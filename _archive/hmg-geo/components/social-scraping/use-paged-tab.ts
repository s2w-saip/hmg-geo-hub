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

  const size = initial.size;

  useEffect(() => {
    if (primed.current) {
      primed.current = false;
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const next = await fetchPage({
          search: deferredSearch.trim() || undefined,
          sort,
          dir,
          page,
          size,
        });
        if (id !== reqId.current) return; // superseded
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
    const res = await fetch(`/api/context-map?${params}`);
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error ?? "failed");
    return json.paged as Paged<T>;
  };
}
