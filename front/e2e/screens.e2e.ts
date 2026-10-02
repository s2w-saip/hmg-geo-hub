import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  type Account,
  type BrowserLog,
  type CaseDef,
  type Check,
  type ScreenDef,
  type Slices,
  type TapEntry,
  type TraceEntry,
  apiKey,
  attachCollectors,
  authConfig,
  authStats,
  blockExternal,
  is2xx,
  latestTraceValue,
  loadAccounts,
  loadAllowConsole,
  loadScreens,
  newBrowserLog,
  nextOverlay,
  norm,
  openSlices,
  OUT_ROOT,
  peakConcurrency,
  prepareContext,
  quiesce,
  qaPassword,
  readMessage,
  RUN_DIR,
  statePath,
  tapSpan,
  writeResult,
} from "./harness";
import { loginViaForm, qaGateLogin, QA_ADD_NOTE, QA_SAVE, QA_SIGN_OUT, settle, waitForPath } from "./flows";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// One test per (screen, case) from e2e/screens.json (design 5.3 collection, 5.4 criteria that
// apply today). Each case: fresh browser context (storage state of its account), external
// network blocked, then the flow, then checks on what the browser, the app trace
// (HGH_API_TRACE_FILE), the header tap and the server logs recorded during that case only.
// Results: e2e/.out/<run>/<screen>__<case>.{png,json} and results.jsonl (report: node e2e/report.mjs).

const doc = loadScreens();
const { password, accounts } = loadAccounts();
const byKey = new Map<string, Account>(accounts.map((a) => [a.key, a]));
const allow = loadAllowConsole();
const LOCALE = doc.defaults.locale;
const DASH_ERROR = readMessage("dashError.title", LOCALE);
const runId = () => process.env.E2E_RUN_ID ?? "adhoc";
const FINAL_PATH: Partial<Record<CaseDef["expect"], string>> = {
  "no-access": `/${LOCALE}/no-access`,
  login: `/${LOCALE}/login`,
  "qa-gate": `/${LOCALE}/raw-data-qa`,
};

for (const screen of doc.screens) {
  if (screen.cases.length === 0) {
    test.skip(`${screen.id} pending ${screen.unit}`, () => undefined);
    continue;
  }
  for (const c of screen.cases) {
    const name = c.name ?? c.account ?? "anonymous";
    test(`${screen.id} ${name}`, async ({ browser }) => {
      await runCase(browser, screen, c, name);
    });
  }
}

