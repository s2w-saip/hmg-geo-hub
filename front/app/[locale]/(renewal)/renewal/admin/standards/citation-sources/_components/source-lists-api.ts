// Admin › 인용 출처 분류 › 시드 · 공식 소셜 · 코드표 (2026-10-30): the shapes the BFF answers
// (back/bff/hub_stores/source_lists.py) and the browser's calls through /api/hub/source-seeds · source-socials ·
// source-codes. The HUB owns these lists (admin-todo decisions G · 코드표); Gold's own values come along for the
// comparison only.
import { SourceRequestError, type SourceCategory, type SourceLayer } from "./source-overrides-api";

/** The current set of a family the external API serves. */
export interface ListPublished {
  version: number;
  items: number;
  changeSeq: number;
  recordedAt: string;
}

export interface ListEvent {
  id: number;
  action: string;
  at: string;
  actor: { login: string; displayName: string | null } | null;
  /** field -> [before, after] */
  changes: Record<string, [unknown, unknown]>;
  publishedSeq: number | null;
}

// ─── seeds (family source_seed) ───────────────────────────────────────────────

/** applied: Gold's seed layer has the HUB's category; shadowed: a higher layer (correction, social, owned) decides. */
export const SEED_STATES = ["applied", "pending", "shadowed", "upstream"] as const;
export type SeedState = (typeof SEED_STATES)[number];
export const SEED_STATUSES = ["active", "removed"] as const;
export type SeedStatus = (typeof SEED_STATUSES)[number];

export interface SeedRow {
  /** lower case, no www., no slash */
  skey: string;
  /** the HUB's category (null: an upstream row the HUB does not have) */
  category: string | null;
  note: string | null;
  status: SeedStatus | null;
  origin: "file_import" | "hub" | null;
  updatedAt: string | null;
  /** Gold's own values (null: Gold has no such source, it was never cited) */
  gold: { category: string | null; source: SourceLayer | null; citations: number } | null;
  state: SeedState | null;
}

export interface SeedListing {
  asOf: string | null;
  categories: SourceCategory[];
  items: SeedRow[];
  published: ListPublished | null;
}

export interface SeedWritten {
  skey: string;
  seed: SeedRow | null;
  published: { version: number; changeSeq: number } | null;
}

export interface SeedHistory {
  skey: string | null;
  seed: SeedRow | null;
  history: ListEvent[];
}

// ─── official social accounts (family source_social) ─────────────────────────

export const SOCIAL_STATES = ["applied", "pending", "upstream"] as const;
export type SocialState = (typeof SOCIAL_STATES)[number];

export interface SocialMatcher {
  /** lower case `<domain>/<path>` prefix */
  prefix: string;
  /** true: the prefix must end at a path segment; false: the prefix carries its own separator */
  boundary: boolean;
}

export interface SocialRow {
  /** display key, case kept as Gold shows it */
  key: string;
  /** lower(key): the primary key */
  accountKey: string;
  domain: string;
  matchers: SocialMatcher[];
  note: string | null;
  status: "active" | "stopped" | null;
  origin: "file_import" | "hub" | null;
  updatedAt: string | null;
  gold: { source: SourceLayer | null; citations: number } | null;
  state: SocialState | null;
}

export interface SocialListing {
  items: SocialRow[];
  published: ListPublished | null;
}

export interface SocialWritten {
  key: string;
  account: SocialRow | null;
  published: { version: number; changeSeq: number } | null;
}

export interface SocialHistory {
  key: string | null;
  account: SocialRow | null;
  history: ListEvent[];
}

// ─── code table (family source_code) ─────────────────────────────────────────

export type CodeKind = "category" | "layer";

export interface CodeRow {
  /** category: the slug (gold.dim_category.slug); layer: override · social · owned · seed · rule · fallback */
  code: string;
  /** category: Gold's category_key (answer_fact.cit_c<k>); layer: category_src = priority */
  number: number;
  nameEn: string;
  nameKo: string;
  ord: number;
  description: string | null;
  updatedAt: string | null;
}

export interface CategoryCodeRow extends CodeRow {
  gold: { name: string; ord: number } | null;
  state: "applied" | "pending" | null;
}

export interface CodeListing {
  categories: CategoryCodeRow[];
  layers: CodeRow[];
  published: ListPublished | null;
}

export interface CodeHistory {
  kind: CodeKind | null;
  code: string | null;
  history: ListEvent[];
}

// ─── calls ───────────────────────────────────────────────────────────────────

async function call<T>(base: string, path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api/hub/${base}${path}`, {
    method,
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; details?: SourceRequestError["details"] } } | null;
  if (!res.ok || !json?.data) throw new SourceRequestError(res.status, json?.error?.code ?? "failed", json?.error?.details);
  return json.data;
}

export const seedApi = {
  list: () => call<SeedListing>("source-seeds", ""),
  history: (skey: string) => call<SeedHistory>("source-seeds", `/history?skey=${encodeURIComponent(skey)}`),
  set: (skey: string, category: string) => call<SeedWritten>("source-seeds", "", "POST", { skey, category }),
  remove: (skey: string) => call<SeedWritten>("source-seeds", "/remove", "POST", { skey }),
};

export const socialApi = {
  list: () => call<SocialListing>("source-socials", ""),
  history: (key: string) => call<SocialHistory>("source-socials", `/history?key=${encodeURIComponent(key)}`),
  set: (key: string, matchers: SocialMatcher[]) => call<SocialWritten>("source-socials", "", "POST", { key, matchers }),
  stop: (key: string) => call<SocialWritten>("source-socials", "/stop", "POST", { key }),
  resume: (key: string) => call<SocialWritten>("source-socials", "/resume", "POST", { key }),
};

export const codeApi = {
  list: () => call<CodeListing>("source-codes", ""),
  history: (kind: CodeKind, code: string) =>
    call<CodeHistory>("source-codes", `/history?${new URLSearchParams({ kind, code }).toString()}`),
  set: (kind: CodeKind, code: string, v: { nameEn: string; nameKo: string; description: string | null }) =>
    call<{ kind: CodeKind; code: string; row: CodeRow; published: ListPublished | null }>("source-codes", "", "POST", { kind, code, ...v }),
  order: (codes: string[]) => call<{ categories: CategoryCodeRow[]; published: ListPublished | null }>("source-codes", "/order", "POST", { codes }),
};
