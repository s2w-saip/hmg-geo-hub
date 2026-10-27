// Browser reads of the Global prompts lists (original and renewal page): GET /api/standard/prompts/*,
// thin proxies to the screens catalog/prompts-* (GET, so the local read-only mode allows them).
import type { HistoryQuery, PromptsExport, PromptsHistory, PromptsPage, PromptsQuery, PromptsTimeline } from "./screen-types";
import { exportParams, historyParams, listParams, toSearch, type ParamValue } from "./screen-query";

async function getJson<T>(view: "page" | "export" | "history" | "timeline", params: Record<string, ParamValue>): Promise<T> {
  const qs = toSearch(params);
  const res = await fetch(`/api/standard/prompts/${view}${qs ? `?${qs}` : ""}`, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Global prompts ${view} read failed (${res.status})`);
  return (await res.json()) as T;
}

export const fetchPromptsPage = (query: PromptsQuery) => getJson<PromptsPage>("page", listParams(query));
export const fetchPromptsExport = (query: PromptsQuery) => getJson<PromptsExport>("export", exportParams(query));
export const fetchPromptsHistory = (query: HistoryQuery) => getJson<PromptsHistory>("history", historyParams(query));
export const fetchPromptTimeline = (promptId: string) => getJson<PromptsTimeline>("timeline", { prompt_id: promptId });
