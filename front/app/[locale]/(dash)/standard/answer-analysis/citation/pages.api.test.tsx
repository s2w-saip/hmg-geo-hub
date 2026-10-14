import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// The five citation screens on the api source (unit U7: HGH_SOURCE_G2 standard + sub pages,
// G3 website, G6 project): every section is fed by lib/hgh/adapters/citations.ts in the legacy
// prop shapes, no legacy reader runs, the table source and the first page reach the client
// components, and the sub pages page with a URL cursor. Server sections are resolved here, client
// components are not rendered (their props are inspected, promises awaited). The in-request dedupe
// needs the react-server build; the D6 order is asserted in lib/hgh/adapters/citations.test.ts.

const st = vi.hoisted(() => ({ legacy: [] as string[], role: "hq" as string }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("nf");
  },
  redirect: (to: string) => {
    throw new Error(`rd:${to}`);
  },
}));
vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined, getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", email: "x", role: st.role, scope: { all: false, brands: ["Kia"], regions: [], countries: ["US", "KR"] }, operator: "none", menuGroups: null },
  }),
}));
const legacyProxy = () =>
  new Proxy(
    {},
    {
      has: () => true,
      get: (_t, name) =>
        name === "then" || name === "__esModule"
          ? undefined
          : async () => {
              st.legacy.push(String(name));
              return null;
            },
    },
  );
