import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ---------- Language colors ----------
const languageColors = {
  JavaScript: 0xf7df1e, TypeScript: 0x3178c6, Python: 0x4b8bbe,
  Go: 0x00add8, Shell: 0x89e051, 'C#': 0x9b4f96, HTML: 0xe34c26,
  CSS: 0x563d7c, Java: 0xb07219, C: 0x888888, 'C++': 0xf34b7d,
  Rust: 0xdea584, Ruby: 0xcc342d, PHP: 0x777bb4, Swift: 0xf05138,
  Kotlin: 0xa97bff, 'Jupyter Notebook': 0xda5b0b,
};

function colorFor(language) {
  if (!language) return 0x8892b0; // unknown language
  if (languageColors[language]) return languageColors[language];
  // stable fallback color from the language name
  let hash = 0;
  for (const ch of language) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((hash % 360) / 360, 0.55, 0.55).getHex();
}

function hashOf(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

const PERSONALITY_LABELS = {
  production: '🏢 Production-grade',
  experimental: '🧪 Experimental',
  learning: '📚 Learning project',
  abandoned: '🏚️ Abandoned',
  utility: '🔧 Utility / tool',
};

const GRADE_COLORS = { A: '#3fb950', B: '#a5d65a', C: '#e3b341', D: '#f85149' };
const GRADE_RANGES = { A: '85+', B: '70+', C: '50+', D: 'under 50' };

// ---------- Scene setup ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);
scene.fog = new THREE.Fog(0x0b1020, 40, 120);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 300);
camera.position.set(15, 14, 20);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2.1;
controls.addEventListener('start', () => { fly = null; }); // user grabs the camera: stop any fly-to

// ---------- Lights ----------
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(20, 40, 10);
sun.castShadow = true;
sun.shadow.camera.left = -50;
sun.shadow.camera.right = 50;
sun.shadow.camera.top = 50;
sun.shadow.camera.bottom = -50;
sun.shadow.camera.far = 150;
scene.add(sun);

// ---------- Ground ----------
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300),
  new THREE.MeshStandardMaterial({ color: 0x151b2e })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------- Data: health scan (backend) with a basic fallback ----------
async function fetchRepos(username) {
  const res = await fetch(
    `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed`
  );
  if (res.status === 404) throw new Error('User not found');
  if (res.status === 403) throw new Error('GitHub rate limit hit. Try again in a while.');
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);

  const data = await res.json();
  return data
    .filter((r) => !r.fork)
    .slice(0, 40)
    .map((r) => ({
      name: r.name,
      language: r.language,
      sizeKB: r.size,
      stars: r.stargazers_count,
      pushedAt: r.pushed_at,
      createdAt: r.created_at,
      topics: r.topics || [],
      archived: r.archived,
      description: r.description,
      url: r.html_url,
    }));
}

async function fetchAnalysis(username) {
  let res = null;
  try {
    res = await fetch(`/api/analyze?user=${encodeURIComponent(username)}`);
  } catch {
    res = null;
  }
  if (res && res.ok) return res.json(); // { profile, repos (with health), summary }

  let message = res ? `server error ${res.status}` : 'server not reachable';
  if (res) {
    try { message = (await res.json()).error || message; } catch {}
  }
  if (res && (res.status === 404 || res.status === 400)) throw new Error(message);

  // health scan failed: still draw the city from public data
  const repos = await fetchRepos(username);
  return { repos, profile: null, summary: null, error: message };
}

// ---------- AI / rule-based personality classification ----------
const classifyCache = new Map();

