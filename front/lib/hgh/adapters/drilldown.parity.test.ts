import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { MentionsPromptLive } from "@/lib/scope/result-adapter";
import { isNonCompetitorMention } from "@/lib/scope/non-competitor-brands";

// Legacy <-> API parity of the mention drilldown lists (unit U6, verification D4; C-G11 / U6-N12).
//
// Method (answers.parity.test.ts pattern). One WORLD (catalog prompts, answers over engines and
// countries, mention rows with a product rolled up to its brand, own-brand sentiment signals) is
// written twice:
//   legacy: mirror rows on PGlite (real PostgreSQL), read by the UNCHANGED legacy readers the
//           routes end in: aggregateMentionsFromMirror(filters, undefined, {onlyBrand}) (the
//           brand drilldown, fetchStandardBrandMentionPrompts) and aggregateSignalPromptsFromMirror
//           (the signal list, fetchStandardSignalPrompts), with the route's filters (cumulative);
//   api:    a backend model of GET /v1/mentions/prompts built from the same WORLD with the
//           documented M-3 semantics (back/app/features/analytics/mentions/prompts/queries.py:
//           rd.answer_brand = answer x display brand, a product folded into its rollup brand,
//           count = sum of the competitive rows' mention_count per prompt, share = count / total,
//           the cell representative per (prompt, engine, country) with runs = answers in the cell;
//           signal = own rows with the signal column > 0), served through fetch to the adapter's
//           loaders (loadBrandMentionPrompts, loadSignalPrompts).
// Rows are compared per prompt id (the drilldown table sorts on the client); every differing path
// must be declared in KNOWN_DIFF with its reason, and every declared difference must still occur.
// The brand lists are read in one request of 2,000 (B010) and the signal list with lite=true (B014):
// the model serves exactly what the backend sends for those requests, so the parity covers them.
//
// Citation sources tab (B007): legacy aggregateBrandCitationsFrom (the pure rollup behind
// fetchBrandCitations / aggregateBrandCitationsFromMirror) vs a model of C-1 ?mention_brand= whose
// rows carry skey = the group key (the backend dim_source ports the same OFFICIAL_SOCIAL_ACCOUNTS
// rule: an official social account is host+path) and domain = the display host. An official account
// row and the plain row of the same host must keep the legacy names and count.

const st = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => st.db }));
// Run visibility (hidden bulk-mirror runs) is outside the list semantics compared here.
vi.mock("@/lib/db/repositories/scope-mirror-progress-read", async () => {
  const { sql } = await import("drizzle-orm");
  return { bulkMirrorRunVisibleSql: async () => sql`true`, bulkMirrorRunVisibleSqlKnown: () => sql`true` };
});

const { setAnchorAxisForTests, resetAnchorAxisForTests } = await import("@/lib/period/anchor-axis-state");
const { setTrendGridForTests, resetTrendGridForTests } = await import("@/lib/period/trend-grid-flag");
const { SYNC_PROBED_COLUMNS, setColumnAvailabilityForTests, resetColumnAvailabilityForTests } = await import(
  "@/lib/db/column-availability"
);
const { aggregateMentionsFromMirror, aggregateSignalPromptsFromMirror } = await import("@/lib/db/repositories/scope-aggregates");
const { aggregateBrandCitationsFrom } = await import("@/lib/scope/result-adapter");
const { citationGroupKey } = await import("@/lib/citation-categorizer/official-social");
const { STANDARD_ROOT_PROJECT_ID } = await import("@/lib/db/repositories/standards");
const { HMG_BRAND_ENTITY_IDS } = await import("@/lib/scope/hmg-brands");
const { bindHghAuth } = await import("../auth");
const D = await import("./drilldown");

type S = components["schemas"];
type Pg = { exec(q: string): Promise<unknown>; close(): Promise<void> };

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ROOT = u(0x1); // SCOPE_ROOT_PROJECT_ID (the mirror runs' project)
const RUN = u(0x2);
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";

// ── WORLD ───────────────────────────────────────────────────────────────────

