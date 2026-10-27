// Renewal Global prompts filter model — pure. The filters are the original
// /standard/prompts filters, unchanged (product decision 2026-10-20: "앱과 100% 동일"):
//   axes      리스트 유형 · Depth1–4 · 퍼널 · 브랜드 포함 여부 · 측정 종류 · 대상 시장 · 언어 · 측정 상태
//   values    single choice each, "전체" (= "all") by default
//   options   the server's facets (cascading by the current picks); presence / kind / status are fixed
//   shown     an axis with no options is hidden (presence / kind / status always show)
//   cascade   picking a parent resets its children to "전체"
//   read      the same query the original list sends (filters = draft, since picks apply at once)
// Parity is pinned by prompt-filter-model.parity.test.tsx (renders the original list).

import {
  EMPTY_FILTER,
  STATUS_MEASURED,
  STATUS_UNMEASURED,
  type FilterState,
} from "@/app/[locale]/(dash)/standard/prompts/_components/prompt-list-readonly";
import type { PromptsQuery } from "@/app/[locale]/(dash)/standard/prompts/_data/screen-types";
import type { CatalogSort } from "@/lib/standards/catalog-page";

export { EMPTY_FILTER, type FilterState };
export const ALL = "all";
export type PromptAxis = keyof FilterState;

/** Panel order = the original filter strip order. */
export const PROMPT_AXES: readonly PromptAxis[] = ["listType", "depth1", "depth2", "depth3", "depth4", "funnel", "presence", "kind", "market", "lang", "status"];
const ALWAYS: ReadonlySet<PromptAxis> = new Set(["presence", "kind", "status"]);
const FIXED: Partial<Record<PromptAxis, readonly string[]>> = {
  presence: ["branded", "unbranded"],
  kind: ["acr", "single"],
  status: [STATUS_MEASURED, STATUS_UNMEASURED],
};

/** Options of one axis: the server facets (presence / kind / status are fixed). */
export function axisOptions(axis: PromptAxis, facets: Record<string, string[]>): readonly string[] {
  return FIXED[axis] ?? facets[axis] ?? [];
}

export function visibleAxes(facets: Record<string, string[]>): PromptAxis[] {
  return PROMPT_AXES.filter((a) => ALWAYS.has(a) || axisOptions(a, facets).length > 0);
}

/** The original updateDraft: a parent pick resets its children to "전체". */
export function patchDraft(prev: FilterState, patch: Partial<FilterState>): FilterState {
  const next = { ...prev, ...patch };
  if (patch.listType !== undefined) Object.assign(next, { depth1: ALL, depth2: ALL, depth3: ALL, depth4: ALL });
  if (patch.depth1 !== undefined) Object.assign(next, { depth2: ALL, depth3: ALL, depth4: ALL });
  if (patch.depth2 !== undefined) Object.assign(next, { depth3: ALL, depth4: ALL });
  if (patch.depth3 !== undefined) Object.assign(next, { depth4: ALL });
  return next;
}

export const activeAxes = (f: FilterState): PromptAxis[] => PROMPT_AXES.filter((a) => f[a] !== ALL);

/** Sort keys of the original table (its sortable headers) and their first direction. */
export const PROMPT_SORTS: readonly CatalogSort[] = ["text", "brand", "presence", "listType", "depth1", "depth2", "depth3", "depth4", "funnel", "kind", "market", "lang", "status"];
const ASC_BY_DEFAULT: ReadonlySet<CatalogSort> = new Set(["text", "brand", "presence", "listType", "depth1", "depth2", "depth3", "depth4", "funnel", "market", "lang", "status"]);
export const firstAsc = (key: CatalogSort) => ASC_BY_DEFAULT.has(key);
export const DEFAULT_SORT: { key: CatalogSort; asc: boolean } = { key: "depth1", asc: true };

/** The original list's read query (picks apply at once, so applied = draft). */
export function readQuery(args: {
  filters: FilterState;
  search: string;
  sort: CatalogSort;
  asc: boolean;
  page: number;
  pageSize: number;
  collation: "ko" | "en";
  marketCodes: readonly string[];
  marketLabel: (code: string) => string;
}): PromptsQuery {
  return {
    filters: args.filters,
    draft: args.filters,
    search: args.search,
    sort: args.sort,
    asc: args.asc,
    page: args.page,
    limit: args.pageSize,
    collation: args.collation,
    marketLabels: Object.fromEntries(args.marketCodes.map((code) => [code, args.marketLabel(code)])),
  };
}

// ── URL / saved-filter form: only picked axes + the search text ──
export function filterToQuery(f: FilterState, search: string): string {
  const p = new URLSearchParams();
  for (const a of PROMPT_AXES) if (f[a] !== ALL) p.set(a, f[a]);
  if (search.trim()) p.set("q", search.trim());
  return p.toString();
}
export function queryToFilter(q: string | URLSearchParams): { filters: FilterState; search: string } {
  const p = typeof q === "string" ? new URLSearchParams(q) : q;
  const filters = { ...EMPTY_FILTER };
  for (const a of PROMPT_AXES) {
    const v = p.get(a);
    if (v) filters[a] = v;
  }
  return { filters, search: p.get("q") ?? "" };
}
