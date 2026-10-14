import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type {
  EngineKpiTrend,
  FirstPositionResult,
  StandardSubKpis,
  StandardTrendBucket,
  TypeKpi,
} from "@/lib/db/repositories/scope-aggregates";

// KPI tab adapter (unit U6): hand-computed conversions, the loaders' queries (D6 second stage,
// period rules), and legacy/api parity: the UNCHANGED view functions of the KPI tabs
// (_data/kpi-view.ts: kpiHero, favorabilityHero, kpiTrendPoints, engineKpiBars, engineKpiSeries,
// engineCompetitorBars, favorabilityTrendPoints, typeComboPoints, typeKpiBars, typeSentimentRows,
// firstRankHero, rankTableRows) run on the legacy fetcher shapes of one WORLD and on the adapter
// output of the same WORLD. Differing paths must be declared (KNOWN_DIFF, with the reason).

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
const K = await import("./kpi-tab");
const M = await import("./mentions");
const { rankFirstPositionRows } = await import("@/lib/kpi/first-position-rank");
const V = await import("@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view");

type S = components["schemas"];
type Meta = S["Meta"];
type Series = S["TrendSeries"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const meta = (m: Partial<Meta> = {}): Meta => ({ mode: "snapshot", as_of: "2026-09-15", cycles: ["2026-09-15"], ...m });
const ratio = (num: number, den: number) => ({ num, den });

// ── WORLD ───────────────────────────────────────────────────────────────────
// Global rounds are Mondays: 09-01, 09-08 (collection error), 09-15. Two engines.

const ROUNDS = ["2026-09-01", "2026-09-08", "2026-09-15"] as const;
const MEASURED_DAYS = [2, 0, 3];
type V3 = [number, number] | null;
/** per round: [num, den] or null (gap round). */
const E = {
  chatgpt: {
    visibility: [[40, 120], null, [60, 110]] as V3[],
    share_of_voice: [[70, 250], null, [90, 250]] as V3[],
    sentiment: [[12, 25], null, [18, 30]] as V3[],
    negative: [3, 0, 3],
  },
  gemini: {
    visibility: [[20, 80], null, [40, 90]] as V3[],
    share_of_voice: [[30, 150], null, [60, 200]] as V3[],
    sentiment: [[8, 15], null, [12, 20]] as V3[],
    negative: [2, 0, 1],
  },
};
const sumPair = (a: V3, b: V3): V3 => (a && b ? [a[0] + b[0], a[1] + b[1]] : null);
const TOTAL = {
  visibility: ROUNDS.map((_, i) => sumPair(E.chatgpt.visibility[i], E.gemini.visibility[i])),
  share_of_voice: ROUNDS.map((_, i) => sumPair(E.chatgpt.share_of_voice[i], E.gemini.share_of_voice[i])),
  sentiment: ROUNDS.map((_, i) => sumPair(E.chatgpt.sentiment[i], E.gemini.sentiment[i])),
  position: [[30, 10], null, [25, 10]] as V3[],
};
const TYPES_BY_ROUND: Record<string, V3[]> = {
  mention: [[30, 200], null, [50, 200]],
  recommendation: [[10, 200], null, [12, 200]],
  comparison: [[0, 200], null, [0, 200]],
  definition: [[2, 200], null, [0, 200]],
  final_choice: [[0, 200], null, [1, 200]],
};

const buckets = () => ROUNDS.map((k, i) => ({ key: k, round_dates: [k], measured_days: MEASURED_DAYS[i] }));
function series(metric: string, key: string, vals: V3[], o: Partial<Series> = {}, negative?: number[]): Series {
  const kind = metric === "position" ? "rank" : "ratio";
  return {
    metric,
    code: null,
    kind,
    key,
    label: key || null,
    is_own: false,
    own_brand_code: null,
    brand_key: null,
    points: ROUNDS.map((b, i) => {
      const v = vals[i];
      if (!v) return { bucket: b, gap: true, gap_reason: "collection_error" };
      if (kind === "rank") return { bucket: b, gap: false, rank: { sum: v[0], count: v[1] } };
      return { bucket: b, gap: false, ratio: ratio(v[0], v[1]), ...(negative ? { negative: negative[i] } : {}) };
    }),
    ...o,
  } as Series;
}
const trend = (dimension: string, s: Series[]): S["TrendData"] =>
  ({ bucket: "cycle", dimension, own_label: "HMG", buckets: buckets(), series: s }) as unknown as S["TrendData"];

const NONE = trend("none", [
  series("visibility", "", TOTAL.visibility),
  series("share_of_voice", "", TOTAL.share_of_voice),
  series("sentiment", "", TOTAL.sentiment, {}, [5, 0, 4]),
  series("position", "", TOTAL.position),
]);
const ENGINE = trend(
  "engine",
  (["chatgpt", "gemini"] as const).flatMap((e) => [
    series("visibility", e, E[e].visibility),
    series("share_of_voice", e, E[e].share_of_voice),
    series("sentiment", e, E[e].sentiment, {}, E[e].negative),
  ]),
);
const TYPE = trend("type", Object.entries(TYPES_BY_ROUND).map(([t, v]) => series("type_exposure", t, v)));

const ENGINES: S["EnginesData"] = {
  engine_consistency: { citation_share: null, position: null, sentiment: null, share_of_voice: null, visibility: null },
  rows: [
    { engine: "chatgpt", answers: 110, tracked: 60, multi: 9, top1: 8, top3: 30, rank_sum: 40, ranked: 16, total_mentions: 250, tracked_mentions: 90, sent_mentions: 30, positive_mentions: 18, negative_mentions: 3, cit_total: 10, cit_owned: 1 },
    { engine: "gemini", answers: 90, tracked: 40, multi: 1, top1: 2, top3: 10, rank_sum: null, ranked: null, total_mentions: 200, tracked_mentions: 60, sent_mentions: 20, positive_mentions: 12, negative_mentions: 1, cit_total: null, cit_owned: null },
  ],
  total: { answers: 200, tracked: 100, multi: 10, top1: 10, top3: 40, rank_sum: 40, ranked: 16, total_mentions: 450, tracked_mentions: 150, sent_mentions: 50, positive_mentions: 30, negative_mentions: 4, cit_total: 10, cit_owned: 1 },
};

const brandItem = (name: string, own: boolean, exposure: [number, number], mentions: number, avg: [number, number] | null = null): S["BrandItem"] => ({
  name,
  is_own: own,
  own_brand_code: own ? name : null,
  brand_key: own ? null : name.length,
  mentions,
  exposure: ratio(exposure[0], exposure[1]),
  share: ratio(mentions, 450),
  avg_rank: avg ? { sum: avg[0], count: avg[1] } : null,
  rank: 1,
  sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0 },
});
const BY_ENGINE: S["BrandsData"] = {
  brands: [],
  own: { avg_rank: null, brands: ["Hyundai"], exposure: ratio(100, 200), mentions: 150, rank: 1, share: ratio(150, 450), vp_label: "Hyundai" },
  totals: { answers: 200, brand_count: 3, mentions_total: 450 },
  by_engine: [
    { engine: "chatgpt", totals: { answers: 110, brand_count: 2, mentions_total: 250 }, brands: [brandItem("Hyundai", true, [60, 110], 90), brandItem("Toyota", false, [30, 110], 50)] },
    { engine: "gemini", totals: { answers: 90, brand_count: 2, mentions_total: 200 }, brands: [brandItem("Hyundai", true, [40, 90], 60), brandItem("Toyota", false, [10, 90], 15)] },
  ],
};

