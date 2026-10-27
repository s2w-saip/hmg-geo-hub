import type { PeriodSlots } from "@/components/dash/period-delta-slot";
// Mention screens' payloads (GET /v1/screens/mention/* — back/bff/screens/mention.py) and the
// display-only helpers the mention components keep. Every value here arrives computed; the
// components only format and draw it.
import type { MentionTypeKey } from "@/lib/db/repositories/scope-aggregates";
import type { CompareResult } from "@/lib/kpi/period-compare";
import type { PeriodDeltaView } from "@/lib/kpi/period-compare-view";
import type { MentionTrend } from "@/lib/scope/result-adapter";
import type { TrendGap, TrendGapRow } from "@/lib/viz/trend-gap";
import type { MentionsViewData } from "../_components/mentions-view";

// ── view-model shapes (the mention screens' payload, back/bff/screens/mention*.py) ─────

export type KpiMetric = "exposure" | "sov";
export type TypeScope = "own" | "all";
export type SentimentKey = "positive" | "neutral" | "mixed" | "negative";

export interface KpiHeroValue {
  pct: number | null;
  numerator: number;
  denominator: number;
}

export interface KpiTrendPoint {
  bucketStart: string;
  pct: number | null;
  numerator: number | null;
  denominator: number | null;
  numeratorWow: number | null;
  denominatorWow: number | null;
  measuredDays: number;
  firstAt: string | null;
  lastAt: string | null;
  gap?: TrendGap;
}

export interface CoverageEntry {
  bucketStart: string;
  measuredDays: number;
}

export interface TrendCoverage {
  cycles: number;
  measuredCycles: number;
  missingCycles: number;
}

export interface CompetitorKpiRow {
  brand: string;
  isTracked: boolean;
  pct: number | null;
  mentions: number | null;
  spark: (number | null)[];
  wowPp: number | null;
  gapPp: number | null;
  inTrendSeries: boolean;
}

export interface BrandTrendSeries {
  brand: string;
  isTracked: boolean;
  colorIndex: number;
}

export interface BrandTrendChartData {
  series: BrandTrendSeries[];
  points: Array<TrendGapRow>;
  coverage: CoverageEntry[];
}

export interface EngineKpiBar {
  engine: string;
  pct: number | null;
  numerator: number;
  denominator: number;
}

export interface EngineCompetitorBar {
  engine: string;
  ownPct: number | null;
  competitorAvgPct: number | null;
  competitorCount: number;
}

export interface TypeKpiBar {
  type: MentionTypeKey;
  ownPct: number | null;
  competitorPct: number | null;
  otherPct: number | null;
  ownSignals: number;
  competitorSignals: number;
  otherSignals: number;
}

export interface TypeComboPoint {
  bucketStart: string;
  answers: number | null;
  exposurePct: number | null;
  sovPct: number | null;
  byType: Record<MentionTypeKey, number | null>;
  favorabilityPct: number | null;
  avgPosition: number | null;
  gap?: TrendGap;
}

export interface FavorabilityHeroValue {
  positivePct: number | null;
  negativePct: number | null;
  positive: number;
  negative: number;
  total: number;
}

export interface FavorabilityTrendPoint {
  bucketStart: string;
  positivePct: number | null;
  negativePct: number | null;
  positive: number | null;
  negative: number | null;
  total: number | null;
  positiveWow: number | null;
  totalWow: number | null;
  measuredDays: number;
  firstAt: string | null;
  lastAt: string | null;
  gap?: TrendGap;
}

export interface SentimentSegment {
  key: SentimentKey;
  count: number;
  pct: number | null;
}

export interface TypeSentimentRowVM {
  type: MentionTypeKey | "all";
  positive: number;
  neutral: number;
  mixed: number;
  negative: number;
  total: number;
  positivePct: number | null;
  segments: Array<{ key: SentimentKey; pct: number | null; count: number }>;
}

export interface FirstRankHeroValue {
  avgPosition: number | null;
  rank: number | null;
  rankedAnswers: number;
  delta: number | null;
  brands: string[];
}

export interface RankTableRow {
  brand: string;
  isTracked: boolean;
  rank: number | null;
  avgPosition: number | null;
  rankedAnswers: number;
  mentions: number;
  spark: (number | null)[];
  wow: number | null;
  colorIndex: number;
}

