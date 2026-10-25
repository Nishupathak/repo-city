// api/analyze.js
// GET /api/analyze?user=<github username>
// Scans a user's public repos with your GITHUB_TOKEN (kept on the server),
// scores each repo's "health" out of 100 and summarizes the whole portfolio.

const GITHUB = 'https://api.github.com';
const CACHE_MS = 10 * 60 * 1000; // remember results for 10 minutes to save GitHub quota
const MAX_REPOS = 40;
const cache = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function ghGet(path, { allowMissing = false } = {}) {
  const res = await fetch(GITHUB + path, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'repo-city',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    },
  });
  if (res.ok) return res.json();
  if (allowMissing && (res.status === 404 || res.status === 409)) return null; // 409 = empty repo
  if (res.status === 401) throw new HttpError(500, 'GitHub rejected the token. Check GITHUB_TOKEN in .env');
  if (res.status === 404) throw new HttpError(404, 'User not found');
  if (res.status === 403 || res.status === 429) throw new HttpError(429, 'GitHub rate limit reached. Try again later.');
  throw new HttpError(502, `GitHub error ${res.status}`);
}

// run `fn` over items, at most `limit` at a time
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function gradeFor(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

// The health checklist. Weights add up to 100.
function evaluate(r, files, workflowCount) {
  const daysSincePush = (Date.now() - new Date(r.pushed_at)) / 86400000;

  const readme = files.find((f) => f.type === 'file' && /^readme(\.|$)/i.test(f.name));
  const hasTests = files.some(
    (f) =>
      (f.type === 'dir' && /^(tests?|__tests__|spec|e2e|cypress)$/i.test(f.name)) ||
      (f.type === 'file' &&
        /(\.test\.|\.spec\.)|^(pytest\.ini|conftest\.py|tox\.ini|jest\.config\.|vitest\.config\.)/i.test(f.name))
  );
  const otherCI = files.some((f) =>
    /^(\.travis\.yml|\.gitlab-ci\.yml|azure-pipelines\.yml|jenkinsfile|\.circleci)$/i.test(f.name)
  );

  const make = (id, label, weight, score, tip) => ({ id, label, weight, score, tip });

  return [
    make('readme', 'README', 15, readme ? 15 : 0,
      'Add a README. It is the first thing a recruiter opens.'),
    make('readme_detail', 'README detail', 10,
      !readme ? 0 : readme.size >= 1000 ? 10 : readme.size >= 300 ? 5 : 0,
      'Expand the README: what it does, how to run it, and a screenshot.'),
    make('description', 'Description', 10, r.description ? 10 : 0,
      'Add a one-line description in the repo About box.'),
    make('topics', 'Topics', 5, (r.topics || []).length >= 2 ? 5 : 0,
      'Add 3-5 topics (like react or machine-learning) so people can discover it.'),
    make('license', 'License', 5, r.license ? 5 : 0,
      'Add a license file (MIT is a common choice).'),
    make('demo', 'Live demo', 10, r.homepage || r.has_pages ? 10 : 0,
      'Add a live demo link in the About box or turn on GitHub Pages.'),
    make('tests', 'Tests', 10, hasTests ? 10 : 0,
      'Add tests so people trust the code (a tests/ folder at the repo root).'),
    make('ci', 'CI', 10, workflowCount > 0 || otherCI ? 10 : 0,
      'Add a GitHub Actions workflow that runs on every push.'),
    make('activity', 'Recent activity', 15,
      r.archived ? 0 : daysSincePush <= 90 ? 15 : daysSincePush <= 365 ? 8 : 0,
      'No recent pushes. Ship an update so the project looks alive.'),
    make('substance', 'Substance', 10, r.size >= 50 ? 10 : r.size >= 10 ? 5 : 0,
      'Very small repo. Build it out, or fold it into a bigger project.'),
  ];
}

async function scanRepo(owner, r) {
  const contents = await ghGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(r.name)}/contents`, {
    allowMissing: true,
  });
  const files = Array.isArray(contents) ? contents : [];

  let workflowCount = 0;
  if (files.some((f) => f.type === 'dir' && f.name === '.github')) {
    const wf = await ghGet(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(r.name)}/contents/.github/workflows`,
      { allowMissing: true }
    );
    workflowCount = Array.isArray(wf) ? wf.filter((f) => /\.ya?ml$/i.test(f.name)).length : 0;
  }

  const checks = evaluate(r, files, workflowCount);
  const score = checks.reduce((sum, c) => sum + c.score, 0);

  return {
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
    homepage: r.homepage || null,
    license: r.license?.spdx_id || null,
    health: { score, grade: gradeFor(score), checks },
  };
}

function summarize(repos) {
  const avgScore = Math.round(repos.reduce((s, r) => s + r.health.score, 0) / repos.length);

  const gradeCounts = { A: 0, B: 0, C: 0, D: 0 };
  const failures = {};
  for (const r of repos) {
    gradeCounts[r.health.grade]++;
    for (const c of r.health.checks) {
      if (c.score < c.weight) {
        const f = (failures[c.id] ||= { id: c.id, label: c.label, tip: c.tip, weight: c.weight, count: 0 });
        f.count++;
      }
    }
  }

  // the gaps that cost the most points across the whole portfolio
  const topGaps = Object.values(failures)
    .sort((a, b) => b.count * b.weight - a.count * a.weight)
    .slice(0, 4)
    .map(({ id, label, tip, count }) => ({ id, label, tip, count }));

  // projects a recruiter should look at first: healthy, and with some traction
  const rank = (r) => r.health.score + Math.min(r.stars, 50) * 0.5;
  const recommended = repos
    .filter((r) => !r.archived)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 3)
    .map((r) => r.name);

  return { avgScore, avgGrade: gradeFor(avgScore), gradeCounts, topGaps, recommended, total: repos.length };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  const user = String(req.query?.user ?? '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(user)) {
    return res.status(400).json({ error: 'Invalid GitHub username' });
  }
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN is not set on the server' });
  }

  const key = user.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return res.status(200).json(hit.data);
  }

  try {
    const [profile, list] = await Promise.all([
      ghGet(`/users/${encodeURIComponent(user)}`),
      ghGet(`/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`),
    ]);

    const own = list.filter((r) => !r.fork).slice(0, MAX_REPOS);
    const repos = await mapPool(own, 8, (r) => scanRepo(profile.login, r));

    const data = {
      profile: {
        login: profile.login,
        name: profile.name,
        avatarUrl: profile.avatar_url,
        bio: profile.bio,
        publicRepos: profile.public_repos,
        followers: profile.followers,
        url: profile.html_url,
      },
      repos,
      summary: repos.length ? summarize(repos) : null,
    };

    cache.set(key, { at: Date.now(), data });
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[analyze]', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
