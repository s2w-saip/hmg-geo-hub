import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { CitationsLive } from "@/lib/scope/result-adapter";

// Legacy <-> API parity of the citation screens (unit U7).
//
// Method (drilldown.parity.test.ts / answers.parity.test.ts pattern). One WORLD (root catalog
// prompts, answers over engines and countries, citation rows with stored categories, an owned
// base, an official HMG social account and a plain social host) is written twice:
//   legacy: mirror rows on PGlite (real PostgreSQL), read by the UNCHANGED legacy aggregate the
//           standard screen ends in (aggregateCitationsFromMirror, the body of
//           fetchStandardCitations: filters {cumulative}, root project, owned prefix hyundai.com);
//   api:    a backend model of C-1 GET /v1/citations/domains (+ competitor_sources), C-2
//           /v1/citations/sources, C-3 /v1/citations/prompts and C-1 detail
//           /v1/citations/domains/{skey}, built from the same WORLD with the documented semantics
//           (skey = the citation group key, share = source citations / all citations, coverage =
//           citing answers / answers_den, own = the owned base prefix per citation row, prompt
//           split owned per row), served through fetch to the adapter's loaders
//           (loadCitationsView, loadDomainDrilldown).
// Every differing path must be declared in KNOWN_DIFF with its reason, and every declared
// difference must still occur (so a stale entry fails too). answers_den is modeled as the
// window's answers (legacy sampledAnswers); the backend defines it as the cit_in answers. The
// owned judgement of a citation row is the ported rule (loc_owned = owned base prefix), evaluated
// with the legacy predicate on PGlite (citationOwnedBaseSql + citationOwnedClause); what this
// parity checks is the grain and the sums around it (drilldown.parity.test.ts does the same).

const st = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => st.db }));
// Run visibility (hidden bulk-mirror runs) is outside the citation semantics compared here.
vi.mock("@/lib/db/repositories/scope-mirror-progress-read", async () => {
  const { sql } = await import("drizzle-orm");
  return { bulkMirrorRunVisibleSql: async () => sql`true`, bulkMirrorRunVisibleSqlKnown: () => sql`true` };
});

const { setAnchorAxisForTests, resetAnchorAxisForTests } = await import("@/lib/period/anchor-axis-state");
const { setTrendGridForTests, resetTrendGridForTests } = await import("@/lib/period/trend-grid-flag");
const { SYNC_PROBED_COLUMNS, setColumnAvailabilityForTests, resetColumnAvailabilityForTests } = await import(
  "@/lib/db/column-availability"
);
const { aggregateCitationsFromMirror, aggregateCitationOwnedPromptsFromMirror, citationOwnedBaseSql, citationOwnedClause } = await import(
  "@/lib/db/repositories/scope-aggregates"
);
const { sql } = await import("drizzle-orm");
const { STANDARD_ROOT_PROJECT_ID } = await import("@/lib/db/repositories/standards");
const { citationGroupKey } = await import("@/lib/citation-categorizer/official-social");
const { CITATION_CATEGORIES, CITATION_CATEGORY_SLUGS } = await import("@/lib/citation-categorizer/taxonomy");
const { bindHghAuth } = await import("../auth");
const C = await import("./citations");

type S = components["schemas"];
type Pg = { exec(q: string): Promise<unknown>; close(): Promise<void> };

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ROOT = u(0x1); // SCOPE_ROOT_PROJECT_ID (the mirror runs' project)
const RUN = u(0x2);
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const OWNED_PREFIXES = ["hyundai.com"];

// ── WORLD ───────────────────────────────────────────────────────────────────

