// Global prompt editing (2026-10-27): the shapes the BFF answers (back/bff/hub_stores/catalog_editor.py)
// and the browser's calls through /api/hub/global-prompts (app/api/hub/global-prompts/[[...rest]]/route.ts).

export type HubOrigin = "hub" | "gold";
// removed: a Gold prompt that left Gold (sync_catalog.py records it after two runs miss it); read-only.
export type HubStatus = "active" | "archived" | "removed";
export type HubKind = "single" | "acr";

export const LABEL_FIELDS = ["funnel", "brandPresence", "listType", "depth1", "depth2", "depth3", "depth4"] as const;
export type LabelField = (typeof LABEL_FIELDS)[number];

export type HubPrompt = {
  id: string;
  origin: HubOrigin;
  editable: boolean;
  version: number;
  text: string;
  kind: HubKind;
  language: string | null;
  regions: string[];
  status: HubStatus;
  recordedAt: string;
  registeredAt: string;
} & Record<LabelField, string | null>;

export interface HubPromptPage {
  items: HubPrompt[];
  page: { total: number; limit: number; offset: number };
  counts: { total: number; hub: number; gold: number; archived: number; removed: number };
}

export interface HubOption {
  value: string;
  count: number;
}

/** A depth code under its parents (depth2 under [depth1], depth3 under [depth1, depth2]), as Gold records them. */
export interface HubTaxon {
  field: "depth1" | "depth2" | "depth3" | "depth4";
  code: string;
  path: string[];
}

export type HubOptions = { kinds: HubKind[]; language: HubOption[]; regions: HubOption[]; taxonomy: HubTaxon[] } & Record<LabelField, HubOption[]>;

export interface HubHistoryEvent {
  version: number;
  event: "created" | "updated" | "archived" | "removed" | "restored";
  changes: Record<string, { old: unknown; new: unknown }>;
  recordedAt: string;
  recordedBy: string | null;
  actor: { login: string; displayName: string | null } | null;
}

export interface HubPromptDetail {
  item: HubPrompt;
  history: HubHistoryEvent[];
}

/** The form's fields ("" = unset); `toBody` turns them into the BFF's input. */
export type Draft = { text: string; kind: HubKind; language: string; regions: string[] } & Record<LabelField, string>;

export function draftOf(item: HubPrompt | null): Draft {
  const labels = Object.fromEntries(LABEL_FIELDS.map((f) => [f, item?.[f] ?? ""])) as Record<LabelField, string>;
  return { text: item?.text ?? "", kind: item?.kind ?? "single", language: item?.language ?? "", regions: item?.regions ?? [], ...labels };
}

export function toBody(d: Draft) {
  const labels = Object.fromEntries(LABEL_FIELDS.map((f) => [f, d[f].trim() || null]));
  return {
    text: d.text.trim(),
    kind: d.kind,
    language: d.language.trim() || null,
    regions: d.regions,
    ...labels,
  };
}

export class HubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: { fields?: string[]; currentVersion?: number; promptId?: string },
  ) {
    super(code);
  }
}

async function call<T>(path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api/hub/global-prompts${path}`, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; details?: HubRequestError["details"] } } | null;
  if (!res.ok || !json?.data) throw new HubRequestError(res.status, json?.error?.code ?? "failed", json?.error?.details);
  return json.data;
}

export const hubApi = {
  /** `search` = listSearch() of hub-prompt-filter-model.ts */
  list: (search: string) => call<HubPromptPage>(`?${search}`),
  detail: (id: string) => call<HubPromptDetail>(`/${id}`),
  create: (d: Draft) => call<{ item: HubPrompt; changed: boolean }>("", "POST", toBody(d)),
  update: (id: string, version: number, d: Draft) => call<{ item: HubPrompt; changed: boolean }>(`/${id}`, "PUT", { ...toBody(d), expectedVersion: version }),
  setStatus: (id: string, version: number, action: "archive" | "restore") =>
    call<{ item: HubPrompt; changed: boolean }>(`/${id}/${action}`, "POST", { expectedVersion: version }),
};
