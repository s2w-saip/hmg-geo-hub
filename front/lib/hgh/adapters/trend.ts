import "server-only";

// Analysis common adapter, part 3 (unit U4): the trend (T-1 GET /v1/trend) in the shapes the
// legacy readers produced. Design 3.2 (3), appendix A R-trend, decisions D13 (split_own).
//
// Outputs (pick the one the screen already consumes):
//   toStandardTrendBuckets  -> StandardTrendBucket[] (fetchStandardTrend/fetchWebsiteTrend/
//                              fetchProjectTrend, SRV:1917 area). The counts are the API integer
//                              pairs, so the pure legacy value rules (overviewTrendValues,
//                              overviewCardDelta in lib/kpi/overview-card-values.ts) run unchanged.
//   withEngineBreakdown     -> the same buckets with `engines` from a dimension=engine answer
//   toLiveTrend             -> LiveTrend (dashboard/_data/live.ts:514; dashboard, website, project
//                              trend charts and, via applyTrendDeltas, the card Δ)
//   toBrandTrendResult      -> BrandTrendResult (dimension=brand: competitor sparklines, KPI tab)
//   toFirstPositionResult   -> FirstPositionResult buckets (dimension=brand, position)
//   toSeriesViews           -> generic series (key, label, colour, points) for any dimension
//   splitTrendDims          -> one TrendResponse per dimension of a dims call (P12 B101: several
//                              dimensions in one request; each equals its separate call)
//
// Point rules (R-trend):
//   bucket key -> bucketStart; roundDate = last round_dates entry (the round the slot belongs
//   to: website week buckets are labelled with the Friday round, not the Monday key);
//   cycleAnchorAt = key for bucket=cycle; gridSlot = true (the backend emits ledger slots only,
//   so screens must not fill empty weeks: fillTrendGaps is skipped by the gridSlot marker).
//   Ratio -> the legacy count pair (trackedAnswers/answers, trackedMentions/totalMentions,
//   positiveMentions/sentMentions, ownedCitations/totalCitations); RankAvg -> avgPosition
//   rounded to one decimal (rankAvg). measured_days (BG-10) -> measuredDays; a call sent with
//   measured_days=false (TrendRequest.measuredDays false) gets null there, carried as 0.
//   gap_reason collection_error -> gap {reason: "collection_error"}, hidden -> {reason:
//   "not_published"}. Mention series gapped -> scope "all" (written without scope, as the
//   legacy readers do); only citation series gapped -> scope "citations"
//   (lib/viz/trend-gap.ts contract). A slot whose mention series has no answer (no_answer /
//   analysis_pending) carries {reason: "no_value"} (WU-6: the legacy trend grid,
//   lib/summary/read/trend-grid-buckets.ts:118-121 gridGapBucket, marks a ledger slot without
//   a value bucket with NO_VALUE_GAP, so the chart shades it like the other gaps); a slot with
//   mention values but no citation answer carries no marker (legacy: the bucket exists).
//   Citation-only no_answer stays unmarked.
//   Website/project M06/M07: point origin report|live (published value vs live) is kept per
//   point as urlRateOrigin. citationAccuracy (⑥ line and the card Δ via applyTrendDeltas) comes
//   only from the citation_accuracy series (requested by WEBSITE_TREND_METRICS, WU-9, and
//   PROJECT_TREND_METRICS, #13): round1(100 * target∧owned / owned answers), always live. The legacy
//   ⑥ readers never read the published report (website/_data/live.ts:246-272,
//   summary-website-aggregates.ts:1570-1650; project aggregateCitationAccuracyTrend,
//   scope-aggregates.ts:8459-8559). The project's legacy owned rule (one effective owned base) is
//   the backend's job (profile project_accuracy_single_base, DC-23). A slot without a series point
//   (den 0) draws no ⑥ value. The former project rule round1(100 * M06.num / M07.num) is gone: it
//   is not the legacy definition and mixes units on a published website round.
//
// Brand dimension (D13): split_own=true is sent by default so a multi-perspective account
// (HMG three brands, admin without a brand) keeps one own line per brand (Hyundai, Kia,
// Genesis) as today; the series key/label is then the perspective brand_code. A single
// perspective gives one own series labelled with own_label (BG-48 = mentions/brands own label).
// Colours: own series take the fixed own colour (series-colors.ts brandColor), competitors
// the palette by their position in the series list (own first), the same rule as the
// competitor KPI table. Screens that colour by their own table order may override colorIndex.
//
// Known differences. Design DC list (front-adapter-plan 3.6 (나)):
//   DC-05  Δ buckets: the legacy card Δ came from a day roll-up of the last 30 days; the API has
//          no day bucket, the Δ source is bucket=cycle (last two valued points = previous round)
//   DC-08  series: top N over the whole window (legacy: weekly top union capped at 15), default
//          window 12 buckets (legacy: 13 week slots / 120 days), no folding of two rounds in a week.
//          WU-6: with the backend profile trend_grid (current X.trendGrid) bucket=cycle is the
//          legacy grid: 13 ledger slots, one representative round per slot (website: per site),
//          global completion < 0.9 and unpublished slots as gaps (back core.cycles resolve_trend_grid)
//   DC-12  handled by D13: split_own keeps one own line per perspective brand (no known diff)
// Outside the DC list (U4 numbering, for the A4 notice; asserted in trend.test.ts):
//   U4-N3  firstAt/lastAt (first/last measurement instants of a slot) are not in the API: null.
//          LiveTrend.lastMeasuredAt is the last valued slot's round date, not an instant
//   U4-N4  a gap slot keeps its ledger round date (legacy empty points had only bucketStart);
//          the x-axis label is the same date
//   U4-N5  a round with only the mention family hidden (hidden_scope 3, no legacy vocabulary) is
//          shown as a whole-slot gap: the citation value of that slot is dropped too
//   U4-N13 website M06/M07 published values (origin=report) come only with bucket=cycle; week
//          buckets are live values (backend T-1 rule; confirm with the website trend owner, U5)
// Sync S1 (asserted in trend.test.ts):
//   S1-N2  LiveTrend points carry no cycleAnchorAt (hmg-geo 2670a16 live.ts copies the bucket's
//          anchor instant onto each point, x axis label only). toLiveTrend is always axis
//          "anchor", where trendBucketLabel uses the round date and never reads it. The one reader
//          is the global dashboard's card sparkline (overview-kpi-cards trendBucketDisplays): the
//          legacy labels a point by the anchor's KST day, the api by the bucket key (the round
//          date). Same day unless the round is attributed to another day than its anchor's KST
//          day (the legacy hero chart already shows the round date there).
//          StandardTrendBucket.cycleAnchorAt stays set for bucket=cycle
import type { LiveTrend, LiveTrendPoint } from "@/app/[locale]/(dash)/dashboard/_data/live";
import { brandColor, seriesColor } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/kpi/series-colors";
import type {
  BrandTrendBucket,
  BrandTrendResult,
  BucketUnit,
  FirstPositionBucket,
  FirstPositionResult,
  StandardTrendBucket,
  StandardTrendEnginePoint,
} from "@/lib/db/repositories/scope-aggregates";
import { overviewTrendValues } from "@/lib/kpi/overview-card-values";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { TrendGridGapReason, TrendGridSlotView } from "@/lib/period/trend-grid-axis";
import type { TrendGap } from "@/lib/viz/trend-gap";
import type { components } from "../api-types";
import { hghGet } from "../client";
import { filterNotices, pct1OrNull, pct1OrZero, rankAvg, type ApiMeta, type FilterNotices, type RankAvg, type Ratio } from "../convert";
import { cardParam, withParams } from "../query";
import { analysisQuery, type AnalysisQueryContext } from "./filters";

