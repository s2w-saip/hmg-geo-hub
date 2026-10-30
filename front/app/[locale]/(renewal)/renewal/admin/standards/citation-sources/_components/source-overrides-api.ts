// Admin › 인용 출처 분류 (2026-10-30): the shapes the BFF answers (back/bff/hub_stores/source_overrides.py) and the
// browser's calls through /api/hub/source-overrides (app/api/hub/source-overrides/[[...rest]]/route.ts).

/** The layer that decided a source's category: Gold's dim_source.category_src, or the HUB's active correction. */
export const SOURCE_LAYERS = ["override", "social", "owned", "seed", "rule", "fallback"] as const;
export type SourceLayer = (typeof SOURCE_LAYERS)[number];

/** applied / pending: whether Gold applies the HUB's decision yet; upstream: Gold applies a correction the HUB does not have. */
export const SYNC_STATES = ["applied", "pending", "upstream"] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export interface SourceOverride {
  /** gold.dim_category slug */
  category: string;
  /** shown only (the original screen had no note input) */
  note: string | null;
  /** cleared = reverted: the row stays, the published list leaves it out */
  status: "active" | "cleared";
  /** gold_import = the first values taken from Gold, hub = set on this screen */
  origin: "gold_import" | "hub";
  createdAt: string;
  updatedAt: string;
}

export interface SourceRow {
  /** Gold's source key as Gold spells it (a social account keeps its case) */
  skey: string;
  /** the key the HUB stores and sends back: lower case, no leading www. */
  key: string;
  domain: string;
  isSocial: boolean;
  /** citations in Gold's latest global round */
  citations: number;
  /** the category the row means now: the HUB's active correction, else Gold's */
  category: string;
  source: SourceLayer;
  /** Gold's own values (null: Gold has no such source) */
  gold: { category: string | null; source: SourceLayer | null } | null;
  override: SourceOverride | null;
  state: SyncState | null;
  /** an active correction over a source Gold marks as an own (HMG) domain */
  shadowsOwned: boolean;
}

export interface SourceCategory {
  slug: string;
  name: string;
}

export interface SourceListing {
  /** the round the citation counts come from (YYYY-MM-DD) */
  asOf: string | null;
  limit: number;
  categories: SourceCategory[];
  items: SourceRow[];
  /** the list the external API serves (reference family source_override) */
  published: { version: number; items: number; changeSeq: number; recordedAt: string } | null;
}

export interface SourceEvent {
  id: number;
  skey: string;
  action: "import" | "set" | "clear";
  at: string;
  actor: { login: string; displayName: string | null } | null;
  /** field -> [before, after] */
  changes: Record<string, [unknown, unknown]>;
  /** change_seq of the published list the change went out in (null: the list did not change) */
  publishedSeq: number | null;
}

export interface SourceHistory {
  skey: string | null;
  override: SourceOverride | null;
  history: SourceEvent[];
}

export interface SourceWritten {
  skey: string;
  override: SourceOverride | null;
  published: { version: number; changeSeq: number } | null;
}

export class SourceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: { fields?: string[] },
  ) {
    super(code);
  }
}

async function call<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api/hub/source-overrides${path}`, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; details?: SourceRequestError["details"] } } | null;
  if (!res.ok || !json?.data) throw new SourceRequestError(res.status, json?.error?.code ?? "failed", json?.error?.details);
  return json.data;
}

export const sourceApi = {
  list: () => call<SourceListing>(""),
  history: (key: string) => call<SourceHistory>(`/history?skey=${encodeURIComponent(key)}`),
  set: (key: string, category: string) => call<SourceWritten>("", "POST", { skey: key, category }),
  clear: (key: string) => call<SourceWritten>("/clear", "POST", { skey: key }),
};
