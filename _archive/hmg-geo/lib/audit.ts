import "server-only";
import { after } from "next/server";
import type { User } from "./auth/types";
import type { ScopeFilter } from "./scope/types";
import {
  bffAuditLogRepository,
  type BffAuditLogInsert,
} from "./db/repositories/bff-audit-logs";

// Real append-only audit sink (spec 2026-07-23-add-bff-audit-sink) — replaces
// the former console PLACEHOLDER. Rows land in `bff_audit_logs`.
//
// SEMANTICS (approved): fire-and-forget. Both functions stay synchronous `void`
// so callers (lib/scope/server.ts::enforce + 4 data-access sites) are unchanged
// — the write is dispatched AFTER the response via next/server's `after()` and
// never adds latency to, nor can fail, the user request. If the sink write
// itself fails, the original payload is emitted to console.error (no silent
// loss); it never throws back into the caller.

// Per-user attribution for scope API calls (access-control spec). The single
// workspace key can't distinguish callers at scope, so we record who initiated
// each call.
export function auditScopeCall(
  user: User,
  action: string,
  filter: ScopeFilter,
): void {
  dispatch({
    kind: "scope_call",
    actorId: user.id,
    actorRole: user.role,
    action,
    target: null,
    detail: filter, // ScopeFilter snapshot
  });
}

// Audit for hmg-geo's own DB access (data-access-security). Without RLS the app
// layer is the only guard, so record who touched what.
export function auditDataAccess(
  user: Pick<User, "id" | "role">,
  table: string,
  action: string,
): void {
  dispatch({
    kind: "data_access",
    actorId: user.id,
    actorRole: user.role,
    action,
    target: table,
    detail: null,
  });
}

// Fire-and-forget dispatch. `after()` defers the write until the response is
// sent (the request path pays nothing). Outside a request context (background
// jobs, or anywhere `after()` is unsupported) `after()` throws synchronously —
// we catch and fire the write immediately instead (still not awaited). Either
// path routes through `persist`, which never throws.
//
// ⚠️ The callback MUST return the promise. `after()` keeps the serverless
// instance alive only for the promise it is handed; a callback that returns
// `undefined` (the former `() => { void persist(row) }`) tells Vercel the
// after-work is already done, and the instance is then suspended *mid-INSERT*.
// The frozen VM never closes its socket, so the pooler never returns the server
// connection and Postgres leaves the backend wedged at `ClientRead` holding
// RowExclusiveLock on bff_audit_logs — `statement_timeout` does not reclaim it
// (it only counts execution time). 2026-08-27 production: 7 backends stuck this
// way, the oldest for 1,165s. Returning the promise is what makes `after()`
// (waitUntil) actually cover the write.
//
// Awaiting is safe: `persist` catches its own errors, and `after()` runs after
// the response, so this adds no user-visible latency and cannot fail a request.
function dispatch(row: BffAuditLogInsert): void {
  try {
    after(() => persist(row));
  } catch {
    // No request scope to attach to — nothing can keep the process alive here.
    void persist(row);
  }
}

async function persist(row: BffAuditLogInsert): Promise<void> {
  try {
    await bffAuditLogRepository.insert(row);
  } catch (err) {
    // Sink failure must be neither silent nor fatal: emit the original payload
    // to console.error (the only remaining fallback) and swallow the error.
    console.error(
      "[bff-audit] sink write failed — falling back to console",
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: row.kind,
        actor: row.actorId,
        role: row.actorRole,
        action: row.action,
        target: row.target ?? null,
        detail: row.detail ?? null,
      }),
      err,
    );
  }
}
