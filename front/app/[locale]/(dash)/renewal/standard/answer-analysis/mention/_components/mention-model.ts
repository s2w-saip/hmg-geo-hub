// Renewal Mention view model — pure. Every number comes from the original tabs' view functions
// (standard/answer-analysis/_data/kpi-view.ts) over the same reads, so a value on this page equals
// the one the original shows for the same URL; this module only regroups them for the redesign
// (one lens of four KPIs, one board, one brand-detail section) and derives the summary rules.
//
// Conventions kept from kpi-view.ts: snapshot values vs round trends are never mixed in one
// column, null = "no measurement" (never 0), Δ compares the last two axis slots (null when the
// slot before is a gap), the 당사 value is the answer-level DISTINCT union (not a sum of brands).

import type {
  BrandTrendResult,
  EngineKpiTrend,
  FirstPositionResult,
  MentionTypeKey,
  StandardSubKpis,
  TypeKpi,
} from "@/lib/db/repositories/scope-aggregates";
import type { CompetitorBrandValue, MentionsBrandLive, MentionTypesByBrand } from "@/lib/scope/result-adapter";
import type { MentionSentimentBreakdown } from "@/lib/scope/types";
import type { CompareMetricKey, CompareResult } from "@/lib/kpi/period-compare";
import { periodCaption, type PeriodCaptionMessage } from "@/lib/kpi/period-compare-view";
import {
  competitorKpiRows,
  deltaPp,
  deltaPosition,
  engineCompetitorBars,
  engineKpiSeries,
  engineTrendSeriesAvailable,
  favorabilityHero,
  favorabilityTrendPoints,
  firstRankDeltaBasis,
  firstRankHero,
  heroTrendAvailable,
  kpiHero,
  kpiTrendPoints,
  overlayFirstPositionValues,
  overviewDeltaFromSlots,
  ownPositionSeries,
  pctOrNull,
  rankTableRows,
  sentimentSegments,
  trendAxis,
  typeComboPoints,
  typeSentimentRows,
  type KpiMetric,
  type SentimentSegment,
  type TypeSentimentRowVM,
} from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view";
import type { KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import { NON_AUTO_GROUP, parentGroupOf } from "./brand-groups";
import type { RnMentionPeriod } from "./mention-input";

export const OWN_KEY = "__own";
const HMG_BRANDS = ["Hyundai", "Kia", "Genesis"];
const round1 = (n: number) => Math.round(n * 10) / 10;
const lastTwo = (s: readonly (number | null)[], diff: (a: number | null, b: number | null) => number | null) =>
  s.length >= 2 ? diff(s[s.length - 1], s[s.length - 2]) : null;

/** An HMG brand that is not 당사 for this account (brand accounts see their siblings as brands). */
export const isHmgSibling = (brand: string, tracked: boolean) => !tracked && HMG_BRANDS.includes(brand);

// ── Δ: the original's precedence, one function ───────────────────────────────────────────

export type DeltaBasis =
  | { kind: "period"; caption: PeriodCaptionMessage }
  | { kind: "cycle"; date: string | null }
  | { kind: "prev"; date: string };

export interface RnDelta {
  value: number | null;
  basis: DeltaBasis | null;
}

/**
 * period compare (that metric) → the Overview card rule (last two valued slots, "직전 회차") →
 * the previous snapshot (sub-kpis-prev) — PeriodDeltaSlot + HeroDelta of the original tabs.
 */
export function resolveDelta(input: {
  period: RnMentionPeriod | null;
  compareKey: CompareMetricKey | null;
  cycle: { pp: number; basisDate: string } | null;
  prev: { cur: number | null; prev: number | null; asOf: string } | null;
}): RnDelta {
  const r: CompareResult | undefined = input.compareKey ? input.period?.compare?.find((x) => x.metric === input.compareKey) : undefined;
  if (r && input.period) {
    const v = r.delta == null ? null : Math.sign(r.delta) * round1(Math.abs(r.delta));
    return { value: v === 0 ? 0 : v, basis: { kind: "period", caption: periodCaption(r, { days: input.period.days ?? 0, kind: input.period.kind }) } };
  }
  if (input.cycle) return { value: input.cycle.pp, basis: { kind: "cycle", date: input.cycle.basisDate } };
  if (input.prev) return { value: deltaPp(input.prev.cur, input.prev.prev), basis: { kind: "prev", date: input.prev.asOf } };
  return { value: null, basis: null };
}

// ── KPI lens (four tiles) + heroes ────────────────────────────────────────────────────────

export interface RateHero {
  metric: KpiMetric;
  pct: number | null;
  numerator: number;
  denominator: number;
  delta: RnDelta;
  /** hero trend (Overview slots or the mirror buckets), keyed by slot */
  points: Array<{ key: string; pct: number | null; numerator: number | null; denominator: number | null; gap: boolean }>;
  /** the trend could not be drawn (budget / degrade) — the value is still valid */
  trendMissing: boolean;
}

const OVERVIEW_KEY = { exposure: "visibility", sov: "shareOfVoice" } as const;
const COMPARE_KEY = { exposure: "visibility", sov: "share" } as const;

export function rateHero(
  metric: KpiMetric,
  sub: StandardSubKpis | null,
  prev: { sub: StandardSubKpis; asOf: string } | null,
  engine: EngineKpiTrend | null,
  period: RnMentionPeriod | null,
): RateHero {
  const hero = kpiHero(sub, metric);
  const cycle = overviewDeltaFromSlots(engine?.overviewDeltaSlots, OVERVIEW_KEY[metric]);
  const points = kpiTrendPoints(engine, metric).map((p) => ({ key: p.bucketStart, pct: p.pct, numerator: p.numerator, denominator: p.denominator, gap: Boolean(p.gap) }));
  return {
    metric,
    pct: hero.pct,
    numerator: hero.numerator,
    denominator: hero.denominator,
    delta: resolveDelta({
      period,
      compareKey: COMPARE_KEY[metric],
      cycle,
      prev: prev ? { cur: hero.pct, prev: kpiHero(prev.sub, metric).pct, asOf: prev.asOf } : null,
    }),
    points,
    trendMissing: !heroTrendAvailable(engine),
  };
}

export interface FavorHero {
  positivePct: number | null;
  negativePct: number | null;
  positive: number;
  total: number;
  positiveDelta: RnDelta;
  negativeDelta: RnDelta;
  /** positive from the Overview fact table, negative from the mirror (sums may not reach 100) */
  mixedBasis: boolean;
  points: Array<{ key: string; positive: number | null; negative: number | null; gap: boolean }>;
  trendMissing: boolean;
}

export function favorHero(
  sub: StandardSubKpis | null,
  prev: { sub: StandardSubKpis; asOf: string } | null,
  engine: EngineKpiTrend | null,
  period: RnMentionPeriod | null,
): FavorHero {
  const h = favorabilityHero(sub);
  const p = prev ? favorabilityHero(prev.sub) : null;
  return {
    positivePct: h.positivePct,
    negativePct: h.negativePct,
    positive: h.positive,
    total: h.total,
    positiveDelta: resolveDelta({
      period,
      compareKey: "favorability",
      cycle: overviewDeltaFromSlots(engine?.overviewDeltaSlots, "sentiment"),
      prev: prev && p ? { cur: h.positivePct, prev: p.positivePct, asOf: prev.asOf } : null,
    }),
    // 부정 비율은 계약 지표가 없다 → 종전 Δ(직전 스냅샷)만.
    negativeDelta: resolveDelta({ period: null, compareKey: null, cycle: null, prev: prev && p ? { cur: h.negativePct, prev: p.negativePct, asOf: prev.asOf } : null }),
    mixedBasis: Boolean(sub?.overviewCards),
    points: favorabilityTrendPoints(engine).map((x) => ({ key: x.bucketStart, positive: x.positivePct, negative: x.negativePct, gap: Boolean(x.gap) })),
    trendMissing: !engine || engine.trendDegraded === true,
  };
}

export interface RankHero {
  avgPosition: number | null;
  rankedAnswers: number;
  delta: RnDelta;
  /** combined 당사 position per slot (gap = null) */
  series: (number | null)[];
  axis: string[];
}

export function rankHero(fp: FirstPositionResult | null, period: RnMentionPeriod | null): RankHero {
  const h = firstRankHero(fp);
  const r = period?.compare?.find((x) => x.metric === "position");
  const delta: RnDelta = r
    ? resolveDelta({ period, compareKey: "position", cycle: null, prev: null })
    : { value: h.delta, basis: h.delta == null ? null : { kind: "cycle", date: firstRankDeltaBasis(fp) } };
  return {
    avgPosition: h.avgPosition,
    rankedAnswers: h.rankedAnswers,
    delta,
    series: fp ? ownPositionSeries(fp) : [],
    axis: fp ? trendAxis(fp.buckets, fp.unit, fp).map((a) => a.bucketStart) : [],
  };
}

export interface LensTile {
  key: KpiTab;
  value: number | null;
  spark: (number | null)[];
  delta: RnDelta;
}

// ── 경쟁 구도 board (exposure / sov) ──────────────────────────────────────────────────────

export interface BoardRow {
  /** brand name, or OWN_KEY for the combined 당사 row */
  key: string;
  own: boolean;
  sibling: boolean;
  pct: number | null;
  mentions: number | null;
  spark: (number | null)[];
  delta: number | null;
  /** competitor − 당사 (pp); null on the 당사 row or when either value is missing */
  gap: number | null;
  /** has a round trend (당사 + the top-10 series) — only these can be compared */
  covered: boolean;
}

export interface Board {
  rows: BoardRow[];
  /** trend axis of the sparks (the brand-trend axis) */
  axis: string[];
  measuredCycles: number;
  ownRank: number | null;
}

/** Competitor rows shown on the board (the original table's cap, 당사 rows excluded). */
export const BOARD_COMPETITORS = 12;

export function board(input: {
  metric: KpiMetric;
  brands: MentionsBrandLive[];
  trend: BrandTrendResult | null;
  values: readonly CompetitorBrandValue[] | null;
  hero: RateHero;
}): Board {
  const { metric, brands, trend, values, hero } = input;
  const tracked = brands.filter((b) => b.isTracked).length;
  const rows = competitorKpiRows({ brands, trend, metric, ownPct: hero.pct, values, limit: tracked + BOARD_COMPETITORS });
  const axisEntries = trend ? trendAxis(trend.buckets, trend.unit, trend) : [];
  const axis = axisEntries.map((a) => a.bucketStart);
  const series = new Set(trend?.brands.map((b) => b.brand) ?? []);
  const heroBy = new Map(hero.points.map((p) => [p.key, p.pct]));
  const ownSpark = axis.length ? axis.map((k) => heroBy.get(k) ?? null) : hero.points.map((p) => p.pct);
  const own: BoardRow = { key: OWN_KEY, own: true, sibling: false, pct: hero.pct, mentions: null, spark: ownSpark, delta: hero.delta.value, gap: null, covered: true };
  const comps: BoardRow[] = rows
    .filter((r) => !r.isTracked)
    .map((r) => ({
      key: r.brand,
      own: false,
      sibling: isHmgSibling(r.brand, false),
      pct: r.pct,
      mentions: r.mentions,
      spark: r.spark,
      delta: r.wowPp,
      gap: r.gapPp,
      covered: series.has(r.brand),
    }));
  const all = [own, ...comps].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || (a.own ? -1 : b.own ? 1 : a.key.localeCompare(b.key)));
  return {
    rows: all,
    axis,
    measuredCycles: axisEntries.filter((a) => a.measured).length,
    ownRank: hero.pct == null ? null : all.findIndex((r) => r.own) + 1,
  };
}

