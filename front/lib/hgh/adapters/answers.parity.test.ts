import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";

// Legacy <-> API parity of the answer modal body (unit U6, AN-2).
//
// Method. One WORLD (an answer, its mention rows including an HMG alias entity and model rows
// rolled up to their brands, its citations) is written twice:
//   legacy: mirror rows on PGlite (real PostgreSQL), read by the UNCHANGED legacy reader the
//           answer route ends in (getMirrorAnswerBody, AGG:7867) with the modal's filters;
//   api:    a backend model of GET /v1/answers/{job_id} built from the same WORLD with the
//           documented AN-2 semantics (brands by canonical display name with the perspective's own
//           flag, non-brand entities under their rollup brand, citations by ord with the category
//           slug), converted by lib/hgh/adapters/answers.ts toMirrorAnswerDetail.
// The outputs are diffed; differing paths must equal KNOWN_DIFF (each with its reason). The
// occurrence (sentiment) and stance tables are absent on both sides here (their conversions are
// hand-checked in answers.test.ts), so neither side carries those keys.
//
// Access gate (backlog B003): the same modal URL (readStandardFilters with the account scope, as the
// route does) goes to both sides. Legacy: getMirrorAnswerBody's IDOR gate (global: region IN f.region
// and prompts.brand IN f.brand; website: the route's region -> websiteCountry remap and withWebsite's
// narrowScopeBrands -> site project ids -> run gate). API: loadAnswerDetail's request against a
// backend model of the documented optional gates (gate_country / gate_brand intersected with the
// account scope, values outside it dropped; a job outside -> 404).

const st = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => st.db }));
// Run visibility (hidden bulk-mirror runs) is outside the modal semantics compared here.
vi.mock("@/lib/db/repositories/scope-mirror-progress-read", async () => {
  const { sql } = await import("drizzle-orm");
  return { bulkMirrorRunVisibleSql: async () => sql`true`, bulkMirrorRunVisibleSqlKnown: () => sql`true` };
});

const { setAnchorAxisForTests, resetAnchorAxisForTests } = await import("@/lib/period/anchor-axis-state");
const { SYNC_PROBED_COLUMNS, setColumnAvailabilityForTests, resetColumnAvailabilityForTests } = await import(
  "@/lib/db/column-availability"
);
const { getMirrorAnswerBody } = await import("@/lib/db/repositories/scope-aggregates");
const { HMG_BRAND_ENTITY_IDS, HMG_BRAND_ALIAS_ENTITY_IDS, narrowScopeBrands } = await import("@/lib/scope/hmg-brands");
const { CITATION_CATEGORY_SLUGS } = await import("@/lib/citation-categorizer/taxonomy");
const { readStandardFilters } = await import("@/components/dash/standard-filters");
const { bindHghAuth } = await import("../auth");
const A = await import("./answers");

type S = components["schemas"];
type Pg = { exec(q: string): Promise<unknown>; close(): Promise<void> };

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const JOB = u(0x10);
const RUN = u(0x20);
const PROMPT = u(0x30);
// Website sites (scope projects) by brand; the answer's run belongs to the Hyundai site.
const SITES = [
  { id: u(0x61), brand: "Hyundai" },
  { id: u(0x62), brand: "Kia" },
];
const ANSWER_COUNTRY = "US"; // scope_answers.region / the backend answer geo
const PROMPT_BRAND = "Hyundai"; // prompts.brand / the backend catalog brand of the prompt (bgrp)
const SITE_BRAND = "Hyundai"; // the brand of the answer's site
const TOYOTA = u(0x41);
const BMW = u(0x42);
const HYUNDAI = HMG_BRAND_ENTITY_IDS.Hyundai;
const HYUNDAI_ALIAS = HMG_BRAND_ALIAS_ENTITY_IDS.Hyundai[0];
const TEXT = "Hyundai Ioniq 5 beats the Toyota bZ4X; 현대자동차 leads, BMW follows.";

// ── WORLD ───────────────────────────────────────────────────────────────────

