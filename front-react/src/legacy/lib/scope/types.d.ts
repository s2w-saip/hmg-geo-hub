// Type-only snapshot; no database or server implementation is included.
export type ScopeTarget = "chatgpt" | "gemini" | "deepseek" | "perplexity" | "claude";
export type FunnelStage = "discovery" | "consideration" | "evaluation" | "transactional" | "loyalty";
export type Region = string;
export interface ScopeFilter {
    brands?: string[];
    regions?: string[];
    countries?: string[];
}
export interface Paginated<T> {
    data: T[];
    next_cursor?: string | null;
}
export interface ScopeErrorBody {
    error: {
        code: "invalid_argument" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "server_error" | "service_unavailable";
        message: string;
        details?: Record<string, unknown>;
    };
}
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
    tracked_brands: TrackedBrand[];
    regions: Region[];
}
export interface UpdateProjectInput {
    name?: string;
    domain?: string;
    tracked_brands?: TrackedBrand[];
    regions?: Region[];
}
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
    interval_days: number;
    targets: string[];
    regions: Region[];
    prompt_ids?: string[] | null;
}
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
        top_co_mentioned?: {
            brand_name?: string;
            co_mention_count?: number;
        }[];
    };
    daily_trend?: {
        date?: string;
        our_brand_score?: number;
    }[];
}
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
export interface BrandMention {
    brand_mention_id?: string;
    brand_name?: string;
    mention_position?: number;
    total_brands_mentioned?: number;
    mention_type?: "recommendation" | "mention" | "comparison" | "listing";
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
    rate_limit?: {
        per_minute?: number;
        per_hour?: number;
    };
}
export interface HealthStatus {
    status: string;
    version?: string;
}
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
export interface MentionOccurrence {
    source_start: number;
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
export interface ResolvedMention {
    entity_id: string;
    entity_type: string | null;
    display_name: string | null;
    rollups: {
        product_entity_id: string | null;
        brand_entity_id: string | null;
        company_entity_id: string | null;
    };
    surfaces: string[];
    mention_count: number;
    sentiment?: MentionSentimentBreakdown;
    avg_position?: number | null;
    type_breakdown?: MentionTypeBreakdown;
    occurrences?: MentionOccurrence[];
}
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
    choiceOutcomeBreakdown?: Partial<Record<"single_entity" | "conditional_multiple" | "generic_category" | "resolved_off_shortlist" | "unresolved_choice" | "none", number>>;
}
export interface AcrSummary {
    prompt_run_id: string;
    rows: AcrRollupRow[];
}
export interface ScopeBrandStance {
    turn_index?: number | null;
    entity_id: string;
    brand_label?: string | null;
    is_tracked?: boolean;
    stance: "positive" | "negative" | "mixed" | "neutral";
    confidence?: number | null;
    evidence_text?: string | null;
    evidence_start?: number | null;
    evidence_end?: number | null;
    reason?: string | null;
    model_slug?: string | null;
}
export interface QueryAnalysisSummary {
    status: "skipped" | "pending" | "completed" | "partial" | "failed";
    analysis_version?: string;
    quality_breakdown?: Partial<Record<"valid_answer" | "empty_answer" | "trash_answer" | "failed_answer" | "refusal_or_non_answer", number>>;
    resolved_mentions?: ResolvedMention[];
    brand_stances?: ScopeBrandStance[];
    acr_summary?: AcrSummary;
}
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
export interface QueryRunResult {
    answer_text: string;
    citations: ScopeCitation[];
    measured_at: string;
    latency_ms?: number;
    model_slug?: string;
}
export interface QueryRunView {
    job_id: string;
    target: string;
    status: string;
    prompt_run_id?: string;
    result?: QueryRunResult;
    error?: {
        code: string;
        message: string;
    };
    analysis?: QueryAnalysisSummary;
}
export interface ResultsResponse {
    results: QueryRunView[];
}
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
export interface MeasurementJob {
    job_id: string;
    prompt_id: string | null;
    target: string;
    region: string | null;
    status: string;
    measured_at: string;
    analysis?: QueryAnalysisSummary;
    result?: QueryRunResult;
}
export interface PageQuery {
    limit?: number;
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