/** Hero chart series on the hero axis: 당사 + the compare brands (or the covered competitors' average). */
export function heroTrendSeries(
  hero: RateHero,
  trend: BrandTrendResult | null,
  metric: KpiMetric,
  compare: readonly string[],
): { x: string[]; own: (number | null)[]; brands: Array<{ key: string; values: (number | null)[] }>; average: (number | null)[] | null } {
  const x = hero.points.map((p) => p.key);
  const byBucket = new Map(trend?.buckets.map((b) => [b.bucketStart, b]) ?? []);
  const valueOf = (brand: string, key: string) => {
    const hit = byBucket.get(key)?.brands.find((b) => b.brand === brand);
    return hit ? (metric === "exposure" ? hit.exposurePct : hit.sharePct) : null;
  };
  const competitors = (trend?.brands ?? []).filter((b) => !b.isTracked).map((b) => b.brand);
  const brands = compare.filter((b) => competitors.includes(b)).map((key) => ({ key, values: x.map((k) => valueOf(key, k)) }));
  const average =
    compare.length === 0 && competitors.length
      ? x.map((k) => {
          const vs = competitors.map((b) => valueOf(b, k)).filter((v): v is number => v != null);
          return vs.length ? round1(vs.reduce((s, v) => s + v, 0) / vs.length) : null;
        })
      : null;
  return { x, own: hero.points.map((p) => p.pct), brands, average };
}

