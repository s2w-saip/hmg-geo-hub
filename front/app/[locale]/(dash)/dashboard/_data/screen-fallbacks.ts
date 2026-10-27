// Screen failure -> UI state for the overview sections (error code -> state, no data rules).
// A transient failure (5xx, timeout, network) of a section's screen shows that section's
// degraded state, as the old degrade registry did; anything else goes to the page error path.
import { isHghApiError } from "@/lib/hgh/errors";
import type { CardCompetitorsView, CardTrendView } from "./screen-types";
import { OVERVIEW_KPI_KEYS, type OverviewKpiKey } from "./overview-metrics";

export function isTransientScreenError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return isHghApiError(e) && e.status >= 500;
}

const byKey = <T,>(v: () => T) => Object.fromEntries(OVERVIEW_KPI_KEYS.map((k) => [k, v()])) as Record<OverviewKpiKey, T>;

/** The card trend screen failed transiently: no Δ, empty sparklines, the trend notice. */
export const DEGRADED_CARD_TREND: CardTrendView = {
  degraded: true,
  cards: byKey(() => ({ delta: null, spark: { points: [], domain: [0, 100], hasValue: false } })),
  count: 0,
};

/** The competitor screen failed transiently: empty rows and the competitor notice. */
export const DEGRADED_CARD_COMPETITORS: CardCompetitorsView = {
  degraded: ["standardMentions", "brandTrend", "firstPosition", "standardCitationDomains"],
  rows: byKey(() => []),
  standing: byKey(() => null),
};

/** `p`, with a transient failure replaced by `fallback` (other failures stay rejections). */
export function onTransient<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((e: unknown) => {
    if (isTransientScreenError(e)) return fallback;
    throw e;
  });
}

/** Attach a rejection handler before anyone awaits (an early failure must not crash the process). */
export function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}