const PROMPTS = [
  { id: u(0x30), text: "best EV", funnel: "인지" },
  { id: u(0x31), text: "best SUV", funnel: "고려" },
  { id: u(0x32), text: "family car", funnel: "구매" },
  { id: u(0x33), text: "compact EV", funnel: "인지" }, // cites only a non-owned page of an owned domain (DC-10)
];
// One answer per (prompt, engine, country) cell: the snapshot keeps them all.
const ANSWERS = [
  { job: u(0x10), prompt: u(0x30), engine: "chatgpt", region: "US", hoursAgo: 30 },
  { job: u(0x11), prompt: u(0x30), engine: "gemini", region: "US", hoursAgo: 29 },
  { job: u(0x12), prompt: u(0x30), engine: "chatgpt", region: "KR", hoursAgo: 28 },
  { job: u(0x13), prompt: u(0x31), engine: "chatgpt", region: "US", hoursAgo: 27 },
  { job: u(0x14), prompt: u(0x31), engine: "gemini", region: "US", hoursAgo: 26 },
  { job: u(0x15), prompt: u(0x32), engine: "chatgpt", region: "US", hoursAgo: 25 },
  { job: u(0x16), prompt: u(0x32), engine: "gemini", region: "KR", hoursAgo: 24 }, // no citation
  { job: u(0x17), prompt: u(0x33), engine: "chatgpt", region: "KR", hoursAgo: 23 },
];
interface Cit {
  job: string;
  url: string;
  domain: string;
  title: string | null;
  category: string;
}
const HMG = "Official (HMG)";
const COMP = "Official (Competitor)";
const MEDIA = "Automotive Media";
const FORUM = "Community & Forums";
const SOCIAL = "Social & Video";
const c = (job: string, url: string, domain: string, category: string, title: string | null = null): Cit => ({ job, url, domain, title, category });
const CITS: Cit[] = [
  c(u(0x10), "https://www.hyundai.com/us/en/ioniq5", "hyundai.com", HMG, "IONIQ 5"),
  c(u(0x10), "https://www.toyota.com/bz4x", "toyota.com", COMP, "bZ4X"),
  c(u(0x10), "https://www.caranddriver.com/ev/best", "caranddriver.com", MEDIA, "Best EVs"),
  c(u(0x11), "https://www.caranddriver.com/ev/best", "caranddriver.com", MEDIA, "Best EVs"),
  c(u(0x11), "https://www.toyota.com/bz4x", "toyota.com", COMP),
  c(u(0x11), "https://www.reddit.com/r/cars/1", "reddit.com", FORUM, "r/cars"),
  c(u(0x12), "https://www.hyundai.com/kr/ko/ioniq5", "hyundai.com", HMG),
  c(u(0x12), "https://www.hyundai.com/us/en/ioniq5", "hyundai.com", HMG, "IONIQ 5"),
  c(u(0x13), "https://www.kia.com/us/en/sorento", "kia.com", HMG, "Sorento"), // HMG, not the owned base
  c(u(0x13), "https://www.caranddriver.com/suv/best", "caranddriver.com", MEDIA),
  c(u(0x13), "https://www.instagram.com/hyundai/p/abc", "instagram.com", SOCIAL), // official social key
  c(u(0x14), "https://www.instagram.com/someone/p/xyz", "instagram.com", SOCIAL), // plain host
  c(u(0x14), "https://www.toyota.com/rav4", "toyota.com", COMP, "RAV4"),
  c(u(0x15), "https://www.reddit.com/r/cars/2", "reddit.com", FORUM),
  c(u(0x15), "https://www.hyundai.com/us/en/palisade", "hyundai.com", HMG, "Palisade"),
  c(u(0x17), "https://www.hyundai.com/kr/ko/kona", "hyundai.com", HMG, "KONA"),
];

const NOW = Date.now();
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const lit = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);