// ── AI 엔진별 ─────────────────────────────────────────────────────────────────────────────

export interface EngineRow {
  engine: string;
  own: number | null;
  avg: number | null;
  avgCount: number;
  gap: number | null;
  series: (number | null)[];
  delta: number | null;
}

export function engineRows(engine: EngineKpiTrend | null, metric: KpiMetric): { rows: EngineRow[]; x: string[]; trendMissing: boolean } {
  const bars = engineCompetitorBars(engine, metric);
  const { points } = engineKpiSeries(engine, metric);
  const x = points.map((p) => String(p.bucketStart));
  const rows = bars.map((b) => {
    const series = points.map((p) => {
      const v = p[b.engine];
      return typeof v === "number" ? v : null;
    });
    return { engine: b.engine, own: b.ownPct, avg: b.competitorAvgPct, avgCount: b.competitorCount, gap: deltaPp(b.ownPct, b.competitorAvgPct), series, delta: lastTwo(series, deltaPp) };
  });
  return { rows, x, trendMissing: !engineTrendSeriesAvailable(engine) };
}

// ── 멘션 유형 ─────────────────────────────────────────────────────────────────────────────

/** Strongest endorsement first — the rows that matter most come first. */
export const TYPE_STRENGTH: readonly MentionTypeKey[] = ["final_choice", "recommendation", "comparison", "definition", "mention"];
export const TYPE_AVG_TOP = 5;

