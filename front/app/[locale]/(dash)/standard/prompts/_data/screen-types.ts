// Payloads of the Global prompts screens (back/bff/screens/standard_prompts.py), shared by
// /standard/prompts and /renewal/standard/prompts. Rows, totals, options, order and pager labels
// come finished from the API; the pages only render them.
import type { CatalogSort } from "@/lib/standards/catalog-page";
import type { PromptAuditLogView } from "@/lib/db/repositories/prompt-audit-logs";

/** The 11 single-choice list filters ("all" = not set). */
export interface FilterState {
  listType: string;
  depth1: string;
  depth2: string;
  depth3: string;
  depth4: string;
  funnel: string;
  presence: string;
  kind: string;
  // 대상 시장 (실국가 또는 지리 의사코드 1개) — 권한 스코프와 무관한 카탈로그 축.
  market: string;
  lang: string;
  // 측정 상태 — measured / unmeasured.
  status: string;
}

/** One catalog row as the list shows it. */
export interface PromptRow {
  id: string;
  text: string;
  brand: string | null;
  brandPresence: string | null;
  listType: string | null;
  depth1: string | null;
  depth2: string | null;
  depth3: string | null;
  depth4: string | null;
  funnelStage: string | null;
  // 측정 종류 ('single' | 'acr')
  kind: string;
  // 대상 시장 원본 (실국가 ISO alpha-2 + `x:` 의사코드). 표시는 markets.
  regions: string[] | null;
  lang: string | null;
  // null = 미측정
  scopePromptId: string | null;
  /** Brand presence class of the row (branded / unbranded / unknown). */
  presence: "branded" | "unbranded" | null;
  /** No brand or the umbrella brand: shown as "공통". */
  common: boolean;
  /** Market codes, normalized and sorted: real countries first, pseudo codes apart (both empty = 전체). */
  markets: { real: string[]; pseudo: string[] };
}

/** One page of the list with the scope's options (screen catalog/prompts-page). */
export interface PromptsPage {
  rows: PromptRow[];
  /** Rows matching the filters and search. */
  total: number;
  /** Rows in the scope. */
  count: number;
  offset: number;
  limit: number;
  page: number;
  pages: number;
  rangeFrom: number;
  rangeTo: number;
  /** listType, depth1–4, funnel, lang, market (filter options), marketSort (every market code). */
  facets: Record<string, string[]>;
  /** Taxonomy columns with a value in the scope. */
  columns: string[];
  collation: "ko" | "en";
}

export interface PromptsQuery {
  filters: FilterState;
  /** The picks the options cascade on (the original list's pending selects). */
  draft: FilterState;
  search: string;
  sort: CatalogSort;
  asc: boolean;
  page: number;
  limit: number;
  collation: "ko" | "en";
  /** Market code -> label, the order of a market sort. */
  marketLabels: Record<string, string>;
}

/** Every row for the same picks, in list order (screen catalog/prompts-export). */
export interface PromptsExport {
  rows: PromptRow[];
  columns: string[];
}

export interface PromptsHeader {
  period: { from: string; to: string } | null;
}

export type AuditRow = Omit<PromptAuditLogView, "createdAt"> & { createdAt: string };

/** The 변경 이력 tab (screen catalog/prompts-history). available = false: the source has no history. */
export interface PromptsHistory {
  available: boolean;
  shown: number;
  groups: { key: string; batchId: string | null; rows: AuditRow[] }[];
}

/** One prompt's change timeline, newest first (screen catalog/prompts-timeline). */
export interface PromptsTimeline {
  available: boolean;
  rows: AuditRow[];
}

export interface HistoryQuery {
  days: "30" | "90";
  event: string;
}

/** The list's first page (server render) and its readers (default: GET /api/standard/prompts/*). */
export interface PromptsRemote {
  initial: PromptsPage;
  load?: (query: PromptsQuery) => Promise<PromptsPage>;
  exportRows?: (query: PromptsQuery) => Promise<PromptsExport>;
}
