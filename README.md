# Headroom

Live agentic-AI news, a model-and-tool picker for a multi-LLM suite, a learning path, and daily habits. Works as a website and installs on a phone as an app (PWA).

- **Today**: habit of the day, focus of the week, live news from official repos, vendor blogs and author feeds.
- **Pick**: which model tier and tool for which task, and how to run each task efficiently.
- **Learn**: an eight-step path on prompting, context and token cost, shared instruction files, skills, engineering discipline and safety.
- **Library**: official docs, author repos and open standards (including Matt Pocock's skills).
- **Habits**: daily tracker with streak, weekly review, skill template.
- **Coach**: builds an audit prompt to paste into any model.

## One-time setup (about 5 minutes)

1. Put these files in this repo and push to `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions tab → "Update news and deploy" → Run workflow.** The first run fetches the news and publishes the site.
4. Open `https://sbhogaita19.github.io/Headroom/`.
5. On your phone: open that URL, then **Share → Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome).

After that it updates itself every 6 hours. Nothing to run on your machine.

## How the auto-pull works

`.github/workflows/update-news.yml` runs `scripts/fetch-news.mjs`, which reads `config/sources.json`:

| Type | Source |
| --- | --- |
| `github-releases` | Releases of agent CLIs (Claude Code, Codex, Gemini CLI, Qwen Code, omp, herdr) |
| `github-commits` | Recent commits to skills repos (anthropics/skills, mattpocock/skills, agentskills) |
| `feed` | RSS/Atom blogs, filtered by keywords (OpenAI, Google AI, GitHub Changelog, Hugging Face, Simon Willison) |
| `hn` | Hacker News stories above a points threshold, labelled "Lead · verify" |

It writes `data/news.json` (committed back to the repo) and the site is redeployed. If one source fails, the others still update and the failed source keeps its previous items. The site shows how many sources were unavailable.

**Add a source:** add an object to `config/sources.json`. Mistral, DeepSeek and Anthropic don't have feeds I could confirm, so add them there if you find official ones.

## Habits without a server

- **Weekly digest issue:** every Monday the workflow opens a GitHub issue ("Headroom digest") assigned to you with the week's changes and a habit review checklist. The GitHub mobile app notifies you.
- **Habit of the day** and **focus of the week** rotate automatically in the app. Your ticks and streak are stored in your browser only.

## Optional: one-line "what it means" notes

Add a repository secret `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions). The fetcher then asks Claude to write a one-sentence takeaway for up to 10 new items per run, using only each item's title and summary. These are labelled "AI-written" in the app. Set the repository variable `ANTHROPIC_MODEL` to override the default model. Without the key, everything else works.

## Trust labels

- **Official**: the vendor's own repo or blog.
- **Author**: the creator's own repo or blog.
- **Lead · verify**: community or aggregator. Confirm with a primary source before acting.

## Notes

- Scheduled workflows can run a few minutes late, and GitHub pauses them after 60 days without repository activity. The bot's commits normally keep it active; if it pauses, re-enable it in the Actions tab.
- If Actions warns about outdated action versions, bump the versions in the workflow.
- Run locally: `python3 -m http.server 8000`. Fetch locally: `GITHUB_TOKEN=$(gh auth token) node scripts/fetch-news.mjs`.
