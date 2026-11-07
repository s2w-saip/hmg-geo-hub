import type { VisTab } from "./screen-types";

// The view tab of the renewal AI Visibility page (?view=). Plain module: the server page reads the
// initial tab, the client rail writes it.
export const VIS_TABS: readonly VisTab[] = ["sum", "page", "engine", "site"];

export function tabOf(raw: string | string[] | undefined): VisTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return VIS_TABS.includes(v as VisTab) ? (v as VisTab) : "sum";
}

/** The query string of `tab` on top of `search` (`?…`, or "" when nothing is left); 요약 is the default, no param. */
export function tabQuery(search: URLSearchParams, tab: VisTab): string {
  if (tab === "sum") search.delete("view");
  else search.set("view", tab);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}
