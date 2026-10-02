/**
 * GA4 connectivity probe — PoC, NOT wired into the app.
 *
 * Verifies that we can reach the Google Analytics 4 Data API for a single
 * property (e.g. the kia.com/it/it PoC) using an OAuth user account such as
 * geo-ops@example.com. Prints an overview + top hostnames so we can confirm
 * the domain's numbers before investing in the full BFF integration.
 *
 *   npm run ga4:probe                 # last 28 days, GA4_PROPERTY_ID from .env.local
 *   npm run ga4:probe -- --days 7     # last 7 days
 *   npm run ga4:probe -- --property 123456789
 *
 * Requires in .env.local (server-only, never NEXT_PUBLIC_):
 *   GA4_OAUTH_CLIENT_ID      OAuth 2.0 "Desktop app" client id
 *   GA4_OAUTH_CLIENT_SECRET  …and its secret
 *   GA4_PROPERTY_ID          numeric GA4 property id for the domain (not the G-XXXX tag)
 *
 * First run opens a browser for consent (log in as the GA4 account). The refresh
 * token is cached in .ga4-token.json (gitignored) so later runs are non-interactive.
 */
import http from "node:http";
import fs from "node:fs";
import { exec } from "node:child_process";
import { OAuth2Client } from "google-auth-library";

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "openid",
  "email",
];
const TOKEN_PATH = ".ga4-token.json";
const PORT = Number(process.env.GA4_OAUTH_PORT ?? 53682);
const REDIRECT_URI = `http://localhost:${PORT}`;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} — set it in .env.local`);
  return v;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start \"\""
        : "xdg-open";
  exec(`${cmd} "${url}"`, () => {
    /* best-effort; the URL is also printed for manual opening */
  });
}

function persistTokens(incoming: Record<string, unknown>) {
  const existing = fs.existsSync(TOKEN_PATH)
    ? JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"))
    : {};
  const merged = { ...existing, ...incoming };
  // Google omits refresh_token on refresh responses — keep the one we have.
  if (!merged.refresh_token && existing.refresh_token) {
    merged.refresh_token = existing.refresh_token;
  }
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
}

function waitForCode(authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error) {
        res.end(`Auth error: ${error}. You can close this tab.`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.end("Waiting for the OAuth redirect…");
        return;
      }
      res.end("✅ GA4 authorized. Close this tab and return to the terminal.");
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(PORT, () => {
      console.log(
        `\nAuthorize access (log in as the GA4 account, e.g. geo-ops@example.com):\n\n${authUrl}\n`,
      );
      openBrowser(authUrl);
    });
  });
}

async function authorize(): Promise<OAuth2Client> {
  const oauth = new OAuth2Client({
    clientId: requireEnv("GA4_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("GA4_OAUTH_CLIENT_SECRET"),
    redirectUri: REDIRECT_URI,
  });
  oauth.on("tokens", (t) => persistTokens(t as Record<string, unknown>));

  if (fs.existsSync(TOKEN_PATH)) {
    oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
    try {
      await oauth.getAccessToken(); // refreshes if expired
      return oauth;
    } catch {
      console.warn("Cached token unusable — re-authenticating…");
    }
  }

  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  const { tokens } = await oauth.getToken(await waitForCode(authUrl));
  oauth.setCredentials(tokens);
  persistTokens(tokens as Record<string, unknown>);
  return oauth;
}

type RunReportBody = Record<string, unknown>;
type GaRow = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] };
type GaReport = { rows?: GaRow[]; metricHeaders?: { name: string }[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function runReport(
  token: string,
  propertyId: string,
  body: RunReportBody,
): Promise<GaReport> {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  const maxAttempts = 6;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json() as Promise<GaReport>;

    const detail = await res.text();
    if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
      const waitMs = Math.min(30_000, 2000 * 2 ** (attempt - 1)); // 2,4,8,16,30s
      console.warn(
        `GA4 returned ${res.status} (transient) — retry ${attempt}/${maxAttempts - 1} in ${waitMs / 1000}s…`,
      );
      await sleep(waitMs);
      continue;
    }
    throw new Error(`GA4 runReport failed (${res.status}):\n${detail}`);
  }
}

/** Best-effort: which Google account does this token belong to? */
async function whoAmI(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const info = (await res.json()) as { email?: string };
    return info.email ?? null;
  } catch {
    return null;
  }
}

type AccountSummaries = {
  accountSummaries?: {
    displayName?: string;
    account?: string;
    propertySummaries?: { property?: string; displayName?: string }[];
  }[];
};

/** Every GA4 property the logged-in account can actually read. */
async function listAccountSummaries(token: string): Promise<AccountSummaries> {
  const res = await fetch(
    "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`accountSummaries failed (${res.status}):\n${await res.text()}`);
  }
  return res.json() as Promise<AccountSummaries>;
}

function table(headers: string[], rows: (string | number)[][]) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const line = (cells: (string | number)[]) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  rows.forEach((r) => console.log(line(r)));
}

const fmtDate = (d: string) =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
const num = (s: string | number | undefined) =>
  Number(s ?? 0).toLocaleString("en-US");

// ── Traffic-source / year-over-year analysis (--sources) ─────────────────────

// sessionSource values GA4 records for referrals from AI chat interfaces.
// PARTIAL_REGEXP, case-insensitive. Extend as new assistants appear.
const AI_SOURCE_REGEX =
  "openai|chatgpt|perplexity|gemini|copilot|claude|bard|poe\\.com|you\\.com|deepseek|grok|mistral|phind|andisearch";

/** "2026-05-22" → "2025-05-22" (same month/day, prior year). */
function priorYear(date: string): string {
  const [y, m, d] = date.split("-");
  return `${Number(y) - 1}-${m}-${d}`;
}

type Metrics = { sessions: number; users: number; conversions: number };

/**
 * Build a runReport body. Property 469542848 (KIA-EU_ITA_NATIONAL_KIA.COM/IT) is
 * already Italy-scoped — ~97% of sessions land under /it — so NO landing-page
 * filter is applied (and a landingPage/pagePath filter actually 502s this large
 * property, especially for prior-year data). The only filter used is the
 * AI-source regex for the AI breakdown, which is reliable.
 */
function sourceBody(opts: {
  start: string;
  end: string;
  dimension: string;
  aiOnly?: boolean;
  limit?: number;
}): RunReportBody {
  // No orderBys: server-side sort on this large property triggers gateway 502s,
  // especially for prior-year ranges. We sort in code (yoyTable) instead.
  const body: RunReportBody = {
    dateRanges: [{ startDate: opts.start, endDate: opts.end }],
    dimensions: [{ name: opts.dimension }],
    metrics: [
      { name: "sessions" },
      { name: "totalUsers" },
      { name: "conversions" },
    ],
    limit: opts.limit ?? 50,
  };
  if (opts.aiOnly) {
    body.dimensionFilter = {
      filter: {
        fieldName: "sessionSource",
        stringFilter: {
          matchType: "PARTIAL_REGEXP",
          value: AI_SOURCE_REGEX,
          caseSensitive: false,
        },
      },
    };
  }
  return body;
}

function toMetricMap(report: GaReport): Map<string, Metrics> {
  const m = new Map<string, Metrics>();
  for (const r of report.rows ?? []) {
    m.set(r.dimensionValues?.[0].value ?? "(not set)", {
      sessions: Number(r.metricValues?.[0].value ?? 0),
      users: Number(r.metricValues?.[1].value ?? 0),
      conversions: Number(r.metricValues?.[2].value ?? 0),
    });
  }
  return m;
}

function yoy(cur: number, prev: number): string {
  if (prev === 0) return cur > 0 ? "new" : "—";
  const pct = ((cur - prev) / prev) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

/** Print a YoY table sorted by current-year sessions. */
function yoyTable(
  title: string,
  cur: Map<string, Metrics>,
  prev: Map<string, Metrics>,
  maxRows = 30,
) {
  const keys = [...new Set([...cur.keys(), ...prev.keys()])].sort(
    (a, b) => (cur.get(b)?.sessions ?? 0) - (cur.get(a)?.sessions ?? 0),
  );
  const shown = keys.slice(0, maxRows);
  const sum = (map: Map<string, Metrics>, f: (m: Metrics) => number) =>
    [...map.values()].reduce((t, v) => t + f(v), 0);

  const rows = shown.map((k) => {
    const c = cur.get(k) ?? { sessions: 0, users: 0, conversions: 0 };
    const p = prev.get(k) ?? { sessions: 0, users: 0, conversions: 0 };
    return [
      k || "(not set)",
      num(c.sessions),
      num(p.sessions),
      yoy(c.sessions, p.sessions),
      num(c.conversions),
      num(p.conversions),
      yoy(c.conversions, p.conversions),
    ];
  });
  // TOTAL row across ALL keys (not just shown), so it reflects the real total.
  const cS = sum(cur, (m) => m.sessions);
  const pS = sum(prev, (m) => m.sessions);
  const cC = sum(cur, (m) => m.conversions);
  const pC = sum(prev, (m) => m.conversions);
  rows.push([
    "TOTAL",
    num(cS),
    num(pS),
    yoy(cS, pS),
    num(cC),
    num(pC),
    yoy(cC, pC),
  ]);

  console.log(`\n── ${title} ──`);
  if (keys.length > maxRows) {
    console.log(`(top ${maxRows} of ${keys.length} by sessions; TOTAL is all rows)`);
  }
  table(
    ["source", "sess '26", "sess '25", "Δ sess", "conv '26", "conv '25", "Δ conv"],
    rows,
  );
}

async function runSources(token: string, propertyId: string) {
  const start = argValue("--start") ?? "2026-05-22";
  const end = argValue("--end") ?? "2026-06-10";
  const pStart = priorYear(start);
  const pEnd = priorYear(end);

  console.log(
    `\nKia Italy traffic sources — property ${propertyId} (KIA-EU_ITA_NATIONAL, already /it-scoped)`,
  );
  console.log(`Current: ${start} → ${end}`);
  console.log(`Prior:   ${pStart} → ${pEnd}`);

  const dims: { title: string; dimension: string; aiOnly?: boolean; max?: number }[] =
    [
      { title: "By channel group", dimension: "sessionDefaultChannelGroup" },
      { title: "By source (top 20)", dimension: "sessionSource", max: 20 },
      { title: "AI chatbot referrals (by source)", dimension: "sessionSource", aiOnly: true },
    ];

  // Sequential (current, then prior) — concurrent pairs raise the 502 rate on
  // this property. sessionSourceMedium is avoided: its high cardinality 502s the
  // prior-year query. sessionSource carries the same "유입 소스" signal reliably.
  for (const d of dims) {
    const curRep = await runReport(token, propertyId, sourceBody({ start, end, dimension: d.dimension, aiOnly: d.aiOnly }));
    const prevRep = await runReport(token, propertyId, sourceBody({ start: pStart, end: pEnd, dimension: d.dimension, aiOnly: d.aiOnly }));
    const cur = toMetricMap(curRep);
    const prev = toMetricMap(prevRep);
    if (d.aiOnly && cur.size === 0 && prev.size === 0) {
      console.log(`\n── ${d.title} ──\n(no AI-referred sessions matched ${AI_SOURCE_REGEX.split("|").slice(0, 4).join("/")}…)`);
      continue;
    }
    yoyTable(d.title, cur, prev, d.max ?? 30);
  }
}

// ── Filter-schema dimension probe (--dimensions) ─────────────────────────────
//
// For designing the conversion/AI-funnel filter schema empirically: enumerate
// the value distribution of each CANDIDATE filter dimension *within the AI
// Assistant cohort*, alongside activeUsers + keyEvents. A dimension is only a
// useful filter axis if it has >1 value with non-trivial AI-cohort volume.
//
// 502-safe: no orderBys (sort in code), no landingPage filter combos, single
// dimension per call, sequential. Each call filtered to the AI channel only.

const AI_CHANNEL = "AI Assistant";

interface DimRow {
  value: string;
  users: number;
  keyEvents: number;
}

async function aiDimReport(
  token: string,
  propertyId: string,
  range: { start: string; end: string },
  dimension: string,
  limit = 50,
): Promise<DimRow[]> {
  const rep = await runReport(token, propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: [{ name: dimension }],
    metrics: [{ name: "activeUsers" }, { name: "keyEvents" }],
    dimensionFilter: {
      filter: {
        fieldName: "sessionDefaultChannelGroup",
        stringFilter: { matchType: "EXACT", value: AI_CHANNEL, caseSensitive: false },
      },
    },
    limit,
  });
  return (rep.rows ?? [])
    .map((r) => ({
      value: r.dimensionValues?.[0].value ?? "(not set)",
      users: Number(r.metricValues?.[0].value ?? 0),
      keyEvents: Number(r.metricValues?.[1].value ?? 0),
    }))
    .sort((a, b) => b.users - a.users);
}

async function runDimensions(token: string, propertyId: string) {
  const days = Number(argValue("--days") ?? 28);
  const range = { start: `${days}daysAgo`, end: "today" };
  console.log(
    `\nConversion filter-schema probe — property ${propertyId} · AI Assistant cohort · last ${days} days`,
  );
  console.log(
    "각 차원: AI cohort 안에서의 값 분포 (activeUsers / keyEvents). 값이 1개거나",
  );
  console.log("볼륨 0이면 필터 축으로 무의미.\n");

  // Candidate filter axes for GA4 conversion data. Ordered by expected value.
  const candidates: { title: string; dimension: string; limit?: number }[] = [
    { title: "AI 엔진 (sessionSource)", dimension: "sessionSource", limit: 30 },
    { title: "전환 종류 (eventName, key events 포함)", dimension: "eventName", limit: 40 },
    { title: "디바이스 (deviceCategory)", dimension: "deviceCategory" },
    { title: "신규/재방문 (newVsReturning)", dimension: "newVsReturning" },
    { title: "국가 (country)", dimension: "country", limit: 30 },
    { title: "지역 (region)", dimension: "region", limit: 30 },
    { title: "랜딩페이지 (landingPagePlusQueryString)", dimension: "landingPagePlusQueryString", limit: 25 },
  ];

  for (const c of candidates) {
    try {
      const rows = await aiDimReport(token, propertyId, range, c.dimension, c.limit);
      console.log(`\n── ${c.title} ── (${rows.length} distinct values)`);
      if (rows.length === 0) {
        console.log("(no AI-cohort rows)");
        continue;
      }
      table(
        ["value", "aiUsers", "keyEvents"],
        rows.map((r) => [r.value || "(not set)", num(r.users), num(r.keyEvents)]),
      );
    } catch (err) {
      console.log(`\n── ${c.title} ── ✗ ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
}

