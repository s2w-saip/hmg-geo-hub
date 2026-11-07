// Next and React side by side on the real service: the same account, the same address. For each page: final address, tab title, every line of text, every control, tables, charts, failed requests.
// Reads only. Nothing is pressed here. usage: node tests/parity/parity.mjs OUTDIR [base|en|enall|filter|axes|vars|bad|odd] [regex]; NEXT_URL and REACT_URL name the two fronts. Run it again before a switch: Next keeps moving.
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const require = createRequire(`${ROOT}/front/package.json`);
const { chromium } = require("playwright");
const NEXT = process.env.NEXT_URL || "http://127.0.0.1:3333";
const REACT = process.env.REACT_URL || "http://127.0.0.1:3334";
const P = "843ecb1b-4713-4c2a-8592-e173eb16b7c7";
const OUT = process.argv[2];
const SET = process.argv[3] || "base";
const ONLY = process.argv[4] ? new RegExp(process.argv[4]) : null;
const admin = Object.fromEntries(fs.readFileSync(`${ROOT}/.local/hub-test-admin.txt`, "utf8").split("\n").map((l) => l.match(/^(login|password): (.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
fs.mkdirSync(path.join(OUT, "shot"), { recursive: true });

const analysis = ["dashboard", "standard/answer-analysis/mention", "standard/answer-analysis/citation", "standard/ai-funnel/acr", "website", "website/answer-analysis/mention", "website/answer-analysis/citation", `projects/${P}`, `projects/${P}/analysis/mention`, `projects/${P}/analysis/citation`];
const SETS = {
  base: ["dashboard", "standard/prompts", "standard/answer-analysis/mention", "standard/answer-analysis/mention?kpi=exposure", "standard/answer-analysis/mention?kpi=sov", "standard/answer-analysis/mention?kpi=favorability", "standard/answer-analysis/mention?kpi=first-rank",
    "standard/answer-analysis/citation", "standard/answer-analysis/citation/prompts", "standard/answer-analysis/citation/tone-urls", "standard/ai-funnel/acr", "standard/ai-funnel/conversion", "standard/ai-funnel/visibility",
    "website", "website/prompts", "website/answer-analysis/mention", "website/answer-analysis/citation", "website/answer-analysis/citation/prompts", "website/answer-analysis/citation/tone-urls", "website/ai-funnel/conversion",
    "projects", `projects/${P}`, `projects/${P}/analysis/mention`, `projects/${P}/analysis/citation`, `projects/${P}/analysis/citation/prompts`, `projects/${P}/analysis/citation/tone-urls`, `projects/${P}/prompt`, `projects/${P}/setting`, `projects/${P}/member`, `projects/${P}/intent/google-keyword`, `projects/${P}/intent/social-scraping`, `projects/${P}/ai-funnel/conversion`,
    "admin", "admin/standards/prompts", "admin/standards/citation-sources", "admin/standards/citation-sources?tab=seeds", "admin/standards/citation-sources?tab=social", "admin/standards/citation-sources?tab=codes", "admin/standards/customer-interest", "admin/standards/customer-interest?tab=sources", "admin/standards/entities", "admin/standards/measurement", "admin/ga4", "admin/keyword-tools"].map((r) => `/ko/renewal/${r}`),
  en: ["dashboard", "standard/prompts", "standard/answer-analysis/mention", "standard/answer-analysis/citation", "standard/ai-funnel/acr", "website", "website/prompts", "projects", `projects/${P}`, `projects/${P}/setting`, "admin", "admin/standards/measurement"].map((r) => `/en/renewal/${r}`),
  filter: analysis.flatMap((r) => [`/ko/renewal/${r}?brand=Kia&geography=KR`, `/ko/renewal/${r}?time=2026-09-07_2026-10-05`]),
  bad: ["brand=없는브랜드", "geography=ZZ", "time=abc", "time=2030-01-01_2030-02-01", "engine=none", "kpi=nope", "view=nope", "tab=nope", "page=-1", "page=abc", "q=%3Cscript%3E"].flatMap((q) => ["dashboard", "standard/answer-analysis/mention", "standard/answer-analysis/citation", "standard/ai-funnel/acr", "website", "website/answer-analysis/citation", `projects/${P}`].map((r) => `/ko/renewal/${r}?${q}`)),
  axes: ["brand=Hyundai", "brand=Genesis&brand=Kia", "geography=BR", "language=en", "engine=gemini", "promptContext=%EB%B9%84%EA%B5%90%2F%EA%B2%80%EC%A6%9D", "brandPresence=unbranded", "listType=Consumer+base+Response", "depth1=1.+Car%2BFeatures", "source=Wiki+%26+Reference"].flatMap((q) => analysis.map((r) => `/ko/renewal/${r}?${q}`)),
  vars: ["standard/answer-analysis/mention?tab=cmp", "standard/answer-analysis/mention?view=brands", "website/answer-analysis/mention?view=brands", "standard/answer-analysis/citation?tab=domains", "standard/answer-analysis/citation/prompts?tab=uncited", "standard/answer-analysis/citation/prompts?page=2", "standard/answer-analysis/citation/prompts?q=suv", "standard/answer-analysis/citation/tone-urls?tone=negative", "standard/answer-analysis/citation/tone-urls?page=2", "standard/answer-analysis/citation/tone-urls?byDomain=1", "website/answer-analysis/citation/prompts?tab=uncited", "website/answer-analysis/citation/prompts?brand=Kia", "website/answer-analysis/citation/tone-urls?tone=negative", "website/answer-analysis/citation/tone-urls?geography=KR", `projects/${P}/analysis/citation/prompts?tab=uncited`, `projects/${P}/analysis/citation/tone-urls?tone=negative`, "standard/prompts?tab=history", "website/prompts?engine=gemini", "website/prompts?time=2026-09-07_2026-10-05", `projects/${P}/prompt?geography=KR`, "standard/ai-funnel/conversion?days=7", "standard/ai-funnel/visibility?view=page", "standard/ai-funnel/visibility?days=7", "website/ai-funnel/conversion?days=90", "admin/standards/prompts?q=suv", "admin/standards/measurement?q=kr", "admin?q=test", "standard/answer-analysis/mention?kpi=sov&brand=Kia&time=2026-09-07_2026-10-05", "standard/ai-funnel/acr?time=2026-09-28_2026-10-05&engine=chatgpt"].map((r) => `/ko/renewal/${r}`),
  odd: ["standard/answer-analysis", "standard/ai-funnel", "website/answer-analysis", "website/ai-funnel", "admin/standards", "no-such-page", `projects/${P}/analysis`, `projects/${P}/intent`, `projects/${P}/ai-funnel`, `projects/${P}/no-such`, "projects/00000000-0000-0000-0000-000000000000", "projects/not-a-uuid"].map((r) => `/ko/renewal/${r}`).concat(["/ko", "/ko/login", "/ko/no-access", "/", "/ko/change-password"]),
};
SETS.enall = SETS.base.map((r) => r.replace("/ko/", "/en/"));
const routes = SETS[SET].filter((r) => !ONLY || ONLY.test(r));

async function open(browser, front) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 915 }, locale: "ko-KR", acceptDownloads: true });
  await ctx.addInitScript((d) => { try { localStorage.setItem("ggmd-beta-notice-hide-date", d); } catch {} }, today);
  const r = await ctx.request.post(`${front}/api/hub/session`, { data: { login: admin.login, password: admin.password }, headers: { Origin: front } });
  if (!r.ok()) throw new Error(`sign-in at ${front}: ${r.status()}`);
  return ctx;
}

