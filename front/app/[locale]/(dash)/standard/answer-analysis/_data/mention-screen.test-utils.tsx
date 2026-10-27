/* eslint-disable @typescript-eslint/no-explicit-any */
// Render-test seams: the old view-model inputs (sub KPI, brand rows, engine / brand trend, type KPI,
// first-position result, MentionsLive) mapped to the mention screens' payloads (back/bff/screens/
// mention*.py). The payloads were recorded once from the former TypeScript view model and are read
// from mention-screen.frozen.json (test/frozen.ts). The component tests keep their fixtures and render
// the components with the payload props.
import type { ComponentProps } from "react";
import type {
  BrandTrendResult,
  EngineKpiTrend,
  FirstPositionResult,
  StandardSubKpis,
  TypeKpi,
} from "@/lib/db/repositories/scope-aggregates";
import type { MentionsBrandLive, MentionTypesByBrand } from "@/lib/scope/result-adapter";
import type { MentionSentimentBreakdown } from "@/lib/scope/types";
import { frozen, loadFrozen } from "@/test/frozen";
import type {
  BrandTableView,
  FirstRankScreen,
  KpiMetric,
  MentionSubKpisView,
  MentionViewScreen,
  TypeScope,
} from "./mention-screen";
import { MentionKpiTab } from "../_components/kpi/mention-kpi-tab";
import { FavorabilityKpiTab } from "../_components/kpi/favorability-kpi-tab";
import { FirstRankKpiTab } from "../_components/kpi/first-rank-kpi-tab";
import { CompetitorKpiTable } from "../_components/kpi/competitor-kpi-table";
import { BrandRankTable } from "../_components/brand-rank-table";
import { MentionsPromptsSection } from "../_components/mentions-prompts-section";
import { MentionsRankSection, MentionsSummarySection, MentionsTrendSection, MentionsView, type MentionsViewData } from "../_components/mentions-view";

const TABLE = loadFrozen(new URL("./mention-screen.frozen.json", import.meta.url));

// ── KPI tabs ────────────────────────────────────────────────────────────────

export type LegacyKpiTabProps = {
  metric: KpiMetric;
  subKpis: StandardSubKpis | null;
  prevSubKpis: StandardSubKpis | null;
  brands: MentionsBrandLive[];
  competitorValues?: any;
  engineTrend: EngineKpiTrend | null;
  brandTrend: BrandTrendResult | null;
  typeKpi: TypeKpi | null;
  typesByBrand: MentionTypesByBrand | null;
  prevBasisDate: string | null;
  heroDegraded?: boolean;
  typeKpiDegraded?: boolean;
  initialTypeScope?: TypeScope;
  initialCompetitors?: string[];
  initialTypeCompetitor?: string | null;
  periodCompare?: any;
  periodDays?: number;
};

type KpiTabScreens = Omit<
  ComponentProps<typeof MentionKpiTab>,
  "metric" | "initialTypeScope" | "initialCompetitors" | "initialTypeCompetitor" | "periodCompare" | "periodDays"
>;

/** mention/kpi-* screens (hero, Δ, competitors, hero trend, engines, types) for one KPI tab. */
export function kpiTabScreens(...args: [p: LegacyKpiTabProps]): KpiTabScreens {
  return frozen(TABLE, "kpiTabScreens", args);
}

export function MentionKpiTabFromLegacy(p: LegacyKpiTabProps) {
  return (
    <MentionKpiTab
      metric={p.metric}
      {...kpiTabScreens(p)}
      initialTypeScope={p.initialTypeScope}
      initialCompetitors={p.initialCompetitors}
      initialTypeCompetitor={p.initialTypeCompetitor}
      periodCompare={p.periodCompare}
      periodDays={p.periodDays}
    />
  );
}

export type LegacyFavorabilityProps = {
  subKpis: StandardSubKpis | null;
  prevSubKpis: StandardSubKpis | null;
  prevBasisDate: string | null;
  engineTrend: EngineKpiTrend | null;
  sentimentTotals: MentionSentimentBreakdown | null;
  stanceDist: any;
  typeKpi: TypeKpi | null;
  initialCounts?: boolean;
  periodCompare?: any;
  periodDays?: number;
  heroDegraded?: boolean;
};

type FavorabilityScreens = Pick<ComponentProps<typeof FavorabilityKpiTab>, "hero" | "delta" | "trend" | "sentiment" | "stance" | "matrix">;

/** mention/favor-* screens. */
export function favorabilityScreens(...args: [p: LegacyFavorabilityProps]): FavorabilityScreens {
  return frozen(TABLE, "favorabilityScreens", args);
}

export function FavorabilityKpiTabFromLegacy(p: LegacyFavorabilityProps) {
  const v = favorabilityScreens(p);
  return (
    <FavorabilityKpiTab
      hero={v.hero}
      delta={v.delta}
      trend={v.trend}
      sentiment={v.sentiment}
      stance={v.stance}
      matrix={v.matrix}
      initialCounts={p.initialCounts}
      periodCompare={p.periodCompare}
      periodDays={p.periodDays}
    />
  );
}

