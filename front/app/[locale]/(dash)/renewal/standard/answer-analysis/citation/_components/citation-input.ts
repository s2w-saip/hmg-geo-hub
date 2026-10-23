import type { CitationToneSummary, CitationTypeCategoryRow } from "@/lib/db/repositories/scope-aggregates";
import type { OverviewCardDelta } from "@/lib/kpi/overview-card-values";
import type { PeriodDeltaView } from "@/lib/kpi/period-compare-view";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import type { CitationSectionDegraded, CitationTableSource } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import type { PrevCategories } from "./citation-model";

/**
 * What the renewal Citation page hands its client body: the SAME reads as
 * /standard/answer-analysis/citation/page.tsx (CitationsStandardView props + the month line),
 * each a promise so every card streams on its own read.
 */
export interface RnCitationInput {
  /** HGH_SOURCE_G2=api: the tone tiles follow the 출처 filter there (the legacy read does not) */
  api: boolean;
  period: { from: string | null; to: string | null } | null;
  /** any citation filter axis in the URL (empty result vs no measurement) */
  filtered: boolean;
  data: Promise<CitationsLive | null>;
  /** `data` null because the read hit its budget (delay), not "no data" */
  dataDegraded: Promise<boolean>;
  /** api: the trend / composition trend / prompt split reads failed for now */
  sectionDegraded: Promise<CitationSectionDegraded | null>;
  /** 공식(HMG) 인용 비중 Δ — the Overview card Δ (same function and input) */
  officialDelta: Promise<OverviewCardDelta | null>;
  prevCategories: Promise<PrevCategories>;
  typeCategories: Promise<CitationTypeCategoryRow[] | null>;
  toneSummary: Promise<CitationToneSummary | null>;
  /** api: the domain table searches / sorts / pages through /api/citations/domains */
  tableSource: Promise<CitationTableSource | null>;
  /** calendar month picked: the "전월 대비" line (citations per answer) */
  periodView: Promise<PeriodDeltaView | null>;
}
