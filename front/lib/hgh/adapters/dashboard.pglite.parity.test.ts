import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { components } from "../api-types";

// Legacy <-> API parity of the global cards ①~⑤ (+ KPI #16) with the LEGACY SQL READER RUN
// (U5 verification D4). dashboard.parity.test.ts models the legacy aggregates by hand; here the
// legacy side is real SQL:
//   legacy: rows on PGlite (real PostgreSQL); lib/scope/server's fetchStandardAggregates is
//           replaced by its mirror reader aggregateStandardFromMirror(filters, undefined,
//           scopeOwnedPrefixes(filters)) (the exact call of server.ts cachedStandardAggregates),
//           so the card definitions (tracked-answer visibility, rollup share of voice,
//           mention-unit sentiment, per-answer own-brand rank, owned-prefix citation share,
//           non-competitor exclusion, root answer-set gate) run as SQL. The UNCHANGED
//           getLiveDashboard builds the cards from it.
//   api:    a backend model of GET /v1/kpi/summary and /v1/mentions/brands computed from the same
//           WORLD in JS with the documented K-1 / M-1 definitions, including DC-01 (engine[] empty
//           = default engines only), through the D8 facade with HGH_SOURCE_G1=api.
// Limit (stated, not hidden): the legacy summary-layer reader (viaGlobalS1 on the summary_*
// tables, the preferred path in production) is not run; its card definitions are the same as the
// mirror reader's by the legacy design (T11) and are not re-checked here. Only the global cards
// run on SQL; the website and project cards, trends and GEO stay at the view-model layer in
// dashboard.parity.test.ts (its header says so).

type Pg = {
  exec(q: string): Promise<unknown>;
  query(q: string, p?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  close(): Promise<void>;
};
const st = vi.hoisted(() => ({ pg: null as unknown }));
const dialect = new PgDialect();
vi.mock("@/lib/db", () => {
  const execute = async (q: SQL) => {
    const c = dialect.sqlToQuery(q);
    return (await (st.pg as Pg).query(c.sql, c.params as unknown[])).rows;
  };
  return {
    getDb: () => ({
      execute,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const pg = st.pg as Pg;
        await pg.exec("BEGIN");
        try {
          const out = await fn({ execute });
          await pg.exec("COMMIT");
          return out;
        } catch (e) {
          await pg.exec("ROLLBACK");
          throw e;
        }
      },
    }),
  };
});
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});
// Only fetchStandardAggregates is used by getLiveDashboard's legacy branch; it runs the real reader.
vi.mock("@/lib/scope/server", async () => {
  const agg = await import("@/lib/db/repositories/scope-aggregates");
  const { ownedBasePrefixesForScope } = await import("@/lib/scope/hmg-brands");
  type F = import("@/lib/scope/result-adapter").StandardFilters;
  return {
    fetchStandardAggregates: vi.fn(async (f: F = {}) =>
      agg.aggregateStandardFromMirror(
        f,
        undefined,
        ownedBasePrefixesForScope(f.contextBrand ?? f.brand, f.ownEntities, f.websiteCountry ?? f.region, f.lang),
      ),
    ),
    wasDegraded: vi.fn(() => false),
  };
});
vi.mock("@/lib/ga4/property-map", () => ({ resolveProperty: vi.fn(async () => null), resolveProperties: vi.fn(async () => []) }));
vi.mock("@/lib/ga4/conversion", () => ({
  getAiTrafficConversionKpi: vi.fn(),
  getAiTrafficConversionRollup: vi.fn(),
  getAiVisitsKpi: vi.fn(),
}));
const session = vi.hoisted(() => ({
  current: { user: { id: "u", email: "", role: "admin", operator: "none", menuGroups: null, scope: { all: true } } } as unknown,
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => session.current) }));

const path = await import("node:path");
const fs = await import("node:fs");
const { createTableFrom, MIG_DIR } = await import("@/scripts/db/answer-cycle-anchors-pglite-fixture");
const { STANDARD_ROOT_PROJECT_ID } = await import("@/lib/db/repositories/standards");
const { HMG_BRAND_ENTITY_IDS, ownedBasePrefixesForScope } = await import("@/lib/scope/hmg-brands");
const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("../auth");
const dashLive = await import("@/app/[locale]/(dash)/dashboard/_data/live");

type S = components["schemas"];
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln"; // {"alg":"ES256"}.{"sub":"u"}.sig

