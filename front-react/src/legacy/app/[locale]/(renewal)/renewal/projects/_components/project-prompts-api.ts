
import { browserFetch as fetch } from "~/api/browser-fetch";
// Project › Prompt (2026-11-03): the browser's writes for a project's prompts and tags through /api/hub/projects/<pid>/…
// (back/bff/hub_stores/project_prompts.py). The HUB owns them (admin-todo decision '프로젝트 프롬프트 적재'); a change reaches
// the numbers after the pipeline reads it and Gold is rebuilt.
import { SourceRequestError } from "../../admin/standards/citation-sources/_components/source-overrides-api";

/** draft: added here, not sent for measurement · active · paused: measurement stop asked · archived: deleted · removed: left Gold */
export const PROMPT_STATUSES = ["active", "draft", "paused", "archived", "removed"] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];
/** the statuses whose values can change */
export const LIVE_STATUSES: readonly PromptStatus[] = ["draft", "active", "paused"];
/** The BFF's comparison with Gold; only `upstream` (only Gold has it) is used: no screen says whether an input reached the numbers (user 2026-11-06). */
export type PromptState = "draft" | "applied" | "pending" | "upstream";
export type PromptAction = "pause" | "resume" | "archive" | "restore";

export interface PromptHistoryEvent {
  version: number;
  event: "created" | "updated" | "paused" | "resumed" | "activated" | "archived" | "restored" | "removed";
  /** field → old / new; a tag as `tag:<field id>` */
  changes: Record<string, { old: string | null; new: string | null }>;
  recordedAt: string;
  recordedBy: string | null;
  actor: { login: string; displayName: string | null } | null;
}

async function call<T>(pid: string, path: string, method: "GET" | "POST" = "POST", body?: unknown): Promise<T> {
  const res = await fetch(`/api/hub/projects/${pid}/${path}`, {
    method,
    cache: "no-store",
    headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; details?: { fields?: string[] } } } | null;
  if (!res.ok || !json?.data) throw new SourceRequestError(res.status, json?.error?.code ?? "failed", json?.error?.details);
  return json.data;
}

export const projectPromptApi = {
  add: (pid: string, text: string) => call<{ created: string[]; skipped: string[] }>(pid, "prompts", "POST", { text }),
  edit: (pid: string, id: string, input: { expectedVersion: number; text?: string; kind?: "single" | "acr"; language?: string | null }) =>
    call<{ changed: boolean }>(pid, `prompts/${id}`, "POST", input),
  act: (pid: string, id: string, action: PromptAction, expectedVersion: number) =>
    call<{ changed: boolean }>(pid, `prompts/${id}/${action}`, "POST", { expectedVersion }),
  history: (pid: string, id: string) => call<{ history: PromptHistoryEvent[] }>(pid, `prompts/${id}/history`, "GET"),
  tag: (pid: string, promptIds: string[], fieldId: string, value: string | null) =>
    call<{ changed: string[]; unchanged: number }>(pid, "prompt-tags", "POST", { promptIds, fieldId, value }),
  addField: (pid: string, label: string) => call<{ field: { id: string; label: string } }>(pid, "prompt-fields", "POST", { label }),
  fieldStatus: (pid: string, fieldId: string, archive: boolean) =>
    call<{ changed: boolean }>(pid, `prompt-fields/${fieldId}/${archive ? "archive" : "restore"}`, "POST", {}),
};

/** The error codes the page names; anything else reads as a failure. */
export const PROMPT_ERRORS = [
  "version_conflict",
  "duplicate",
  "not_draft",
  "not_editable",
  "invalid_status",
  "reserved_label",
  "unknown_code",
  "invalid_value",
  "not_found",
  "forbidden",
  "unauthorized",
  "source_unavailable",
] as const;

export function errorCode(e: unknown): (typeof PROMPT_ERRORS)[number] | "failed" {
  const code = e instanceof SourceRequestError ? e.code : "failed";
  return (PROMPT_ERRORS as readonly string[]).includes(code) ? (code as (typeof PROMPT_ERRORS)[number]) : "failed";
}