const HYUNDAI = HMG_BRAND_ENTITY_IDS.Hyundai;
const TOYOTA = u(0x41);
const BMW = u(0x42);
const GOLF = u(0x43); // a bare-only non-competitor name ("golf"): only its named products count
const BZ4X = u(0x51); // Toyota product
const IONIQ = u(0x52); // Hyundai product
const GOLF_GTI = u(0x53); // Golf product (extends the bare name: competitive)

interface Prompt {
  id: string;
  key: number;
  text: string;
  funnel: string;
}
const PROMPTS: Prompt[] = [
  { id: u(0x30), key: 30, text: "best EV", funnel: "인지" },
  { id: u(0x31), key: 31, text: "best SUV", funnel: "고려" },
  { id: u(0x32), key: 32, text: "family car", funnel: "구매" },
];
interface Answer {
  job: string;
  prompt: string;
  engine: string;
  region: string;
  hoursAgo: number;
}
const ANSWERS: Answer[] = [
  { job: u(0x10), prompt: u(0x30), engine: "chatgpt", region: "US", hoursAgo: 30 },
  { job: u(0x11), prompt: u(0x30), engine: "gemini", region: "US", hoursAgo: 29 },
  { job: u(0x12), prompt: u(0x30), engine: "chatgpt", region: "KR", hoursAgo: 28 },
  { job: u(0x13), prompt: u(0x31), engine: "chatgpt", region: "US", hoursAgo: 27 },
  { job: u(0x14), prompt: u(0x31), engine: "gemini", region: "US", hoursAgo: 26 },
  { job: u(0x15), prompt: u(0x32), engine: "chatgpt", region: "US", hoursAgo: 25 },
];
interface Mention {
  job: string;
  entity: string;
  name: string;
  type: "Brand" | "Product";
  count: number;
  rollup: string;
  position: number;
  positive: number;
}
const M = (job: string, entity: string, name: string, type: Mention["type"], count: number, rollup: string, position: number, positive = 0): Mention => ({
  job,
  entity,
  name,
  type,
  count,
  rollup,
  position,
  positive,
});
const MENTIONS: Mention[] = [
  M(u(0x10), TOYOTA, "Toyota", "Brand", 2, TOYOTA, 1),
  M(u(0x10), BZ4X, "bZ4X", "Product", 1, TOYOTA, 2),
  M(u(0x10), HYUNDAI, "Hyundai", "Brand", 3, HYUNDAI, 2, 2),
  M(u(0x11), TOYOTA, "Toyota", "Brand", 4, TOYOTA, 1),
  M(u(0x11), HYUNDAI, "Hyundai", "Brand", 1, HYUNDAI, 3, 1),
  M(u(0x12), BZ4X, "bZ4X", "Product", 2, TOYOTA, 1), // Toyota only through its product
  M(u(0x13), TOYOTA, "Toyota", "Brand", 1, TOYOTA, 3), // 2nd brand of the answer at avg position 3
  M(u(0x13), IONIQ, "Ioniq 5", "Product", 2, HYUNDAI, 1, 2),
  M(u(0x14), BMW, "BMW", "Brand", 5, BMW, 1),
  M(u(0x14), HYUNDAI, "Hyundai", "Brand", 2, HYUNDAI, 2, 3),
  M(u(0x15), HYUNDAI, "Hyundai", "Brand", 1, HYUNDAI, 1),
  M(u(0x15), GOLF, "Golf", "Brand", 2, GOLF, 2), // bare "golf": non-competitive row
  M(u(0x15), GOLF_GTI, "Golf GTI", "Product", 1, GOLF, 3), // competitive row of Golf
];
const BRAND_NAME = new Map(MENTIONS.filter((m) => m.type === "Brand").map((m) => [m.entity, m.name]));
const OWN = new Set([HYUNDAI]);

const NOW = Date.now();
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const lit = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);

