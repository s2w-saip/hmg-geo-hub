import "server-only";

// KPI tab adapter (unit U6): the standard mention screen's KPI tabs (exposure, share, favorability,
// first rank) in the legacy fetcher shapes, so the tab components and _data/kpi-view.ts run
// unchanged. Design 3.3 KPI rows, appendix B "[KPI 탭]" rows, 정합 3/7/10, decisions D6, D13.
//
//   legacy (lib/scope/server.ts)                    api (this module)
//   fetchStandardKpiHeroSubKpis(f, exposure|sov)    loadKpiHeroSubKpis: K-1 summary -> overviewCards
//   fetchStandardKpiHeroSubKpis(f, favorability)    loadKpiHeroSubKpis: K-3 engines rows only
//   fetchStandardKpiHeroSubKpisPrev                 loadKpiHeroSubKpisPrev: cycle_offset=1 (snapshot),
//                                                   null in period mode (the round Δ takes over)
//   fetchStandardKpiEngineTrend                     loadEngineKpiTrend: K-3 (latest), M-1 group_by=
//                                                   engine engine_only (latestBrands, BG-16), T-1
//                                                   dimension=engine (buckets, BG-09 negative, BG-10
//                                                   measured days) with dims=type (typeTrend, BG-07)
//                                                   in the same call (B038), T-1 dimension=none
//                                                   (overviewSlots = Δ slots, grid; the D6 essential)
//   fetchStandardKpiBrandTrend                      loadBrandTrend: T-1 dimension=brand (U4 toBrandTrendResult)
//   fetchStandardKpiFirstPosition                   loadFirstPosition: same T-1 brand answer (position) +
//                                                   M-1 rows (latest, re-ranked by average position)
//   fetchStandardKpiTypes                           loadTypeKpi: M-2 types
//   fetchStandardKpiStanceDist                      loadStanceDist: M-2 stance (card switched off today)
//   fetchStandardMentionCompetitorBrands            null: rows and values come from one source now
//
// Rules (hand-checked in kpi-tab.test.ts):
//   overviewCards  visibility/shareOfVoice/sentiment/citationShare = the summary Ratio pairs,
//                  position = {round1(sum/count), count}. The metric the hero reads is null or
//                  suppressed -> no overviewCards and rows [] (kpiHero "측정 없음"), never {0, 0}
//   favorability   rows = engine rows (sent/positive/negative), no overviewCards: positive and
//                  negative share one denominator, NegativeBasisNote is not drawn
//   engine points  answers/trackedAnswers = visibility den/num, totalMentions/trackedMentions =
//                  share_of_voice den/num, sent/positive = sentiment den/num, negative = the
//                  sentiment point's negative (BG-09); percents = Math.round(n/d*1000)/10, d 0 null
//   bucket key     the round date (the grid resolver maps it to the slot); gap points carry no
//                  engine value
//   typeTrend      byType[t] = type_exposure numerator of type t, answers = its denominator
//   first rank     latest rows = the brand trend series (own first, legacy `series`), values from
//                  M-1; ranked by the legacy function itself (lib/kpi/first-position-rank.ts
//                  rankFirstPositionRows, hmg-geo ce30601): competition rank on avgPosition asc
//                  (ties share, next skipped), null last by mentions desc, ties and nulls ordered
//                  by a code unit name compare (locale independent; sync S1 FA-2)
//   TypeKpi        rows by_type in the legacy order; percents by the mirror rule; ownMentions and
//                  totalMentions = row sums; sentimentMatrix split by scope own/all
//   requests       K-1 parts=measured (mentions.ts MENTION_SUMMARY_PARTS, shared with the body);
//                  K-3 part=sov (KPI_TAB_ENGINE_PART: the mention columns, no rank detail or
//                  citation columns, B036); M-2 include_stance=false except the stance card
//   degraded       trendDegraded also when the engine × brand or the type trend read failed (the
//                  legacy trend phase held both, B034); the hero and type-bar failures are read by
//                  the page (KPI_TAB_DEGRADE_LABELS) and shown with the existing degraded notice
//
// Known differences. Design DC list (front-adapter-plan 3.6 (나)):
//   DC-01  engine[] empty = the default engine only (legacy: every engine)
//   DC-05  period mode has no prev sub (legacy: cumulative up to the first measure day); the Δ
//          badge comes from the round Δ (overviewDeltaSlots = the last two rounds)
//   DC-08  brand series = top 10 over the window; 12 rounds by default (legacy 13 week slots)
//   DC-12  handled by D13 split_own (own rows and lines per perspective brand)
// Resolved (sync S1 FA-4): DC-21 (average position = rank sum / ranked answers; the legacy tab
//   averaged per-answer body positions). hmg-geo 6bc5c54 (#308) moved the legacy tile, table,
//   ladder and trend to the competition rank inside each answer averaged over the answers (the
//   rule of the hero and card ④), which is the backend definition (rd.answer_brand.rk). Value
//   equivalence on data is BE-11 (back/tests/core/test_sync_s1_equiv.py); tie order is FA-2
// Outside the DC list (U6 numbering; asserted in kpi-tab.test.ts):
//   U6-N4  latestMeasuredAt is the round date (meta.as_of), not the last measurement instant
//          (the tab does not display it)
//   U6-N5  firstAt/lastAt of trend buckets are null (not in the API; the coverage label uses
//          measured days only)
//   U6-N6  competitorValues overlay is null: the competitor rows and their values come from the
//          same M-1 call, so "Overview competitor line = mention screen" holds by construction
import type { PrevSubKpis } from "@/lib/scope/server";
import type {
  AnswerStanceDistribution,
  BrandTrendResult,
  EngineBrandPoint,
  EngineKpiBucket,
  EngineKpiPoint,
  EngineKpiTrend,
  FirstPositionResult,
  FirstPositionRow,
  MentionTypeKey,
  OverviewCardValues,
  StandardSubKpis,
  TypeKpi,
  TypeKpiRow,
  TypeSentimentRow,
  TypeTrendBucket,
} from "@/lib/db/repositories/scope-aggregates";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { rankFirstPositionRows } from "@/lib/kpi/first-position-rank";
import { degradeOnApiFailure, wasDegraded } from "@/lib/scope/degrade-registry";
import { rankAvg, suppressionOf, wholeSuppression, type Ratio } from "../convert";
import {
  afterEssentials,
  startEssentials,
  fetchBrandTrend,
  fetchEngineRows,
  fetchMentionBrands,
  fetchMentionSummary,
  fetchMentionTypes,
  fetchOverviewTrend,
  MENTION_TYPES,
  toSubKpiRows,
  type ApiBrandsData,
  type ApiEnginesData,
  type ApiTypesData,
  type BrandsRequest,
  type EnginesPart,
  type Enveloped,
  type MentionsContext,
} from "./mentions";
import type { ApiSummaryData, SummaryResponse } from "./summary";
import {
  bucketRoundDate,
  fetchTrendDims,
  mirrorPct,
  pointGap,
  toBrandTrendResult,
  toFirstPositionResult,
  toStandardTrendBuckets,
  trendGridOf,
  withEngineBreakdown,
  type ApiTrendData,
  type ApiTrendPoint,
  type TrendResponse,
} from "./trend";