type S = components["schemas"];
export type ApiTrendData = S["TrendData"];
export type ApiTrendSeries = S["TrendSeries"];
export type ApiTrendBucket = S["TrendBucket"];
export type ApiTrendPoint = S["app__features__analytics__trend__series__schemas__TrendPoint"];
export type TrendBucketName = ApiTrendData["bucket"];
export type TrendDimension = ApiTrendData["dimension"];

/** Metric names of T-1 (the query also accepts M01..M10 codes). */
export type TrendMetric =
  | "visibility"
  | "share_of_voice"
  | "sentiment"
  | "position"
  | "citation_share"
  | "target_url_rate"
  | "owned_url_rate"
  | "citation_accuracy"
  | "type_exposure"
  | "source_share"
  | "category_share";

/** Overview card metrics (M01..M05), the legacy card order. */
export const OVERVIEW_TREND_METRICS: readonly TrendMetric[] = [
  "visibility",
  "share_of_voice",
  "sentiment",
  "position",
  "citation_share",
];
/** Overview + website/project URL rates (M01..M07). */
export const URL_TREND_METRICS: readonly TrendMetric[] = [...OVERVIEW_TREND_METRICS, "target_url_rate", "owned_url_rate"];
/** Website trend: M01..M07 + the live citation accuracy series (legacy ⑥ line, WU-9). */
export const WEBSITE_TREND_METRICS: readonly TrendMetric[] = [...URL_TREND_METRICS, "citation_accuracy"];
/** Project trend: M01..M07 + the citation accuracy series (legacy project ⑥ line, #13). */
export const PROJECT_TREND_METRICS: readonly TrendMetric[] = [...URL_TREND_METRICS, "citation_accuracy"];

