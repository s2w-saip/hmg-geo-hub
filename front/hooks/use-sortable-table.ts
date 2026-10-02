"use client";

import { useMemo, useState } from "react";

// Reusable sortable-table state. Pass rows + a `sorters` map keyed by
// SortKey (each value returns a comparable — string or number) and get
// back `{ sorted, sortKey, asc, toggleSort, headerProps }`.
//
// Caller renders header cells via <SortableHeader {...headerProps(key)}>
// from `components/ui/sortable-header.tsx`. The hook intentionally
// doesn't render — keeps it framework-agnostic for both <table> and
// <ul/div> grid layouts.
//
// Example:
//   const { sorted, headerProps } = useSortableTable(rows, {
//     name: (r) => r.name,
//     count: (r) => r.count,
//   }, { defaultKey: "count", defaultAsc: false });
//
//   <SortableHeader {...headerProps("count")} align="right">
//     Mentions
//   </SortableHeader>

export type Sorter<T> = (row: T) => string | number;

export type UseSortableTableOptions<K extends string> = {
  defaultKey: K;
  /** true = ascending on first paint. false = descending (most common for numeric leaderboards). */
  defaultAsc?: boolean;
  /** Sort keys that default to ascending direction when first selected.
   *  Common case: string columns flip to ascending; numeric flip to descending. */
  ascByDefault?: K[];
};

export type SortableHeaderProps<K extends string> = {
  active: boolean;
  asc: boolean;
  onClick: () => void;
  sortKey: K;
};

export function useSortableTable<T, K extends string>(
  rows: T[],
  sorters: Record<K, Sorter<T>>,
  opts: UseSortableTableOptions<K>,
): {
  sorted: T[];
  sortKey: K;
  asc: boolean;
  toggleSort: (next: K) => void;
  headerProps: (key: K) => SortableHeaderProps<K>;
} {
  const [sortKey, setSortKey] = useState<K>(opts.defaultKey);
  const [asc, setAsc] = useState(opts.defaultAsc ?? false);
  const ascSet = useMemo(
    () => new Set(opts.ascByDefault ?? []),
    [opts.ascByDefault],
  );

  function toggleSort(next: K) {
    if (next === sortKey) {
      setAsc((v) => !v);
      return;
    }
    setSortKey(next);
    // First selection of a column picks the "natural" direction. String
    // columns lean ascending (A→Z); numeric/score columns lean descending
    // (top first). Callers declare via `ascByDefault`.
    setAsc(ascSet.has(next));
  }

  const sorted = useMemo(() => {
    const sorter = sorters[sortKey];
    const dir = asc ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sorter(a);
      const bv = sorter(b);
      if (typeof av === "string" && typeof bv === "string") {
        return dir * av.localeCompare(bv);
      }
      return dir * ((av as number) - (bv as number));
    });
  }, [rows, sortKey, asc, sorters]);

  function headerProps(key: K): SortableHeaderProps<K> {
    return {
      active: sortKey === key,
      asc,
      onClick: () => toggleSort(key),
      sortKey: key,
    };
  }

  return { sorted, sortKey, asc, toggleSort, headerProps };
}