const DDL = `
SET TIME ZONE 'UTC';
CREATE TABLE scope_runs (run_id uuid PRIMARY KEY, status text, started_at timestamptz, completed_at timestamptz, total_jobs int,
  synced_at timestamptz DEFAULT now(), project_id uuid, cycle_anchor_at timestamptz);
CREATE TABLE scope_answers (job_id uuid PRIMARY KEY, run_id uuid, prompt_id uuid, target text, region text, status text,
  measured_at timestamptz, model_slug text, answer_text text);
CREATE TABLE scope_mentions (job_id uuid, entity_id uuid, brand text, entity_type text, mention_count int,
  sentiment_positive int DEFAULT 0, sentiment_neutral int DEFAULT 0, sentiment_negative int DEFAULT 0, sentiment_mixed int DEFAULT 0,
  avg_position real, surfaces text[], brand_rollup_entity_id uuid, type_mention int DEFAULT 0, type_recommendation int DEFAULT 0,
  type_comparison int DEFAULT 0, type_definition int DEFAULT 0, type_final_choice int DEFAULT 0);
CREATE TABLE scope_prompts (prompt_id uuid PRIMARY KEY, text text, funnel_stage text);
CREATE TABLE prompts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, scope_prompt_id uuid, brand text, list_type text,
  depth1 text, depth2 text, depth3 text, funnel_stage text, brand_presence text);
`;
function inserts(): string {
  const rows = [`INSERT INTO scope_runs (run_id, status, started_at, project_id) VALUES (${lit(RUN)}, 'completed', ${lit(at(31))}, ${lit(ROOT)});`];
  for (const p of PROMPTS) {
    rows.push(`INSERT INTO scope_prompts VALUES (${lit(p.id)}, ${lit(p.text)}, NULL);`);
    rows.push(`INSERT INTO prompts (project_id, scope_prompt_id, brand, funnel_stage) VALUES (${lit(STANDARD_ROOT_PROJECT_ID)}, ${lit(p.id)}, 'Hyundai', ${lit(p.funnel)});`);
  }
  for (const a of ANSWERS) {
    rows.push(
      `INSERT INTO scope_answers VALUES (${lit(a.job)}, ${lit(RUN)}, ${lit(a.prompt)}, ${lit(a.engine)}, ${lit(a.region)}, 'completed', ${lit(at(a.hoursAgo))}, NULL, 'text');`,
    );
  }
  for (const m of MENTIONS) {
    rows.push(
      `INSERT INTO scope_mentions (job_id, entity_id, brand, entity_type, mention_count, brand_rollup_entity_id, avg_position, sentiment_positive) VALUES (${lit(m.job)}, ${lit(m.entity)}, ${lit(m.name)}, ${lit(m.type)}, ${m.count}, ${lit(m.rollup)}, ${m.position}, ${m.positive});`,
    );
  }
  return rows.join("\n");
}

// ── PGlite ──────────────────────────────────────────────────────────────────

let pg: Pg;
beforeAll(async () => {
  vi.stubEnv("SCOPE_MODE", "live");
  vi.stubEnv("SCOPE_ROOT_PROJECT_ID", ROOT);
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  pg = new PGlite() as unknown as Pg;
  await pg.exec(DDL);
  await pg.exec(inserts());
  const real = drizzle(pg as never);
  st.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") return async (q: unknown) => (await target.execute(q as never)).rows;
      return Reflect.get(target, prop, receiver);
    },
  });
  setAnchorAxisForTests(false);
  setTrendGridForTests(false);
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, false);
}, 60_000);
afterAll(async () => {
  resetAnchorAxisForTests();
  resetTrendGridForTests();
  resetColumnAvailabilityForTests();
  vi.unstubAllEnvs();
  await pg?.close();
});

// ── backend model: GET /v1/mentions/prompts (M-3) ──────────────────────────

const PROMPT_BY_ID = new Map(PROMPTS.map((p) => [p.id, p]));
const ANSWER_BY_JOB = new Map(ANSWERS.map((a) => [a.job, a]));
/** Display brand of a mention row = the name of its rollup Brand entity. */
const displayBrand = (m: Mention) => BRAND_NAME.get(m.rollup) ?? m.name;
/**
 * rd.answer_brand.competitive (ingest brand_competitive(bare, disp)): the brand's bare name is not
 * a non-competitor name, or it is a bare-only one and the row's own name extends it. The backend
 * ports the legacy list and rule (app.non_competitor_name), so the rule is evaluated with the
 * legacy predicate here; what this parity checks is the grain and the sums around it.
 */