/** API metric -> LiveTrend value key (TrendKpiKey). */
export const TREND_METRIC_KPI_KEY = {
  visibility: "visibility",
  share_of_voice: "shareOfVoice",
  sentiment: "sentiment",
  position: "position",
  citation_share: "citationShare",
} as const;

const MENTION_FAMILY: ReadonlySet<string> = new Set(["visibility", "share_of_voice", "sentiment", "position", "type_exposure"]);

export interface TrendRequest extends AnalysisQueryContext {
  bucket: TrendBucketName;
  /** Default none. */
  dimension?: TrendDimension;
  /** Default: the surface set (global M01..M05, website/project M01..M07). */
  metrics?: readonly TrendMetric[];
  /** dimension=brand|source|category|type: top series (1..50, backend default 10). */
  top?: number;
  /** BG-11: competitor brand keys to add beyond top (dimension=brand). */
  brandKeys?: readonly number[];
  /** D13: one own series per perspective brand. Default true for dimension=brand. */
  splitOwn?: boolean;
  /**
   * Performance A1: false sends measured_days=false, the backend skips the rd.job join and
   * every buckets[].measured_days is null (the adapters then carry measuredDays 0). Only for
   * calls whose measuredDays no screen shows or computes with (the KPI tab coverage labels
   * read the overview, engine and brand trends, which keep the default). Default: not sent
   * (backend default true), so the query of those calls and their cache keys stay as before.
   */
  measuredDays?: boolean;
  /** WU-3 card path (cardParam): the dashboard trend and competitor Δ reads, not the analysis tabs. */
  card?: boolean;
  /**
   * P12 B101: more dimensions in the same call (backend dims). Each one answers like a separate
   * fetchTrend of that dimension with the same filters, bucket, measuredDays and card (the window,
   * measured days, base scan, citation presence and the source/category scan are computed once).
   * Read the answer with splitTrendDims. Default: not sent, so the query stays as before.
   */
  dims?: readonly TrendDimSpec[];
}

/**
 * One extra dimension of a dims call: metrics/top as in TrendRequest (omitted = the backend
 * default of that dimension / the request top). brand is only the primary dimension (brand_key
 * and split_own belong to it).
 */
export interface TrendDimSpec {
  dimension: Exclude<TrendDimension, "brand">;
  metrics?: readonly TrendMetric[];
  top?: number;
}

export interface TrendResponse {
  data: ApiTrendData;
  meta: ApiMeta;
}

/** The backend dims item of a spec: `dimension[:metric,…][@top]`. */
export function dimsParam(spec: TrendDimSpec): string {
  const metrics = spec.metrics?.length ? `:${[...new Set(spec.metrics)].join(",")}` : "";
  return `${spec.dimension}${metrics}${spec.top !== undefined ? `@${spec.top}` : ""}`;
}

