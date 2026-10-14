import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { AllowedScope } from "@/lib/auth/types";

// Unit tests of the U4 filter adapter: source switch, the one serializer entry (analysisQuery),
// F-1 options -> panel props, F-2 dates -> calendar props, and the "filter consistency" check
// across every U4 fetcher (each axis reaches the query of each endpoint; meta.ignored_filters
// comes back as a notice). Expected values are computed by hand in the comments.

const { bindHghAuth } = await import("../auth");
const F = await import("./filters");
const { fetchKpiSummary, loadKpiSummary } = await import("./summary");
const { fetchPeriodCompareView } = await import("./compare");
const { fetchTrend, loadTrend } = await import("./trend");
const { readStandardFilters } = await import("@/components/dash/standard-filters");

type S = components["schemas"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const BASE = "https://api.hgh.test";
const PID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const FIELD = "0b8e2f2c-1d4a-4c1b-9a53-3f1c2d4e5f60";

interface Seen {
  path: string;
  query: Record<string, string[]>;
}
const seen: Seen[] = [];
let answer: (path: string) => unknown = () => ({ data: {}, meta: { mode: "snapshot" } });

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const url = new URL(String(u));
      const query: Record<string, string[]> = {};
      for (const k of [...new Set(url.searchParams.keys())]) query[k] = url.searchParams.getAll(k);
      seen.push({ path: url.pathname, query });
      return new Response(JSON.stringify(answer(url.pathname)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  seen.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", BASE);
  bindHghAuth({ getAccessToken: async () => TOKEN });
  stubFetch();
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const meta = (m: Partial<S["Meta"]> = {}): S["Meta"] => ({ mode: "snapshot", ...m });
const ADMIN: AllowedScope = { all: true };
const KIA_ACCOUNT: AllowedScope = { all: false, brands: ["Kia"], countries: ["US", "GB"] };

// ── source switch ────────────────────────────────────────────────────────────

describe("isAnalysisApi: HGH_SOURCE_<group> by sourceGroupFor(area, surface)", () => {
  it.each([
    ["dashboard", "global", "HGH_SOURCE_G1"],
    ["analysis", "global", "HGH_SOURCE_G2"],
    ["funnel", "global", "HGH_SOURCE_G4"],
    ["prompts", "global", "HGH_SOURCE_G5"],
    ["dashboard", "website", "HGH_SOURCE_G3"],
    ["analysis", "website", "HGH_SOURCE_G3"],
    ["analysis", "project", "HGH_SOURCE_G6"],
    ["dashboard", "project", "HGH_SOURCE_G6"],
  ] as const)("%s/%s -> %s", (area, surface, name) => {
    expect(F.isAnalysisApi(area, surface, {})).toBe(false); // default legacy
    expect(F.isAnalysisApi(area, surface, { [name]: "api" })).toBe(true);
    expect(F.isAnalysisApi(area, surface, { [name]: "legacy" })).toBe(false);
    // another group's flag does not switch this screen
    const other = name === "HGH_SOURCE_G1" ? "HGH_SOURCE_G2" : "HGH_SOURCE_G1";
    expect(F.isAnalysisApi(area, surface, { [other]: "api" })).toBe(false);
  });
});

describe("canReadAnalysis: the (dash) place gate for analysis BFF routes", () => {
  const u = (role: "hq" | "region" | "country" | "admin" | "vendor" | "website", menuGroups: ("standard" | "website" | "project" | "admin")[] | null = null) => ({ role, menuGroups });
  it("representative page per (surface, area)", () => {
    expect(F.analysisRoutePath("dashboard", "global")).toBe("/dashboard");
    expect(F.analysisRoutePath("analysis", "global")).toBe("/standard/answer-analysis");
    expect(F.analysisRoutePath("funnel", "global")).toBe("/standard/ai-funnel");
    expect(F.analysisRoutePath("prompts", "global")).toBe("/standard/prompts");
    expect(F.analysisRoutePath("analysis", "website")).toBe("/website/answer-analysis");
    expect(F.analysisRoutePath("funnel", "project")).toBe("/projects");
  });
  it.each([
    [u("vendor"), "dashboard", "global", false],
    [u("vendor"), "analysis", "project", true],
    [u("website"), "analysis", "global", false],
    [u("website"), "dashboard", "website", true],
    [u("website"), "analysis", "project", false],
    [u("hq", ["project"]), "dashboard", "website", false],
    [u("hq", ["project"]), "analysis", "project", true],
    [u("hq", ["website"]), "funnel", "global", false],
    [u("hq", []), "funnel", "global", true], // empty whitelist = role default
    [u("country"), "prompts", "website", true],
    [u("admin"), "prompts", "global", true],
  ] as const)("%o %s/%s -> %s", (user, area, surface, want) => {
    expect(F.canReadAnalysis(user, area, surface)).toBe(want);
  });
});

// ── analysisQuery ────────────────────────────────────────────────────────────

describe("analysisQuery: toCommonQuery + one-sided periods passed through", () => {
  it("closed period: same as toCommonQuery (from/to both)", () => {
    const q = F.analysisQuery({ dateFrom: "2026-09-01", dateTo: "2026-09-14" }, { surface: "global", scope: ADMIN });
    expect(q).toEqual({ query: { surface: "global", from: "2026-09-01", to: "2026-09-14" } });
  });

  it("only from: sent alone (backend closes to = latest round), no /v1/filters/dates needed", () => {
    const q = F.analysisQuery({ dateFrom: "2026-06-01" }, { surface: "website", scope: ADMIN });
    expect(q.query).toEqual({ surface: "website", from: "2026-06-01" });
  });

  it("only to: sent alone; out-of-range day clamped to the API range", () => {
    expect(F.analysisQuery({ dateTo: "2026-06-30" }, { surface: "global", scope: ADMIN }).query).toEqual({
      surface: "global",
      to: "2026-06-30",
    });
    expect(F.analysisQuery({ dateFrom: "1999-01-01" }, { surface: "global", scope: ADMIN }).query.from).toBe("2000-01-01");
  });

  it("malformed one-sided day = no period (as toCommonQuery)", () => {
    expect(F.analysisQuery({ dateFrom: "2026/06/01" }, { surface: "global", scope: ADMIN }).query).toEqual({ surface: "global" });
  });

  it("hasClosedPeriod: both ends, ordered", () => {
    expect(F.hasClosedPeriod({ dateFrom: "2026-09-01", dateTo: "2026-09-14" })).toBe(true);
    expect(F.hasClosedPeriod({ dateFrom: "2026-09-01" })).toBe(false);
    expect(F.hasClosedPeriod({ dateFrom: "2026-09-14", dateTo: "2026-09-01" })).toBe(false);
  });
});

// ── F-1 options ──────────────────────────────────────────────────────────────

const GEO: S["GeoCombo"][] = [
  { brand: "Kia", region: "US", lang: "en" },
  { brand: "Hyundai", region: "US", lang: "en" },
  { brand: "Hyundai", region: "KR", lang: "ko" },
  { brand: null, region: "GB", lang: "en" },
  { brand: "Genesis", region: "DE", lang: null },
  { brand: "Kia", region: "DE", lang: "de" },
];

function optionsData(o: Partial<S["OptionsData"]> = {}): S["OptionsData"] {
  return {
    catalog: {
      brand_presence: [],
      depth1: [],
      depth2: [],
      depth3: [],
      funnel: [],
      list_type: [],
      rows: [
        { brand: "Kia", brand_presence: "branded", list_type: "B", depth1: "2.", depth2: null, depth3: null, depth4: "x", funnel: "인지/탐색" },
        { brand: "Kia", brand_presence: "branded", list_type: "B", depth1: "2.", depth2: null, depth3: null, depth4: "x", funnel: "구매/사후관리" },
        { brand: null, brand_presence: "unbranded", list_type: "A", depth1: null, depth2: null, depth3: null, funnel: null },
        { brand: "Hyundai", brand_presence: "branded", list_type: null, depth1: "1.", depth2: "a", depth3: null, depth4: null, funnel: null },
      ],
    },
    custom_fields: null,
    engines: [
      { code: "chatgpt", is_default: true },
      { code: "gemini", is_default: false },
    ],
    geo_matrix: GEO,
    languages: ["de", "en", "ko"],
    regions: [],
    source_categories: [
      { name: "Other", ord: 13, slug: "other" },
      { name: "Official (HMG)", ord: 1, slug: "officialHmg" },
    ],
    ...o,
  };
}

describe("fetchFilterOptions: only surface, project_id and the period are sent", () => {
  it("brand/country/engine are never sent (options are not narrowed by user choices)", async () => {
    answer = () => ({ data: optionsData(), meta: meta() });
    await F.fetchFilterOptions({ surface: "project", projectId: PID, dateFrom: "2026-09-01", dateTo: "2026-09-14" });
    expect(seen).toEqual([
      { path: "/v1/filters/options", query: { from: ["2026-09-01"], project_id: [PID], surface: ["project"], to: ["2026-09-14"] } },
    ]);
  });

  it("global drops project_id; one-sided window passes through", async () => {
    answer = () => ({ data: optionsData(), meta: meta() });
    await F.fetchFilterOptions({ surface: "global", projectId: PID, dateTo: "2026-06-30" });
    expect(seen[0].query).toEqual({ surface: ["global"], to: ["2026-06-30"] });
  });

  it("B095 geoOnly (conversion pages): geo_only=true; the geography options are the same", async () => {
    const scope = KIA_ACCOUNT;
    answer = () => ({ data: optionsData(), meta: meta() });
    const full = await F.loadPanelOptions({ surface: "global", scope, filters: {} });
    answer = () => ({ data: optionsData({ catalog: null, custom_fields: null }), meta: meta() });
    const geo = await F.loadPanelOptions({ surface: "global", scope, filters: {}, geoOnly: true });
    expect(seen.map((s) => s.query)).toEqual([{ surface: ["global"] }, { geo_only: ["true"], surface: ["global"] }]);
    expect(geo.geographyOptions).toEqual(full.geographyOptions); // the only prop the conversion pages read
    expect({ ...geo, catalogRows: full.catalogRows }).toEqual(full);
    await F.loadPanelOptions({ surface: "website", scope, filters: {}, geoOnly: true });
    expect(seen[2].query).toEqual({ geo_only: ["true"], surface: ["website"] });
  });
});

describe("toCatalogRows: legacy CatalogTaxonomyRow (camel, funnel dropped, deduped, legacy order)", () => {
  it("rows", () => {
    // funnel differs only -> one row; order ListType A, B, then null (NULLs last)
    expect(F.toCatalogRows(optionsData().catalog)).toEqual([
      { brand: null, brandPresence: "unbranded", listType: "A", depth1: null, depth2: null, depth3: null, depth4: null },
      { brand: "Kia", brandPresence: "branded", listType: "B", depth1: "2.", depth2: null, depth3: null, depth4: "x" },
      { brand: "Hyundai", brandPresence: "branded", listType: null, depth1: "1.", depth2: "a", depth3: null, depth4: null },
    ]);
  });
  it("website catalog null -> undefined (panel static lists)", () => {
    expect(F.toCatalogRows(null)).toBeUndefined();
  });
});

describe("optionBrandsFor: the legacy narrowScopeBrands narrowing", () => {
  it("admin without a brand -> null (no narrowing)", () => {
    expect(F.optionBrandsFor(ADMIN, undefined)).toBeNull();
    expect(F.optionBrandsFor(null, undefined)).toBeNull();
  });
  it("admin with brand=Kia -> [Kia]", () => {
    expect(F.optionBrandsFor(ADMIN, ["Kia"])).toEqual(["Kia"]);
  });
  it("brand account: the lock [Kia, HMG] intersects to [Kia]", () => {
    const f = readStandardFilters({}, KIA_ACCOUNT);
    expect(f.brand).toEqual(["Kia", "HMG"]);
    expect(F.optionBrandsFor(KIA_ACCOUNT, f.brand)).toEqual(["Kia"]);
  });
  it("deny marker brands [HMG] is never a real brand: common rows only", () => {
    const deny: AllowedScope = { all: false, brands: ["HMG"], countries: ["ZZ"] };
    const f = readStandardFilters({}, deny);
    expect(F.optionBrandsFor(deny, f.brand)).toEqual([]);
    // only the brand-null row (GB) stays
    expect(F.regionOptionsOf(GEO, F.optionBrandsFor(deny, f.brand))).toEqual(["GB"]);
  });
});

describe("geo_matrix narrowing (listMeasuredRegions / Languages / ScopeMatrix)", () => {
  it("no narrowing: every region and language, sorted", () => {
    expect(F.regionOptionsOf(GEO, null)).toEqual(["DE", "GB", "KR", "US"]);
    expect(F.languageOptionsOf(GEO, null)).toEqual(["de", "en", "ko"]);
  });
  it("Kia: Kia rows + brand-null rows (GB common)", () => {
    // Kia US en, Kia DE de, null GB en
    expect(F.regionOptionsOf(GEO, ["Kia"])).toEqual(["DE", "GB", "US"]);
    expect(F.languageOptionsOf(GEO, ["Kia"])).toEqual(["de", "en"]);
    expect(F.narrowGeoMatrix(GEO, ["Kia"])).toEqual([
      { brand: "Kia", region: "DE", lang: "de" },
      { brand: null, region: "GB", lang: "en" },
      { brand: "Kia", region: "US", lang: "en" },
    ]);
  });
  it("lang null counts for the region only (Genesis DE)", () => {
    expect(F.regionOptionsOf(GEO, ["Genesis"])).toEqual(["DE", "GB"]);
    expect(F.languageOptionsOf(GEO, ["Genesis"])).toEqual(["en"]);
  });
  it("matrix order = region, lang, brand with NULLs last", () => {
    expect(F.narrowGeoMatrix(GEO, null).map((r) => `${r.region}|${r.lang}|${r.brand}`)).toEqual([
      "DE|de|Kia",
      "DE|null|Genesis",
      "GB|en|null",
      "KR|ko|Hyundai",
      "US|en|Hyundai",
      "US|en|Kia",
    ]);
  });
});

describe("toDynamicAxes / engines / source categories", () => {
  it("custom fields: id, label, values sorted (localeCompare)", () => {
    expect(F.toDynamicAxes([{ field_id: FIELD, label: "캠페인", values: ["b", "A", "a"] }])).toEqual([
      { id: FIELD, label: "캠페인", options: ["a", "A", "b"] },
    ]);
    expect(F.toDynamicAxes(null)).toEqual([]);
  });
  it("engines in API order; default engine (DC-01)", () => {
    expect(F.engineOptionsOf(optionsData().engines)).toEqual(["chatgpt", "gemini"]);
    expect(F.defaultEngineOf(optionsData().engines)).toBe("chatgpt");
  });
  it("source categories by ord", () => {
    expect(F.sourceCategoryOptionsOf(optionsData().source_categories).map((c) => c.slug)).toEqual(["officialHmg", "other"]);
  });
});

describe("toPanelOptions: the props each surface's page passed", () => {
  const res = { data: optionsData(), meta: meta() };
  it("global: catalog rows, lists narrowed by the applied brand, matrix not narrowed", () => {
    const o = F.toPanelOptions(res, { surface: "global", scope: ADMIN, filters: { brand: ["Hyundai"] } });
    expect(o.geographyOptions).toEqual(["GB", "KR", "US"]); // Hyundai KR, US + common GB
    expect(o.languageOptions).toEqual(["en", "ko"]);
    expect(o.optionMatrix).toHaveLength(GEO.length);
    expect(o.catalogRows).toHaveLength(3);
    expect(o.dynamicAxes).toBeUndefined();
  });
  it("website: matrix narrowed too, no catalog", () => {
    const o = F.toPanelOptions({ data: optionsData({ catalog: null }), meta: meta() }, {
      surface: "website",
      scope: KIA_ACCOUNT,
      filters: readStandardFilters({}, KIA_ACCOUNT),
    });
    expect(o.catalogRows).toBeUndefined();
    expect(o.geographyOptions).toEqual(["DE", "GB", "US"]);
    expect(o.optionMatrix?.every((r) => r.brand === null || r.brand === "Kia")).toBe(true);
  });
  it("project: geography (project measured), engines, dynamic axes, catalog; no language list", () => {
    const o = F.toPanelOptions(
      { data: optionsData({ custom_fields: [{ field_id: FIELD, label: "L", values: ["x"] }] }), meta: meta() },
      { surface: "project", scope: KIA_ACCOUNT, filters: {} },
    );
    expect(o.geographyOptions).toEqual(["DE", "GB", "KR", "US"]); // project answer: not narrowed by the account
    expect(o.languageOptions).toBeUndefined();
    expect(o.engineOptions).toEqual(["chatgpt", "gemini"]);
    expect(o.dynamicAxes).toEqual([{ id: FIELD, label: "L", options: ["x"] }]);
    expect(o.optionMatrix).toBeUndefined();
  });
});

// ── F-2 dates ────────────────────────────────────────────────────────────────

function datesData(d: Partial<S["DatesData"]> = {}): S["DatesData"] {
  return {
    dates: ["2026-09-14", "2026-09-07", "2026-08-31"],
    dates_truncated: false,
    first_measured_date: "2026-07-01",
    latest_round_date: "2026-09-14",
    presets: [{ preset: "weekly", from: "2026-09-08", to: "2026-09-14" }],
    surface: "global",
    ...d,
  };
}

describe("F-2 dates -> calendar props", () => {
  it("fetchFilterDates: surface + family (+ project_id), no value axes", async () => {
    answer = () => ({ data: datesData(), meta: meta() });
    await F.fetchFilterDates({ surface: "project", projectId: PID, family: "all" });
    await F.fetchFilterDates({ surface: "global", projectId: PID });
    expect(seen.map((s) => s.query)).toEqual([
      { family: ["all"], project_id: [PID], surface: ["project"] },
      { family: ["mentions"], surface: ["global"] },
    ]);
  });

  it("dates reversed to ascending (legacy contract); empty -> undefined", () => {
    expect(F.selectableDatesOf(datesData())).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
    expect(F.selectableDatesOf(datesData({ dates: [] }))).toBeUndefined();
  });

  it("collection start = KST midnight instant of first_measured_date", () => {
    // 2026-07-01T00:00+09:00 = 2026-06-30T15:00Z
    expect(F.collectionStartDayOf(datesData())).toBe("2026-06-30T15:00:00.000Z");
    expect(F.collectionStartDayOf(datesData({ first_measured_date: null }))).toBeNull();
  });

  it("view: latest, presets, truncated, notices", async () => {
    answer = () => ({ data: datesData({ dates_truncated: true }), meta: meta({ ignored_filters: ["brand"] }) });
    const v = await F.loadFilterDates({ surface: "global", family: "citations" });
    expect(v).toMatchObject({
      latestAnchorDay: "2026-09-14",
      firstMeasuredDate: "2026-07-01",
      truncated: true,
      presets: [{ preset: "weekly", from: "2026-09-08", to: "2026-09-14" }],
    });
    expect(v.notices.ignored).toEqual(["brand"]);
    expect(seen[0].query.family).toEqual(["citations"]);
  });
});

// ── filter consistency across the U4 fetchers ─────────────────────────────────

describe("filter consistency: every axis reaches every U4 endpoint through one serializer", () => {
  // A URL with every axis the panel can write, read by the real readStandardFilters (admin).
  const url = {
    geography: "US~GB",
    engine: "ChatGPT~gemini",
    time: "2026-09-01..2026-09-14",
    promptContext: "인지/탐색",
    brand: "Kia",
    brandPresence: "branded",
    listType: "Brand Message",
    depth1: "1., Innovation",
    depth2: "a",
    depth3: "b",
    source: "Official (HMG)~Other",
    language: "EN",
  };
  const filters = readStandardFilters(url, ADMIN);
  const expected = {
    brand: ["Kia"],
    brand_presence: ["branded"],
    country: ["GB", "US"],
    depth1: ["1., Innovation"],
    depth2: ["a"],
    depth3: ["b"],
    engine: ["chatgpt", "gemini"],
    from: ["2026-09-01"],
    funnel: ["인지/탐색"],
    lang: ["en"],
    list_type: ["Brand Message"],
    source: ["officialHmg", "other"],
    surface: ["global"],
    to: ["2026-09-14"],
  };
  const ctx = { surface: "global" as const, scope: ADMIN };

  beforeEach(() => {
    answer = (path) => {
      if (path === "/v1/kpi/compare") {
        return { data: [], meta: { mode: "cumulative", compare: { kind: "window", first_published: null, windows: null } } };
      }
      if (path === "/v1/trend") {
        return { data: { bucket: "cycle", buckets: [], dimension: "none", own_label: "HMG", series: [] }, meta: meta({ ignored_filters: ["lang"] }) };
      }
      return {
        data: {
          analysis_gap: { base_answers: 0, gap_answers: 0 },
          citation_accuracy: null,
          citation_share: null,
          owned_url_rate: null,
          params: { answers: 0, applied_prompts: 0, measured_prompts: 0 },
          position: null,
          sentiment: null,
          share_of_voice: null,
          target_url_rate: null,
          visibility: null,
        },
        meta: meta({ ignored_filters: ["source"], dropped_filters: { brand: ["HMG"] } }),
      };
    };
  });

  it("GET /v1/kpi/summary carries every axis", async () => {
    await fetchKpiSummary(filters, ctx);
    expect(seen[0].path).toBe("/v1/kpi/summary");
    // parts: the analysis tabs' K-1 parts (B089, summary.ts), not a filter axis
    expect(seen[0].query).toEqual({ ...expected, parts: ["gap", "measured", "urls"] });
  });

  it("GET /v1/kpi/compare carries every axis + kind + metrics", async () => {
    await fetchPeriodCompareView(filters, { ...ctx, kind: "window", metrics: ["visibility", "share"] });
    expect(seen[0].path).toBe("/v1/kpi/compare");
    // card: WU-3 card path (every legacy compare caller read the summary tables, compare.ts header)
    expect(seen[0].query).toEqual({ ...expected, kind: ["window"], metrics: ["visibility", "share_of_voice"], card: ["true"] });
  });

  it("GET /v1/trend carries every axis + bucket/dimension (+ split_own on brand)", async () => {
    await fetchTrend(filters, { ...ctx, bucket: "cycle" });
    await fetchTrend(filters, { ...ctx, bucket: "week", dimension: "brand", metrics: ["visibility"], top: 20, brandKeys: [9, 3] });
    expect(seen[0].query).toEqual({ ...expected, bucket: ["cycle"], dimension: ["none"] });
    expect(seen[1].query).toEqual({
      ...expected,
      bucket: ["week"],
      dimension: ["brand"],
      metrics: ["visibility"],
      top: ["20"],
      brand_key: ["3", "9"],
      split_own: ["true"],
    });
  });

  it("project surface: project_id and cf.<uuid> reach the query", async () => {
    await fetchKpiSummary({ engine: ["chatgpt"] }, { surface: "project", projectId: PID, scope: null, customFields: { [FIELD]: ["b", "a"] } });
    expect(seen[0].query).toEqual({ [`cf.${FIELD}`]: ["a", "b"], engine: ["chatgpt"], parts: ["gap", "measured", "urls"], project_id: [PID], surface: ["project"] });
  });

  it("scope-injected values are not sent (brand lock, account countries)", async () => {
    const f = readStandardFilters({}, KIA_ACCOUNT);
    expect(f.brand).toEqual(["Kia", "HMG"]);
    expect(f.region).toEqual(["US", "GB"]);
    await fetchKpiSummary(f, { surface: "global", scope: KIA_ACCOUNT });
    expect(seen[0].query).toEqual({ parts: ["gap", "measured", "urls"], surface: ["global"] });
  });

  it("ignored_filters / dropped_filters come back as notices", async () => {
    const s = await loadKpiSummary(filters, ctx);
    expect(s.notices).toEqual({ ignored: ["source"], dropped: { brand: ["HMG"] }, hasAny: true });
    const t = await loadTrend(filters, { ...ctx, bucket: "cycle" });
    expect(t.notices.ignored).toEqual(["lang"]);
  });
});