export type HeroMetric = "exposure" | "sov" | "favorability";

/**
 * B036: the engine-row columns the KPI tab reads (favorability hero rows: sentiment counts; engine
 * scalars: answers, tracked, mentions, sentiment). part=sov = the mention columns only; the hero,
 * its previous round and the engine trend all send it, so they share one call.
 */
export const KPI_TAB_ENGINE_PART: EnginesPart = "sov";

/**
 * B034: degrade labels of the KPI tab reads the page shows with the existing degraded notice
 * (read with wasKpiTabDegraded after that read settled).
 */
export const KPI_TAB_DEGRADE_LABELS = { hero: "standardKpiHero", types: "standardKpiTypes" } as const;

/** The first-rank reads under the brand rows (trend, summary, overview), see wasFirstPositionHeroDegraded. */
const FIRST_POSITION_HERO_LABELS = [
  "standardKpiFirstPosition.trend",
  "standardKpiFirstPosition.summary",
  "standardKpiFirstPosition.overview",
] as const;

/** Was that KPI tab read a transient failure in this request (degrade mark)? */
export function wasKpiTabDegraded(which: keyof typeof KPI_TAB_DEGRADE_LABELS): boolean {
  return wasDegraded(KPI_TAB_DEGRADE_LABELS[which]);
}