// ── Filter end-to-end verification (--verify-filters) ────────────────────────
//
// Proves the conversion filters actually narrow GA4 results. This REPLICATES the
// exact dimensionFilter builders in lib/ga4/conversion.ts (aiFilter / base /
// toFilter) so a green run here means the runtime filter JSON is GA4-valid AND
// partitions correctly. If conversion.ts changes its filter shape, mirror it
// here. Verification = each axis's values should sum back to the unfiltered
// baseline (a partition), which only holds if the filter is honored server-side.

const ENGINE_SOURCE: Record<string, string> = {
  chatgpt: "chatgpt.com",
  gemini: "gemini.google.com",
  copilot: "copilot.com",
  perplexity: "perplexity.ai",
  claude: "claude.ai",
};
const AI_CHANNEL_EXPR = {
  filter: {
    fieldName: "sessionDefaultChannelGroup",
    stringFilter: { matchType: "EXACT", value: AI_CHANNEL, caseSensitive: false },
  },
};
const inListExpr = (fieldName: string, values: string[]) => ({
  filter: { fieldName, inListFilter: { values, caseSensitive: false } },
});
type VFilters = { engine?: string[]; device?: string[]; visitorType?: string[] };
function baseExpressions(f?: VFilters): object[] {
  const e: object[] = [];
  if (f?.device?.length) e.push(inListExpr("deviceCategory", f.device));
  if (f?.visitorType?.length) e.push(inListExpr("newVsReturning", f.visitorType));
  return e;
}
function toFilter(exprs: object[]): object | undefined {
  if (exprs.length === 0) return undefined;
  if (exprs.length === 1) return exprs[0];
  return { andGroup: { expressions: exprs } };
}
function aiFilter(f?: VFilters): object {
  const exprs: object[] = [AI_CHANNEL_EXPR];
  const sources = (f?.engine ?? []).map((e) => ENGINE_SOURCE[e]).filter(Boolean);
  if (sources.length) exprs.push(inListExpr("sessionSource", sources));
  exprs.push(...baseExpressions(f));
  return toFilter(exprs)!;
}