export interface TypeCompareRow {
  type: MentionTypeKey;
  /** 당사 share of the type's signals (all tracked brands) */
  own: number | null;
  /** average share of the top-5 competitors by mentions */
  avg: number | null;
  dots: Array<{ brand: string; value: number | null }>;
  /** the reference: the leading compare brand, else the competitor average */
  ref: { brand: string | null; value: number | null };
  gap: number | null;
}

export function typeCompareRows(input: { typesByBrand: MentionTypesByBrand | null; brands: MentionsBrandLive[]; compare: readonly string[] }): TypeCompareRow[] {
  const tb = input.typesByBrand;
  if (!tb) return [];
  const byBrand = new Map(tb.brands.map((b) => [b.brand, b]));
  const avgSet = [...input.brands]
    .filter((b) => !b.isTracked && byBrand.has(b.brand))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, TYPE_AVG_TOP)
    .map((b) => b.brand);
  return TYPE_STRENGTH.map((type) => {
    const total = tb.totals[type];
    const share = (n: number) => pctOrNull(n, total);
    const own = share(tb.brands.filter((b) => b.isTracked).reduce((s, b) => s + b.types[type], 0));
    const avgVals = avgSet.map((b) => share(byBrand.get(b)!.types[type])).filter((v): v is number => v != null);
    const avg = avgVals.length ? round1(avgVals.reduce((s, v) => s + v, 0) / avgVals.length) : null;
    const dots = input.compare.map((brand) => {
      const hit = byBrand.get(brand);
      return { brand, value: hit && !hit.isTracked ? share(hit.types[type]) : null };
    });
    const valued = dots.filter((d): d is { brand: string; value: number } => d.value != null);
    const ref = valued.length ? valued.reduce((a, c) => (c.value > a.value ? c : a)) : { brand: null, value: avg };
    return { type, own, avg, dots, ref, gap: deltaPp(own, ref.value) };
  });
}

