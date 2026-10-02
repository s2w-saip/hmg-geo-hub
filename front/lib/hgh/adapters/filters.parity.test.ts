import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { AllowedScope } from "@/lib/auth/types";

// Legacy <-> API parity of the filter option lists (unit U4, F-1).
//
// Method. One WORLD (root catalog prompts, prompt languages, runs, answers) is written twice:
//   legacy: rows on PGlite (real PostgreSQL), read by the UNCHANGED legacy readers the pages
//           call (listCatalogTaxonomy, listMeasuredRegions, listMeasuredStandardLanguages,
//           listMeasuredScopeMatrix) with the same arguments as dashboard/page.tsx;
//   api:    a backend model of GET /v1/filters/options built from the same WORLD with the
//           documented F-1 semantics (completed answers in the window, root catalog, hidden
//           countries out, scope = account brands + common rows, umbrella and brand-less
//           prompts as brand null), converted by lib/hgh/adapters/filters.ts exactly as
//           toPanelOptions does (geo_matrix narrowed by optionBrandsFor).
// The two outputs are diffed per list; differing values must equal KNOWN_DIFF with a reason.

const st = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => st.db }));

const { setAnchorAxisForTests, resetAnchorAxisForTests } = await import("@/lib/period/anchor-axis-state");
const { SYNC_PROBED_COLUMNS, setColumnAvailabilityForTests, resetColumnAvailabilityForTests } = await import(
  "@/lib/db/column-availability"
);
const { STANDARD_ROOT_PROJECT_ID, listCatalogTaxonomy } = await import("@/lib/db/repositories/standards");
const { listMeasuredRegions, listMeasuredStandardLanguages, listMeasuredScopeMatrix } = await import(
  "@/lib/db/repositories/scope-aggregates"
);
const { narrowScopeBrands } = await import("@/lib/scope/hmg-brands");
const { readStandardFilters } = await import("@/components/dash/standard-filters");
const F = await import("./filters");

type S = components["schemas"];
type Pg = { exec(q: string): Promise<unknown>; close(): Promise<void> };

const ROOT = STANDARD_ROOT_PROJECT_ID;
const OTHER = "00000000-0000-4000-8000-0000000000ff";
const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WINDOW = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };

// ── WORLD ───────────────────────────────────────────────────────────────────

interface Prompt {
  id: string;
  project: string;
  brand: string | null;
  lang: string | null;
  presence: string;
  listType: string;
  d1: string | null;
  d2: string | null;
  d4: string | null;
  funnel: string | null;
  deleted?: boolean;
}
const P: Record<string, Prompt> = {
  P1: { id: u(1), project: ROOT, brand: "Hyundai", lang: "EN", presence: "branded", listType: "Brand Message", d1: "1.", d2: "a", d4: "x", funnel: "인지/탐색" },
  P2: { id: u(2), project: ROOT, brand: "Kia", lang: "EN", presence: "branded", listType: "Brand Message", d1: "2.", d2: null, d4: null, funnel: "구매/사후관리" },
  P3: { id: u(3), project: ROOT, brand: "HMG", lang: "KO", presence: "unbranded", listType: "Category", d1: null, d2: null, d4: null, funnel: null },
  P4: { id: u(4), project: ROOT, brand: null, lang: "FR", presence: "unbranded", listType: "Category", d1: null, d2: null, d4: null, funnel: null },
  P5: { id: u(5), project: ROOT, brand: "Genesis", lang: null, presence: "branded", listType: "Brand Message", d1: "3.", d2: null, d4: null, funnel: null },
  P6: { id: u(6), project: ROOT, brand: "Kia", lang: "DE", presence: "branded", listType: "Old", d1: null, d2: null, d4: null, funnel: null, deleted: true },
  P7: { id: u(7), project: OTHER, brand: "Hyundai", lang: "DE", presence: "branded", listType: "Other", d1: null, d2: null, d4: null, funnel: null },
};
const RUN_IN = u(0x100); // started inside the window
const RUN_OUT = u(0x101); // started before it
interface Answer {
  prompt: Prompt;
  region: string;
  run: string;
  status: string;
}
const A: Answer[] = [
  { prompt: P.P1, region: "US", run: RUN_IN, status: "completed" },
  { prompt: P.P1, region: "KR", run: RUN_IN, status: "completed" },
  { prompt: P.P2, region: "US", run: RUN_IN, status: "completed" },
  { prompt: P.P2, region: "GB", run: RUN_IN, status: "completed" },
  { prompt: P.P3, region: "JP", run: RUN_IN, status: "completed" },
  { prompt: P.P4, region: "FR", run: RUN_IN, status: "completed" },
  { prompt: P.P5, region: "DE", run: RUN_IN, status: "completed" },
  { prompt: P.P2, region: "ID", run: RUN_IN, status: "completed" }, // hidden standard country
  { prompt: P.P1, region: "MX", run: RUN_OUT, status: "completed" }, // outside the window
  { prompt: P.P2, region: "BR", run: RUN_IN, status: "failed" }, // only a failed answer in BR
  { prompt: P.P7, region: "CA", run: RUN_IN, status: "completed" }, // not a root catalog prompt
  { prompt: P.P1, region: "UNKNOWN", run: RUN_IN, status: "completed" },
];

