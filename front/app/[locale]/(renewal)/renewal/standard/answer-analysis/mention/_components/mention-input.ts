// What the renewal Mention page hands its client body: one screen read per section
// (back/bff/screens/mention_renewal.py, "mention/rn-<section>"), as promises — each card resolves
// its own inside a <Suspense>, like the original tabs. Neutral module: the server page builds it,
// the client body consumes it.

import type { CompareKind, CompareResult } from "@/lib/kpi/period-compare";
import type { KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import type {
  RnBumpVM,
  RnCompareVM,
  RnFavorDistVM,
  RnFavorHeroVM,
  RnFavorMatrixVM,
  RnRankVM,
  RnRankingVM,
  RnRateEnginesVM,
  RnRateHeroVM,
  RnRateTypesVM,
  RnRateValueVM,
  RnShellVM,
  RnSummaryVM,
  RnTabDeltasVM,
  RnTabValueVM,
} from "../_data/screen-types";

export type HeroMetric = "exposure" | "sov" | "favorability";

/** The period compare block of the original KPI body (the old view model's input). */
export interface RnMentionPeriod {
  /** null = no period compare (no period, switch off, before the epoch) → the cycle / prev Δ. */
  compare: CompareResult[] | null;
  days: number | undefined;
  kind: CompareKind;
}

export interface RnMentionInput {
  kpi: KpiTab;
  /** 당사 label: the applied brands without the HMG umbrella, else "HMG". */
  ownLabel: string;
  /** dateFrom..dateTo when a period is set (cumulative), null = latest round snapshot. */
  period: { from: string | null; to: string | null } | null;
  /** any filter axis in the URL (decides "결과 없음" vs "측정 대기"). */
  filtered: boolean;
  /** the tab rail: each tab's value, then the Δ of all four */
  tabValue: Record<KpiTab, Promise<RnTabValueVM>>;
  tabDeltas: Promise<RnTabDeltasVM>;
  /** the body aggregate: page state, 당사 brands, the brand drawer rows */
  shell: Promise<RnShellVM>;
  /** the competitors that can be compared */
  compare: Promise<RnCompareVM>;
  summary: Promise<RnSummaryVM>;
  rateValue: Promise<RnRateValueVM>;
  rateHero: Promise<RnRateHeroVM>;
  rateEngines: Promise<RnRateEnginesVM>;
  rateTypes: Promise<RnRateTypesVM>;
  favorHero: Promise<RnFavorHeroVM>;
  favorDist: Promise<RnFavorDistVM>;
  favorMatrix: Promise<RnFavorMatrixVM>;
  rank: Promise<RnRankVM>;
  bump: Promise<RnBumpVM>;
  ranking: Promise<RnRankingVM>;
}