// ── DDL (the tables the mirror reader and its answer-set gate read) ─────────

const MIRROR = path.join(process.cwd(), "scripts", "db", "scope-mirror.sql");
const mig = (f: string) => path.join(MIG_DIR, f);
function normFnDdl(): string[] {
  const src = fs.readFileSync(mig("0052_scope_citations_url_norm.sql"), "utf8");
  return ["citation_url_norm", "citation_url_base_norm"].map((n) => {
    const hit = src.match(new RegExp(`CREATE OR REPLACE FUNCTION ${n}\\(text\\)[\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$;`));
    if (!hit) throw new Error(`0052: ${n}`);
    return hit[0];
  });
}
const DDL = (): string[] => [
  ...["scope_runs", "scope_answers", "scope_mentions", "scope_citations", "scope_prompts"].map((t) => createTableFrom(MIRROR, t)),
  `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS project_id uuid;`,
  `ALTER TABLE scope_runs ADD COLUMN IF NOT EXISTS cycle_anchor_at timestamptz;`,
  ...["brand_rollup_entity_id uuid", "surfaces text[]"].map((c) => `ALTER TABLE scope_mentions ADD COLUMN IF NOT EXISTS ${c};`),
  `ALTER TABLE scope_citations ADD COLUMN IF NOT EXISTS category text;`,
  ...["is_korean boolean", "regions text[]"].map((c) => `ALTER TABLE scope_prompts ADD COLUMN IF NOT EXISTS ${c};`),
  createTableFrom(mig("0059_summary_tables.sql"), "summary_cycles"),
  ...["hidden_reason text", "hidden_scope text", "fleet_visible boolean", "view_anchor_at timestamptz", "active_generation_id uuid", "cycle_week date"].map(
    (c) => `ALTER TABLE summary_cycles ADD COLUMN IF NOT EXISTS ${c};`,
  ),
  createTableFrom(mig("0059_summary_tables.sql"), "summary_cycle_runs"),
  `CREATE TABLE IF NOT EXISTS projects (id uuid PRIMARY KEY, name text, country text, scope_project_id uuid, industry_id uuid);`,
  `CREATE TABLE IF NOT EXISTS prompts (id uuid PRIMARY KEY, scope_prompt_id uuid, project_id uuid, brand text, list_type text,
     depth1 text, depth2 text, depth3 text, depth4 text, region text, country text, lang_code text, kind text, enabled boolean,
     funnel_stage text, brand_presence text, deleted_at timestamptz);`,
  `CREATE TABLE IF NOT EXISTS prompt_custom_field_values (prompt_id uuid, field_id uuid, value text);`,
  `CREATE TABLE IF NOT EXISTS entity_registry (id uuid PRIMARY KEY, name text, role text);`,
  ...normFnDdl(),
];

// ── WORLD: one root round in DE, three catalog prompts ──────────────────────

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const lit = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const RUN = u(0x100);
const BRAND_ID: Record<string, string> = {
  Kia: HMG_BRAND_ENTITY_IDS.Kia,
  Hyundai: HMG_BRAND_ENTITY_IDS.Hyundai,
  Toyota: u(0x901),
  Honda: u(0x902),
};
const OWN = new Set(["Kia", "Hyundai"]);
interface Mention {
  brand: string;
  count: number;
  pos: number;
  sent: [number, number, number, number]; // positive, neutral, negative, mixed
}
interface Answer {
  job: string;
  prompt: number;
  target: string;
  mentions: Mention[];
  cites: string[];
}
const mn = (brand: string, count: number, pos: number, sent: Mention["sent"]): Mention => ({ brand, count, pos, sent });
const BASE_ANSWERS: Answer[] = [
  { job: u(0x301), prompt: 1, target: "chatgpt", mentions: [mn("Kia", 3, 1.5, [2, 1, 0, 0]), mn("Toyota", 2, 3, [0, 2, 0, 0])], cites: ["https://www.kia.com/de/modelle/ev9/", "https://www.toyota.de/x"] },
  { job: u(0x302), prompt: 1, target: "gemini", mentions: [mn("Hyundai", 1, 4, [1, 0, 0, 0]), mn("Toyota", 1, 2, [0, 0, 1, 0])], cites: ["https://en.wikipedia.org/wiki/Kia"] },
  { job: u(0x303), prompt: 2, target: "chatgpt", mentions: [mn("Honda", 2, 1, [0, 2, 0, 0])], cites: ["https://www.honda.de/"] },
  { job: u(0x304), prompt: 2, target: "gemini", mentions: [mn("Kia", 1, 7, [0, 0, 0, 1]), mn("Honda", 1, 1, [0, 1, 0, 0]), mn("Toyota", 1, 5, [0, 1, 0, 0])], cites: ["https://www.kia.com/de/a", "https://www.kia.com/de/b"] },
  { job: u(0x305), prompt: 3, target: "chatgpt", mentions: [], cites: [] },
  { job: u(0x306), prompt: 3, target: "gemini", mentions: [mn("Kia", 2, 2, [2, 0, 0, 0]), mn("Hyundai", 1, 6, [1, 0, 0, 0])], cites: ["https://www.hyundai.com/de/de/"] },
];
/** An answer of a non-default engine (DC-01: the backend's engine[] empty reads default engines only). */
const CLAUDE_ANSWER: Answer = {
  job: u(0x307),
  prompt: 1,
  target: "claude",
  mentions: [mn("Kia", 4, 1, [4, 0, 0, 0])],
  cites: ["https://www.kia.com/de/c"],
};
const DEFAULT_ENGINES = new Set(["chatgpt", "gemini"]);