export interface FirstRankCompetitorCard {
  brand: string;
  rank: number | null;
  avgPosition: number | null;
  wow: number | null;
  colorIndex: number;
}

export interface RankTrendChartData {
  series: BrandTrendSeries[];
  points: Array<TrendGapRow>;
  coverage: CoverageEntry[];
  yMax: number;
}

export interface BrandRowValues {
  mentions: number | null;
  prompts: number | null;
  share: number | null;
  mentionRate: number | null;
}

/** Row indices per sortable column and direction (hooks/use-ordered-table TableOrders). */
export type Orders<K extends string> = Record<K, { asc: number[]; desc: number[] }>;

// ── screen payloads ─────────────────────────────────────────────────────────

/** mention/as-of */
export interface MentionAsOfScreen {
  asOf: string | null;
}

/** mention/kpi-period: the KPI body frame. */
export interface MentionKpiPeriodScreen {
  periodCompare: CompareResult[] | null;
  /** What the KPI tabs' PeriodDeltaSlot draws per metric (chip + caption), null without a closed period. */
  periodSlots: PeriodSlots | null;
  periodDays?: number;
  monthLine: PeriodDeltaView | null;
}

/** mention/kpi-hero */
export interface KpiHeroScreen {
  hero: KpiHeroValue;
  degraded: boolean;
}

/** Caption under the hero: message key under answerAnalysis.mentions.kpi + its date. */
export interface DeltaBasis {
  key: "hero.deltaBasisCycle" | "hero.deltaBasis";
  date: string;
}

/** mention/kpi-hero-delta */
export interface KpiHeroDeltaScreen {
  value: number | null;
  basis: DeltaBasis | null;
}

export type OwnBrandLabel = { kind: "brand"; brand: string } | { kind: "set"; n: number } | { kind: "default" };

/** mention/kpi-competitors */
export interface KpiCompetitorsScreen {
  ownPct: number | null;
  rows: CompetitorKpiRow[];
  /** Hero mini cards: competitors by value desc (null last), first 4. */
  top: CompetitorKpiRow[];
  coverage: TrendCoverage;
  donut: { own: number; rest: number } | null;
  barMax: number;
  ownBrand: OwnBrandLabel;
}

/** mention/kpi-hero-trend */
export type KpiHeroTrendScreen =
  | { kind: "brand"; chart: BrandTrendChartData }
  | { kind: "degraded" }
  | { kind: "line"; points: KpiTrendPoint[]; coverage: CoverageEntry[] };

/** mention/kpi-engines */
export interface KpiEnginesScreen {
  engine: {
    bars: EngineKpiBar[];
    competitorBars: EngineCompetitorBar[];
    series: { engines: string[]; points: Array<TrendGapRow> };
    coverage: CoverageEntry[];
    trendUnavailable: boolean;
  };
  combo: { combo: TypeComboPoint[]; coverage: CoverageEntry[]; trendUnavailable: boolean };
}

/** Per competitor and type: [competitorPct, otherPct, competitorSignals, otherSignals]. */
export type TypeCompetitorSegments = Array<[number | null, number | null, number, number]>;

/** mention/kpi-types */
export interface KpiTypesScreen {
  own: TypeKpiBar[];
  all: TypeKpiBar[];
  byCompetitor: Record<string, TypeCompetitorSegments>;
  competitors: string[];
  total: { pct: number | null; ownSignals: number | null };
  degraded: boolean;
}

/** The bars of a scope (and, stacked, of the picked competitor): selection only, no arithmetic. */
export function typeBarsOf(vm: KpiTypesScreen, scope: TypeScope, competitor: string | null): TypeKpiBar[] {
  if (scope === "own") return vm.own;
  const seg = competitor ? vm.byCompetitor[competitor] : undefined;
  if (!seg) return vm.all;
  return vm.all.map((b, i) => ({
    ...b,
    competitorPct: seg[i][0],
    otherPct: seg[i][1],
    competitorSignals: seg[i][2],
    otherSignals: seg[i][3],
  }));
}

/** mention/favor-hero */
export interface FavorHeroScreen {
  hero: FavorabilityHeroValue;
  degraded: boolean;
  negativeBasisNote: boolean;
}