/** GET /v1/trend for the screen's filters (one call, deduped in the request). */
export async function fetchTrend(filters: StandardFilters, req: TrendRequest): Promise<TrendResponse> {
  const { bucket, dimension = "none", metrics, top, brandKeys, splitOwn, measuredDays, card, dims, ...ctx } = req;
  const { query, cf } = analysisQuery(filters, ctx);
  const extra: {
    bucket: TrendBucketName;
    dimension: TrendDimension;
    metrics?: string[];
    top?: number;
    brand_key?: number[];
    split_own?: boolean;
    measured_days?: boolean;
    card?: true;
    dims?: string[];
  } = { bucket, dimension, ...cardParam(ctx.surface, card) };
  if (metrics?.length) extra.metrics = [...new Set(metrics)];
  if (top !== undefined) extra.top = top;
  if (dimension === "brand") {
    if (brandKeys?.length) extra.brand_key = [...new Set(brandKeys)].sort((a, b) => a - b);
    extra.split_own = splitOwn ?? true;
  }
  if (measuredDays === false) extra.measured_days = false;
  if (dims?.length) extra.dims = dims.map(dimsParam);
  const res = await hghGet("/v1/trend", { query: withParams(query, extra), cf });
  return { data: res.data, meta: res.meta };
}

/**
 * A dims answer -> one TrendResponse per dimension (the primary first), each shaped like the
 * answer of a separate fetchTrend of that dimension: bucket, buckets and own_label shared,
 * dimension and series from the block, meta = the block meta (the primary keeps the top-level
 * meta). The primary data carries no dims. An answer without dims gives the primary only.
 */
export function splitTrendDims(res: TrendResponse): Map<TrendDimension, TrendResponse> {
  const { dims, ...data } = res.data;
  const out = new Map<TrendDimension, TrendResponse>([[data.dimension, { data, meta: res.meta }]]);
  for (const b of dims ?? []) out.set(b.dimension, { data: { ...data, dimension: b.dimension, series: b.series }, meta: b.meta });
  return out;
}

/** fetchTrend with dims, split per dimension (splitTrendDims). One call. */
export async function fetchTrendDims(
  filters: StandardFilters,
  req: TrendRequest & { dims: readonly TrendDimSpec[] },
): Promise<Map<TrendDimension, TrendResponse>> {
  return splitTrendDims(await fetchTrend(filters, req));
}

// ── point helpers ────────────────────────────────────────────────────────────

/** The gap marker a point carries on screen (collection_error, hidden), or undefined. */
export function pointGap(p: ApiTrendPoint | undefined): TrendGap | undefined {
  if (!p) return undefined;
  if (p.gap_reason === "collection_error") return { reason: "collection_error" };
  if (p.gap_reason === "hidden") return { reason: "not_published" };
  return undefined;
}

/** Legacy mirror percent: Math.round(n/d*1000)/10, den 0 -> null (scope-aggregates pctOrNull). */
export function mirrorPct(r: Ratio | null | undefined): number | null {
  return r && r.den > 0 ? pct1OrZero(r) : null;
}

type PointIndex = Map<string, ApiTrendPoint>;
const indexPoints = (s: ApiTrendSeries): PointIndex => new Map(s.points.map((p) => [p.bucket, p]));

/** Series of dimension none by metric name (first match). */
function seriesByMetric(data: ApiTrendData): Map<string, PointIndex> {
  const out = new Map<string, PointIndex>();
  for (const s of data.series) if (!out.has(s.metric)) out.set(s.metric, indexPoints(s));
  return out;
}

const lastOf = <T>(xs: readonly T[]): T | undefined => (xs.length ? xs[xs.length - 1] : undefined);

/** Round date labelling a bucket: the last ledger round in it (cycle: the key itself). */
export function bucketRoundDate(b: ApiTrendBucket): string {
  return lastOf(b.round_dates) ?? b.key;
}

/**
 * Bucket-level gap marker from the series at that bucket: a gapped mention series means the
 * whole slot (scope "all", written without scope); only citation series gapped means scope
 * "citations".
 */
export function bucketGap(series: ReadonlyMap<string, PointIndex>, key: string): TrendGap | undefined {
  let mention: TrendGap | undefined;
  let citation: TrendGap | undefined;
  let noValue = false;
  for (const [metric, idx] of series) {
    const p = idx.get(key);
    const g = pointGap(p);
    if (!g) {
      if (MENTION_FAMILY.has(metric) && (p?.gap_reason === "no_answer" || p?.gap_reason === "analysis_pending")) noValue = true;
      continue;
    }
    if (MENTION_FAMILY.has(metric)) mention ??= g;
    else citation ??= g;
  }
  // scope "all" is written as no scope (lib/viz/trend-gap.ts: undefined = "all"), as the legacy readers do.
  if (mention) return { reason: mention.reason };
  if (citation) return { reason: citation.reason, scope: "citations" };
  // A ledger slot without a mention value: the legacy grid's no-value gap (WU-6, see the header).
  if (noValue) return { reason: "no_value" };
  return undefined;
}