/**
 * First-rank hero: the average position and Δ come from the summary and overview reads, the best
 * rank and the fallback series from the brand trend (loadFirstPosition). Read after it settled. A
 * failed brand-row read is not here: then loadFirstPosition is null and the tab already says so.
 */
export function wasFirstPositionHeroDegraded(): boolean {
  return FIRST_POSITION_HERO_LABELS.some(wasDegraded);
}

/** Legacy mirror percent: Math.round(n/d*1000)/10, d 0 -> null (scope-aggregates pctOrNull). */
export const pctOrNull = (n: number, d: number): number | null => mirrorPct({ num: n, den: d });

const pair = (r: Ratio | null | undefined) => ({ numerator: r?.num ?? 0, denominator: r?.den ?? 0 });

// ── hero sub KPI ─────────────────────────────────────────────────────────────

/** K-1 -> OverviewCardValues (the five Overview card pairs). */
export function toOverviewCards(data: ApiSummaryData): OverviewCardValues {
  return {
    visibility: pair(data.visibility),
    shareOfVoice: pair(data.share_of_voice),
    sentiment: pair(data.sentiment),
    position: { avgPosition: rankAvg(data.position), sampledAnswers: data.position?.count ?? 0 },
    citationShare: pair(data.citation_share),
  };
}

/** The summary field the exposure / share hero reads. */
const HERO_FIELD = { exposure: "visibility", sov: "share_of_voice" } as const;

/**
 * Exposure / share hero: StandardSubKpis carrying overviewCards (kpiHero reads them first).
 * The hero's field null or suppressed -> an empty sub (rows [], no overviewCards) = "측정 없음".
 */
export function toHeroSubKpis(res: SummaryResponse, metric: "exposure" | "sov"): StandardSubKpis {
  const params = wholeSuppression(res.meta) ? null : res.data.params;
  const field = HERO_FIELD[metric];
  const measuredPrompts = params ? params.measured_prompts : null;
  if (!params || suppressionOf(res.meta, field) || !res.data[field]) {
    return { rows: [], promptsWithoutBrand: null, measuredPrompts };
  }
  return { rows: [], promptsWithoutBrand: null, measuredPrompts, overviewCards: toOverviewCards(res.data) };
}

/** Favorability hero: engine rows only (same denominator for positive and negative). */
export function toFavorabilitySubKpis(engines: Enveloped<ApiEnginesData>): StandardSubKpis {
  return { rows: toSubKpiRows(engines), promptsWithoutBrand: null, measuredPrompts: null };
}

/** Drop-in for fetchStandardKpiHeroSubKpis. A failed read is the empty sub (legacy withStandardRoot fallback). */
export async function loadKpiHeroSubKpis(filters: StandardFilters, ctx: MentionsContext, metric: HeroMetric): Promise<StandardSubKpis> {
  startEssentials(filters, ctx);
  const empty: StandardSubKpis = { rows: [], promptsWithoutBrand: null, measuredPrompts: null };
  if (metric === "favorability") {
    const engines = await degradeOnApiFailure(KPI_TAB_DEGRADE_LABELS.hero, () =>
      afterEssentials(filters, ctx, () => fetchEngineRows(filters, ctx, { part: KPI_TAB_ENGINE_PART })),
    );
    return engines ? toFavorabilitySubKpis(engines) : empty;
  }
  const res = await degradeOnApiFailure(KPI_TAB_DEGRADE_LABELS.hero, () => fetchMentionSummary(filters, ctx));
  return res ? toHeroSubKpis(res, metric) : empty;
}

/**
 * Drop-in for fetchStandardKpiHeroSubKpisPrev. Period mode (any period end) -> null (DC-05: the
 * badge uses the round Δ). Snapshot -> the previous round (cycle_offset=1), asOf = meta.as_of;
 * no previous round ('*' suppressed or no as_of) -> null.
 */
