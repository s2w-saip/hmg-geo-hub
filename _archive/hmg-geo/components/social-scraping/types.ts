// Shared types for the Social Research (social-scraping) flow.
//
// This mirrors a *simplified* slice of scope's EnrichedContextMatrix
// (see docs/social-scraping-screen-design.md §6-1) — enough to drive the
// 구매 맥락 지도 (Purchase Context Map) UI without the full measurement
// engine. The real matrix arrives via scope; until then the view runs on
// the fake fixtures in `sample-data.ts`.

export type Perspective = "buyer" | "seller" | "neutral";

export type Strength = "high" | "medium" | "low";

export type PerspectiveBreakdown = {
  buyer: number;
  seller: number;
  neutral: number;
};

export type EvidenceQuote = {
  quote: string;
  sourceTitle: string;
  sourceUrl: string;
  perspective: Perspective;
};

// ─── Buyer Context side (좌, teal) ────────────────────────────────────────
export type ContextTheme = {
  id: string;
  name: string;
  description: string;
};

export type BuyerContext = {
  id: string;
  themeId: string;
  name: string; // 예: "다자녀 가구"
  mentionCount: number;
  perspective: PerspectiveBreakdown;
  sourceDomains: Record<string, number>;
  evidenceQuotes: EvidenceQuote[];
};

// ─── Purchase Condition side (우, amber) ──────────────────────────────────
export type ConditionCategory = {
  id: string;
  name: string;
  description: string;
};

export type PurchaseCondition = {
  id: string;
  categoryId: string;
  name: string; // 예: "3열 풀사이즈"
  mentionCount: number;
  perspective: PerspectiveBreakdown;
  sourceDomains: Record<string, number>;
  evidenceQuotes: EvidenceQuote[];
  relatedConditionIds: string[];
};

// context → condition ("이 맥락이 이 조건을 유발한다")
export type DriveRelation = {
  contextId: string;
  conditionId: string;
  strength: Strength;
};

// condition ↔ condition ("동시에 고려되는 조건 세트")
export type Combination = {
  id: string;
  conditionIds: [string, string];
  frequency: Strength;
  description: string;
  coOccurrenceCount: number;
  totalSpeakers: number;
  justification: string; // 예: "120명 중 41명 (34%)"
  sourceUrls: string[];
};

export type MatrixStats = {
  contexts: number;
  conditions: number;
  relationships: number;
  sources: number;
  workers: number;
  cost: number; // USD
};

export type ContextMatrix = {
  keyword: string;
  themes: ContextTheme[];
  contexts: BuyerContext[];
  categories: ConditionCategory[];
  conditions: PurchaseCondition[];
  drives: DriveRelation[];
  combinations: Combination[];
  stats: MatrixStats;
};

// ─── Graph selection ──────────────────────────────────────────────────────
export type GraphSelection =
  | { kind: "context"; id: string }
  | { kind: "condition"; id: string }
  // Carries the row it was opened from: there is no loaded matrix to look a
  // combination up in once the tables are paged, and a combination has no
  // evidence of its own to fetch.
  | {
      kind: "combination";
      id: string;
      label: string;
      condAId: string;
      condAName: string;
      condBId: string;
      condBName: string;
      coOccurrenceCount: number;
    }
  | null;

// ─── EXPLORING simulation (fake live streaming) ───────────────────────────
export type WorkerStatus = "searching" | "analyzing" | "completed";

export type ActivityLogKind =
  | "wave"
  | "reasoning"
  | "search"
  | "discover"
  | "worker"
  | "confirmation"
  | "complete";

export type ActivityLogEntry = {
  id: string;
  kind: ActivityLogKind;
  title: string;
  detail?: string;
};

// One scripted timeline event. The exploring view folds a growing prefix of
// these into a snapshot on each timer tick — a deterministic stand-in for the
// real SSE stream (docs/social-scraping-screen-design.md §5).
export type ExploringStep =
  | { kind: "wave"; wave: number; strategy: string }
  | {
      kind: "dispatch";
      workerId: string;
      wave: number;
      label: string;
      query: string;
    }
  | { kind: "sources"; workerId: string; sourceCount: number }
  | { kind: "complete"; workerId: string }
  | {
      kind: "log";
      logKind: Exclude<ActivityLogKind, "wave">;
      title: string;
      detail?: string;
    }
  | { kind: "cost"; cost: number; firecrawl: number };

export type ExploringWorker = {
  id: string;
  wave: number;
  label: string;
  query: string;
  status: WorkerStatus;
  sourceCount: number;
};

export type ExploringSnapshot = {
  waves: { wave: number; strategy: string }[];
  workers: ExploringWorker[];
  log: ActivityLogEntry[];
  cost: number;
  firecrawl: number;
  sources: number;
};

// ─── Prompt candidate bridge (구매 맥락 지도 → 프롬프트 후보 풀) ─────────────
// Mirrors prompt_candidates (source = 'social_scraping') + the generate-prompts
// columns from §6-3. Each row is a consumer question derived from the matrix.
export type PromptLayer = "L1-context" | "L2-condition" | "L3-intersection";
export type FunnelStage = "awareness" | "consideration" | "purchase";

