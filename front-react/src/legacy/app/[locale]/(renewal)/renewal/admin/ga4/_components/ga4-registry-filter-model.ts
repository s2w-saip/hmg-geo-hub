// Admin › GA4 연동 (2026-10-29): the list's filters, search and order. Properties are few (one per market at most),
// so the page reads them all once and filters in the browser. The URL and the saved filters (page "ga4") carry the
// picks and the search text.

import { GA4_BRANDS, type Ga4Property } from "./ga4-registry-api";

export const ALL = "all";
export const GA4_AXES = ["brand", "setting", "result"] as const;
export type Ga4Axis = (typeof GA4_AXES)[number];
export type Ga4Filter = Record<Ga4Axis, string>;
export const DEFAULT_FILTER: Ga4Filter = { brand: ALL, setting: ALL, result: ALL };

/** The administrator's setting: 수집 · 중지 */
export const SETTINGS = ["enabled", "stopped"] as const;
/** The collector's last result as it left it; never = it has not run for the property yet. */
export const RESULTS = ["collected", "pending_grant", "failed", "stopped", "never"] as const;
export type Ga4Result = (typeof RESULTS)[number];

export const AXIS_OPTIONS: Record<Ga4Axis, readonly string[]> = {
  brand: GA4_BRANDS,
  setting: SETTINGS,
  result: RESULTS,
};

export function resultOf(p: Ga4Property): Ga4Result {
  return p.collection.status ?? "never";
}

export function queryToFilter(q: URLSearchParams | string): { filters: Ga4Filter; search: string } {
  const sp = typeof q === "string" ? new URLSearchParams(q) : q;
  const filters = { ...DEFAULT_FILTER };
  for (const axis of GA4_AXES) {
    const v = sp.get(axis);
    if (v && AXIS_OPTIONS[axis].includes(v)) filters[axis] = v;
  }
  return { filters, search: (sp.get("q") ?? "").slice(0, 200) };
}

export function filterToQuery(filters: Ga4Filter, search: string): string {
  const sp = new URLSearchParams();
  for (const axis of GA4_AXES) if (filters[axis] !== ALL) sp.set(axis, filters[axis]);
  if (search.trim()) sp.set("q", search.trim());
  return sp.toString();
}

export function pickedAxes(filters: Ga4Filter): Ga4Axis[] {
  return GA4_AXES.filter((a) => filters[a] !== ALL);
}

/** The search text matches the property ID, the country code, the country's name (`countryLabel`) or an event. */
export function matches(p: Ga4Property, f: Ga4Filter, search: string, countryLabel: (code: string) => string = (c) => c): boolean {
  if (f.brand !== ALL && p.brand !== f.brand) return false;
  if (f.setting !== ALL && (p.enabled ? "enabled" : "stopped") !== f.setting) return false;
  if (f.result !== ALL && resultOf(p) !== f.result) return false;
  const q = search.trim().toLowerCase();
  return !q || [p.propertyId, p.country, countryLabel(p.country), ...p.events].some((v) => v.toLowerCase().includes(q));
}

export const GA4_SORTS = ["market", "propertyId", "result", "collectedTo"] as const;
export type Ga4Sort = (typeof GA4_SORTS)[number];
export const DEFAULT_SORT: { key: Ga4Sort; asc: boolean } = { key: "market", asc: true };

/** The last collected day reads newest first on the first click; the rest A → Z. */
export function firstAsc(key: Ga4Sort): boolean {
  return key !== "collectedTo";
}

const RESULT_RANK: Record<Ga4Result, number> = { failed: 0, pending_grant: 1, never: 2, collected: 3, stopped: 4 };

/** One column, then brand, country and property ID. A property never collected sorts after every collected day either way. */
export function sortProperties(items: Ga4Property[], key: Ga4Sort, asc: boolean, countryLabel: (code: string) => string = (c) => c): Ga4Property[] {
  const market = (a: Ga4Property, b: Ga4Property) =>
    a.brand.localeCompare(b.brand) || countryLabel(a.country).localeCompare(countryLabel(b.country)) || a.propertyId.localeCompare(b.propertyId);
  const dir = asc ? 1 : -1;
  const by = (a: Ga4Property, b: Ga4Property): number => {
    switch (key) {
      case "propertyId":
        return (a.propertyId.length - b.propertyId.length || a.propertyId.localeCompare(b.propertyId)) * dir;
      case "result":
        return (RESULT_RANK[resultOf(a)] - RESULT_RANK[resultOf(b)]) * dir;
      case "collectedTo": {
        const x = a.collection.collectedTo;
        const y = b.collection.collectedTo;
        if (!x || !y) return x ? -1 : y ? 1 : 0;
        return x.localeCompare(y) * dir;
      }
      default:
        return market(a, b) * dir;
    }
  };
  return [...items].sort((a, b) => by(a, b) || market(a, b));
}