const DDL = `
SET TIME ZONE 'UTC';
CREATE TABLE scope_runs (run_id uuid PRIMARY KEY, status text, started_at timestamptz, completed_at timestamptz, total_jobs int,
  synced_at timestamptz DEFAULT now(), project_id uuid, cycle_anchor_at timestamptz);
CREATE TABLE scope_answers (job_id uuid PRIMARY KEY, run_id uuid, prompt_id uuid, target text, region text, status text,
  measured_at timestamptz, model_slug text, answer_text text);
CREATE TABLE scope_citations (id bigserial PRIMARY KEY, job_id uuid, ref_index int, url text, domain text, title text, category text);
CREATE TABLE scope_prompts (prompt_id uuid PRIMARY KEY, text text, funnel_stage text);
CREATE TABLE prompts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, scope_prompt_id uuid, brand text, list_type text,
  depth1 text, depth2 text, depth3 text, funnel_stage text, brand_presence text);
CREATE TABLE citation_domain_overrides (domain text PRIMARY KEY, category text);
`;
function inserts(): string {
  const rows = [`INSERT INTO scope_runs (run_id, status, started_at, project_id) VALUES (${lit(RUN)}, 'completed', ${lit(at(31))}, ${lit(ROOT)});`];
  for (const p of PROMPTS) {
    rows.push(`INSERT INTO scope_prompts VALUES (${lit(p.id)}, ${lit(p.text)}, ${lit(p.funnel)});`);
    rows.push(`INSERT INTO prompts (project_id, scope_prompt_id, brand, funnel_stage) VALUES (${lit(STANDARD_ROOT_PROJECT_ID)}, ${lit(p.id)}, 'Hyundai', ${lit(p.funnel)});`);
  }
  for (const a of ANSWERS) {
    rows.push(
      `INSERT INTO scope_answers VALUES (${lit(a.job)}, ${lit(RUN)}, ${lit(a.prompt)}, ${lit(a.engine)}, ${lit(a.region)}, 'completed', ${lit(at(a.hoursAgo))}, NULL, 'text');`,
    );
  }
  CITS.forEach((x, i) =>
    rows.push(
      `INSERT INTO scope_citations (job_id, ref_index, url, domain, title, category) VALUES (${lit(x.job)}, ${i}, ${lit(x.url)}, ${lit(x.domain)}, ${lit(x.title)}, ${lit(x.category)});`,
    ),
  );
  return rows.join("\n");
}

// ── PGlite ──────────────────────────────────────────────────────────────────

let pg: Pg;
let legacy: CitationsLive | null;
/** ref_index of the citation rows the owned rule marks (evaluated once on PGlite). */
const OWN_ROWS = new Set<number>();
beforeAll(async () => {
  vi.stubEnv("SCOPE_MODE", "live");
  vi.stubEnv("SCOPE_ROOT_PROJECT_ID", ROOT);
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  pg = new PGlite() as unknown as Pg;
  await pg.exec(DDL);
  await pg.exec(inserts());
  // postgres-js returns rows from execute(); drizzle-pglite returns {rows}. Transactions too
  // (withAnswerSet / budgetedMirrorDb run their statements on the transaction object).
  type Exec = { execute(q: never): Promise<{ rows: unknown }>; transaction(fn: (tx: unknown) => unknown, cfg?: unknown): unknown };
  const rowsOnly = <T extends object>(db: T): T =>
    new Proxy(db, {
      get(target, prop, receiver) {
        const t = target as unknown as Exec;
        if (prop === "execute") return async (q: unknown) => (await t.execute(q as never)).rows;
        if (prop === "transaction") return (fn: (tx: unknown) => unknown, cfg?: unknown) => t.transaction((tx) => fn(rowsOnly(tx as object)), cfg);
        return Reflect.get(target, prop, receiver);
      },
    });
  st.db = rowsOnly(drizzle(pg as never));
  setAnchorAxisForTests(false);
  setTrendGridForTests(false);
  for (const [t, col] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, col, false);
  legacy = await aggregateCitationsFromMirror({ cumulative: true }, undefined, OWNED_PREFIXES, undefined, false);
  const own = (await (st.db as { execute(q: unknown): Promise<unknown> }).execute(sql`
    WITH c2 AS (SELECT c.ref_index, lower(c.domain) AS domain, ${citationOwnedBaseSql(OWNED_PREFIXES)} AS base FROM scope_citations c)
    SELECT ref_index, COALESCE(${citationOwnedClause(OWNED_PREFIXES)}, false) AS own FROM c2
  `)) as Array<{ ref_index: number; own: boolean }>;
  for (const r of own) if (r.own) OWN_ROWS.add(r.ref_index);
}, 60_000);
afterAll(async () => {
  resetAnchorAxisForTests();
  resetTrendGridForTests();
  resetColumnAvailabilityForTests();
  vi.unstubAllEnvs();
  await pg?.close();
});