const competitive = (m: Mention) => !isNonCompetitorMention(displayBrand(m), m.name);

interface AnswerBrandRow {
  job: string;
  brand: string;
  val: number;
  tp: number;
  rk: number;
  positive: number;
  models: string[];
}
/** rd.answer_brand competitive rows: answer x display brand, entity rows folded, rk = rank by min position. */
function answerBrandRows(): AnswerBrandRow[] {
  const rows: AnswerBrandRow[] = [];
  for (const a of ANSWERS) {
    const byBrand = new Map<string, AnswerBrandRow>();
    for (const m of MENTIONS.filter((x) => x.job === a.job && competitive(x))) {
      const b = displayBrand(m);
      const r = byBrand.get(b) ?? { job: a.job, brand: b, val: 0, tp: Infinity, rk: 0, positive: 0, models: [] };
      r.val += m.count;
      r.tp = Math.min(r.tp, m.position);
      r.positive += m.positive;
      if (m.type === "Product") r.models.push(m.name);
      byBrand.set(b, r);
    }
    const list = [...byBrand.values()];
    for (const r of list) r.rk = 1 + list.filter((o) => o.tp < r.tp).length; // rank() OVER (ORDER BY tp)
    rows.push(...list);
  }
  return rows;
}

type PromptItem = D.ApiPromptItem;
function backendPrompts(target: { brand: string } | { signal: "positive" }, lite = false): S["PromptsData"] {
  const own = [...OWN].map((id) => BRAND_NAME.get(id)!);
  const rows = answerBrandRows()
    .filter((r) => ("brand" in target ? r.brand === target.brand : own.includes(r.brand) && r.positive > 0))
    .map((r) => ({ ...r, value: "brand" in target ? r.val : r.positive }));
  const byPrompt = new Map<string, typeof rows>();
  for (const r of rows) {
    const p = ANSWER_BY_JOB.get(r.job)!.prompt;
    byPrompt.set(p, [...(byPrompt.get(p) ?? []), r]);
  }
  const total = rows.reduce((n, r) => n + r.value, 0);
  const items: PromptItem[] = [...byPrompt].map(([pid, list]) => {
    const count = list.reduce((n, r) => n + r.value, 0);
    return {
      prompt_id: pid,
      prompt_text: PROMPT_BY_ID.get(pid)!.text,
      funnel_code: PROMPT_BY_ID.get(pid)!.funnel,
      count,
      share: { num: count, den: total },
      providers: [...new Set(list.map((r) => ANSWER_BY_JOB.get(r.job)!.engine))].sort(),
      answers: [...list]
        .sort((x, y) => y.value - x.value)
        .map((r) => {
          const a = ANSWER_BY_JOB.get(r.job)!;
          return {
            job_id: r.job,
            engine: a.engine,
            region: a.region,
            value: r.value,
            // lite (mode=signal only, B014): the backend does not compute these three
            position: lite ? null : r.rk,
            measured_at: lite ? null : at(a.hoursAgo),
            runs: lite ? null : 1,
            ...("brand" in target ? { terms: { brand: [target.brand], model: r.models } } : {}),
          };
        }),
    };
  });
  items.sort((x, y) => y.count - x.count || PROMPT_BY_ID.get(y.prompt_id)!.key - PROMPT_BY_ID.get(x.prompt_id)!.key);
  return {
    mode: "brand" in target ? "brand" : "signal",
    target: "brand" in target ? { brand_key: 1, name: target.brand } : { signal: target.signal },
    total,
    items,
  } as S["PromptsData"];
}

