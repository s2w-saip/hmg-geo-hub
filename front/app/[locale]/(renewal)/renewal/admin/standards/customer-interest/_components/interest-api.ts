// Admin › 고객 관심 데이터 관리 (2026-11-02): the shapes the BFF answers (back/bff/hub_stores/interest.py) and the browser's
// calls through /api/hub/interest-keywords · interest-sources. The HUB owns these lists (admin-todo decisions A · E);
// Gold's own values come along for the comparison only.
import { call, type ListEvent, type ListPublished } from "../../citation-sources/_components/source-lists-api";

export const INTEREST_BRANDS = ["Hyundai", "Kia", "Genesis"] as const;
export type InterestBrand = (typeof INTEREST_BRANDS)[number];

export interface InterestWritten {
  published: { version: number; changeSeq: number } | null;
}

// ─── keywords (family interest_keyword) ──────────────────────────────────────

/** DataForSEO's location and language, as Gold's seed rows and the external list carry them. */
export interface KeywordCondition {
  location_code: number;
  language_code: string;
}

export const KEYWORD_SOURCES = ["google_keyword", "community_voc"] as const;
export type KeywordSource = (typeof KEYWORD_SOURCES)[number];

/** applied: Gold's seed rows hold every HUB condition; pending: not yet; upstream: Gold's seed the HUB does not have. */
export const KEYWORD_STATES = ["applied", "pending", "upstream"] as const;
export type KeywordState = (typeof KEYWORD_STATES)[number];
export const INTEREST_STATUSES = ["active", "stopped"] as const;
export type InterestStatus = (typeof INTEREST_STATUSES)[number];

export interface KeywordRow {
  term: string;
  termNorm: string;
  /** the HUB's conditions (an upstream row: Gold's) */
  conditions: KeywordCondition[];
  sourceTypes: KeywordSource[];
  /** empty: common to every brand */
  brands: InterestBrand[];
  note: string | null;
  /** null: an upstream row the HUB does not have */
  status: InterestStatus | null;
  origin: "gold_import" | "hub" | null;
  updatedAt: string | null;
  /** Gold's seed rows (null: Gold never collected this term) */
  gold: { conditions: (KeywordCondition & { observedAt: string })[]; observedAt: string } | null;
  /** how many of `conditions` Gold's seed rows hold */
  collected: number;
  state: KeywordState | null;
}

export interface KeywordListing {
  items: KeywordRow[];
  published: ListPublished | null;
}

export interface KeywordInput {
  term: string;
  conditions: KeywordCondition[];
  sourceTypes: KeywordSource[];
  brands: InterestBrand[];
  note: string | null;
}

export interface KeywordHistory {
  term: string | null;
  history: ListEvent[];
}

// ─── community sources (family interest_source) ──────────────────────────────

export const SOURCE_CHANNELS = ["news", "pr", "social", "community"] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

/** A comparison with Gold's active social snapshot: observed / unseen = a HUB source whose host is or is not in it;
 * upstream = a corpus host no HUB source has. */
export const INTEREST_SOURCE_STATES = ["observed", "unseen", "upstream"] as const;
export type InterestSourceState = (typeof INTEREST_SOURCE_STATES)[number];

export interface InterestSourceRow {
  /** lower case, no scheme, no www., no trailing slash */
  key: string;
  /** as entered */
  url: string;
  host: string;
  channel: SourceChannel | null;
  brands: InterestBrand[];
  note: string | null;
  status: InterestStatus | null;
  updatedAt: string | null;
  /** the host in Gold's active snapshot */
  gold: { entities: number; mentions: number } | null;
  state: InterestSourceState | null;
}

export interface InterestSourceListing {
  /** Gold's active social snapshot and its hosts */
  snapshot: { takenAt: string; sources: number } | null;
  items: InterestSourceRow[];
  published: ListPublished | null;
}

export interface InterestSourceInput {
  url: string;
  channel: SourceChannel;
  brands: InterestBrand[];
  note: string | null;
}

export interface InterestSourceHistory {
  key: string | null;
  history: ListEvent[];
}

// ─── calls ───────────────────────────────────────────────────────────────────

export const keywordApi = {
  list: () => call<KeywordListing>("interest-keywords", ""),
  history: (term: string) => call<KeywordHistory>("interest-keywords", `/history?term=${encodeURIComponent(term)}`),
  set: (input: KeywordInput) => call<InterestWritten & { term: string }>("interest-keywords", "", "POST", input),
  stop: (term: string) => call<InterestWritten>("interest-keywords", "/stop", "POST", { term }),
  resume: (term: string) => call<InterestWritten>("interest-keywords", "/resume", "POST", { term }),
};

export const interestSourceApi = {
  list: () => call<InterestSourceListing>("interest-sources", ""),
  history: (url: string) => call<InterestSourceHistory>("interest-sources", `/history?url=${encodeURIComponent(url)}`),
  set: (input: InterestSourceInput) => call<InterestWritten & { key: string }>("interest-sources", "", "POST", input),
  stop: (url: string) => call<InterestWritten>("interest-sources", "/stop", "POST", { url }),
  resume: (url: string) => call<InterestWritten>("interest-sources", "/resume", "POST", { url }),
};