interface Mention {
  entity: string;
  name: string;
  type: "Brand" | "Product";
  count: number;
  rollup: string | null;
}
const MENTIONS: Mention[] = [
  { entity: HYUNDAI, name: "Hyundai", type: "Brand", count: 3, rollup: HYUNDAI },
  { entity: HYUNDAI_ALIAS, name: "현대자동차", type: "Brand", count: 1, rollup: HYUNDAI_ALIAS },
  { entity: TOYOTA, name: "Toyota", type: "Brand", count: 2, rollup: TOYOTA },
  { entity: BMW, name: "BMW", type: "Brand", count: 1, rollup: BMW },
  { entity: u(0x51), name: "Ioniq 5", type: "Product", count: 5, rollup: HYUNDAI },
  { entity: u(0x52), name: "bZ4X", type: "Product", count: 1, rollup: TOYOTA },
];
const CITATIONS = [
  { ref: 2, url: "https://b.example/x", domain: "b.example", title: null, category: "News & Media" as const },
  { ref: 1, url: "https://hyundai.com/us", domain: "hyundai.com", title: "Hyundai", category: "Official (HMG)" as const },
];
const PERSPECTIVE = ["Hyundai"]; // the modal's brand filter (admin choice / account brand)

const lit = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
const DDL = `
SET TIME ZONE 'UTC';
CREATE TABLE scope_answers (job_id uuid PRIMARY KEY, run_id uuid, prompt_id uuid, target text, region text, status text,
  measured_at timestamptz, model_slug text, answer_text text);
CREATE TABLE scope_mentions (job_id uuid, entity_id uuid, brand text, entity_type text, mention_count int,
  sentiment_positive int DEFAULT 0, sentiment_neutral int DEFAULT 0, sentiment_negative int DEFAULT 0, sentiment_mixed int DEFAULT 0,
  avg_position real, surfaces text[], brand_rollup_entity_id uuid, type_mention int DEFAULT 0, type_recommendation int DEFAULT 0,
  type_comparison int DEFAULT 0, type_definition int DEFAULT 0, type_final_choice int DEFAULT 0);
CREATE TABLE scope_citations (id bigserial PRIMARY KEY, job_id uuid, ref_index int, url text, domain text, title text,
  category text, url_norm text, url_host text, url_base_norm text);
CREATE TABLE prompts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, scope_prompt_id uuid, brand text);
CREATE TABLE scope_runs (run_id uuid PRIMARY KEY, project_id uuid);
`;
function inserts(): string {
  const rows = [
    `INSERT INTO scope_answers VALUES (${lit(JOB)}, ${lit(RUN)}, ${lit(PROMPT)}, 'chatgpt', ${lit(ANSWER_COUNTRY)}, 'completed', '2026-09-14T03:00:00Z', NULL, ${lit(TEXT)});`,
    `INSERT INTO prompts (scope_prompt_id, brand) VALUES (${lit(PROMPT)}, ${lit(PROMPT_BRAND)});`,
    `INSERT INTO scope_runs VALUES (${lit(RUN)}, ${lit(SITES.find((s) => s.brand === SITE_BRAND)!.id)});`,
  ];
  for (const m of MENTIONS) {
    rows.push(
      `INSERT INTO scope_mentions (job_id, entity_id, brand, entity_type, mention_count, brand_rollup_entity_id) VALUES (${lit(JOB)}, ${lit(m.entity)}, ${lit(m.name)}, ${lit(m.type)}, ${m.count}, ${lit(m.rollup)});`,
    );
  }
  for (const c of CITATIONS) {
    rows.push(
      `INSERT INTO scope_citations (job_id, ref_index, url, domain, title, category) VALUES (${lit(JOB)}, ${c.ref}, ${lit(c.url)}, ${lit(c.domain)}, ${lit(c.title)}, ${lit(c.category)});`,
    );
  }
  return rows.join("\n");
}

// ── backend model: GET /v1/answers/{job_id} (AN-2) ──────────────────────────

