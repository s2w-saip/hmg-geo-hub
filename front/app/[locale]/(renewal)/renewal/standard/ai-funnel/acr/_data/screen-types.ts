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
  /** server rank (API order) */
  rank: number;
  trend: Array<number | null> | null;
  d: number | null;
  /** an own brand of this account */
  own: boolean;
  /** an HMG brand that is not 당사 for this account */
  sibling: boolean;
  /** a rival with a trend (a compare candidate) */
  canCompare: boolean;
  /** Top1 bar width (% of the largest Top1 on the board) */
  top1Bar: number;
  /** 후보 → 최종 선택 map: coverage (x), Top1 (y), the distance to the average line and its CSV value */
  mapX: number;
  mapY: number;
  dev: number;
  devCsv: number;
}

export type AcrBattleView = "all" | "notown" | "split";
export type AcrModelSort = "conversionRate" | "shortlistCount" | "top1Count";
export type AcrDistOrder = "text" | "own" | "textZero" | "ownZero";

export interface AcrDistRow {
  promptId: string;
  label: string;
  validAcr: number;
  /** picks of the own brands, picks of every brand */
  ownN: number;
  picked: number;
  /** validAcr > picked: the "nobody chosen" segment, `none` picks wide */
  hatch: boolean;
  none: number;
  /** first entry (API order) */
  top: { brand: string; choice: number } | null;
  /** segment width = choice / validAcr (%) */
  entries: { brand: string; choice: number; width: number }[];
  /** CSV: the choice of every `present` brand */
  pivot: number[];
}

export interface AcrDistSheet {
  /** `${country ?? ""}|${engine}` */
  key: string;
  region: string | null;
  engine: string;
  rows: AcrDistRow[];
  /** brands present in the sheet (first appearance) */
  present: string[];
  /** row orders: by prompt text / by own share, all rows / rows without an own pick */
  orders: Record<AcrDistOrder, number[]>;
}

export interface RnAcrView {
  own: AcrOwnTotal | null;
  ownBrands: string[];
  multiOwn: boolean;
  brands: AcrBrandRow[];
  /** board orders (metric descending, nulls last, ties by rank) */
  boardOrders: Record<"choiceShare" | "coverage" | "d", number[]>;
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
  /** 당사 rank among the rivals, the leader, 당사 − leader (pp) and the field size */
  rank: number;
  leader: AcrBrand | null;
  gap: number | null;
  standingN: number;
  /** 지도 평균선 slope */
  k: number;
  engines: string[];
  /** per engine: own wins, wins per winner brand (null = nobody chosen), prompts minus own wins */
  engineWins: { engine: string; ownWins: number; byBrand: { brand: string | null; count: number }[]; restBase: number }[];
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
    rows: (StandardAcr["modelConversion"][number] & { rank: number; brandLabel: string; own: boolean; sibling: boolean; bar: number })[];
    orders: Record<AcrModelSort, number[]>;
  };
  sheets: AcrDistSheet[];
  distVisible: number;
}

export interface RnAcrInput {
  measured: boolean;
  /** any filter in the URL (tells "no result for these filters" from "not measured yet") */
  filtered: boolean;
  acrPromptCount: number;
  /** API path: trend buckets are rounds */
  roundBuckets: boolean;
  period: boolean;
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