export interface TypeOwnRow {
  type: MentionTypeKey;
  /** exposure: 당사 answers with the type ÷ all answers; sov: 당사 signals of the type ÷ 당사 signals */
  pct: number | null;
  signals: number;
  /** exposure only: per-type exposure per slot (sov has no per-type trend) */
  spark: (number | null)[];
  delta: number | null;
}

export function typeOwnRows(kpi: TypeKpi | null, engine: EngineKpiTrend | null, metric: KpiMetric): TypeOwnRow[] {
  if (!kpi) return [];
  const combo = metric === "exposure" ? typeComboPoints(engine) : [];
  return TYPE_STRENGTH.map((type) => {
    const r = kpi.rows.find((x) => x.type === type);
    const spark = combo.map((p) => p.byType[type]);
    return {
      type,
      pct: r ? (metric === "exposure" ? r.ownExposurePct : pctOrNull(r.ownMentions, kpi.ownMentions)) : null,
      signals: r?.ownMentions ?? 0,
      spark,
      delta: lastTwo(spark, deltaPp),
    };
  });
}

// ── 우호도 ────────────────────────────────────────────────────────────────────────────────

export function favorDistribution(totals: MentionSentimentBreakdown | null): SentimentSegment[] {
  return sentimentSegments(totals);
}

/** 전체 first, then the types strongest endorsement first. */
export function favorMatrix(kpi: TypeKpi | null): TypeSentimentRowVM[] {
  const rows = typeSentimentRows(kpi, "own");
  const all = rows.find((r) => r.type === "all");
  return all ? [all, ...TYPE_STRENGTH.map((t) => rows.find((r) => r.type === t)).filter((r): r is TypeSentimentRowVM => Boolean(r))] : [];
}

// ── 우선 노출도 ───────────────────────────────────────────────────────────────────────────

export interface RankRow {
  key: string;
  own: boolean;
  sibling: boolean;
  avgPosition: number | null;
  rank: number | null;
  spark: (number | null)[];
  delta: number | null;
  /** competitor − 당사 (positive = the brand is named after 당사) */
  gap: number | null;
  covered: boolean;
}

export function rankBoard(fp: FirstPositionResult | null, values: readonly CompetitorBrandValue[] | null, hero: RankHero): { rows: RankRow[]; ahead: number } {
  const overlaid = overlayFirstPositionValues(fp, values);
  const table = rankTableRows(overlaid, { sparkCycles: 4 });
  const series = new Set(overlaid?.brands ?? []);
  const own: RankRow = {
    key: OWN_KEY,
    own: true,
    sibling: false,
    avgPosition: hero.avgPosition,
    rank: null,
    spark: hero.series.slice(-4),
    delta: hero.delta.value,
    gap: null,
    covered: true,
  };
  const comps: RankRow[] = table
    .filter((r) => !r.isTracked)
    .map((r) => ({
      key: r.brand,
      own: false,
      sibling: isHmgSibling(r.brand, false),
      avgPosition: r.avgPosition,
      rank: r.rank,
      spark: r.spark,
      delta: r.wow,
      gap: r.avgPosition != null && hero.avgPosition != null ? deltaPosition(r.avgPosition, hero.avgPosition) : null,
      covered: series.has(r.brand),
    }));
  const rows = [own, ...comps].sort((a, b) => (a.avgPosition ?? Infinity) - (b.avgPosition ?? Infinity) || (a.own ? -1 : b.own ? 1 : a.key.localeCompare(b.key)));
  const ahead = hero.avgPosition == null ? 0 : comps.filter((r) => r.avgPosition != null && r.avgPosition < hero.avgPosition!).length;
  return { rows, ahead };
}

/** Position per slot of a competitor (rank chart), on the hero axis. */
export function rankSeriesOf(fp: FirstPositionResult | null, brand: string, axis: readonly string[]): (number | null)[] {
  const by = new Map(fp?.buckets.map((b) => [b.bucketStart, b]) ?? []);
  return axis.map((k) => by.get(k)?.brands.find((x) => x.brand === brand)?.avgPosition ?? null);
}