/** mention/first-rank screen. */
export function firstRankScreen(...args: [firstPosition: FirstPositionResult | null, competitorValues?: any, heroDegraded?: boolean]): FirstRankScreen {
  return frozen(TABLE, "firstRankScreen", args);
}

export function FirstRankKpiTabFromLegacy({
  firstPosition,
  competitorValues,
  heroDegraded,
  ...rest
}: { firstPosition: FirstPositionResult | null; competitorValues?: any; heroDegraded?: boolean } & Omit<ComponentProps<typeof FirstRankKpiTab>, "firstRank">) {
  return <FirstRankKpiTab firstRank={firstRankScreen(firstPosition, competitorValues, heroDegraded ?? false)} {...rest} />;
}

type CompetitorTableProps = ComponentProps<typeof CompetitorKpiTable>;

/** The competitor table's donut, bar scale and own-brand label (mention/kpi-competitors). */
export function competitorTableExtras(
  ...args: [ownPct: number | null, rows: CompetitorTableProps["rows"]]
): Pick<CompetitorTableProps, "donut" | "barMax" | "ownBrand"> {
  return frozen(TABLE, "competitorTableExtras", args);
}

/** The own-share donut the competitor screen sends for a hero value. */
export function ownShareDonut(...args: [pct: number | null]): CompetitorTableProps["donut"] {
  return frozen(TABLE, "ownShareDonut", args);
}

export function CompetitorKpiTableFromLegacy(
  p: Omit<ComponentProps<typeof CompetitorKpiTable>, "donut" | "barMax" | "ownBrand">,
) {
  return <CompetitorKpiTable {...p} {...competitorTableExtras(p.ownPct, p.rows)} />;
}

// ── bottom section and the website / project view ──────────────────────────

/** BrandRankTable values, ranks and column orders (screen brand_table_view). */
export function brandTableOf(...args: [brands: MentionsBrandLive[], totalAnswers?: number | null]): BrandTableView {
  return frozen(TABLE, "brandTableOf", args);
}

export function trendSplitOf(data: MentionsViewData) {
  if (!data.trend) return null;
  const tracked = new Set(data.brands.filter((b) => b.isTracked).map((b) => b.brand));
  return { own: data.trend.series.filter((b) => tracked.has(b)), competitors: data.trend.series.filter((b) => !tracked.has(b)) };
}

export function BrandRankTableFromLegacy(
  p: Omit<ComponentProps<typeof BrandRankTable>, "table"> & { totalAnswers?: number | null },
) {
  const { totalAnswers, ...rest } = p;
  return <BrandRankTable {...rest} table={brandTableOf(p.brands, totalAnswers ?? null)} />;
}

export function MentionsPromptsSectionFromLegacy(p: { data: MentionsViewData | null; degraded?: boolean; initialMulti?: boolean }) {
  if (!p.data) return <MentionsPromptsSection data={null} degraded={p.degraded} initialMulti={p.initialMulti} />;
  return (
    <MentionsPromptsSection
      data={p.data}
      table={brandTableOf(p.data.brands, p.data.summary.totalAnswers ?? null)}
      trendSeries={trendSplitOf(p.data)}
      degraded={p.degraded}
      initialMulti={p.initialMulti}
    />
  );
}

export type LegacyViewProps = {
  data: MentionsViewData | null;
  subKpis?: MentionSubKpisView | null;
  prevSubKpis?: MentionSubKpisView | null;
  prevBasisDate?: string | null;
  designatedTargetBrand?: string | null;
  degraded?: { data?: boolean; types?: boolean; subKpis?: boolean };
};

/** mention/view for given page data (screen mention_surfaces.view). */
export function mentionViewScreen(...args: [p: LegacyViewProps]): MentionViewScreen {
  return frozen(TABLE, "mentionViewScreen", args);
}

export function MentionsViewFromLegacy(
  p: LegacyViewProps & Omit<ComponentProps<typeof MentionsView>, "vm" | "compareSource">,
) {
  const { data, subKpis, prevSubKpis, prevBasisDate, designatedTargetBrand, degraded, ...rest } = p;
  return (
    <MentionsView
      vm={mentionViewScreen({ data, subKpis, prevSubKpis, prevBasisDate, designatedTargetBrand, degraded })}
      compareSource={{ surface: "website" }}
      {...rest}
    />
  );
}

export function MentionsSummarySectionFromLegacy(p: LegacyViewProps) {
  return <MentionsSummarySection vm={mentionViewScreen(p)} compareSource={{ surface: "website" }} />;
}

export function MentionsTrendSectionFromLegacy({ data }: { data: MentionsViewData | null }) {
  return <MentionsTrendSection data={data} trendSeries={data ? trendSplitOf(data) : null} />;
}

export function MentionsRankSectionFromLegacy({ data, isWebsite, lazyPrompts }: { data: MentionsViewData | null; isWebsite?: boolean; lazyPrompts?: boolean }) {
  if (!data) return <MentionsRankSection data={null} table={brandTableOf([])} />;
  return <MentionsRankSection data={data} table={brandTableOf(data.brands, data.summary.totalAnswers ?? null)} isWebsite={isWebsite} lazyPrompts={lazyPrompts} />;
}
