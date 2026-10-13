export type ProjectPageQuery = { offset?: number; limit?: number; sort?: string; direction?: "asc" | "desc" | null; collation?: "en" | "ko"; ids_only?: boolean; include_values?: boolean };
/** values = project-wide tag value suggestions; empty when read with include_values=false (reuseProjectValues fills it). */
export type ProjectRowsPage<T> = { rows: T[]; ids: string[]; total: number; offset: number; limit: number; show_brand: boolean; show_category: boolean; draft_count: number; values: Record<string, string[]> };
export type RemoteProjectRows<T> = { initial: ProjectRowsPage<T>; load: (query: ProjectPageQuery) => Promise<ProjectRowsPage<T>>; selectAll?: () => Promise<string[]> };
export function projectPageQuery(input: ProjectPageQuery): Required<ProjectPageQuery> {
  const q = { offset: 0, limit: 200, sort: "", direction: null, collation: "en" as const, ids_only: false, include_values: true, ...input };
  if (!Number.isInteger(q.offset) || q.offset < 0 || q.offset > 10_000_000 || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 500 ||
    typeof q.sort !== "string" || q.sort.length > 36 || ![null, "asc", "desc"].includes(q.direction) || !["en", "ko"].includes(q.collation) || typeof q.ids_only !== "boolean" ||
    typeof q.include_values !== "boolean") throw new Error("Invalid project page query");
  return q;
}

/**
 * The prompt list's page loader. The tag value suggestions (values) are project-wide, the same for every page and
 * sort, so reads after the server render skip that aggregation and carry the render's values. A write re-renders
 * the page with a new remote (fresh values); the list also adds the values of its rows on screen.
 */
export function reuseProjectValues<T>(remote: RemoteProjectRows<T>): RemoteProjectRows<T>["load"] {
  const { values } = remote.initial;
  return async (query) => ({ ...(await remote.load({ ...query, include_values: false })), values });
}