const ratioOf = (idx: PointIndex | undefined, key: string): Ratio | null => idx?.get(key)?.ratio ?? null;
const rankOf = (idx: PointIndex | undefined, key: string): RankAvg | null => idx?.get(key)?.rank ?? null;

// ── StandardTrendBucket ─────────────────────────────────────────────────────

/**
 * dimension=none answer -> StandardTrendBucket[] (the legacy trend reader shape), one per API
 * bucket in API order. A metric that was not requested contributes zeros (its value is then
 * absent under overviewTrendValues, as a legacy bucket without that signal).
 */
export function toStandardTrendBuckets(data: ApiTrendData): StandardTrendBucket[] {
  const series = seriesByMetric(data);
  const vis = series.get("visibility");
  const sov = series.get("share_of_voice");
  const sen = series.get("sentiment");
  const pos = series.get("position");
  const cit = series.get("citation_share");
  return data.buckets.map((b) => {
    const k = b.key;
    const v = ratioOf(vis, k);
    const s = ratioOf(sov, k);
    const e = ratioOf(sen, k);
    const c = ratioOf(cit, k);
    const gap = bucketGap(series, k);
    const out: StandardTrendBucket = {
      bucketStart: k,
      roundDate: bucketRoundDate(b),
      ...(data.bucket === "cycle" ? { cycleAnchorAt: k } : {}),
      gridSlot: true,
      ...(gap ? { gap } : {}),
      answers: v?.den ?? 0,
      trackedAnswers: v?.num ?? 0,
      totalMentions: s?.den ?? 0,
      trackedMentions: s?.num ?? 0,
      sentMentions: e?.den ?? 0,
      positiveMentions: e?.num ?? 0,
      avgPosition: rankAvg(rankOf(pos, k)),
      totalCitations: c?.den ?? 0,
      ownedCitations: c?.num ?? 0,
      measuredDays: b.measured_days ?? 0,
      firstAt: null,
      lastAt: null,
    };
    return out;
  });
}

/**
 * Adds the per-engine breakdown (legacy StandardTrendBucket.engines) from a dimension=engine
 * answer of the same filters and bucket. Buckets the engine answer does not have keep none.
 */
export function withEngineBreakdown(buckets: readonly StandardTrendBucket[], engineData: ApiTrendData): StandardTrendBucket[] {
  // engine -> metric -> points
  const byEngine = new Map<string, Map<string, PointIndex>>();
  for (const s of engineData.series) {
    if (!s.key) continue;
    let m = byEngine.get(s.key);
    if (!m) byEngine.set(s.key, (m = new Map()));
    if (!m.has(s.metric)) m.set(s.metric, indexPoints(s));
  }
  return buckets.map((b) => {
    const engines: StandardTrendEnginePoint[] = [];
    for (const [engine, m] of byEngine) {
      const k = b.bucketStart;
      const v = ratioOf(m.get("visibility"), k);
      if (!v) continue;
      const s = ratioOf(m.get("share_of_voice"), k);
      const e = ratioOf(m.get("sentiment"), k);
      const r = rankOf(m.get("position"), k);
      engines.push({
        engine,
        answers: v.den,
        trackedAnswers: v.num,
        totalMentions: s?.den ?? 0,
        trackedMentions: s?.num ?? 0,
        sentMentions: e?.den ?? 0,
        positiveMentions: e?.num ?? 0,
        rankSum: r?.sum ?? 0,
        rankedAnswers: r?.count ?? 0,
      });
    }
    return engines.length ? { ...b, engines } : { ...b };
  });
}

// ── LiveTrend ───────────────────────────────────────────────────────────────

export type UrlRateOrigin = "report" | "live";

/** LiveTrendPoint plus the published-value flag of the website/project URL-rate series. */
export interface ApiLiveTrendPoint extends LiveTrendPoint {
  /** M06/M07 value source at this slot (report = published report, live = live aggregate). */
  urlRateOrigin?: UrlRateOrigin;
}

export interface ApiLiveTrend extends LiveTrend {
  points: ApiLiveTrendPoint[];
}

export interface LiveTrendOptions {
  /** The unit the legacy call used (getLiveTrend(filters, unit)); labels follow the anchor axis anyway. */
  unit?: BucketUnit;
}