async function aiCohort(
  token: string,
  propertyId: string,
  range: { start: string; end: string },
  f?: VFilters,
): Promise<{ users: number; keyEvents: number }> {
  const rep = await runReport(token, propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    metrics: [{ name: "activeUsers" }, { name: "keyEvents" }],
    dimensionFilter: aiFilter(f),
  });
  const r = rep.rows?.[0];
  return {
    users: Number(r?.metricValues?.[0].value ?? 0),
    keyEvents: Number(r?.metricValues?.[1].value ?? 0),
  };
}

async function runVerifyFilters(token: string, propertyId: string) {
  const days = Number(argValue("--days") ?? 90);
  const range = { start: `${days}daysAgo`, end: "today" };
  console.log(
    `\n필터 검수 — property ${propertyId} · AI Assistant cohort · last ${days} days`,
  );
  console.log("각 축의 값별 결과가 무필터 baseline으로 합산되면(파티션) 필터가 서버에서 적용된 것.\n");

  const base = await aiCohort(token, propertyId, range);
  console.log(`baseline (무필터): users=${base.users}  keyEvents=${base.keyEvents}\n`);

  const scenarios: { label: string; f: VFilters }[] = [
    { label: "engine=chatgpt", f: { engine: ["chatgpt"] } },
    { label: "engine=gemini", f: { engine: ["gemini"] } },
    { label: "engine=copilot", f: { engine: ["copilot"] } },
    { label: "engine=perplexity", f: { engine: ["perplexity"] } },
    { label: "device=mobile", f: { device: ["mobile"] } },
    { label: "device=desktop", f: { device: ["desktop"] } },
    { label: "device=tablet", f: { device: ["tablet"] } },
    { label: "visitor=new", f: { visitorType: ["new"] } },
    { label: "visitor=returning", f: { visitorType: ["returning"] } },
    { label: "device=mobile ∧ engine=chatgpt (andGroup)", f: { device: ["mobile"], engine: ["chatgpt"] } },
  ];
  const got: Record<string, { users: number; keyEvents: number }> = {};
  const rows: (string | number)[][] = [];
  for (const s of scenarios) {
    const r = await aiCohort(token, propertyId, range, s.f);
    got[s.label] = r;
    const pct = base.users > 0 ? `${((r.users / base.users) * 100).toFixed(0)}%` : "—";
    rows.push([s.label, r.users, r.keyEvents, pct]);
  }
  table(["scenario", "users", "keyEvents", "% of base"], rows);

  // Partition checks — sum of an axis's values must equal the baseline if the
  // filter is honored (overlap impossible within a single GA4 dimension).
  const sum = (labels: string[], key: "users") =>
    labels.reduce((t, l) => t + (got[l]?.[key] ?? 0), 0);
  const check = (name: string, got: number, want: number) => {
    const ok = got === want;
    console.log(`  ${ok ? "✓" : "✗"} ${name}: Σ=${got} vs baseline=${want}${ok ? "" : "  ← MISMATCH"}`);
  };
  console.log("\n파티션 검증 (users):");
  check(
    "engine 4종 합",
    sum(["engine=chatgpt", "engine=gemini", "engine=copilot", "engine=perplexity"], "users"),
    base.users,
  );
  check("device 3종 합", sum(["device=mobile", "device=desktop", "device=tablet"], "users"), base.users);
  check("visitor 2종 합", sum(["visitor=new", "visitor=returning"], "users"), base.users);
  // andGroup sanity: mobile∧chatgpt ≤ min(mobile, chatgpt)
  const comb = got["device=mobile ∧ engine=chatgpt (andGroup)"].users;
  const mob = got["device=mobile"].users;
  const cg = got["engine=chatgpt"].users;
  const okAnd = comb <= Math.min(mob, cg);
  console.log(
    `  ${okAnd ? "✓" : "✗"} andGroup: mobile∧chatgpt=${comb} ≤ min(mobile=${mob}, chatgpt=${cg})`,
  );
  console.log(
    "\n주의: engine은 AI cohort 내 sessionSource 합이 baseline과 같으려면 모든 AI 세션이 4개 소스 중 하나여야 함 — 다른 소스가 있으면 ≤ 가 정상.",
  );
}