export async function loadKpiHeroSubKpisPrev(
  filters: StandardFilters,
  ctx: MentionsContext,
  metric: HeroMetric,
): Promise<PrevSubKpis | null> {
  if (filters.dateFrom || filters.dateTo) return null;
  return degradeOnApiFailure("standardKpiHeroPrev", () =>
    afterEssentials(filters, ctx, async () => {
      if (metric === "favorability") {
        const engines = await fetchEngineRows(filters, ctx, { cycleOffset: 1, part: KPI_TAB_ENGINE_PART });
        if (wholeSuppression(engines.meta) || !engines.meta.as_of) return null;
        return { sub: toFavorabilitySubKpis(engines), asOf: engines.meta.as_of };
      }
      const res = await fetchMentionSummary(filters, ctx, { cycleOffset: 1 });
      if (wholeSuppression(res.meta) || !res.meta.as_of) return null;
      return { sub: toHeroSubKpis(res, metric), asOf: res.meta.as_of };
    }),
  );
}

// ── engine trend ─────────────────────────────────────────────────────────────

/** K-3 row -> EngineKpiPoint (legacy latest scalar). */
export function toEnginePoint(r: ApiEnginesData["rows"][number]): EngineKpiPoint {
  const n = (v: number | null | undefined) => v ?? 0;
  const answers = n(r.answers);
  const totalMentions = n(r.total_mentions);
  return {
    engine: r.engine,
    answers,
    trackedAnswers: n(r.tracked),
    exposurePct: pctOrNull(n(r.tracked), answers),
    totalMentions,
    trackedMentions: n(r.tracked_mentions),
    sovPct: pctOrNull(n(r.tracked_mentions), totalMentions),
    sentSignals: n(r.sent_mentions),
    positiveSignals: n(r.positive_mentions),
    negativeSignals: n(r.negative_mentions),
  };
}

/** M-1 group_by=engine -> EngineBrandPoint[] (each engine: own rows + its top competitors). */
export function toLatestBrands(data: ApiBrandsData): EngineBrandPoint[] {
  const out: EngineBrandPoint[] = [];
  for (const e of data.by_engine ?? []) {
    for (const b of e.brands) {
      out.push({ engine: e.engine, brand: b.name, isTracked: b.is_own, answersWithBrand: b.exposure.num, mentions: b.mentions });
    }
  }
  return out;
}

type PointIdx = Map<string, ApiTrendPoint>;

/** T-1 dimension=engine -> engines (sorted) + EngineKpiBucket[] keyed by round date. */
export function toEngineBuckets(data: ApiTrendData): { engines: string[]; buckets: EngineKpiBucket[] } {
  const byEngine = new Map<string, Map<string, PointIdx>>();
  for (const s of data.series) {
    if (!s.key) continue;
    let m = byEngine.get(s.key);
    if (!m) byEngine.set(s.key, (m = new Map()));
    if (!m.has(s.metric)) m.set(s.metric, new Map(s.points.map((p) => [p.bucket, p])));
  }
  const engines = [...byEngine.keys()].sort();
  const buckets: EngineKpiBucket[] = [];
  for (const b of data.buckets) {
    const points: EngineKpiPoint[] = [];
    for (const engine of engines) {
      const m = byEngine.get(engine)!;
      const vp = m.get("visibility")?.get(b.key);
      if (!vp || pointGap(vp) || vp.gap || !vp.ratio) continue;
      const v = vp.ratio;
      const s = m.get("share_of_voice")?.get(b.key);
      const e = m.get("sentiment")?.get(b.key);
      const sv = s && !s.gap ? s.ratio : null;
      const ev = e && !e.gap ? e.ratio : null;
      points.push({
        engine,
        answers: v.den,
        trackedAnswers: v.num,
        exposurePct: pctOrNull(v.num, v.den),
        totalMentions: sv?.den ?? 0,
        trackedMentions: sv?.num ?? 0,
        sovPct: sv ? pctOrNull(sv.num, sv.den) : null,
        sentSignals: ev?.den ?? 0,
        positiveSignals: ev?.num ?? 0,
        negativeSignals: e && !e.gap ? (e.negative ?? 0) : 0,
      });
    }
    if (!points.length) continue;
    buckets.push({ bucketStart: bucketRoundDate(b), measuredDays: b.measured_days ?? 0, firstAt: null, lastAt: null, engines: points });
  }
  return { engines, buckets };
}