export type GeneratedPrompt = {
  id: string;
  question: string;
  layer: PromptLayer;
  funnelStage: FunnelStage;
  // human-readable provenance (context / condition names)
  sourceLabel: string;
  // 0-100 priority blending mention rate + evidence count
  priority: number;
  // User removed this row from the catalog. Kept in the per-project cache
  // (not hard-deleted) so its seed id stays in the "더 생성" exclude set —
  // otherwise the same seed would resurface on the next batch.
  removed?: boolean;
  // Most similar existing text in the project (registered prompt or candidate
  // pool) when it clears the similarity threshold. Computed at read time
  // (lib/social-scraping/similarity.ts) — never persisted.
  similarTo?: { text: string; score: number; kind: "prompt" | "candidate" } | null;
  // "composed" = the user hand-picked the seeds (구성 flow). Absent = auto
  // batch (initial generation / "더 생성"). Persisted in the cache blob so the
  // distinction survives revisits; the catalog renders it as a badge.
  origin?: "composed";
};

// ─── Paged query surface (openspec 2026-07-15-add-context-map-query) ───────
//
// The context map moved from "one Top-350 bundle per page visit" to page-sized
// server queries. The old ContextMatrix carried evidence + domains for every
// entity up front, which is what dominated wire time (3.9s of 6.4s per the
// scope-context-map.ts measurement). These list rows are deliberately THIN:
// detail (quotes / domains / linked conditions) is fetched only when a row's
// dialog opens — see ContextEntityDetail.

export type ContextSortDir = "asc" | "desc";

export type ContextListSort = "name" | "mentions";
export type ConditionListSort = "name" | "mentions";
export type CombinationListSort = "cooccurrence";

export type ContextMapQuery<S extends string> = {
  /** Free-text match on the entity's canonical name. Empty/omitted = no filter. */
  search?: string;
  sort: S;
  dir: ContextSortDir;
  /** 0-based. */
  page: number;
  size: number;
};

export type Paged<T> = {
  rows: T[];
  /** Rows matching the query across the WHOLE corpus — not this page, and not
   *  a capped subset. The UI needs it to say "N results" honestly. */
  total: number;
  page: number;
  size: number;
};

/** Thin context row for the list. No evidence, no domains. */
export type ContextListRow = {
  id: string;
  name: string;
  themeId: string;
  themeName: string;
  mentionCount: number;
  perspective: PerspectiveBreakdown;
  /** How many conditions this context drives. A COUNT aggregate on the list
   *  query — the old code derived it from the fully-loaded drives array, which
   *  a page does not have. */
  linkedCount: number;
};

/** Thin condition row for the list. */
export type ConditionListRow = {
  id: string;
  name: string;
  categoryId: string;
  mentionCount: number;
  perspective: PerspectiveBreakdown;
  /** How many contexts drive this condition. */
  linkedCount: number;
};

/** Thin combination row. Names are JOINed in — the old code resolved them from
 *  a Map of all 200 conditions, which only worked because nothing was paged. */
export type CombinationListRow = {
  id: string;
  condAId: string;
  condAName: string;
  condBId: string;
  condBName: string;
  coOccurrenceCount: number;
  frequency: Strength;
};

/** Whole-corpus payload behind the "Excel 내보내기" button — the same three
 *  list-tab row shapes, unpaged. Detail (quotes/domains/links) is deliberately
 *  out: it would turn one export into a per-entity fan-out. */
export type ContextMapExportData = {
  contexts: ContextListRow[];
  conditions: ConditionListRow[];
  combinations: CombinationListRow[];
};

/** Fetched when a row's detail dialog opens — never as part of a list. */
export type ContextEntityDetail = {
  id: string;
  name: string;
  mentionCount: number;
  perspective: PerspectiveBreakdown;
  evidenceQuotes: EvidenceQuote[];
  sourceDomains: Record<string, number>;
  /** For a context: the conditions it drives. For a condition: the contexts
   *  driving it. Each with the co-mention strength. */
  linked: Array<{ id: string; name: string; strength: Strength }>;
};

/** Corpus-wide totals for the header. Cheap aggregate, unchanged. */
export type ContextMapStats = {
  contexts: number;
  conditions: number;
  /** drives + combinations. Two different edge kinds are summed into the one
   *  "관계" figure the header shows, which is why the parts are carried too —
   *  the header tooltip breaks them out instead of leaving the reader to guess
   *  why 관계 ≠ the 조합 패턴 tab's row count. */
  relationships: number;
  /** 맥락 → 조건 edges (scope_context_drives). Detail-dialog only in the UI. */
  drives: number;
  /** 조건 ↔ 조건 co-occurrence pairs — this IS the 조합 패턴 tab's total. */
  combinations: number;
  /** DISTINCT host over scope_context_domains — domains, not documents. */
  sources: number;
};

/** Top-N signal pool for prompt generation. Thin — no evidence/domains.
 *  Separate from the list surface because seeding wants "the strongest N",
 *  which paging cannot express (openspec design.md D2). */
export type ContextSeedPool = {
  contexts: Array<{ id: string; name: string; mentionCount: number }>;
  conditions: Array<{ id: string; name: string; mentionCount: number }>;
  combinations: Array<{
    condAId: string;
    condAName: string;
    condBId: string;
    condBName: string;
    coCount: number;
  }>;
  /** context→condition co-mention. Only used as the L3 fallback when the
   *  combination pool is exhausted — kept so seeding behaviour is unchanged. */
  drives: Array<{
    contextId: string;
    contextName: string;
    conditionId: string;
    conditionName: string;
    strength: Strength;
  }>;
};
