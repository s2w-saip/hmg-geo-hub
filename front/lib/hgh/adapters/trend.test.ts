import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { BrandTrendResult, StandardTrendBucket } from "@/lib/db/repositories/scope-aggregates";
import type { TrendRequest, TrendResponse } from "./trend";

// Trend adapter (T-1): conversions checked against hand-computed values, then legacy/api
// parity by running the UNCHANGED legacy view builders on the same WORLD:
//   legacy: the legacy trend reader output (StandardTrendBucket[] as the aggregate reader
//           returns it on the anchor axis) fed through the real getLiveTrend /
//           getLiveWebsiteTrend (dashboard and website live.ts, reader mocked at
//           lib/scope/server) and applyTrendDeltas / overviewCardDelta; for the brand
//           dimension, a BrandTrendResult built by the legacy reader formulas fed through
//           the real brandTrendChart (kpi-view.ts);
//   api:    a T-1 answer for the same WORLD through lib/hgh/adapters/trend.ts.
// Differing paths must equal KNOWN_DIFF (with reasons); an undeclared difference fails and so
// does a declared one that disappears.

const reader = vi.hoisted(() => ({
  standard: [] as unknown[],
  website: [] as unknown[],
  accuracy: [] as unknown[],
}));
vi.mock("@/lib/scope/server", () => ({
  fetchStandardTrend: async () => reader.standard,
  fetchProjectTrend: async () => reader.standard,
  fetchWebsiteTrend: async () => reader.website,
  fetchWebsiteCitationAccuracyTrend: async () => reader.accuracy,
}));

const T = await import("./trend");
const { getLiveTrend, applyTrendDeltas } = await import("@/app/[locale]/(dash)/dashboard/_data/live");
const { getLiveWebsiteTrend } = await import("@/app/[locale]/(dash)/website/_data/live");
const { overviewCardDelta, overviewTrendValues } = await import("@/lib/kpi/overview-card-values");
const { brandTrendChart } = await import("@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view");
const { setAnchorAxisForTests, resetAnchorAxisForTests } = await import("@/lib/period/anchor-axis-state");

type S = components["schemas"];
type Point = S["app__features__analytics__trend__series__schemas__TrendPoint"];
type Ratio = S["Ratio"];

beforeAll(() => setAnchorAxisForTests(true)); // the API is anchor-axis only; legacy compared on the same axis
afterAll(() => resetAnchorAxisForTests());

// ── WORLD: four global rounds ────────────────────────────────────────────────
// r1 normal; r2 citations hidden for collection error (mention values alive); r3 whole round
// collection error; r4 normal.
const R = ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"] as const;
interface Counts {
  vis: [number, number];
  sov: [number, number];
  sen: [number, number];
  pos: [number, number];
  cit: [number, number];
  days: number;
}
const WORLD: (Counts | "gap-all" | (Omit<Counts, "cit"> & { cit: "gap" }))[] = [
  { vis: [60, 100], sov: [90, 300], sen: [40, 50], pos: [150, 60], cit: [12, 80], days: 2 },
  { vis: [50, 90], sov: [70, 250], sen: [30, 45], pos: [100, 50], cit: "gap", days: 1 },
  "gap-all",
  { vis: [66, 110], sov: [99, 330], sen: [44, 55], pos: [140, 66], cit: [15, 90], days: 2 },
];

const ratio = (p: [number, number]): Ratio => ({ num: p[0], den: p[1] });
const gapPoint = (bucket: string): Point => ({ bucket, gap: true, gap_reason: "collection_error", ratio: null, rank: null });

function apiOverview(): S["TrendData"] {
  const series = (metric: string, code: string, kind: "ratio" | "rank", pick: (c: Counts) => [number, number], citation = false) => ({
    metric,
    code,
    kind,
    key: null,
    points: WORLD.map((w, i): Point => {
      if (w === "gap-all") return gapPoint(R[i]);
      if (citation && w.cit === "gap") return gapPoint(R[i]);
      const c = w as Counts;
      return kind === "rank"
        ? { bucket: R[i], rank: { sum: pick(c)[0], count: pick(c)[1] } }
        : { bucket: R[i], ratio: ratio(pick(c)) };
    }),
  });
  return {
    bucket: "cycle",
    dimension: "none",
    own_label: "HMG",
    buckets: WORLD.map((w, i) => ({ key: R[i], round_dates: [R[i]], measured_days: w === "gap-all" ? 0 : w.days })),
    series: [
      series("visibility", "M01", "ratio", (c) => c.vis),
      series("share_of_voice", "M02", "ratio", (c) => c.sov),
      series("sentiment", "M03", "ratio", (c) => c.sen),
      series("position", "M04", "rank", (c) => c.pos),
      series("citation_share", "M05", "ratio", (c) => c.cit, true),
    ],
  };
}

