// Every control of every renewal page pressed in Next and in React, in step: what each shows after the press is compared line by line.
// Anything that could write is left out by name, and no request but a read leaves the browser. usage: node tests/parity/walkpair.mjs OUTFILE [regex]; NEXT_URL and REACT_URL name the two fronts.
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const require = createRequire(`${ROOT}/front/package.json`);
const { chromium } = require("playwright");
const NEXT = process.env.NEXT_URL || "http://127.0.0.1:3333";
const REACT = process.env.REACT_URL || "http://127.0.0.1:3334";
const P = "843ecb1b-4713-4c2a-8592-e173eb16b7c7";
const OUT = process.argv[2];
const ONLY = process.argv[3] ? new RegExp(process.argv[3]) : null;
const MAX = Number(process.env.MAX || 60);
const admin = Object.fromEntries(fs.readFileSync(`${ROOT}/.local/hub-test-admin.txt`, "utf8").split("\n").map((l) => l.match(/^(login|password): (.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const routes = ["dashboard", "standard/prompts", "standard/answer-analysis/mention", "standard/answer-analysis/mention?kpi=exposure", "standard/answer-analysis/mention?kpi=sov", "standard/answer-analysis/mention?kpi=favorability", "standard/answer-analysis/mention?kpi=first-rank",
  "standard/answer-analysis/citation", "standard/answer-analysis/citation/prompts", "standard/answer-analysis/citation/tone-urls", "standard/ai-funnel/acr", "standard/ai-funnel/conversion", "standard/ai-funnel/visibility",
  "website", "website/prompts", "website/answer-analysis/mention", "website/answer-analysis/mention?view=brands", "website/answer-analysis/citation", "website/answer-analysis/citation/prompts", "website/answer-analysis/citation/tone-urls", "website/ai-funnel/conversion",
  "projects", `projects/${P}`, `projects/${P}/analysis/mention`, `projects/${P}/analysis/citation`, `projects/${P}/analysis/citation/prompts`, `projects/${P}/analysis/citation/tone-urls`, `projects/${P}/prompt`, `projects/${P}/setting`, `projects/${P}/member`, `projects/${P}/intent/google-keyword`, `projects/${P}/intent/social-scraping`, `projects/${P}/ai-funnel/conversion`,
  "admin", "admin/standards/prompts", "admin/standards/citation-sources", "admin/standards/citation-sources?tab=seeds", "admin/standards/citation-sources?tab=social", "admin/standards/citation-sources?tab=codes", "admin/standards/customer-interest", "admin/standards/customer-interest?tab=sources", "admin/standards/entities", "admin/standards/measurement", "admin/ga4", "admin/keyword-tools"].map((r) => `/ko/renewal/${r}`).filter((r) => !ONLY || ONLY.test(r));
const WRITES = /제거|제외|해제|되돌리기|취소|승인|저장|삭제|보관|복원|추가|만들기|생성|등록|중지|다시 사용|측정 실행|전송|재생성|재설정|내보내기|다운로드|Excel|엑셀|Log out|로그아웃|비밀번호|언어|의견 메일|안내 닫기|검색량 조회|조회$|다시 시도|적용$|초기화|현재 조건|복사/;

const LOOK = () => {
  const c = document.body.cloneNode(true);
  c.querySelectorAll("#recharts_measurement_span").forEach((x) => x.remove());
  c.style.position = "absolute"; document.body.appendChild(c);
  const text = c.innerText; c.remove();
  return { url: location.pathname + location.search, lines: text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean), dialogs: document.querySelectorAll("[role=dialog],[role=alertdialog]").length };
};
const LIST = (writes) => {
  const re = new RegExp(writes); const seen = new Set(); const out = []; let rowsTaken = 0;
  document.querySelectorAll("[data-scn]").forEach((e) => e.removeAttribute("data-scn"));
  const els = [...document.querySelectorAll("main button, main [role=tab], main [role=radio], main [role=switch], main [role=button], main summary, main [role=combobox]:not(select)")];
  els.forEach((el) => {
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return;
    const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name || re.test(name) || seen.has(name)) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return;
    if (el.closest("[data-rn-section]") && !el.closest("[data-rn-section]").querySelector(":scope > button")?.contains(el) && el.getAttribute("role") !== "radio") return;
    if (el.closest("tbody")) { if (rowsTaken >= 3) return; rowsTaken++; }
    seen.add(name); el.setAttribute("data-scn", name); out.push(name);
  });
  return out;
};
const MARK = ([name, writes]) => {
  const re = new RegExp(writes);
  for (const el of document.querySelectorAll("main button, main [role=tab], main [role=radio], main [role=switch], main [role=button], main summary, main [role=combobox]:not(select)")) {
    const n = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const r = el.getBoundingClientRect();
    if (n === name && r.width > 0 && r.height > 0 && !re.test(n)) { el.setAttribute("data-scn", n); return true; }
  }
  return false;
};
class Side {
  constructor(front, ctx) { this.front = front; this.ctx = ctx; }
  async open() {
    this.p = await this.ctx.newPage(); this.inflight = 0; this.last = Date.now(); this.bad = []; this.errors = [];
    const mine = (r) => r.url().startsWith(this.front) && !/\/(_next\/static|src\/|node_modules\/|@vite|@react-refresh|@fs\/)/.test(r.url());
    // this walk only reads: whatever the name of a control, no write leaves the browser
    this.blocked = [];
    await this.p.route("**/api/**", (r) => { const m = r.request().method(); if (m === "GET" || m === "HEAD") return r.fallback(); this.blocked.push(`${m} ${r.request().url().slice(this.front.length, this.front.length + 90)}`); return r.abort(); });
    this.p.on("request", (r) => { if (mine(r)) { this.inflight++; this.last = Date.now(); } });
    const done = (r) => { if (mine(r)) { this.inflight = Math.max(0, this.inflight - 1); this.last = Date.now(); } };
    this.p.on("requestfinished", done); this.p.on("requestfailed", done);
    this.p.on("pageerror", (e) => this.errors.push(String(e).slice(0, 180)));
    this.p.on("response", (r) => { const u = r.url(); if (mine(r) && r.status() >= 400 && !u.includes("favicon")) this.bad.push(`${r.status()} ${r.request().method()} ${u.slice(this.front.length, this.front.length + 110)}`); });
  }
  async settle(cap = 9000) { const t0 = Date.now(); await this.p.waitForTimeout(150); while (Date.now() - t0 < cap) { if (this.inflight === 0 && Date.now() - this.last > 450) break; await this.p.waitForTimeout(60); } for (let i = 0; i < 12; i++) { const busy = await this.p.evaluate(() => document.querySelectorAll("main .animate-pulse").length).catch(() => 0); if (!busy) break; await this.p.waitForTimeout(150); } await this.p.waitForTimeout(120); }
  async home(route) { this.inflight = 0; await this.p.goto(this.front + route, { waitUntil: "domcontentloaded", timeout: 180000 }); await this.settle(30000); }
  look() { return this.p.evaluate(LOOK).catch(() => ({ url: "?", lines: [], dialogs: 0 })); }
  async press(name) {
    let el = this.p.locator(`[data-scn=${JSON.stringify(name)}]`).first();
    if (!(await el.count())) { await this.p.evaluate(MARK, [name, WRITES.source]); el = this.p.locator(`[data-scn=${JSON.stringify(name)}]`).first(); }
    if (!(await el.count())) return "gone";
    try { await el.click({ timeout: 2500 }); } catch (e) { return `clickfail: ${String(e).split("\n")[0].slice(0, 70)}`; }
    await this.settle();
    return null;
  }
}
const minus = (a, b) => { const m = new Map(); for (const x of b) m.set(x, (m.get(x) || 0) + 1); const out = []; for (const x of a) { const n = m.get(x) || 0; if (n) m.set(x, n - 1); else out.push(x); } return out; };
const norm = (x) => (x || "").replace(/^http:\/\/[^/]+/, "");

async function session(browser, front) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 915 }, locale: "ko-KR", acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript((d) => { try { localStorage.setItem("ggmd-beta-notice-hide-date", d); } catch {} }, today);
  const r = await ctx.request.post(`${front}/api/hub/session`, { data: { login: admin.login, password: admin.password }, headers: { Origin: front } });
  if (!r.ok()) throw new Error(`sign-in at ${front}: ${r.status()}`);
  return ctx;
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
const [cn, cr] = [await session(browser, NEXT), await session(browser, REACT)];
const out = fs.createWriteStream(OUT, { flags: "a" });
let pressedTotal = 0, diffTotal = 0;
for (const route of routes) {
  const n = new Side(NEXT, cn), r = new Side(REACT, cr);
  await n.open(); await r.open();
  const row = { route, pressed: 0, same: 0, diffs: [], listNext: [], listReact: [] };
  try {
    await Promise.all([n.home(route), r.home(route)]);
    const [ln, lr] = await Promise.all([n.p.evaluate(LIST, WRITES.source), r.p.evaluate(LIST, WRITES.source)]);
    row.listNext = minus(ln, lr); row.listReact = minus(lr, ln);
    const both = ln.filter((x) => lr.includes(x)).slice(0, MAX);
    for (const name of both) {
      const [before] = await Promise.all([n.look(), r.look()]);
      let [fn, fr] = await Promise.all([n.press(name), r.press(name)]);
      if (fn || fr) {
        // something left open covers the control: start the page over, and press again
        await Promise.all([n.p.keyboard.press("Escape"), r.p.keyboard.press("Escape")]);
        await Promise.all([n.home(route), r.home(route)]);
        await Promise.all([n.p.evaluate(LIST, WRITES.source), r.p.evaluate(LIST, WRITES.source)]);
        [fn, fr] = await Promise.all([n.press(name), r.press(name)]);
        if (fn && fr) { row.blocked = (row.blocked || 0) + 1; fn = fr = null; row.pressed--; row.same--; }
      }
      const [an, ar] = await Promise.all([n.look(), r.look()]);
      row.pressed++;
      const onlyN = minus(an.lines, ar.lines), onlyR = minus(ar.lines, an.lines);
      const urlSame = norm(an.url) === norm(ar.url);
      if (fn || fr || onlyN.length || onlyR.length || !urlSame || an.dialogs !== ar.dialogs) {
        row.diffs.push({ name, failNext: fn, failReact: fr, url: urlSame ? undefined : [an.url, ar.url], dialogs: an.dialogs !== ar.dialogs ? [an.dialogs, ar.dialogs] : undefined, onlyNext: onlyN.slice(0, 12), onlyReact: onlyR.slice(0, 12), counts: [onlyN.length, onlyR.length] });
      } else row.same++;
      // back to the page's first state when the press moved or opened anything
      const moved = an.url !== before.url || ar.url !== before.url || an.dialogs !== before.dialogs || ar.dialogs !== before.dialogs || (an.lines.length - before.lines.length > 12);
      if (moved) { await Promise.all([n.p.keyboard.press("Escape"), r.p.keyboard.press("Escape")]); await Promise.all([n.home(route), r.home(route)]); await Promise.all([n.p.evaluate(LIST, WRITES.source), r.p.evaluate(LIST, WRITES.source)]); }
    }
  } catch (e) { row.exception = String(e).slice(0, 240); }
  row.badNext = [...new Set(n.bad)].slice(0, 8); row.badReact = [...new Set(r.bad)].slice(0, 8); row.errNext = [...new Set(n.errors)].slice(0, 4); row.errReact = [...new Set(r.errors)].slice(0, 4); row.writesStopped = [...new Set([...n.blocked, ...r.blocked])].slice(0, 6);
  out.write(JSON.stringify(row) + "\n");
  pressedTotal += row.pressed; diffTotal += row.diffs.length;
  console.log(`${route.replace(P, "<P>").padEnd(62)} pressed ${String(row.pressed).padStart(3)} same ${String(row.same).padStart(3)} diff ${String(row.diffs.length).padStart(3)} listOnly -${row.listNext.length} +${row.listReact.length} blocked ${row.blocked || 0} bad ${row.badNext.length}/${row.badReact.length} err ${row.errNext.length}/${row.errReact.length}${row.exception ? " EXC" : ""}`);
  await n.p.close(); await r.p.close();
}
await browser.close();
console.log(`\n== pages ${routes.length}, pressed ${pressedTotal}, different ${diffTotal}`);
