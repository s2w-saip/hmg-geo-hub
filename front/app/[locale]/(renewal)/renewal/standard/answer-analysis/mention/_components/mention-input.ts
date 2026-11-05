// What the renewal Mention page hands its client body: one screen read per section
// (back/bff/screens/mention_renewal.py, "mention/rn-<section>"), as promises — each card resolves
// its own inside a <Suspense>, like the original tabs. Neutral module: the server page builds it,
// the client body consumes it.

import type { ReactNode } from "react";
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

/** What sits under the rail: the KPI tab's analysis, or 브랜드 상세 (no KPI: mention counts and shares). */
export type MentionView = "kpi" | "brands";
/** `?view=brands` opens 브랜드 상세; no param = the KPI view (`?kpi=` keeps the tab either way). A brands-first page
 * (Global, 2026-11-05) opens 브랜드 상세 with no param; `?view=kpi` or a `?kpi=` link (the dashboard KPI cards') opens the
 * KPI view. */
export const MENTION_VIEW_PARAM = "view";

type Raw = string | string[] | undefined | null;

const first = (raw: Raw) => (Array.isArray(raw) ? raw[0] : raw);

export function resolveMentionView(raw: Raw, brandsFirst?: { kpi: Raw }): MentionView {
  const v = first(raw);
  if (!brandsFirst) return v === "brands" ? "brands" : "kpi";
  if (v === "brands" || v === "kpi") return v;
  return first(brandsFirst.kpi) ? "kpi" : "brands";
}

/** The period compare block of the original KPI body (the old view model's input). */
export interface RnMentionPeriod {
  /** null = no period compare (no period, switch off, before the epoch) → the cycle / prev Δ. */
  compare: CompareResult[] | null;
  days: number | undefined;
  kind: CompareKind;
}

export interface RnMentionInput {
  kpi: KpiTab;
  view: MentionView;
  /** 당사 label: the applied brands without the HMG umbrella, else "HMG". */
  ownLabel: string;
  /** dateFrom..dateTo when a period is set (cumulative), null = latest round snapshot. */
  period: { from: string | null; to: string | null } | null;
  /** any filter axis in the URL (decides "결과 없음" vs "측정 대기"). */
  filtered: boolean;
  /** 브랜드 상세 leads the rail and is the landing view (Global, 2026-11-05 the user's call); else it closes the rail. */
  brandsFirst?: boolean;
  /** The page's own sections in place of the standard bar, rail and views (the Website page, 2026-11-02: its prompts aim
   * at its own pages, so the page reads differently), inside the same providers. */
  body?: ReactNode;
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
