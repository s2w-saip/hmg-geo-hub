// Query params of the Global prompts screens (catalog/prompts-*), built the same way for the
// server render and the browser reads through /api/standard/prompts/*. Param names only — the
// screen reads, filters, orders and pages.
import type { HistoryQuery, PromptsQuery } from "./screen-types";

export type ParamValue = string | number | boolean | undefined;

/** f.<axis> = applied filters, d.<axis> = draft ("all" left out), ml.<code> = market labels (market sort only). */
export function listParams(q: Partial<PromptsQuery>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = { search: q.search, sort: q.sort, asc: q.asc, page: q.page, limit: q.limit, collation: q.collation };
  for (const [key, value] of Object.entries(q.filters ?? {})) if (value !== "all") out[`f.${key}`] = value;
  for (const [key, value] of Object.entries(q.draft ?? {})) if (value !== "all") out[`d.${key}`] = value;
  if (q.sort === "market") for (const [code, label] of Object.entries(q.marketLabels ?? {})) out[`ml.${code}`] = label;
  return out;
}

/** The export read: the list's picks without paging. */
export function exportParams(q: PromptsQuery): Record<string, ParamValue> {
  return listParams({ ...q, page: undefined, limit: undefined });
}

export function historyParams(q: HistoryQuery): Record<string, ParamValue> {
  return { days: q.days, event: q.event };
}

/** Sorted keys, empty values dropped (the screen client's serialization). */
export function toSearch(params: Record<string, ParamValue>): string {
  const out = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v !== undefined && v !== "") out.append(key, String(v));
  }
  return out.toString();
}
