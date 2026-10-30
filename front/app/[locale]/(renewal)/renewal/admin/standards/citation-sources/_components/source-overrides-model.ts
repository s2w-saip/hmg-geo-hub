// Admin › 인용 출처 분류 (2026-10-30): the list's filters, search, sort and URL mirror, kept pure for the tests.
import { SOURCE_LAYERS, SYNC_STATES, type SourceRow } from "./source-overrides-api";

export const ALL = "all";
export const OTHER = "other"; // gold.dim_category slug of 미분류 (Other)

export const SOURCE_AXES = ["category", "source", "state"] as const;
export type SourceAxis = (typeof SOURCE_AXES)[number];
export type SourceFilter = Record<SourceAxis, string>;
export const DEFAULT_FILTER: SourceFilter = { category: ALL, source: ALL, state: ALL };

export const SOURCE_SORTS = ["citations", "domain", "category", "source", "state"] as const;
export type SourceSort = (typeof SOURCE_SORTS)[number];
export const DEFAULT_SORT: { key: SourceSort; asc: boolean } = { key: "citations", asc: false };

/** Text columns start A→Z; counts and the correction-first orders start with the largest / the corrected. */
export function firstAsc(key: SourceSort): boolean {
  return key === "domain" || key === "category";
}

/** The values an axis can pick; RnRadioAxis adds its own 전체 (ALL) row in front. */
export function axisOptions(axis: SourceAxis, categories: readonly string[]): string[] {
  if (axis === "category") return [...categories];
  if (axis === "source") return [...SOURCE_LAYERS];
  return [...SYNC_STATES];
}

export function matches(row: SourceRow, f: SourceFilter, search: string, otherOnly: boolean): boolean {
  if (otherOnly && row.category !== OTHER) return false;
  if (f.category !== ALL && row.category !== f.category) return false;
  if (f.source !== ALL && row.source !== f.source) return false;
  if (f.state !== ALL && row.state !== f.state) return false;
  const q = search.trim().toLowerCase();
  return !q || row.skey.toLowerCase().includes(q) || row.domain.toLowerCase().includes(q);
}

const STATE_ORDER: Record<string, number> = { pending: 0, upstream: 1, applied: 2 };

/** Ties fall back to citations (largest first), then the key. `categoryOrder` is Gold's category order. */
export function sortRows(rows: readonly SourceRow[], key: SourceSort, asc: boolean, categoryOrder: ReadonlyMap<string, number>): SourceRow[] {
  const value = (r: SourceRow): number | string => {
    if (key === "citations") return r.citations;
    if (key === "domain") return r.skey.toLowerCase();
    if (key === "category") return categoryOrder.get(r.category) ?? 999;
    // the corrected first (the rows a revert is for), as the original screen
    if (key === "source") return r.source === "override" ? 0 : 1;
    return r.state ? STATE_ORDER[r.state] : 9;
  };
  const dir = asc ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return c * dir || b.citations - a.citations || a.key.localeCompare(b.key);
  });
}

export function counts(rows: readonly SourceRow[]) {
  return {
    total: rows.length,
    overrides: rows.filter((r) => r.override?.status === "active").length,
    other: rows.filter((r) => r.category === OTHER).length,
    pending: rows.filter((r) => r.state === "pending").length,
  };
}

export function filterToQuery(f: SourceFilter, search: string, otherOnly: boolean): string {
  const p = new URLSearchParams();
  for (const a of SOURCE_AXES) if (f[a] !== ALL) p.set(a, f[a]);
  if (otherOnly) p.set("other", "1");
  if (search.trim()) p.set("q", search.trim());
  return p.toString();
}

/** URL picks; a value that is not one of the axis's is dropped (categories: Gold's slug shape only, checked on render). */
export function queryToFilter(q: string | URLSearchParams): { filters: SourceFilter; search: string; otherOnly: boolean } {
  const p = typeof q === "string" ? new URLSearchParams(q) : q;
  const pick = (a: SourceAxis, allowed: readonly string[] | null) => {
    const v = p.get(a);
    return v && (allowed ? allowed.includes(v) : /^[a-z][A-Za-z0-9]{0,63}$/.test(v)) ? v : ALL;
  };
  return {
    filters: { category: pick("category", null), source: pick("source", SOURCE_LAYERS), state: pick("state", SYNC_STATES) },
    search: p.get("q") ?? "",
    otherOnly: p.get("other") === "1",
  };
}

export function pickedAxes(f: SourceFilter): SourceAxis[] {
  return SOURCE_AXES.filter((a) => f[a] !== ALL);
}
