import "server-only";
import { describeHghError, isHghApiError } from "@/lib/hgh/errors";
import { hubFetch } from "@/lib/hub/client";
import { hubToken } from "@/lib/hub/session";
import type { SavedFilter, SavedFilterPage } from "./saved-filters";

/**
 * The signed-in account's saved filters of `page`, read with the page so the panel shows them in its first
 * render (and a default filter opens without waiting for another round trip). null when they cannot be
 * read now: the panel then asks again from the browser.
 */
export async function loadSavedFilters(page: SavedFilterPage): Promise<SavedFilter[] | null> {
  const token = await hubToken();
  if (!token) return null;
  try {
    const query = new URLSearchParams({ page }).toString();
    return (await hubFetch<{ data: { items: SavedFilter[] } }>("GET", "/v1/hub/saved-filters", { token, query })).data.items;
  } catch (e) {
    console.warn("[hub] saved filters read failed", isHghApiError(e) ? describeHghError(e) : e instanceof Error ? e.name : typeof e);
    return null;
  }
}
