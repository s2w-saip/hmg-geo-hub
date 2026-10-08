export type ProjectPageQuery = { offset?: number; limit?: number; sort?: string; direction?: "asc" | "desc" | null; collation?: "en" | "ko"; ids_only?: boolean };
export type ProjectRowsPage<T> = { rows: T[]; ids: string[]; total: number; offset: number; limit: number; show_brand: boolean; show_category: boolean; draft_count: number; values: Record<string, string[]> };
export type RemoteProjectRows<T> = { initial: ProjectRowsPage<T>; load: (query: ProjectPageQuery) => Promise<ProjectRowsPage<T>>; selectAll?: () => Promise<string[]> };
export function projectPageQuery(input: ProjectPageQuery): Required<ProjectPageQuery> {
  const q = { offset: 0, limit: 200, sort: "", direction: null, collation: "en" as const, ids_only: false, ...input };
  if (!Number.isInteger(q.offset) || q.offset < 0 || q.offset > 10_000_000 || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 500 ||
    typeof q.sort !== "string" || q.sort.length > 36 || ![null, "asc", "desc"].includes(q.direction) || !["en", "ko"].includes(q.collation) || typeof q.ids_only !== "boolean") throw new Error("Invalid project page query");
  return q;
}
