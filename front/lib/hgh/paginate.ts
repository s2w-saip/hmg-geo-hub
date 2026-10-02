// Keyset cursor pagination (design 2.6, decision D5). The backend has no offsets or page
// numbers: meta.page = {next_cursor, limit, total?}. Rules enforced here:
//   - fetchAllPages needs an explicit maxPages (no unbounded loop) and fails loudly when
//     the list is longer, unless the caller opts into a truncated result.
//   - 409 cursor_stale (data generation moved) restarts from the first page ONCE, then fails.
//   - 422 cursor_invalid is a front bug (a cursor reused with other filters): never retried.
// Pure module: callers pass a page fetcher built on lib/hgh/client.
import { HghApiError, isCursorStale, LOCAL_CODES } from "./errors";
import type { ApiPage } from "./convert";

/** Hard ceiling for maxPages: a bigger list is not a "read everything" candidate. */
export const MAX_PAGES_CEILING = 100;

export interface PageInfo {
  nextCursor: string | null;
  limit: number | null;
  total: number | null;
  hasMore: boolean;
}

/** meta.page -> PageInfo (missing page = single, final page). */
export function pageInfo(meta: { page?: ApiPage | null } | null | undefined): PageInfo {
  const page = meta?.page ?? null;
  const nextCursor = page?.next_cursor || null;
  return {
    nextCursor,
    limit: page?.limit ?? null,
    total: page?.total ?? null,
    hasMore: nextCursor !== null,
  };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  total?: number | null;
}

export type PageFetcher<T> = (cursor: string | null) => Promise<CursorPage<T>>;

export interface FetchAllOptions {
  /** Required: most pages to read (1..MAX_PAGES_CEILING). */
  maxPages: number;
  /** When pages remain after maxPages: "throw" (default) or "truncate" (return what was read, truncated=true). */
  onLimit?: "throw" | "truncate";
}

export interface FetchAllResult<T> {
  items: T[];
  pages: number;
  total: number | null;
  truncated: boolean;
  /** A cursor_stale restart happened (items are from the restarted pass only). */
  restarted: boolean;
}

/**
 * Read a small list to the end: at most maxPages requests per pass, at most two passes
 * (the second only after 409 cursor_stale).
 */
export async function fetchAllPages<T>(fetchPage: PageFetcher<T>, opts: FetchAllOptions): Promise<FetchAllResult<T>> {
  const { maxPages } = opts;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_CEILING) {
    throw new RangeError(`fetchAllPages: maxPages must be an integer 1..${MAX_PAGES_CEILING}`);
  }
  let restarted = false;
  for (;;) {
    try {
      return { ...(await onePass(fetchPage, maxPages, opts.onLimit ?? "throw")), restarted };
    } catch (e) {
      if (isCursorStale(e) && !restarted) {
        restarted = true;
        continue;
      }
      throw e;
    }
  }
}

async function onePass<T>(fetchPage: PageFetcher<T>, maxPages: number, onLimit: "throw" | "truncate") {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let total: number | null = null;
  for (let pages = 1; ; pages += 1) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (page.total !== undefined && page.total !== null) total = page.total;
    const next = page.nextCursor || null;
    if (next === null) return { items, pages, total, truncated: false };
    if (seen.has(next)) {
      // The backend handed back a cursor it already gave: stop instead of looping.
      throw new HghApiError(500, LOCAL_CODES.pageLimit, "cursor repeated; pagination aborted");
    }
    seen.add(next);
    if (pages >= maxPages) {
      if (onLimit === "truncate") return { items, pages, total, truncated: true };
      throw new HghApiError(500, LOCAL_CODES.pageLimit, `more than ${maxPages} pages`, { maxPages });
    }
    cursor = next;
  }
}

/**
 * One page for a URL- or client-supplied cursor (server component lists, /api/* relays).
 * On 409 cursor_stale the cursor is dropped and the first page is read once instead.
 */
export async function fetchPageOrRestart<T>(
  fetchPage: PageFetcher<T>,
  cursor: string | null,
): Promise<CursorPage<T> & { restarted: boolean }> {
  try {
    return { ...(await fetchPage(cursor)), restarted: false };
  } catch (e) {
    if (cursor !== null && isCursorStale(e)) return { ...(await fetchPage(null)), restarted: true };
    throw e;
  }
}

const CURSOR_RE = /^[A-Za-z0-9_-]{1,8192}$/;

/**
 * Cursor from a search param: a base64url string or null (first page). Anything else
 * (arrays, junk) reads as the first page instead of a guaranteed 422 cursor_invalid.
 */
export function readCursorParam(raw: string | string[] | null | undefined): string | null {
  return typeof raw === "string" && CURSOR_RE.test(raw) ? raw : null;
}