function worldSql(answers: Answer[]): string {
  const rows: string[] = [
    `INSERT INTO scope_runs (run_id, status, started_at, completed_at, total_jobs, project_id) VALUES (${lit(RUN)}, 'completed', now() - interval '1 day', now() - interval '1 day', ${answers.length}, NULL);`,
  ];
  for (const p of [1, 2, 3]) {
    rows.push(
      `INSERT INTO prompts (id, scope_prompt_id, project_id, brand, enabled) VALUES (${lit(u(0x200 + p))}, ${lit(u(0x10 + p))}, ${lit(STANDARD_ROOT_PROJECT_ID)}, 'Kia', true);`,
      `INSERT INTO scope_prompts (prompt_id, text) VALUES (${lit(u(0x10 + p))}, 'p${p}');`,
    );
  }
  for (const a of answers) {
    rows.push(
      `INSERT INTO scope_answers (job_id, run_id, prompt_id, target, region, status, measured_at) VALUES (${lit(a.job)}, ${lit(RUN)}, ${lit(u(0x10 + a.prompt))}, ${lit(a.target)}, 'DE', 'completed', now() - interval '1 day');`,
    );
    for (const x of a.mentions) {
      const id = BRAND_ID[x.brand];
      rows.push(
        `INSERT INTO scope_mentions (job_id, entity_id, brand, entity_type, mention_count, sentiment_positive, sentiment_neutral, sentiment_negative, sentiment_mixed, avg_position, brand_rollup_entity_id) VALUES (${lit(a.job)}, ${lit(id)}, ${lit(x.brand)}, 'Brand', ${x.count}, ${x.sent.join(", ")}, ${x.pos}, ${lit(id)});`,
      );
    }
    for (const url of a.cites) {
      const host = new URL(url).hostname.replace(/^www\./, "");
      rows.push(`INSERT INTO scope_citations (job_id, url, domain) VALUES (${lit(a.job)}, ${lit(url)}, ${lit(host)});`);
    }
  }
  return rows.join("\n");
}

// ── backend model (K-1 summary, M-1 brands) from the same WORLD ──────────────

/** Owned citation = the URL (scheme and www stripped) is an owned base of the scope or under it. */
function isOwnedUrl(url: string, prefixes: readonly string[]): boolean {
  const s = url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  return prefixes.some((p) => s === p || s.startsWith(`${p}/`));
}
/** Brand rank in an answer = 1 + brands strictly ahead by position (rank()). */
function brandRank(a: Answer, brand: string): number | null {
  const x = a.mentions.find((y) => y.brand === brand);
  return x ? 1 + a.mentions.filter((y) => y.pos < x.pos).length : null;
}
/** Own rank of an answer = best rank among own brands (D5 counts answers with an own rank). */
function ownRank(a: Answer): number | null {
  const own = a.mentions.filter((x) => OWN.has(x.brand)).map((x) => brandRank(a, x.brand)!);
  return own.length ? Math.min(...own) : null;
}