// ── Site-visits sub-KPI feasibility (--visits) ───────────────────────────────
//
// Validates the "AI 유입 사이트 방문 수" sub-KPI: AI Assistant cohort totals in
// BOTH units (sessions vs activeUsers — they differ, so the unit must be chosen)
// plus a per-landing-page breakdown to confirm the page Dimension is trackable.

async function runVisits(token: string, propertyId: string) {
  const days = Number(argValue("--days") ?? 90);
  const range = { start: `${days}daysAgo`, end: "today" };
  const aiOnly = {
    filter: {
      fieldName: "sessionDefaultChannelGroup",
      stringFilter: { matchType: "EXACT", value: AI_CHANNEL, caseSensitive: false },
    },
  };
  console.log(`\nAI 유입 사이트 방문 수 검증 — property ${propertyId} · last ${days} days\n`);

  // Totals in both candidate units.
  const totals = await runReport(token, propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }],
    dimensionFilter: aiOnly,
  });
  const tr = totals.rows?.[0];
  const sessions = Number(tr?.metricValues?.[0].value ?? 0);
  const users = Number(tr?.metricValues?.[1].value ?? 0);
  const views = Number(tr?.metricValues?.[2].value ?? 0);
  console.log("AI cohort 합계 (단위 비교):");
  table(
    ["sessions (Visits/회)", "activeUsers (사용자)", "screenPageViews", "sessions/user"],
    [[num(sessions), num(users), num(views), users ? (sessions / users).toFixed(2) : "—"]],
  );

  // Per-landing-page (입구 페이지) — confirms the page Dimension is trackable.
  const byPage = await runReport(token, propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [{ name: "sessions" }, { name: "activeUsers" }],
    dimensionFilter: aiOnly,
    limit: 30,
  });
  const pageRows = (byPage.rows ?? [])
    .map((r) => ({
      url: r.dimensionValues?.[0].value ?? "(not set)",
      sessions: Number(r.metricValues?.[0].value ?? 0),
      users: Number(r.metricValues?.[1].value ?? 0),
    }))
    .sort((a, b) => b.sessions - a.sessions);
  console.log(`\n페이지별(landingPage) AI 유입 — ${pageRows.length} pages`);
  table(
    ["landingPage", "sessions", "users"],
    pageRows.slice(0, 15).map((r) => [r.url || "(not set)", num(r.sessions), num(r.users)]),
  );
  console.log(
    "\n→ 단위 확정 필요: Visits(회)=sessions vs 사용자=activeUsers (위 sessions/user 배율만큼 차이).",
  );
}

