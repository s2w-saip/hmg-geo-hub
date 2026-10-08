/** Confirmed chunks are separate from the failed/unattempted remainder.
 * A failed response can be ambiguous: reapplying the same field value is idempotent. */
export type BulkFieldResult =
  | { ok: true; value: { count: number } }
  | { ok: false; error: string; progress?: { appliedIds: string[]; remainingIds: string[] } };
