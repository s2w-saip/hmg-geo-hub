// Payloads of the renewal Mention screens (back/bff/screens/mention_renewal.py, "mention/rn-<section>").
// Every value a card shows is computed there; the cards only format and lay it out. Compare picks
// (max 3) stay UI state: what depends on them comes for every pick, keyed by `pickKey`.

import type { KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import type { MentionTypeKey } from "@/lib/db/repositories/scope-aggregates";
import type { PeriodCaptionMessage, PeriodDeltaView } from "@/lib/kpi/period-compare-view";

export type SentimentKey = "positive" | "neutral" | "mixed" | "negative";
export const SENTIMENT_KEYS: readonly SentimentKey[] = ["positive", "neutral", "mixed", "negative"];
/** Type chips of the brand drawer, in the original order. */
export const MENTION_TYPE_KEYS: readonly MentionTypeKey[] = ["mention", "recommendation", "comparison", "definition", "final_choice"];

/** The combined 당사 row key. */
export const OWN_KEY = "__own";
/** Treemap block of the folded small groups. */
export const TREEMAP_FOLD = "__rest";
/** Treemap group of the brands that are not car makers. */
export const NON_AUTO_GROUP = "__nonAuto";

/**
 * Key of a compare pick: the bit mask of the picked brands' positions in the payload's
 * `covered` list (brands outside it are ignored).
 */
export function pickKey(compare: readonly string[], covered: readonly string[]): string {
  let k = 0;
  for (const b of compare) {
    const i = covered.indexOf(b);
    if (i >= 0) k += 2 ** i;
  }
  return String(k);
}

/** The first picked brand among tied candidates (the pick order breaks a tie, as before). */
export function firstPicked(compare: readonly string[], cands: readonly string[]): string | null {
  return compare.find((b) => cands.includes(b)) ?? null;
}

export type DeltaBasis = { kind: "period"; caption: PeriodCaptionMessage } | { kind: "cycle"; date: string | null } | { kind: "prev"; date: string };

export interface RnDelta {
  value: number | null;
  basis: DeltaBasis | null;
}

export interface RnPageVM {
  ownLabel: string;
  period: { from: string | null; to: string | null } | null;
}

export interface RnAsOfVM {
  asOf: string | null;
}

export interface RnTabValueVM {
  value: number | null;
}

export type RnTabDeltasVM = Record<KpiTab, RnDelta>;

export interface RnDrawerBrand {
  brand: string;
  /** 1-based position in the body brand list */
  rank: number;
  isTracked: boolean;
  own: { code: string | null } | null;
  sibling: boolean;
  mentions: number;
  share: number;
  avgPosition: number | null;
  mentionRate: number;
  /** signal counts; null when they sum to 0 */
  sentiment: Record<SentimentKey, number> | null;
  /** 100 × count ÷ total (unrounded), null with `sentiment` */
  sentimentPct: Record<SentimentKey, number> | null;
  types: Record<MentionTypeKey, number> | null;
}

export interface RnShellVM {
  /** the body aggregate has brands */
  measured: boolean;
  /** the body read failed transiently */
  degraded: boolean;
  /** tracked (당사) brand names */
  ownBrands: string[];
  /** one per brand of the first 100 body brands (the treemap's, the boards'); a ranking row past them carries its own */
  drawer: RnDrawerBrand[];
}

export interface RnCompareVM {
  /** competitors with a round trend, share-of-voice order (only these can be compared) */
  covered: string[];
}

export type FindingKind = "standingLead" | "standingTrail" | "typeTrail" | "typeLead" | "mover" | "engine" | "climb" | "negative";

export interface Finding {
  kind: FindingKind;
  tone: "warn" | "good" | "info";
  pri: number;
  target: string;
  kpi?: KpiTab;
  brand?: string;
  params: Record<string, string | number>;
}

/** The type finding of a pick without its leading compare brand: the tied candidates instead. */
export interface TypeFinding extends Omit<Finding, "brand"> {
  refCands: string[];
}

export interface RnSummaryVM {
  /** last hero round with a value (the snapshot chip) */
  asOf: string | null;
  exp: { rank: number | null; pct: number | null; delta: number | null };
  sov: { rank: number | null; pct: number | null; delta: number | null };
  fav: number | null;
  pos: number | null;
  covered: string[];
  /** the findings that do not depend on the pick */
  fixed: Finding[];
  typeFindings: TypeFinding[];
  /** per pick: the type finding (index) and the four shown, highest priority first (-1 = the type finding) */
  options: Record<string, { type: number | null; order: number[] }>;
  /** a calendar month: the original's period line with the one compare metric no tab shows (답변당 언급 수); else null */
  monthLine: PeriodDeltaView | null;
}

/** A metric without a value (its read failed or was suppressed) has no numerator or denominator either (null). */
export interface RnRateValueVM {
  exposure: { pct: number | null; numerator: number | null; denominator: number | null };
  sov: { pct: number | null; numerator: number | null; denominator: number | null };
  degraded: boolean;
}

export interface BoardRow {
  key: string;
  own: boolean;
  sibling: boolean;
  pct: number | null;
  mentions: number | null;
  spark: (number | null)[];
  delta: number | null;
  gap: number | null;
  covered: boolean;
  /** 1-based board position */
  pos: number;
  /** shown before "more" (당사 or the first five competitors) */
  top: boolean;
  hasSpark: boolean;
}

export interface RnRateHeroMetric {
  delta: RnDelta;
  standing: { n: number; rank: number; other: string | null; gap: number | null } | null;
  trend: {
    missing: boolean;
    x: string[];
    own: (number | null)[];
    /** the competitors' average (shown when nothing is picked) */
    average: (number | null)[] | null;
    /** 당사's numerator and denominator per round, on x (null without a rate) */
    ownNum: (number | null)[];
    ownDen: (number | null)[];
    competitors: string[];
    /** per competitor, on x */
    values: (number | null)[][];
  };
  board: { rows: BoardRow[]; axis: string[]; measuredCycles: number; barMax: number };
}

export type RnRateHeroVM = Record<"exposure" | "sov", RnRateHeroMetric>;

export interface EngineRow {
  engine: string;
  own: number | null;
  avg: number | null;
  avgCount: number;
  gap: number | null;
  series: (number | null)[];
  delta: number | null;
  hasSeries: boolean;
}

export type RnRateEnginesVM = Record<"exposure" | "sov", { rows: EngineRow[]; x: string[]; trendMissing: boolean }>;

export interface DotCell {
  value: number | null;
  gap: number | null;
  lo: number | null;
  hi: number | null;
}

export interface TypeOwnRow {
  type: MentionTypeKey;
  pct: number | null;
  signals: number;
  spark: (number | null)[];
  /** the type's own answers per round, on the view's x (null without a rate; [] for the share view) */
  counts: (number | null)[];
  delta: number | null;
  hasSpark: boolean;
}

export interface RnRateTypesVM {
  degraded: boolean;
  cmp: {
    covered: string[];
    /** per type (strongest endorsement first); [] when there is no type signal */
    rows: Array<{ type: MentionTypeKey; own: number | null; avg: number | null }>;
    /** the competitor average as the reference, per type */
    avgRef: DotCell[];
    /** dots[i][t] = covered[i] on rows[t] */
    dots: DotCell[][];
    options: Record<string, { refs: string[][]; top: number }>;
  };
  /** `x` = the rounds of the lines and `answers` = each round's answers (the exposure view; [] for the share view) */
  own: Record<"exposure" | "sov", { rows: TypeOwnRow[]; maxPct: number; maxCount: number; x: string[]; answers: (number | null)[] }>;
}

export interface RnFavorHeroVM {
  positivePct: number | null;
  negativePct: number | null;
  /** null with positivePct */
  positive: number | null;
  total: number | null;
  positiveDelta: RnDelta;
  negativeDelta: RnDelta;
  mixedBasis: boolean;
  /** per round: the signal shares and the counts under the positive one (null without a share) */
  points: Array<{ key: string; positive: number | null; negative: number | null; positiveCount: number | null; total: number | null; gap: boolean }>;
  trendMissing: boolean;
  degraded: boolean;
}

export interface SentimentSegment {
  key: SentimentKey;
  count: number;
  pct: number | null;
}

export interface RnFavorDistVM {
  segments: SentimentSegment[];
  total: number;
}

export interface TypeSentimentRow {
  type: MentionTypeKey | "all";
  positive: number;
  neutral: number;
  mixed: number;
  negative: number;
  total: number;
  positivePct: number | null;
  segments: SentimentSegment[];
}

export interface RnFavorMatrixVM {
  rows: TypeSentimentRow[];
}

export interface RankRow {
  key: string;
  own: boolean;
  sibling: boolean;
  avgPosition: number | null;
  rank: number | null;
  spark: (number | null)[];
  delta: number | null;
  gap: number | null;
  covered: boolean;
  pos: number;
  hasSpark: boolean;
}

export interface RnRankVM {
  /** the first-position read answered (else the degraded note) */
  fp: boolean;
  degraded: boolean;
  /** rankedAnswers and ahead are null when avgPosition is (no 당사 position: nothing counted or compared) */
  hero: { avgPosition: number | null; rankedAnswers: number | null; delta: RnDelta; series: (number | null)[]; axis: string[] };
  ahead: number | null;
  rows: RankRow[];
  /** row order with the ladder off (당사 first) */
  ownFirst: number[];
  barMax: number;
  track: { lo: number; hi: number } | null;
  covered: string[];
  /** per covered brand, on hero.axis */
  series: (number | null)[][];
  hasValue: boolean[];
  /** per pick: the chart's y top */
  options: Record<string, number>;
  ticks: Record<string, number[]>;
}

export interface BumpSeries {
  key: string;
  own: boolean;
  mentions: (number | null)[];
  shares: (number | null)[];
  ranks: (number | null)[];
  /** rank change first → last measured slot (positive = climbed) */
  move: number | null;
}

export interface RnBumpVM {
  /** the brand trend read answered */
  trend: boolean;
  data: { x: string[]; series: BumpSeries[]; first: number; last: number } | null;
  /** slots with a measurement */
  measured: number;
  maxShare: number;
}

export interface RankingValues {
  mentions: number | null;
  prompts: number | null;
  share: number | null;
  mentionRate: number | null;
  delta: number | null;
  covered: boolean;
}

export interface RankingRow {
  brand: string;
  rank: number;
  own: boolean;
  sibling: boolean;
  avgPosition: number | null;
  /** parent group (brand-group master data); the brand itself when unmapped */
  group: string;
  grouped: boolean;
  hasMulti: boolean;
  off: RankingValues;
  on: RankingValues;
  /** a row past the shell's drawer rows (rank > 100): its drawer row, so its drawer opens with its values */
  drawer?: RnDrawerBrand;
}

export type RankingSortKey = "rank" | "brand" | "mentions" | "share" | "delta" | "avgPosition" | "prompts" | "mentionRate";

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
  members: TreemapBrand[];
  value: number;
  share: number;
  delta: number | null;
  partial: boolean;
  own: boolean;
}

export interface RnRankingVM {
  /** every body brand, rank order (the table shows 100 first, searches them all; the treemap holds the top 100) */
  rows: RankingRow[];
  /** all body brands */
  count: number;
  /** brands before the backend cap (only when cut) */
  total?: number;
  multiUnavailable: boolean;
  orders: Record<"off" | "on", Record<RankingSortKey, { asc: number[]; desc: number[] }>>;
  treemap: Record<"off" | "on", TreemapGroup[]>;
}
