// Fetches agentic-AI news from the sources in config/sources.json and writes
// data/news.json (used by the site) and digest.md (used for the weekly issue).
// Node 20+, no dependencies. Each source fails independently; a failed source
// keeps its items from the previous run.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = process.env.HEADROOM_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UA = "headroom-news-bot (+https://github.com/sbhogaita19/Headroom)";
const DAY = 86400000;

/* ---------- small parsing helpers (exported for tests) ---------- */
export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
export function toText(s = "") {
  const noCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodeEntities(noCdata).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}
function linkOf(block) {
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map(m => m[1]).filter(a => /href=/i.test(a));
  const pick = links.find(a => /rel=["']alternate["']/i.test(a)) || links.find(a => !/rel=/i.test(a)) || links[0];
  if (pick) { const h = pick.match(/href=["']([^"']+)["']/i); if (h) return decodeEntities(h[1]); }
  const t = toText(tagText(block, "link")) || toText(tagText(block, "guid"));
  return /^https?:\/\//.test(t) ? t : "";
}
export function parseFeed(xml) {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  return blocks.map(b => {
    const date = toText(tagText(b, "pubDate") || tagText(b, "published") || tagText(b, "updated") || tagText(b, "dc:date"));
    const summary = toText(tagText(b, "description") || tagText(b, "summary") || tagText(b, "content") || tagText(b, "content:encoded"));
    const d = new Date(date);
    return { title: toText(tagText(b, "title")), url: linkOf(b), date: isNaN(d) ? null : d.toISOString(), summary: summary.slice(0, 280) };
  }).filter(i => i.title && i.url);
}

/* ---------- network ---------- */
async function getText(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}
function ghHeaders() {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/* ---------- source handlers ---------- */
async function fromReleases(src, n) {
  const arr = JSON.parse(await getText(`https://api.github.com/repos/${src.repo}/releases?per_page=${n + 4}`, ghHeaders()));
  return arr.filter(r => !r.draft && !r.prerelease).slice(0, n).map(r => ({
    title: `${src.repo} ${r.name || r.tag_name}`.trim(), url: r.html_url,
    date: r.published_at || r.created_at, summary: toText((r.body || "").replace(/[#*_`>-]/g, " ")).slice(0, 280), kind: "release"
  }));
}
async function fromCommits(src, n) {
  const arr = JSON.parse(await getText(`https://api.github.com/repos/${src.repo}/commits?per_page=${n}`, ghHeaders()));
  return arr.map(c => ({
    title: `${src.repo}: ${(c.commit.message || "").split("\n")[0]}`.slice(0, 200), url: c.html_url,
    date: c.commit.author?.date || c.commit.committer?.date, summary: "", kind: "commit"
  }));
}
async function fromFeed(src, n) {
  const items = parseFeed(await getText(src.url, { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }));
  const re = src.keywords ? new RegExp(src.keywords, "i") : null;
  return items.filter(i => !re || re.test(i.title + " " + i.summary)).slice(0, n).map(i => ({ ...i, kind: "post" }));
}
async function fromHN(src, n) {
  const since = Math.floor((Date.now() - 14 * DAY) / 1000);
  const seen = new Map();
  for (const q of src.queries || []) {
    const u = `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=20&query=${encodeURIComponent(q)}&numericFilters=${encodeURIComponent(`points>=${src.minPoints || 50},created_at_i>${since}`)}`;
    const j = JSON.parse(await getText(u));
    for (const h of j.hits || []) if (h.title && !seen.has(h.objectID)) seen.set(h.objectID, h);
  }
  return [...seen.values()].sort((a, b) => b.points - a.points).slice(0, n).map(h => ({
    title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    date: h.created_at, summary: `${h.points} points on Hacker News`, kind: "discussion"
  }));
}
const HANDLERS = { "github-releases": fromReleases, "github-commits": fromCommits, feed: fromFeed, hn: fromHN };

/* ---------- optional AI notes (Groq first, Anthropic as fallback) ---------- */
const GROQ_MODELS = (process.env.GROQ_MODELS || "openai/gpt-oss-120b,llama-3.3-70b-versatile").split(",").map(s => s.trim()).filter(Boolean);

async function askModel(prompt) {
  const errors = [];
  if (process.env.GROQ_API_KEY) {
    for (const model of GROQ_MODELS) {
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({ model, temperature: 0.2, max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
          signal: AbortSignal.timeout(60000)
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const text = j.choices?.[0]?.message?.content;
        if (text) return text;
        throw new Error("empty reply");
      } catch (e) { errors.push(`groq ${model}: ${e.message}`); console.warn("model error:", errors.at(-1)); }
    }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(60000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      if (text) return text;
    } catch (e) { errors.push(`anthropic: ${e.message}`); console.warn("model error:", errors.at(-1)); }
  }
  if (!errors.length) return null; // no key configured
  throw new Error(errors.join("; "));
}

export function parseNotes(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("["), end = clean.lastIndexOf("]");
  return JSON.parse(clean.slice(start, end + 1));
}

async function annotate(items) {
  if (!process.env.GROQ_API_KEY && !process.env.ANTHROPIC_API_KEY) return 0;
  const todo = items.filter(i => !i.why && i.date && Date.now() - new Date(i.date) < 14 * DAY).slice(0, 12);
  if (!todo.length) return 0;
  const payload = todo.map(i => ({ id: i.url, title: i.title, source: i.source, summary: i.summary }));
  const prompt = "For each item, write one sentence (max 25 words) on what it means in practice for a developer who uses several coding agents and cares about token cost, prompt terseness, security and good habits. Use ONLY the title, source and summary given; do not add facts. If nothing practical follows, write \"Awareness only.\". Reply with a JSON array of {\"id\": string, \"why\": string} and nothing else.\n\n" + JSON.stringify(payload);
  const text = await askModel(prompt);
  if (!text) return 0;
  let n = 0;
  for (const a of parseNotes(text)) { const it = todo.find(i => i.url === a.id); if (it && typeof a.why === "string") { it.why = a.why.slice(0, 220); it.whyBy = "ai"; n++; } }
  return n;
}

/* ---------- main ---------- */
async function readJSON(p, fallback) { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; } }
function isoWeek(d = new Date()) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7); }

export function buildDigest(items, focus, now = new Date()) {
  const week = items.filter(i => i.date && now - new Date(i.date) < 7 * DAY);
  const group = (tier, title) => { const g = week.filter(i => i.tier === tier).slice(0, 8); return g.length ? `### ${title}\n` + g.map(i => `- [${i.title}](${i.url}) · ${i.source}${i.why ? `\n  - ${i.why}${i.whyBy === "ai" ? " _(AI-written)_" : ""}` : ""}`).join("\n") + "\n" : ""; };
  const f = focus[isoWeek(now) % focus.length];
  return `# Headroom digest · ${now.toISOString().slice(0, 10)}\n\n## Focus this week: ${f.title}\n${f.action}\n\n## What changed (last 7 days)\n${group("official", "Official") || ""}${group("author", "Authors") || ""}${group("lead", "Leads to verify (community / news)") || ""}${week.length ? "" : "_Nothing new in the last 7 days._\n"}\n## Weekly habit review\n- [ ] Promote one repeated prompt into a skill\n- [ ] Prune AGENTS.md\n- [ ] Check which model tier I used for each task\n- [ ] Read one primary source from above\n- [ ] Review one agent PR as if a stranger wrote it\n`;
}

async function main() {
  const cfg = await readJSON(path.join(ROOT, "config/sources.json"), null);
  if (!cfg) throw new Error("config/sources.json missing");
  const prev = await readJSON(path.join(ROOT, "data/news.json"), { items: [] });
  const focus = await readJSON(path.join(ROOT, "data/focus.json"), [{ title: "Brief before build", action: "Write goal, done-criteria and a verify command.", tab: "habits" }]);
  const status = [], fresh = [];

  for (const src of cfg.sources) {
    const n = src.maxItems || cfg.maxItemsPerSource || 6;
    try {
      const got = await HANDLERS[src.type](src, n);
      got.forEach(g => fresh.push({ ...g, source: src.name, sourceId: src.id, tier: src.tier, tags: src.tags || ["open"] }));
      status.push({ id: src.id, name: src.name, ok: true, count: got.length });
      console.log(`ok   ${src.id}: ${got.length}`);
    } catch (e) {
      status.push({ id: src.id, name: src.name, ok: false, error: String(e.message || e).slice(0, 160) });
      console.warn(`FAIL ${src.id}: ${e.message}`);
    }
  }
  const failed = new Set(status.filter(s => !s.ok).map(s => s.id));
  const old = new Map((prev.items || []).map(i => [i.url, i]));
  const merged = new Map();
  for (const i of fresh) { const o = old.get(i.url); merged.set(i.url, { ...i, ...(o && o.why ? { why: o.why, whyBy: o.whyBy } : {}) }); }
  for (const i of prev.items || []) if (failed.has(i.sourceId) && !merged.has(i.url)) merged.set(i.url, i);

  const cutoff = Date.now() - (cfg.maxAgeDays || 45) * DAY;
  let items = [...merged.values()].filter(i => !i.date || new Date(i.date) > cutoff)
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, cfg.maxTotalItems || 150);

  try { const n = await annotate(items); if (n) console.log(`AI notes added: ${n}`); } catch (e) { console.warn("AI notes skipped:", e.message); }

  if (!fresh.length && (prev.items || []).length) { console.warn("No source returned items; keeping previous data."); items = prev.items; }
  const out = { generatedAt: new Date().toISOString(), sources: status, items };
  await fs.writeFile(path.join(ROOT, "data/news.json"), JSON.stringify(out, null, 2) + "\n");
  await fs.writeFile(path.join(ROOT, "digest.md"), buildDigest(items, focus));
  console.log(`Wrote ${items.length} items from ${status.filter(s => s.ok).length}/${status.length} sources.`);
  if (status.every(s => !s.ok)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