async function classifyRepos(repos) {
  const now = Date.now();
  const payload = repos.map((r) => ({
    name: r.name,
    description: r.description,
    language: r.language,
    topics: r.topics,
    sizeKB: r.sizeKB,
    stars: r.stars,
    archived: r.archived,
    ageDays: Math.round((now - new Date(r.createdAt)) / 86400000),
    daysSincePush: Math.round((now - new Date(r.pushedAt)) / 86400000),
  }));

  const res = await fetch('/api/classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repos: payload }),
    signal: AbortSignal.timeout(40000), // never wait forever
  });
  if (!res.ok) {
    let msg = `server error ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json(); // { classifications, source }
}

function applyClassification(repos, classifications) {
  repos.forEach((r) => {
    const c = classifications[r.name];
    if (c) {
      r.personality = c.personality;
      r.reason = c.reason;
    }
  });
}

// ---------- Shared state ----------
let currentData = null;            // { profile, repos, summary, error }
let colorMode = 'language';        // 'language' | 'health'
const filters = { query: '', language: '', personality: '', grade: '' };
const defaultFilters = () => ({ query: '', language: '', personality: '', grade: '' });

// ---------- Buildings & districts ----------
const cityGroup = new THREE.Group();
scene.add(cityGroup);

let buildingGroups = [];            // one THREE.Group per repo (hover/click targets)
const groupByName = new Map();      // repo name -> its building group
let markers = [];                   // gold "Start here" diamonds
let hovered = null;
let selected = null;
let selectedName = null;
let fly = null;                     // active camera fly-to animation

function clearCity() {
  cityGroup.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  });
  cityGroup.clear();
  buildingGroups = [];
  groupByName.clear();
  markers = [];
  hovered = null;
  selected = null;
  hideTooltip();
}

const TILE_HEIGHT = 0.2;

function createBuilding(repo, x, z) {
  // color: by language, or by health grade when that mode is on
  const baseColor =
    colorMode === 'health' && repo.health ? GRADE_COLORS[repo.health.grade] : colorFor(repo.language);
  const color = new THREE.Color(baseColor);

  const baseHeight = 1 + Math.log10(repo.sizeKB + 1) * 3.5; // size -> height (log scale)
  const footprint = 2 + Math.min(repo.stars, 20) * 0.1;      // stars -> width
  const daysSincePush = (Date.now() - new Date(repo.pushedAt)) / 86400000;
  const personality = repo.personality || 'unknown';
  const dir = hashOf(repo.name) % 2 ? 1 : -1;

  const active = daysSincePush < 90 && personality !== 'abandoned';
  const baseGlow = active ? 0.25 : 0;

  const group = new THREE.Group();
  group.position.set(x, TILE_HEIGHT, z);
  const materials = [];

  const makeMat = (c, extra = {}) => {
    const m = new THREE.MeshStandardMaterial({
      color: c,
      roughness: 0.6,
      emissive: c,
      emissiveIntensity: baseGlow,
      ...extra,
    });
    materials.push(m);
    return m;
  };

  const addBox = (w, h, d, mat, px = 0, py = 0, pz = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(px, py + h / 2, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  const addCylinder = (r, h, mat, px, py, pz) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), mat);
    mesh.position.set(px, py + h / 2, pz);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  switch (personality) {
    case 'production': {
      const h = baseHeight * 1.2;
      const glass = makeMat(color.clone().lerp(new THREE.Color(0xffffff), 0.25), {
        roughness: 0.15,
        metalness: 0.3,
      });
      addBox(footprint, h, footprint, glass);
      addBox(footprint * 0.6, h * 0.12, footprint * 0.6, makeMat(color), 0, h, 0);
      addCylinder(0.06, h * 0.2, makeMat(0xdddddd), 0, h + h * 0.12, 0);
      break;
    }
    case 'experimental': {
      const lowerH = baseHeight * 0.6;
      const upperH = baseHeight * 0.55;
      const lower = addBox(footprint, lowerH, footprint, makeMat(color));
      lower.rotation.z = 0.06 * dir;
      const upper = addBox(
        footprint * 0.7, upperH, footprint * 0.7,
        makeMat(color.clone().offsetHSL(0.05, 0, 0.08)),
        0.3 * dir, lowerH, 0
      );
      upper.rotation.y = 0.5;
      upper.rotation.z = -0.1 * dir;
      break;
    }
    case 'learning': {
      const w = footprint * 1.1;
      const bodyH = Math.min(baseHeight * 0.5, 3.2) + 0.8;
      addBox(w, bodyH, w, makeMat(color));
      const roofH = w * 0.6;
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(w * 0.8, roofH, 4),
        makeMat(color.clone().multiplyScalar(0.55))
      );
      roof.rotation.y = Math.PI / 4;
      roof.position.set(0, bodyH + roofH / 2, 0);
      roof.castShadow = true;
      group.add(roof);
      break;
    }
    case 'abandoned': {
      const faded = color.clone().lerp(new THREE.Color(0x555a66), 0.75).multiplyScalar(0.7);
      const mat = makeMat(faded, { roughness: 0.95 });
      const h = baseHeight * 0.75;
      const body = addBox(footprint, h, footprint, mat);
      body.rotation.z = 0.05 * dir;
      addBox(footprint * 0.5, h * 0.25, footprint * 0.5, mat, footprint * 0.7, 0, footprint * 0.3);
      break;
    }
    case 'utility': {
      const w = footprint * 1.5;
      const h = Math.max(1.5, baseHeight * 0.5);
      addBox(w, h, w, makeMat(color));
      addCylinder(0.35, h * 0.8, makeMat(color.clone().multiplyScalar(0.6)), w * 0.3, h, w * 0.3);
      break;
    }
    default: {
      addBox(footprint, baseHeight, footprint, makeMat(color));
    }
  }

  group.userData = { ...repo, isBuilding: true, dimmed: false, baseGlow, daysSincePush, materials };
  cityGroup.add(group);
  buildingGroups.push(group);
  groupByName.set(repo.name, group);
}

function makeLabel(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 56px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
  ctx.fillText(text, 256, 64);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthWrite: false,
      fog: false,
    })
  );
  sprite.scale.set(10, 2.5, 1);
  return sprite;
}

// gold floating diamonds over the "Start here" projects
function addRecommendedMarkers() {
  const names = currentData?.summary?.recommended || [];
  names.forEach((name) => {
    const g = groupByName.get(name);
    if (!g) return;
    g.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(g);
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.55),
      new THREE.MeshStandardMaterial({
        color: 0xffd34d,
        emissive: 0xffb400,
        emissiveIntensity: 0.9,
        roughness: 0.3,
      })
    );
    mesh.position.set(g.position.x, box.max.y + 1.3, g.position.z);
    mesh.userData = { baseY: mesh.position.y, forName: name };
    cityGroup.add(mesh);
    markers.push(mesh);
  });
}

function buildCity(repos, { fitCamera = true } = {}) {
  clearCity();

  const groups = {};
  repos.forEach((r) => {
    const key = r.language || 'Other';
    (groups[key] ||= []).push(r);
  });
  const districts = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);

  const spacing = 6;
  const pad = 3;
  const gap = 4;
  const blocks = districts.map(([language, list]) => {
    const cols = Math.ceil(Math.sqrt(list.length));
    const rows = Math.ceil(list.length / cols);
    return { language, list, cols, rows, w: cols * spacing + pad * 2, d: rows * spacing + pad * 2 };
  });

  const totalArea = blocks.reduce((sum, b) => sum + b.w * b.d, 0);
  const maxRowWidth = Math.max(Math.sqrt(totalArea) * 1.3, ...blocks.map((b) => b.w));
  let cursorX = 0, cursorZ = 0, rowDepth = 0, cityW = 0;
  blocks.forEach((b) => {
    if (cursorX > 0 && cursorX + b.w > maxRowWidth) {
      cursorX = 0;
      cursorZ += rowDepth + gap;
      rowDepth = 0;
    }
    b.x = cursorX;
    b.z = cursorZ;
    cursorX += b.w + gap;
    rowDepth = Math.max(rowDepth, b.d);
    cityW = Math.max(cityW, cursorX - gap);
  });
  const cityD = cursorZ + rowDepth;
  const offX = -cityW / 2;
  const offZ = -cityD / 2;

  blocks.forEach((b) => {
    // district tiles and labels always stay language-colored
    const color = colorFor(b.language === 'Other' ? null : b.language);
    const centerX = offX + b.x + b.w / 2;
    const centerZ = offZ + b.z + b.d / 2;

    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(b.w, TILE_HEIGHT, b.d),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(color).multiplyScalar(0.25),
        roughness: 0.9,
      })
    );
    tile.position.set(centerX, TILE_HEIGHT / 2, centerZ);
    tile.receiveShadow = true;
    cityGroup.add(tile);

    const label = makeLabel(`${b.language} (${b.list.length})`, color);
    label.position.set(centerX, 1.2, centerZ + b.d / 2 + 1.5);
    cityGroup.add(label);

    b.list.forEach((repo, i) => {
      const col = i % b.cols;
      const row = Math.floor(i / b.cols);
      const x = centerX - b.w / 2 + pad + spacing / 2 + col * spacing;
      const z = centerZ - b.d / 2 + pad + spacing / 2 + row * spacing;
      createBuilding(repo, x, z);
    });
  });

  const extent = Math.max(cityW, cityD);
  if (fitCamera) {
    camera.position.set(extent * 0.5, extent * 0.6, extent * 0.8);
    controls.target.set(0, 0, 0);
    controls.update();
  }

  scene.fog.near = extent * 0.8;
  scene.fog.far = Math.max(120, extent * 3);

  const s = extent * 0.8;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.updateProjectionMatrix();

  addRecommendedMarkers();

  // keep selection and filters after a rebuild
  if (selectedName) {
    selected = groupByName.get(selectedName) || null;
    applyGlow(selected);
  }
  applyFilter();
}

// ---------- Filters ----------
function isMatch(r) {
  const q = filters.query.trim().toLowerCase();
  if (q && !`${r.name} ${r.description || ''}`.toLowerCase().includes(q)) return false;
  if (filters.language && (r.language || 'Other') !== filters.language) return false;
  if (filters.personality && r.personality !== filters.personality) return false;
  if (filters.grade && r.health?.grade !== filters.grade) return false;
  return true;
}

function filtersActive() {
  return Boolean(filters.query.trim() || filters.language || filters.personality || filters.grade);
}

// dim buildings that don't match, so matches stand out on the map
function applyFilter() {
  buildingGroups.forEach((g) => {
    const match = isMatch(g.userData);
    g.userData.dimmed = !match;
    g.userData.materials.forEach((m) => {
      const wasTransparent = m.transparent;
      m.transparent = !match;
      m.opacity = match ? 1 : 0.12;
      m.depthWrite = match;
      if (wasTransparent !== m.transparent) m.needsUpdate = true;
    });
    g.traverse((o) => {
      if (o.isMesh) o.castShadow = match;
    });
  });
  markers.forEach((m) => {
    m.visible = !groupByName.get(m.userData.forName)?.userData.dimmed;
  });
  if (hovered?.userData.dimmed) {
    setHovered(null);
    hideTooltip();
  }
}

// ---------- Glow, hover, selection, camera ----------
function applyGlow(group) {
  if (!group) return;
  const level = group === hovered ? 0.7 : group === selected ? 0.5 : group.userData.baseGlow;
  group.userData.materials.forEach((m) => (m.emissiveIntensity = level));
}

function setHovered(group) {
  if (hovered === group) return;
  const prev = hovered;
  hovered = group;
  applyGlow(prev);
  applyGlow(hovered);
  renderer.domElement.style.cursor = hovered ? 'pointer' : 'default';
}

function flyTo(group) {
  const target = group.position.clone().add(new THREE.Vector3(0, 2, 0));
  const dir = camera.position.clone().sub(controls.target).normalize();
  dir.y = Math.max(dir.y, 0.35);
  dir.normalize();
  fly = {
    t: 0,
    fromPos: camera.position.clone(),
    toPos: target.clone().add(dir.multiplyScalar(16)),
    fromTarget: controls.target.clone(),
    toTarget: target,
  };
}

function selectRepo(name, { fly: doFly = true } = {}) {
  const prev = selected;
  selectedName = name;
  selected = groupByName.get(name) || null;
  applyGlow(prev);
  applyGlow(selected);
  if (selected && doFly) flyTo(selected);
  renderPanel({ resetScroll: true });
}

function clearSelection() {
  const prev = selected;
  selectedName = null;
  selected = null;
  applyGlow(prev);
  renderPanel({ resetScroll: true });
}

// ---------- Small DOM helpers ----------
// build elements with textContent only, so GitHub text can never inject HTML
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function gradeBadge(grade) {
  const b = el('span', 'badge', grade);
  b.style.background = GRADE_COLORS[grade] || '#8892b0';
  return b;
}

function safeGithubUrl(u) {
  return typeof u === 'string' && u.startsWith('https://github.com/') ? u : null;
}

function timeAgo(days) {
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${Math.floor(days)} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

// ---------- Color-by toggle + legend ----------
const modeButtons = document.querySelectorAll('#colorby button');
const legend = document.getElementById('legend');

function updateModeButtons() {
  modeButtons.forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === colorMode);
    if (b.dataset.mode === 'health') b.disabled = !currentData?.summary;
  });
}

function renderLegend() {
  legend.replaceChildren();
  if (!currentData) {
    legend.hidden = true;
    return;
  }
  legend.hidden = false;

  if (colorMode === 'health') {
    legend.appendChild(el('div', null, 'Building color = health grade'));
    Object.keys(GRADE_COLORS).forEach((g) => {
      const row = el('div', 'row');
      const sw = el('span', 'sw');
      sw.style.background = GRADE_COLORS[g];
      row.appendChild(sw);
      row.appendChild(el('span', null, `${g}  (${GRADE_RANGES[g]})`));
      legend.appendChild(row);
    });
  } else {
    legend.appendChild(el('div', null, 'Building color = language'));
  }
  legend.appendChild(el('div', null, 'Glow = pushed in the last 90 days'));
  if (currentData.summary?.recommended?.length) {
    const row = el('div', 'row');
    row.appendChild(el('span', 'gold', '◆'));
    row.appendChild(el('span', null, 'Start here'));
    legend.appendChild(row);
  }
}

function setColorMode(mode) {
  colorMode = mode;
  updateModeButtons();
  renderLegend();
  if (currentData) buildCity(currentData.repos, { fitCamera: false });
}

modeButtons.forEach((b) =>
  b.addEventListener('click', () => {
    if (!b.disabled) setColorMode(b.dataset.mode);
  })
);

// ---------- Side panel ----------
const panel = document.getElementById('panel');
const panelBody = document.getElementById('panel-body');
const panelClose = document.getElementById('panel-close');
const panelOpen = document.getElementById('panel-open');

let sortOrder = 'low'; // 'low' = needs work first, 'high' = best first
let listEl = null;
let countEl = null;

panelClose.addEventListener('click', () => {
  panel.hidden = true;
  panelOpen.hidden = !currentData;
});
panelOpen.addEventListener('click', () => {
  panel.hidden = false;
  panelOpen.hidden = true;
});

function renderPanel({ resetScroll = false } = {}) {
  if (!currentData) {
    panel.hidden = true;
    panelOpen.hidden = true;
    return;
  }
  if (panelOpen.hidden && panel.hidden) panel.hidden = false; // first render opens the panel
  if (selectedName && currentData.repos.some((r) => r.name === selectedName)) renderDetail();
  else renderOverview();
  if (resetScroll) panelBody.scrollTop = 0;
}

function onFiltersChanged() {
  renderRepoList();
  applyFilter();
}

function buildFilterBar(repos, hasHealth) {
  const wrap = el('div');

  const search = el('input', 'fsearch');
  search.type = 'search';
  search.placeholder = 'Search repos...';
  search.value = filters.query;
  search.addEventListener('input', () => {
    filters.query = search.value;
    onFiltersChanged();
  });
  wrap.appendChild(search);

  const row = el('div', 'frow');
  const makeSelect = (key, allLabel, options) => {
    const s = el('select', 'fsel');
    const first = el('option', null, allLabel);
    first.value = '';
    s.appendChild(first);
    options.forEach(([value, text]) => {
      const o = el('option', null, text);
      o.value = value;
      s.appendChild(o);
    });
    s.value = filters[key];
    s.addEventListener('change', () => {
      filters[key] = s.value;
      onFiltersChanged();
    });
    return s;
  };

  const languages = [...new Set(repos.map((r) => r.language || 'Other'))].sort();
  row.appendChild(makeSelect('language', 'All languages', languages.map((l) => [l, l])));

  const personalities = Object.keys(PERSONALITY_LABELS).filter((p) => repos.some((r) => r.personality === p));
  if (personalities.length) {
    row.appendChild(makeSelect('personality', 'All types', personalities.map((p) => [p, PERSONALITY_LABELS[p]])));
  }
  if (hasHealth) {
    row.appendChild(makeSelect('grade', 'All grades', ['A', 'B', 'C', 'D'].map((g) => [g, `Grade ${g}`])));
  }
  wrap.appendChild(row);

  countEl = el('div', 'fmeta');
  wrap.appendChild(countEl);
  return wrap;
}

function renderRepoList() {
  const { repos } = currentData;
  const list = repos.filter(isMatch).sort((a, b) => {
    const sa = a.health?.score ?? 0;
    const sb = b.health?.score ?? 0;
    return sortOrder === 'low' ? sa - sb : sb - sa;
  });

  listEl.replaceChildren();
  if (!list.length) listEl.appendChild(el('div', 'dmeta', 'No repos match these filters.'));
  list.forEach((r) => {
    const row = el('div', 'repo-row');
    if (r.health) row.appendChild(gradeBadge(r.health.grade));
    row.appendChild(el('span', 'rn', r.name));
    if (r.health) row.appendChild(el('span', 'rs', String(r.health.score)));
    row.addEventListener('click', () => selectRepo(r.name));
    listEl.appendChild(row);
  });

  countEl.replaceChildren();
  countEl.appendChild(el('span', null, `Showing ${list.length} of ${repos.length}`));
  if (filtersActive()) {
    const clear = el('button', 'linkbtn', 'Clear filters');
    clear.addEventListener('click', () => {
      Object.assign(filters, defaultFilters());
      renderOverview();
      applyFilter();
    });
    countEl.appendChild(clear);
  }
}

function renderOverview() {
  const { repos, profile, summary, error } = currentData;
  panelBody.replaceChildren();

  // profile header + overall score
  const head = el('div', 'profile');
  if (profile?.avatarUrl && profile.avatarUrl.startsWith('https://avatars.githubusercontent.com/')) {
    const img = el('img', 'avatar');
    img.src = profile.avatarUrl;
    img.alt = '';
    head.appendChild(img);
  }
  const names = el('div');
  names.appendChild(el('div', 'pname', profile?.name || profile?.login || 'GitHub profile'));
  if (profile?.login) names.appendChild(el('div', 'plogin', '@' + profile.login));
  head.appendChild(names);

  if (summary) {
    const big = el('div', 'bigscore', String(summary.avgScore));
    big.style.color = GRADE_COLORS[summary.avgGrade];
    big.appendChild(el('small', null, `health · grade ${summary.avgGrade}`));
    head.appendChild(big);
  }
  panelBody.appendChild(head);

  if (!summary) {
    const warn = el('div', 'gap');
    warn.appendChild(el('div', 't', 'Health scan unavailable'));
    warn.appendChild(el('div', 'tip', error || 'The server could not scan this profile.'));
    warn.appendChild(el('div', 'tip', 'The city is drawn from public data only. Check GITHUB_TOKEN in .env and restart the dev server.'));
    panelBody.appendChild(warn);
  } else {
    // Start here: the projects a recruiter should open first
    const picks = (summary.recommended || [])
      .map((name) => repos.find((r) => r.name === name))
      .filter(Boolean);
    if (picks.length) {
      panelBody.appendChild(el('div', 'section', 'Start here'));
      picks.forEach((r) => {
        const card = el('div', 'start');
        card.appendChild(el('span', 'gold', '◆'));
        const info = el('div', 'info');
        info.appendChild(el('div', 'rn', r.name));
        info.appendChild(el('div', 'sub', `${r.language || 'No language'} · ★ ${r.stars} · pushed ${timeAgo((Date.now() - new Date(r.pushedAt)) / 86400000)}`));
        card.appendChild(info);
        card.appendChild(gradeBadge(r.health.grade));
        card.addEventListener('click', () => selectRepo(r.name));
        panelBody.appendChild(card);
      });
    }

    // biggest gaps across the whole portfolio
    panelBody.appendChild(el('div', 'section', 'Biggest gaps'));
    if (summary.topGaps.length === 0) {
      panelBody.appendChild(el('div', 'gap', 'No gaps found. Nice work.'));
    }
    summary.topGaps.forEach((g) => {
      const box = el('div', 'gap');
      box.appendChild(el('div', 't', g.label));
      box.appendChild(el('div', 'c', `${g.count} of ${summary.total} repos`));
      box.appendChild(el('div', 'tip', g.tip));
      panelBody.appendChild(box);
    });
  }

  // repositories: search, filters, sort, list
  panelBody.appendChild(el('div', 'section', 'Repositories'));
  panelBody.appendChild(buildFilterBar(repos, Boolean(summary)));

  if (summary) {
    const bar = el('div', 'sortbar');
    [['low', 'Needs work first'], ['high', 'Best first']].forEach(([key, label]) => {
      const b = el('button', key === sortOrder ? 'active' : '', label);
      b.addEventListener('click', () => {
        sortOrder = key;
        renderOverview();
      });
      bar.appendChild(b);
    });
    panelBody.appendChild(bar);
  }

  listEl = el('div');
  panelBody.appendChild(listEl);
  renderRepoList();

  panelBody.appendChild(
    el('div', 'note',
      'Scores come from rule-based checks of public repo files. Tests are only detected at the repo root, so a repo with tests deeper in src/ may be marked as missing them.')
  );
}

function renderDetail() {
  const repo = currentData.repos.find((r) => r.name === selectedName);
  panelBody.replaceChildren();

  const back = el('button', 'back', '← All repositories');
  back.addEventListener('click', clearSelection);
  panelBody.appendChild(back);

  const head = el('div', 'dhead');
  head.appendChild(el('span', 'rn', repo.name));
  if (repo.health) {
    head.appendChild(gradeBadge(repo.health.grade));
    head.appendChild(el('span', null, `${repo.health.score}/100`));
  }
  panelBody.appendChild(head);

  const days = (Date.now() - new Date(repo.pushedAt)) / 86400000;
  panelBody.appendChild(
    el('div', 'dmeta', `${repo.language || 'No language'} · ★ ${repo.stars} · pushed ${timeAgo(days)}`)
  );
  if (repo.personality) {
    panelBody.appendChild(el('div', 'dmeta', PERSONALITY_LABELS[repo.personality] || repo.personality));
  }
  if (repo.description) panelBody.appendChild(el('div', 'ddesc', repo.description));

  if (repo.health) {
    panelBody.appendChild(el('div', 'section', 'Health checklist'));
    repo.health.checks.forEach((c) => {
      const full = c.score === c.weight;
      const none = c.score === 0;
      const row = el('div', 'check');
      const icon = el('span', 'ic', full ? '✓' : none ? '✗' : '◐');
      icon.style.color = full ? '#3fb950' : none ? '#f85149' : '#e3b341';
      row.appendChild(icon);

      const body = el('div', 'body');
      body.appendChild(el('div', null, c.label));
      if (!full) body.appendChild(el('div', 'tip', c.tip));
      row.appendChild(body);
      row.appendChild(el('span', 'pts', `${c.score}/${c.weight}`));
      panelBody.appendChild(row);
    });

    const best = repo.health.checks
      .filter((c) => c.score < c.weight)
      .sort((a, b) => b.weight - b.score - (a.weight - a.score))[0];
    if (best) {
      const win = el('div', 'win');
      win.appendChild(el('div', null, `Biggest win: ${best.label} (+${best.weight - best.score} points)`));
      win.appendChild(el('div', 'tip', best.tip));
      panelBody.appendChild(win);
    }
  }

  const url = safeGithubUrl(repo.url);
  if (url) {
    const a = el('a', 'ghbtn', 'Open on GitHub');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    panelBody.appendChild(a);
  }
}

// ---------- Hover tooltip + click ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
let downPos = null;

function hideTooltip() {
  tooltip.style.display = 'none';
}

function showTooltip(repo, clientX, clientY) {
  tooltip.replaceChildren();

  tooltip.appendChild(el('div', 'name', repo.name));

  const lang = el('div', 'lang');
  const dot = el('span', 'dot');
  dot.style.background = '#' + new THREE.Color(colorFor(repo.language)).getHexString();
  lang.appendChild(dot);
  lang.appendChild(document.createTextNode(repo.language || 'No language detected'));
  tooltip.appendChild(lang);

  if (repo.health) {
    const h = el('div', 'lang', `Health ${repo.health.score}/100 (${repo.health.grade})`);
    h.style.marginTop = '4px';
    h.style.color = GRADE_COLORS[repo.health.grade];
    h.style.fontWeight = '700';
    tooltip.appendChild(h);
  }

  if (repo.personality) {
    const persona = el('div', 'lang', PERSONALITY_LABELS[repo.personality] || repo.personality);
    persona.style.marginTop = '4px';
    persona.style.color = '#e6ecff';
    tooltip.appendChild(persona);
    if (repo.reason) {
      const why = el('div', 'meta', repo.reason);
      why.style.fontStyle = 'italic';
      tooltip.appendChild(why);
    }
  }

  if (repo.description) tooltip.appendChild(el('div', 'desc', repo.description));

  const sizeText = repo.sizeKB >= 1024 ? `${(repo.sizeKB / 1024).toFixed(1)} MB` : `${repo.sizeKB} KB`;
  tooltip.appendChild(
    el('div', 'meta', `★ ${repo.stars}  ·  ${sizeText}  ·  pushed ${timeAgo(repo.daysSincePush)}`)
  );
  tooltip.appendChild(el('div', 'hint', 'Click for the full report'));

  tooltip.style.display = 'block';

  const pad = 14;
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  let x = clientX + pad;
  let y = clientY + pad;
  if (x + w > window.innerWidth - 8) x = clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = clientY - h - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

function pick(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // dimmed (filtered-out) buildings can't be hovered or clicked
  const targets = buildingGroups.filter((g) => !g.userData.dimmed);
  const hits = raycaster.intersectObjects(targets, true);
  if (!hits.length) return null;
  let obj = hits[0].object;
  while (obj && !obj.userData.isBuilding) obj = obj.parent;
  return obj || null;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons !== 0) {
    setHovered(null);
    hideTooltip();
    return;
  }
  const group = pick(e.clientX, e.clientY);
  setHovered(group);
  if (group) showTooltip(group.userData, e.clientX, e.clientY);
  else hideTooltip();
});

renderer.domElement.addEventListener('pointerleave', () => {
  setHovered(null);
  hideTooltip();
});

renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = { x: e.clientX, y: e.clientY };
});

// a click (not a camera drag) on a building opens its health report
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 5) return;
  const group = pick(e.clientX, e.clientY);
  if (group) {
    selectRepo(group.userData.name, { fly: false });
    panel.hidden = false;
    panelOpen.hidden = true;
  }
});

// ---------- UI: load a user ----------
const input = document.getElementById('username');
const button = document.getElementById('go');
const statusEl = document.getElementById('status');
const analysisCache = new Map();
let loadId = 0; // guards against an older search finishing after a newer one

function sourceText(cls) {
  if (cls.source === 'ai') return `classified by AI${cls.provider ? ` (${cls.provider})` : ''}`;
  return `classified by simple rules${cls.note ? ` (${cls.note})` : ''}`;
}

function statusLine(data, cls) {
  const parts = [`${data.repos.length} repos`];
  if (data.summary) parts.push(`health ${data.summary.avgScore}/100`);
  else parts.push(`health scan unavailable (${data.error})`);
  if (cls) parts.push(sourceText(cls));
  return parts.join(' · ');
}

async function loadUser() {
  const username = input.value.trim();
  if (!username) return;
  const myId = ++loadId;
  button.disabled = true;
  statusEl.textContent = 'Scanning GitHub profile...';

  try {
    const key = username.toLowerCase();
    let data = analysisCache.get(key);
    if (!data) {
      data = await fetchAnalysis(username);
      if (myId !== loadId) return;
      if (!data.error) analysisCache.set(key, data); // only cache successful health scans
    }

    if (data.repos.length === 0) {
      statusEl.textContent = 'No original repos found for this user.';
      currentData = null;
      selectedName = null;
      clearCity();
      renderPanel();
      renderLegend();
      updateModeButtons();
      return;
    }

    currentData = data;
    selectedName = null;
    sortOrder = 'low';
    Object.assign(filters, defaultFilters());
    if (!data.summary) colorMode = 'language'; // health colors need a health scan
    updateModeButtons();
    renderLegend();

    const cached = classifyCache.get(key);
    if (cached) applyClassification(data.repos, cached.classifications);

    buildCity(data.repos);
    renderPanel({ resetScroll: true });

    if (cached) {
      statusEl.textContent = statusLine(data, cached);
      return;
    }

    // the city is already usable, so unlock the button while the AI works in the background
    button.disabled = false;
    statusEl.textContent = `${statusLine(data)} · classifying personalities...`;
    try {
      const cls = await classifyRepos(data.repos);
      if (myId !== loadId) return;
      classifyCache.set(key, cls);
      applyClassification(data.repos, cls.classifications);
      buildCity(data.repos, { fitCamera: false });
      renderPanel();
      statusEl.textContent = statusLine(data, cls);
    } catch (err) {
      statusEl.textContent = `${statusLine(data)} (classification failed: ${err.message})`;
    }
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    if (myId === loadId) button.disabled = false;
  }
}

button.addEventListener('click', loadUser);
input.addEventListener('keydown', (e) => e.key === 'Enter' && loadUser());

// ---------- Resize + animate ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const time = clock.elapsedTime;

  if (fly) {
    fly.t = Math.min(1, fly.t + dt / 0.9);
    const e = 1 - Math.pow(1 - fly.t, 3); // ease-out
    camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
    controls.target.lerpVectors(fly.fromTarget, fly.toTarget, e);
    if (fly.t >= 1) fly = null;
  }

  // spin and bob the gold "Start here" diamonds
  markers.forEach((m, i) => {
    m.rotation.y += dt * 1.5;
    m.position.y = m.userData.baseY + Math.sin(time * 2 + i) * 0.15;
  });

  controls.update();
  renderer.render(scene, camera);
}
animate();

loadUser(); // build a city on first load