test("d1-token-path", async () => {
  // D1 locally: the front verified sessions through JWKS (getClaims, asymmetric), never the
  // /auth/v1/user fallback, and every Bearer that reached the backend was the mock's ES256
  // token. The real Supabase alg can only be seen on stg (reported separately).
  const stats = await authStats();
  const tap = readFileSync(join(RUN_DIR, "tap.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TapEntry);
  const bearer = tap.filter((e) => e.auth?.scheme.toLowerCase() === "bearer");
  const algs = [...new Set(bearer.map((e) => `${e.auth?.alg}/${e.auth?.kid}`))];
  const checks: Check[] = [
    { name: "front used JWKS, not /auth/v1/user", ok: (stats.user ?? 0) === 0 && (stats.jwks ?? 0) >= 1, detail: `jwks ${stats.jwks ?? 0}, user ${stats.user ?? 0}` },
    { name: "Bearer calls reached the backend", ok: bearer.length > 0, detail: `${bearer.length} calls` },
    { name: "every Bearer is ES256 kid e2e-kid", ok: algs.length === 1 && algs[0] === "ES256/e2e-kid", detail: algs.join(", ") },
  ];
  writeResult(runId(), "d1-token-path", { runId: runId(), screen: "d1-token-path", unit: "U3", case: "all", checks, authStats: stats });
  expect(checks.filter((c) => !c.ok), JSON.stringify(checks)).toEqual([]);
});

// ── one case ────────────────────────────────────────────────────────────────

interface Capture {
  log: BrowserLog;
  slices: Slices;
}

async function runCase(browser: Browser, screen: ScreenDef, c: CaseDef, name: string): Promise<void> {
  const fileKey = `${screen.id}__${name}`.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const fresh = screen.flow === "login" || screen.flow === "refresh";
  const context = await browser.newContext(c.account && !fresh ? { storageState: statePath(c.account) } : {});
  const setupLog = newBrowserLog();
  await blockExternal(context, setupLog);
  await prepareContext(context);

  let path = c.path ?? screen.path;
  const checks: Check[] = [];
  try {
    if (c.resolve) path = await resolvePath(context, path, c.resolve.var, c.resolve.from, c.resolve.route, c.resolve.jsonPath);
  } catch (e) {
    checks.push({ name: "resolve path placeholder", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
  // Server work of the previous case (a navigation still streaming when its context closed) must
  // not land in this case's slices.
  await quiesce();

  const page = await context.newPage();
  const cap: Capture = { log: newBrowserLog(), slices: openSlices() };
  attachCollectors(page, cap.log);
  // external requests of this page also land in the setup log (context-level route): merged below
  const restart = () => {
    const fresh2 = newBrowserLog();
    Object.assign(cap.log, fresh2);
    cap.slices = openSlices();
  };

  const t0 = Date.now();
  let docStatus: number | null = null;
  let loadAt = Date.now();
  const extra: Record<string, unknown> = {};
  const account = c.account && c.account !== "QA" ? byKey.get(c.account) : undefined;
  if (c.account && c.account !== "QA" && !account) throw new Error(`unknown account ${c.account}`);

  try {
    if (checks.some((k) => !k.ok)) throw new Error("case setup failed");
    switch (screen.flow) {
      case "visit": {
        const res = await page.goto(path, { waitUntil: "domcontentloaded" });
        docStatus = res?.status() ?? null;
        await settle(page);
        break;
      }
      case "login": {
        await loginViaForm(page, account!.email, c.password === "wrong" ? `${password}-wrong` : password, LOCALE);
        break;
      }
      case "refresh": {
        await authConfig({ email: account!.email, exp_in: c.expIn ?? 30 });
        const s0 = await authStats();
        await loginViaForm(page, account!.email, password, LOCALE);
        restart(); // the landing page belongs to login-landing; this case checks the next navigation
        await page.waitForTimeout(1_500);
        const res = await page.goto(path, { waitUntil: "domcontentloaded" });
        docStatus = res?.status() ?? null;
        await settle(page);
        const s1 = await authStats();
        const d = (k: string) => (s1[k] ?? 0) - (s0[k] ?? 0);
        extra.refresh = { ok: d("token:refresh:ok"), grace: d("token:refresh:grace"), reused: d("token:refresh:reused"), notFound: d("token:refresh:not_found") };
        checks.push({ name: "short-lived token was refreshed", ok: d("token:refresh:ok") >= 1, detail: JSON.stringify(extra.refresh) });
        checks.push({ name: "no refresh token reuse outside grace", ok: d("token:refresh:reused") === 0 && d("token:refresh:not_found") === 0, detail: JSON.stringify(extra.refresh) });
        break;
      }
      case "qaGate": {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await settle(page);
        await page.locator("#qa-name").fill(c.reviewer ?? "e2e-gate");
        await page.locator("#qa-password").fill(c.password === "wrong" ? `${qaPassword()}-wrong` : qaPassword());
        const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/qa/session");
        await page.locator("form button[type=submit]").click();
        extra.gateStatus = (await answer).status();
        if (c.landing) await waitForPath(page, c.landing);
        else await settle(page);
        break;
      }
      case "qaNote": {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await settle(page);
        await page.getByRole("button", { name: QA_ADD_NOTE(), exact: true }).first().click();
        const dialog = page.getByRole("dialog");
        await dialog.locator("textarea").fill(c.noteBody ?? "e2e note");
        const saved = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/qa/note");
        await dialog.getByRole("button", { name: QA_SAVE(), exact: true }).click();
        extra.noteStatus = (await saved).status();
        checks.push({ name: "note saved (POST /api/qa/note 200)", ok: extra.noteStatus === 200, detail: String(extra.noteStatus) });
        await settle(page);
        break;
      }
      case "qaLogout": {
        const status = await qaGateLogin(page, c.reviewer ?? "e2e-logout", qaPassword(), LOCALE);
        checks.push({ name: "gate login for logout case", ok: status === 200, detail: String(status) });
        // The QA header (reviewer, tabs, sign out) only appears after a full load: the shared
        // raw-data-qa layout is not re-rendered by the gate's client navigation (finding F2).
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await settle(page);
        const out = page.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === "/api/qa/session");
        await page.getByRole("button", { name: QA_SIGN_OUT(), exact: true }).click();
        extra.logoutStatus = (await out).status();
        await settle(page);
        const res = await page.goto(path, { waitUntil: "domcontentloaded" });
        docStatus = res?.status() ?? null;
        await settle(page);
        const qaCookie = (await context.cookies()).some((k) => k.name === "raw_data_qa" && k.value !== "");
        checks.push({ name: "QA cookie cleared in the browser", ok: !qaCookie });
        break;
      }
    }
    const wantFinal = c.landing ?? FINAL_PATH[c.expect];
    if (wantFinal && screen.flow !== "visit") await waitForPath(page, wantFinal);
    loadAt = Date.now();
    await evaluateCase(page, screen, c, path, docStatus, loadAt, cap, checks, extra);
  } catch (e) {
    checks.push({ name: "flow completed", ok: false, detail: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300) });
  }
  // next dev exits and restarts itself when its used heap passes 80% of the heap cap
  // (next/dist/server/lib/start-server.js, checked after each request) and drops the request in
  // flight, which shows up as a 25 s goto timeout. That is the local dev server, not the screen:
  // named here so the failure reads as such (2026-09-30, second full run on one next dev process).
  if (cap.slices.front.lines().some((l) => l.includes("approaching the used memory threshold"))) {
    checks.push({
      name: "next dev did not restart during the case (heap threshold: local dev server, not the screen)",
      ok: false,
      detail: "fresh next dev per full run: bash e2e/stack.sh down && bash e2e/stack.sh up",
    });
  }

  const shot = join(OUT_ROOT, runId(), `${fileKey}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
  await Promise.all(cap.log.pending);
  const external = [...new Set([...setupLog.external, ...cap.log.external])];
  if (external.length) checks.push({ name: "no external network", ok: false, detail: external.join(", ") });

  const trace = cap.slices.trace.jsonl<TraceEntry>();
  const tap = cap.slices.tap.jsonl<TapEntry>().filter((e) => e.path.startsWith("/v1/"));
  const result = {
    runId: runId(),
    screen: screen.id,
    unit: screen.unit,
    case: name,
    account: c.account,
    flow: screen.flow,
    expect: c.expect,
    path,
    finalUrl: pathOf(page.url()),
    docStatus,
    ms: loadAt - t0,
    ok: checks.every((k) => k.ok),
    checks,
    apis: trace.map((e) => ({ api: apiKey(e), path: e.path, status: e.status, ms: e.ms, attempt: e.attempt, code: e.code, query: e.query, values: e.values })),
    tap: tap.map((e) => ({ api: `${e.method} ${e.path}`, status: e.status, ms: e.ms, auth: e.auth, cookieNames: e.cookieNames, setCookieNames: e.setCookieNames })),
    browser: {
      apiResponses: cap.log.apiResponses,
      documents: cap.log.documents,
      requestFailed: cap.log.requestFailed,
      external,
    },
    extra,
    screenshot: shot.slice(shot.indexOf("/e2e/") + 1),
  };
  writeResult(runId(), fileKey, result);
  await releaseQaLock(page, cap.log);
  await context.close();
  if (screen.flow === "refresh" && account) await authConfig({ email: account.email, exp_in: null }).catch(() => undefined);

  const failed = checks.filter((k) => !k.ok);
  expect(failed, failed.map((k) => `${k.name}: ${k.detail ?? ""}`).join("\n")).toEqual([]);
}

/**
 * A QA detail page holds an answer lock (TTL 180 s) until its pagehide beacon releases it. Closing
 * the context skips pagehide, and the next run's reviewer session would then find the answer
 * locked (read-only, note button disabled). Leave the page the way a user does and wait for the
 * release to reach the server. Runs after the case result is written, so it is not part of it.
 */
async function releaseQaLock(page: Page, log: BrowserLog): Promise<void> {
  if (!log.apiResponses.some((r) => r.method === "POST" && r.path === "/api/qa/lock")) return;
  const released = page
    .waitForResponse((r) => new URL(r.url()).pathname === "/api/qa/lock" && r.request().method() !== "PATCH" && r.request().method() !== "GET" && (r.request().method() === "DELETE" || new URL(r.url()).searchParams.get("release") === "1"), { timeout: 5_000 })
    .catch(() => null);
  await page.goto("about:blank").catch(() => undefined);
  await released;
}

function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

async function resolvePath(context: import("@playwright/test").BrowserContext, path: string, v: string, from: string, route: string, jsonPath: string): Promise<string> {
  let value = latestTraceValue(route, jsonPath);
  if (value === null) {
    const p = await context.newPage();
    await p.goto(from, { waitUntil: "domcontentloaded" });
    await settle(p);
    await p.close();
    value = latestTraceValue(route, jsonPath);
  }
  if (value === null) throw new Error(`could not resolve {${v}} from ${route} ${jsonPath}`);
  return path.replace(`{${v}}`, encodeURIComponent(String(value)));
}

// ── checks (design 5.4 items that apply to converted screens today) ──────────

async function evaluateCase(
  page: Page,
  screen: ScreenDef,
  c: CaseDef,
  path: string,
  docStatus: number | null,
  loadAt: number,
  cap: Capture,
  checks: Check[],
  extra: Record<string, unknown>,
): Promise<void> {
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const finalPath = new URL(page.url()).pathname;
  const legacyLeaf = screen.leaf === "legacy";
  const legacyOk = legacyLeaf && c.expect === "ok";
  const wantPath = new URL(path, "http://x").pathname;

  // 1. outcome (render / permission scenario)
  switch (c.expect) {
    case "ok":
      add("final path", finalPath === (c.landing ?? wantPath), `${finalPath} (want ${c.landing ?? wantPath})`);
      if (docStatus !== null) add("document 200", docStatus === 200, String(docStatus));
      break;
    case "no-access":
      add("redirected to no-access", finalPath === `/${LOCALE}/no-access`, finalPath);
      break;
    case "not-found": {
      // (dash)/loading.tsx and projects/loading.tsx put the page under a Suspense boundary, so a
      // notFound() thrown in a nested layout streams the not-found UI after a 200 status line.
      // Accepted when the not-found UI is what rendered; the status is recorded.
      const ui = (await page.locator("h1.next-error-h1").count()) > 0;
      extra.notFound = { status: docStatus, ui };
      add("not-found (HTTP 404, or streamed not-found UI)", docStatus === 404 || (docStatus === 200 && ui), `status ${docStatus}, not-found UI ${ui}`);
      break;
    }
    case "login":
      add("sent to login", finalPath === `/${LOCALE}/login`, finalPath);
      break;
    case "login-error":
    case "qa-error": {
      const gate = c.expect === "login-error" ? `/${LOCALE}/login` : `/${LOCALE}/raw-data-qa`;
      add("stays on the form", finalPath === gate, finalPath);
      const text = readMessage(c.errorText ?? "login.error", LOCALE);
      add("error message shown", (await page.getByText(text, { exact: true }).count()) > 0, text);
      break;
    }
    case "qa-gate":
      add("sent to QA gate", finalPath === `/${LOCALE}/raw-data-qa`, finalPath);
      add("gate form shown", (await page.locator("#qa-name").count()) > 0);
      break;
  }

  // ready selectors, section markers, GNB rail
  if (c.expect === "ok") {
    for (const sel of screen.ready ?? []) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      add(`ready ${sel}`, visible);
    }
    for (const m of screen.markers ?? []) {
      add(`marker ${m}`, (await page.locator(`[data-hmg-section-done="${m}"]`).count()) > 0);
    }
  }
  // What the body rendered (recorded, not judged): section markers present and the first headings
  // under <main>. Used to pick `ready`/`markers` for a screen and to read a failure without the capture.
  extra.dom = await page
    .evaluate(() => {
      const main = document.querySelector("main");
      return {
        markers: [...document.querySelectorAll("[data-hmg-section-done]")].map((e) => e.getAttribute("data-hmg-section-done") ?? ""),
        headings: main ? [...main.querySelectorAll("h1, h2")].slice(0, 4).map((e) => `${e.tagName.toLowerCase()} ${(e.textContent ?? "").trim().slice(0, 60)}`) : [],
        mainTextLength: main ? (main.textContent ?? "").replace(/\s+/g, " ").trim().length : 0,
      };
    })
    .catch(() => null);
  if (c.rail) {
    const hrefs = await page.locator("[aria-label='Primary'] a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
    const tabs = hrefs.map((h) => new URL(h, "http://x").pathname.replace(new RegExp(`^/${LOCALE}(?=/|$)`), ""));
    add("GNB rail tabs", JSON.stringify(tabs) === JSON.stringify(c.rail), `${JSON.stringify(tabs)} (want ${JSON.stringify(c.rail)})`);
  }

  // error boundary, Next overlay, legacy leaf attribution
  const frontText = cap.slices.front.text();
  const boundary = (await page.getByText(DASH_ERROR, { exact: true }).count()) > 0;
  const overlay = await nextOverlay(page).catch(() => ({ dialog: false, issues: null }));
  const legacyCause = frontText.includes("DATABASE_URL is not set");
  extra.overlay = overlay;
  if (boundary) {
    if (legacyOk) {
      add("legacy leaf failed on its legacy data path only", legacyCause, legacyCause ? "DATABASE_URL is not set" : "boundary without the legacy cause");
      extra.legacyLeaf = "error boundary (legacy data path, later unit)";
    } else add("no error boundary", false, DASH_ERROR);
  } else if (legacyOk) extra.legacyLeaf = "rendered";
  if (overlay.dialog && !legacyLeaf) add("no Next error overlay", false);

  // 2. API calls (app trace)
  const trace = cap.slices.trace.jsonl<TraceEntry>();
  const expected = c.apis ?? screen.apis ?? [];
  for (const k of expected) {
    const want = c.apiStatus?.[k];
    const hits = trace.filter((e) => apiKey(e) === k);
    const ok = hits.some((e) => (want ? e.status === want : is2xx(e.status)));
    add(`api ${k}${want ? ` -> ${want}` : ""}`, ok, hits.length ? hits.map((e) => `${e.status} ${e.ms}ms`).join(", ") : "not called");
  }
  for (const [k, want] of Object.entries(c.apiStatus ?? {})) {
    if (expected.includes(k)) continue;
    add(`api ${k} -> ${want}`, trace.some((e) => apiKey(e) === k && e.status === want));
  }
  const unexpected = trace.filter((e) => {
    if (is2xx(e.status) || c.apiStatus?.[apiKey(e)] === e.status) return false;
    return !trace.some((x) => x.method === e.method && x.path === e.path && x.attempt > e.attempt && is2xx(x.status));
  });
  add("all API calls 2xx (or expected)", unexpected.length === 0, unexpected.map((e) => `${apiKey(e)} ${e.status} ${e.code ?? ""}`).join(", "));
  if (screen.flow === "visit" && c.expect === "ok") {
    const budget = screen.serverCallBudget ?? doc.defaults.serverCallBudget;
    // Judged (serverCallBudget, G-25 and D6): the most backend (/v1) calls in flight at once while
    // the page loads. Spans are the tap's [start, end) per call (what reached the backend, retries
    // included); every /v1 call of the case that started by the time the load settled counts:
    // the layout's auth/me, the QA session gate, the page sections and the backend calls behind
    // the browser's /api requests.
    const loadSpans = cap.slices.tap
      .jsonl<TapEntry>()
      .filter((e) => e.path.startsWith("/v1/"))
      .map(tapSpan)
      .filter((s) => s.start <= loadAt);
    const peak = peakConcurrency(loadSpans);
    extra.backendPeak = peak.max;
    extra.backendPeakApis = peak.at;
    // Recorded, not judged: the server calls made before the browser's first /api request (the
    // first render) and the same calls grouped into waves (a call opens a new wave when it starts
    // after every earlier call ended; start = trace ts - ms). A staged first render (D6:
    // essentials first, the rest after they settle) shows as several waves.
    const cut = cap.log.firstApiRequestAt ?? loadAt;
    const first = trace.filter((e) => Date.parse(e.ts) <= cut).length;
    extra.firstRenderServerCalls = first;
    const spans = trace
      .filter((e) => Date.parse(e.ts) <= cut)
      .map((e) => ({ api: apiKey(e), start: Date.parse(e.ts) - e.ms, end: Date.parse(e.ts) }))
      .sort((a, b) => a.start - b.start);
    const waves: string[][] = [];
    let busyUntil = -Infinity;
    for (const s of spans) {
      if (waves.length === 0 || s.start >= busyUntil) waves.push([]);
      waves[waves.length - 1].push(s.api);
      busyUntil = Math.max(busyUntil, s.end);
    }
    extra.callWaves = waves.map((w) => w.length);
    extra.callWaveApis = waves;
    add(
      `backend calls in flight during page load <= ${budget}`,
      peak.max <= budget,
      `${peak.max} at once (${peak.at.join(", ")}); recorded: ${first} first-render calls, waves ${JSON.stringify(extra.callWaves)}${screen.budgetNote ? ` (${screen.budgetNote})` : ""}`,
    );
  }

  // 4. filters reached the API and were applied
  for (const [k, params] of Object.entries(c.query ?? {})) {
    const hits = trace.filter((e) => apiKey(e) === k);
    const ok = hits.some((e) => Object.entries(params).every(([p, v]) => JSON.stringify(e.query[p] ?? []) === JSON.stringify(v)));
    add(`query ${k} ${JSON.stringify(params)}`, ok, hits.map((e) => JSON.stringify(e.query)).join(" | ") || "not called");
  }
  const notApplied = frontText.split("\n").filter((l) => l.includes("[hgh] filters not applied"));
  add("backend applied every filter (no ignored/dropped)", notApplied.length === 0, notApplied.map((l) => l.slice(l.indexOf("[hgh]"), l.indexOf("[hgh]") + 200)).join(" | "));

  // 3. values on screen = values in the API answer
  if (c.expect === "ok") {
    for (const v of screen.values ?? []) {
      const entry = [...trace].reverse().find((e) => e.route === v.route && e.values && v.jsonPath in e.values);
      const value = entry?.values?.[v.jsonPath];
      if (value === undefined || value === null) {
        add(`value ${v.route} ${v.jsonPath}`, false, "not traced");
        continue;
      }
      if (v.match === "count") {
        const n = await page.locator(v.selector).count();
        add(`value ${v.jsonPath} = count(${v.selector})`, n === Number(value), `screen ${n}, api ${value}`);
      } else {
        const text = norm(await page.locator(v.selector).first().innerText().catch(() => ""));
        const want = norm(String(value)).slice(0, v.prefix ?? 200);
        const ok = v.match === "equals" ? text === want : text.includes(want);
        add(`value ${v.jsonPath} on ${v.selector}`, ok, `api "${want.slice(0, 60)}"`);
      }
    }
  }

  // relay: credentials on the wire (tap) and cookies the browser was given
  const tap = cap.slices.tap.jsonl<TapEntry>().filter((e) => e.path.startsWith("/v1/"));
  const sb = tap.filter((e) => e.cookieNames.some((n) => n.startsWith("sb-")));
  add("no sb-* cookie reached the backend", sb.length === 0, sb.map((e) => `${e.method} ${e.path}`).join(", "));
  const qaCalls = tap.filter((e) => e.path.startsWith("/v1/qa/"));
  const other = tap.filter((e) => !e.path.startsWith("/v1/qa/"));
  if (qaCalls.length) {
    const bad = qaCalls.filter((e) => e.auth !== null || e.cookieNames.some((n) => n !== "raw_data_qa"));
    add("QA calls: no Authorization, Cookie raw_data_qa only", bad.length === 0, bad.map((e) => `${e.method} ${e.path} auth=${e.auth?.scheme ?? "-"} cookies=${e.cookieNames.join("+")}`).join(", ") || `${qaCalls.length} calls`);
  }
  if (other.length) {
    const bad = other.filter((e) => e.auth?.scheme.toLowerCase() !== "bearer" || e.auth.alg !== "ES256" || e.auth.kid !== "e2e-kid" || e.cookieNames.length > 0);
    add("session calls: Bearer ES256 (kid e2e-kid), no cookies", bad.length === 0, bad.map((e) => `${e.method} ${e.path} auth=${JSON.stringify(e.auth)} cookies=${e.cookieNames.join("+")}`).join(", ") || `${other.length} calls`);
  }
  if (screen.relay === "qa") {
    await Promise.all(cap.log.pending);
    const setCookie = cap.log.apiResponses.filter((r) => r.setCookieNames.length > 0);
    const foreign = setCookie.filter((r) => r.setCookieNames.some((n) => n !== "raw_data_qa"));
    add("browser Set-Cookie from /api/qa/*: raw_data_qa only", foreign.length === 0, setCookie.map((r) => `${r.method} ${r.path} ${r.setCookieNames.join("+")}`).join(", ") || "none");
    if ((screen.flow === "qaGate" && c.expect === "ok") || screen.flow === "qaLogout") {
      add("QA session cookie relayed to the browser", setCookie.some((r) => r.path === "/api/qa/session" && r.setCookieNames.includes("raw_data_qa")));
    }
    // D2: the gate login carries the viewer IP with the shared relay secret (header names only).
    const login = tap.filter((e) => e.method === "POST" && e.path === "/v1/qa/sessions");
    if (login.length) {
      const relayed = login.every((e) => e.headerNames.includes("x-hgh-client-ip") && e.headerNames.includes("x-hgh-relay-secret"));
      add("D2: QA login relays viewer IP with the relay secret", relayed, login.map((e) => e.headerNames.filter((h) => h.startsWith("x-hgh")).join("+") || "no x-hgh headers").join(", "));
    }
  }

  // 6. console errors, 2. browser network failures
  await Promise.all(cap.log.pending);
  // Statuses this case expects the browser to see (a "Failed to load resource" console line for
  // them is the browser reporting the expected answer, not an app error).
  const expectedStatus = new Set<number>([
    ...(c.expect === "not-found" ? [404] : []),
    ...(c.expect === "qa-error" ? [401] : []),
  ]);
  const errors = [...cap.log.console.filter((m) => m.type === "error").map((m) => m.text), ...cap.log.pageErrors];
  const allowed: Array<{ id: string; text: string }> = [];
  const denied: string[] = [];
  for (const text of errors) {
    const status = /Failed to load resource: the server responded with a status of (\d{3})/.exec(text);
    if (status && expectedStatus.has(Number(status[1]))) {
      allowed.push({ id: "expected-status", text: text.slice(0, 160) });
      continue;
    }
    const hit = allow.find(
      (a) => new RegExp(a.pattern).test(text) && (!a.screens || a.screens.includes(screen.id)) && (!a.when || (a.when === "legacyLeaf" && legacyOk)),
    );
    if (hit) allowed.push({ id: hit.id, text: text.slice(0, 160) });
    else denied.push(text.slice(0, 1200));
  }
  extra.console = { denied, allowed, warnings: cap.log.console.filter((m) => m.type === "warning").map((m) => m.text.slice(0, 200)) };
  add("console errors 0 (outside allow-console.json)", denied.length === 0, denied.join(" | "));
  const failedReq = cap.log.requestFailed.filter((r) => !/ERR_ABORTED|blockedbyclient/i.test(r.failure));
  add("no failed browser requests", failedReq.length === 0, failedReq.map((r) => `${r.method} ${r.url} ${r.failure}`).join(", "));
  const bad4xx = cap.log.apiResponses.filter((r) => r.status >= 400 && !expectedStatus.has(r.status));
  add("browser /api/* responses < 400 (or expected)", bad4xx.length === 0, bad4xx.map((r) => `${r.method} ${r.path} ${r.status}`).join(", "));

  // server logs of this case
  const backLines = cap.slices.back.lines();
  const back5xx = backLines.filter((l) => / HTTP\/[\d.]+" 5\d\d /.test(l));
  const backTrace = backLines.filter((l) => /Traceback|ERROR/.test(l));
  add("backend: no 5xx, no traceback", back5xx.length === 0 && backTrace.length === 0, [...back5xx, ...backTrace].slice(0, 3).join(" | "));
  const egress = frontText.split("\n").filter((l) => l.includes("[e2e-egress] blocked"));
  add("next: no external fetch", egress.length === 0, egress.slice(0, 3).join(" | "));
  const hghProblems = frontText.split("\n").filter((l) => /\[hgh\].*(Set-Cookie dropped|without a relayable|is not writable|is unreadable)/.test(l));
  add("next: no [hgh] relay or trace problems", hghProblems.length === 0, hghProblems.slice(0, 2).join(" | "));
  // Next marks server errors with "⨯". A screen whose leaf is a later unit's page may see that
  // page fail (legacy data path, or its own no-session throw while the layout redirects): those
  // blocks are attributed by their top stack frame (a page.tsx) or the legacy cause and recorded.
  const blocks = errorBlocks(frontText);
  const leafBlocks = blocks.filter((b) => legacyLeaf && (/DATABASE_URL is not set/.test(b) || /^\s+at \S+ \(app\/.*\/page\.tsx:/m.test(b)));
  const appBlocks = blocks.filter((b) => !leafBlocks.includes(b));
  extra.leafServerErrors = leafBlocks.map((b) => b.split("\n").slice(0, 2).join(" ").slice(0, 200));
  add("next: no server errors (later-unit leaf excepted)", appBlocks.length === 0, appBlocks.map((b) => b.split("\n").slice(0, 2).join(" ").slice(0, 200)).join(" | "));
}

/** Next dev error blocks: a "⨯" line plus the stack lines under it. */
function errorBlocks(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes("⨯")) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && j <= i + 12 && !lines[j].includes("⨯") && !/^ (GET|POST|PUT|PATCH|DELETE) \//.test(lines[j]); j += 1) block.push(lines[j]);
    out.push(block.join("\n"));
  }
  return out;
}