vi.mock("@/lib/scope/server", () => legacyProxy());
vi.mock("@/lib/db/repositories/standards", () => ({ listCatalogTaxonomy: async () => (st.legacy.push("catalog"), []) }));
vi.mock("@/lib/db/repositories/scope-aggregates", () => legacyProxy());
vi.mock("@/lib/db/repositories/website-sites", () => legacyProxy());
vi.mock("@/lib/db/repositories/project-custom-fields", () => ({ projectCustomFieldRepository: legacyProxy() }));
vi.mock("@/lib/period/compare-shape", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, resolveRequestComparePeriodShape: async () => ({ kind: "calendarMonth", days: 31, months: { cur: { lo: "2026-08-01", hi: "2026-08-31" }, prev: { lo: "2026-07-01", hi: "2026-07-31" } } }) };
});
vi.mock("@/app/[locale]/(dash)/projects/[id]/analysis/_lib/auth-and-locks", () => ({
  loadProjectAnalysisContext: async () => ({ locks: [{ group: "geography", value: "US" }], lockedGroups: ["geography"] }),
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const StandardPage = (await import("./page")).default;
const PromptsPage = (await import("./prompts/page")).default;
const TonePage = (await import("./tone-urls/page")).default;
const WebsitePage = (await import("../../../website/answer-analysis/citation/page")).default;
const ProjectPage = (await import("../../../projects/[id]/analysis/citation/page")).default;

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const FIELD = "0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3";
const log: URL[] = [];
const meta = (o: Record<string, unknown> = {}) => ({ mode: "cumulative", as_of: "2026-09-21", cycles: ["2026-09-21"], ...o });
const cat = { category_key: 1, name: "Official (HMG)", slug: "officialHmg" };
const row = { skey: "hyundai.com", domain: "hyundai.com", is_social: false, category: cat, citations: 5, share: { num: 5, den: 10 }, citing_answers: 2, citing_prompts: 2, coverage: { num: 2, den: 4 }, is_own: true, is_target: false, own_citations: 3, competitor_brand: null, rank: 1, match_rank: 1 };

function handler(u: URL): { body: unknown; status?: number } {
  const q = u.searchParams;
  switch (u.pathname) {
    case "/v1/filters/options":
      return {
        body: {
          data: {
            catalog: q.get("surface") === "website" ? null : { rows: [], brand_presence: [], depth1: [], depth2: [], depth3: [], funnel: [], list_type: [] },
            custom_fields: q.get("surface") === "project" ? [{ field_id: FIELD, label: "Tag", values: ["b", "a"] }] : null,
            engines: [{ code: "chatgpt", is_default: true }],
            geo_matrix: [{ brand: "Kia", region: "US", lang: "en" }],
            languages: ["en"],
            regions: [{ code: "US", kind: "iso" }],
            source_categories: [],
          },
          meta: meta(),
        },
      };
    case "/v1/filters/dates":
      return { body: { data: { dates: ["2026-09-21", "2026-09-14"], dates_truncated: false, first_measured_date: "2026-06-01", latest_round_date: "2026-09-21", presets: [] }, meta: meta() } };
    case "/v1/citations/domains":
      return {
        body: {
          data: {
            summary: { total_citations: 10, unique_sources: 1, own_share: { num: 3, den: 10 }, answers_den: 4 },
            items: [row],
            competitor_totals: [],
            competitor_sources: q.get("competitor_sources") ? [{ skey: "toyota.com", domain: "toyota.com", citations: 2, brand: "Toyota" }] : null,
          },
          meta: meta({ page: { limit: 200, next_cursor: "n1", total: 300 } }),
        },
      };
    case "/v1/citations/sources":
      return {
        body: {
          data: {
            total_citations: 10,
            categories: [{ category: cat, citations: 10, share: { num: 10, den: 10 } }],
            by_engine: [{ engine: "chatgpt", total: 10, categories: [{ category_key: 1, citations: 10 }] }],
            tone: { positive: { urls: 3, citations: 4, answers: 2 }, negative: { urls: 1, citations: 1, answers: 1 } },
            types: [],
          },
          meta: meta(),
        },
      };
    case "/v1/citations/prompts":
      return { body: { data: { counts: { owned: 2, uncited: 7 }, items: [] }, meta: meta({ page: { limit: Number(q.get("limit")), next_cursor: "p2", total: 7 } }) } };
    case "/v1/citations/sources/tone":
      return { body: { data: { items: [], counts: { positive: 3, negative: 1 } }, meta: meta({ page: { limit: 50, next_cursor: null, total: 0 } }) } };
    case "/v1/citations/targets":
      return { body: { data: { measured: 40, target: { num: 7, den: 40 }, owned: { num: 11, den: 40 } }, meta: meta({ source: { origin: "live", reason: "no_publication" } }) } };
    case "/v1/trend":
      return { body: { data: { bucket: "cycle", dimension: q.get("dimension"), own_label: "Kia", buckets: [], series: [] }, meta: meta() } };
    case "/v1/kpi/summary":
      // website: url_prompts (DC-02 decision 6) feeds the website URL-rate cards
      return q.get("surface") === "website"
        ? {
            body: {
              data: { params: { answers: 4, applied_prompts: 9, measured_prompts: 8 }, url_prompts: { measured_prompts: 40, target_prompts: 7, owned_prompts: 11 } },
              meta: meta({ surface: "website", source: { url_rates: "live", reason: "no_publication", publications: [] } }),
            },
          }
        : { body: { data: { params: { answers: 4, applied_prompts: 9, measured_prompts: 8 } }, meta: meta() } };
    case "/v1/kpi/compare":
      return { body: { data: [], meta: { ...meta(), compare: { kind: "calendarMonth", windows: null } } } };
    default:
      return { body: { error: { code: "not_found" } }, status: 404 };
  }
}

let override: ((u: URL) => { body: unknown; status?: number } | null) | null = null;
beforeEach(() => {
  st.legacy = [];
  st.role = "hq";
  log.length = 0;
  override = null;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  for (const g of ["G2", "G3", "G6"]) vi.stubEnv(`HGH_SOURCE_${g}`, "api");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const url = new URL(String(u));
      log.push(url);
      const r = override?.(url) ?? handler(url);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SERVER_SECTIONS = new Set([
  "CitationsFilterBar",
  "CitationsBody",
  "CitationsBodyApi",
  "CitationsData",
  "ProjectCitationApi",
]);

/** Walk the tree, resolving the page's own server sections; collect client component props by name. */
async function collect(node: unknown): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const queue: unknown[] = [node];
  while (queue.length) {
    const n = queue.shift();
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (!isValidElement(n)) continue;
    const el = n as ReactElement<Record<string, unknown>>;
    const name = typeof el.type === "string" ? el.type : ((el.type as { name?: string }).name ?? "");
    if (SERVER_SECTIONS.has(name)) {
      queue.push(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
      continue;
    }
    if (name && typeof el.type !== "string") out.set(name, el.props);
    for (const v of Object.values(el.props)) if (isValidElement(v) || Array.isArray(v)) queue.push(v);
    queue.push(el.props.children);
  }
  return out;
}
const args = (sp: Record<string, string>, extra: { id?: string } = {}) => ({
  params: Promise.resolve({ locale: "ko", id: extra.id ?? "" }),
  searchParams: Promise.resolve(sp as Record<string, string | string[] | undefined>),
});
const pathsOf = () => log.map((u) => u.pathname);

describe("standard citation page, api source (G2)", () => {
  it("pill, filter bar and body from the adapters; table source for the client table; no legacy reader", async () => {
    const got = await collect(await StandardPage(args({ geography: "US", competitor: "toyota.com", time: "2026-08-01..2026-08-31" })));
    expect(await (got.get("LastMeasuredPill")!.asOf as Promise<string | null>)).toBe("2026-09-21");
    const bar = got.get("AnalysisFilterBar")!;
    expect(await (bar.competitorOptions as Promise<string[]>)).toEqual(["toyota.com"]);
    expect([bar.latestAnchorDay, bar.selectableDates]).toEqual(["2026-09-21", ["2026-09-14", "2026-09-21"]]);
    // the measurement overview card is gone on both sources (hmg-geo #305, sync S1), and so is
    // the K-1 summary that fed it (FA-3)
    expect(got.has("MeasurementOverviewCard")).toBe(false);
    const view = got.get("CitationsStandardView")!;
    const live = (await view.data) as { summary: unknown; domains: { skey?: string }[] };
    expect(live.summary).toEqual({ total: 10, uniqueDomains: 1, officialOwnShare: 30 });
    expect(live.domains[0].skey).toBe("hyundai.com");
    expect(await view.tableSource).toEqual({ query: "competitor=toyota.com&geography=US&time=2026-08-01..2026-08-31", nextCursor: "n1", total: 300 });
    expect(await view.dataDegraded).toBe(false);
    // P6 B041: the section flags come from the same request-scope labels (none here: every call answered)
    expect(await view.sectionDegraded).toEqual({ data: false, trend: false, categoryTrend: false, split: false });
    expect(await view.officialDelta).toBeNull(); // no trend buckets in this stub
    expect((await view.typeCategories) as unknown[]).toHaveLength(5);
    expect(await view.toneSummary).toEqual({ positive: { urls: 3, citations: 4, answers: 2 }, negative: { urls: 1, citations: 1, answers: 1 } });
    // month comparison line (calendar month): citations_per_answer, the line renders
    expect(got.has("PeriodDeltaLine")).toBe(true); // a calendar month: the line is drawn (legacy rule: any result array)
    const cmp = log.find((u) => u.pathname === "/v1/kpi/compare")!.searchParams;
    expect([cmp.get("kind"), cmp.getAll("metrics")]).toEqual(["calendarMonth", ["citations_per_answer"]]);
    expect(st.legacy).toEqual([]);
    expect(log.some((u) => u.pathname === "/v1/kpi/summary")).toBe(false);
    // the competitor pick reaches the backend with the page filters
    const main = log.find((u) => u.pathname === "/v1/citations/domains" && u.searchParams.get("competitor_sources"))!.searchParams;
    expect([main.getAll("competitor"), main.getAll("country"), main.get("from"), main.get("to")]).toEqual([["toyota.com"], ["US"], "2026-08-01", "2026-08-31"]);
    // P6 B043 / B044 / B046: the table's 100 rows, no competitor brand totals; one trend call for both charts
    expect([main.get("limit"), main.get("include_competitor_totals")]).toEqual(["100", "false"]);
    const trends = log.filter((u) => u.pathname === "/v1/trend").map((u) => [u.searchParams.get("dimension"), u.searchParams.getAll("dims")]);
    expect(trends).toEqual(expect.arrayContaining([["source", ["category@13"]], ["none", []]]));
    expect(trends.some(([d]) => d === "category")).toBe(false);
  });

  it("legacy source (default): the legacy readers run, no backend call", async () => {
    vi.stubEnv("HGH_SOURCE_G2", "legacy");
    // the stubbed legacy readers answer null, which some sections dereference: only the calls matter here
    await collect(await StandardPage(args({}))).catch(() => undefined);
    expect(st.legacy).toEqual(expect.arrayContaining(["fetchStandardCitations", "catalog"]));
    expect(log).toEqual([]);
  });

  it("a 401 from the backend redirects to the login page", async () => {
    // The filter bar's calendar read goes through throwForPage (the K-1 overview card that did is gone).
    override = (u) => (u.pathname === "/v1/filters/dates" ? { body: { error: { code: "token_expired" } }, status: 401 } : null);
    const tree = await StandardPage(args({}));
    await expect(collect(tree)).rejects.toThrow("rd:/ko/login");
  });
});

describe("standard sub pages, api source (G2)", () => {
  it("prompts: URL cursor and q forwarded, rows + both tab counts from one call, nextCursor for the pager", async () => {
    const got = await collect(await PromptsPage(args({ tab: "uncited", q: "ev", page: "2", cursor: "p1" })));
    const view = got.get("CitationPromptsPage")!;
    expect([view.tab, view.ownedCount, view.uncitedCount]).toEqual(["uncited", 2, 7]);
    expect(view.page).toMatchObject({ page: 2, pageSize: 50, total: 7, nextCursor: "p2" });
    const q = log[0].searchParams;
    expect([log.length, q.get("owned"), q.get("q"), q.get("cursor"), q.get("limit")]).toEqual([1, "false", "ev", "p1", "50"]);
    // P6 B043: the page draws no funnel / engines (fields=text); the modal's answers stay (include_refs not sent)
    expect([q.get("fields"), q.get("include_refs")]).toEqual(["text", null]);
    expect(st.legacy).toEqual([]);
  });

  it("prompts: a malformed cursor reads the first page (no 422 round trip)", async () => {
    await collect(await PromptsPage(args({ cursor: "../x" })));
    expect(log[0].searchParams.get("cursor")).toBeNull();
  });

  it("tone: with_counts, domain switch -> group_by source, one call", async () => {
    const got = await collect(await TonePage(args({ tone: "negative", by: "domain" })));
    expect(got.get("CitationToneUrlsPage")).toMatchObject({ tone: "negative", byDomain: true, counts: { positive: 3, negative: 1 } });
    expect(pathsOf()).toEqual(["/v1/citations/sources/tone"]);
    expect([log[0].searchParams.get("group_by"), log[0].searchParams.get("with_counts")]).toEqual(["source", "true"]);
  });
});

describe("website citation page, api source (G3)", () => {
  it("filter bar, view and cards from the adapters; site-country axis; table source with surface=website", async () => {
    const got = await collect(await WebsitePage(args({ geography: "US" })));
    const bar = got.get("AnalysisFilterBar")!;
    expect(await (bar.asOf as Promise<string | null>)).toBe("2026-09-21");
    const view = got.get("CitationsView")!;
    expect(view.tableSource).toEqual({ query: "geography=US&surface=website", nextCursor: "n1", total: 300 });
    // DC-02 decision 6: prompt unit from K-1 url_prompts (legacy wording: no `unit`); C-4 is not read
    expect(view.targetHitRate).toEqual({ hitPrompts: 7, ownedPrompts: 11, measuredPrompts: 40, rate: 17.5, ownedRate: 27.5, source: "live" });
    expect(pathsOf()).not.toContain("/v1/citations/targets");
    expect(log.find((u) => u.pathname === "/v1/kpi/summary")!.searchParams.getAll("country")).toEqual(["US"]);
    const d = log.find((u) => u.pathname === "/v1/citations/domains")!.searchParams;
    expect([d.get("surface"), d.getAll("country"), d.get("competitor_sources")]).toEqual(["website", ["US"], null]);
    expect(st.legacy).toEqual([]);
    // P6 B042: the degrade flags reach the view (none here); B043: lighter calls with the same screen values
    expect([view.dataDegraded, view.degradedSections]).toEqual([false, { data: false, trend: false, categoryTrend: false, split: false }]);
    const src = log.find((u) => u.pathname === "/v1/citations/sources")!.searchParams;
    expect([src.get("include_tone"), src.get("include_types"), d.get("limit"), d.get("include_competitor_totals")]).toEqual(["false", "false", "200", "false"]);
    const prompts = log.filter((u) => u.pathname === "/v1/citations/prompts").map((u) => [u.searchParams.get("owned"), u.searchParams.get("limit"), u.searchParams.get("both_buckets")]);
    // one query shape (the same call repeats only because nothing is deduped outside the react-server build)
    expect([...new Set(prompts.map((x) => JSON.stringify(x)))]).toEqual([JSON.stringify(["true", "5", "true"])]);
  });

  it("source category filter: empty cards (prompt unit like the filled card, U7 verification D6), no summary or targets call (legacy page rule)", async () => {
    const got = await collect(await WebsitePage(args({ source: "Official (HMG)" })));
    expect(got.get("CitationsView")!.targetHitRate).toEqual({ hitPrompts: 0, ownedPrompts: 0, measuredPrompts: 0, rate: null, ownedRate: null });
    expect(pathsOf()).not.toContain("/v1/citations/targets");
    expect(pathsOf()).not.toContain("/v1/kpi/summary");
  });
});

describe("project citation page, api source (G6)", () => {
  it("options first (custom fields read the cf_ filter), then the view; project id everywhere; table source with the active cf_ only", async () => {
    const got = await collect(await ProjectPage(args({ [`cf_${FIELD}`]: "a", cf_gone: "x" }, { id: PROJECT })));
    const view = got.get("CitationsView")!;
    expect(view.dynamicAxes).toEqual([{ id: FIELD, label: "Tag", options: ["a", "b"] }]);
    expect(view.engineOptions).toEqual(["chatgpt"]);
    expect(view.selectableDates).toEqual(["2026-09-14", "2026-09-21"]);
    expect(view.tableSource).toEqual({ query: `cf_${FIELD}=a&projectId=${PROJECT}`, nextCursor: "n1", total: 300 });
    expect(pathsOf()[0]).toBe("/v1/filters/options");
    const d = log.find((u) => u.pathname === "/v1/citations/domains")!.searchParams;
    expect([d.get("surface"), d.get("project_id"), d.getAll(`cf.${FIELD}`)]).toEqual(["project", PROJECT, ["a"]]);
    expect(st.legacy).toEqual([]);
    // P6 B042: the degrade flags reach the view (none here)
    expect([view.dataDegraded, view.degradedSections]).toEqual([false, { data: false, trend: false, categoryTrend: false, split: false }]);
  });

  it("a 404 from the backend (not a member) -> notFound()", async () => {
    override = (u) => (u.pathname === "/v1/filters/options" ? { body: { error: { code: "not_found" } }, status: 404 } : null);
    await expect(collect(await ProjectPage(args({}, { id: PROJECT })))).rejects.toThrow("nf");
  });
});