/**
 * dimension=none answer -> LiveTrend (legacy getLiveTrendImpl / website buildTrendFromBuckets
 * without the empty-week fill: the backend only emits ledger slots). Values use the legacy
 * value rules (overviewTrendValues) on the API counts, so rounding is identical.
 */
export function toLiveTrend(data: ApiTrendData, opts: LiveTrendOptions = {}): ApiLiveTrend {
  const buckets = toStandardTrendBuckets(data);
  const series = seriesByMetric(data);
  const tgt = series.get("target_url_rate");
  const own = series.get("owned_url_rate");
  const accSeries = series.get("citation_accuracy");
  const points: ApiLiveTrendPoint[] = buckets.map((b) => {
    const k = b.bucketStart;
    const gapPart = b.gap ? { gap: b.gap } : {};
    const origin = own?.get(k)?.origin ?? tgt?.get(k)?.origin ?? null;
    const originPart = origin ? { urlRateOrigin: origin } : {};
    const mentionGap = b.gap && (b.gap.scope ?? "all") === "all";
    if (mentionGap || b.answers === 0) {
      return {
        bucketStart: k,
        ...(b.roundDate ? { roundDate: b.roundDate } : {}),
        firstAt: null,
        values: {},
        measuredDays: 0,
        answers: 0,
        lastAt: null,
        ...gapPart,
        ...originPart,
      };
    }
    const values: LiveTrendPoint["values"] = { ...overviewTrendValues(b) };
    // ⑥ citation accuracy = target ∧ own / own answers, only from the requested live series.
    const acc = accSeries ? pct1OrNull(ratioOf(accSeries, k)) : null;
    if (acc !== null) values.citationAccuracy = acc;
    return {
      bucketStart: k,
      ...(b.roundDate ? { roundDate: b.roundDate } : {}),
      firstAt: null,
      values,
      measuredDays: b.measuredDays,
      answers: b.answers,
      lastAt: null,
      ...gapPart,
      ...originPart,
    };
  });
  const valued = points.filter((p) => p.answers > 0);
  return {
    unit: opts.unit ?? "week",
    axis: "anchor",
    points,
    lastMeasuredAt: lastOf(valued)?.roundDate ?? lastOf(valued)?.bucketStart ?? null,
    totalAnswers: valued.reduce((s, p) => s + p.answers, 0),
  };
}

// ── generic series views (any dimension) ────────────────────────────────────

export interface TrendPointView {
  bucket: string;
  roundDate: string;
  ratio: Ratio | null;
  rank: RankAvg | null;
  /** Ratio: legacy mirror percent (den 0 -> null). Rank: average rounded to one decimal. */
  value: number | null;
  gap?: TrendGap;
  /** Website/project M06/M07 value source. */
  origin: UrlRateOrigin | null;
  /** BG-09: negative signals of a sentiment point (denominator = ratio.den). */
  negative: number | null;
}

export interface TrendSeriesView {
  /** Series key: 'own' (merged own), a perspective brand_code (split own), a brand name,
   *  an engine code, a source key, a category slug or a type key; "" for dimension none. */
  key: string;
  /** Display name: own = own_brand_code (split) or own_label (merged); else label ?? key. */
  label: string;
  metric: string;
  code: string | null;
  kind: "ratio" | "rank";
  isOwn: boolean;
  ownBrandCode: string | null;
  brandKey: number | null;
  /** Position among the series of the same metric (own first): brandColor/seriesColor index. */
  colorIndex: number;
  color: string;
  points: TrendPointView[];
}

/** Display name of a series (see TrendSeriesView.label). */
export function seriesLabel(s: ApiTrendSeries, data: Pick<ApiTrendData, "own_label">): string {
  if (s.is_own) return s.own_brand_code ?? data.own_label;
  return s.label ?? s.key ?? "";
}

/**
 * Every series of the answer with its points aligned to data.buckets (a missing point is an
 * empty slot). Own series come first per metric, in API order otherwise.
 */
