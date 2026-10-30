import type { CitationCategoryTotals, CitationToneSummary } from "@/lib/db/repositories/scope-aggregates";
import type { PeriodDeltaView } from "@/lib/kpi/period-compare-view";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import type {
  CitationSectionDegraded,
  CitationTableSource,
  DomainTableViews,
  NumberedDomainRow,
  WebsiteCitationScreen,
} from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";

// The renewal citation page's payload types (screen `citation/standard`, variant renewal:
// back/bff/screens/citation.py renewal_vm) and the display constants its cards quote.

/** The Δ bars share one axis: the largest change on screen, never below ±0.5pp (noise stays short). */
export const DELTA_AXIS_MIN = 0.5;
/** Weekly share sparklines draw at least a 2pp range, so sub-point wobbles stay nearly flat. */
export const SPARK_MIN_SPAN = 2;

/** The previous round's category totals (the Δ base), with the last round's when a period is cumulative; in period
 * mode the period before (`period`) and the selected period's totals (`current`), both cumulative. */
export type PrevCategories = { totals: CitationCategoryTotals; asOf: string; current?: CitationCategoryTotals; period?: { from: string; to: string } } | null;

export interface RnCitationDelta {
  value: number | null;
  /** card = the Overview card Δ (official share only), category = previous round's category totals,
   * period = the period before (period mode) */
  basis: "card" | "category" | "period" | null;
  /** the date of the round compared against (period: the last day of the period before) */
  date: string | null;
  /** period: the first day of the period before */
  from?: string | null;
}

// ── 출처 구성: one ranked list ────────────────────────────────────────────────

export interface CategoryRow {
  name: string;
  /** citations (공식(경쟁사) = the picked competitors' sum while a pick is on) */
  value: number;
  /** share (%) of all citations before the competitor pick (the original's denominator) */
  pct: number | null;
  /** the previous round's share — the tick on the bar */
  prevPct: number | null;
  delta: number | null;
  /** 공식(경쟁사) while a competitor pick is on: the original hides that Δ */
  deltaHidden: boolean;
  trend: (number | null)[] | null;
  /** the category's top domains and their share inside the category */
  top: { domain: string; pct: number }[];
}

// ── 개요: the four tiles ──────────────────────────────────────────────────────

export type SplitState =
  | { kind: "ok"; owned: number; uncited: number }
  /** 출처 filter leaves 공식(HMG) out */
  | { kind: "noOwnCategory" }
  /** legacy does not compute the split while a 출처 filter is on (scope-aggregates wantSplit) */
  | { kind: "notComputed" }
  /** computed, no prompt cited an owned URL (the original hides the section) */
  | { kind: "noOwned" }
  /** api: the split read failed for now */
  | { kind: "degraded" };

// ── source preference matrix ─────────────────────────────────────────────────

export interface MatrixCol {
  key: string;
  n: number;
  /** null in a column without citations (n = 0): no share, drawn '—' */
  shares: Record<string, number | null>;
  counts: Record<string, number>;
}
export interface Matrix {
  cols: MatrixCol[];
  rows: string[];
  /** 전체 = the columns' own sum (types double-count, so not the page total) */
  base: Record<string, number>;
  total: number;
  /** coloured columns: those with citations, when two or more have them */
  live: string[];
  /** the gap (pp) drawn at full strength */
  cap: number;
}

// ── 도메인: weekly rank bump ──────────────────────────────────────────────────

export interface BumpSeries {
  key: string;
  own: boolean;
  values: (number | null)[];
  ranks: (number | null)[];
}
export interface DomainBump {
  x: string[];
  series: BumpSeries[];
  first: number;
  last: number;
  /** the biggest rank changes first → last outside 공식(HMG), at most 3 */
  movers: { key: string; move: number }[];
}

// ── 이번 회차 요약 ─────────────────────────────────────────────────────────────

export type FindingKind = "standingLead" | "standingTrail" | "mover" | "engineGap" | "typeGap" | "opportunity" | "skew" | "climb";
export interface Finding {
  kind: FindingKind;
  tone: "warn" | "good" | "info";
  pri: number;
  /** section to jump to */
  target: string;
  /** key lit after the jump (category or domain) */
  key?: string;
  /** matrix axis the finding is about */
  axis?: "engine" | "type";
  /** sub page the finding opens instead of a jump */
  href?: "uncited";
  params: Record<string, string | number>;
}


/** A source preference matrix as drawn: + each cell's gap to 전체, the 전체 counts, one source picked. */
export type RnMatrixView = Matrix & {
  gaps: Record<string, Record<string, number | null>>;
  baseCounts: Record<string, number>;
  oneSource: boolean;
};

