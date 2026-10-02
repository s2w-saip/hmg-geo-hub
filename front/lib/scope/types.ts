// Single source of truth for the scope data contract. Shapes mirror scope's
// CONFIRMED public API surface (/api/v1/*) — see docs/scope-api-integration.md
// and scope's /openapi/v1.yaml. Fields are snake_case to match scope verbatim;
// we do not re-case at the transport layer.
//
// Scope split: settings (projects/prompts CRUD) + result reads (overview,
// brand-scores, brand-mentions, citations, reports, usage). Measurement
// triggers (/query, /measurements) and the internal /results feed are scope's
// own surface and are intentionally absent here (scope-gateway spec).

// LLM measured by scope. scope's Target enum.
export type ScopeTarget = "chatgpt" | "gemini" | "deepseek" | "perplexity" | "claude";

// Buyer-journey stage. Client may set it explicitly; scope does not auto-classify.
export type FunnelStage =
  | "discovery"
  | "consideration"
  | "evaluation"
  | "transactional"
  | "loyalty";

// ISO 3166-1 alpha-2 country code (e.g. "KR", "US"). NOTE: scope calls this a
// "region". It is a COUNTRY code — it maps to HMG's `countries`, NOT to HMG's
// `regions` bucket (APAC/EU/NA). Keep that distinction or wires cross silently.
export type Region = string;

// --- Server-injected role scope (HMG-side, NOT a scope API shape) ---
// Built ONLY from the authenticated user's role (lib/auth/scope-policy). Never
// populated from client input. Carried for audit attribution and (future)
// role→project gating in lib/scope/server.ts. It is NOT a ScopeClient argument:
// scope's public reads are project-scoped aggregates with no value filters.
export interface ScopeFilter {
  brands?: string[];
  regions?: string[];
  countries?: string[];
}

// --- Common envelope ---

// Cursor-paginated list response. `next_cursor` (opaque) present → pass it back
// as `?cursor=` for the next page.
export interface Paginated<T> {
  data: T[];
  next_cursor?: string | null;
}

// Error envelope returned on non-2xx.
export interface ScopeErrorBody {
  error: {
    code:
      | "invalid_argument"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "rate_limited"
      | "server_error"
      | "service_unavailable";
    message: string;
    details?: Record<string, unknown>;
  };
}

// --- Settings surface: projects ---

export interface TrackedBrand {
  brand_name: string;
  alternative_names?: string[];
  aliases?: string[];
}

export interface Project {
  project_id: string;
  workspace_id: string;
  name: string;
  domain?: string;
  tracked_brands: TrackedBrand[];
  regions: Region[];
  created_at: string;
  updated_at?: string;
}

// Lighter shape returned by the project LIST endpoint.
export interface ProjectSummary {
  project_id: string;
  name: string;
  domain?: string;
  tracked_brands_count?: number;
  regions: Region[];
  prompts_count?: number;
  last_measurement_at?: string | null;
  created_at?: string;
}

export interface CreateProjectInput {
  name: string;
  domain?: string;
  tracked_brands: TrackedBrand[]; // >= 1
  regions: Region[]; // >= 1, ISO alpha-2
}

export interface UpdateProjectInput {
  name?: string;
  domain?: string;
  tracked_brands?: TrackedBrand[];
  regions?: Region[];
}

// --- Settings surface: prompts ---

// 측정 종류 — 'single' = 1턴 단발, 'acr' = 2턴 AI's Choice Rate (반복수는
// 프로젝트 공유 설정 acr_iterations 상속). scope prompts.kind와 동일 enum.
export type PromptKind = "single" | "acr";