function backendSummary(world: Answer[], prefixes: readonly string[]): S["SummaryData"] {
  const as = world.filter((a) => DEFAULT_ENGINES.has(a.target)); // DC-01
  const ms = as.flatMap((a) => a.mentions);
  const own = ms.filter((x) => OWN.has(x.brand));
  const ranks = as.map(ownRank).filter((r): r is number => r !== null);
  const cites = as.flatMap((a) => a.cites);
  return {
    visibility: { num: as.filter((a) => a.mentions.some((x) => OWN.has(x.brand))).length, den: as.length },
    share_of_voice: { num: own.reduce((s, x) => s + x.count, 0), den: ms.reduce((s, x) => s + x.count, 0) },
    sentiment: { num: own.reduce((s, x) => s + x.sent[0], 0), den: own.reduce((s, x) => s + x.sent.reduce((p, q) => p + q, 0), 0) },
    position: { sum: ranks.reduce((s, r) => s + r, 0), count: ranks.length },
    citation_share: { num: cites.filter((c) => isOwnedUrl(c, prefixes)).length, den: cites.length },
    target_url_rate: null,
    owned_url_rate: null,
    citation_accuracy: null,
    params: { answers: as.length, applied_prompts: 3, measured_prompts: 3, prompts_without_brand: 0, measured_by_funnel: null },
    analysis_gap: { gap_answers: 0, base_answers: as.length },
  };
}

function backendBrands(world: Answer[]): S["BrandsData"] {
  const as = world.filter((a) => DEFAULT_ENGINES.has(a.target)); // DC-01
  const total = as.flatMap((a) => a.mentions).reduce((s, x) => s + x.count, 0);
  const items = Object.keys(BRAND_ID)
    .map((name, i): S["BrandItem"] => {
      const hits = as.filter((a) => a.mentions.some((x) => x.brand === name));
      const rows = hits.flatMap((a) => a.mentions.filter((x) => x.brand === name));
      const mentions = rows.reduce((s, x) => s + x.count, 0);
      const ranks = hits.map((a) => brandRank(a, name)!);
      const sent = rows.reduce((s, x) => s.map((v, k) => v + x.sent[k]), [0, 0, 0, 0]);
      return {
        name,
        rank: 0,
        mentions,
        exposure: { num: hits.length, den: as.length },
        share: { num: mentions, den: total },
        avg_rank: ranks.length ? { sum: ranks.reduce((s, r) => s + r, 0), count: ranks.length } : null,
        is_own: OWN.has(name),
        is_hmg_own: OWN.has(name),
        brand_key: 10 + i,
        sentiment: { positive: sent[0], neutral: sent[1], negative: sent[2], mixed: sent[3] },
      };
    })
    .filter((b) => b.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions)
    .map((b, i) => ({ ...b, rank: i + 1 }));
  const ownMentions = items.filter((b) => b.is_own).reduce((s, b) => s + b.mentions, 0);
  return {
    brands: items,
    own: { brands: ["Hyundai", "Kia"], vp_label: "HMG", mentions: ownMentions, rank: 1, exposure: { num: 0, den: as.length }, share: { num: ownMentions, den: total }, avg_rank: null },
    totals: { answers: as.length, brand_count: items.length, mentions_total: total },
  };
}

const meta = (): S["Meta"] => ({ mode: "snapshot", as_of: "2026-09-28", cycles: ["2026-09-28"] });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const noConversion: S["ConversionData"] = {
  coverage: { total_markets: 0, measured_markets: 0, markets: [] },
  summary: { ai: { conversions: 0, sessions: 0, page_views: 0, conv: { num: 0, den: 0 } }, human: { conversions: 0, sessions: 0, conv: { num: 0, den: 0 } } },
  trend: [],
  by_engine: [],
  by_country: null,
  pages: [],
  period: { from: null, to: null },
};

/** Paths where a and b differ (undefined on both sides is equal). */
function diff(a: unknown, b: unknown, p = ""): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return [p];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    return av === undefined && bv === undefined ? [] : diff(av, bv, p ? `${p}.${k}` : k);
  });
}
function expectOnlyKnown(legacy: unknown, api: unknown, known: { path: RegExp; reason: string }[]) {
  const d = diff(legacy, api);
  for (const x of d) expect(known.some((k) => k.path.test(x)), `undeclared difference at ${x}`).toBe(true);
  for (const k of known) expect(d.some((x) => k.path.test(x)), `declared difference ${k.path} (${k.reason}) disappeared`).toBe(true);
}

