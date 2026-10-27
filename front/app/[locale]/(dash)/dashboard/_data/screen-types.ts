// Payloads of the overview screens (GET /v1/screens/overview/* and website/*, back/bff/screens/overview.py).
// The API computes every value; the components only format and lay them out. Neutral module (no
// "server-only" / "use client"): server sections fetch these and client components render them.
import type { CatalogTaxonomyRow, DimensionGroup, MeasuredScopeCombo } from "@/components/dash/dimension-filter-panel";
import type { TrendBucketDisplay } from "@/lib/as-of-date";
import type { PeriodCaptionMessage, PeriodChip } from "@/lib/kpi/period-compare-view";
import type { TrendGap } from "@/lib/viz/trend-gap";
import type { KpiKey, KpiSummary, KpiUnit } from "./model";
import type { LiveSourceSlice, LiveTopicSlice, MarketCompetition, TrendKpiKey } from "./live-types";
import type { OverviewKpiKey } from "./overview-metrics";

/** An i18n message chosen by the API (key + ICU params); Next calls t(). */
export interface ScreenMessage {
  key: string;
  params: Record<string, number | string>;
}

/** overview/as-of — the header pill / as-of chip date (null = "—" / no chip). */
export interface AsOfView {
  asOf: string | null;
}

/** overview/filters — the filter bar props (OverviewFilters / WebsiteFilters). */
export interface FilterBarView {
  catalogRows?: CatalogTaxonomyRow[];
  geographyOptions: string[];
  languageOptions: string[];
  optionMatrix: MeasuredScopeCombo[];
  collectionStartDay: string | null;
  latestAnchorDay: string | null;
  selectableDates?: string[];
  /** Global only: the panel's axes (no measured language = no language axis). */
  onlyGroups?: DimensionGroup[];
}

/** The period-compare block of a card: chip, what it compares against, the reason caption. */
export interface PeriodBlockView {
  chip: PeriodChip;
  label: ScreenMessage;
  caption: PeriodCaptionMessage;
}

export interface OverviewCardView {
  key: OverviewKpiKey;
  value: number | null;
  /** 측정 대기: no value, or 0 without a denominator — no Δ, sparkline or competitor row. */
  pending: boolean;
  /** Set when a closed period's compare answered for this card (never on a pending card). */
  period: PeriodBlockView | null;
}

/** overview/cards — empty = no answers for the filters, degraded = the read failed transiently. */
export type CardsView =
  | { state: "empty" | "degraded" }
  | { state: "ok"; cards: OverviewCardView[]; compareTitle: ScreenMessage | null };

export interface SparkPointView {
  bucketStart: string;
  cycleAnchorAt?: string;
  value: number | null;
  wow: number | null;
  gap?: TrendGap;
  /** Axis / tooltip label source (the round anchor's KST day, time on a same-day collision). */
  display?: TrendBucketDisplay;
}

export interface SparkView {
  points: SparkPointView[];
  domain: [number, number];
  /** Some point has a value (else the empty box). */
  hasValue: boolean;
}

/** overview/card-trend — per card the Δ vs the previous round and the sparkline. */
export interface CardTrendView {
  degraded: boolean;
  cards: Record<OverviewKpiKey, { delta: number | null; spark: SparkView }>;
  /** Rounds drawn by the sparklines (renewal "최근 N회차"). */
  count: number;
}

export interface CompetitorMiniView {
  brand: string;
  value: number | null;
  delta?: number | null;
}

export interface StandingView {
  rank: number;
  count: number;
}

/** overview/card-competitors — the competitor row of every card. */
export interface CardCompetitorsView {
  /** Old degrade labels of the parts that failed transiently (empty = none). */
  degraded: string[];
  rows: Record<OverviewKpiKey, CompetitorMiniView[]>;
  /** Renewal only: 당사's place among the card's competitors. */
  standing?: Record<OverviewKpiKey, StandingView | null>;
}

interface GeoRowView extends MarketCompetition {
  values: Record<OverviewKpiKey, number | null>;
  rivals: Record<OverviewKpiKey, { name: string; value: number | null } | null>;
  /** Tooltip shows the lead brand line (it is not the own label). */
  showLead: boolean;
}

export interface GeoCountryView extends GeoRowView {
  code: string;
  /** world-atlas polygon id, null = not drawn. */
  numeric: string | null;
}

export interface GeoRegionView extends GeoRowView {
  region: string;
  /** Region-level map: the polygons painted with this region (its RHQ countries, else its countries). */
  numerics: string[];
  countries: GeoCountryView[];
}

export interface GeoView {
  markets: GeoRegionView[];
  pending: string[];
  ourLabel: string;
  /** Country menu order (by the localized name). */
  countryOrder: string[];
  /** Country menu groups (market order). */
  countryGroups: { region: string; codes: string[] }[];
  /** Country-level map colour domain per KPI over every country (no country picked). */
  domains: Record<OverviewKpiKey, [number, number] | null>;
}

/** overview/geo */
export interface OverviewGeoView {
  geo: GeoView | null;
  degraded: boolean;
}

export interface BrandCellView {
  value: number | null;
  delta: number | null;
  bar: number;
  best: boolean;
  deltaMark: { r: number; tone: "flat" | "good" | "bad" } | null;
}

/** overview/brand-matrix (renewal) — null when the cards are empty. */
export interface BrandMatrixView {
  rows: { name: string; own: boolean; cells: Record<OverviewKpiKey, BrandCellView | null> }[];
  cols: { key: OverviewKpiKey; best: number | null; max: number | null; standing: StandingView | null }[];
}

/** One website tile. */
export interface TileView extends Pick<KpiSummary, "coverage" | "sparkline" | "ratio" | "competitorSov" | "provenance" | "copyVariant"> {
  key: KpiKey;
  unit: KpiUnit;
  value: number | null;
  pending: boolean;
  delta: number | null;
  direction: KpiSummary["direction"];
  tone: "good" | "bad" | "flat";
  period: PeriodChip | null;
  engineConsistency?: number;
}

export interface TilesView {
  groups: { category: "content" | "source" | "conversion"; tiles: TileView[] }[];
  suppressionCaption: PeriodCaptionMessage | null;
}

/** website/summary, website/summary-deferred */
export type WebsiteSummaryView = { state: "empty" | "degraded" } | { state: "ok"; tiles: TilesView };

export interface TrendRowView {
  key: string;
  /** x label date (YYYY-MM-DD). */
  day: string;
  values: Partial<Record<TrendKpiKey, number>>;
  measuredDays: number;
  answers: number;
  /** The gap marker as each gap family reads it. */
  gap: { mention: TrendGap | null; citation: TrendGap | null };
}

export interface TrendChartView {
  rows: TrendRowView[];
  availableSeries: TrendKpiKey[];
}

/** website/trend — null = fewer than two points ("accruing"). */
export interface WebsiteTrendView {
  trend: TrendChartView | null;
}

/** website/composition */
export interface CompositionView {
  topics: LiveTopicSlice[];
  sources: LiveSourceSlice[];
  degraded: boolean;
}

/** website/geo — shown only when the cards have data. */
export type WebsiteGeoView = { show: false } | { show: true; degraded: boolean; geo: GeoView };
