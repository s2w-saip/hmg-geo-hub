import type { StandardCatalogRow, StandardCatalogStats } from "@/lib/db/repositories/standards";

export const CATALOG_SORTS = ["text", "brand", "presence", "listType", "depth1", "depth2", "depth3", "depth4", "funnel", "kind", "market", "lang", "status", "tracked"] as const;
export type CatalogSort = typeof CATALOG_SORTS[number];
export type CatalogFilters = Partial<Record<"listType" | "depth1" | "depth2" | "depth3" | "depth4" | "funnel" | "presence" | "kind" | "market" | "lang" | "status" | "view", string>>;
export type CatalogPageQuery = {
  filters?: CatalogFilters;
  draft?: CatalogFilters;
  search?: string;
  sort?: CatalogSort;
  asc?: boolean;
  offset?: number;
  limit?: number;
  collation?: "ko" | "en";
  market_labels?: Record<string, string>;
};
export type CatalogPage = {
  rows: StandardCatalogRow[];
  total: number;
  count: number;
  offset: number;
  limit: number;
  facets: Record<string, string[]>;
  columns: string[];
  stats?: StandardCatalogStats | null;
};
export type CatalogPageLoader = (query: CatalogPageQuery) => Promise<CatalogPage>;
export type RemoteCatalog = { initial: CatalogPage; load: CatalogPageLoader };

export function catalogPageQuery(input: CatalogPageQuery): Required<CatalogPageQuery> {
  const q = { filters: {}, draft: {}, search: "", sort: "depth1" as CatalogSort, asc: true, offset: 0, limit: 50, collation: "en" as const, market_labels: {}, ...input };
  if (!CATALOG_SORTS.includes(q.sort) || !Number.isInteger(q.offset) || q.offset < 0 || q.offset > 10_000_000 ||
      !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 500 || !["ko", "en"].includes(q.collation) ||
      typeof q.search !== "string" || q.search.length > 5000 || typeof q.asc !== "boolean") throw new Error("Invalid catalog page query");
  for (const values of [q.filters, q.draft]) {
    if (!values || Object.entries(values).some(([key, value]) =>
      !["listType", "depth1", "depth2", "depth3", "depth4", "funnel", "presence", "kind", "market", "lang", "status", "view"].includes(key) ||
      typeof value !== "string" || value.length > 5000)) throw new Error("Invalid catalog filters");
  }
  return q;
}

/** Only an explicit export loads all matching pages. A failed page rejects the entire export. */
export async function exportCatalogPages(load: CatalogPageLoader, query: CatalogPageQuery): Promise<StandardCatalogRow[]> {
  const rows: StandardCatalogRow[] = [];
  const seen = new Set<string>();
  let expected: number | undefined;
  for (let offset = 0; ; offset += 500) {
    const page = await load({ ...query, offset, limit: 500 });
    expected ??= page.total;
    if (page.offset !== offset || page.total !== expected) throw new Error("Catalog changed during export; retry");
    for (const row of page.rows) {
      if (seen.has(row.id)) throw new Error("Catalog changed during export; retry");
      seen.add(row.id);
      rows.push(row);
    }
    if (rows.length === expected) return rows;
    if (page.rows.length !== 500) throw new Error("Incomplete catalog export");
  }
}
