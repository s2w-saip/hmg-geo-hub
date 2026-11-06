import type { StandardCatalogRow, StandardCatalogStats } from "@/lib/db/repositories/standards";

export const CATALOG_SORTS = ["text", "brand", "presence", "listType", "depth1", "depth2", "depth3", "depth4", "funnel", "kind", "market", "lang", "status", "tracked"] as const;
/** Page reads with the scope metadata (count, facets, columns, stats): the server's page bound. */
export const CATALOG_PAGE_LIMIT_MAX = 500;
/** Rows-only reads (rows and total, no metadata): an export reads batches up to this size. */
export const CATALOG_ROWS_LIMIT_MAX = 5_000;
/** Rows per read of an export through a rows-only reader. */
export const CATALOG_EXPORT_PAGE_SIZE = CATALOG_ROWS_LIMIT_MAX;
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
  /** Collation of the read ("en" when absent): the list re-reads its first page only when the browser's differs. */
  collation?: "ko" | "en";
};
export type CatalogPageLoader = (query: CatalogPageQuery) => Promise<CatalogPage>;
/** A page without the scope metadata (count, facets, columns, stats): rows and the filtered total only. */
export type CatalogRowsPage = Pick<CatalogPage, "rows" | "total" | "offset" | "limit">;
export type CatalogRowsLoader = (query: CatalogPageQuery) => Promise<CatalogRowsPage>;
/** initial = the server render's page (default draft); rows = optional rows-only read used by reuseCatalogMeta. */
export type RemoteCatalog = { initial: CatalogPage; load: CatalogPageLoader; rows?: CatalogRowsLoader };

type CatalogMeta = Pick<CatalogPage, "count" | "facets" | "columns" | "stats">;
const metaOf = (page: CatalogPage): CatalogMeta => ({ count: page.count, facets: page.facets, columns: page.columns, stats: page.stats });
// The draft is the only query input the metadata depends on ("all" = not set).
const draftKey = (draft: CatalogFilters | undefined) =>
  JSON.stringify(Object.entries(draft ?? {}).filter(([, value]) => value !== "all").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * The page loader a list screen reads through. count, facets, columns and the admin stats are computed over the
 * account scope and the draft filters only (never the applied filters, search, sort or page), so a read with the
 * draft of the last metadata reuses it and asks the server for rows and total only (the original screen also built
 * its options once per visit). A write re-renders the page with a new remote, which starts over from its initial.
 */
export function reuseCatalogMeta(remote: RemoteCatalog): CatalogPageLoader {
  const { rows } = remote;
  if (!rows) return remote.load;
  let last = { key: draftKey({}), meta: metaOf(remote.initial) };
  return async (query) => {
    const key = draftKey(query.draft);
    if (key === last.key) {
      const meta = last.meta;
      return { ...(await rows(query)), ...meta };
    }
    const page = await remote.load(query);
    last = { key, meta: metaOf(page) };
    return page;
  };
}

/**
 * Korean or English ICU order for a locale or an Accept-Language value (the browser's comparator:
 * Intl.Collator's locale on the client, the request's first language on the server).
 */
export function collationOf(locale: string | null | undefined): "ko" | "en" {
  return (locale ?? "").trim().toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** The first page came from the server with `initial.collation`; read it again only when the browser sorts otherwise. */
export function rereadAfterHydration(initial: Pick<CatalogPage, "collation">, collation: "ko" | "en"): boolean {
  return (initial.collation ?? "en") !== collation;
}

/** maxLimit: CATALOG_PAGE_LIMIT_MAX for page reads with metadata, CATALOG_ROWS_LIMIT_MAX (default) for rows-only reads. */
export function catalogPageQuery(input: CatalogPageQuery, maxLimit: number = CATALOG_ROWS_LIMIT_MAX): Required<CatalogPageQuery> {
  const q = { filters: {}, draft: {}, search: "", sort: "depth1" as CatalogSort, asc: true, offset: 0, limit: 50, collation: "en" as const, market_labels: {}, ...input };
  if (!CATALOG_SORTS.includes(q.sort) || !Number.isInteger(q.offset) || q.offset < 0 || q.offset > 10_000_000 ||
      !Number.isInteger(q.limit) || q.limit < 1 || q.limit > maxLimit || !["ko", "en"].includes(q.collation) ||
      typeof q.search !== "string" || q.search.length > 5000 || typeof q.asc !== "boolean") throw new Error("Invalid catalog page query");
  for (const values of [q.filters, q.draft]) {
    if (!values || Object.entries(values).some(([key, value]) =>
      !["listType", "depth1", "depth2", "depth3", "depth4", "funnel", "presence", "kind", "market", "lang", "status", "view"].includes(key) ||
      typeof value !== "string" || value.length > 5000)) throw new Error("Invalid catalog filters");
  }
  return q;
}

/**
 * Only an explicit export loads all matching pages. A failed page rejects the entire export.
 * pageSize: rows per read (500, or up to CATALOG_ROWS_LIMIT_MAX through a rows-only reader); the rows and
 * their order are the same for any size (offset pages over one server order).
 */
export async function exportCatalogPages(load: CatalogRowsLoader, query: CatalogPageQuery, pageSize = 500): Promise<StandardCatalogRow[]> {
  const rows: StandardCatalogRow[] = [];
  const seen = new Set<string>();
  let expected: number | undefined;
  for (let offset = 0; ; offset += pageSize) {
    const page = await load({ ...query, offset, limit: pageSize });
    expected ??= page.total;
    if (page.offset !== offset || page.total !== expected) throw new Error("Catalog changed during export; retry");
    for (const row of page.rows) {
      if (seen.has(row.id)) throw new Error("Catalog changed during export; retry");
      seen.add(row.id);
      rows.push(row);
    }
    if (rows.length === expected) return rows;
    if (page.rows.length !== pageSize) throw new Error("Incomplete catalog export");
  }
}