/** The legacy aggregate reader's buckets for the WORLD (anchor axis: cycle anchors, grid slots). */
function legacyOverviewBuckets(): StandardTrendBucket[] {
  return WORLD.map((w, i) => {
    const base = { bucketStart: R[i], cycleAnchorAt: R[i], roundDate: R[i], gridSlot: true as const };
    if (w === "gap-all") {
      return {
        ...base,
        gap: { reason: "collection_error" },
        answers: 0, trackedAnswers: 0, totalMentions: 0, trackedMentions: 0, sentMentions: 0, positiveMentions: 0,
        avgPosition: null, totalCitations: 0, ownedCitations: 0, measuredDays: 0, firstAt: null, lastAt: null,
      };
    }
    const citGap = w.cit === "gap";
    const cit = citGap ? [0, 0] : (w.cit as [number, number]);
    return {
      ...base,
      ...(citGap ? { gap: { reason: "collection_error" as const, scope: "citations" as const } } : {}),
      answers: w.vis[1],
      trackedAnswers: w.vis[0],
      totalMentions: w.sov[1],
      trackedMentions: w.sov[0],
      sentMentions: w.sen[1],
      positiveMentions: w.sen[0],
      // legacy reader: round1(rank_sum / ranked)
      avgPosition: Math.round((w.pos[0] / w.pos[1]) * 10) / 10,
      totalCitations: cit[1],
      ownedCitations: cit[0],
      measuredDays: w.days,
      firstAt: `${R[i]}T00:10:00.000Z`,
      lastAt: `${R[i]}T20:00:00.000Z`,
    };
  });
}

// ── conversions (hand-computed) ──────────────────────────────────────────────

