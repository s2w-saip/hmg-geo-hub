// Renewal ACR screen payloads (back/bff/screens/acr.py): acr/renewal-header (the page header's
// period pill) and acr/renewal (filter option props + the body view model). Every number, order,
// rule and finding is computed by the API; the cards format and render it.
import type { CatalogTaxonomyRow } from "@/components/dash/dimension-filter-panel";
import type { StandardAcr } from "@/lib/db/repositories/scope-aggregates";

export type AcrBrand = StandardAcr["brands"][number];

export interface AcrOwnTotal {
  choiceCount: number;
  appearanceCount: number;
  choiceShare: number | null;
  coverage: number | null;
}

export type AcrFindingKind = "standing" | "leak" | "engine" | "sweep" | "model" | "mover" | "dist";
export interface AcrFinding {
  kind: AcrFindingKind;
  tone: "warn" | "good" | "info";
  pri: number;
  target: "sec-overview" | "sec-comp" | "sec-prompt" | "sec-model" | "sec-dist";
  /** brand to light after the jump */
  brand?: string;
  /** a view the target card should switch to first */
  act?: { battle?: "notown" } | { sheet: string };
  params: Record<string, string | number>;
}

export interface AcrBrandRow extends AcrBrand {
  /** Gold's HMG flag (own_bit ≠ 0) of the value the reader judges this row's 당사 by (renewal audit 11-2) */
  isHmg?: boolean;
  /** server rank (API order) */
  rank: number;
  trend: Array<number | null> | null;
  d: number | null;
  /** an own brand of this account */
  own: boolean;
  /** Gold's HMG flag and not 당사 for this account */
  sibling: boolean;
  /** a rival with a trend (a compare candidate) */
  canCompare: boolean;
  /** Top1 bar width (% of the largest Top1 on the board) */
  top1Bar: number;
  /** 후보 → 최종 선택 map: coverage (x) and Top1 (y), a dot without a reference line (2026-10-31 ⛔L) */
  mapX: number;
  mapY: number;
}

export type AcrBattleView = "all" | "notown" | "split";
export type AcrModelSort = "conversionRate" | "shortlistCount" | "top1Count";
/** row sorts: 당사 열세 (the most picked rival's share − 당사's) / 당사 몫, low first / prompt text */
export type AcrDistSort = "gap" | "own" | "text";
/** 당사 in a row: picked / a candidate never picked / not a candidate */
export type AcrDistState = "pick" | "listed" | "absent";

/** 후보 → 선택 전환: rows by 후보 탈락 count (default) or share */
export type AcrConversionSort = "listed" | "share";
export interface AcrConversionRow {
  region: string | null;
  /** prompt rows of the country (every engine summed in the "all" view) */
  n: number;
  counts: Record<AcrDistState, number>;
  /** each count over n, rounded once (null when n is 0) */
  shares: Record<AcrDistState, number | null>;
  /** the 분포 sheet the row opens (the country's sheet with the most 후보 탈락 rows) */
  sheet: string | null;
}
export interface AcrConversionView {
  n: number;
  counts: Record<AcrDistState, number>;
  shares: Record<AcrDistState, number | null>;
  rows: AcrConversionRow[];
  orders: Record<AcrConversionSort, number[]>;
}
export type AcrDuelPart = "own" | "rival" | "rest";
export interface AcrDuelRow {
  brand: string;
  /** repetitions whose shortlist held 당사 and this rival */
  n: number;
  counts: Record<AcrDuelPart, number>;
  shares: Record<AcrDuelPart, number | null>;
  /** bar widths (% of a half; one scale per view, its largest 당사 or rival share fills its half) */
  bars: Record<"own" | "rival", number>;
  sibling: boolean;
  lead: "own" | "rival" | "even";
}

export interface AcrDistRow {
  promptId: string;
  label: string;
  /** repetitions of the prompt's cells summed (a round's re-measurements, a period's rounds) */
  validAcr: number;
  cells: number;
  state: AcrDistState;
  /** brands on a shortlist in the row */
  candidates: number;
  /** picks of the own brands, picks of every brand */
  ownN: number;
  picked: number;
  /** validAcr > picked: the "nobody chosen" segment, `none` picks wide */
  hatch: boolean;
  none: number;
  /** the most picked brand (first entry); null when nobody was picked */
  top: { brand: string; choice: number } | null;
  /** the brands picked; segment width = choice / validAcr (%) */
  entries: { brand: string; choice: number; width: number }[];
  /** CSV: the choice of every `present` brand */
  pivot: number[];
}