/** The adapter's loaders against the model, over fetch (the real client, query and conversion). */
async function apiList(target: { brand: string } | { signal: "positive" }): Promise<MentionsPromptLive[]> {
  const log: URL[] = [];
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const url = new URL(String(u));
      log.push(url);
      const body = { data: backendPrompts(target, url.searchParams.get("lite") === "true"), meta: { mode: "cumulative", page: { limit: 200, next_cursor: null } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  try {
    const ctx = { surface: "global" as const, scope: null };
    const rows =
      "brand" in target
        ? (await D.loadBrandMentionPrompts({ cumulative: true }, ctx, { mentionBrand: target.brand })).prompts
        : (await D.loadSignalPrompts({ cumulative: true }, ctx, target.signal)).prompts;
    const q = log[0].searchParams;
    expect([q.get("mode"), q.get("mention_brand"), q.get("signal")]).toEqual(
      "brand" in target ? ["brand", target.brand, null] : ["signal", null, target.signal],
    );
    // B010: one request of 2,000 for the brand list; B014: lite for the signal list
    expect([log.length, q.get("limit"), q.get("lite")]).toEqual("brand" in target ? [1, "2000", null] : [1, "50", "true"]);
    return rows;
  } finally {
    bindHghAuth(null);
    vi.unstubAllGlobals();
    vi.stubEnv("HGH_API_BASE_URL", "");
  }
}

// ── comparison ──────────────────────────────────────────────────────────────

/**
 * Order is presentation, not content: prompts by id (the drilldown table and the signal dialog
 * sort on the client), answer references by job id (API: value desc; legacy brand list: first
 * seen), providers as a set (API: engine key order; legacy: first seen).
 */
function normalize(list: MentionsPromptLive[]): MentionsPromptLive[] {
  return [...list]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({ ...p, providers: [...p.providers].sort(), answers: [...p.answers].sort((a, b) => a.jobId.localeCompare(b.jobId)) }));
}

function diff(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    return av === undefined && bv === undefined ? [] : diff(av, bv, path ? `${path}.${k}` : k);
  });
}

type Known = { path: RegExp; reason: string };
function expectOnlyKnown(legacy: MentionsPromptLive[], api: MentionsPromptLive[], known: Known[]): string[] {
  const d = diff(normalize(legacy), normalize(api));
  for (const p of d) expect(known.some((k) => k.path.test(p)), `undeclared difference ${p}`).toBe(true);
  for (const k of known) expect(d.some((p) => k.path.test(p)), `declared difference ${k.path} disappeared`).toBe(true);
  return d;
}

const legacyBrand = async (brand: string) =>
  (await aggregateMentionsFromMirror({ cumulative: true }, undefined, { onlyBrand: brand }))?.perBrandPrompts[brand] ?? [];

describe("brand drilldown: legacy aggregateMentionsFromMirror({onlyBrand}) vs M-3 mode=brand through the adapter", () => {
  it("Toyota: same prompts, counts (products folded into the brand), shares, providers, references", async () => {
    const legacy = await legacyBrand("Toyota");
    const api = await apiList({ brand: "Toyota" });
    // sanity: the legacy reader really read the WORLD
    expect(legacy.map((p) => [p.id, p.mentions, p.share])).toEqual([
      [u(0x30), 9, 90],
      [u(0x31), 1, 10],
    ]);
    // C-G11 / U6-N12: the prompt count is the same on both sides (every Toyota row, the product included)
    expect(normalize(api).map((p) => [p.id, p.mentions, p.share])).toEqual(normalize(legacy).map((p) => [p.id, p.mentions, p.share]));
    expectOnlyKnown(legacy, api, [
      { path: /^0\.answers\.0\.mentionCount$/, reason: "U6-N14 reference value: API = the brand's total in the answer (brand row + rolled-up products), legacy = its first mention row" },
      { path: /^1\.answers\.0\.position$/, reason: "U6-N15 reference position: API = the brand's rank among the answer's competitive brands, legacy = the first row's avg_position" },
    ]);
  });
  it("Golf (bare-only non-competitor name): both sides count only the competitive row (named product)", async () => {
    const legacy = await legacyBrand("Golf");
    const api = await apiList({ brand: "Golf" });
    expect(legacy.map((p) => [p.id, p.mentions])).toEqual([[u(0x32), 1]]);
    expect(api.map((p) => [p.id, p.mentions])).toEqual([[u(0x32), 1]]);
    expectOnlyKnown(legacy, api, [
      { path: /^0\.answers\.0\.position$/, reason: "U6-N15 reference position (rank 2 vs avg_position 3)" },
    ]);
  });
  it("a brand with no rows: both empty", async () => {
    expect(await legacyBrand("Nope")).toEqual([]);
    expect(await apiList({ brand: "Nope" })).toEqual([]);
  });
});