// ── 브랜드 언급 상세: bump (weekly mention rank), share Δ, table, treemap ───────────────────

export interface BumpSeries {
  key: string;
  own: boolean;
  mentions: (number | null)[];
  shares: (number | null)[];
  ranks: (number | null)[];
}
export interface BumpData {
  x: string[];
  series: BumpSeries[];
  /** first / last slot with a measurement */
  first: number;
  last: number;
}

/** Weekly mention ranks of 당사 (all tracked brands summed) and the top-10 competitor series. */
export function bumpData(trend: BrandTrendResult | null): BumpData | null {
  if (!trend || trend.buckets.length === 0) return null;
  const axis = trendAxis(trend.buckets, trend.unit, trend);
  const by = new Map(trend.buckets.map((b) => [b.bucketStart, b]));
  const comps = trend.brands.filter((b) => !b.isTracked).map((b) => b.brand);
  const hasOwn = trend.brands.some((b) => b.isTracked);
  const keys = [...(hasOwn ? [OWN_KEY] : []), ...comps];
  const series: BumpSeries[] = keys.map((key) => ({ key, own: key === OWN_KEY, mentions: [], shares: [], ranks: [] }));
  axis.forEach((a) => {
    const b = a.measured ? by.get(a.bucketStart) : undefined;
    for (const s of series) {
      if (!b) {
        s.mentions.push(null);
        s.shares.push(null);
        continue;
      }
      const hits = s.own ? b.brands.filter((x) => x.isTracked) : b.brands.filter((x) => x.brand === s.key);
      s.mentions.push(hits.length ? hits.reduce((n, x) => n + x.mentions, 0) : 0);
      s.shares.push(hits.length ? round1(hits.reduce((n, x) => n + (x.sharePct ?? 0), 0)) : 0);
    }
  });
  axis.forEach((_, i) => {
    const order = series
      .filter((s) => s.mentions[i] != null)
      .sort((a, b) => b.mentions[i]! - a.mentions[i]! || (b.shares[i] ?? 0) - (a.shares[i] ?? 0) || a.key.localeCompare(b.key));
    for (const s of series) s.ranks[i] = s.mentions[i] == null ? null : order.indexOf(s) + 1;
  });
  const measured = axis.map((a, i) => (a.measured && by.has(a.bucketStart) ? i : -1)).filter((i) => i >= 0);
  if (!measured.length) return null;
  return { x: axis.map((a) => a.bucketStart), series, first: measured[0], last: measured[measured.length - 1] };
}

/** Share Δ (pp, last two axis slots) per series brand — table / treemap colour. 당사 = sum of tracked. */
export function shareDeltas(trend: BrandTrendResult | null): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!trend) return out;
  const axis = trendAxis(trend.buckets, trend.unit, trend);
  const by = new Map(trend.buckets.map((b) => [b.bucketStart, b]));
  const sparkOf = (pick: (b: BrandTrendResult["buckets"][number]) => number | null) =>
    axis.map((a) => {
      const b = a.measured ? by.get(a.bucketStart) : undefined;
      return b ? pick(b) : null;
    });
  for (const s of trend.brands) out.set(s.brand, lastTwo(sparkOf((b) => b.brands.find((x) => x.brand === s.brand)?.sharePct ?? null), deltaPp));
  if (trend.brands.some((b) => b.isTracked)) {
    out.set(OWN_KEY, lastTwo(sparkOf((b) => round1(b.brands.filter((x) => x.isTracked).reduce((n, x) => n + (x.sharePct ?? 0), 0))), deltaPp));
  }
  return out;
}

export interface TreemapBrand {
  brand: string;
  value: number;
  share: number;
  delta: number | null;
  own: boolean;
  sibling: boolean;
}
export interface TreemapGroup {
  key: string;
  /** label; NON_AUTO_GROUP and the fold use message keys at render */
  members: TreemapBrand[];
  value: number;
  share: number;
  /** Σ member Δ over the members with a trend; null when none has one */
  delta: number | null;
  /** some members have no trend (the Δ is partial) */
  partial: boolean;
  own: boolean;
}