// ── backend model (documented C-1 / C-2 / C-3 semantics) ────────────────────

const ANSWER = new Map(ANSWERS.map((a) => [a.job, a]));
const PROMPT = new Map(PROMPTS.map((p) => [p.id, p]));
const skeyOf = (x: Cit) => citationGroupKey(x.domain, x.url);
/** Owned judgement per citation row (the ported rule; see the header). */
const ownRow = (x: Cit) => OWN_ROWS.has(CITS.indexOf(x));
const catRef = (name: string): S["CategoryRef"] => ({
  category_key: CITATION_CATEGORIES.indexOf(name as (typeof CITATION_CATEGORIES)[number]) + 1,
  name,
  slug: CITATION_CATEGORY_SLUGS[name as keyof typeof CITATION_CATEGORY_SLUGS],
});
const bySkey = () => {
  const m = new Map<string, Cit[]>();
  for (const x of CITS) m.set(skeyOf(x), [...(m.get(skeyOf(x)) ?? []), x]);
  return m;
};
const total = CITS.length;
const answersDen = ANSWERS.length;

function domainRows(): S["DomainRow"][] {
  const rows = [...bySkey()].map(([skey, list]): S["DomainRow"] => {
    const answers = new Set(list.map((x) => x.job));
    const prompts = new Set(list.map((x) => ANSWER.get(x.job)!.prompt));
    const cat = skey.includes("/") ? HMG : list[0].category; // official social keys are Official (HMG)
    return {
      skey,
      domain: skey.split("/")[0],
      is_social: skey.includes("/"),
      category: catRef(cat),
      citations: list.length,
      share: { num: list.length, den: total },
      citing_answers: answers.size,
      citing_prompts: prompts.size,
      coverage: { num: answers.size, den: answersDen },
      is_own: list.some(ownRow),
      is_target: false,
      own_citations: list.filter(ownRow).length,
      competitor_brand: cat === COMP ? "Toyota" : null,
    };
  });
  rows.sort((a, b) => b.citations - a.citations || (a.skey < b.skey ? -1 : a.skey > b.skey ? 1 : 0));
  return rows.map((r, i) => ({ ...r, rank: i + 1, match_rank: i + 1 }));
}
function domainsData(): S["DomainsData"] {
  const items = domainRows();
  return {
    summary: {
      total_citations: total,
      unique_sources: items.length,
      own_share: { num: CITS.filter(ownRow).length, den: total },
      answers_den: answersDen,
    },
    items,
    competitor_totals: [{ brand: "Toyota", citations: 3, sources: 1 }],
    competitor_sources: items.filter((r) => r.category?.name === COMP).map((r) => ({ skey: r.skey, domain: r.domain, citations: r.citations, brand: "Toyota" })),
  };
}
function sourcesData(): S["SourcesData"] {
  const cats = new Map<string, number>();
  const eng = new Map<string, Map<number, number>>();
  for (const [skey, list] of bySkey()) {
    for (const x of list) {
      const cat = skey.includes("/") ? HMG : x.category;
      cats.set(cat, (cats.get(cat) ?? 0) + 1);
      const e = ANSWER.get(x.job)!.engine;
      const m = eng.get(e) ?? new Map<number, number>();
      m.set(catRef(cat).category_key, (m.get(catRef(cat).category_key) ?? 0) + 1);
      eng.set(e, m);
    }
  }
  const zero = { urls: 0, citations: 0, answers: 0 };
  return {
    total_citations: total,
    categories: [...cats]
      .sort((a, b) => b[1] - a[1] || catRef(a[0]).category_key - catRef(b[0]).category_key)
      .map(([name, n]) => ({ category: catRef(name), citations: n, share: { num: n, den: total } })),
    by_engine: [...eng].map(([engine, m]) => ({
      engine,
      total: [...m.values()].reduce((s, v) => s + v, 0),
      categories: [...m].map(([category_key, citations]) => ({ category_key, citations })),
    })),
    tone: { positive: zero, negative: zero },
    types: [],
  };
}
function promptsData(owned: boolean, limit: number): S["CitationPromptsData"] {
  const byPrompt = new Map<string, Cit[]>();
  for (const x of CITS) {
    const p = ANSWER.get(x.job)!.prompt;
    byPrompt.set(p, [...(byPrompt.get(p) ?? []), x]);
  }
  const rows = [...byPrompt].map(([pid, list]) => ({ pid, list, own: list.some(ownRow) }));
  const pick = rows.filter((r) => r.own === owned).sort((a, b) => b.list.length - a.list.length || (a.pid < b.pid ? -1 : 1));
  return {
    counts: { owned: rows.filter((r) => r.own).length, uncited: rows.filter((r) => !r.own).length },
    items: pick.slice(0, limit).map((r) => ({
      prompt_id: r.pid,
      text: PROMPT.get(r.pid)!.text,
      funnel: PROMPT.get(r.pid)!.funnel,
      citations: r.list.length,
      providers: [...new Set(r.list.map((x) => ANSWER.get(x.job)!.engine))].sort(),
      answers: [...new Set(r.list.map((x) => x.job))]
        .map((job) => ({ job, n: r.list.filter((x) => x.job === job).length }))
        .sort((a, b) => b.n - a.n || (a.job < b.job ? -1 : 1))
        .slice(0, 8)
        .map(({ job, n }) => ({ job_id: job, provider: ANSWER.get(job)!.engine, region: ANSWER.get(job)!.region, citations_in_answer: n })),
    })),
  };
}
function detailData(skey: string): S["DomainDetailData"] {
  const list = bySkey().get(skey)!;
  const byUrl = new Map<string, Cit[]>();
  for (const x of list) byUrl.set(x.url, [...(byUrl.get(x.url) ?? []), x]);
  const firstOf = (xs: Cit[]) => [...xs].sort((a, b) => ANSWER.get(b.job)!.hoursAgo - ANSWER.get(a.job)!.hoursAgo)[0];
  const byPrompt = new Map<string, Cit[]>();
  for (const x of list) {
    const p = ANSWER.get(x.job)!.prompt;
    byPrompt.set(p, [...(byPrompt.get(p) ?? []), x]);
  }
  const cat = skey.includes("/") ? HMG : list[0].category;
  return {
    source: { skey, domain: skey.split("/")[0], is_social: skey.includes("/"), category: catRef(cat), competitor_brand: null },
    citations: list.length,
    own_citations: list.filter(ownRow).length,
    url_total: byUrl.size,
    prompt_total: byPrompt.size,
    // backend order: citations desc, then url_hash (not the url); simulated with the reversed url
    urls: [...byUrl]
      .sort((a, b) => b[1].length - a[1].length || ([...a[0]].reverse().join("") < [...b[0]].reverse().join("") ? -1 : 1))
      .map(([url, xs]) => ({
      url,
      title: firstOf(xs).title,
      citations: xs.length,
      engines: [...new Set(xs.map((x) => ANSWER.get(x.job)!.engine))].sort(),
      prompt_text: PROMPT.get(ANSWER.get(firstOf(xs).job)!.prompt)!.text,
      country: null,
    })),
    prompts: [...byPrompt].map(([pid, xs]) => {
      const perJob = new Map<string, number>();
      for (const x of xs) perJob.set(x.job, (perJob.get(x.job) ?? 0) + 1);
      return {
        prompt_id: pid,
        text: PROMPT.get(pid)!.text,
        funnel: PROMPT.get(pid)!.funnel,
        citations: xs.length,
        own_citations: xs.filter(ownRow).length,
        engines: [...new Set(xs.map((x) => ANSWER.get(x.job)!.engine))].sort(),
        answers: [...perJob]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([job, n]) => ({ job_id: job, engine: ANSWER.get(job)!.engine, country: ANSWER.get(job)!.region, citations: n })),
      };
    }),
  };
}

