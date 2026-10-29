// ACR screen payloads (back/bff/screens/acr.py): acr/standard (/standard/ai-funnel/acr) and
// acr/gold (the website / project ACR pages in local read-only mode). Every value AcrLiveView
// shows is computed by the API; the view only formats and renders it.
import type { CatalogTaxonomyRow, DimensionGroup } from "@/components/dash/dimension-filter-panel";
import type { TableOrders } from "@/hooks/use-ordered-table";
import type { StandardAcr } from "@/lib/db/repositories/scope-aggregates";

export type AcrBrandSortKey = "brand" | "top1" | "coverage" | "choices" | "appearances";
export type AcrConvSortKey = "brand" | "model" | "conv" | "shortlist" | "top1";

export type AcrLiveBrand = StandardAcr["brands"][number] & { color: string };
export type AcrLiveModel = StandardAcr["modelConversion"][number];

export interface AcrLiveVm {
  /** false = the waiting state (no ACR cell yet, or the answer is suppressed) */
  measured: boolean;
  /** waiting-state catalog count; null = no count (데이터 없음) */
  acrPromptCount: number | null;
  /** brand table rows (API order) with their colour, and the header sort orders */
  brands: AcrLiveBrand[];
  brandOrders: TableOrders<AcrBrandSortKey>;
  /** KPI cards: the viewpoint own total (else the first own brand row) */
  kpi: { top1: number | null; top5: number | null; rank1: number };
  totals: StandardAcr["totals"];
  /** trend chart: one line per series brand, one row per bucket ({date, [brand]: percent}); empty while rounds are not compared */
  trendBrands: { brand: string; color: string }[];
  trendRows: Record<string, string | number | null>[];
  /** false while the ACR pages compare no two rounds (BFF acr.COMPARE_ROUNDS) */
  compareRounds: boolean;
  /** a period of several rounds while rounds are not compared: its rounds, and nothing else to draw */
  held: { rounds: number; from: string; to: string } | null;
  /** battle grid: the winner per totals.engines column (null = no cell) */
  battle: { promptId: string; label: string; cells: ({ winner: string | null; winnerIsOurs: boolean } | null)[] }[];
  battleVisible: number;
  /** rows behind "N개 더 보기" while collapsed (0 = no button) */
  battleHidden: number;
  models: AcrLiveModel[];
  modelOrders: TableOrders<AcrConvSortKey>;
  /** territory sheets (country × engine): legend by Σ choice, per row the picks, empty slots, dominant entry */
  territory: {
    region: string | null;
    engine: string;
    legend: { brand: string; color: string }[];
    rows: {
      promptId: string;
      label: string;
      entries: { brand: string; choice: number; color: string }[];
      noChoice: number;
      dominant: { brand: string; choice: number; color: string } | null;
    }[];
  }[];
}

/** DimensionFilterPanel option props (scope comes from the session in the page). */
export interface AcrPanelProps {
  catalogRows?: CatalogTaxonomyRow[];
  geographyOptions?: string[];
  languageOptions: string[];
  selectableDates?: string[];
  onlyGroups: DimensionGroup[];
}

export interface AcrScreen {
  panel: AcrPanelProps;
  view: AcrLiveVm;
}
