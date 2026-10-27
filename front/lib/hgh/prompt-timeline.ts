import "server-only";
import type { PromptAuditLogView } from "@/lib/db/repositories/prompt-audit-logs";
import type { PromptAuditChanges } from "@/lib/standards/audit";
import type { components } from "./api-types";
import { hghGet } from "./client";
import { todayKst } from "./query";

// One prompt's change timeline on the backend (the read-only timeline action of /standard/prompts and
// the admin catalog, (dash)/standard/prompts/_actions.ts):
//   promptAuditLogRepository.listForPrompt(id) GET /v1/prompts/history?prompt_id&from=2000-01-01
//                                               &to=today KST (no window, as legacy; limit 100);
//                                               admin catalog place (G7): GET /v1/admin/catalog/
//                                               prompts/{id}/history (no window, limit 100)
// History row id = String(audit_id) (backend integer); legacy = the audit uuid. Only a React key.

export type ApiHistoryRow = components["schemas"]["HistoryRow"];

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** jsonb {field: {old, new}} -> PromptAuditChanges (values as strings, as the legacy writer stored them). */
export function toAuditChanges(changes: ApiHistoryRow["changes"]): PromptAuditChanges {
  const out: PromptAuditChanges = {};
  for (const [field, v] of Object.entries(changes ?? {})) {
    const pair = (v ?? {}) as { old?: unknown; new?: unknown };
    out[field] = { old: str(pair.old), new: str(pair.new) };
  }
  return out;
}

/** HistoryRow -> PromptAuditLogView. */
export function toAuditView(r: ApiHistoryRow): PromptAuditLogView {
  return {
    id: String(r.audit_id),
    promptId: r.prompt_id,
    actorId: r.actor_id ?? null,
    actorType: r.actor_type,
    eventType: r.event_type,
    changes: toAuditChanges(r.changes),
    batchId: r.batch_id ?? null,
    createdAt: new Date(r.created_at),
    actorEmail: r.actor_email ?? null,
    promptText: r.prompt_text ?? null,
    promptBrand: r.prompt_brand ?? null,
  };
}

/** Legacy timeline has no period: from/to are always sent, else the backend applies 90 days. */
export const TIMELINE_FROM = "2000-01-01";

/** One prompt's timeline (latest 100), for the read-only action. */
export async function fetchPromptTimelineApi(promptId: string, today: string = todayKst()): Promise<PromptAuditLogView[]> {
  const res = await hghGet("/v1/prompts/history", {
    query: { surface: "global", prompt_id: promptId, from: TIMELINE_FROM, to: today, limit: 100 },
    retryOn401: true,
  });
  return res.data.items.map(toAuditView);
}

/**
 * One prompt's timeline for the admin catalog place (latest 100, no window, deleted prompts
 * included): the admin-only route, gated by admin + the admin menu group (backend request U8-7).
 */
export async function fetchAdminPromptTimelineApi(promptId: string): Promise<PromptAuditLogView[]> {
  const res = await hghGet("/v1/admin/catalog/prompts/{prompt_id}/history", {
    pathParams: { prompt_id: promptId },
    query: { limit: 100 },
    retryOn401: true,
  });
  return res.data.items.map(toAuditView);
}