export const TREEMAP_FOLD = "__rest";
const FOLD_SHARE = 1.5;
const FOLD_AFTER = 14;

/**
 * Top brands → parent groups. Groups under 1.5 % of the shown total (or past the 14th) fold into
 * one block; the group holding 당사 always stays. Values: mentions (or multi-mentions).
 */
export function treemapGroups(rows: ReadonlyArray<TreemapBrand>): TreemapGroup[] {
  const by = new Map<string, TreemapBrand[]>();
  for (const r of rows) {
    const g = parentGroupOf(r.brand);
    by.set(g, [...(by.get(g) ?? []), r]);
  }
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const groups = [...by.entries()].map(([key, members]) => groupOf(key, members, total)).sort((a, b) => b.value - a.value);
  const keep = groups.filter((g, i) => g.own || (g.key !== NON_AUTO_GROUP && i < FOLD_AFTER && g.share >= FOLD_SHARE));
  const rest = groups.filter((g) => !keep.includes(g));
  return rest.length ? [...keep, groupOf(TREEMAP_FOLD, rest.flatMap((g) => g.members), total)] : keep;
}

function groupOf(key: string, members: TreemapBrand[], total: number): TreemapGroup {
  const sorted = [...members].sort((a, b) => b.value - a.value);
  const value = sorted.reduce((s, m) => s + m.value, 0);
  const withD = sorted.filter((m) => m.delta != null);
  return {
    key,
    members: sorted,
    value,
    share: round1((100 * value) / total),
    delta: withD.length ? round1(withD.reduce((s, m) => s + m.delta!, 0)) : null,
    partial: withD.length > 0 && withD.length < sorted.length,
    own: sorted.some((m) => m.own),
  };
}

/** Squarified treemap (Bruls et al.): items sorted desc → rects inside (x, y, w, h). */
export function squarify<T extends { value: number }>(items: readonly T[], x: number, y: number, w: number, h: number): Array<T & { x: number; y: number; w: number; h: number }> {
  const out: Array<T & { x: number; y: number; w: number; h: number }> = [];
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  let rest = items.map((i) => ({ item: i, area: i.value * scale }));
  let rx = x, ry = y, rw = w, rh = h;
  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row), min = Math.min(...row);
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  while (rest.length) {
    const side = Math.min(rw, rh);
    const row: typeof rest = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]].map((r) => r.area), side) <= worst(row.map((r) => r.area), side)) row.push(rest[i++]);
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (rw >= rh) {
      const cw = sum / rh;
      let cy = ry;
      for (const r of row) {
        const ch = r.area / cw;
        out.push({ ...r.item, x: rx, y: cy, w: cw, h: ch });
        cy += ch;
      }
      rx += cw;
      rw -= cw;
    } else {
      const ch = sum / rw;
      let cx = rx;
      for (const r of row) {
        const cw = r.area / ch;
        out.push({ ...r.item, x: cx, y: ry, w: cw, h: ch });
        cx += cw;
      }
      ry += ch;
      rh -= ch;
    }
    rest = rest.slice(i);
  }
  return out;
}

// ── 이번 회차 요약: rules over the numbers on the page (no new data) ───────────────────────

export type FindingKind = "standingLead" | "standingTrail" | "typeTrail" | "typeLead" | "mover" | "engine" | "climb" | "negative";

export interface Finding {
  kind: FindingKind;
  tone: "warn" | "good" | "info";
  pri: number;
  /** section to jump to */
  target: "sec-comp" | "sec-mix" | "sec-brands" | "sec-overview";
  /** KPI tab the target lives on (switch before jumping) */
  kpi?: KpiTab;
  /** brand to flash after the jump */
  brand?: string;
  params: Record<string, string | number>;
}

export interface FindingInput {
  exposure?: Board | null;
  sov?: Board | null;
  types?: TypeCompareRow[] | null;
  engines?: EngineRow[] | null;
  bump?: BumpData | null;
  favor?: FavorHero | null;
}

