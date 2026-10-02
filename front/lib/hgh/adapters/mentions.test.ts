import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { StandardSubKpis } from "@/lib/db/repositories/scope-aggregates";

// Mentions adapter (unit U6): hand-computed conversions (B-2 MentionsLive, B-3 Sub KPI), the
// empty and suppressed states, the D6 first-render order, the query every call of one screen
// shares (filter consistency), the previous-window rules, the failure policy, and parity with the
// UNCHANGED legacy Sub KPI view builder (buildMentionSubKpis) and trend builder (buildMentionTrend)
// run on the legacy shape of the same WORLD. Known differences are listed in KNOWN_DIFF and must
// be documented in the adapter header.

// react-server build so cache() (in-request dedupe, degrade labels) really works per request.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});
vi.mock("@/lib/scope/server", () => ({}));
const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("../auth");
const M = await import("./mentions");
const { buildMentionSubKpis } = await import("@/app/[locale]/(dash)/standard/answer-analysis/_data/sub-kpis");
const { buildMentionTrend } = await import("@/lib/scope/result-adapter");
const { wasDegraded } = await import("@/lib/scope/degrade-registry");

type S = components["schemas"];
type Brand = S["BrandItem"];
type Meta = S["Meta"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const FIELD = "0b3f1c2d-0000-4000-8000-000000000001";

const meta = (m: Partial<Meta> = {}): Meta => ({ mode: "snapshot", as_of: "2026-09-14", cycles: ["2026-09-14"], ...m });
const ratio = (num: number, den: number) => ({ num, den });
const sent = (positive: number, neutral: number, negative: number, mixed: number) => ({ positive, neutral, negative, mixed });
const types = (mention: number, recommendation = 0, comparison = 0, definition = 0, final_choice = 0) => ({
  mention,
  recommendation,
  comparison,
  definition,
  final_choice,
});

function brand(o: Partial<Brand> & Pick<Brand, "name" | "mentions">): Brand {
  return {
    avg_rank: null,
    brand_key: 10,
    exposure: ratio(0, 400),
    is_own: false,
    rank: 1,
    share: ratio(o.mentions, 900),
    sentiment: sent(0, 0, 0, 0),
    ...o,
  };
}

// WORLD: 400 answers, 900 mentions. Split perspective (HMG three brands -> Hyundai and Kia rows).
const BRANDS: S["BrandsData"] = {
  brands: [
    brand({ name: "Hyundai", own_brand_code: "Hyundai", is_own: true, brand_key: 1, mentions: 201, exposure: ratio(150, 400), share: ratio(201, 400), avg_rank: { sum: 7, count: 2 }, prompts: 40, multi: { mentions: 50, answers: 20, prompts: 10 }, sentiment: sent(30, 10, 5, 1), types: types(20, 5) }),
    brand({ name: "Toyota", brand_key: 7, mentions: 180, exposure: ratio(1, 3), avg_rank: { sum: 9, count: 3 }, prompts: 30, sentiment: sent(2, 2, 2, 2), types: types(8, 1) }),
    brand({ name: "Kia", own_brand_code: "Kia", is_own: true, brand_key: 2, mentions: 120, exposure: ratio(90, 400), avg_rank: null, prompts: 25, sentiment: sent(12, 3, 0, 0), types: types(10) }),
  ],
  own: { avg_rank: { sum: 7, count: 2 }, brands: ["Hyundai", "Kia", "Genesis"], exposure: ratio(200, 400), mentions: 321, rank: 1, share: ratio(321, 900), vp_label: "HMG" },
  totals: { answers: 400, brand_count: 17, mentions_total: 900 },
  types_total: types(60, 10, 0, 2, 0),
};

const TYPES: S["app__features__analytics__mentions__types__schemas__TypesData"] = {
  answers_total: 400,
  by_type: [
    { type: "mention", own_mentions: 30, other_mentions: 30, own_answers: 25, other_answers: 20, own_exposure: ratio(25, 400), other_exposure: ratio(20, 400), own_share: ratio(30, 60) },
    { type: "recommendation", own_mentions: 5, other_mentions: 5, own_answers: 4, other_answers: 4, own_exposure: ratio(4, 400), other_exposure: ratio(4, 400), own_share: ratio(5, 10) },
    { type: "comparison", own_mentions: 0, other_mentions: 0, own_answers: 0, other_answers: 0, own_exposure: ratio(0, 400), other_exposure: ratio(0, 400), own_share: ratio(0, 0) },
    { type: "definition", own_mentions: 2, other_mentions: 0, own_answers: 2, other_answers: 0, own_exposure: ratio(2, 400), other_exposure: ratio(0, 400), own_share: ratio(2, 2) },
    { type: "final_choice", own_mentions: 0, other_mentions: 0, own_answers: 0, other_answers: 0, own_exposure: ratio(0, 400), other_exposure: ratio(0, 400), own_share: ratio(0, 0) },
  ],
  sentiment_matrix: [],
  stance: null,
};

// Trend: rounds 09-01 (Mon) and 09-03 (Wed, same week), 09-08 a collection error, 09-15.
function trendData(): S["TrendData"] {
  const buckets = ["2026-09-01", "2026-09-03", "2026-09-08", "2026-09-15"].map((k) => ({ key: k, round_dates: [k], measured_days: 1 }));
  const pt = (bucket: string, num: number | null, gap?: "collection_error") =>
    gap ? { bucket, gap: true, gap_reason: gap } : { bucket, gap: false, ratio: num === null ? null : ratio(num, 100) };
  const series = (key: string, label: string, isOwn: boolean, own: string | null, vals: (number | null)[]) => ({
    metric: "share_of_voice",
    code: "M02",
    kind: "ratio" as const,
    key,
    label,
    is_own: isOwn,
    own_brand_code: own,
    brand_key: null,
    points: [pt("2026-09-01", vals[0]), pt("2026-09-03", vals[1]), pt("2026-09-08", null, "collection_error"), pt("2026-09-15", vals[2])],
  });
  return {
    bucket: "cycle",
    dimension: "brand",
    own_label: "HMG",
    buckets,
    series: [
      series("Toyota", "Toyota", false, null, [5, 6, 7]),
      series("Hyundai", "Hyundai", true, "Hyundai", [10, 20, 30]),
      series("Kia", "Kia", true, "Kia", [1, 2, 3]),
    ],
  } as unknown as S["TrendData"];
}

function summaryData(o: Partial<S["SummaryData"]> = {}): S["SummaryData"] {
  return {
    visibility: ratio(200, 400),
    share_of_voice: ratio(321, 900),
    sentiment: ratio(42, 63),
    position: { sum: 7, count: 2 },
    citation_share: ratio(10, 100),
    target_url_rate: null,
    owned_url_rate: null,
    citation_accuracy: null,
    params: { answers: 400, applied_prompts: 120, measured_prompts: 100, prompts_without_brand: 12, measured_by_funnel: null },
    analysis_gap: { gap_answers: 0, base_answers: 400 },
    ...o,
  };
}

// ── conversions ──────────────────────────────────────────────────────────────

describe("toMentionsBrandLive: hand-computed", () => {
  it("own split row: percent rule, rank average, extras, own code", () => {
    // share 201/400: (201/400)*1000 = 502.49999... -> 502 -> 50.2 (legacy pctOf, not 50.3)
    // exposure 150/400 = 37.5 ; rank 7/2 = 3.5
    expect(M.toMentionsBrandLive(BRANDS.brands[0])).toEqual({
      brand: "Hyundai",
      mentions: 201,
      prompts: 40,
      share: 50.2,
      mentionRate: 37.5,
      avgPosition: 3.5,
      isTracked: true,
      multi: { mentions: 50, answers: 20, prompts: 10 },
      sentiment: { positive: 30, neutral: 10, negative: 5, mixed: 1 },
      brandKey: 1,
      ownBrandCode: "Hyundai",
    });
  });
  it("competitor row: 1/3 -> 33.3, 9/3 -> 3, no multi, no own code; den 0 -> 0", () => {
    const r = M.toMentionsBrandLive(BRANDS.brands[1]);
    expect([r.mentionRate, r.avgPosition, r.multi, r.ownBrandCode, r.brandKey]).toEqual([33.3, 3, undefined, undefined, 7]);
    expect(M.toMentionsBrandLive(brand({ name: "X", mentions: 0, share: ratio(0, 0), exposure: ratio(0, 0) })).share).toBe(0);
  });
  it("merged own row without brand_key: no brandKey key (legacy rows never had one)", () => {
    const r = M.toMentionsBrandLive(brand({ name: "HMG", is_own: true, brand_key: null, mentions: 3 }));
    expect("brandKey" in r).toBe(false);
  });
});

describe("toMentionsLive: B-2 assembly", () => {
  const parts = (o: Partial<Parameters<typeof M.toMentionsLive>[0]> = {}) => ({
    brands: { data: BRANDS, meta: meta() },
    types: { data: TYPES, meta: meta() },
    summary: { data: summaryData(), meta: meta() },
    trend: { data: trendData(), meta: meta() },
    ...o,
  });
  it("summary, sentiment of the own rows, type totals, types by brand, position flag", () => {
    const live = M.toMentionsLive(parts())!;
    expect(live.summary).toEqual({ total: 900, uniqueBrands: 17, totalPrompts: 100, totalAnswers: 400 });
    expect(live.asOf).toBe("2026-09-14");
    // Hyundai (30,10,5,1) + Kia (12,3,0,0)
    expect(live.sentimentTotals).toEqual({ positive: 42, neutral: 13, negative: 5, mixed: 1 });
    expect(live.typeTotals).toEqual({ mention: 30, recommendation: 5, comparison: 0, definition: 2, final_choice: 0 });
    expect(live.typesByBrand?.totals).toEqual(types(60, 10, 0, 2, 0));
    expect(live.typesByBrand?.brands.map((b) => [b.brand, b.isTracked, b.types.mention])).toEqual([
      ["Hyundai", true, 20],
      ["Toyota", false, 8],
      ["Kia", true, 10],
    ]);
    expect(live.hasPosition).toBe(true);
    expect(live.perBrandPrompts).toEqual({});
    expect(live.brands.map((b) => b.brand)).toEqual(["Hyundai", "Toyota", "Kia"]);
    expect("trendDegraded" in live).toBe(false);
  });
  it("own rows without mentions: typeTotals null; all own sentiment 0: sentimentTotals null", () => {
    const quiet: S["BrandsData"] = {
      ...BRANDS,
      brands: [brand({ name: "Hyundai", is_own: true, mentions: 0 }), BRANDS.brands[1]],
      types_total: types(0),
    };
    const live = M.toMentionsLive(parts({ brands: { data: quiet, meta: meta() } }))!;
    expect([live.typeTotals, live.sentimentTotals, live.typesByBrand]).toEqual([null, null, null]);
  });
  it("whole suppression -> null (EmptyState); no answers -> the legacy empty shape", () => {
    expect(M.toMentionsLive(parts({ brands: { data: BRANDS, meta: meta({ suppressed: { "*": "no_active_snapshot" } }) } }))).toBeNull();
    const none = { ...BRANDS, totals: { answers: 0, brand_count: 0, mentions_total: 0 } };
    expect(M.toMentionsLive(parts({ brands: { data: none, meta: meta() } }))).toEqual(M.emptyMentionsLive());
  });
  it("failed trend call -> trend null + trendDegraded (the chart says 준비 중, headline kept)", () => {
    const live = M.toMentionsLive(parts({ trend: null, trendFailed: true }))!;
    expect([live.trend, live.trendDegraded, live.summary.total]).toEqual([null, true, 900]);
  });
});

describe("toMentionTrend: weekly chart through the unchanged legacy builder", () => {
  it("rounds of one week summed on the Monday, own series first, the gap round is a gap week", () => {
    const t = M.toMentionTrend(trendData())!;
    expect(t.series).toEqual(["Hyundai", "Kia", "Toyota"]);
    // week 08-31 (Mon) = rounds 09-01 + 09-03: Hyundai 10+20, Kia 1+2, Toyota 5+6 ; week 09-07 =
    // the collection-error round (all null + gap, inside the axis) ; week 09-14 = round 09-15
    expect(t.points.map((p) => [p.week, p.Hyundai, p.Kia, p.Toyota])).toEqual([
      ["2026-08-31", 30, 3, 11],
      ["2026-09-07", null, null, null],
      ["2026-09-14", 30, 3, 7],
    ]);
    expect(t.points[1].gap).toBeDefined();
  });
  it("parity: equals buildMentionTrend on the legacy weekly entries of the same WORLD", () => {
    const legacyEntries = [
      { date: "2026-09-01", brand: "Hyundai", count: 10 },
      { date: "2026-09-03", brand: "Hyundai", count: 20 },
      { date: "2026-09-15", brand: "Hyundai", count: 30 },
      { date: "2026-09-01", brand: "Kia", count: 1 },
      { date: "2026-09-03", brand: "Kia", count: 2 },
      { date: "2026-09-15", brand: "Kia", count: 3 },
      { date: "2026-09-01", brand: "Toyota", count: 5 },
      { date: "2026-09-03", brand: "Toyota", count: 6 },
      { date: "2026-09-15", brand: "Toyota", count: 7 },
    ];
    const legacy = buildMentionTrend(legacyEntries, ["Hyundai", "Kia", "Toyota"], ["2026-09-07"]);
    expect(M.toMentionTrend(trendData())).toEqual(legacy);
  });
  it("one valued week only -> null (legacy '2 weeks' rule, the gap week does not count)", () => {
    const d = trendData();
    d.buckets = d.buckets.slice(0, 3);
    d.series = d.series.map((s) => ({ ...s, points: s.points.slice(0, 3) }));
    expect(M.toMentionTrend(d)).toBeNull();
  });
});

// ── Sub KPI ─────────────────────────────────────────────────────────────────

const ENGINES: S["EnginesData"] = {
  engine_consistency: { citation_share: null, position: null, sentiment: null, share_of_voice: null, visibility: null },
  rows: [
    { engine: "chatgpt", answers: 200, tracked: 120, multi: 30, top1: 20, top3: 60, rank_sum: 300, ranked: 100, total_mentions: 500, tracked_mentions: 180, sent_mentions: 40, positive_mentions: 25, negative_mentions: 5, cit_total: 50, cit_owned: 5 },
    { engine: "gemini", answers: 200, tracked: 80, multi: 10, top1: 10, top3: 30, rank_sum: null, ranked: null, total_mentions: 400, tracked_mentions: 141, sent_mentions: 23, positive_mentions: 17, negative_mentions: 1, cit_total: null, cit_owned: null },
  ],
  total: { answers: 400, tracked: 200, multi: 40, top1: 30, top3: 90, rank_sum: 300, ranked: 100, total_mentions: 900, tracked_mentions: 321, sent_mentions: 63, positive_mentions: 42, negative_mentions: 6, cit_total: 50, cit_owned: 5 },
};

/** The legacy StandardSubKpis the mirror reader returns for the same WORLD. */
const LEGACY_SUB: StandardSubKpis = {
  rows: [
    { engine: "chatgpt", answers: 200, tracked: 120, multi: 30, top1: 20, top3: 60, avgPosition: 3, totalMentions: 500, trackedMentions: 180, sentMentions: 40, positiveMentions: 25, negativeMentions: 5, citTotal: 50, citOwned: 5 },
    { engine: "gemini", answers: 200, tracked: 80, multi: 10, top1: 10, top3: 30, avgPosition: null, totalMentions: 400, trackedMentions: 141, sentMentions: 23, positiveMentions: 17, negativeMentions: 1, citTotal: 0, citOwned: 0 },
  ],
  promptsWithoutBrand: 12,
  measuredPrompts: 100,
};

describe("Sub KPI (B-3)", () => {
  it("engine rows: rank_sum/ranked, nulls -> 0; params from the summary", () => {
    const sub = M.toStandardSubKpis({ data: ENGINES, meta: meta() }, { data: summaryData(), meta: meta() });
    expect(sub).toEqual(LEGACY_SUB);
  });
  it("parity: buildMentionSubKpis gives the same cards on the adapter output and the legacy sub", () => {
    const api = buildMentionSubKpis(M.toStandardSubKpis({ data: ENGINES, meta: meta() }, { data: summaryData(), meta: meta() }));
    expect(api).toEqual(buildMentionSubKpis(LEGACY_SUB));
    // hand check: top3 90/200 = 45%, own rate 200/400 = 50%, multi 40, keywords 42 / 6
    expect(api).toMatchObject({ top3Rate: 45, top3Count: 90, top3Base: 200, ownMentionRate: 50, multiMentionAnswers: 40, positiveKeywords: 42, negativeKeywords: 6, missingPrompts: 12, totalMentions: 900, measuredPrompts: 100 });
  });
  it("hidden mention family or whole suppression -> rows [] (the three cards drop, as legacy empty rows)", () => {
    expect(M.toSubKpiRows({ data: ENGINES, meta: meta({ suppressed: { visibility: "hidden" } }) })).toEqual([]);
    expect(M.toSubKpiRows({ data: ENGINES, meta: meta({ suppressed: { "*": "no_active_snapshot" } }) })).toEqual([]);
    expect(M.toSubKpiRows({ data: ENGINES, meta: meta({ suppressed: { citation_share: "no_data" } }) })).toHaveLength(2);
  });
  it("prompts_without_brand absent -> null (BG-06 gives it on every surface; a hidden summary gives nulls)", () => {
    const hidden = M.toStandardSubKpis({ data: ENGINES, meta: meta() }, { data: summaryData(), meta: meta({ suppressed: { "*": "hidden" } }) });
    expect([hidden.promptsWithoutBrand, hidden.measuredPrompts]).toEqual([null, null]);
  });
});

// ── calls ───────────────────────────────────────────────────────────────────

type Handler = (url: URL) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

function stubFetch(handler: Handler, log: URL[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const url = new URL(String(u));
      log.push(url);
      const r = await handler(url);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
}

function defaultHandler(url: URL): { status?: number; body: unknown } {
  switch (url.pathname) {
    case "/v1/mentions/brands":
      return { body: { data: BRANDS, meta: meta() } };
    case "/v1/mentions/types":
      return { body: { data: TYPES, meta: meta() } };
    case "/v1/trend":
      return { body: { data: trendData(), meta: meta() } };
    case "/v1/kpi/summary":
      return { body: { data: summaryData(), meta: meta({ cycles: ["2026-09-08", "2026-09-01", "2026-09-14"] }) } };
    case "/v1/kpi/engines":
      return { body: { data: ENGINES, meta: meta() } };
    case "/v1/filters/dates":
      return { body: { data: { dates: ["2026-09-14"], dates_truncated: false, first_measured_date: "2026-06-01", latest_round_date: "2026-09-14", presets: [] }, meta: meta() } };
    case `/v1/projects/${PROJECT}`:
      return { body: { data: { project_id: PROJECT, target_brand: "Toyota" }, meta: meta() } };
    default:
      return { status: 404, body: { error: { code: "not_found", message: "x" } } };
  }
}

const common = (u: URL) => {
  const q = new URLSearchParams(u.search);
  const out: Record<string, string[]> = {};
  for (const k of ["surface", "project_id", "brand", "country", "lang", "engine", "from", "to", "funnel", "list_type", "source"]) {
    const v = q.getAll(k);
    if (v.length) out[k] = v;
  }
  for (const k of new Set(q.keys())) if (k.startsWith("cf.")) out[k] = q.getAll(k);
  return out;
};

describe("loaders: queries, filter consistency, D6 order", () => {
  const log: URL[] = [];
  beforeEach(() => {
    log.length = 0;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    stubFetch(defaultHandler, log);
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("brands call B1: full list, split own, include multi/prompts/types, sort by mentions", async () => {
    await M.fetchMentionBrands({}, { surface: "global", scope: null });
    const q = log[0].searchParams;
    expect([q.get("full"), q.get("split_own"), q.get("sort"), q.get("top_n"), q.getAll("include")]).toEqual([
      "true",
      "true",
      "mentions",
      "100",
      ["multi", "prompts", "types"],
    ]);
  });

  it("every call of one screen carries the same CommonFilters (scope injection stripped, cf on project)", async () => {
    // readStandardFilters output of an HQ Kia account on /projects/<id>/analysis/mention with a period,
    // one country and one custom field; the injected brand lock (Kia) must not be sent.
    const filters = { region: ["US"], brand: ["Kia"], dateFrom: "2026-09-01", dateTo: "2026-09-14", engine: ["ChatGPT"], customFieldFilters: { [FIELD]: ["b", "a"] } };
    const ctx = { surface: "project" as const, projectId: PROJECT, scope: { all: false, brands: ["Kia"] }, customFields: filters.customFieldFilters };
    await withRequestScope(() =>
      Promise.all([M.loadMentionsLive(filters, ctx), M.loadSubKpis(filters, ctx), M.loadSubKpisPrev(filters, ctx)]),
    );
    const analysis = log.filter((u) => u.pathname !== "/v1/filters/dates");
    expect(analysis.length).toBeGreaterThanOrEqual(6);
    const expected = {
      surface: ["project"],
      project_id: [PROJECT],
      country: ["US"],
      engine: ["chatgpt"],
      from: ["2026-09-01"],
      to: ["2026-09-14"],
      [`cf.${FIELD}`]: ["a", "b"],
    };
    // The previous window re-reads with to = the first round of the window (2026-09-01).
    for (const u of analysis) {
      const c = common(u);
      if (c.to?.[0] === "2026-09-01") expect(c).toEqual({ ...expected, to: ["2026-09-01"] });
      else expect(c).toEqual(expected);
    }
  });

  it("D6: the four essentials go first, the second stage waits, and each distinct call is made once", async () => {
    const gates: Array<() => void> = [];
    const isEssential = (u: URL) =>
      ["/v1/mentions/brands", "/v1/kpi/summary", "/v1/filters/dates"].includes(u.pathname) ||
      (u.pathname === "/v1/trend" && u.searchParams.get("dimension") === "none");
    stubFetch(async (u) => {
      if (isEssential(u)) await new Promise<void>((r) => gates.push(r));
      return defaultHandler(u);
    }, log);
    await withRequestScope(async () => {
      const p = M.loadMentionsLive({}, { surface: "global", scope: null });
      await vi.waitFor(() => expect(gates.length).toBe(4));
      expect(log.map((u) => u.pathname).sort()).toEqual(["/v1/filters/dates", "/v1/kpi/summary", "/v1/mentions/brands", "/v1/trend"]);
      // types and the brand trend have not been requested while the essentials are pending
      await new Promise((r) => setTimeout(r, 5));
      expect(log.some((u) => u.pathname === "/v1/mentions/types")).toBe(false);
      while (gates.length) gates.shift()!();
      const live = await p;
      expect(live?.summary.total).toBe(900);
      const keys = log.map((u) => `${u.pathname}?${u.search}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(log.map((u) => `${u.pathname}:${u.searchParams.get("dimension") ?? ""}`).sort()).toEqual([
        "/v1/filters/dates:",
        "/v1/kpi/summary:",
        "/v1/mentions/brands:",
        "/v1/mentions/types:",
        "/v1/trend:brand",
        "/v1/trend:none",
      ]);
    });
  });

  it("website/project essentials: the engine rows replace the overview trend (Sub KPI cards first)", async () => {
    await withRequestScope(async () => {
      await M.loadSubKpis({}, { surface: "website", scope: null });
    });
    expect(log.some((u) => u.pathname === "/v1/trend")).toBe(false);
    expect(log.filter((u) => u.pathname === "/v1/kpi/engines")).toHaveLength(1);
  });

  it("prev, period: re-read up to the first round of the window, asOf = that round", async () => {
    const prev = await withRequestScope(() => M.loadSubKpisPrev({ dateFrom: "2026-08-25", dateTo: "2026-09-14" }, { surface: "website", scope: null }));
    expect(prev?.asOf).toBe("2026-09-01");
    const re = log.filter((u) => u.searchParams.get("to") === "2026-09-01");
    expect(re.map((u) => [u.pathname, u.searchParams.get("from")]).sort()).toEqual([
      ["/v1/kpi/engines", "2026-08-25"],
      ["/v1/kpi/summary", "2026-08-25"],
    ]);
  });

  it("prev, period with one round -> null; snapshot -> cycle_offset=1 and asOf = meta.as_of", async () => {
    stubFetch((u) => (u.pathname === "/v1/kpi/summary" ? { body: { data: summaryData(), meta: meta({ cycles: ["2026-09-14"] }) } } : defaultHandler(u)), log);
    expect(await withRequestScope(() => M.loadSubKpisPrev({ dateFrom: "2026-09-10", dateTo: "2026-09-14" }, { surface: "website", scope: null }))).toBeNull();
    log.length = 0;
    stubFetch((u) => (u.searchParams.get("cycle_offset") === "1" ? { body: { data: u.pathname === "/v1/kpi/engines" ? ENGINES : summaryData(), meta: meta({ as_of: "2026-09-07" }) } } : defaultHandler(u)), log);
    const prev = await withRequestScope(() => M.loadSubKpisPrev({}, { surface: "website", scope: null }));
    expect(prev?.asOf).toBe("2026-09-07");
    expect(log.filter((u) => u.searchParams.get("cycle_offset") === "1").map((u) => u.pathname).sort()).toEqual(["/v1/kpi/engines", "/v1/kpi/summary"]);
  });

  it("designated target brand = ProjectDetail.target_brand; hidden project -> null", async () => {
    expect(await M.loadDesignatedTargetBrand(PROJECT)).toBe("Toyota");
    expect(await M.loadDesignatedTargetBrand("11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("failure policy: backend 503 degrades (null + degrade label); 403 is thrown", async () => {
    stubFetch((u) => (u.pathname === "/v1/mentions/brands" ? { status: 503, body: { error: { code: "upstream", message: "x" } } } : defaultHandler(u)), log);
    await withRequestScope(async () => {
      expect(await M.loadMentionsLive({}, { surface: "global", scope: null })).toBeNull();
      expect(wasDegraded("globalMentions")).toBe(true);
    });
    stubFetch((u) => (u.pathname === "/v1/mentions/brands" ? { status: 403, body: { error: { code: "role_forbidden", message: "x" } } } : defaultHandler(u)), log);
    await withRequestScope(() => expect(M.loadMentionsLive({}, { surface: "global", scope: null })).rejects.toMatchObject({ status: 403 }));
  });
});

// ── known differences ───────────────────────────────────────────────────────

/** Declared differences of this adapter (A4 notice); each must be written in the module header. */
export const KNOWN_DIFF = [
  { id: "DC-01", reason: "engine[] empty = the default engine only (legacy: every engine)" },
  { id: "DC-05", reason: "prev Sub KPI = previous round (legacy: previous measure day)" },
  { id: "DC-08", reason: "trend series top 10 over the window; 12 rounds by default" },
  { id: "DC-12", reason: "handled by split_own (D13): own rows per perspective brand" },
  { id: "U6-N1", reason: "full brand list capped at 2000 competitor rows" },
  { id: "U6-N2", reason: "custom-field values of deleted prompts no longer offered" },
  { id: "U6-N3", reason: "unresolved brand (brand_key 0) is not a table row" },
];

describe("known differences are documented in the adapter header", () => {
  const src = readFileSync(fileURLToPath(new URL("./mentions.ts", import.meta.url)), "utf8");
  it.each(KNOWN_DIFF.map((k) => [k.id, k.reason] as const))("%s", (id) => {
    expect(src).toContain(id);
  });
  it("U6-N1: truncated list keeps the first 2000 (the flag is passed through the call)", () => {
    const big = { ...BRANDS, truncated: true };
    expect(M.toMentionsLive({ brands: { data: big, meta: meta() }, types: null, summary: null, trend: null })?.brands).toHaveLength(3);
  });
});