describe("signal list: legacy aggregateSignalPromptsFromMirror vs M-3 mode=signal through the adapter", () => {
  it("positive: same prompts, signal counts (own rows, products folded), shares, references", async () => {
    const legacy = await aggregateSignalPromptsFromMirror("positive", { cumulative: true });
    const api = await apiList({ signal: "positive" });
    expect(legacy.map((p) => [p.id, p.mentions, p.share])).toEqual([
      [u(0x31), 5, 62.5],
      [u(0x30), 3, 37.5],
    ]);
    expectOnlyKnown(legacy, api, [
      { path: /^\d\.funnelStage$/, reason: "U6-N16 signal list funnel: API = the catalog funnel (as the brand list), legacy = scope_prompts.funnel_stage (legacy vocabulary, null here)" },
    ]);
  });
});

// ── citation sources tab (B007): legacy group keys vs C-1 ?mention_brand= through the adapter ──

const CJ = (n: number) => `c0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const brandMention = (entity: string, name: string) => ({
  entity_id: entity,
  entity_type: "Brand",
  display_name: name,
  rollups: { product_entity_id: null, brand_entity_id: entity, company_entity_id: null },
  surfaces: [],
  mention_count: 1,
});
/** Answers: two mention Toyota (cited sources below), one only BMW (its sources are outside the drilldown). */
const CIT_JOBS = [
  { job: CJ(1), prompt: u(0x30), engine: "chatgpt", brands: [[TOYOTA, "Toyota"]] },
  { job: CJ(2), prompt: u(0x31), engine: "gemini", brands: [[TOYOTA, "Toyota"], [BMW, "BMW"]] },
  { job: CJ(3), prompt: u(0x32), engine: "chatgpt", brands: [[BMW, "BMW"]] },
] as const;
/** Citations per answer: an official HMG social account (host+path key) next to plain rows of the same host. */
const CIT_URLS: Record<string, { url: string; host: string }[]> = {
  [CJ(1)]: [
    { url: "https://www.linkedin.com/company/hyundai-motor-group/posts/1", host: "linkedin.com" },
    { url: "https://www.linkedin.com/in/someone", host: "linkedin.com" },
    { url: "https://www.reddit.com/r/cars/1", host: "reddit.com" },
  ],
  [CJ(2)]: [
    { url: "https://www.linkedin.com/posts/hyundai-motor-group_ioniq-123", host: "linkedin.com" },
    { url: "https://www.linkedin.com/pulse/ev-2026", host: "linkedin.com" },
    { url: "https://www.linkedin.com/company/hyundai-motor-group/about", host: "linkedin.com" },
  ],
  [CJ(3)]: [{ url: "https://www.linkedin.com/in/other", host: "linkedin.com" }],
};

function legacyBrandSources(brand: string) {
  const jobs = CIT_JOBS.map((j) => ({
    job_id: j.job,
    prompt_id: j.prompt,
    target: j.engine,
    region: "US",
    status: "completed",
    measured_at: at(10),
    analysis: { status: "completed", resolved_mentions: j.brands.map(([id, name]) => brandMention(id, name)) },
  }));
  const results = CIT_JOBS.map((j) => ({
    job_id: j.job,
    target: j.engine,
    status: "completed",
    result: { answer_text: "", measured_at: at(10), citations: CIT_URLS[j.job] },
  }));
  const promptMap = new Map(PROMPTS.map((p) => [p.id, { text: p.text, funnel: p.funnel }]));
  return aggregateBrandCitationsFrom(jobs as never, promptMap as never, results as never, brand, {}, { anchorAxis: false });
}

/** C-1 ?mention_brand= model: rows per source group key (skey) with the display host (domain), citations desc. */
function backendSources(brand: string): S["DomainsData"] {
  const jobs = new Set(CIT_JOBS.filter((j) => j.brands.some(([, name]) => name === brand)).map((j) => j.job));
  const by = new Map<string, { domain: string; citations: number; answers: Set<string>; prompts: Set<string> }>();
  for (const j of CIT_JOBS.filter((x) => jobs.has(x.job))) {
    for (const c of CIT_URLS[j.job]) {
      const skey = citationGroupKey(c.host, c.url);
      const r = by.get(skey) ?? { domain: c.host, citations: 0, answers: new Set<string>(), prompts: new Set<string>() };
      r.citations += 1;
      r.answers.add(j.job);
      r.prompts.add(j.prompt);
      by.set(skey, r);
    }
  }
  const total = [...by.values()].reduce((n, r) => n + r.citations, 0);
  const items = [...by]
    .sort(([ka, a], [kb, b]) => b.citations - a.citations || ka.localeCompare(kb))
    .map(([skey, r], i) => ({
      skey,
      domain: r.domain,
      is_social: skey !== r.domain,
      category: null,
      citations: r.citations,
      share: { num: r.citations, den: total },
      citing_answers: r.answers.size,
      coverage: { num: r.answers.size, den: jobs.size },
      own_citations: 0,
      is_own: false,
      is_target: false,
      competitor_brand: null,
      citing_prompts: r.prompts.size,
      rank: i + 1,
      match_rank: i + 1,
    }));
  return {
    summary: { total_citations: total, unique_sources: items.length, own_share: { num: 0, den: total }, answers_den: jobs.size },
    items,
    competitor_totals: [],
  } as S["DomainsData"];
}

async function apiSources(brand: string) {
  const log: URL[] = [];
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url0: string) => {
      const url = new URL(String(url0));
      log.push(url);
      const data = backendSources(url.searchParams.get("mention_brand") ?? "");
      const body = { data, meta: { mode: "cumulative", page: { limit: 2000, next_cursor: null, total: data.items.length } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  try {
    const res = await D.loadBrandCitationDomains({ cumulative: true }, { surface: "global", scope: null }, brand);
    expect(log.map((x) => [x.pathname, x.searchParams.get("mention_brand"), x.searchParams.get("limit")])).toEqual([
      ["/v1/citations/domains", brand, "2000"],
    ]);
    return res;
  } finally {
    bindHghAuth(null);
    vi.unstubAllGlobals();
    vi.stubEnv("HGH_API_BASE_URL", "");
  }
}

describe("citation sources tab (B007): legacy aggregateBrandCitationsFrom vs C-1 mention_brand through the adapter", () => {
  it("an official social account row and the plain row of its host keep the legacy names and count", async () => {
    const legacy = legacyBrandSources("Toyota");
    const api = await apiSources("Toyota");
    const rows = (list: { domain: string; citations: number; prompts: number }[]) =>
      list.map((r) => [r.domain, r.citations, r.prompts] as const).sort((a, b) => a[0].localeCompare(b[0]));
    // sanity: the legacy rollup really split the host (official account key next to the plain host)
    expect(rows(legacy)).toEqual([
      ["linkedin.com", 2, 2],
      ["linkedin.com/hyundai-motor-group", 3, 2],
      ["reddit.com", 1, 1],
    ]);
    expect(rows(api.domains)).toEqual(rows(legacy));
    expect(api.total).toBeUndefined();
    expect(new Set(api.domains.map((r) => r.domain)).size).toBe(api.domains.length); // table React key / expanded row
    // the display host alone would have collided (the pre-B007 row name)
    const hosts = backendSources("Toyota").items.map((r) => r.domain);
    expect(new Set(hosts).size).toBeLessThan(hosts.length);
  });
  it("a brand cited nowhere: both empty", async () => {
    expect(legacyBrandSources("Nope")).toEqual([]);
    expect((await apiSources("Nope")).domains).toEqual([]);
  });
});
