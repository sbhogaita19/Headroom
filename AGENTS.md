# AGENTS.md

Headroom is a static site (no build step) plus a news fetcher that runs in GitHub Actions.

## Layout
- `index.html`: the whole app (HTML, CSS, JS in one file). Data constants (SRC, NEWS, TIERS, TASKS, LESSONS, HABITS) are at the top of the script.
- `config/sources.json`: which feeds, repos and queries the fetcher reads. Add or remove sources here.
- `scripts/fetch-news.mjs`: fetcher. Node 20+, no dependencies. Writes `data/news.json` and `digest.md`.
- `data/focus.json`: weekly focus rotation shown in the app and in the digest.
- `sw.js`, `manifest.webmanifest`, `icons/`: PWA files for installing on a phone.
- `.github/workflows/update-news.yml`: scheduled fetch, commit, and GitHub Pages deploy.

## Commands
- Serve locally: `python3 -m http.server 8000`, then open http://localhost:8000
- Fetch news locally: `GITHUB_TOKEN=$(gh auth token) node scripts/fetch-news.mjs`
- Syntax check the fetcher: `node --check scripts/fetch-news.mjs`

## Rules
- No build tools, no runtime dependencies. Keep `index.html` self-contained.
- Never put API keys in the repo. Optional keys (GROQ_API_KEY, ANTHROPIC_API_KEY) are repository secrets.
- Build DOM with the `h()` helper and `textContent`; never assign untrusted feed text to `innerHTML`.
- Every source and link in the app is labelled Official, Author, Community or Lead. Keep that when adding items.
- Bump `CACHE` in `sw.js` when you change cached files.