const LOOK = () => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = (e) => (e.getAttribute("aria-label") || e.innerText || e.getAttribute("title") || e.getAttribute("placeholder") || e.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 70);
  const main = document.querySelector("main") || document.body;
  const controls = [...document.querySelectorAll("button,a[href],input,select,textarea,[role=tab],[role=radio],[role=switch],[role=checkbox],[role=combobox],summary")].filter(vis).map((e) => `${e.tagName.toLowerCase()}${e.getAttribute("role") ? ":" + e.getAttribute("role") : ""} ${name(e)}${e.tagName === "A" ? " -> " + (e.getAttribute("href") || "").replace(/^https?:\/\/(127\.0\.0\.1|localhost):\d+/, "") : ""}${e.disabled ? " [disabled]" : ""}`);
  const tables = [...main.querySelectorAll("table")].filter(vis).map((t) => t.querySelectorAll("tbody tr").length);
  return {
    url: location.pathname + location.search, title: document.title,
    lines: (() => { const c = document.body.cloneNode(true); c.querySelectorAll("#recharts_measurement_span").forEach((x) => x.remove()); document.body.appendChild(c); c.style.position = "absolute"; const s = c.innerText; c.remove(); return s; })().split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean),
    controls, tables, charts: main.querySelectorAll("svg.recharts-surface").length, svgs: main.querySelectorAll("svg").length,
    busy: main.querySelectorAll('[aria-busy="true"],[role=status]').length,
  };
};