/** T-1 dimension=type -> TypeTrendBucket[] (legacy D29 shape). */
export function toTypeTrend(data: ApiTrendData): TypeTrendBucket[] {
  const idx = new Map<string, PointIdx>();
  for (const s of data.series) if (s.key) idx.set(s.key, new Map(s.points.map((p) => [p.bucket, p])));
  const out: TypeTrendBucket[] = [];
  for (const b of data.buckets) {
    let answers: number | null = null;
    const byType = {} as Record<MentionTypeKey, number>;
    for (const t of MENTION_TYPES) {
      const p = idx.get(t)?.get(b.key);
      if (p && !p.gap && p.ratio) {
        answers ??= p.ratio.den;
        byType[t] = p.ratio.num;
      } else byType[t] = 0;
    }
    if (answers === null) continue;
    out.push({ bucketStart: bucketRoundDate(b), answers, byType });
  }
  return out;
}

export interface EngineTrendParts {
  engines: Enveloped<ApiEnginesData>;
  latestBrands: Enveloped<ApiBrandsData> | null;
  engineTrend: TrendResponse | null;
  typeTrend: TrendResponse | null;
  overview: TrendResponse | null;
}

/**
 * K-3 + M-1(engine) + T-1(engine, type, none) -> EngineKpiTrend. A failed trend read is
 * trendDegraded with the snapshot scalars kept (legacy C2 contract). The engine × brand and the
 * type trend reads count too (B034): the legacy trend phase computed them, and its failure was
 * this same mark (the type combo then says degradedTrend instead of an empty chart).
 */
export function toEngineKpiTrend(p: EngineTrendParts): EngineKpiTrend {
  const degraded = !p.engineTrend || !p.overview || !p.typeTrend || !p.latestBrands;
  const eng = p.engineTrend ? toEngineBuckets(p.engineTrend.data) : { engines: [], buckets: [] };
  const latest = wholeSuppression(p.engines.meta) ? [] : p.engines.data.rows.map(toEnginePoint);
  const out: EngineKpiTrend = {
    unit: "week",
    engines: eng.engines,
    buckets: eng.buckets,
    latestBrands: p.latestBrands && !wholeSuppression(p.latestBrands.meta) ? toLatestBrands(p.latestBrands.data) : [],
    typeTrend: p.typeTrend ? toTypeTrend(p.typeTrend.data) : [],
    latest,
    latestMeasuredAt: p.engines.meta.as_of ?? null,
    trendDegraded: degraded,
    windowStartBucket: null,
    windowEndBucket: null,
  };
  if (p.overview) {
    const slots = p.engineTrend
      ? withEngineBreakdown(toStandardTrendBuckets(p.overview.data), p.engineTrend.data)
      : toStandardTrendBuckets(p.overview.data);
    out.overviewSlots = slots;
    out.overviewDeltaSlots = slots;
    out.trendGrid = trendGridOf(p.overview.data);
  }
  return out;
}

/** Engine × brand snapshot (BG-16): each engine's own rows + top 30 competitors. */
export const ENGINE_BRAND_TOP_N = 30;

/**
 * M-1 group_by=engine of the engine section (B038): toLatestBrands reads by_engine only, so
 * engine_only=true skips the window-wide own totals, competitor rows and sentiment (by_engine and
 * meta are the same).
 */
export const ENGINE_BRANDS: BrandsRequest = {
  top_n: ENGINE_BRAND_TOP_N,
  sort: "mentions",
  split_own: true,
  group_by: "engine",
  engine_only: true,
};

/** T-1 engine metrics of the engine section (buckets, BG-09 negative, BG-10 measured days). */
export const ENGINE_TREND_METRICS = ["visibility", "share_of_voice", "sentiment"] as const;