const DDL = `
CREATE TABLE scope_runs (run_id uuid PRIMARY KEY, project_id uuid, started_at timestamptz, cycle_anchor_at timestamptz);
CREATE TABLE prompts (id uuid PRIMARY KEY, project_id uuid NOT NULL, brand text, brand_presence text, list_type text,
  depth1 text, depth2 text, depth3 text, depth4 text, funnel_stage text, scope_prompt_id uuid, deleted_at timestamptz);
CREATE TABLE scope_prompts (prompt_id uuid PRIMARY KEY, lang text);
CREATE TABLE scope_answers (job_id uuid PRIMARY KEY, run_id uuid, prompt_id uuid, region text, status text);
`;

const lit = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
function inserts(): string {
  const rows: string[] = [
    `INSERT INTO scope_runs VALUES (${lit(RUN_IN)}, ${lit(ROOT)}, '2026-09-10T01:00:00Z', NULL), (${lit(RUN_OUT)}, ${lit(ROOT)}, '2026-08-01T01:00:00Z', NULL);`,
  ];
  Object.values(P).forEach((p, i) => {
    // catalog row id and scope prompt id differ on purpose (only scope_prompt_id joins answers)
    rows.push(
      `INSERT INTO prompts VALUES (${lit(u(0x200 + i))}, ${lit(p.project)}, ${lit(p.brand)}, ${lit(p.presence)}, ${lit(p.listType)}, ${lit(p.d1)}, ${lit(p.d2)}, NULL, ${lit(p.d4)}, ${lit(p.funnel)}, ${lit(p.id)}, ${p.deleted ? "'2026-09-01T00:00:00Z'" : "NULL"});`,
      `INSERT INTO scope_prompts VALUES (${lit(p.id)}, ${lit(p.lang)});`,
    );
  });
  A.forEach((a, i) => rows.push(`INSERT INTO scope_answers VALUES (${lit(u(0x300 + i))}, ${lit(a.run)}, ${lit(a.prompt.id)}, ${lit(a.region)}, ${lit(a.status)});`));
  return rows.join("\n");
}

// ── backend model: GET /v1/filters/options (F-1) ─────────────────────────────

const HIDDEN_STANDARD = new Set(["ID"]); // the backend until BE-2 (S1-N1, see HIDDEN_ID)
const UMBRELLA = "HMG";
function backendOptions(scope: AllowedScope): S["OptionsData"] {
  const inWindow = (a: Answer) => a.run === RUN_IN;
  const rows = new Map<string, S["GeoCombo"]>();
  for (const a of A) {
    const p = a.prompt;
    if (a.status !== "completed" || !inWindow(a) || p.project !== ROOT || p.deleted) continue;
    if (a.region === "UNKNOWN" || HIDDEN_STANDARD.has(a.region)) continue;
    const brand = p.brand === UMBRELLA ? null : p.brand; // umbrella and brand-less prompts = common (null)
    if (!scope.all) {
      if (scope.countries && !scope.countries.includes(a.region)) continue;
      if (scope.brands && brand !== null && !scope.brands.includes(brand)) continue;
    }
    const row = { brand, region: a.region, lang: p.lang?.toLowerCase() ?? null };
    rows.set(JSON.stringify(row), row);
  }
  const catalogRows = Object.values(P)
    .filter((p) => p.project === ROOT && !p.deleted)
    .map((p) => ({ brand: p.brand, brand_presence: p.presence, list_type: p.listType, depth1: p.d1, depth2: p.d2, depth3: null, depth4: p.d4, funnel: p.funnel }));
  return {
    catalog: { brand_presence: [], depth1: [], depth2: [], depth3: [], funnel: [], list_type: [], rows: catalogRows },
    custom_fields: null,
    engines: [],
    geo_matrix: [...rows.values()],
    languages: [],
    regions: [],
    source_categories: [],
  };
}

// ── PGlite ──────────────────────────────────────────────────────────────────

let pg: Pg;
beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  pg = new PGlite() as unknown as Pg;
  await pg.exec(DDL);
  await pg.exec(inserts());
  const real = drizzle(pg as never);
  // Production (drizzle postgres-js) returns rows from db.execute() as an array; pglite returns {rows}.
  st.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") return async (q: unknown) => (await target.execute(q as never)).rows;
      return Reflect.get(target, prop, receiver);
    },
  });
  // Legacy axis off (the option readers' run window), no optional columns probed.
  setAnchorAxisForTests(false);
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, false);
}, 60_000);
afterAll(async () => {
  resetAnchorAxisForTests();
  resetColumnAvailabilityForTests();
  await pg?.close();
});

// ── cases ───────────────────────────────────────────────────────────────────