const META: S["Meta"] = { mode: "snapshot", as_of: "2026-09-21", cycles: ["2026-09-21"], page: { limit: 200, next_cursor: null, total: null } };
const json = (data: unknown, meta: S["Meta"] = META) =>
  new Response(JSON.stringify({ data, meta }), { status: 200, headers: { "content-type": "application/json" } });

function serve(url: string): Response {
  const x = new URL(url);
  const q = x.searchParams;
  if (x.pathname === "/v1/citations/domains") return json(domainsData(), { ...META, page: { limit: Number(q.get("limit")), next_cursor: null, total: domainRows().length } });
  if (x.pathname.startsWith("/v1/citations/domains/")) return json(detailData(decodeURIComponent(x.pathname.slice("/v1/citations/domains/".length))));
  if (x.pathname === "/v1/citations/sources") return json(sourcesData());
  if (x.pathname === "/v1/citations/prompts") {
    const d = promptsData(q.get("owned") === "true", Number(q.get("limit")));
    const all = promptsData(q.get("owned") === "true", 1000).items.length;
    return json(d, { ...META, page: { limit: Number(q.get("limit")), next_cursor: null, total: all } });
  }
  if (x.pathname === "/v1/trend") return json({ bucket: "cycle", dimension: q.get("dimension") ?? "none", own_label: "HMG", buckets: [], series: [] });
  if (x.pathname === "/v1/filters/dates") return json({ dates: ["2026-09-21"], first_measured_date: "2026-09-01", latest_round_date: "2026-09-21", presets: [], dates_truncated: false });
  if (x.pathname === "/v1/kpi/summary") return json({});
  return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
}

