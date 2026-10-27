// Test inputs for the screen-driven overview components: the views the overview screens send
// (back/bff/screens/overview.py) for the small KpiSummary / LiveTrend / brand / LiveGeo fixtures the
// tests use. The views were recorded once from the former TypeScript view model and are read from
// overview-views.frozen.json (test/frozen.ts); the app never imports this file.
import type { CompetitorBrandValue } from "@/lib/scope/result-adapter";
import { frozen, loadFrozen } from "@/test/frozen";
import type { LiveGeo, LiveTrend } from "../../_data/live-types";
import type { KpiSummary } from "../../_data/model";
import type { OverviewKpiKey } from "../../_data/overview-metrics";
import type {
  CardCompetitorsView,
  CardTrendView,
  GeoView,
  OverviewCardView,
} from "../../_data/screen-types";

const TABLE = loadFrozen(new URL("./overview-views.frozen.json", import.meta.url));

/** A promise React's `use()` reads synchronously (already fulfilled), so static renders show the value. */
export function done<T>(v: T): Promise<T> {
  return Object.assign(Promise.resolve(v), { status: "fulfilled" as const, value: v });
}

/** overview/cards for the KPIs (value, 측정 대기). */
export function cardsOf(...args: [kpis: KpiSummary[]]): OverviewCardView[] {
  return frozen(TABLE, "cardsOf", args);
}

/** overview/card-trend: card Δ = the KPI's delta; sparkline = the trend's last points. */
export function trendOf(...args: [kpis: KpiSummary[], trend: LiveTrend | null, degraded?: boolean]): CardTrendView {
  return frozen(TABLE, "trendOf", args);
}

/** overview/card-competitors for the brand rows (+ per-KPI Δ by brand). */
export function competitorsOf(
  ...args: [brands: CompetitorBrandValue[], deltas?: Partial<Record<OverviewKpiKey, Record<string, number>>>]
): CardCompetitorsView {
  return frozen(TABLE, "competitorsOf", args);
}

/** overview/geo for a LiveGeo (values, rivals, lead flag, map bindings, country menu, domains). */
export function geoViewOf(...args: [live: LiveGeo, numeric?: Record<string, string>]): GeoView {
  return frozen(TABLE, "geoViewOf", args);
}
