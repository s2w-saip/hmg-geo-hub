// What the renewal Mention page hands its client body: the SAME reads as
// /standard/answer-analysis/mention/page.tsx, as promises (each card resolves its own inside
// a <Suspense>, like the original tabs). Neutral module: the server page builds it, the client
// body consumes it.

import type {
  BrandTrendResult,
  EngineKpiTrend,
  FirstPositionResult,
  StandardSubKpis,
  TypeKpi,
} from "@/lib/db/repositories/scope-aggregates";
import type { CompetitorBrandValue, MentionsBrandLive, MentionTypesByBrand } from "@/lib/scope/result-adapter";
import type { MentionSentimentBreakdown } from "@/lib/scope/types";
import type { CompareKind, CompareResult } from "@/lib/kpi/period-compare";
import type { MentionsViewData } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/mentions-view";
import type { KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";

export type HeroMetric = "exposure" | "sov" | "favorability";

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
  /** MentionsData: the body aggregate (bottom section, brands, types by brand, sentiment). */
  mentions: Promise<MentionsViewData | null>;
  /** KPI brand rows (legacy: mentions.brands, api: the same B1 call). */
  brands: Promise<MentionsBrandLive[]>;
  /** Overview competitor values (legacy, trend grid on); api: null (U6-N6). */
  competitorValues: Promise<CompetitorBrandValue[] | null>;
  sub: Record<HeroMetric, Promise<StandardSubKpis | null>>;
  prev: Record<HeroMetric, Promise<{ sub: StandardSubKpis; asOf: string } | null>>;
  engineTrend: Promise<EngineKpiTrend | null>;
  brandTrend: Promise<BrandTrendResult | null>;
  typeKpi: Promise<TypeKpi | null>;
  typesByBrand: Promise<MentionTypesByBrand | null>;
  sentimentTotals: Promise<MentionSentimentBreakdown | null>;
  firstPosition: Promise<FirstPositionResult | null>;
  periodCompare: Promise<RnMentionPeriod>;
  /** api only (B034): a read was a transient failure, not "no data". Legacy: always false. */
  degraded: { data: Promise<boolean>; hero: Promise<boolean>; types: Promise<boolean>; firstRank: Promise<boolean> };
}