/** Canonical display name of a brand row (backend rd.dim_brand_name rollup of the HMG aliases). */
function canonical(m: Mention): string {
  return m.entity === HYUNDAI_ALIAS ? "Hyundai" : m.name;
}
function backendDetail(): S["AnswerDetail"] {
  const brands = new Map<string, { count: number; own: boolean }>();
  for (const m of MENTIONS.filter((x) => x.type === "Brand")) {
    const name = canonical(m);
    const cur = brands.get(name) ?? { count: 0, own: PERSPECTIVE.includes(name) };
    cur.count += m.count;
    brands.set(name, cur);
  }
  const brandName = new Map(MENTIONS.filter((m) => m.type === "Brand").map((m) => [m.entity, canonical(m)]));
  return {
    id: JOB,
    body: { available: true, answer_text: TEXT },
    header: {
      acr_iter_rank: 0,
      analysis_state: 1,
      anchor_date: "2026-09-14",
      country: "US",
      cycle_id: "c1",
      engine: "chatgpt",
      gap: false,
      is_acr: false,
      is_rep: true,
      lang: "en",
      measured_at: "2026-09-14T03:00:00+00:00",
      model_slug: null,
      prompt: { funnel: null, kind: "catalog", prompt_id: PROMPT, text: null },
      round_date: "2026-09-14",
      surface: "global",
    },
    citations: CITATIONS.map((c) => ({
      ord: c.ref,
      url: c.url,
      domain: c.domain,
      title: c.title,
      category: CITATION_CATEGORY_SLUGS[c.category],
      owned: c.domain === "hyundai.com",
      target_hit: false,
    })),
    mentions: {
      brands: [...brands].map(([name, v], i) => ({ name, mention_count: v.count, own: v.own, rank: i + 1 })),
      models: MENTIONS.filter((m) => m.type !== "Brand").map((m) => ({
        name: m.name,
        mention_count: m.count,
        parent_brand: m.rollup ? (brandName.get(m.rollup) ?? null) : null,
        avg_position: null,
      })),
    },
    sentiment: { spans: [], skipped: 0 },
    stances: [],
  } as S["AnswerDetail"];
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
  st.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") return async (q: unknown) => (await target.execute(q as never)).rows;
      return Reflect.get(target, prop, receiver);
    },
  });
  setAnchorAxisForTests(false);
  for (const [t, c] of SYNC_PROBED_COLUMNS) setColumnAvailabilityForTests(t, c, false);
}, 60_000);
afterAll(async () => {
  resetAnchorAxisForTests();
  resetColumnAvailabilityForTests();
  await pg?.close();
});

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

const KNOWN_DIFF = [
  { path: /^citations\.\d+\.category$/, reason: "U6-N7 category slug (API) vs scope classifier label (legacy); the modal does not read it" },
];

describe("answer modal body: legacy getMirrorAnswerBody vs AN-2 through the adapter", () => {
  it("same body, mentions (alias folded, own flag), models under their brand, citations by ref order", async () => {
    const legacy = await getMirrorAnswerBody(JOB, { brand: PERSPECTIVE });
    const api = A.toMirrorAnswerDetail(backendDetail());
    // sanity: the legacy reader really read the WORLD
    expect(legacy.available).toBe(true);
    expect(legacy.brandMentions?.[0]).toEqual({ name: "Hyundai", count: 4, tracked: true });
    const d = diff(legacy, api);
    for (const p of d) expect(KNOWN_DIFF.some((k) => k.path.test(p)), `undeclared difference ${p}`).toBe(true);
    for (const k of KNOWN_DIFF) expect(d.some((p) => k.path.test(p)), `declared difference ${k.path} disappeared`).toBe(true);
  });
  it("a job the reader does not have: both sides {available: false}", async () => {
    const legacy = await getMirrorAnswerBody(u(0x99), { brand: PERSPECTIVE });
    const api = A.toMirrorAnswerDetail({ ...backendDetail(), body: { available: false, answer_text: null } });
    expect(api).toEqual(legacy);
  });
});

// ── access gate by the modal's URL filters (B003) ───────────────────────────