describe("toStandardTrendBuckets / toLiveTrend: hand-computed values", () => {
  it("counts, gaps and labels per slot", () => {
    const b = T.toStandardTrendBuckets(apiOverview());
    expect(b.map((x) => [x.bucketStart, x.cycleAnchorAt, x.roundDate, x.gridSlot])).toEqual(R.map((r) => [r, r, r, true]));
    expect(b[0]).toMatchObject({ answers: 100, trackedAnswers: 60, totalMentions: 300, trackedMentions: 90, sentMentions: 50, positiveMentions: 40, avgPosition: 2.5, totalCitations: 80, ownedCitations: 12, measuredDays: 2 });
    expect(b[0].gap).toBeUndefined();
    expect(b[1].gap).toEqual({ reason: "collection_error", scope: "citations" }); // only M05 gapped
    expect(b[2].gap).toEqual({ reason: "collection_error" }); // scope "all" = no scope (trend-gap contract)
    expect(b[2].answers).toBe(0);
    expect(b[3].avgPosition).toBe(2.1); // 140 / 66 = 2.12 -> 2.1
  });

  it("LiveTrend values: r1 60/30/80/2.5/15, r2 55.6/28/66.7/2 (no citation), r3 empty gap, r4 60/30/80/2.1/16.7", () => {
    const t = T.toLiveTrend(apiOverview(), { unit: "day" });
    expect(t.unit).toBe("day");
    expect(t.axis).toBe("anchor");
    expect(t.points.map((p) => p.values)).toEqual([
      { visibility: 60, shareOfVoice: 30, sentiment: 80, position: 2.5, citationShare: 15 },
      // 50/90 = 0.5556 -> 55.6 ; 30/45 -> round1(66.67) = 66.7
      { visibility: 55.6, shareOfVoice: 28, sentiment: 66.7, position: 2 },
      {},
      // 15/90 = 0.1667 -> 16.7
      { visibility: 60, shareOfVoice: 30, sentiment: 80, position: 2.1, citationShare: 16.7 },
    ]);
    expect(t.points[2]).toMatchObject({ answers: 0, gap: { reason: "collection_error" } });
    expect(t.totalAnswers).toBe(100 + 90 + 110);
    expect(t.lastMeasuredAt).toBe("2026-09-14");
  });

  it("Δ with the legacy applyTrendDeltas: last two valued points (r4 vs r2; citation r4 vs r1)", () => {
    const kpis = (["visibility", "shareOfVoice", "sentiment", "position", "citationShare"] as const).map((key) => ({
      key,
      value: 0,
      delta: null,
      direction: "flat" as const,
    }));
    const out = applyTrendDeltas(kpis, T.toLiveTrend(apiOverview()));
    // 60 - 55.6 = 4.4 ; 30 - 28 = 2 ; 80 - 66.7 = 13.3 ; 2.1 - 2 = 0.1 ; 16.7 - 15 = 1.7
    expect(out.map((k) => [k.key, k.delta, k.direction])).toEqual([
      ["visibility", 4.4, "up"],
      ["shareOfVoice", 2, "up"],
      ["sentiment", 13.3, "up"],
      ["position", 0.1, "up"],
      ["citationShare", 1.7, "up"],
    ]);
  });

  it("gap vocabulary: collection_error -> collection_error, hidden -> not_published, others no marker", () => {
    expect(T.pointGap({ bucket: R[0], gap: true, gap_reason: "collection_error" })).toEqual({ reason: "collection_error" });
    expect(T.pointGap({ bucket: R[0], gap: true, gap_reason: "hidden" })).toEqual({ reason: "not_published" });
    expect(T.pointGap({ bucket: R[0], gap: true, gap_reason: "no_answer" })).toBeUndefined();
    expect(T.pointGap({ bucket: R[0], gap: true, gap_reason: "analysis_pending" })).toBeUndefined();
  });

  it("WU-6 grid: a slot without a mention value is the legacy no-value gap; citation-only no_answer stays unmarked", () => {
    const idx = (p: Point) => new Map([[R[0], p]]);
    const noAns: Point = { bucket: R[0], gap: true, gap_reason: "no_answer" };
    const value: Point = { bucket: R[0], ratio: { num: 1, den: 2 } };
    const series = (m: Point, c: Point) => new Map([["visibility", idx(m)], ["citation_share", idx(c)]]);
    expect(T.bucketGap(series(noAns, noAns), R[0])).toEqual({ reason: "no_value" });
    expect(T.bucketGap(series({ ...noAns, gap_reason: "analysis_pending" }, noAns), R[0])).toEqual({ reason: "no_value" });
    expect(T.bucketGap(series(value, noAns), R[0])).toBeUndefined();
    // a hidden (unpublished) slot keeps its own marker; collection_error wins over no value
    expect(T.bucketGap(series({ ...noAns, gap_reason: "hidden" }, noAns), R[0])).toEqual({ reason: "not_published" });
    expect(T.bucketGap(series(noAns, { ...noAns, gap_reason: "collection_error" }), R[0])).toEqual({
      reason: "collection_error",
      scope: "citations",
    });
  });

  it("engine breakdown attaches per-engine counts", () => {
    const engine: S["TrendData"] = {
      ...apiOverview(),
      dimension: "engine",
      series: [
        { metric: "visibility", kind: "ratio", key: "chatgpt", points: [{ bucket: R[0], ratio: { num: 30, den: 50 } }] },
        { metric: "position", kind: "rank", key: "chatgpt", points: [{ bucket: R[0], rank: { sum: 70, count: 30 } }] },
        { metric: "visibility", kind: "ratio", key: "gemini", points: [{ bucket: R[0], ratio: { num: 30, den: 50 } }] },
      ],
    };
    const out = T.withEngineBreakdown(T.toStandardTrendBuckets(apiOverview()), engine);
    expect(out[0].engines).toEqual([
      { engine: "chatgpt", answers: 50, trackedAnswers: 30, totalMentions: 0, trackedMentions: 0, sentMentions: 0, positiveMentions: 0, rankSum: 70, rankedAnswers: 30 },
      { engine: "gemini", answers: 50, trackedAnswers: 30, totalMentions: 0, trackedMentions: 0, sentMentions: 0, positiveMentions: 0, rankSum: 0, rankedAnswers: 0 },
    ]);
    expect(out[1].engines).toBeUndefined();
  });
});

// ── parity: dashboard (global, cycle) ────────────────────────────────────────

type Diff = { path: RegExp; reason: string };
function diffJson(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return [path || "(root)"];
  if (Array.isArray(a) !== Array.isArray(b)) return [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    if (av === undefined && bv === undefined) continue;
    out.push(...diffJson(av, bv, path ? `${path}.${k}` : k));
  }
  return out;
}
function expectOnlyKnown(diff: string[], declared: Diff[]): void {
  for (const p of diff) expect(declared.some((d) => d.path.test(p)), `undeclared difference ${p}`).toBe(true);
  for (const d of declared) expect(diff.some((p) => d.path.test(p)), `declared difference ${d.path} disappeared`).toBe(true);
}

const LIVE_TREND_KNOWN_DIFF: Diff[] = [
  { path: /^points\.\d+\.(firstAt|lastAt)$/, reason: "first/last measurement instants are not in the API (null); labels use the round date on the anchor axis" },
  { path: /^points\.2\.roundDate$/, reason: "a gap slot keeps its ledger round date (legacy empty points had only bucketStart); the label is the same date" },
  { path: /^lastMeasuredAt$/, reason: "legacy: last measurement instant; API: last valued slot's round date" },
  // S1-N2 (sync S1): hmg-geo 2670a16 live.ts carries the bucket's cycleAnchorAt into LiveTrend points
  // (x axis label only). The API LiveTrend is always axis "anchor", where the chart labels with
  // the round date and never reads it; only the dashboard card sparkline does (trend.ts S1-N2).
  { path: /^points\.\d+\.cycleAnchorAt$/, reason: "S1-N2: LiveTrend points carry no cycleAnchorAt (label = round date)" },
];

