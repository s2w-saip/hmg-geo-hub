// Filter model of Admin › Global prompts (2026-10-28) — pure. The list has the Global prompts list's
// panel (standard/prompts/_components/prompt-filter-model.ts): one choice per axis, applied at once,
// "전체" (= "all") by default, picking a parent resets its children, the URL and saved filters carry
// the picks and the search text. The axes are the catalog's own:
//   axes      상태 · 출처, then the Global list's order: 리스트 유형 · Depth1–4 · 퍼널 · 브랜드 포함 여부 ·
//             측정 종류 · 대상 시장 · 언어
//   default   상태 = 사용 중 (the rest 전체)
//   options   상태 · 출처 · 측정 종류 are fixed; the others are the codes the catalog uses (count > 0)
//   read      the BFF list query (catalog_editor.list_filters / list_order)

import type { HubOptions } from "./hub-prompts-api";

export const ALL = "all";

export const HUB_AXES = ["status", "origin", "listType", "depth1", "depth2", "depth3", "depth4", "funnel", "brandPresence", "kind", "region", "language"] as const;
export type HubAxis = (typeof HUB_AXES)[number];
export type HubFilter = Record<HubAxis, string>;

export const DEFAULT_FILTER: HubFilter = { ...(Object.fromEntries(HUB_AXES.map((a) => [a, ALL])) as HubFilter), status: "active" };

const FIXED = {
  status: ["active", "archived", "removed"],
  origin: ["hub", "gold"],
  kind: ["acr", "single"],
} as const;

/** Options of one axis: fixed, or the codes the catalog uses. */
export function axisOptions(axis: HubAxis, options: HubOptions): readonly string[] {
  if (axis === "status" || axis === "origin" || axis === "kind") return FIXED[axis];
  return options[axis === "region" ? "regions" : axis].filter((o) => o.count > 0).map((o) => o.value);
}

/** An axis with no options is hidden. */
export function visibleAxes(options: HubOptions): HubAxis[] {
  return HUB_AXES.filter((a) => axisOptions(a, options).length > 0);
}

/** A parent pick resets its children to "전체". */
export function patchFilter(prev: HubFilter, patch: Partial<HubFilter>): HubFilter {
  const next = { ...prev, ...patch };
  if (patch.listType !== undefined) Object.assign(next, { depth1: ALL, depth2: ALL, depth3: ALL, depth4: ALL });
  if (patch.depth1 !== undefined) Object.assign(next, { depth2: ALL, depth3: ALL, depth4: ALL });
  if (patch.depth2 !== undefined) Object.assign(next, { depth3: ALL, depth4: ALL });
  if (patch.depth3 !== undefined) Object.assign(next, { depth4: ALL });
  return next;
}

/** The axes picked away from their default. */
export const pickedAxes = (f: HubFilter): HubAxis[] => HUB_AXES.filter((a) => f[a] !== DEFAULT_FILTER[a]);

/** Sort keys (the BFF's sort=) and their first direction: the latest change first, the rest A→Z. */
export const HUB_SORTS = ["changed", "text", "origin", "status", "listType", "depth1", "depth2", "depth3", "depth4", "funnel", "brandPresence", "kind", "region", "language"] as const;
export type HubSort = (typeof HUB_SORTS)[number];
export const firstAsc = (key: HubSort) => key !== "changed";
export const DEFAULT_SORT: { key: HubSort; asc: boolean } = { key: "changed", asc: false };

export interface ListQuery {
  filters: HubFilter;
  search: string;
  sort: HubSort;
  asc: boolean;
  page: number;
  pageSize: number;
}

export const DEFAULT_PAGE_SIZE = 50;

/** The BFF list query of a page. */
export function listSearch(q: ListQuery): string {
  const p = new URLSearchParams({ status: q.filters.status, origin: q.filters.origin });
  for (const a of HUB_AXES) if (a !== "status" && a !== "origin" && q.filters[a] !== ALL) p.set(a, q.filters[a]);
  if (q.search.trim()) p.set("q", q.search.trim());
  p.set("sort", q.sort);
  p.set("order", q.asc ? "asc" : "desc");
  p.set("limit", String(q.pageSize));
  p.set("offset", String((q.page - 1) * q.pageSize));
  return p.toString();
}

// ── URL / saved-filter form: the axes away from their default + the search text ──
export function filterToQuery(f: HubFilter, search: string): string {
  const p = new URLSearchParams();
  for (const a of pickedAxes(f)) p.set(a, f[a]);
  if (search.trim()) p.set("q", search.trim());
  return p.toString();
}

export function queryToFilter(q: string | URLSearchParams): { filters: HubFilter; search: string } {
  const p = typeof q === "string" ? new URLSearchParams(q) : q;
  const filters = { ...DEFAULT_FILTER };
  for (const a of HUB_AXES) {
    const v = p.get(a);
    if (v) filters[a] = v;
  }
  return { filters, search: p.get("q") ?? "" };
}