/** Drop-in for fetchStandardKpiEngineTrend. null when the engine scalars themselves failed. */
export async function loadEngineKpiTrend(filters: StandardFilters, ctx: MentionsContext): Promise<EngineKpiTrend | null> {
  const engines = await degradeOnApiFailure("standardKpiEngineTrend", () =>
    afterEssentials(filters, ctx, () => fetchEngineRows(filters, ctx, { part: KPI_TAB_ENGINE_PART })),
  );
  if (!engines) return null;
  const [latestBrands, trends, overview] = await Promise.all([
    degradeOnApiFailure("standardKpiEngineTrend.brands", () => fetchMentionBrands(filters, ctx, ENGINE_BRANDS)),
    // B038: the engine and type trends in one call (backend dims: one window, base scan and
    // measured days). Each block equals its former separate call; the type block now carries
    // measured days too, which toTypeTrend does not read. The overview (none) stays its own call:
    // it is the D6 essential the hero, card Δ and first rank share.
    degradeOnApiFailure("standardKpiEngineTrend.trend", () =>
      fetchTrendDims(filters, {
        ...ctx,
        bucket: "cycle",
        dimension: "engine",
        metrics: ENGINE_TREND_METRICS,
        dims: [{ dimension: "type", metrics: ["type_exposure"] }],
      }),
    ),
    degradeOnApiFailure("standardKpiEngineTrend.overview", () => fetchOverviewTrend(filters, ctx)),
  ]);
  const engineTrend = trends?.get("engine") ?? null;
  const typeTrend = trends?.get("type") ?? null;
  return toEngineKpiTrend({ engines, latestBrands, engineTrend, typeTrend, overview });
}

// ── brand trend and first rank ──────────────────────────────────────────────

/** Drop-in for fetchStandardKpiBrandTrend (series labels = the M-1 row names, BG-48). */
export async function loadBrandTrend(filters: StandardFilters, ctx: MentionsContext): Promise<BrandTrendResult | null> {
  const res = await degradeOnApiFailure("standardKpiBrandTrend", () =>
    afterEssentials(filters, ctx, () => fetchBrandTrend(filters, ctx)),
  );
  return res ? toBrandTrendResult(res.data) : null;
}

/** Latest rank rows: the trend series brands (own first), values from the M-1 rows by name. */
export function toFirstPositionLatest(series: readonly string[], brands: ApiBrandsData | null): FirstPositionRow[] {
  const byName = new Map((brands?.brands ?? []).map((b) => [b.name, b]));
  let competitors = 0;
  const names = series.length
    ? series
    : (brands?.brands ?? []).filter((b) => b.is_own || competitors++ < 10).map((b) => b.name);
  return rankFirstPositionRows(
    names.map((name) => {
      const b = byName.get(name);
      return {
        brand: name,
        isTracked: b?.is_own ?? false,
        avgPosition: rankAvg(b?.avg_rank),
        rankedAnswers: b?.avg_rank?.count ?? 0,
        mentions: b?.mentions ?? 0,
      };
    }),
  );
}

export interface FirstPositionParts {
  trend: TrendResponse | null;
  brands: Enveloped<ApiBrandsData> | null;
  summary: SummaryResponse | null;
  overview: TrendResponse | null;
}

/** T-1 brand (position) + M-1 + K-1 + T-1 none -> FirstPositionResult. */
export function toFirstPositionResultApi(p: FirstPositionParts): FirstPositionResult {
  const base: FirstPositionResult = p.trend
    ? toFirstPositionResult(p.trend.data)
    : { unit: "week", brands: [], buckets: [], latest: [] };
  const brands = p.brands && !wholeSuppression(p.brands.meta) ? p.brands.data : null;
  const out: FirstPositionResult = { ...base, latest: toFirstPositionLatest(base.brands, brands) };
  if (p.summary && !wholeSuppression(p.summary.meta) && !suppressionOf(p.summary.meta, "position")) {
    out.overviewCards = toOverviewCards(p.summary.data);
  }
  if (p.overview) {
    const slots = toStandardTrendBuckets(p.overview.data);
    out.overviewSlots = slots;
    out.overviewDeltaSlots = slots;
  }
  return out;
}