/** The renewal citation model (screen `citation/standard`, variant renewal: back/bff/screens/citation.py). */
export interface RnCitationVm {
  /** 출처 구성: one ranked list (+ `moved`: the Δ is at least 0.05pp, the Δ bar is drawn). */
  rows: (CategoryRow & { moved: boolean })[];
  lens: {
    hmg: { value: number | null; delta: RnCitationDelta; spark: (number | null)[]; sparkOn: boolean };
    dealer: { value: number | null; delta: RnCitationDelta; spark: (number | null)[]; sparkOn: boolean };
    /** ok: + each prompt tile's share of both (Math.round, null when both are 0). */
    split: SplitState & { ownedPct?: number | null; uncitedPct?: number | null };
  };
  /** 공식(HMG)'s rank among the categories (0 = not listed). */
  hmgRank: number;
  /** The share bars' scale (largest share, at least 1). */
  maxPct: number;
  /** The Δ bars' shared axis (deltaAxis). */
  cap: number;
  /** Any category has a weekly share point (the trend column). */
  trendOn: boolean;
  findings: Finding[];
  engineMatrix: { status: "ok" | "pending"; m: RnMatrixView | null };
  /** empty: no mention type has citations (the original type chart's empty note) */
  typeMatrix: { status: "ok" | "pending" | "degraded" | "empty"; m: RnMatrixView | null };
  /** One 출처 picked: absolute counts instead of shares. */
  oneSource: boolean;
  /** The weekly domain rank bump (+ draw order, measured weeks, each series' move and its row in live.domains). */
  bump: (Omit<DomainBump, "series"> & {
    series: (DomainBump["series"][number] & { move: number | null; domainIndex: number })[];
    drawOrder: number[];
    measured: number;
  }) | null;
  /** The domain table's first rows (after the pick, numbered) with the category select views. */
  table: { rows: NumberedDomainRow[]; views: DomainTableViews; categories: string[] };
}

/** A share tile as the screen sends it (value, Δ + basis, weekly line, whether the line is drawn). */
export interface RnShareTile {
  value: number | null;
  delta: RnCitationDelta;
  spark: (number | null)[];
  sparkOn: boolean;
}

/** The URL funnel per prompt: measured → owned URL cited → target page cited (one denominator; rates in %). */
export interface RnUrlFunnel {
  measured: number;
  owned: number;
  target: number;
  ownedRate: number | null;
  targetRate: number | null;
}

/** The website 사이트 인용 도달 card (back/bff/screens/citation.py load_url_reach). */
export type RnUrlReach =
  /** a 출처 filter: the funnel is per prompt, the 출처 class per citation (the original's cards) */
  | { status: "notComputed" }
  | { status: "degraded" }
  /** no measured prompt in the filter */
  | { status: "none" }
  | (RnUrlFunnel & {
      status: "ok";
      /** the compared funnel (null = no comparable answer) */
      prev: RnUrlFunnel | null;
      /** Δpp of the rates vs the page's previous round (`round`) or the period before (`period`) */
      delta: { ownedRate: number | null; targetRate: number | null; basis: "round" | "period" | null; date: string | null; from?: string | null };
      /** the same funnel per engine (전체 counts a prompt once whichever engine cited it) */
      engines: (RnUrlFunnel & { engine: string })[];
      enginesDegraded: boolean;
      source?: WebsiteCitationScreen["targetHitRate"]["source"];
      publication?: WebsiteCitationScreen["targetHitRate"]["publication"];
    });

/** The website page's own parts: the 공식(당사) tile and the URL funnel card. */
export interface RnCitationWebsite {
  /** 공식(당사) share (the site's brand scope, unlike the 공식(HMG) category); null without the citation read. */
  own: RnShareTile | null;
  reach: RnUrlReach;
}

/** Screen `citation/website`, variant renewal: the renewal page's data on the website surface + the website parts. */
export interface RnWebsiteCitationScreen {
  live: CitationsLive | null;
  tableSource: CitationTableSource | null;
  dataDegraded: boolean;
  sectionDegraded: CitationSectionDegraded | null;
  prevCategories: PrevCategories;
  toneSummary: CitationToneSummary | null;
  periodView: PeriodDeltaView | null;
  rn: RnCitationVm | null;
  own: RnShareTile | null;
  reach: RnUrlReach;
}

/**
 * What the renewal Citation page hands its client body: the screen `citation/standard` (variant
 * renewal) — the data of /standard/answer-analysis/citation plus the renewal model — each a promise
 * of the same answer, so every card streams as before. The website page fills the same fields from
 * `citation/website` (variant renewal) and adds `website`.
 */
export interface RnCitationInput {
  /** The tone tiles follow the 출처 filter (the api source; always on the screen API). */
  api: boolean;
  period: { from: string | null; to: string | null } | null;
  /** any citation filter axis in the URL (empty result vs no measurement) */
  filtered: boolean;
  data: Promise<CitationsLive | null>;
  /** `data` null because the read hit its budget (delay), not "no data" */
  dataDegraded: Promise<boolean>;
  /** the trend / composition trend / prompt split reads failed for now */
  sectionDegraded: Promise<CitationSectionDegraded | null>;
  prevCategories: Promise<PrevCategories>;
  toneSummary: Promise<CitationToneSummary | null>;
  /** the domain table searches / sorts / pages through /api/citations/domains */
  tableSource: Promise<CitationTableSource | null>;
  /** calendar month picked: the "전월 대비" line (citations per answer) */
  periodView: Promise<PeriodDeltaView | null>;
  /** the renewal model (null when `data` is null) */
  rn: Promise<RnCitationVm | null>;
  /** website page only: the 공식(당사) tile and the URL funnel card (absent = the standard page's layout) */
  website?: Promise<RnCitationWebsite>;
}
