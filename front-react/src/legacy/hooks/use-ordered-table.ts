"use client";

import { useMemo, useState } from "react";
import type { SortableHeaderProps, UseSortableTableOptions } from "./use-sortable-table";

// Sortable table whose orders come from the API (screen view models carry `orders`).
// The hook only keeps the UI state (which column, which direction) and picks the matching
// precomputed row order; it never compares values.
//
//   const { sorted, headerProps } = useOrderedTable(vm.rows, vm.orders, { defaultKey: "count" });

/** Row indices per sortable column and direction (back/bff/screens/_sort.py table_orders). */
export type TableOrders<K extends string> = Record<K, { asc: number[]; desc: number[] }>;

export function useOrderedTable<T, K extends string>(
  rows: T[],
  orders: TableOrders<K>,
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
  const ascSet = useMemo(() => new Set(opts.ascByDefault ?? []), [opts.ascByDefault]);

  function toggleSort(next: K) {
    if (next === sortKey) {
      setAsc((v) => !v);
      return;
    }
    setSortKey(next);
    setAsc(ascSet.has(next));
  }

  const sorted = useMemo(() => {
    const order = orders[sortKey]?.[asc ? "asc" : "desc"];
    return order ? order.map((i) => rows[i]) : rows;
  }, [rows, orders, sortKey, asc]);

  function headerProps(key: K): SortableHeaderProps<K> {
    return { active: sortKey === key, asc, onClick: () => toggleSort(key), sortKey: key };
  }

  return { sorted, sortKey, asc, toggleSort, headerProps };
}
