import "server-only";
import { getDb } from "@/lib/db";
import { bffAuditLogs, type BffAuditLogRow } from "@/lib/db/schema";

// Append-only sink for the BFF audit trail (spec 2026-07-23-add-bff-audit-sink).
// v1 exposes INSERT only — there is deliberately NO read method: retention is
// indefinite and there is no query UI yet (approved scope). Reads (an admin
// audit viewer, exports) are a future change and will add their own methods.
//
// Callers are lib/audit.ts's fire-and-forget dispatch; the action layer owns
// the authorisation decision, this repo only persists. Inserts here are NOT
// audited themselves (no recursion — enforced by lib/audit.ts calling the repo
// directly, never routing back through auditDataAccess).

export type BffAuditKind = "scope_call" | "data_access";

export interface BffAuditLogInsert {
  actorId: string;
  actorRole: string;
  kind: BffAuditKind;
  action: string;
  /** data_access: the table touched. scope_call: null. */
  target?: string | null;
  /** scope_call: ScopeFilter snapshot. Otherwise null. */
  detail?: unknown;
}

export interface BffAuditLogRepository {
  insert(input: BffAuditLogInsert): Promise<BffAuditLogRow>;
}

export const bffAuditLogRepository: BffAuditLogRepository = {
  async insert(input) {
    const inserted = await getDb()
      .insert(bffAuditLogs)
      .values({
        actorId: input.actorId,
        actorRole: input.actorRole,
        kind: input.kind,
        action: input.action,
        target: input.target ?? null,
        detail: input.detail ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error("bffAuditLogRepository.insert: no row returned");
    }
    return row;
  },
};