export interface Prompt {
  prompt_id: string;
  project_id: string;
  text: string;
  funnel_stage?: FunnelStage | null;
  keywords?: string[];
  kind?: PromptKind;
  /**
   * soft-delete 되지 않았는가. **소등 여부가 아니다** — 목록 응답에서는 늘 true
   * 다(삭제된 행은 애초에 안 나온다).
   */
  active?: boolean;
  /**
   * 측정 대상인가. `active` 와 직교한다 — 소등을 뜻하는 건 이쪽이다.
   * 응답에 두 필드가 나란히 있어서 `UpdatePromptInput` 의 필드명을 `active` 로
   * 잘못 잡는 사고가 났다(아래 주석 참조). 읽을 때도 둘을 헷갈리지 말 것.
   */
  enabled?: boolean;
  /**
   * 시트 언어 코드 (ISO 639-1 대문자 — EN·KO·ES·AR·…). null/미전송 = 미지정.
   * 종전에는 `text ~ '[가-힣]'` 휴리스틱으로 KO/EN 을 갈랐으나 44개 언어
   * 라운드에서 성립하지 않아 컬럼으로 승격됐다 (로컬 migration 0047 ·
   * 미러 0048).
   */
  lang?: string | null;
  /**
   * 측정 대상 시장. 실국가는 ISO 3166-1 alpha-2, 비국가 사이트 슬롯은 `x:`
   * 네임스페이스 의사코드(x:WW·x:EU·x:ME·x:NBRAND·x:CPO — 접두사 없이 쓰면
   * `ME` 가 몬테네그로, `EU` 가 ISO 예약코드와 충돌한다).
   * null/빈 배열 = 스케줄·프로젝트 범위 상속 (scope#474).
   *
   * ⚠️ 여기 있던 것은 **응답 필드**다 — scope 서버는 이미 싣고 있었고
   * (2026-08-29 라이브 확인: 표준 루트 12,012행 중 regions 11,909 · lang 11,902)
   * 뒤처져 있던 것은 이 클라이언트 타입이었다.
   */
  regions?: string[] | null;
  created_at: string;
  updated_at?: string;
}

export interface CreatePromptInput {
  text: string;
  funnel_stage?: FunnelStage;
  keywords?: string[];
  kind?: PromptKind;
  /**
   * 시장·언어는 **미전송 = NULL = 상속**이다. 기존 호출부는 이 두 필드를 보내지
   * 않으므로 동작이 바뀌지 않는다 (추가는 순수 optional).
   */
  regions?: string[] | null;
  lang?: string | null;
}

export interface UpdatePromptInput {
  text?: string;
  funnel_stage?: FunnelStage;
  keywords?: string[];
  kind?: PromptKind;
  /**
   * ⚠️ 필드명은 `enabled` 다 — 예전에 `active` 로 잘못 적혀 있었고, scope 의 zod
   * 스키마(`PromptUpdateSchema`)에 그런 키가 없어 `.partial()` 이 **조용히 무시**했다.
   * 그래서 이 클라이언트로 보낸 소등이 전부 무효였다(2026-08-18 실증: 103 건을
   * `{active:false}` 로 호출해 200·"성공" 을 받았으나 DB 는 `enabled=true` 그대로).
   * 서버가 200 을 주므로 호출부는 성공으로 오인한다 — 소등 후에는 반드시 DB 로 확인할 것.
   */
  enabled?: boolean;
  /**
   * 측정 대상 시장. null/빈 배열 = 스케줄·프로젝트 범위 상속 (scope#474).
   * 어휘는 `Prompt.regions` 주석 참조 (`x:` 의사코드 포함).
   */
  regions?: string[] | null;
  /**
   * 시트 언어 코드. 미전송 = 무변경 — 기존 호출부는 동작이 바뀌지 않는다.
   *
   * ⚠️ **쓰기 경로는 미검증이다.** 읽기(응답에 lang 이 실린다)는 2026-08-29
   * 라이브로 확인했지만, scope 의 `PromptUpdateSchema` 가 이 키를 받는지는
   * 확인하지 않았다. `.partial()` 은 모르는 키를 **200 을 주면서 조용히 무시**한다
   * (`enabled` 를 `active` 로 잘못 적어 103건 소등이 전부 무효였던 2026-08-18
   * 사고와 같은 형태). 이 필드로 쓰기를 하는 첫 호출부(H5 어드민 편집)는
   * 반드시 쓰기 직후 `GET prompts` 로 반영을 확인할 것.
   */
  lang?: string | null;
}