type Scope = import("@/lib/auth/types").AllowedScope;
type Sp = Record<string, string | string[]>;
const ADMIN: Scope = { all: true };
const HYUNDAI_US: Scope = { all: false, brands: ["Hyundai"], countries: ["US"] };

/** Legacy global: fetchStandardAnswerBody -> getMirrorAnswerBody with the route's filters. */
async function legacyGlobal(sp: Sp, scope: Scope) {
  return getMirrorAnswerBody(JOB, readStandardFilters(sp, scope, undefined, "standard"));
}
// Project: the route reads the project URL without the profile scope and fetchProjectAnswerBody gates on the project's runs
// (getMirrorAnswerBody runProjectIds, which replaces the brand gate) and region IN f.region. The answer's run belongs to RUN_PROJECT
// (the project's Scope id); the API side is called with the hub project id the route gated on (PROJECT_ID = the answer's project).
const RUN_PROJECT = SITES.find((s) => s.brand === SITE_BRAND)!.id;
const PROJECT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
/** Legacy project: fetchProjectAnswerBody -> withProject (contextBrand = the project brand) -> getMirrorAnswerBody run gate. */
async function legacyProject(sp: Sp) {
  const f = readStandardFilters(sp, undefined, undefined, "standard");
  return getMirrorAnswerBody(JOB, { ...f, contextBrand: PERSPECTIVE }, { runProjectIds: RUN_PROJECT });
}
/** Legacy website: the route's region -> websiteCountry remap, then withWebsite (narrowScopeBrands -> site ids -> run gate). */
async function legacyWebsite(sp: Sp, scope: Scope) {
  const raw = readStandardFilters(sp, scope, undefined, "website");
  const f = { ...raw, websiteCountry: raw.region, region: undefined };
  const eff = narrowScopeBrands(scope, f.brand);
  const ids = SITES.filter((s) => eff.all || (eff.brands ?? []).includes(s.brand)).map((s) => s.id);
  if (!ids.length) return { available: false };
  return getMirrorAnswerBody(JOB, { ...f, brand: undefined, contextBrand: eff.all ? undefined : eff.brands }, { runProjectIds: ids });
}

/**
 * Backend model of GET /v1/answers/{job_id} access (back answers/detail service.py): the account scope, then the optional gates
 * intersected with it (resolve_read_context: values outside the scope dropped; brand: all dropped -> the scope; country: all
 * dropped -> nothing). global: answer geo and prompt catalog brand; website: the site brand only (gate_country unused); project: the
 * answer's project (project_id) and the answer geo (gate_country as sent: the project surface does not apply the account country scope).
 */
function backendStatus(q: URLSearchParams, scope: Scope): 200 | 404 {
  const surface = q.get("surface");
  if (surface === "project") {
    if (q.get("project_id") !== PROJECT_ID) return 404;
    if (q.has("gate_country") && !q.getAll("gate_country").includes(ANSWER_COUNTRY)) return 404;
    return 200;
  }
  const scopeBrands = scope.all || !scope.brands?.length ? null : scope.brands;
  const scopeCountries = scope.all || !scope.countries?.length ? null : scope.countries;
  const brand = surface === "website" ? SITE_BRAND : PROMPT_BRAND;
  if (scopeBrands && !scopeBrands.includes(brand)) return 404;
  if (surface === "global" && scopeCountries && !scopeCountries.includes(ANSWER_COUNTRY)) return 404;
  const gateBrand = q.getAll("gate_brand").filter((b) => !scopeBrands || scopeBrands.includes(b));
  if (gateBrand.length && !gateBrand.includes(brand)) return 404;
  if (surface === "global" && q.has("gate_country")) {
    const gateCountry = q.getAll("gate_country").filter((c) => !scopeCountries || scopeCountries.includes(c));
    if (!gateCountry.includes(ANSWER_COUNTRY)) return 404;
  }
  return 200;
}