function summaryData(o: Partial<S["SummaryData"]> = {}): S["SummaryData"] {
  return {
    visibility: ratio(100, 200),
    share_of_voice: ratio(150, 450),
    sentiment: ratio(30, 50),
    position: { sum: 25, count: 10 },
    citation_share: ratio(1, 10),
    target_url_rate: null,
    owned_url_rate: null,
    citation_accuracy: null,
    params: { answers: 200, applied_prompts: 80, measured_prompts: 70, prompts_without_brand: 5, measured_by_funnel: null },
    analysis_gap: { gap_answers: 0, base_answers: 200 },
    ...o,
  };
}

// ── the legacy fetcher shapes of the same WORLD ─────────────────────────────

const pctOrNull = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const enginePoint = (e: "chatgpt" | "gemini", i: number) => {
  const v = E[e].visibility[i]!;
  const s = E[e].share_of_voice[i]!;
  const t = E[e].sentiment[i]!;
  return {
    engine: e,
    answers: v[1],
    trackedAnswers: v[0],
    exposurePct: pctOrNull(v[0], v[1]),
    totalMentions: s[1],
    trackedMentions: s[0],
    sovPct: pctOrNull(s[0], s[1]),
    sentSignals: t[1],
    positiveSignals: t[0],
    negativeSignals: E[e].negative[i],
  };
};
/** legacy fetchStandardTrend (fact reader) slots: round-keyed ledger slots, firstAt/lastAt instants. */
function legacyOverviewSlots(): StandardTrendBucket[] {
  return ROUNDS.map((k, i) => {
    const v = TOTAL.visibility[i];
    if (!v) {
      return { bucketStart: k, roundDate: k, cycleAnchorAt: k, gridSlot: true, gap: { reason: "collection_error" }, answers: 0, trackedAnswers: 0, totalMentions: 0, trackedMentions: 0, sentMentions: 0, positiveMentions: 0, avgPosition: null, totalCitations: 0, ownedCitations: 0, measuredDays: 0, firstAt: null, lastAt: null };
    }
    const s = TOTAL.share_of_voice[i]!;
    const t = TOTAL.sentiment[i]!;
    const p = TOTAL.position[i]!;
    return {
      bucketStart: k,
      roundDate: k,
      cycleAnchorAt: k,
      gridSlot: true,
      answers: v[1],
      trackedAnswers: v[0],
      totalMentions: s[1],
      trackedMentions: s[0],
      sentMentions: t[1],
      positiveMentions: t[0],
      avgPosition: Math.round((p[0] / p[1]) * 10) / 10,
      totalCitations: 0,
      ownedCitations: 0,
      measuredDays: MEASURED_DAYS[i],
      firstAt: `${k}T01:00:00.000Z`,
      lastAt: `${k}T09:00:00.000Z`,
      engines: (["chatgpt", "gemini"] as const).map((e) => {
        const ev = E[e].visibility[i]!;
        const es = E[e].share_of_voice[i]!;
        const et = E[e].sentiment[i]!;
        return { engine: e, answers: ev[1], trackedAnswers: ev[0], totalMentions: es[1], trackedMentions: es[0], sentMentions: et[1], positiveMentions: et[0], rankSum: 0, rankedAnswers: 0 };
      }),
    };
  });
}
function legacyEngineTrend(): EngineKpiTrend {
  const valued = [0, 2];
  const slots = legacyOverviewSlots();
  return {
    unit: "week",
    engines: ["chatgpt", "gemini"],
    buckets: valued.map((i) => ({
      bucketStart: ROUNDS[i],
      measuredDays: MEASURED_DAYS[i],
      firstAt: `${ROUNDS[i]}T01:00:00.000Z`,
      lastAt: `${ROUNDS[i]}T09:00:00.000Z`,
      engines: [enginePoint("chatgpt", i), enginePoint("gemini", i)],
    })),
    latestBrands: [
      { engine: "chatgpt", brand: "Hyundai", isTracked: true, answersWithBrand: 60, mentions: 90 },
      { engine: "chatgpt", brand: "Toyota", isTracked: false, answersWithBrand: 30, mentions: 50 },
      { engine: "gemini", brand: "Hyundai", isTracked: true, answersWithBrand: 40, mentions: 60 },
      { engine: "gemini", brand: "Toyota", isTracked: false, answersWithBrand: 10, mentions: 15 },
    ],
    typeTrend: valued.map((i) => ({
      bucketStart: ROUNDS[i],
      answers: 200,
      byType: {
        mention: TYPES_BY_ROUND.mention[i]![0],
        recommendation: TYPES_BY_ROUND.recommendation[i]![0],
        comparison: TYPES_BY_ROUND.comparison[i]![0],
        definition: TYPES_BY_ROUND.definition[i]![0],
        final_choice: TYPES_BY_ROUND.final_choice[i]![0],
      },
    })),
    latest: [
      { engine: "chatgpt", answers: 110, trackedAnswers: 60, exposurePct: 54.5, totalMentions: 250, trackedMentions: 90, sovPct: 36, sentSignals: 30, positiveSignals: 18, negativeSignals: 3 },
      { engine: "gemini", answers: 90, trackedAnswers: 40, exposurePct: 44.4, totalMentions: 200, trackedMentions: 60, sovPct: 30, sentSignals: 20, positiveSignals: 12, negativeSignals: 1 },
    ],
    latestMeasuredAt: "2026-09-15T09:00:00.000Z",
    trendDegraded: false,
    windowStartBucket: null,
    windowEndBucket: null,
    trendGrid: ROUNDS.map((k, i) => ({ roundDate: k, anchorWeek: k, gapReason: i === 1 ? "hidden-collection-error" : null })),
    overviewSlots: slots,
    overviewDeltaSlots: slots,
  };
}