describe("legacy/api parity: dashboard trend (getLiveTrend + applyTrendDeltas + overviewCardDelta)", () => {
  it("LiveTrend", async () => {
    reader.standard = legacyOverviewBuckets();
    const legacy = await getLiveTrend({}, "day");
    const api = T.toLiveTrend(apiOverview(), { unit: "day" });
    expectOnlyKnown(diffJson(legacy, api), LIVE_TREND_KNOWN_DIFF);
  });

  it("card Δ (applyTrendDeltas) identical", async () => {
    reader.standard = legacyOverviewBuckets();
    const legacy = await getLiveTrend({}, "day");
    const kpis = (["visibility", "shareOfVoice", "sentiment", "position", "citationShare"] as const).map((key) => ({
      key,
      value: 1,
      delta: null,
      direction: "flat" as const,
    }));
    expect(applyTrendDeltas(kpis, T.toLiveTrend(apiOverview(), { unit: "day" }))).toEqual(applyTrendDeltas(kpis, legacy));
  });

  it("mention-screen Δ (overviewCardDelta) and slot values identical on the bucket arrays", () => {
    const legacy = legacyOverviewBuckets();
    const api = T.toStandardTrendBuckets(apiOverview());
    for (const key of ["visibility", "shareOfVoice", "sentiment", "position", "citationShare"] as const) {
      expect(overviewCardDelta(api, key)).toEqual(overviewCardDelta(legacy, key));
    }
    expect(api.map(overviewTrendValues)).toEqual(legacy.map(overviewTrendValues));
  });
});

// ── parity: website (week buckets, M06/M07, published origin) ─────────────────

const W = ["2026-08-31", "2026-09-07"] as const; // week keys (Mondays)
const WR = ["2026-09-04", "2026-09-11"] as const; // Friday rounds

function apiWebsite(): S["TrendData"] {
  const r = (num: number, den: number): Ratio => ({ num, den });
  const s = (metric: string, pts: (Ratio | null)[], origin?: ("report" | "live")[]) => ({
    metric,
    kind: "ratio" as const,
    key: null,
    points: pts.map((p, i): Point => ({ bucket: W[i], ratio: p, ...(origin ? { origin: origin[i] } : {}) })),
  });
  return {
    bucket: "week",
    dimension: "none",
    own_label: "Kia",
    buckets: W.map((k, i) => ({ key: k, round_dates: [WR[i]], measured_days: 1 })),
    series: [
      s("visibility", [r(40, 80), r(45, 90)]),
      s("share_of_voice", [r(50, 200), r(60, 240)]),
      s("sentiment", [r(20, 30), r(21, 30)]),
      { metric: "position", kind: "rank", key: null, points: W.map((b, i) => ({ bucket: b, rank: i ? { sum: 81, count: 45 } : { sum: 60, count: 40 } })) },
      s("citation_share", [r(9, 60), r(8, 64)]),
      s("target_url_rate", [r(6, 80), r(7, 90)], ["report", "live"]),
      s("owned_url_rate", [r(12, 80), r(13, 90)], ["report", "live"]),
    ],
  };
}

function legacyWebsite(): { buckets: StandardTrendBucket[]; accuracy: unknown[] } {
  const b = (i: number, c: Omit<StandardTrendBucket, "bucketStart" | "roundDate" | "cycleAnchorAt" | "gridSlot" | "firstAt" | "lastAt" | "measuredDays">): StandardTrendBucket => ({
    bucketStart: W[i],
    roundDate: WR[i],
    cycleAnchorAt: WR[i],
    gridSlot: true,
    firstAt: `${WR[i]}T01:00:00.000Z`,
    lastAt: `${WR[i]}T09:00:00.000Z`,
    measuredDays: 1,
    ...c,
  });
  return {
    buckets: [
      b(0, { answers: 80, trackedAnswers: 40, totalMentions: 200, trackedMentions: 50, sentMentions: 30, positiveMentions: 20, avgPosition: 1.5, totalCitations: 60, ownedCitations: 9 }),
      b(1, { answers: 90, trackedAnswers: 45, totalMentions: 240, trackedMentions: 60, sentMentions: 30, positiveMentions: 21, avgPosition: 1.8, totalCitations: 64, ownedCitations: 8 }),
    ],
    // legacy ⑥ trend: rate = round1(100 * target / owned)
    accuracy: [
      { bucketStart: W[0], ownedAnswers: 12, targetAnswers: 6, rate: 50, measuredDays: 1, firstAt: null, lastAt: null },
      { bucketStart: W[1], ownedAnswers: 13, targetAnswers: 7, rate: 53.8, measuredDays: 1, firstAt: null, lastAt: null },
    ],
  };
}