async function main() {
  const oauth = await authorize();
  const token = (await oauth.getAccessToken()).token;
  if (!token) throw new Error("Failed to obtain an access token");

  const email = await whoAmI(token);
  console.log(`\nLogged in as: ${email ?? "(unknown — re-auth to capture email)"}`);

  // Diagnostic: list every property this account can read, then exit.
  if (argFlag("--list")) {
    const { accountSummaries = [] } = await listAccountSummaries(token);
    if (!accountSummaries.length) {
      console.log(
        "\nNo GA4 accounts visible to this login. Likely the wrong account, " +
          "or it has no GA4 access. Delete .ga4-token.json and re-run to switch account.",
      );
      return;
    }
    console.log("\nGA4 properties this account can read:\n");
    for (const acc of accountSummaries) {
      console.log(`▸ ${acc.displayName} (${acc.account})`);
      for (const p of acc.propertySummaries ?? []) {
        const id = (p.property ?? "").replace(/^properties\//, "");
        console.log(`    ${id}  ${p.displayName}`);
      }
    }
    console.log("\nUse one of the numeric ids above as GA4_PROPERTY_ID.");
    return;
  }

  const days = Number(argValue("--days") ?? 28);
  const propertyId = (argValue("--property") ?? process.env.GA4_PROPERTY_ID ?? "")
    .toString()
    .replace(/^properties\//, "")
    .trim();
  if (!propertyId) {
    throw new Error(
      "No GA4 property id — set GA4_PROPERTY_ID in .env.local or pass --property <numericId>. " +
        "Run with --list to see ids this account can read.",
    );
  }

  // Traffic-source year-over-year breakdown (the GEO/acquisition goal).
  if (argFlag("--sources")) {
    await runSources(token, propertyId);
    console.log("\n✅ Done.");
    return;
  }

  // Filter-schema dimension distribution (AI cohort) — designs the conversion
  // filter axes from real data.
  if (argFlag("--dimensions")) {
    await runDimensions(token, propertyId);
    console.log("\n✅ Done.");
    return;
  }

  // End-to-end filter verification — proves the runtime filter JSON narrows GA4.
  if (argFlag("--verify-filters")) {
    await runVerifyFilters(token, propertyId);
    console.log("\n✅ Done.");
    return;
  }

  // Site-visits sub-KPI feasibility (sessions vs users + per-page).
  if (argFlag("--visits")) {
    await runVisits(token, propertyId);
    console.log("\n✅ Done.");
    return;
  }

  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "today" }];
  console.log(`\nGA4 property ${propertyId} · last ${days} days\n`);

  // Overview by day
  const overview = await runReport(token, propertyId, {
    dateRanges,
    dimensions: [{ name: "date" }],
    metrics: [
      { name: "sessions" },
      { name: "totalUsers" },
      { name: "screenPageViews" },
      { name: "conversions" },
    ],
    orderBys: [{ dimension: { dimensionName: "date" } }],
  });
  const ovRows = (overview.rows ?? []).map((r) => [
    fmtDate(r.dimensionValues?.[0].value ?? ""),
    num(r.metricValues?.[0].value),
    num(r.metricValues?.[1].value),
    num(r.metricValues?.[2].value),
    num(r.metricValues?.[3].value),
  ]);
  if (ovRows.length) {
    console.log("── Daily overview ──");
    table(["date", "sessions", "users", "pageViews", "conversions"], ovRows);
  } else {
    console.log("── Daily overview ── (no rows returned for this range)");
  }

  // Top hostnames — confirms which domain(s) the property actually measures
  const hosts = await runReport(token, propertyId, {
    dateRanges,
    dimensions: [{ name: "hostName" }],
    metrics: [{ name: "sessions" }, { name: "totalUsers" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 10,
  });
  const hostRows = (hosts.rows ?? []).map((r) => [
    r.dimensionValues?.[0].value ?? "",
    num(r.metricValues?.[0].value),
    num(r.metricValues?.[1].value),
  ]);
  console.log("\n── Top hostnames ──");
  if (hostRows.length) {
    table(["hostName", "sessions", "users"], hostRows);
  } else {
    console.log("(no rows)");
  }

  console.log("\n✅ GA4 connection OK.");
}

main().catch((err) => {
  console.error("\n✗ GA4 probe failed:\n", err instanceof Error ? err.message : err);
  process.exit(1);
});