function apiEngineTrend(): EngineKpiTrend {
  return K.toEngineKpiTrend({
    engines: { data: ENGINES, meta: meta() },
    latestBrands: { data: BY_ENGINE, meta: meta() },
    engineTrend: { data: ENGINE, meta: meta() },
    typeTrend: { data: TYPE, meta: meta() },
    overview: { data: NONE, meta: meta() },
  });
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
function expectParity(legacy: unknown, api: unknown, known: { path: RegExp; reason: string }[] = []) {
  const d = diff(legacy, api);
  for (const p of d) expect(known.some((k) => k.path.test(p)), `undeclared difference ${p}`).toBe(true);
  for (const k of known) expect(d.some((p) => k.path.test(p)), `declared difference ${k.path} disappeared`).toBe(true);
}

/** U6-N5: trend slot instants are not in the API. */
const INSTANTS = { path: /(^|\.)(firstAt|lastAt)$/, reason: "U6-N5 firstAt/lastAt null (API has round dates and measured days only)" };

// ── conversions ──────────────────────────────────────────────────────────────

describe("hero sub KPI", () => {
  it("overviewCards from the summary pairs (position = round1(sum/count), count)", () => {
    expect(K.toOverviewCards(summaryData())).toEqual({
      visibility: { numerator: 100, denominator: 200 },
      shareOfVoice: { numerator: 150, denominator: 450 },
      sentiment: { numerator: 30, denominator: 50 },
      position: { avgPosition: 2.5, sampledAnswers: 10 },
      citationShare: { numerator: 1, denominator: 10 },
    });
  });
  it("suppressed or null hero field -> empty sub, never {0, 0} (kpiHero 측정 없음)", () => {
    const sup = K.toHeroSubKpis({ data: summaryData(), meta: meta({ suppressed: { share_of_voice: "hidden" } }) }, "sov");
    expect(sup).toEqual({ rows: [], promptsWithoutBrand: null, measuredPrompts: 70 });
    expect(V.kpiHero(sup, "sov").pct).toBeNull();
    const nul = K.toHeroSubKpis({ data: summaryData({ visibility: null }), meta: meta() }, "exposure");
    expect(nul.overviewCards).toBeUndefined();
    // the other hero still has its cards
    expect(K.toHeroSubKpis({ data: summaryData({ visibility: null }), meta: meta() }, "sov").overviewCards).toBeDefined();
  });
  it("parity: kpiHero on the legacy hero sub (overview cards of the same aggregates) and the adapter", () => {
    const legacySub: StandardSubKpis = {
      rows: [],
      promptsWithoutBrand: null,
      measuredPrompts: 70,
      overviewCards: {
        visibility: { numerator: 100, denominator: 200 },
        shareOfVoice: { numerator: 150, denominator: 450 },
        sentiment: { numerator: 30, denominator: 50 },
        position: { avgPosition: 2.5, sampledAnswers: 10 },
        citationShare: { numerator: 1, denominator: 10 },
      },
    };
    for (const metric of ["exposure", "sov"] as const) {
      const api = K.toHeroSubKpis({ data: summaryData(), meta: meta() }, metric);
      expectParity(V.kpiHero(legacySub, metric), V.kpiHero(api, metric));
    }
    // hand check: 150/450 = 33.3
    expect(V.kpiHero(K.toHeroSubKpis({ data: summaryData(), meta: meta() }, "sov"), "sov").pct).toBe(33.3);
  });
  it("favorability: engine rows only; positive and negative on one denominator (NegativeBasisNote gone)", () => {
    const sub = K.toFavorabilitySubKpis({ data: ENGINES, meta: meta() });
    expect(sub.overviewCards).toBeUndefined();
    expect(V.favorabilityHero(sub)).toEqual({ positivePct: 60, negativePct: 8, positive: 30, negative: 4, total: 50 });
    // legacy: positive from the overview card (same 30/50 here), negative from the mirror rows
    const legacy: StandardSubKpis = { ...sub, overviewCards: K.toOverviewCards(summaryData()) };
    expectParity(V.favorabilityHero(legacy), V.favorabilityHero(sub));
  });
  it("B036 parity: part=sov rows (rank detail and citation columns null) give the same hero and engine scalars", () => {
    // backend part=sov = core mentions only: multi / top1 / top3 / cit_total / cit_owned come back null
    const sovOnly: S["EnginesData"] = {
      ...ENGINES,
      rows: ENGINES.rows.map((r) => ({ ...r, multi: null, top1: null, top3: null, cit_total: null, cit_owned: null })),
    };
    expect(V.favorabilityHero(K.toFavorabilitySubKpis({ data: sovOnly, meta: meta() }))).toEqual(
      V.favorabilityHero(K.toFavorabilitySubKpis({ data: ENGINES, meta: meta() })),
    );
    expect(sovOnly.rows.map(K.toEnginePoint)).toEqual(ENGINES.rows.map(K.toEnginePoint));
    const t = (e: S["EnginesData"]) =>
      K.toEngineKpiTrend({ engines: { data: e, meta: meta() }, latestBrands: { data: BY_ENGINE, meta: meta() }, engineTrend: { data: ENGINE, meta: meta() }, typeTrend: { data: TYPE, meta: meta() }, overview: { data: NONE, meta: meta() } });
    for (const m of ["exposure", "sov"] as const) expectParity(V.engineKpiBars(t(ENGINES), m), V.engineKpiBars(t(sovOnly), m));
  });
  it("B4 parity: a parts=measured summary (applied, gap and URL fields null) gives the same hero cards", () => {
    const measuredOnly = summaryData({ analysis_gap: null, params: { ...summaryData().params, applied_prompts: null } });
    for (const metric of ["exposure", "sov"] as const) {
      expect(K.toHeroSubKpis({ data: measuredOnly, meta: meta() }, metric)).toEqual(K.toHeroSubKpis({ data: summaryData(), meta: meta() }, metric));
    }
  });
});

describe("engine trend", () => {
  it("engine buckets keyed by round date, gap round skipped, BG-09 negative, BG-10 measured days", () => {
    const { engines, buckets: b } = K.toEngineBuckets(ENGINE);
    expect(engines).toEqual(["chatgpt", "gemini"]);
    expect(b.map((x) => [x.bucketStart, x.measuredDays])).toEqual([
      ["2026-09-01", 2],
      ["2026-09-15", 3],
    ]);
    // chatgpt 09-01: 40/120 -> 33.3 ; 70/250 -> 28 ; sentiment 12/25, negative 3
    expect(b[0].engines[0]).toEqual({ engine: "chatgpt", answers: 120, trackedAnswers: 40, exposurePct: 33.3, totalMentions: 250, trackedMentions: 70, sovPct: 28, sentSignals: 25, positiveSignals: 12, negativeSignals: 3 });
  });
  it("type trend (BG-07): numerators by type, the denominator once", () => {
    expect(K.toTypeTrend(TYPE)).toEqual([
      { bucketStart: "2026-09-01", answers: 200, byType: { mention: 30, recommendation: 10, comparison: 0, definition: 2, final_choice: 0 } },
      { bucketStart: "2026-09-15", answers: 200, byType: { mention: 50, recommendation: 12, comparison: 0, definition: 0, final_choice: 1 } },
    ]);
  });
  it("latest scalars and engine x brand snapshot (BG-16)", () => {
    const t = apiEngineTrend();
    expect(t.latest[0]).toMatchObject({ engine: "chatgpt", exposurePct: 54.5, sovPct: 36, negativeSignals: 3 });
    expect(t.latestBrands).toEqual(legacyEngineTrend().latestBrands);
    expect([t.latestMeasuredAt, t.trendDegraded, t.overviewSlots === t.overviewDeltaSlots]).toEqual(["2026-09-15", false, true]);
  });
  it("a failed trend read keeps the scalars and marks trendDegraded (legacy C2)", () => {
    const t = K.toEngineKpiTrend({ engines: { data: ENGINES, meta: meta() }, latestBrands: null, engineTrend: null, typeTrend: null, overview: null });
    expect([t.trendDegraded, t.buckets, t.latest.length, t.overviewSlots]).toEqual([true, [], 2, undefined]);
  });
  it("B034: a failed engine × brand or type trend read marks trendDegraded too; the other values stay", () => {
    const ok = apiEngineTrend();
    const parts = { engines: { data: ENGINES, meta: meta() }, latestBrands: { data: BY_ENGINE, meta: meta() }, engineTrend: { data: ENGINE, meta: meta() }, typeTrend: { data: TYPE, meta: meta() }, overview: { data: NONE, meta: meta() } };
    const noType = K.toEngineKpiTrend({ ...parts, typeTrend: null });
    expect([noType.trendDegraded, noType.typeTrend]).toEqual([true, []]);
    expect({ ...noType, trendDegraded: false, typeTrend: ok.typeTrend }).toEqual(ok);
    const noBrands = K.toEngineKpiTrend({ ...parts, latestBrands: null });
    expect([noBrands.trendDegraded, noBrands.latestBrands]).toEqual([true, []]);
    expect({ ...noBrands, trendDegraded: false, latestBrands: ok.latestBrands }).toEqual(ok);
    // the type combo then says degradedTrend (legacy trend phase failure) instead of an empty chart
    expect(ok.trendDegraded).toBe(false);
  });
  it("B038: the type block of the dims call carries measured days, which toTypeTrend never reads", () => {
    const noDays = { ...TYPE, buckets: TYPE.buckets.map((b) => ({ ...b, measured_days: null })) } as S["TrendData"];
    expect(K.toTypeTrend(TYPE)).toEqual(K.toTypeTrend(noDays));
  });
  it("B038: engine_only by_engine answer (window-wide rows empty) gives the same engine × brand points", () => {
    const engineOnly: S["BrandsData"] = { ...BY_ENGINE, brands: [], totals: { answers: 0, brand_count: 0, mentions_total: 0 } };
    expect(K.toLatestBrands(engineOnly)).toEqual(K.toLatestBrands(BY_ENGINE));
  });

  const t = () => ({ legacy: legacyEngineTrend(), api: apiEngineTrend() });
  it.each(["exposure", "sov"] as const)("parity: kpiTrendPoints (%s)", (m) => {
    const { legacy, api } = t();
    expectParity(V.kpiTrendPoints(legacy, m), V.kpiTrendPoints(api, m), [INSTANTS]);
  });
  it.each(["exposure", "sov"] as const)("parity: engineKpiBars, engineKpiSeries, engineCompetitorBars (%s)", (m) => {
    const { legacy, api } = t();
    expectParity(V.engineKpiBars(legacy, m), V.engineKpiBars(api, m));
    expectParity(V.engineKpiSeries(legacy, m), V.engineKpiSeries(api, m));
    expectParity(V.engineCompetitorBars(legacy, m), V.engineCompetitorBars(api, m));
  });
  it("parity: favorabilityTrendPoints (negative from the engine buckets) and typeComboPoints", () => {
    const { legacy, api } = t();
    expectParity(V.favorabilityTrendPoints(legacy), V.favorabilityTrendPoints(api), [INSTANTS]);
    expectParity(V.typeComboPoints(legacy, null), V.typeComboPoints(api, null));
    // hand check: 09-15 negative (3+1) / sent (30+20) = 8% ; positive 30/50 = 60%
    const last = V.favorabilityTrendPoints(api).at(-1)!;
    expect([last.positivePct, last.negativePct]).toEqual([60, 8]);
  });
});

// ── types ───────────────────────────────────────────────────────────────────

const TYPES: S["app__features__analytics__mentions__types__schemas__TypesData"] = {
  answers_total: 200,
  by_type: [
    { type: "mention", own_mentions: 40, other_mentions: 20, own_answers: 30, other_answers: 15, own_exposure: ratio(30, 200), other_exposure: ratio(15, 200), own_share: ratio(40, 60) },
    { type: "recommendation", own_mentions: 1, other_mentions: 2, own_answers: 1, other_answers: 2, own_exposure: ratio(1, 200), other_exposure: ratio(2, 200), own_share: ratio(1, 3) },
    { type: "comparison", own_mentions: 0, other_mentions: 0, own_answers: 0, other_answers: 0, own_exposure: ratio(0, 200), other_exposure: ratio(0, 200), own_share: ratio(0, 0) },
    { type: "definition", own_mentions: 0, other_mentions: 5, own_answers: 0, other_answers: 5, own_exposure: ratio(0, 200), other_exposure: ratio(5, 200), own_share: ratio(0, 5) },
    { type: "final_choice", own_mentions: 2, other_mentions: 0, own_answers: 2, other_answers: 0, own_exposure: ratio(2, 200), other_exposure: ratio(0, 200), own_share: ratio(2, 2) },
  ],
  sentiment_matrix: [
    { type: "mention", scope: "own", rows: 30, positive: 10, neutral: 15, negative: 3, mixed: 2 },
    { type: "mention", scope: "all", rows: 45, positive: 12, neutral: 25, negative: 5, mixed: 3 },
  ],
  stance: { positive: 5, neutral: 3, mixed: 1, negative: 1, pairs: 10 },
};

describe("type KPI and stance", () => {
  const legacy: TypeKpi = {
    totalAnswers: 200,
    totalMentions: 70,
    ownMentions: 43,
    rows: [
      { type: "mention", ownMentions: 40, otherMentions: 20, totalMentions: 60, ownAnswers: 30, otherAnswers: 15, ownExposurePct: 15, otherExposurePct: 7.5, ownSharePct: 66.7 },
      { type: "recommendation", ownMentions: 1, otherMentions: 2, totalMentions: 3, ownAnswers: 1, otherAnswers: 2, ownExposurePct: 0.5, otherExposurePct: 1, ownSharePct: 33.3 },
      { type: "comparison", ownMentions: 0, otherMentions: 0, totalMentions: 0, ownAnswers: 0, otherAnswers: 0, ownExposurePct: 0, otherExposurePct: 0, ownSharePct: null },
      { type: "definition", ownMentions: 0, otherMentions: 5, totalMentions: 5, ownAnswers: 0, otherAnswers: 5, ownExposurePct: 0, otherExposurePct: 2.5, ownSharePct: 0 },
      { type: "final_choice", ownMentions: 2, otherMentions: 0, totalMentions: 2, ownAnswers: 2, otherAnswers: 0, ownExposurePct: 1, otherExposurePct: 0, ownSharePct: 100 },
    ],
    sentimentMatrix: {
      own: [
        { type: "mention", rows: 30, positive: 10, neutral: 15, negative: 3, mixed: 2 },
        ...(["recommendation", "comparison", "definition", "final_choice"] as const).map((type) => ({ type, rows: 0, positive: 0, neutral: 0, negative: 0, mixed: 0 })),
      ],
      all: [
        { type: "mention", rows: 45, positive: 12, neutral: 25, negative: 5, mixed: 3 },
        ...(["recommendation", "comparison", "definition", "final_choice"] as const).map((type) => ({ type, rows: 0, positive: 0, neutral: 0, negative: 0, mixed: 0 })),
      ],
    },
  };
  it("toTypeKpi equals the legacy TypeKpi of the same WORLD (hand-computed percents)", () => {
    expect(K.toTypeKpi(TYPES)).toEqual(legacy);
  });
  it("parity: typeKpiBars (both scopes, both metrics) and typeSentimentRows", () => {
    const api = K.toTypeKpi(TYPES);
    for (const metric of ["exposure", "sov"] as const) {
      for (const scope of ["own", "all"] as const) {
        expectParity(V.typeKpiBars({ kpi: legacy, metric, scope }), V.typeKpiBars({ kpi: api, metric, scope }));
      }
    }
    expectParity(V.typeSentimentRows(legacy, "own"), V.typeSentimentRows(api, "own"));
    expectParity(V.typeSentimentRows(legacy, "all"), V.typeSentimentRows(api, "all"));
  });
  it("stance distribution; none -> null", () => {
    expect(K.toStanceDist(TYPES)).toEqual({ positive: 5, neutral: 3, mixed: 1, negative: 1, pairs: 10 });
    expect(K.toStanceDist({ ...TYPES, stance: null })).toBeNull();
  });
});

// ── first rank ──────────────────────────────────────────────────────────────

describe("first rank", () => {
  it("competition rank on average position: ties share, the next is skipped, null last by mentions", () => {
    const rows = rankFirstPositionRows([
      { brand: "A", isTracked: false, avgPosition: 2, rankedAnswers: 5, mentions: 10 },
      { brand: "B", isTracked: false, avgPosition: 1.5, rankedAnswers: 5, mentions: 8 },
      { brand: "C", isTracked: true, avgPosition: 2, rankedAnswers: 5, mentions: 9 },
      { brand: "D", isTracked: false, avgPosition: null, rankedAnswers: 0, mentions: 1 },
      { brand: "E", isTracked: false, avgPosition: null, rankedAnswers: 0, mentions: 3 },
      { brand: "F", isTracked: false, avgPosition: 4, rankedAnswers: 1, mentions: 1 },
    ]);
    expect(rows.map((r) => [r.brand, r.rank])).toEqual([
      ["B", 1],
      ["A", 2],
      ["C", 2],
      ["F", 4],
      ["E", null],
      ["D", null],
    ]);
  });

  it("FA-2: ties and nulls order by code unit (the legacy rule), not by locale", () => {
    // localeCompare would put "audi" before "BMW" and "Ö" next to "O"; the legacy compares
    // UTF-16 code units: "BMW" < "Hyundai" < "audi", and "Z" < "Ö".
    const row = (brand: string, avgPosition: number | null, mentions = 1) => ({
      brand,
      isTracked: false,
      avgPosition,
      rankedAnswers: avgPosition === null ? 0 : 1,
      mentions,
    });
    const latest = K.toFirstPositionLatest(
      ["audi", "BMW", "Hyundai", "Öko", "Zeta"],
      {
        ...BY_ENGINE,
        by_engine: null,
        brands: [
          brandItem("audi", false, [1, 10], 1, [4, 2]),
          brandItem("BMW", false, [1, 10], 1, [4, 2]),
          brandItem("Hyundai", true, [1, 10], 1, [4, 2]),
          brandItem("Öko", false, [1, 10], 5, null),
          brandItem("Zeta", false, [1, 10], 5, null),
        ],
      },
    );
    expect(latest.map((r) => [r.brand, r.rank])).toEqual([
      ["BMW", 1],
      ["Hyundai", 1],
      ["audi", 1],
      ["Zeta", null],
      ["Öko", null],
    ]);
    const input = [row("audi", 2), row("BMW", 2), row("Öko", null, 3), row("Zeta", null, 3)];
    expect(K.toFirstPositionLatest(input.map((r) => r.brand), null).map((r) => r.brand)).toEqual(["BMW", "Zeta", "audi", "Öko"]);
    expect(rankFirstPositionRows(input).map((r) => r.brand)).toEqual(["BMW", "audi", "Zeta", "Öko"]);
  });

  // brand trend (position) for Hyundai (own split), Kia (own split), Toyota ; M-1 rows
  const BRAND_TREND = trend("brand", [
    series("position", "Hyundai", [[12, 6], null, [10, 5]], { is_own: true, own_brand_code: "Hyundai", label: "Hyundai" }),
    series("position", "Kia", [[9, 3], null, [8, 4]], { is_own: true, own_brand_code: "Kia", label: "Kia" }),
    series("position", "Toyota", [[4, 4], null, [3, 3]], { brand_key: 7 }),
  ]);
  const ROWS: S["BrandsData"] = {
    ...BY_ENGINE,
    by_engine: null,
    brands: [
      brandItem("Hyundai", true, [60, 200], 90, [10, 5]),
      brandItem("Toyota", false, [30, 200], 50, [3, 3]),
      brandItem("Kia", true, [40, 200], 60, [8, 4]),
    ],
  };
  const legacyFp = (): FirstPositionResult => ({
    unit: "week",
    brands: ["Hyundai", "Kia", "Toyota"],
    buckets: [0, 2].map((i) => ({
      bucketStart: ROUNDS[i],
      measuredDays: MEASURED_DAYS[i],
      firstAt: `${ROUNDS[i]}T01:00:00.000Z`,
      lastAt: `${ROUNDS[i]}T09:00:00.000Z`,
      brands: [
        { brand: "Hyundai", isTracked: true, avgPosition: i === 0 ? 2 : 2, rankedAnswers: i === 0 ? 6 : 5 },
        { brand: "Kia", isTracked: true, avgPosition: i === 0 ? 3 : 2, rankedAnswers: i === 0 ? 3 : 4 },
        { brand: "Toyota", isTracked: false, avgPosition: 1, rankedAnswers: i === 0 ? 4 : 3 },
      ],
    })),
    latest: [
      { brand: "Toyota", isTracked: false, avgPosition: 1, rank: 1, rankedAnswers: 3, mentions: 50 },
      { brand: "Hyundai", isTracked: true, avgPosition: 2, rank: 2, rankedAnswers: 5, mentions: 90 },
      { brand: "Kia", isTracked: true, avgPosition: 2, rank: 2, rankedAnswers: 4, mentions: 60 },
    ],
    trendGrid: ROUNDS.map((k, i) => ({ roundDate: k, anchorWeek: k, gapReason: i === 1 ? "hidden-collection-error" : null })),
    gapBuckets: ["2026-09-08"],
    windowStartBucket: "2026-09-01",
    windowEndBucket: "2026-09-15",
    overviewCards: K.toOverviewCards(summaryData()),
    overviewSlots: legacyOverviewSlots(),
    overviewDeltaSlots: legacyOverviewSlots(),
  } as FirstPositionResult);
  const apiFp = () =>
    K.toFirstPositionResultApi({
      trend: { data: BRAND_TREND, meta: meta() },
      brands: { data: ROWS, meta: meta() },
      summary: { data: summaryData(), meta: meta() },
      overview: { data: NONE, meta: meta() },
    });

  it("latest rows = the trend series (own first), values from M-1, re-ranked by position", () => {
    expect(apiFp().latest).toEqual(legacyFp().latest);
  });
  it("parity: firstRankHero and rankTableRows", () => {
    expectParity(V.firstRankHero(legacyFp()), V.firstRankHero(apiFp()));
    expectParity(V.rankTableRows(legacyFp()), V.rankTableRows(apiFp()));
  });
});

// ── loaders ─────────────────────────────────────────────────────────────────

describe("loaders: queries and period rules", () => {
  const log: URL[] = [];
  beforeEach(() => {
    log.length = 0;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        const url = new URL(String(u));
        log.push(url);
        const body = (() => {
          switch (url.pathname) {
            case "/v1/kpi/engines":
              return { data: ENGINES, meta: meta({ as_of: url.searchParams.get("cycle_offset") ? "2026-09-08" : "2026-09-15" }) };
            case "/v1/kpi/summary":
              return { data: summaryData(), meta: meta({ as_of: url.searchParams.get("cycle_offset") ? "2026-09-08" : "2026-09-15" }) };
            case "/v1/mentions/brands":
              return { data: url.searchParams.get("group_by") ? BY_ENGINE : ROWS_FOR_LOADER, meta: meta() };
            case "/v1/mentions/types":
              return { data: TYPES, meta: meta() };
            case "/v1/filters/dates":
              return { data: { dates: [], dates_truncated: false, first_measured_date: null, latest_round_date: null, presets: [] }, meta: meta() };
            case "/v1/trend": {
              const d = url.searchParams.get("dimension");
              const base = d === "engine" ? ENGINE : d === "type" ? TYPE : NONE;
              // B101 dims: each extra dimension as a block (series + meta), buckets shared
              const dims = url.searchParams.getAll("dims").map((item) => {
                const dim = item.split(/[:@]/)[0];
                return { dimension: dim, series: (dim === "type" ? TYPE : dim === "engine" ? ENGINE : NONE).series, meta: meta() };
              });
              return { data: dims.length ? { ...base, dims } : base, meta: meta() };
            }
            default:
              return { data: null, meta: meta() };
          }
        })();
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const ROWS_FOR_LOADER: S["BrandsData"] = { ...BY_ENGINE, by_engine: null, brands: [brandItem("Hyundai", true, [100, 200], 150, [25, 10])] };
  const ctx = { surface: "global" as const, scope: null };

  it("engine trend: engines part=sov, brands group_by=engine top 30 split own engine_only, trend engine+type (dims) and none on cycles", async () => {
    const t = await withRequestScope(() => K.loadEngineKpiTrend({}, ctx));
    expect(t?.trendDegraded).toBe(false);
    const by = (path: string, dim?: string) => log.filter((u) => u.pathname === path && (!dim || u.searchParams.get("dimension") === dim));
    // B036: the mention columns only (no rank detail, no citation columns)
    expect(by("/v1/kpi/engines").map((u) => [u.searchParams.get("part"), u.searchParams.getAll("parts")])).toEqual([["sov", []]]);
    const eb = by("/v1/mentions/brands").find((u) => u.searchParams.get("group_by"))!.searchParams;
    expect([eb.get("group_by"), eb.get("top_n"), eb.get("split_own"), eb.get("sort"), eb.get("engine_only")]).toEqual(["engine", "30", "true", "mentions", "true"]);
    expect(by("/v1/trend", "engine")[0].searchParams.getAll("metrics")).toEqual(["visibility", "share_of_voice", "sentiment"]);
    // B038: the type trend rides on the engine call (one window, base scan and measured days)
    expect(by("/v1/trend", "engine")[0].searchParams.getAll("dims")).toEqual(["type:type_exposure"]);
    expect(by("/v1/trend", "type")).toHaveLength(0);
    for (const u of by("/v1/trend")) expect(u.searchParams.get("bucket")).toBe("cycle");
    // engine and overview feed the coverage labels (measured days kept); none stays the D6 essential
    expect(by("/v1/trend").map((u) => [u.searchParams.get("dimension"), u.searchParams.get("measured_days")]).sort()).toEqual([
      ["engine", null],
      ["none", null],
    ]);
    const keys = log.map((u) => `${u.pathname}?${u.search}`);
    expect(new Set(keys).size).toBe(keys.length); // each distinct call once (request dedupe)
    // same EngineKpiTrend as the separate engine / type calls of the same WORLD
    expect(t).toEqual(apiEngineTrend());
  });

  it("B036: the hero, its previous round and the engine trend share one engines part (one call per offset)", async () => {
    await withRequestScope(() =>
      Promise.all([
        K.loadKpiHeroSubKpis({}, ctx, "favorability"),
        K.loadKpiHeroSubKpisPrev({}, ctx, "favorability"),
        K.loadEngineKpiTrend({}, ctx),
      ]),
    );
    const eng = log.filter((u) => u.pathname === "/v1/kpi/engines").map((u) => [u.searchParams.get("part"), u.searchParams.get("cycle_offset") ?? "0"]);
    expect(eng.sort()).toEqual([
      ["sov", "0"],
      ["sov", "1"],
    ]);
  });

  it("B4: the KPI tab and the mention body send the same summary parts, so one summary call serves them all", async () => {
    await withRequestScope(() =>
      Promise.all([
        K.loadKpiHeroSubKpis({}, ctx, "exposure"),
        K.loadKpiHeroSubKpis({}, ctx, "sov"),
        K.loadFirstPosition({}, ctx),
        M.loadMentionsLive({}, ctx),
      ]),
    );
    const summary = log.filter((u) => u.pathname === "/v1/kpi/summary");
    expect(summary.map((u) => u.searchParams.getAll("parts"))).toEqual([["measured"]]);
    log.length = 0;
    // the previous round: the D6 essential (offset 0) and the offset 1 read, both parts=measured
    await withRequestScope(() => K.loadKpiHeroSubKpisPrev({}, ctx, "sov"));
    const prev = log.filter((u) => u.pathname === "/v1/kpi/summary").map((u) => [u.searchParams.getAll("parts"), u.searchParams.get("cycle_offset") ?? "0"]);
    expect(prev.sort()).toEqual([
      [["measured"], "0"],
      [["measured"], "1"],
    ]);
  });

  it("B036: the type KPI skips the stance (include_stance=false); the stance card keeps it", async () => {
    await withRequestScope(() => K.loadTypeKpi({}, ctx));
    expect(log.filter((u) => u.pathname === "/v1/mentions/types").map((u) => u.searchParams.get("include_stance"))).toEqual(["false"]);
    log.length = 0;
    expect(await withRequestScope(() => K.loadStanceDist({}, ctx))).toEqual({ positive: 5, neutral: 3, mixed: 1, negative: 1, pairs: 10 });
    expect(log.filter((u) => u.pathname === "/v1/mentions/types").map((u) => u.searchParams.has("include_stance"))).toEqual([false]);
  });

  it("B034: wasKpiTabDegraded reads the hero / type marks of this request (5xx only)", async () => {
    const fail = (path: string) => {
      const ok = vi.mocked(fetch).getMockImplementation()!;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (u: string, init?: RequestInit) =>
          new URL(String(u)).pathname === path
            ? new Response(JSON.stringify({ error: { code: "upstream", message: "x" } }), { status: 503, headers: { "content-type": "application/json" } })
            : ok(u, init),
        ),
      );
    };
    await withRequestScope(async () => {
      await Promise.all([K.loadKpiHeroSubKpis({}, ctx, "exposure"), K.loadTypeKpi({}, ctx)]);
      expect([K.wasKpiTabDegraded("hero"), K.wasKpiTabDegraded("types")]).toEqual([false, false]);
    });
    fail("/v1/kpi/summary");
    await withRequestScope(async () => {
      expect(await K.loadKpiHeroSubKpis({}, ctx, "exposure")).toEqual({ rows: [], promptsWithoutBrand: null, measuredPrompts: null });
      expect([K.wasKpiTabDegraded("hero"), K.wasKpiTabDegraded("types")]).toEqual([true, false]);
    });
    fail("/v1/mentions/types");
    await withRequestScope(async () => {
      expect(await K.loadTypeKpi({}, ctx)).toBeNull();
      expect(K.wasKpiTabDegraded("types")).toBe(true);
    });
  });

  it("hero prev: period -> null without a call; snapshot -> cycle_offset=1, asOf = meta.as_of", async () => {
    expect(await withRequestScope(() => K.loadKpiHeroSubKpisPrev({ dateFrom: "2026-09-01", dateTo: "2026-09-15" }, ctx, "sov"))).toBeNull();
    expect(log).toHaveLength(0);
    const prev = await withRequestScope(() => K.loadKpiHeroSubKpisPrev({}, ctx, "exposure"));
    expect(prev?.asOf).toBe("2026-09-08");
    expect(log.some((u) => u.pathname === "/v1/kpi/summary" && u.searchParams.get("cycle_offset") === "1")).toBe(true);
    const fav = await withRequestScope(() => K.loadKpiHeroSubKpisPrev({}, ctx, "favorability"));
    expect(fav?.sub.rows).toHaveLength(2);
  });

  it("first position: trend brand call shares the B3 parameters with the bottom chart", async () => {
    const fp = await withRequestScope(() => K.loadFirstPosition({}, ctx));
    expect(fp?.overviewCards?.position).toEqual({ avgPosition: 2.5, sampledAnswers: 10 });
    const tb = log.find((u) => u.pathname === "/v1/trend" && u.searchParams.get("dimension") === "brand")!.searchParams;
    expect([tb.getAll("metrics"), tb.get("top"), tb.get("split_own"), tb.get("bucket"), tb.get("measured_days")]).toEqual([
      ["visibility", "share_of_voice", "position"],
      "10",
      "true",
      "cycle",
      null, // the brand coverage labels read measuredDays (kpi-view brandTrendChartData)
    ]);
  });
});

// ── known differences ───────────────────────────────────────────────────────

export const KNOWN_DIFF = [
  { id: "DC-01", reason: "engine[] empty = the default engine only" },
  { id: "DC-05", reason: "period mode has no prev sub; the round Δ covers the badge" },
  { id: "DC-08", reason: "brand series top 10 over the window; 12 rounds by default" },
  { id: "DC-12", reason: "split_own keeps own rows per perspective brand" },
  { id: "U6-N4", reason: "latestMeasuredAt is the round date" },
  { id: "U6-N5", reason: "trend bucket firstAt/lastAt null" },
  { id: "U6-N6", reason: "competitorValues overlay null (rows and values from one call)" },
];

describe("known differences are documented in the adapter header", () => {
  const src = readFileSync(fileURLToPath(new URL("./kpi-tab.ts", import.meta.url)), "utf8");
  it.each(KNOWN_DIFF.map((k) => [k.id] as const))("%s", (id) => {
    expect(src).toContain(id);
  });
  it("U6-N4: latestMeasuredAt differs from the legacy instant", () => {
    expect([legacyEngineTrend().latestMeasuredAt, apiEngineTrend().latestMeasuredAt]).toEqual(["2026-09-15T09:00:00.000Z", "2026-09-15"]);
  });
});