describe("legacy/api parity: website trend (getLiveWebsiteTrend)", () => {
  it("LiveTrend incl. citationAccuracy; urlRateOrigin is the published-value flag", async () => {
    const l = legacyWebsite();
    reader.website = l.buckets;
    reader.accuracy = l.accuracy;
    const legacy = await getLiveWebsiteTrend({}, "week");
    const api = T.toLiveTrend(apiWebsite(), { unit: "week" });
    expect(api.points.map((p) => p.values.citationAccuracy)).toEqual([50, 53.8]); // 6/12, 7/13 = 53.85 -> 53.8
    expect(api.points.map((p) => p.urlRateOrigin)).toEqual(["report", "live"]);
    expectOnlyKnown(diffJson(legacy, api), [
      { path: /^points\.\d+\.(firstAt|lastAt)$/, reason: "not in the API" },
      { path: /^points\.\d+\.urlRateOrigin$/, reason: "new flag: M06/M07 value source per slot (report = published, live)" },
      { path: /^lastMeasuredAt$/, reason: "instant vs round date" },
      { path: /^points\.\d+\.cycleAnchorAt$/, reason: "S1-N2: no cycleAnchorAt on API LiveTrend points (week buckets carry none either)" },
    ]);
  });

  it("WU-9: the citation_accuracy series (live answers) wins over M06/M07 numerators on a published round", async () => {
    // Round 0 is published: M06/M07 carry report prompt counts (10/15, 12/15), whose numerators
    // would give 10/12 = 83.3. The legacy ⑥ line never reads the report: live 6/12 = 50.
    const data = apiWebsite();
    const r = (num: number, den: number): Ratio => ({ num, den });
    data.series = data.series.map((x) =>
      x.metric === "target_url_rate" ? { ...x, points: [{ ...x.points[0], ratio: r(10, 15) }, x.points[1]] }
        : x.metric === "owned_url_rate" ? { ...x, points: [{ ...x.points[0], ratio: r(12, 15) }, x.points[1]] }
          : x,
    );
    const without = T.toLiveTrend(data, { unit: "week" });
    expect(without.points[0].values.citationAccuracy).toBe(83.3); // the numerator rule mixes units here
    data.series.push({
      metric: "citation_accuracy",
      code: "ACC",
      kind: "ratio",
      key: null,
      points: [{ bucket: W[0], ratio: r(6, 12) }, { bucket: W[1], ratio: r(7, 13) }],
    });
    const l = legacyWebsite();
    reader.website = l.buckets;
    reader.accuracy = l.accuracy;
    const legacy = await getLiveWebsiteTrend({}, "week");
    const api = T.toLiveTrend(data, { unit: "week" });
    expect(api.points.map((p) => p.values.citationAccuracy)).toEqual([50, 53.8]);
    expect(legacy?.points.map((p) => p.values.citationAccuracy)).toEqual([50, 53.8]);
    // a slot without an accuracy point (den 0 = no owned-URL answer) draws no ⑥ value, the legacy null rate
    data.series[data.series.length - 1].points[1] = { bucket: W[1], ratio: null };
    expect(T.toLiveTrend(data, { unit: "week" }).points[1].values.citationAccuracy).toBeUndefined();
  });

  it("WU-9: the website trend requests the accuracy series, the project keeps M01..M07", () => {
    expect(T.WEBSITE_TREND_METRICS).toEqual([...T.URL_TREND_METRICS, "citation_accuracy"]);
    expect(T.URL_TREND_METRICS).not.toContain("citation_accuracy");
  });
});

// ── brand dimension (split_own, colours, legacy brand chart parity) ────────────

