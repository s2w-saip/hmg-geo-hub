// Browser reads of the renewal Website › Prompts body (search, order, page, page size, the list's picks,
// export): GET /api/website/prompts/{page|rows|insights}, thin proxies to the screens website/prompts-* (GET, so
// the local read-only mode allows them; a server action is a POST). `query` is the page URL's search (filters,
// q, sort, dir, size, picks) with the page number; the BFF derives the rest (back/bff/screens/website_prompts.py).
import type { WebsitePromptInsights, WebsitePromptRow, WebsitePromptsPage } from "./website-prompt-model";

async function getJson<T>(view: "page" | "rows" | "insights", query: string): Promise<T> {
  const res = await fetch(`/api/website/prompts/${view}${query ? `?${query}` : ""}`, { cache: "no-store", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Website prompts ${view} read failed (${res.status})`);
  return (await res.json()) as T;
}

export const readWebsitePromptsPage = (query: string) => getJson<WebsitePromptsPage>("page", query);
export const readWebsitePromptRows = (query: string) => getJson<{ rows: WebsitePromptRow[]; roundAxis: string[] }>("rows", query);
export const readWebsitePromptInsights = (query: string) => getJson<WebsitePromptInsights>("insights", query);