export function toSeriesViews(data: ApiTrendData): TrendSeriesView[] {
  const byMetric = new Map<string, ApiTrendSeries[]>();
  for (const s of data.series) {
    const list = byMetric.get(s.metric) ?? [];
    list.push(s);
    byMetric.set(s.metric, list);
  }
  const roundOf = new Map(data.buckets.map((b) => [b.key, bucketRoundDate(b)]));
  const out: TrendSeriesView[] = [];
  for (const list of byMetric.values()) {
    const ordered = [...list.filter((s) => s.is_own), ...list.filter((s) => !s.is_own)];
    ordered.forEach((s, colorIndex) => {
      const idx = indexPoints(s);
      const label = seriesLabel(s, data);
      const isOwn = s.is_own === true;
      out.push({
        key: s.key ?? "",
        label,
        metric: s.metric,
        code: s.code ?? null,
        kind: s.kind,
        isOwn,
        ownBrandCode: s.own_brand_code ?? null,
        brandKey: s.brand_key ?? null,
        colorIndex,
        color: data.dimension === "brand" ? brandColor(label, isOwn, colorIndex) : seriesColor(colorIndex),
        points: data.buckets.map((b) => {
          const p = idx.get(b.key);
          const ratio = p?.ratio ?? null;
          const rank = p?.rank ?? null;
          const gap = pointGap(p);
          return {
            bucket: b.key,
            roundDate: roundOf.get(b.key) ?? b.key,
            ratio,
            rank,
            value: s.kind === "rank" ? rankAvg(rank) : mirrorPct(ratio),
            ...(gap ? { gap } : {}),
            origin: p?.origin ?? null,
            negative: p?.negative ?? null,
          };
        }),
      });
    });
  }
  return out;
}

// ── dimension=brand -> legacy brand trend shapes ─────────────────────────────

export interface BrandTrendOptions {
  unit?: BucketUnit;
  /** Window mention totals by brand (e.g. from GET /v1/mentions/brands) when share_of_voice was not requested. */
  mentions?: ReadonlyMap<string, number>;
}

interface BrandSeriesGroup {
  name: string;
  isOwn: boolean;
  vis?: PointIndex;
  sov?: PointIndex;
  pos?: PointIndex;
}

function brandGroups(data: ApiTrendData): BrandSeriesGroup[] {
  const groups = new Map<string, BrandSeriesGroup>();
  const order: string[] = [];
  const add = (s: ApiTrendSeries) => {
    const name = seriesLabel(s, data);
    const id = `${s.is_own ? "own" : "comp"}:${name}`;
    let g = groups.get(id);
    if (!g) {
      groups.set(id, (g = { name, isOwn: s.is_own === true }));
      order.push(id);
    }
    const idx = indexPoints(s);
    if (s.metric === "visibility") g.vis ??= idx;
    else if (s.metric === "share_of_voice") g.sov ??= idx;
    else if (s.metric === "position") g.pos ??= idx;
  };
  for (const s of data.series) if (s.is_own) add(s);
  for (const s of data.series) if (!s.is_own) add(s);
  return order.map((id) => groups.get(id)!);
}

/** Monday of the week a YYYY-MM-DD day falls in (the legacy anchor_week). */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

/** Slot gap reason from the series points at that bucket (collection_error first). */
function slotGapReason(data: ApiTrendData, key: string): TrendGridGapReason | null {
  let reason: TrendGridGapReason | null = null;
  for (const s of data.series) {
    const p = s.points.find((x) => x.bucket === key);
    if (p?.gap_reason === "collection_error") return "hidden-collection-error";
    if (p?.gap_reason === "hidden") reason = "not-published";
  }
  return reason;
}

/**
 * The ledger slots of the answer as the legacy trend grid (TrendGridSlotView, D5): the axis
 * is exactly these slots, labelled by round date (the screens then never fill empty weeks).
 */
export function trendGridOf(data: ApiTrendData): TrendGridSlotView[] {
  return data.buckets.map((b) => {
    const roundDate = bucketRoundDate(b);
    return {
      roundDate,
      anchorWeek: data.bucket === "week" ? b.key : mondayOf(roundDate),
      gapReason: slotGapReason(data, b.key),
    };
  });
}

/** Gap candidate keys (legacy TrendGapBucketKeys.gapBuckets): round dates of gapped slots. */
function gapKeys(data: ApiTrendData): string[] {
  return trendGridOf(data)
    .filter((s) => s.gapReason !== null)
    .map((s) => s.roundDate);
}