async function look(ctx, front, route, shot) {
  const p = await ctx.newPage();
  let inflight = 0, last = Date.now();
  const bad = [], errors = [], reads = [];
  const mine = (r) => r.url().startsWith(front) && !/\/(_next\/static|src\/|node_modules\/|@vite|@react-refresh|@fs\/)/.test(r.url());
  p.on("request", (r) => { if (mine(r)) { inflight++; last = Date.now(); } });
  const done = (r) => { if (mine(r)) { inflight = Math.max(0, inflight - 1); last = Date.now(); } };
  p.on("requestfinished", done); p.on("requestfailed", done);
  p.on("pageerror", (e) => errors.push(String(e).slice(0, 220)));
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push("console: " + m.text().slice(0, 220)); });
  p.on("response", (r) => { const u = r.url(); if (mine(r) && r.status() >= 400 && !u.includes("favicon")) bad.push(`${r.status()} ${r.request().method()} ${u.slice(front.length, front.length + 130)}`); if (u.includes("/api/") && mine(r)) reads.push(`${r.status()} ${u.slice(front.length, front.length + 170)}`); });
  const t0 = Date.now();
  let status = null;
  try {
    const res = await p.goto(front + route, { waitUntil: "domcontentloaded", timeout: 180000 });
    status = res?.status() ?? null;
    await p.waitForTimeout(250);
    while (Date.now() - t0 < 90000) { if (inflight === 0 && Date.now() - last > 900) break; await p.waitForTimeout(100); }
    // a page may keep a skeleton on the way in: wait for it to leave, within reason
    for (let i = 0; i < 40; i++) { const busy = await p.evaluate(() => document.querySelectorAll('main [role=status], main .animate-pulse').length).catch(() => 0); if (!busy) break; await p.waitForTimeout(250); }
    await p.waitForTimeout(250);
  } catch (e) { errors.push("goto: " + String(e).slice(0, 200)); }
  const seen = await p.evaluate(LOOK).catch((e) => ({ url: "?", title: "?", lines: [], controls: [], tables: [], charts: 0, svgs: 0, busy: 0, failed: String(e).slice(0, 100) }));
  await p.screenshot({ path: shot }).catch(() => {});
  await p.close();
  return { ...seen, status, ms: Date.now() - t0, bad: [...new Set(bad)], errors: [...new Set(errors)], reads };
}

const minus = (a, b) => { const m = new Map(); for (const x of b) m.set(x, (m.get(x) || 0) + 1); const out = []; for (const x of a) { const n = m.get(x) || 0; if (n) m.set(x, n - 1); else out.push(x); } return out; };

const browser = await chromium.launch({ channel: "chrome", headless: true });
const [cn, cr] = [await open(browser, NEXT), await open(browser, REACT)];
const rows = [];
for (const route of routes) {
  const key = route.replace(/[^a-z0-9]+/gi, "_").slice(0, 90);
  const [n, r] = await Promise.all([look(cn, NEXT, route, `${OUT}/shot/${key}.next.png`), look(cr, REACT, route, `${OUT}/shot/${key}.react.png`)]);
  const row = {
    route, url: n.url === r.url ? "same" : { next: n.url, react: r.url }, title: n.title === r.title ? "same" : { next: n.title, react: r.title },
    onlyNext: minus(n.lines, r.lines), onlyReact: minus(r.lines, n.lines), ctlNext: minus(n.controls, r.controls), ctlReact: minus(r.controls, n.controls),
    tables: [n.tables, r.tables], charts: [n.charts, r.charts], svgs: [n.svgs, r.svgs], ms: [n.ms, r.ms], status: [n.status, r.status],
    badNext: n.bad, badReact: r.bad, errNext: n.errors, errReact: r.errors, readsReact: r.reads, lineCount: [n.lines.length, r.lines.length],
  };
  rows.push(row);
  const same = row.url === "same" && row.title === "same" && !row.onlyNext.length && !row.onlyReact.length && !row.ctlNext.length && !row.ctlReact.length && JSON.stringify(row.tables[0]) === JSON.stringify(row.tables[1]) && row.charts[0] === row.charts[1] && !row.badReact.length && !row.errReact.length;
  row.same = same;
  console.log(`${same ? "SAME" : "DIFF"} ${route.replace(P, "<P>").padEnd(62)} lines ${n.lines.length}/${r.lines.length} -${row.onlyNext.length} +${row.onlyReact.length} ctl -${row.ctlNext.length} +${row.ctlReact.length} tbl ${JSON.stringify(n.tables)}/${JSON.stringify(r.tables)} ch ${n.charts}/${r.charts} bad ${n.bad.length}/${r.bad.length} err ${n.errors.length}/${r.errors.length} ${(n.ms / 1000).toFixed(1)}s/${(r.ms / 1000).toFixed(1)}s`);
  fs.writeFileSync(`${OUT}/${SET}.json`, JSON.stringify(rows, null, 1));
}
await browser.close();
const same = rows.filter((x) => x.same).length;
console.log(`\n== ${SET}: ${rows.length} pages, same ${same}, different ${rows.length - same}`);