// ── harness ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  st.pg = new PGlite();
  for (const q of DDL()) await (st.pg as Pg).exec(q);
});
afterAll(async () => {
  await (st.pg as Pg).close();
});

let routes: Record<string, () => Response>;
beforeEach(async () => {
  for (const t of ["scope_runs", "scope_answers", "scope_mentions", "scope_citations", "scope_prompts", "prompts"]) {
    await (st.pg as Pg).exec(`DELETE FROM ${t};`);
  }
  routes = {};
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const r = routes[new URL(String(input)).pathname];
      return r ? r() : new Response(JSON.stringify({ error: { code: "not_found", message: "", details: null } }), { status: 404 });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function bothSides(world: Answer[]) {
  await (st.pg as Pg).exec(worldSql(world));
  const legacy = await withRequestScope(() => dashLive.getLiveDashboard({}));
  const prefixes = ownedBasePrefixesForScope(undefined, undefined, undefined, undefined);
  vi.stubEnv("HGH_SOURCE_G1", "api");
  routes["/v1/kpi/summary"] = () => json({ data: backendSummary(world, prefixes), meta: meta() });
  routes["/v1/mentions/brands"] = () => json({ data: backendBrands(world), meta: meta() });
  routes["/v1/funnel/conversion"] = () => json({ data: noConversion, meta: meta() });
  const api = await withRequestScope(() => dashLive.getLiveDashboard({}));
  return { legacy, api, prefixes };
}

const COPY_ONLY = { path: /^kpis\.5\.copyVariant$/, reason: "DC-03 wording on the api ⑦ card (u5 messages); no GA4 market on either side" };

describe("global cards on the real legacy SQL reader (PGlite) vs HGH_SOURCE_G1=api", () => {
  it("default engines only: ①~⑤ values, ratios and KPI #16 are equal", async () => {
    const { legacy, api, prefixes } = await bothSides(BASE_ANSWERS);
    // the world really exercises the owned rule and the rank rule
    expect(prefixes).toEqual(expect.arrayContaining(["kia.com/de", "hyundai.com/de/de"]));
    expect(legacy).not.toBeNull();
    const card = (k: string) => legacy!.kpis.find((x) => x.key === k);
    // hand check of the SQL: 4 of 6 answers with an own brand; own ranks 1, 2, 3, 1 -> 1.75 -> 1.8
    // (the stored positions 1.5, 4, 7, 2 average 3.6: the card is the brand rank, not the raw position);
    // owned citations kia.com/de x3 + hyundai.com/de/de of 7; positive 6 of 8 own sentiment signals
    expect([card("visibility")?.value, card("position")?.value, card("citationShare")?.value, card("sentiment")?.value]).toEqual([66.7, 1.8, 57.1, 75]);
    // KPI #16: own mentions 8 / Toyota 4 x 100
    expect(card("shareOfVoice")?.competitorSov).toEqual({ brand: "Toyota", value: 200 });
    expectOnlyKnown(legacy, api, [COPY_ONLY]);
  });

  it("a non-default engine answer: the differences are exactly DC-01 (legacy counts every engine)", async () => {
    const { legacy, api } = await bothSides([...BASE_ANSWERS, CLAUDE_ANSWER]);
    expectOnlyKnown(legacy, api, [
      COPY_ONLY,
      { path: /^kpis\.0\.(value|ratio\.(numerator|denominator))$/, reason: "DC-01: visibility 5/7 (every engine) vs 4/6 (default engines)" },
      { path: /^kpis\.1\.(value|ratio\.(numerator|denominator))$/, reason: "DC-01: share of voice with the claude mentions" },
      { path: /^kpis\.1\.competitorSov\.value$/, reason: "DC-01: KPI #16 numerator with the claude mentions (12 / 4 vs 8 / 4)" },
      { path: /^kpis\.2\.(value|ratio\.(numerator|denominator))$/, reason: "DC-01: sentiment with the claude signals" },
      { path: /^kpis\.3\.(value|ratio\.(numerator|denominator))$/, reason: "DC-01: position with the claude rank 1 (8 / 5 = 1.6 vs 7 / 4 = 1.8)" },
      { path: /^kpis\.4\.(value|ratio\.(numerator|denominator))$/, reason: "DC-01: citation share with the claude citation" },
    ]);
  });
});