/** Drop-in for fetchStandardKpiFirstPosition. null when the brand rows failed (the tab's only source). */
export async function loadFirstPosition(filters: StandardFilters, ctx: MentionsContext): Promise<FirstPositionResult | null> {
  startEssentials(filters, ctx);
  const brands = await degradeOnApiFailure("standardKpiFirstPosition", () => fetchMentionBrands(filters, ctx));
  if (!brands) return null;
  const [trendLabel, summaryLabel, overviewLabel] = FIRST_POSITION_HERO_LABELS;
  const [trend, summary, overview] = await Promise.all([
    degradeOnApiFailure(trendLabel, () => afterEssentials(filters, ctx, () => fetchBrandTrend(filters, ctx))),
    degradeOnApiFailure(summaryLabel, () => fetchMentionSummary(filters, ctx)),
    degradeOnApiFailure(overviewLabel, () => fetchOverviewTrend(filters, ctx)),
  ]);
  return toFirstPositionResultApi({ trend, brands, summary, overview });
}

// ── types and stance ────────────────────────────────────────────────────────

/** M-2 -> TypeKpi (legacy aggregateTypeKpiFromMirror shape). */
export function toTypeKpi(data: ApiTypesData): TypeKpi {
  const byType = new Map(data.by_type.map((r) => [r.type, r]));
  const rows: TypeKpiRow[] = MENTION_TYPES.map((type) => {
    const r = byType.get(type);
    const ownMentions = r?.own_mentions ?? 0;
    const otherMentions = r?.other_mentions ?? 0;
    const totalMentions = ownMentions + otherMentions;
    return {
      type,
      ownMentions,
      otherMentions,
      totalMentions,
      ownAnswers: r?.own_answers ?? 0,
      otherAnswers: r?.other_answers ?? 0,
      ownExposurePct: pctOrNull(r?.own_answers ?? 0, data.answers_total),
      otherExposurePct: pctOrNull(r?.other_answers ?? 0, data.answers_total),
      ownSharePct: pctOrNull(ownMentions, totalMentions),
    };
  });
  const matrix = (scope: "own" | "all"): TypeSentimentRow[] =>
    MENTION_TYPES.map((type) => {
      const c = data.sentiment_matrix.find((m) => m.scope === scope && m.type === type);
      return {
        type,
        rows: c?.rows ?? 0,
        positive: c?.positive ?? 0,
        neutral: c?.neutral ?? 0,
        negative: c?.negative ?? 0,
        mixed: c?.mixed ?? 0,
      };
    });
  return {
    totalAnswers: data.answers_total,
    totalMentions: rows.reduce((s, r) => s + r.totalMentions, 0),
    ownMentions: rows.reduce((s, r) => s + r.ownMentions, 0),
    rows,
    sentimentMatrix: { own: matrix("own"), all: matrix("all") },
  };
}

/** Drop-in for fetchStandardKpiTypes. Failure or whole suppression -> null (legacy kpiDegrade). */
export async function loadTypeKpi(filters: StandardFilters, ctx: MentionsContext): Promise<TypeKpi | null> {
  const res = await degradeOnApiFailure(KPI_TAB_DEGRADE_LABELS.types, () =>
    afterEssentials(filters, ctx, () => fetchMentionTypes(filters, ctx)),
  );
  if (!res || wholeSuppression(res.meta)) return null;
  return toTypeKpi(res.data);
}

/** M-2 stance -> AnswerStanceDistribution (null = "수집 대기"). */
export function toStanceDist(data: ApiTypesData): AnswerStanceDistribution | null {
  const s = data.stance;
  return s ? { positive: s.positive, neutral: s.neutral, mixed: s.mixed, negative: s.negative, pairs: s.pairs } : null;
}

/**
 * Drop-in for fetchStandardKpiStanceDist (the card is off today: STANCE_CARD_ENABLED). The only
 * reader of data.stance, so the only M-2 call that keeps include_stance (B036).
 */
export async function loadStanceDist(filters: StandardFilters, ctx: MentionsContext): Promise<AnswerStanceDistribution | null> {
  const res = await degradeOnApiFailure("standardKpiStance", () =>
    afterEssentials(filters, ctx, () => fetchMentionTypes(filters, ctx, { stance: true })),
  );
  if (!res || wholeSuppression(res.meta)) return null;
  return toStanceDist(res.data);
}