function apiBrand(): S["TrendData"] {
  const pts = (vals: [number, number][]) => vals.map((v, i): Point => ({ bucket: R[i], ratio: { num: v[0], den: v[1] } }));
  return {
    bucket: "cycle",
    dimension: "brand",
    own_label: "HMG",
    buckets: [0, 1, 2].map((i) => ({ key: R[i], round_dates: [R[i]], measured_days: i === 2 ? 0 : 1 })),
    series: [
      // split_own: one own series per perspective brand
      { metric: "visibility", kind: "ratio", key: "Hyundai", is_own: true, own_brand_code: "Hyundai", brand_key: 11, label: "HMG", points: [...pts([[30, 100], [35, 100]]), gapPoint(R[2])] },
      { metric: "visibility", kind: "ratio", key: "Kia", is_own: true, own_brand_code: "Kia", brand_key: 12, label: "HMG", points: [...pts([[20, 100], [25, 100]]), gapPoint(R[2])] },
      { metric: "visibility", kind: "ratio", key: "Toyota", is_own: false, brand_key: 40, label: "Toyota", points: [...pts([[50, 100], [45, 100]]), gapPoint(R[2])] },
      { metric: "share_of_voice", kind: "ratio", key: "Hyundai", is_own: true, own_brand_code: "Hyundai", brand_key: 11, points: [...pts([[40, 200], [44, 210]]), gapPoint(R[2])] },
      { metric: "share_of_voice", kind: "ratio", key: "Kia", is_own: true, own_brand_code: "Kia", brand_key: 12, points: [...pts([[30, 200], [31, 210]]), gapPoint(R[2])] },
      { metric: "share_of_voice", kind: "ratio", key: "Toyota", is_own: false, brand_key: 40, label: "Toyota", points: [...pts([[70, 200], [63, 210]]), gapPoint(R[2])] },
    ],
  };
}