export function findings(f: FindingInput): Finding[] {
  const out: Finding[] = [];
  const ex = f.exposure;
  const own = ex?.rows.find((r) => r.own);
  if (ex && own && own.pct != null) {
    const rank = ex.rows.indexOf(own) + 1;
    const rival = rank === 1 ? ex.rows[1] : ex.rows[0];
    if (rival && rival.pct != null) {
      const gap = round1(own.pct - rival.pct);
      const move = own.delta != null && rival.delta != null ? round1(own.delta - rival.delta) : null;
      const lead = rank === 1;
      out.push({
        kind: lead ? "standingLead" : "standingTrail",
        tone: lead ? "good" : "warn",
        pri: lead && gap >= 5 ? 3 : 9,
        target: "sec-comp",
        kpi: "exposure",
        brand: rival.key,
        params: { rank, rival: rival.key, gap: Math.abs(gap), own: own.pct, ...(move == null ? {} : { move: Math.abs(move), widened: String(lead === move > 0) }) },
      });
    }
  }
  const types = f.types?.filter((t) => t.gap != null) ?? [];
  if (types.length) {
    const worst = [...types].sort((a, b) => a.gap! - b.gap!)[0];
    const key = types.slice(0, 2).find((t) => t.gap! < 0);
    const pick = key ?? worst;
    const trail = pick.gap! < 0;
    out.push({
      kind: trail ? "typeTrail" : "typeLead",
      tone: trail ? "warn" : "good",
      pri: trail ? 8 : 2,
      target: "sec-mix",
      kpi: "exposure",
      ...(pick.ref.brand ? { brand: pick.ref.brand } : {}),
      params: { type: pick.type, ref: pick.ref.brand ?? "", gap: Math.abs(pick.gap!), own: pick.own ?? 0, strong: String(TYPE_STRENGTH.indexOf(pick.type) < 2) },
    });
  }
  const movers = (f.sov?.rows ?? []).filter((r) => !r.own && r.delta != null).sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!));
  if (movers[0]) {
    const m = movers[0];
    const ownSov = f.sov?.rows.find((r) => r.own);
    out.push({ kind: "mover", tone: m.delta! > 0 ? "warn" : "info", pri: m.delta! > 0 ? 7 : 4, target: "sec-brands", brand: m.key, params: { brand: m.key, delta: m.delta!, own: ownSov?.delta ?? "" } });
  }
  const eg = (f.engines ?? []).filter((r) => r.gap != null).sort((a, b) => a.gap! - b.gap!);
  if (eg[0]) {
    out.push({
      kind: "engine",
      tone: eg[0].gap! < 5 ? "warn" : "info",
      pri: eg[0].gap! < 5 ? 6 : 1,
      target: "sec-mix",
      kpi: "exposure",
      params: { engine: eg[0].engine, gap: eg[0].gap!, next: eg[1]?.engine ?? "", nextGap: eg[1]?.gap ?? "" },
    });
  }
  const bump = f.bump;
  if (bump && bump.last > bump.first) {
    const climb = bump.series
      .filter((s) => !s.own && s.ranks[bump.first] != null && s.ranks[bump.last] != null)
      .map((s) => ({ key: s.key, r0: s.ranks[bump.first]!, r1: s.ranks[bump.last]! }))
      .sort((a, b) => b.r0 - b.r1 - (a.r0 - a.r1))[0];
    if (climb && climb.r0 > climb.r1) {
      out.push({ kind: "climb", tone: "info", pri: climb.r0 - climb.r1 >= 3 ? 5 : 2, target: "sec-brands", brand: climb.key, params: { brand: climb.key, from: climb.r0, to: climb.r1, weeks: bump.last - bump.first + 1 } });
    }
  }
  const neg = f.favor;
  if (neg && neg.negativePct != null && neg.negativeDelta.value != null && neg.negativeDelta.value >= 0.3) {
    out.push({ kind: "negative", tone: "warn", pri: 6, target: "sec-overview", kpi: "favorability", params: { pct: neg.negativePct, delta: neg.negativeDelta.value } });
  }
  return out.sort((a, b) => b.pri - a.pri).slice(0, 4);
}