/** mention/favor-delta */
export interface FavorDeltaScreen {
  positive: number | null;
  negative: number | null;
  basis: DeltaBasis | null;
}

/** mention/favor-trend */
export type FavorTrendScreen =
  | { unavailable: true }
  | { unavailable: false; points: FavorabilityTrendPoint[]; coverage: CoverageEntry[] };

/** mention/favor-sentiment */
export interface FavorSentimentScreen {
  segments: SentimentSegment[];
  hasAny: boolean;
}

/** mention/favor-matrix */
export interface FavorMatrixScreen {
  rows: TypeSentimentRowVM[];
  hasAny: boolean;
}

/** mention/first-rank */
export interface FirstRankScreen {
  available: boolean;
  degraded: boolean;
  hero: FirstRankHeroValue;
  cards: FirstRankCompetitorCard[];
  chart: RankTrendChartData;
  rows: RankTableRow[];
  /** Row orders: ladder on = ranked order, ladder off (`ownFirst`) = own rows first. */
  orders: { ladder: number[]; ownFirst: number[] };
  /** Ladder marker without a pick: the best-ranked competitor. */
  ladderDefault: string | null;
  /** Bar axis: the worst observed average position (min 1). */
  worst: number;
  cycles: number;
}

export type BrandSortKey =
  | "brand"
  | "mentions"
  | "share"
  | "avgPosition"
  | "prompts"
  | "mentionRate"
  | "multiMentions"
  | "multiRate";

/** BrandRankTable: per-row values, the default rank, every column's order. Rows align with `brands`. */
export interface BrandTableView {
  rows: Array<{ rank: number; values: BrandRowValues; multiValues: BrandRowValues }>;
  orders: Orders<BrandSortKey>;
  multiUnavailable: boolean;
}

/** MentionTrendChart series split (tracked brands vs the rest), series order. */
export interface TrendSeriesSplit {
  own: string[];
  competitors: string[];
}

/** mention/prompts-section */
export type PromptsSectionScreen =
  | { data: null; degraded: boolean }
  | { data: MentionsViewData; degraded: boolean; table: BrandTableView; trendSeries: TrendSeriesSplit | null };

export type { MentionTrend };

// ── website / project page (MentionsView: mention/view, mention/view-compare) ─

/** The head-to-head's own row brand: the view shows `compare.ours` for it. */
export const OWN_ROW = "__own";

export interface SummaryDelta {
  diff: number;
  unit: "count" | "pp";
  tone: "good" | "bad" | "neutral";
}

export interface CompareRow {
  brand: string;
  mentions: number;
  prompts: number;
  share: number;
  mentionRate: number;
  avgPosition: number | null;
  isTracked: boolean;
}

export interface ComparisonView {
  own: CompareRow;
  target: CompareRow;
  peers: CompareRow[];
  mode: "manual" | "designated" | "auto";
  options: string[];
  ownBrands: string[];
}

/** Segment colour classes the screen sends (mention_surfaces.py). They must be written out here: the
 *  class names arrive as data, and Tailwind only generates classes it finds in the front source. */
export type TypeShareColor = "bg-brand-700" | "bg-accent-gold" | "bg-brand-300" | "bg-ink-500" | "bg-ink-300" | "bg-ink-100";

/** A stack segment: brand segments carry `label`, the own / rest ones a `labelKey` (breakdown.*). */
export interface TypeShareSeg {
  key: string;
  label?: string;
  labelKey?: "ours" | "others";
  val: number;
  color: TypeShareColor;
  width: number;
}

export interface TypeShareView {
  rows: Array<{ type: MentionTypeKey; total: number; trackedShare: number; segs: TypeShareSeg[] }>;
  legend: Array<{ color: TypeShareColor; label?: string; labelKey?: "ours" | "others" }>;
}

/** The head-to-head and the type stack that follows its target (mention/view-compare). */
export interface ComparePartsScreen {
  comparison: ComparisonView | null;
  typeShare: TypeShareView | null;
}

/** MentionSubKpis (buildMentionSubKpis), computed by the screen. */
export interface MentionSubKpisView {
  missingPrompts: number | null;
  multiMentionAnswers: number;
  top3Rate: number | null;
  top3Count: number | null;
  top3Base: number | null;
  positiveKeywords: number | null;
  negativeKeywords: number | null;
  ownMentionRate: number | null;
  totalMentions: number;
  measuredPrompts: number | null;
}

