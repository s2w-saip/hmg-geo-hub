"use client";

import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import type { ContextSortDir, ContextMapQuery, Paged } from "./types";

// Query state + fetching for one context-map tab.
//
// Live tabs fetch pages from /api/context-map; the sample fixture is paged in
// memory by the caller's `fetchPage`. The hook does not know which — it just
// owns (search, sort, dir, page) and keeps the latest page.
//
// Search is deferred, not debounced: the same call the citations view made after
// a per-keystroke re-sort caused an INP regression. Deferring keeps the input
// responsive without inventing a delay constant, and here it also collapses the
// bursts of requests a raw keystroke→fetch would produce.
//
// Cursor paging (decision D5, unit U10 C3): the API source pages by keyset cursor,
// not offset. A page that carries `nextCursor` teaches the hook the cursor of the
// following page; pages are still numbered for the UI (prev/next + "page n of m"
// from the total), and prev reuses the cursor remembered for that page. Any change
// to the result set (search, sort, direction) forgets the cursors. When the server
// answers another page than the one asked (a stale cursor restarts at the first
// page), the hook moves to that page instead of refetching. Sources without cursors
// (legacy offsets, the sample pager) never set `nextCursor` and behave as before.

export type PagedTabState<T, S extends string> = {
  data: Paged<T>;
  loading: boolean;
  error: boolean;
  search: string;
  setSearch: (v: string) => void;
  sort: S;
  dir: ContextSortDir;
  /** Header click: same key flips direction, a new key starts at its natural one. */
  toggleSort: (key: S) => void;
  page: number;
  setPage: (p: number) => void;
  pageCount: number;
  retry: () => void;
};

export function usePagedTab<T, S extends string>({
  initial,
  defaultSort,
  ascByDefault,
  fetchPage,
}: {
  initial: Paged<T>;
  defaultSort: S;
  /** Keys that read naturally ascending (names). Others start descending. */
  ascByDefault?: readonly S[];
  fetchPage: (q: ContextMapQuery<S>) => Promise<Paged<T>>;
}): PagedTabState<T, S> {
  const [data, setData] = useState<Paged<T>>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [search, setSearchRaw] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [sort, setSort] = useState<S>(defaultSort);
  const [dir, setDir] = useState<ContextSortDir>(
    ascByDefault?.includes(defaultSort) ? "asc" : "desc",
  );
  const [page, setPage] = useState(0);
  const [nonce, setNonce] = useState(0);

  // Guards against a slow first request overwriting a fast later one — with
  // search-as-you-type, out-of-order responses are the normal case, not an edge.
  const reqId = useRef(0);
  // The server already rendered page 0 of the default query; refetching it on
  // mount would double every page load for nothing.
  const primed = useRef(true);
  // "<set key>#<page>" when the server moved us to another page: that page is
  // already in `data`, so the effect run for it must not refetch.
  const synced = useRef<string | null>(null);

  const size = initial.size;

  // page -> cursor for the current result set (API source only).
  const cursors = useRef<Map<number, string>>(
    new Map(initial.nextCursor ? [[1, initial.nextCursor]] : []),
  );
  const setKey = useRef(`|${sort}|${dir}|${size}`);

  useEffect(() => {
    const key = `${deferredSearch.trim()}|${sort}|${dir}|${size}`;
    if (key !== setKey.current) {
      setKey.current = key;
      cursors.current.clear();
    }
    if (primed.current) {
      primed.current = false;
      return;
    }
    const landed = synced.current === `${key}#${page}`;
    synced.current = null;
    if (landed) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(false);
    const cursor = page > 0 ? cursors.current.get(page) : undefined;
    void (async () => {
      try {
        const next = await fetchPage({
          search: deferredSearch.trim() || undefined,
          sort,
          dir,
          page,
          size,
          ...(cursor ? { cursor } : {}),
        });
        if (id !== reqId.current) return; // superseded
        if (rememberCursor(cursors.current, page, next)) {
          synced.current = `${key}#${next.page}`;
          setPage(next.page);
        }
        setData(next);
      } catch {
        if (id !== reqId.current) return;
        setError(true);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
  }, [deferredSearch, sort, dir, page, size, fetchPage, nonce]);

  // Any change to the result SET must reset to the first page — otherwise
  // narrowing a search while on page 5 lands the user on an empty page and
  // reads as "no results".
  const setSearch = useCallback((v: string) => {
    setSearchRaw(v);
    setPage(0);
  }, []);

  const toggleSort = useCallback(
    (key: S) => {
      if (key === sort) {
        setDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSort(key);
        setDir(ascByDefault?.includes(key) ? "asc" : "desc");
      }
      setPage(0);
    },
    [sort, ascByDefault],
  );

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return {
    data,
    loading,
    error,
    search,
    setSearch,
    sort,
    dir,
    toggleSort,
    page,
    setPage,
    pageCount: Math.max(1, Math.ceil(data.total / Math.max(data.size, 1))),
    retry,
  };
}

/**
 * Cursor bookkeeping for one answered page (D5). Records the cursor of the page after the
 * answered one (or forgets it on the last page). When the server answered another page than
 * the one asked (stale or missing cursor: first page), every remembered cursor is dropped and
 * true is returned: the caller moves to `res.page`. Pages without `nextCursor` (offset sources)
 * leave the map alone. Exported for unit test.
 */
export function rememberCursor(
  cursors: Map<number, string>,
  requestedPage: number,
  res: Pick<Paged<unknown>, "page" | "nextCursor">,
): boolean {
  if (res.nextCursor === undefined) return false;
  const moved = res.page !== requestedPage;
  if (moved) cursors.clear();
  if (res.nextCursor) cursors.set(res.page + 1, res.nextCursor);
  else cursors.delete(res.page + 1);
  return moved;
}

/** Fetcher for the live tabs. Sample tabs pass an in-memory pager instead. */
export function fetchContextMapPage<T, S extends string>(
  tab: "contexts" | "conditions" | "combinations",
): (q: ContextMapQuery<S>) => Promise<Paged<T>> {
  return async (q) => {
    const params = new URLSearchParams({
      tab,
      sort: q.sort,
      dir: q.dir,
      page: String(q.page),
      size: String(q.size),
    });
    if (q.search) params.set("search", q.search);
    if (q.cursor) params.set("cursor", q.cursor);
    const res = await fetch(`/api/context-map?${params}`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error ?? "failed");
    return json.paged as Paged<T>;
  };
}