async function withBackend<T>(run: () => Promise<T>): Promise<T> {
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => serve(String(input))));
  try {
    return await run();
  } finally {
    bindHghAuth(null);
    vi.unstubAllGlobals();
    vi.stubEnv("HGH_API_BASE_URL", "");
  }
}

// ── comparison ──────────────────────────────────────────────────────────────

/** Leaf paths where the two sides differ. */
function diffPaths(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return [path || "<root>"];
  if (Array.isArray(a) !== Array.isArray(b)) return [path];
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  return [...keys].flatMap((k) =>
    diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k),
  );
}

/** Declared differences (path pattern -> reason). */
const KNOWN_DIFF: Record<string, string> = {
  asOf: "U7-N1: legacy = the cycle anchor text of the answer set, api = meta.as_of round date",
  "domains[].urls": "U7-N2 / 3.5 #6: rows carry no drilldown; it loads when the row opens (compared below)",
  "domains[].promptList": "U7-N2 / 3.5 #6: same as urls",
  "domains[].skey": "api rows keep the source key for the drilldown route (legacy rows have none)",
  "domains[].rank": "BG-21: api rows carry the backend rank ('#'); the legacy table numbers rows on the client",
  "domains[].matchRank": "BG-21: same as rank (search rank)",
  "promptSplit.owned": "the standard screen reads only the split counts (limit 1); the list rows are the website/project cards",
  "promptSplit.uncited": "same as promptSplit.owned",
  trend: "not modeled here (DC-08 series rule; toCitationTrend is unit-tested)",
  categoryTrend: "not modeled here (DC-08; unit-tested)",
};
const norm = (p: string) => p.replace(/\.\d+(?=\.|$)/g, "[]");
const matchDeclared = (p: string) => Object.keys(KNOWN_DIFF).find((k) => norm(p) === k || norm(p).startsWith(`${k}.`) || norm(p).startsWith(`${k}[]`));