describe("answer modal access: the URL filters gate both sides alike (B003)", () => {
  let scope: Scope = ADMIN;
  const requests: URL[] = [];
  beforeEach(() => {
    requests.length = 0;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (raw: string) => {
        const url = new URL(String(raw));
        requests.push(url);
        const status = backendStatus(url.searchParams, scope);
        const body = status === 200 ? { data: backendDetail(), meta: { mode: "snapshot" } } : { error: { code: "not_found", message: "x" } };
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function api(sp: Sp, s: Scope, surface: "global" | "website" | "project") {
    scope = s;
    if (surface === "project") {
      // the route: no profile scope on a project (readStandardFilters without it, scope null), projectId = the gated project
      const filters = readStandardFilters(sp, undefined, undefined, "standard");
      return A.loadAnswerDetail({ jobId: JOB, surface, filters, scope: null, projectId: PROJECT_ID });
    }
    const filters = readStandardFilters(sp, s, undefined, surface === "website" ? "website" : "standard");
    return A.loadAnswerDetail({ jobId: JOB, surface, filters, scope: s });
  }
  function same(legacy: unknown, apiOut: unknown, available: boolean) {
    expect((legacy as { available: boolean }).available).toBe(available);
    if (!available) return expect(apiOut).toEqual(legacy);
    const d = diff(legacy, apiOut);
    for (const p of d) expect(KNOWN_DIFF.some((k) => k.path.test(p)), `undeclared difference ${p}`).toBe(true);
  }

  it.each([
    ["admin, no URL filter", {}, ADMIN, true],
    ["admin, URL country = the answer's", { geography: "US" }, ADMIN, true],
    ["admin, URL countries incl. the answer's", { geography: ["DE", "US"] }, ADMIN, true],
    ["admin, URL brand = the prompt's + country", { brand: "Hyundai", geography: "US" }, ADMIN, true],
    ["admin, URL country outside the answer (in scope)", { geography: "DE" }, ADMIN, false],
    ["admin, URL brand outside the prompt (in scope)", { brand: "Kia" }, ADMIN, false],
    ["account, no URL filter (scope injection not sent)", {}, HYUNDAI_US, true],
    ["account, URL country outside the scope (legacy falls back to the scope)", { geography: "DE" }, HYUNDAI_US, true],
    ["account, URL brand under the brand lock (ignored)", { brand: "Kia" }, HYUNDAI_US, true],
  ] as const)("global: %s", async (_name, sp, s, available) => {
    same(await legacyGlobal(sp as Sp, s), await api(sp as Sp, s, "global"), available);
  });

  it.each([
    ["admin, no URL filter", {}, true],
    ["admin, URL brand = the site's", { brand: "Hyundai" }, true],
    ["admin, URL brand outside the site", { brand: "Kia" }, false],
    // 2026-09-04: virtual site countries (worldwide) are not answer countries -> no country gate on either side
    ["admin, virtual site country", { geography: "worldwide" }, true],
    ["admin, virtual site country + the site's brand", { geography: "worldwide", brand: "Hyundai" }, true],
  ] as const)("website: %s", async (_name, sp, available) => {
    same(await legacyWebsite(sp as Sp, ADMIN), await api(sp as Sp, ADMIN, "website"), available);
    expect(requests.at(-1)!.searchParams.has("gate_country")).toBe(false);
  });

  it.each([
    ["no URL filter", {}, true],
    ["URL country = the answer's", { geography: "US" }, true],
    ["URL countries incl. the answer's", { geography: ["DE", "US"] }, true],
    // legacy region IN f.region also gates a project answer (P13d: the API read now sends gate_country on a project)
    ["URL country outside the answer", { geography: "DE" }, false],
    // the run gate replaces the prompt brand gate on a project: a URL brand never gates
    ["URL brand outside the prompt", { brand: "Kia" }, true],
    ["URL brand + country outside the answer", { brand: "Kia", geography: "DE" }, false],
  ] as const)("project: %s", async (_name, sp, available) => {
    same(await legacyProject(sp as Sp), await api(sp as Sp, HYUNDAI_US, "project"), available);
    expect(requests.at(-1)!.searchParams.get("project_id")).toBe(PROJECT_ID);
    expect(requests.at(-1)!.searchParams.has("gate_brand")).toBe(false);
  });
});
