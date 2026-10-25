# Repo City

Turn any GitHub profile into a 3D city, and find out which projects need work.

Type a GitHub username and Repo City builds a city where **each repo is a building**. Alongside the visuals, it scans every public repo, scores its health out of 100, and tells you exactly what to fix. Recruiters can use it to find a developer's strongest projects in seconds.

![Repo City](docs/screenshot.png)

## What it does

- **3D city from real data.** One building per original repo (forks are skipped). Districts group repos by language.
- **Health score (0-100) per repo.** Checks for a README, description, topics, license, live demo, tests, CI, recent activity, and substance. Every miss becomes a concrete tip.
- **Portfolio summary.** Overall score and grade, plus the biggest gaps across all repos (for example, "5 of 7 repos have no tests").
- **Personality classification.** Each repo is labeled *production*, *experimental*, *learning*, *abandoned* or *utility* and drawn in a matching architectural style. Uses the Gemini free tier when a key is set, with Claude as a second option and simple rules as a fallback.
- **Discovery tools.** A "Start here" top 3 (marked with gold diamonds in the city), search, filters by language, type and grade, and a Color by: Language / Health toggle.
- **Interactive.** Hover for details, click a building or list item to open its full report, and the camera flies to the selected repo.

## How the city maps to your data

| GitHub data | City element |
|---|---|
| Repo | Building |
| Repo size | Height (log scale) |
| Stars | Width |
| Primary language | District and color |
| Pushed in the last 90 days | Glowing windows |
| Personality (AI or rules) | Architecture style |
| Health grade | Color, in Health mode |

## Tech

Vanilla JavaScript, [Three.js](https://threejs.org/), [Vite](https://vitejs.dev/), the GitHub REST API, and the Gemini API (free tier). A tiny serverless-style backend in `api/` keeps the API keys off the browser.

## Getting started

You need Node.js 18 or newer.

```bash
git clone https://github.com/Nishupathak/repo-city.git
cd repo-city
npm install
```

Create a `.env` file in the project root (see `.env.example`):

```
GITHUB_TOKEN=your-github-token
GEMINI_API_KEY=your-gemini-key
```

Then start the dev server:

```bash
npm run dev
```

Open the local URL it prints (usually http://localhost:5173) and type a GitHub username.

### Keys

| Variable | Required | Where to get it |
|---|---|---|
| `GITHUB_TOKEN` | Yes, for health scans | github.com/settings/personal-access-tokens/new. Choose a fine-grained token with **public repositories (read-only)** and no extra permissions. Raises the GitHub limit from 60 to 5,000 requests per hour. |
| `GEMINI_API_KEY` | No | aistudio.google.com ("Get API key"). Free tier, no credit card. |
| `ANTHROPIC_API_KEY` | No | console.anthropic.com. Used only if Gemini is missing or fails. |
| `GEMINI_MODEL` | No | Defaults to `gemini-flash-latest`. |

Without `GEMINI_API_KEY` (or the Anthropic key), classification falls back to simple rules, and everything else still works. Without `GITHUB_TOKEN`, the city is drawn from public data but health scores are unavailable.

Never commit your `.env` file. It is listed in `.gitignore`.

## Project structure

```
repo-city/
├── api/
│   ├── analyze.js     # scans a profile, scores each repo's health
│   └── classify.js    # classifies repo personalities (Gemini / Claude / rules)
├── src/
│   └── main.js        # Three.js scene, city layout, side panel, filters
├── index.html         # page and styles
├── vite.config.js     # runs the files in api/ locally during `npm run dev`
└── .env.example
```

`vite.config.js` serves each file in `api/` at `/api/<name>` while you develop. The files use the standard `(req, res)` handler shape, so they can also run as serverless functions on a platform like Vercel.

## Health score

| Check | Points |
|---|---|
| README exists | 15 |
| README has real content | 10 |
| Description | 10 |
| Topics (2 or more) | 5 |
| License | 5 |
| Live demo (homepage or GitHub Pages) | 10 |
| Tests | 10 |
| CI | 10 |
| Recent activity (partial credit up to a year) | 15 |
| Substance (repo size) | 10 |

Grades: **A** 85 or more, **B** 70 or more, **C** 50 or more, **D** below 50.

## Limitations

- Scores are rule-based checks of public repo files. They indicate what is missing, not how good the code is.
- Tests are only detected at the repository root, so a repo with tests deeper inside `src/` may be marked as missing them.
- Only the 40 most recently pushed original repos are shown.
- Free-tier AI quotas are small. When they run out, classification falls back to rules.
- Results are cached in memory for 10 minutes to save GitHub quota.

## Ideas for later

- Detect tests and CI in subfolders
- Real commit counts for building height
- Score history to track improvement over time
- Compare two developers side by side

## License

MIT. See [LICENSE](LICENSE).