/** A 분포 sheet tab; its rows come with the page for the first sheet, else from acr/renewal-sheet */
export interface AcrDistTab {
  /** `${country ?? ""}|${engine}` */
  key: string;
  region: string | null;
  engine: string;
  /** rows of the sheet */
  count: number;
}

export interface AcrDistSheet {
  /** `${country ?? ""}|${engine}` */
  key: string;
  region: string | null;
  engine: string;
  rows: AcrDistRow[];
  /** brands picked in the sheet (first appearance) */
  present: string[];
  /** rows per 당사 state */
  counts: Record<AcrDistState | "all", number>;
  /** row orders per sort and 당사 state */
  orders: Record<AcrDistSort, Record<AcrDistState | "all", number[]>>;
}

export interface RnAcrView {
  own: AcrOwnTotal | null;
  ownBrands: string[];
  multiOwn: boolean;
  brands: AcrBrandRow[];
  /** board orders: the metrics descending (nulls last), the brand name ascending; ties by rank */
  boardOrders: Record<"choiceShare" | "coverage" | "d" | "choiceCount" | "appearanceCount" | "brand", number[]>;
  /** Top1 bar width of the 당사 total row */
  ownTop1Bar: number | null;
  /** trend buckets (labels as given: YYYY-MM-DD) */
  dates: string[];
  ownTrend: Array<number | null> | null;
  ownDelta: number | null;
  /** compare candidates: rivals with a trend, best first */
  rivals: string[];
  /** the compare brands before any pick (the best rival) */
  defaultCompare: string[];
  showDelta: boolean;
  /** 당사 rank among the chosen rivals (the reader's, beyond the table; null without 당사), the leader,
   * 당사 − leader (pp) and the field size (chosen rivals + 당사) */
  rank: number | null;
  leader: AcrBrand | null;
  gap: number | null;
  standingN: number | null;
  engines: string[];
  /** per engine: own wins, prompts nobody was picked in (or not measured on it), wins per winner brand (null = nobody
   * chosen), prompts another brand won (prompts − own − none) */
  engineWins: { engine: string; ownWins: number; noneWins: number; byBrand: { brand: string | null; count: number }[]; restBase: number }[];
  sweeps: Array<{ brand: string; count: number }>;
  findings: AcrFinding[];
  battle: {
    rows: { promptId: string; label: string; winners: (string | null)[]; notOwn: boolean }[];
    views: Record<AcrBattleView, number[]>;
    /** rows behind "더 보기" per view while collapsed */
    hidden: Record<AcrBattleView, number>;
    visible: number;
    count: number;
    /** bar denominator (count, at least 1) */
    total: number;
  };
  models: {
    /** own = Gold's isOurs; sibling = Gold's HMG flag (isHmg) and not own */
    rows: (StandardAcr["modelConversion"][number] & { isHmg?: boolean; rank: number; brandLabel: string; own: boolean; sibling: boolean; bar: number })[];
    orders: Record<AcrModelSort, number[]>;
  };
  /** every sheet, the most rows first */
  sheets: AcrDistTab[];
  /** the first sheet (the others are read when their tab opens) */
  sheet: AcrDistSheet | null;
  distVisible: number;
  /** 후보 → 선택 전환 per country: views "all" (every engine summed) and per engine */
  conversion: { engines: string[]; views: Record<string, AcrConversionView>; visible: number };
  /** 결선 맞대결 per rival (null when not read): views "all" and per engine; the reader's sample of about one repetition per cell */
  duels: { engines: string[]; views: Record<string, AcrDuelRow[]>; sample: { iterations: number; cells: number } } | null;
}

export interface RnAcrInput {
  measured: boolean;
  /** any filter in the URL (tells "no result for these filters" from "not measured yet") */
  filtered: boolean;
  acrPromptCount: number;
  /** API path: trend buckets are rounds */
  roundBuckets: boolean;
  period: boolean;
  /** the round shown (YYYY-MM-DD): the snapshot's, a period's last; null when the read names none */
  asOf: string | null;
  /** 당사 name (the applied own brands, else the HMG umbrella) */
  ownLabel: string;
  totals: StandardAcr["totals"];
  view: RnAcrView | null;
}

export interface RnAcrScreen {
  /** RnOverviewFilters option props (the page adds the session scope) */
  props: {
    stage: "acr";
    catalogRows?: CatalogTaxonomyRow[];
    geographyOptions?: string[];
    languageOptions: string[];
    selectableDates?: string[];
  };
  body: RnAcrInput;
}

export interface RnAcrHeader {
  period: boolean;
  dateFrom: string | null;
  dateTo: string | null;
}
