"use client";

// The pages of an admin list read whole (2026-11-05): the list screens' rows split into pages of 50 (25 · 50 · 100 to
// pick), with the pager under the table, as Admin › Global prompts and 엔티티 역할. A new filter, search or sort starts at
// page 1; a list that shrinks under the page (a reload after a change) shows its last page.

import { useState, type ReactNode } from "react";
import { RnListPager } from "../../_components/prompt-list";

export const ADMIN_PAGE_SIZES = [25, 50, 100] as const;
export const ADMIN_PAGE_SIZE = 50;

/** `rows` (filtered and sorted) one page at a time; `resetOn` holds the filter, search and sort the page goes back to 1 on. */
export function useAdminListPage<T>(rows: readonly T[], resetOn: readonly unknown[]): { rows: T[]; pager: ReactNode } {
  const [size, setSize] = useState<number>(ADMIN_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [seen, setSeen] = useState(resetOn);
  if (resetOn.length !== seen.length || resetOn.some((v, i) => !Object.is(v, seen[i]))) {
    setSeen(resetOn);
    setPage(1);
  }
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages);
  return {
    rows: rows.slice((current - 1) * size, current * size),
    pager: (
      <RnListPager
        rangeFrom={rows.length ? (current - 1) * size + 1 : 0}
        rangeTo={Math.min(current * size, rows.length)}
        total={rows.length}
        page={current}
        pages={pages}
        pageSize={size}
        pageSizes={ADMIN_PAGE_SIZES}
        onPageSize={(n) => {
          setSize(n);
          setPage(1);
        }}
        onPage={setPage}
      />
    ),
  };
}