/**
 * dimension=brand (metrics visibility, share_of_voice) -> BrandTrendResult. brands = own
 * series first, then competitors in API order; mentions = window sum of the share_of_voice
 * numerators (or opts.mentions). Buckets are keyed by their round date (the grid label);
 * buckets without answers are left out (legacy: absent bucket = no measurement). trendGrid
 * carries the ledger slots (the screen's axis) and gapBuckets the gapped round dates.
 */
export function toBrandTrendResult(data: ApiTrendData, opts: BrandTrendOptions = {}): BrandTrendResult {
  const groups = brandGroups(data);
  const rounds = data.buckets.map(bucketRoundDate);
  const answersAt = (k: string): number => {
    for (const g of groups) {
      const r = g.vis?.get(k)?.ratio;
      if (r) return r.den;
    }
    return 0;
  };
  const totalMentionsAt = (k: string): number => {
    for (const g of groups) {
      const r = g.sov?.get(k)?.ratio;
      if (r) return r.den;
    }
    return 0;
  };
  const buckets: BrandTrendBucket[] = [];
  for (const b of data.buckets) {
    const answers = answersAt(b.key);
    if (answers === 0) continue;
    buckets.push({
      bucketStart: bucketRoundDate(b),
      answers,
      totalMentions: totalMentionsAt(b.key),
      measuredDays: b.measured_days ?? 0,
      firstAt: null,
      lastAt: null,
      brands: groups.map((g) => {
        const v = g.vis?.get(b.key)?.ratio ?? null;
        const s = g.sov?.get(b.key)?.ratio ?? null;
        return {
          brand: g.name,
          isTracked: g.isOwn,
          mentions: s?.num ?? 0,
          answers: v?.num ?? 0,
          exposurePct: mirrorPct(v),
          sharePct: mirrorPct(s),
        };
      }),
    });
  }
  const gaps = gapKeys(data);
  return {
    unit: opts.unit ?? "week",
    brands: groups.map((g) => ({
      brand: g.name,
      isTracked: g.isOwn,
      mentions: g.sov
        ? [...g.sov.values()].reduce((sum, p) => sum + (p.ratio?.num ?? 0), 0)
        : (opts.mentions?.get(g.name) ?? 0),
    })),
    buckets,
    windowStartBucket: rounds[0] ?? null,
    windowEndBucket: lastOf(rounds) ?? null,
    trendGrid: trendGridOf(data),
    ...(gaps.length ? { gapBuckets: gaps } : {}),
  };
}

/**
 * dimension=brand with metric position -> FirstPositionResult (brands + buckets). `latest`
 * (the snapshot rank table) is not a trend: empty here, the screen fills it from
 * GET /v1/mentions/brands (avg_rank).
 */
export function toFirstPositionResult(data: ApiTrendData, opts: { unit?: BucketUnit } = {}): FirstPositionResult {
  const groups = brandGroups(data).filter((g) => g.pos);
  const buckets: FirstPositionBucket[] = data.buckets
    .filter((b) => groups.some((g) => g.pos?.get(b.key)?.rank))
    .map((b) => ({
      bucketStart: bucketRoundDate(b),
      measuredDays: b.measured_days ?? 0,
      firstAt: null,
      lastAt: null,
      brands: groups.map((g) => {
        const r = g.pos?.get(b.key)?.rank ?? null;
        return { brand: g.name, isTracked: g.isOwn, avgPosition: rankAvg(r), rankedAnswers: r?.count ?? 0 };
      }),
    }));
  const gaps = gapKeys(data);
  return {
    unit: opts.unit ?? "week",
    brands: groups.map((g) => g.name),
    buckets,
    latest: [],
    trendGrid: trendGridOf(data),
    ...(gaps.length ? { gapBuckets: gaps } : {}),
  };
}

// ── view bundle ─────────────────────────────────────────────────────────────

export interface TrendView {
  data: ApiTrendData;
  notices: FilterNotices;
  /** Whole-answer suppression ('*'), e.g. no_active_snapshot. */
  suppressed: ApiMeta["suppressed"];
}

/** fetchTrend + meta notices (ignored_filters, dropped_filters) for the filter chips or a log line. */
export async function loadTrend(filters: StandardFilters, req: TrendRequest): Promise<TrendView> {
  const res = await fetchTrend(filters, req);
  return { data: res.data, notices: filterNotices(res.meta), suppressed: res.meta.suppressed ?? {} };
}