describe("brand dimension: series views (split own, colours, keys)", () => {
  it("own series first per metric, labels = perspective brand, own colours fixed, competitors by position", () => {
    const v = T.toSeriesViews(apiBrand()).filter((s) => s.metric === "visibility");
    expect(v.map((s) => [s.key, s.label, s.isOwn, s.brandKey, s.colorIndex, s.color])).toEqual([
      ["Hyundai", "Hyundai", true, 11, 0, "var(--color-own-hyundai)"],
      ["Kia", "Kia", true, 12, 1, "var(--color-own-kia)"],
      ["Toyota", "Toyota", false, 40, 2, "var(--color-series-3)"],
    ]);
    // mirror percent: 30/100 = 30 ; gap slot -> null value + marker
    expect(v[0].points.map((p) => p.value)).toEqual([30, 35, null]);
    expect(v[0].points[2].gap).toEqual({ reason: "collection_error" });
  });

  it("mixed API order: own series first (Hyundai, Kia, Genesis), competitors keep API order; colour indexes follow", () => {
    const d = apiBrand();
    const s = (key: string, own: boolean, bk: number) => ({
      metric: "visibility",
      kind: "ratio" as const,
      key,
      is_own: own,
      ...(own ? { own_brand_code: key } : { label: key }),
      brand_key: bk,
      points: [{ bucket: R[0], ratio: { num: bk, den: 100 } }],
    });
    d.series = [s("Toyota", false, 40), s("Hyundai", true, 11), s("Honda", false, 41), s("Kia", true, 12), s("Genesis", true, 13)];
    const v = T.toSeriesViews(d);
    expect(v.map((x) => [x.key, x.isOwn, x.colorIndex, x.color])).toEqual([
      ["Hyundai", true, 0, "var(--color-own-hyundai)"],
      ["Kia", true, 1, "var(--color-own-kia)"],
      ["Genesis", true, 2, "var(--color-own-genesis)"],
      ["Toyota", false, 3, "var(--color-series-4)"],
      ["Honda", false, 4, "var(--color-series-5)"],
    ]);
    expect(T.toBrandTrendResult(d).brands.map((b) => [b.brand, b.isTracked])).toEqual([
      ["Hyundai", true],
      ["Kia", true],
      ["Genesis", true],
      ["Toyota", false],
      ["Honda", false],
    ]);
    expect(T.toBrandTrendResult(d).buckets[0].brands.map((b) => [b.brand, b.exposurePct])).toEqual([
      ["Hyundai", 11],
      ["Kia", 12],
      ["Genesis", 13],
      ["Toyota", 40],
      ["Honda", 41],
    ]);
  });

  it("merged own (single perspective or split_own off) is labelled with own_label", () => {
    const d = apiBrand();
    d.series = [{ metric: "visibility", kind: "ratio", key: "own", is_own: true, points: [] }];
    expect(T.toSeriesViews(d)[0]).toMatchObject({ key: "own", label: "HMG", color: "var(--color-own-hyundai)" });
  });

  it("toBrandTrendResult: brands, bucket counts, trend grid (gap slot), mentions from SOV numerators", () => {
    const r = T.toBrandTrendResult(apiBrand());
    expect(r.brands).toEqual([
      { brand: "Hyundai", isTracked: true, mentions: 84 }, // 40 + 44
      { brand: "Kia", isTracked: true, mentions: 61 },
      { brand: "Toyota", isTracked: false, mentions: 133 },
    ]);
    expect(r.buckets.map((b) => b.bucketStart)).toEqual([R[0], R[1]]); // the gap slot has no answers
    expect(r.buckets[1].brands[2]).toEqual({ brand: "Toyota", isTracked: false, mentions: 63, answers: 45, exposurePct: 45, sharePct: 30 });
    expect(r.trendGrid).toEqual([
      { roundDate: R[0], anchorWeek: R[0], gapReason: null },
      { roundDate: R[1], anchorWeek: R[1], gapReason: null },
      { roundDate: R[2], anchorWeek: R[2], gapReason: "hidden-collection-error" },
    ]);
    expect(r.gapBuckets).toEqual([R[2]]);
  });

  it("parity with the legacy brand chart (brandTrendChart on the legacy reader shape)", () => {
    // Legacy reader (aggregateBrandTrendFromMirror): pctOrNull = Math.round(n/d*1000)/10, buckets
    // only where answers exist, grid slots from the ledger (withKpiTrendGaps).
    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
    const legacy: BrandTrendResult = {
      unit: "week",
      brands: [
        { brand: "Hyundai", isTracked: true, mentions: 84 },
        { brand: "Kia", isTracked: true, mentions: 61 },
        { brand: "Toyota", isTracked: false, mentions: 133 },
      ],
      buckets: [
        { bucketStart: R[0], answers: 100, totalMentions: 200, measuredDays: 1, firstAt: "x", lastAt: "y", brands: [
          { brand: "Hyundai", isTracked: true, mentions: 40, answers: 30, exposurePct: pct(30, 100), sharePct: pct(40, 200) },
          { brand: "Kia", isTracked: true, mentions: 30, answers: 20, exposurePct: pct(20, 100), sharePct: pct(30, 200) },
          { brand: "Toyota", isTracked: false, mentions: 70, answers: 50, exposurePct: pct(50, 100), sharePct: pct(70, 200) },
        ] },
        { bucketStart: R[1], answers: 100, totalMentions: 210, measuredDays: 1, firstAt: "x", lastAt: "y", brands: [
          { brand: "Hyundai", isTracked: true, mentions: 44, answers: 35, exposurePct: pct(35, 100), sharePct: pct(44, 210) },
          { brand: "Kia", isTracked: true, mentions: 31, answers: 25, exposurePct: pct(25, 100), sharePct: pct(31, 210) },
          { brand: "Toyota", isTracked: false, mentions: 63, answers: 45, exposurePct: pct(45, 100), sharePct: pct(63, 210) },
        ] },
      ],
      windowStartBucket: R[0],
      windowEndBucket: R[2],
      gapBuckets: [R[2]],
      trendGrid: [
        { roundDate: R[0], anchorWeek: R[0], gapReason: null },
        { roundDate: R[1], anchorWeek: R[1], gapReason: null },
        { roundDate: R[2], anchorWeek: R[2], gapReason: "hidden-collection-error" },
      ],
    };
    const rows = legacy.brands.map((b) => ({ brand: b.brand, isTracked: b.isTracked, pct: null, mentions: null, spark: [], wowPp: null, gapPp: null, inTrendSeries: true }));
    const api = T.toBrandTrendResult(apiBrand());
    for (const metric of ["exposure", "share"] as const) {
      expect(brandTrendChart(rows, api, metric)).toEqual(brandTrendChart(rows, legacy, metric));
    }
  });

  it("toFirstPositionResult: per-brand average rank per slot", () => {
    const d = apiBrand();
    d.series = [
      { metric: "position", kind: "rank", key: "Hyundai", is_own: true, own_brand_code: "Hyundai", points: [{ bucket: R[0], rank: { sum: 45, count: 30 } }, { bucket: R[1], rank: { sum: 70, count: 35 } }] },
      { metric: "position", kind: "rank", key: "Toyota", is_own: false, label: "Toyota", points: [{ bucket: R[0], rank: { sum: 100, count: 50 } }] },
    ];
    const r = T.toFirstPositionResult(d);
    expect(r.brands).toEqual(["Hyundai", "Toyota"]);
    expect(r.buckets.map((b) => b.brands.map((x) => [x.brand, x.avgPosition, x.rankedAnswers]))).toEqual([
      [["Hyundai", 1.5, 30], ["Toyota", 2, 50]],
      [["Hyundai", 2, 35], ["Toyota", null, 0]],
    ]);
    expect(r.latest).toEqual([]);
  });
});

describe("week grid: anchor week = API week key, slot label = round date", () => {
  it("mondayOf and trendGridOf on week buckets", () => {
    expect(T.mondayOf("2026-09-11")).toBe("2026-09-07"); // Friday -> Monday
    expect(T.mondayOf("2026-09-07")).toBe("2026-09-07");
    expect(T.trendGridOf(apiWebsite())).toEqual([
      { roundDate: WR[0], anchorWeek: W[0], gapReason: null },
      { roundDate: WR[1], anchorWeek: W[1], gapReason: null },
    ]);
  });
});