/** mention/view */
export interface MentionViewScreen extends Partial<ComparePartsScreen> {
  data: MentionsViewData | null;
  degraded: { data: boolean; types: boolean; subKpis: boolean };
  subKpis: MentionSubKpisView | null;
  prevSubKpis: MentionSubKpisView | null;
  prevBasisDate: string | null;
  /** Project page: the filter panel's inputs (options and calendar of the same request). */
  panel?: {
    catalogRows?: import("@/components/dash/dimension-filter-panel").CatalogTaxonomyRow[];
    engineOptions?: string[];
    dynamicAxes: import("@/components/dash/dimension-filter-panel").DynamicAxis[];
    selectableDates: string[] | null;
  };
  deltas?: {
    total: SummaryDelta | null;
    totalPrompts: SummaryDelta | null;
    missingPrompts?: SummaryDelta | null;
    multiMention?: SummaryDelta | null;
    top3Rate?: SummaryDelta | null;
  };
  sentiment?: Array<{ key: SentimentKey; value: number; cls: string; share: number }> | null;
  typeAbs?: Array<{ key: MentionTypeKey; value: number; width: number }> | null;
  trendSeries?: TrendSeriesSplit | null;
  table?: BrandTableView;
}

// ── display helpers (formatting and chart axes only) ────────────────────────

export const MENTION_TYPE_KEYS_UI: readonly MentionTypeKey[] = [
  "mention",
  "recommendation",
  "comparison",
  "definition",
  "final_choice",
];

export const SENTIMENT_KEYS = ["positive", "neutral", "mixed", "negative"] as const;

/** Off since 2026-09-18 (answer-axis stance card). */
export const STANCE_CARD_ENABLED = false;

/** rankTrendChart point key: the own ranked answers (tooltip). */
export const RANK_TOOLTIP_OWN_RANKED = "__ownRankedAnswers";

export interface RankLadderMark {
  brand: string;
  isTracked: boolean;
  rank: number | null;
  avgPosition: number;
  /** Position on the track, 0 (top = best observed) .. 100 (worst observed). */
  offsetPct: number;
  colorIndex: number;
}

/**
 * Ladder track coordinates of the marks the user shows (own + picked competitors): each mark's
 * place between the best and the worst shown value. Drawing geometry over the current picks, like
 * the sparkline's shared y domain; the values themselves come from the screen.
 */
export function ladderMarks(rows: RankTableRow[]): RankLadderMark[] {
  const ranked = rows.filter((r): r is RankTableRow & { avgPosition: number } => r.avgPosition != null);
  if (ranked.length === 0) return [];
  const min = Math.min(...ranked.map((r) => r.avgPosition));
  const max = Math.max(...ranked.map((r) => r.avgPosition));
  return ranked.map((r) => ({
    brand: r.brand,
    isTracked: r.isTracked,
    rank: r.rank,
    avgPosition: r.avgPosition,
    offsetPct: max > min ? Math.round(((100 * (r.avgPosition - min)) / (max - min)) * 10) / 10 : 0,
    colorIndex: r.colorIndex,
  }));
}

/** "12.2" (position value text). null -> em dash. */
export function positionText(v: number | null | undefined): string {
  return v == null ? "—" : v.toFixed(1);
}

/** Rank chart y ticks: 1 always, every integer up to 10, else 5·10·20·50… steps (max 8 ticks). */
export function rankAxisTicks(yMax: number): number[] {
  const top = Number.isFinite(yMax) ? Math.floor(yMax) : 1;
  if (top <= 1) return [1];
  if (top <= 10) return Array.from({ length: top }, (_, i) => i + 1);
  const MAX_TICKS = 8;
  let step = 5;
  for (let mag = 1; 1 + Math.floor(top / step) > MAX_TICKS; ) {
    if (step === 5 * mag) step = 10 * mag;
    else if (step === 10 * mag) step = 20 * mag;
    else {
      mag *= 10;
      step = 5 * mag;
    }
  }
  const ticks = [1];
  for (let v = step; v <= top; v += step) ticks.push(v);
  return ticks;
}