describe("standard citations: legacy aggregateCitationsFromMirror (PGlite) vs loadCitationsView (backend model)", () => {
  it("the legacy side really ran on the WORLD (sanity)", () => {
    expect(legacy).not.toBeNull();
    expect(legacy!.summary.total).toBe(CITS.length);
    // the official social account is its own row (group key host+path)
    expect(legacy!.domains.map((d) => d.domain)).toContain("instagram.com/hyundai");
  });

  it("every value is equal except the declared differences, and every declared difference occurs", async () => {
    const view = await withBackend(() => C.loadCitationsView({ cumulative: true }, { surface: "global", scope: null }));
    const api = view.live!;
    const diffs = diffPaths(legacy, api);
    const undeclared = diffs.filter((p) => !matchDeclared(p));
    expect(undeclared).toEqual([]);
    const seen = new Set(diffs.map((p) => matchDeclared(p)));
    const declaredButEqual = Object.keys(KNOWN_DIFF).filter((k) => !seen.has(k));
    // trend / categoryTrend: legacy aggregate leaves them null with the grid off, the model gives no buckets -> equal
    expect(declaredButEqual.filter((k) => k !== "trend" && k !== "categoryTrend")).toEqual([]);
  });

  it("hand check of the compared values (not just equal: the expected numbers)", async () => {
    const view = await withBackend(() => C.loadCitationsView({ cumulative: true }, { surface: "global", scope: null }));
    const api = view.live!;
    // 16 citations in 7 sources; owned rows (the rule on PGlite): 3 -> 3/16 = 0.1875 -> 187.5 -> 188 -> 18.8
    // (the rule marks the three /us/ pages; the /kr/ko page is not owned under this prefix list)
    expect([...OWN_ROWS].sort((a, b) => a - b)).toEqual([0, 7, 14]);
    expect(api.summary).toEqual({ total: 16, uniqueDomains: 7, officialOwnShare: 18.8 });
    // hyundai.com 5 cites in 4 answers of 8 -> share 5/16 = 312.5 -> 313 -> 31.3, coverage 4/8 = 50,
    // 3 prompts, own (3 rows)
    const hy = api.domains.find((d) => d.domain === "hyundai.com")!;
    expect([hy.citations, hy.share, hy.coverageRate, hy.prompts, hy.isOurs, hy.category]).toEqual([5, 31.3, 50, 3, true, HMG]);
    const legacyHy = legacy!.domains.find((d) => d.domain === "hyundai.com")!;
    expect([legacyHy.citations, legacyHy.share, legacyHy.coverageRate, legacyHy.prompts, legacyHy.isOurs]).toEqual([5, 31.3, 50, 3, true]);
    // order: citations desc, then the key (caranddriver 3, hyundai 4 -> hyundai first)
    expect(api.domains.map((d) => d.domain)).toEqual(legacy!.domains.map((d) => d.domain));
    // split counts: prompts 30 and 32 have an owned row -> owned 2; 31 and 33 (the KR page only) uncited 2
    expect([api.promptSplit?.ownedCount, api.promptSplit?.uncitedCount]).toEqual([2, 2]);
    expect(view.competitorOptions).toEqual(["toyota.com"]);
  });

  it("prompt split rows (website/project cards): toPromptSplit of C-3 owned / uncited equals the legacy split lists", async () => {
    const [owned, uncited] = await withBackend(() =>
      Promise.all([
        C.fetchCitationPrompts({ cumulative: true }, { surface: "global", scope: null }, { owned: true, limit: C.SPLIT_CARD_ROWS }),
        C.fetchCitationPrompts({ cumulative: true }, { surface: "global", scope: null }, { owned: false, limit: C.SPLIT_CARD_ROWS }),
      ]),
    );
    const api = C.toPromptSplit(owned.data, uncited.data)!;
    const l = legacy!.promptSplit!;
    // legacy lists hold up to 20 rows; the cards show five (PromptBucketCard), the API asks for five
    expect(api).toEqual({
      owned: l.owned.slice(0, C.SPLIT_CARD_ROWS),
      uncited: l.uncited.slice(0, C.SPLIT_CARD_ROWS),
      ownedCount: l.ownedCount,
      uncitedCount: l.uncitedCount,
    });
    // hand check: prompt 30 has 8 citations over 3 answers (J12 has 3), prompt 32 has 2
    expect(api.owned.map((p) => [p.promptText, p.citations, p.answers.map((a) => a.mentionCount)])).toEqual([
      ["best EV", 8, [3, 3, 2]],
      ["family car", 2, [2]],
    ]);
  });

  it("prompts sub page: loadOwnedPromptPage vs aggregateCitationOwnedPromptsFromMirror, DC-10 the only difference", async () => {
    const f = { cumulative: true };
    const ctx = { surface: "global" as const, scope: null };
    const legacyTab = async (owned: boolean) =>
      aggregateCitationOwnedPromptsFromMirror(f, undefined, OWNED_PREFIXES, { owned, page: 1, pageSize: 50, q: "" });
    const apiTab = (owned: boolean) => withBackend(() => C.loadOwnedPromptPage(f, ctx, { owned, q: "", page: 1, cursor: null }));
    const [lo, lu, ao, au] = await Promise.all([legacyTab(true), legacyTab(false), apiTab(true), apiTab(false)]);
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
    // DC-10: legacy owned = the prompt cited a domain that is owned somewhere (domain grain), so
    // "compact EV" (only the non-owned KR page of hyundai.com) is owned there; the API judges per
    // citation row, so it is uncited. Every other row is equal field by field.
    expect(ids(lo.rows)).toEqual([u(0x30), u(0x32), u(0x33)]);
    expect(ids(ao.page!.rows)).toEqual([u(0x30), u(0x32)]);
    expect(ids(lu.rows)).toEqual([u(0x31)]);
    expect(ids(au.page!.rows)).toEqual([u(0x31), u(0x33)]);
    const byId = (rows: { id: string }[]) => new Map(rows.map((r) => [r.id, r]));
    const lAll = byId([...lo.rows, ...lu.rows]);
    for (const r of [...ao.page!.rows, ...au.page!.rows]) {
      const l = lAll.get(r.id)!;
      expect({ ...r, answers: r.answers.map((a) => a.jobId).sort() }).toEqual({ ...l, answers: l.answers.map((a) => a.jobId).sort() });
    }
    // tab counts come with the rows (legacy: the promptSplit of the main aggregate, row grain)
    expect([ao.ownedCount, ao.uncitedCount]).toEqual([legacy!.promptSplit!.ownedCount, legacy!.promptSplit!.uncitedCount]);
    expect([ao.page!.page, ao.page!.pageSize, ao.page!.nextCursor]).toEqual([1, 50, null]);
  });

  it("drilldown: loadDomainDrilldown equals the legacy inline urls / promptList of the same row", async () => {
    for (const skey of ["hyundai.com", "caranddriver.com", "instagram.com/hyundai"]) {
      const api = await withBackend(() => C.loadDomainDrilldown({ cumulative: true }, { surface: "global", scope: null }, skey));
      const row = legacy!.domains.find((d) => d.domain === skey)!;
      expect(api.urls).toEqual(row.urls);
      expect(api.promptList).toEqual(row.promptList);
    }
  });
});