interface Case {
  name: string;
  scope: AllowedScope;
  url: Record<string, string>;
  known: { list: "regions" | "languages" | "matrix" | "catalog"; value: string; reason: string }[];
}
const FAILED_ONLY = "legacy listMeasuredRegions has no status predicate: a country with only a failed answer (BR) was offered; F-1 lists measured (completed) answers only";
// S1-N1 (sync S1, temporary). The legacy emptied its hidden standard country list (hmg-geo #302
// b60fa40, lib/scope/hidden-regions.ts), so ID is offered again; this backend model keeps ID
// hidden (HIDDEN_STANDARD) as the backend does until BE-2 (app.hidden_market ('global','ID')
// removed in unit BE-A: the stg fix SQL and the seed without the row). Release: when BE-2
// is on the branch this test runs against, empty HIDDEN_STANDARD and drop HIDDEN_ID from CASES.
const HIDDEN_ID = "S1-N1: the legacy offers ID again (hmg-geo #302 emptied the hidden standard list); the backend hides ID until BE-2";
const BRANDLESS =
  "a root catalog prompt without brand (NULL, not the umbrella) is a common row (brand null) in F-1 and stays under a brand choice; the legacy brand narrowing (brand IN (<brands>, HMG)) dropped it";
const CASES: Case[] = [
  {
    name: "admin, no brand",
    scope: { all: true },
    url: {},
    known: [
      { list: "regions", value: "BR", reason: FAILED_ONLY },
      { list: "regions", value: "ID", reason: HIDDEN_ID },
      { list: "matrix", value: "Kia|ID|en", reason: HIDDEN_ID },
    ],
  },
  {
    name: "admin, brand=Kia",
    scope: { all: true },
    url: { brand: "Kia" },
    known: [
      { list: "regions", value: "BR", reason: FAILED_ONLY },
      { list: "regions", value: "FR", reason: BRANDLESS },
      { list: "languages", value: "fr", reason: BRANDLESS },
      { list: "regions", value: "ID", reason: HIDDEN_ID },
      { list: "matrix", value: "Kia|ID|en", reason: HIDDEN_ID },
    ],
  },
  {
    name: "Hyundai account, countries US KR JP",
    scope: { all: false, brands: ["Hyundai"], countries: ["US", "KR", "JP"] },
    url: {},
    known: [],
  },
];

function symDiff(a: readonly string[], b: readonly string[]): string[] {
  const sa = new Set(a);
  const sb = new Set(b);
  return [...new Set([...a, ...b])].filter((x) => sa.has(x) !== sb.has(x)).sort();
}

describe("legacy/api parity: filter options (dashboard composition)", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const filters = readStandardFilters({ ...c.url, time: `${WINDOW.dateFrom}..${WINDOW.dateTo}` }, c.scope);
    // legacy: dashboard/page.tsx OverviewFiltersSection arguments
    const optionScope = narrowScopeBrands(c.scope, filters.brand);
    const dateRange = { dateFrom: filters.dateFrom, dateTo: filters.dateTo };
    const [catalog, regions, languages, matrix] = await Promise.all([
      listCatalogTaxonomy(),
      listMeasuredRegions(optionScope, undefined, true, dateRange),
      listMeasuredStandardLanguages(optionScope, undefined, dateRange),
      listMeasuredScopeMatrix(c.scope, dateRange),
    ]);
    // api
    const api = F.toPanelOptions(
      { data: backendOptions(c.scope), meta: { mode: "cumulative" } },
      { surface: "global", scope: c.scope, filters },
    );
    const key = (r: { brand: string | null; region: string; lang: string | null }) => `${r.brand}|${r.region}|${r.lang}`;
    const got: Record<Case["known"][number]["list"], string[]> = {
      regions: symDiff(regions, api.geographyOptions),
      languages: symDiff(languages, api.languageOptions ?? []),
      matrix: symDiff(matrix.map(key), (api.optionMatrix ?? []).map(key)),
      catalog: symDiff(catalog.map((r) => JSON.stringify(r)), (api.catalogRows ?? []).map((r) => JSON.stringify(r))),
    };
    for (const list of Object.keys(got) as (keyof typeof got)[]) {
      const declared = c.known.filter((k) => k.list === list).map((k) => k.value).sort();
      expect(got[list], `${list}: differences must equal KNOWN_DIFF`).toEqual(declared);
    }
    // order: the adapter keeps the legacy orders (regions/languages sorted, matrix region/lang/brand)
    expect(api.geographyOptions).toEqual([...api.geographyOptions].sort());
    expect((api.optionMatrix ?? []).map(key)).toEqual(
      matrix.filter((r) => (api.optionMatrix ?? []).some((x) => key(x) === key(r))).map(key),
    );
  });

  it("catalog rows keep the legacy ORDER BY list_type, depth1, depth2, depth3", async () => {
    const legacy = await listCatalogTaxonomy();
    const api = F.toCatalogRows(backendOptions({ all: true }).catalog)!;
    const sortKey = (r: { listType: string | null; depth1: string | null; depth2: string | null; depth3: string | null }) =>
      [r.listType, r.depth1, r.depth2, r.depth3].map((x) => x ?? "￿").join("\u0000");
    expect(api.map(sortKey)).toEqual(legacy.map(sortKey));
    expect(api).toHaveLength(5); // P1..P5 (P6 deleted, P7 other project); funnel dropped, no duplicates
  });
});