// ── P12 B101: dims (several dimensions in one call) ─────────────────────────
describe("dims: one call, one TrendResponse per dimension", () => {
  type Meta = S["Meta"];
  const meta = (m: Partial<Meta> = {}): Meta => ({ mode: "cumulative", as_of: R[3], cycles: [...R], ...m });
  const mix = (metric: string, code: string, key: string, num: number): S["TrendSeries"] => ({
    metric,
    code,
    kind: "ratio",
    key,
    label: key,
    points: R.map((bucket) => ({ bucket, ratio: { num, den: 10 } })),
  });
  const shared = { bucket: "cycle" as const, own_label: "HMG", buckets: apiOverview().buckets };
  const source: S["TrendData"] = { ...shared, dimension: "source", series: [mix("source_share", "M09", "reddit.com", 3)] };
  const category: S["TrendData"] = { ...shared, dimension: "category", series: [mix("category_share", "M10", "newsMedia", 4)] };
  const overview = apiOverview();

  it("dimsParam builds the backend item dimension[:metric,…][@top]", () => {
    expect(T.dimsParam({ dimension: "category", top: 13 })).toBe("category@13");
    expect(T.dimsParam({ dimension: "none", metrics: ["visibility", "share_of_voice", "visibility"] })).toBe("none:visibility,share_of_voice");
    expect(T.dimsParam({ dimension: "engine", metrics: ["sentiment"], top: 5 })).toBe("engine:sentiment@5");
    expect(T.dimsParam({ dimension: "type" })).toBe("type");
  });

  it("splitTrendDims: each dimension has the shape (and values) of its separate answer", () => {
    const sourceMeta = meta({ ignored_filters: [] });
    const categoryMeta = meta({ suppressed: { category_share: "hidden" } });
    const overviewMeta = meta({ ignored_filters: ["source"] });
    const combined: TrendResponse = {
      data: {
        ...source,
        dims: [
          { dimension: "category", series: category.series, meta: categoryMeta },
          { dimension: "none", series: overview.series, meta: overviewMeta },
        ],
      },
      meta: sourceMeta,
    };
    const m = T.splitTrendDims(combined);
    expect([...m.keys()]).toEqual(["source", "category", "none"]);
    expect(m.get("source")).toEqual({ data: source, meta: sourceMeta });
    expect("dims" in m.get("source")!.data).toBe(false);
    expect(m.get("category")).toEqual({ data: category, meta: categoryMeta });
    expect(m.get("none")).toEqual({ data: overview, meta: overviewMeta });
    // the adapters give the same output on a split answer as on the separate answer
    expect(T.toLiveTrend(m.get("none")!.data)).toEqual(T.toLiveTrend(overview));
    expect(T.toSeriesViews(m.get("category")!.data)).toEqual(T.toSeriesViews(category));
    // an answer without dims gives the primary only
    expect([...T.splitTrendDims({ data: source, meta: sourceMeta }).entries()]).toEqual([["source", { data: source, meta: sourceMeta }]]);
  });

  describe("fetchTrend query", () => {
    const log: URL[] = [];
    beforeEach(async () => {
      log.length = 0;
      vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
      const { bindHghAuth } = await import("../auth");
      bindHghAuth({ getAccessToken: async () => "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (u: string) => {
          const url = new URL(String(u));
          log.push(url);
          const dims = url.searchParams.getAll("dims");
          const data = dims.length ? { ...source, dims: [{ dimension: "category", series: category.series, meta: meta() }] } : source;
          return new Response(JSON.stringify({ data, meta: meta() }), { status: 200, headers: { "content-type": "application/json" } });
        }),
      );
    });
    afterEach(async () => {
      const { bindHghAuth } = await import("../auth");
      bindHghAuth(null);
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it("sends dims only when given; fetchTrendDims splits the one answer", async () => {
      const req: TrendRequest = { surface: "global", scope: null, bucket: "cycle", dimension: "source", top: 15, measuredDays: false };
      await T.fetchTrend({}, req);
      expect(log).toHaveLength(1);
      expect(log[0].searchParams.has("dims")).toBe(false); // default query unchanged (cache keys as before)
      const byDim = await T.fetchTrendDims({}, { ...req, dims: [{ dimension: "category", top: 13 }] });
      expect(log).toHaveLength(2);
      expect(log[1].searchParams.getAll("dims")).toEqual(["category@13"]);
      expect(log[1].searchParams.get("dimension")).toBe("source");
      expect(log[1].searchParams.get("top")).toBe("15");
      expect(log[1].searchParams.get("measured_days")).toBe("false");
      expect([...byDim.keys()]).toEqual(["source", "category"]);
      expect(byDim.get("category")!.data).toEqual(category);
      expect(byDim.get("source")!.data).toEqual(source);
    });
  });
});