// --- Settings surface: measurement schedule ---
// Mirrors scope GET/PUT /projects/{id}/schedule (1 project = 1 schedule,
// upsert). interval_days drives scope's cadence freshness window
// (interval_days × 24h). Empty targets/regions mean "defer to the project's
// own regions and scope's default targets" at plan time.

export interface ScheduleResponse {
  enabled: boolean;
  interval_days: number;
  targets: string[];
  regions: Region[];
  prompt_ids: string[] | null;
  last_run_at: string | null;
  last_run_status?: string | null;
  next_run_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ScheduleUpdateInput {
  enabled: boolean;
  interval_days: number; // 1..30
  targets: string[];
  regions: Region[];
  prompt_ids?: string[] | null;
}

// --- Result-read surface (scope fills via measurement; HMG reads) ---

export interface ProjectOverview {
  project_name?: string;
  tracked_brands?: TrackedBrand[];
  regions?: Region[];
  last_measurement_at?: string;
  top_brands_by_score?: {
    brand_name?: string;
    comprehensive_score?: number;
    mention_rank?: number;
  }[];
  competitive_landscape?: {
    tracked_brand_position?: number;
    top_co_mentioned?: { brand_name?: string; co_mention_count?: number }[];
  };
  daily_trend?: { date?: string; our_brand_score?: number }[];
}

// Daily aggregate score row (0..100 metrics, nullable when not yet computed).
export interface BrandScore {
  brand_name?: string;
  metric_date?: string;
  region?: Region;
  target?: ScopeTarget;
  presence_score?: number | null;
  prominence_score?: number | null;
  sentiment_score?: number | null;
  intent_score?: number | null;
  comprehensive_score?: number | null;
  presence_multiplier?: number | null;
  mention_rank?: number | null;
  mention_percentile?: number | null;
  share_of_voice?: number | null;
  raw_metrics?: Record<string, unknown>;
  computed_at?: string | null;
}

// A single brand mention in an answer. `co_mentioned_brands` is scope's moat.
export interface BrandMention {
  brand_mention_id?: string;
  brand_name?: string;
  mention_position?: number;
  total_brands_mentioned?: number;
  mention_type?: "recommendation" | "mention" | "comparison" | "listing";
  // scope's LLM semantics pass scores 4 values (2026-07-29); "mixed" reaches the
  // public feed too, so it must not be silently folded into neutral.
  brand_sentiment?: "positive" | "neutral" | "negative" | "mixed";
  mention_context?: string;
  brand_positioning?: string;
  key_points?: string[];
  co_mentioned_brands?: string[];
  region?: Region;
  target?: ScopeTarget;
  ai_model?: string | null;
  measured_at?: string | null;
  prompt_id?: string | null;
  prompt_text?: string | null;
  query_run_id?: string | null;
  measurement_run_id?: string | null;
  is_tracked?: boolean | null;
  extraction_metadata?: Record<string, unknown>;
}

export interface Citation {
  url?: string;
  domain?: string;
  title?: string;
  category?: string;
  subcategory?: string;
  mention_count?: number;
  brands_mentioned?: string[];
  target?: ScopeTarget;
  region?: Region;
  query_run_id?: string;
  measured_at?: string;
}

export interface CitationByDomain {
  domain?: string;
  citation_count?: number;
  brand_count?: number;
  avg_mention_position?: number;
}

// Narrative report. Endpoint pending scope redeploy (currently 404) — shape is
// provisional until the spec is republished.
export interface Report {
  report_id?: string;
  title?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface UsageSummary {
  workspace_id?: string;
  billing_period?: string;
  queries_used?: number;
  queries_quota?: number;
  cost_usd?: number;
  rate_limit?: { per_minute?: number; per_hour?: number };
}

export interface HealthStatus {
  status: string;
  version?: string;
}

// --- REAL measurement-result surface (what scope actually exposes) ----------
// scope's named result endpoints (overview/brand-scores/brand-mentions/...) do
// NOT exist. The live AI-answer data lives in /results (workspace feed),
// /projects/{id}/measurements[/{runId}/jobs] (run lifecycle + per-job analysis),
// and the embedded QueryAnalysisSummary (the only brand-mention carrier).
// These types mirror those shapes verbatim (snake_case). See result-adapter.ts.

// Per-mention rollups added by scope change measurement-llm-sentiment-citation-
// classification. Optional here because pre-backfill responses omit them — the
// adapter detects presence and degrades to a "준비 중" placeholder when absent.
export interface MentionSentimentBreakdown {
  positive: number;
  neutral: number;
  negative: number;
  mixed: number;
}
export interface MentionTypeBreakdown {
  mention: number;
  recommendation: number;
  comparison: number;
  definition: number;
  final_choice: number;
}

// 발생 단위 언급 하나 — 한 답변 원문 안의 특정 구간(문장/절)이 특정 엔티티를
// 어떤 감성으로 언급한 지점. scope#632 ③. 오프셋은 코드포인트 기준.
export interface MentionOccurrence {
  source_start: number; // 코드포인트 기준
  source_end: number;
  surface_text: string;
  sentiment: "positive" | "negative" | "mixed" | "neutral";
  mention_role: string | null;
  assertion: string | null;
  context_snippet: string | null;
  descriptors: string[];
  criteria: string[];
  turn_index: number | null;
}

// A single resolved entity mention inside one answer (GROUP BY entity_id).
export interface ResolvedMention {
  entity_id: string;
  entity_type: string | null; // "Brand" | "Product" | "Company" | ...
  display_name: string | null;
  rollups: {
    product_entity_id: string | null;
    brand_entity_id: string | null;
    company_entity_id: string | null;
  };
  surfaces: string[];
  mention_count: number;
  // present only after the scope sentiment/classification backfill
  sentiment?: MentionSentimentBreakdown;
  avg_position?: number | null;
  type_breakdown?: MentionTypeBreakdown;
  // 발생 단위 배열(scope#632 ③) — listRunJobs(…, { include: "result,occurrences" })
  // 일 때만 온다. 오프셋은 코드포인트 기준(scope 가 과거 행도 보정해 준다).
  occurrences?: MentionOccurrence[];
}

// ACR(AI's Choice Rate) prompt-run 롤업 한 행 — analysis.acr_summary.rows[].
// 주의: 래퍼(acr_summary/prompt_run_id)는 snake_case인데 rows 내부 필드는
// scope가 camelCase로 직렬화한다(같은 응답 안에 두 컨벤션 혼재 — scope
// lib/measurement-analysis/store.ts::loadAcrSummaryRows 참조). 엔티티 표시명은
// 없음 — resolved_mentions[].entity_id로 조인해 display_name/rollup을 해소한다.
export interface AcrRollupRow {
  rollupLevel: "product" | "brand" | "company";
  entityId: string;
  plannedIterations: number;
  validTurn1Iterations: number;
  validAcrIterations: number;
  appearanceCount: number;
  choiceCount: number;
  conditionalChoiceCount: number;
  appearanceRate: number | null;
  acr: number | null;
  overallChoiceShare: number | null;
  offShortlistChoiceCount: number;
  unresolvedChoiceCount: number;
  genericChoiceCount: number;
  choiceOutcomeBreakdown?: Partial<
    Record<
      | "single_entity"
      | "conditional_multiple"
      | "generic_category"
      | "resolved_off_shortlist"
      | "unresolved_choice"
      | "none",
      number
    >
  >;
}

// ACR job(= prompt-run에 속한 반복 query_run)에만 존재. 같은 prompt-run의
// 반복 job들이 전부 동일한 rows를 반복 반환하므로 소비자는 prompt_run_id로
// dedup해야 한다 (lib/scope/mirror/sync.ts).
export interface AcrSummary {
  prompt_run_id: string;
  rows: AcrRollupRow[];
}

// 답변 단위 브랜드 스탠스 하나 — (답변 turn × 브랜드 롤업 엔티티) 1건.
// 발생 단위 감성(MentionOccurrence.sentiment)과 **다른 축**이다: 발생은 "이 문장이
// 이 브랜드를 어떻게 말하는가", 스탠스는 "이 답변 전체가 이 브랜드에 대해 어떤 태도인가".
// 브랜드 표면이 없는 문장(대명사·"이 업데이트"·"제조사")의 비판까지 포함하므로 발생
// 단위가 구조적으로 놓치는 부정을 회수한다.
// 정본 계약: scope-answer-brand-stance-spec-2026-09-14.md §5.1 (`?include=stances`).
//
// ⚠️ 코어(scope) 배포 전에는 이 배열이 아예 오지 않는다 — 미러·화면은 "없음"을
// 발생 감성으로 **조용히 대체하지 않는다**(같은 스펙 FR10).
export interface ScopeBrandStance {
  turn_index?: number | null;
  entity_id: string;
  brand_label?: string | null;
  is_tracked?: boolean;
  stance: "positive" | "negative" | "mixed" | "neutral";
  confidence?: number | null;
  evidence_text?: string | null;
  // 코드포인트 오프셋. **코어가** 답변 원문에서 evidence_text 를 정확히 1회 찾았을 때만
  // 채운다(0회·2회 이상이면 둘 다 null) — 스펙 FR4.
  // ⚠️ 이 값이 있다는 것은 "코어가 찾았다"는 뜻이지 "우리 원문에 있다"가 아니다.
  // 화면의 대조 판정은 `lib/answer-sentiment/stance-evidence.ts` 가 **미러 원문과 직접
  // 비교해** 내린다(파일럿 실측: 모델 인용의 8.6% 가 원문과 불일치).
  evidence_start?: number | null;
  evidence_end?: number | null;
  reason?: string | null;
  model_slug?: string | null;
}

// Embedded analysis object (the brand/mention carrier). Only the fields the
// adapter consumes are typed; scope returns more (counters/health/etc).
export interface QueryAnalysisSummary {
  status: "skipped" | "pending" | "completed" | "partial" | "failed";
  analysis_version?: string;
  quality_breakdown?: Partial<
    Record<
      | "valid_answer"
      | "empty_answer"
      | "trash_answer"
      | "failed_answer"
      | "refusal_or_non_answer",
      number
    >
  >;
  resolved_mentions?: ResolvedMention[];
  // 답변 단위 브랜드 스탠스 — listRunJobs(…, { include: "result,occurrences,stances" })
  // 일 때만 온다. **resolved_mentions 안이 아니라 형제 배열**인 것이 계약의 핵심이다:
  // 미러가 멘션을 (job_id, entity_id) 로 접으므로 그 안에 turn 축이 있는 배열을 넣으면
  // 접히면서 사라진다(스펙 §5.1 경고).
  brand_stances?: ScopeBrandStance[];
  // ACR 프롬프트(kind='acr')의 job에만 존재 — 2턴 선택 측정의 prompt-run 롤업.
  acr_summary?: AcrSummary;
}

// One element of result.citations. `domain` is a display label (e.g.
// "App Store"), NOT a host. `host`/`category`/`subcategory` are added by scope's
// per-domain classifier (change measurement-llm-sentiment-citation-
// classification) — optional because pre-backfill responses omit them.
export interface ScopeCitation {
  url?: string;
  title?: string;
  domain?: string;
  refType?: string;
  snippet?: string;
  refIndex?: number;
  host?: string;
  category?: string;
  subcategory?: string | null;
}

// A completed (or errored) single-turn query run, as returned by /results.
export interface QueryRunResult {
  answer_text: string;
  citations: ScopeCitation[];
  measured_at: string;
  latency_ms?: number;
  model_slug?: string;
}

export interface QueryRunView {
  job_id: string;
  target: string; // "chatgpt" | "gemini" | ...
  status: string; // "completed" | "failed" | ...
  prompt_run_id?: string;
  result?: QueryRunResult;
  error?: { code: string; message: string };
  analysis?: QueryAnalysisSummary;
}

// GET /results — workspace-wide single-turn feed (limit only, no project/region
// filter). Workspace-scoped by the key.
export interface ResultsResponse {
  results: QueryRunView[];
}

// GET /projects/{id}/measurements — run-history list (lifecycle metadata only).
export interface MeasurementRunSummary {
  measurement_run_id: string;
  project_id: string;
  trigger: string;
  status: string;
  targets: string[];
  regions: string[];
  total_jobs: number;
  started_at: string;
  completed_at: string | null;
}

// GET /projects/{id}/measurements/{runId}/jobs — per-job list. Carries `region`
// AND the analysis summary, so it's the source for region-attributed mentions.
export interface MeasurementJob {
  job_id: string;
  prompt_id: string | null;
  target: string;
  region: string | null;
  status: string;
  measured_at: string;
  analysis?: QueryAnalysisSummary;
  // Present only when requested via listRunJobs(..., { include: "result" }) and
  // the job completed (scope change: jobs feed ?include=result). The raw answer
  // text + citations for the mirror sync, so one project-scoped paginated feed
  // covers all targets (the workspace-wide /results dropped Gemini).
  result?: QueryRunResult;
}

// --- Query option bags for list/read endpoints ---

export interface PageQuery {
  limit?: number; // 1..100
  cursor?: string;
}

/** Existing Scope jobs-feed filters; status is applied before ID pagination. */
export interface RunJobsQuery extends PageQuery {
  include?: string;
  status?: "queued" | "running" | "completed" | "failed";
}

export interface BrandScoresQuery extends PageQuery {
  date_from?: string;
  date_to?: string;
  region?: Region;
  target?: ScopeTarget;
  brand_name?: string;
}

export interface BrandMentionsQuery extends BrandScoresQuery {
  is_tracked?: boolean;
  include_synthetic?: boolean;
}

export interface CitationsQuery extends PageQuery {
  date_from?: string;
  date_to?: string;
  domain?: string;
  brand_name?: string;
}

export interface PromptsQuery extends PageQuery {
  funnel_stage?: FunnelStage;
  /**
   * `updatedAt >= 이 시각` 인 프롬프트만. scope 라우트가 이미 지원한다
   * (`app/api/v1/projects/[id]/prompts/route.ts` → `lib/prompts/store.ts`
   * 의 `gte(prompts.updatedAt, …)`).
   *
   * 미러가 이 값을 쓰는 이유: 프롬프트 목록은 `created_at DESC` 정렬이고
   * 페이지 상한(PROMPT_MAX_PAGES × 100)이 있어 **오래된 프롬프트가 영구히
   * 잘린다**. 루트 프로젝트는 12,446개로 상한 5,000 을 크게 넘어, 실측상
   * 미러에 4,146개가 없고 그중 `lang` 백필분 2,986개가 반영되지 않았다
   * (2026-09-01). 창을 좁히면 그 안에서는 상한에 안 걸린다.
   */
  updated_from?: string;
  /**
   * `updatedAt < 이 시각` 인 프롬프트만. **`updated_from` 과 반드시 함께 쓴다.**
   *
   * 하한만으로는 절단이 안 풀린다(2026-09-01 라이브 실측): 목록 정렬이
   * `created_at DESC` 라 창을 과거로 넓히면 대상이 전체와 같아져 페이지 상한에
   * 다시 걸린다 — `updated_from=2020-01-01` 로 돌린 회수에서 `pageCapHits` 에
   * `prompts` 가 그대로 남았고 미러 총계는 변화 0 이었다.
   *
   * `[from, to)` 구간으로 쪼개야 각 창이 상한 아래로 내려가 전량이 넘어온다.
   */
  updated_to?: string;
}

// --- Presentational view-model (NOT part of the ScopeClient contract) ---
// Row shape the dashboard's ResultsTable renders. Decoupled from scope's API:
// the old workspace-wide "recent results" feed was scope-internal (/results)
// and is no longer callable. A project-scoped feed (e.g. derived from
// brand-mentions) arrives with role→project gating — a follow-up change.
export interface ResultItem {
  id: string;
  prompt: string;
  target: ScopeTarget;
  status: "completed" | "accepted" | "failed";
  createdAt: string;
  brand?: string;
  region?: string;
  country?: string;
}
