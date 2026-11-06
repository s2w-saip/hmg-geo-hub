// Type-only snapshot; no database or server implementation is included.
import type { ScopeClient } from "./client";
import type { TrendGapRow } from "@/lib/viz/trend-gap";
import { type CitationOverrideMap } from "@/lib/citation-categorizer";
import type { BrandMention, Citation, MeasurementJob, MentionSentimentBreakdown, MentionTypeBreakdown, QueryRunView } from "./types";
export interface RootConfig {
    projectId: string;
}
export declare function getRootConfig(): RootConfig | null;
export declare const MOCK_ROOT_PROJECT_ID = "mock-root-project";
export declare function getStandardRootId(): string | null;
export interface BrandAgg {
    name: string;
    mentionCount: number;
    answerCount: number;
    isTracked: boolean;
}
export interface RegionAgg {
    region: string;
    answerCount: number;
    trackedAnswerCount: number;
}
export interface DomainAgg {
    host: string;
    citingAnswers: number;
    citationCount: number;
    ownedCitationCount: number;
    isOurs: boolean;
}
export interface StandardAggregates {
    rootProjectId: string;
    asOf?: string | null;
    totalAnswers: number;
    totalMentions: number;
    trackedAnswerCount: number;
    brands: BrandAgg[];
    regions: RegionAgg[];
    citations: {
        sampledAnswers: number;
        answersWithCitation: number;
        totalCitations: number;
        ownedCitations: number;
        /**
         * **글로벌 ⑤ 분자**(제품 책임자 2026-09-29) — 출처 카테고리가 `Official (HMG)` 인 인용 수.
         * 인용 탭 카테고리 차트와 같은 분류(`resolveCitationCategory` + 오버라이드)다.
         * 글로벌(표준) 리더만 싣는다. website·project 는 이 필드가 없고 ⑤ 는 종전
         * `ownedCitations`(base URL prefix)다 — 읽을 때는 `citationShareNumerator` 로만.
         */
        officialHmgCitations?: number;
        domains: DomainAgg[];
    };
    position: {
        avgPosition: number | null;
        sampledAnswers: number;
    };
    sentiment: {
        positiveRate: number | null;
        positiveMentions: number;
        sampledMentions: number;
    };
}
export declare function providerLabel(t: string): string;
export interface StandardFilters {
    region?: string[];
    engine?: string[];
    funnelStage?: string[];
    dateFrom?: string;
    dateTo?: string;
    cumulative?: boolean;
    brand?: string[];
    contextBrand?: string[];
    ownEntities?: {
        id: string;
        name: string;
    }[];
    brandPresence?: string[];
    listType?: string[];
    depth1?: string[];
    depth2?: string[];
    depth3?: string[];
    sourceCategory?: string[];
    lang?: string[];
    websiteCountry?: string[];
    customFieldFilters?: Record<string, string[]>;
}
export declare const STANDARD_FILTER_ARRAY_AXES: readonly ["region", "engine", "funnelStage", "brand", "brandPresence", "listType", "depth1", "depth2", "depth3", "sourceCategory", "lang", "websiteCountry"];
export interface PromptMetaValue {
    text: string;
    funnel: string | null;
    brand?: string | null;
    brandPresence?: string | null;
    listType?: string | null;
    depth1?: string | null;
    depth2?: string | null;
    depth3?: string | null;
}
/** 앵커 축에서 답변 한 건이 실어야 하는 값(계약 §2). 전부 optional = 옵트인. */
export interface AnswerAnchorFields {
    /** 회차 **귀속** 날짜(KST `YYYY-MM-DD`). 기간 술어·dedup 의 키이자 축의 존재 신호. */
    round_date?: string | null;
    /** `round_date` 가 속한 KST 주의 월요일 — 주 버킷 키. */
    anchor_week?: string | null;
    /** 대표 답변 정렬 키(원본 측정 시각, 접기 이전). */
    measured_at_orig?: string | null;
    /** 기본 타깃(ChatGPT·Gemini) 여부. 엔진 필터가 비었을 때의 기본 범위. */
    is_default_engine?: boolean | null;
    /** 노출 게이트. `undefined` = 미투영(게이트 없음) · `null` = 비노출 · 값 = 그날부터. */
    view_anchor_date?: string | null;
}
/** 앵커 필드를 실은 job/result — `MeasurementJob`/`QueryRunView` 를 그대로 받는다. */
export type AnchoredJob = MeasurementJob & AnswerAnchorFields;
export type AnchoredResult = QueryRunView & AnswerAnchorFields;
/** 이 행이 앵커 축으로 읽히는가 = `round_date` 가 실려 왔는가. */
export declare function anchorAxisCarried(row: AnswerAnchorFields | null | undefined): boolean;
/**
 * 노출 게이트(계약 §2 `view_anchor_date`). 3값이다:
 *   `undefined` = 미투영 → **통과**(종전 동작) · `null` = 비노출 → 차단 ·
 *   값 = `today`(KST) 이상이면 아직 안 됐다 → 차단.
 */
export declare function anchorViewPasses(row: AnswerAnchorFields | null | undefined, today: string): boolean;
/**
 * 기본 엔진 범위 — **엔진 필터가 비어 있을 때만** 건다(계약 §3, `anchorDefaultEngineScope`).
 * 사용자가 엔진을 고르면 그 선택이 이긴다(고른 엔진이 화면에서 사라지면 결함으로 읽힌다).
 * 값이 안 실려 오면(`undefined`·`null`) 좁히지 않는다 — 모르는 값으로 모수를 지우지 않는다.
 */
export declare function anchorDefaultEnginePasses(f: StandardFilters, row: AnswerAnchorFields | null | undefined): boolean;
/**
 * **회차마다 셀당 대표 1건**(계약 §3) — SQL 의
 * `DISTINCT ON (ca.round_date, prompt_id, target, region) … ORDER BY … ca.measured_at_orig DESC`
 * 와 같은 규칙을 인메모리로 낸다. 셀 = 프롬프트 × 엔진(`target`) × 지역(`region`).
 *
 * 기간에 회차가 여럿이면 **회차마다** 대표를 하나씩 고르고, 호출부가 그 집합을
 * `snapshotJobIds` 로 써서 회차 간 **합산**한다(회차는 통째로 들어오거나 나간다).
 *
 * 반환:
 *   · `null` — 앵커를 실은 행이 **하나도 없다**(= 종전 축). 호출부는 자기 스냅샷 집합을 쓴다.
 *   · `Set`  — 대표 job id 집합.
 *
 * `opts.pass` 는 dedup **이전에** 거는 술어다(SQL 의 `WHERE`). 필터에서 떨어질 답변이
 * 대표 자리를 차지하면 그 셀이 통째로 사라진다 — 순서가 곧 값이다.
 *
 * 동점(같은 `measured_at_orig`)은 `job_id` 사전식 최대로 깬다. 임의지만 **결정적**이다.
 */
export declare function anchorRepresentativeJobIds(jobs: readonly AnchoredJob[], opts?: {
    pass?: (job: AnchoredJob) => boolean;
}): Set<string> | null;
export declare function aggregateStandard(client: ScopeClient, root: RootConfig, filters?: StandardFilters): Promise<StandardAggregates | null>;
/**
 * 대시보드 KPI 카드 **경쟁사 행**이 실제로 소비하는 필드만 — `MentionsBrandLive` 의
 * 구조적 부분집합이다(그 타입은 이 타입에 그대로 대입된다).
 *
 * 왜 따로 두는가: 경쟁사 행의 원천을 집계층(회차 스냅샷)으로 옮기면서
 * (`S1.competitors`, PR④ B1) 그 경로가 낼 수 있는 것이 이 여섯 필드뿐이기 때문이다.
 * `prompts`·`multi` 같은 언급 화면 전용 필드를 0 으로 채워 `MentionsBrandLive` 인 척
 * 하면, 나중에 그 필드를 읽는 소비자가 생겼을 때 **조용히 0** 이 그려진다.
 * 타입이 없다고 말하게 두는 편이 낫다.
 *
 * 소비처는 `dashboard/_components/overview-kpi-cards.tsx::competitorMinis` 하나다.
 */
export interface CompetitorBrandValue {
    brand: string;
    mentions: number;
    /** % of total mentions */
    share: number;
    /** % of answers mentioning the brand */
    mentionRate: number;
    avgPosition: number | null;
    isTracked: boolean;
    sentiment?: {
        positive: number;
        neutral: number;
        negative: number;
        mixed: number;
    };
    /**
     * 새 백엔드(API 원천, U4)만 채우는 브랜드 키(rd.dim_brand_name.brand_key). 추이
     * brand_key[](BG-11)·언급 드릴다운(M-3 mode=brand) 입력이다. 옛 경로는 채우지 않는다.
     */
    brandKey?: number;
}
export interface MentionsBrandLive {
    brand: string;
    mentions: number;
    prompts: number;
    share: number;
    mentionRate: number;
    avgPosition: number | null;
    isTracked: boolean;
    /**
     * 복수 언급(2026-09-02) — 한 답변 안에서 이 브랜드가 2회 이상 언급된 답변만의
     * 합계. 공통 하단 "브랜드 복수 언급" 토글의 원천. 표준 SQL 경로만 채우고
     * 구 캐시 셀·JS/mock 경로에는 없다(optional) → 토글이 값을 못 찾으면 "—".
     */
    multi?: {
        mentions: number;
        answers: number;
        prompts: number;
    };
    /** 브랜드별 감정 신호 합(2026-09-02, Overview 카드 경쟁사 우호도). 표준 SQL 경로만. */
    sentiment?: {
        positive: number;
        neutral: number;
        negative: number;
        mixed: number;
    };
    /**
     * 새 백엔드(API 원천, U4)만 채우는 브랜드 키(rd.dim_brand_name.brand_key). 브랜드
     * 드릴다운(M-3 mode=brand)이 이 키를 받는다(BG-17). 옛 경로는 채우지 않는다.
     */
    brandKey?: number;
}
export interface MentionAnswerLive {
    jobId: string;
    provider: string;
    region: string | null;
    mentionCount: number;
    position: number | null;
    highlights: {
        brand: string[];
        model: string[];
    };
    measuredAt: string | null;
    runs: number;
}
export interface MentionsPromptLive {
    id: string;
    promptText: string;
    mentions: number;
    share: number;
    funnelStage: string | null;
    providers: string[];
    answers: MentionAnswerLive[];
}
export interface WeeklyTrend {
    series: string[];
    /**
     * [{ week, KeyA, KeyB, … }]. 수집 오류 회차는 시리즈 값이 전부 `null` 이고
     * `gap` 마커가 붙는다(lib/viz/trend-gap.ts). 그 외 값은 종전대로 숫자다.
     */
    points: Array<TrendGapRow>;
}
export type MentionTrend = WeeklyTrend;
export type CitationTrend = WeeklyTrend;
export interface MentionTypesByBrand {
    totals: MentionTypeBreakdown;
    brands: Array<{
        brand: string;
        isTracked: boolean;
        types: MentionTypeBreakdown;
    }>;
}
export interface MentionsLive {
    /** totalAnswers: 측정 답변 수(언급률 분모). 표준 SQL 경로만 채운다(optional — 복수 언급 토글용). */
    summary: {
        total: number;
        uniqueBrands: number;
        totalPrompts: number;
        totalAnswers?: number;
    };
    asOf: string | null;
    brands: MentionsBrandLive[];
    perBrandPrompts: Record<string, MentionsPromptLive[]>;
    sentimentTotals: MentionSentimentBreakdown | null;
    typeTotals: MentionTypeBreakdown | null;
    typesByBrand?: MentionTypesByBrand | null;
    hasPosition: boolean;
    /**
     * 관점 당사(합친 당사)의 서버 값 — API 원천만 싣는다(/v1/mentions/brands own 블록). share = M02 당사 점유율(%),
     * avgPosition = M04 우선노출도(답변별 당사 최상위 순위의 평균), mentionRate = M01 노출률(당사 등장 답변 / 답변, %).
     * 헤드투헤드 '당사' 행이 브랜드 행 합산 대신 쓴다. mentionRate 는 이 필드 이전의 캐시 항목에는 없다.
     */
    own?: {
        share: number;
        avgPosition: number | null;
        mentionRate?: number;
    };
    trend: MentionTrend | null;
    /**
     * true = 추이 롤업이 시간 초과로 빠졌다(null 이 "2주 미만"이 아니라 degrade).
     * 서버 캐시는 이 값이 true 인 결과를 저장하지 않는다(kpi-tab-budget 규칙 —
     * 2026-09-02 실증: degrade 가 30분 캐시에 굳어 하단 차트가 "준비 중"으로 남았다).
     */
    trendDegraded?: boolean;
}
/**
 * 추이 입력 한 건. `week` 가 실려 있으면 그것이 버킷이고(앵커 축의 `ca.anchor_week`),
 * 없으면 종전대로 `date` 에서 UTC 월요일을 계산한다.
 *
 * 앵커 축에서 계산을 안 하는 이유: `anchor_week` 는 쓰기 시점에 KST 로 굳은 `date` 라
 * 세션 타임존·접힌 `measured_at` 과 무관하다(`lib/period/sql-day.ts` 머리 주석의
 * 세션 TZ 의존 문제를 JS 쪽에서도 같은 방식으로 피한다).
 */
export interface WeeklyTrendEntry {
    date: string | null | undefined;
    key: string;
    count: number;
    /** 앵커 축의 주 버킷(`anchor_week`, KST 월요일). 없으면 `date` 에서 계산. */
    week?: string | null;
}
export declare function weeklyTopNUnion(entries: WeeklyTrendEntry[], n: number, cap: number): string[];
export declare function buildWeeklyTrend(entries: WeeklyTrendEntry[], series: string[],
/**
 * 숨긴 회차(0070)의 주 격자 키(`cycle_week`) 목록 — 그 주를 **시리즈 값 전부 null +
 * `gap` 마커** 행으로 끼워 넣는다.
 *
 * 규칙 셋(정본 `lib/viz/trend-gap.ts`):
 *   ① 축 **안쪽**만 — 첫/마지막 주 밖의 갭은 이을 이웃이 없어 축만 늘린다.
 *   ② 그 주에 **측정이 남아 있으면 넣지 않는다** — 숨긴 회차 말고 다른 회차의 인용이
 *      그 주에 남아 있다면 그 주는 구멍이 아니다(값이 줄었을 뿐이고 그건 사실이다).
 *   ③ 갭 주는 "2주 이상이어야 선" 판정(`weeks.size < 2`)에 **세지 않는다** — 갭만
 *      둘 있는 차트는 선이 아니다.
 */
gapWeeks?: readonly string[]): WeeklyTrend | null;
/**
 * 주별 추이에 **숨긴 회차 갭 슬롯**을 얹는다(0070). 순수 함수 — 값은 하나도 안 바꾸고
 * 없던 주 하나를 "전부 null + `gap`" 행으로 끼워 넣을 뿐이다.
 *
 * `buildWeeklyTrend` 안에서도 쓰고, **이미 만들어진 추이**(미러 집계가 돌려준 것)에
 * 페처 경계에서 얹을 때도 쓴다 — 두 벌로 갈라지면 한쪽만 고치는 결함이 생긴다.
 * 규칙(축 안쪽만 · 값이 남은 주는 제외)은 `insertTrendGapSlots` 한 곳이 쥔다.
 */
export declare function applyWeeklyTrendGaps(trend: WeeklyTrend | null, gapWeeks?: readonly string[]): WeeklyTrend | null;
export declare function buildMentionTrend(entries: {
    date: string | null | undefined;
    brand: string;
    count: number;
    week?: string | null;
}[], seriesBrands: string[], gapWeeks?: readonly string[]): MentionTrend | null;
export type PromptMap = Map<string, PromptMetaValue>;
export declare function aggregateMentions(client: ScopeClient, projectId: string, filters?: StandardFilters): Promise<MentionsLive | null>;
export declare function aggregateMentionsFrom(jobs: AnchoredJob[], promptMap: PromptMap, filters?: StandardFilters, opts?: {
    snapshotJobIds?: Set<string> | null;
    brandPrompts?: "all" | "none" | {
        onlyBrand: string;
    };
    globalNames?: Map<string, string>;
    /**
     * 앵커 축(0077)으로 읽는가. **생략 = 자동 판정**(job 하나라도 `round_date` 를
     * 실었으면 켠다) — 투영이 됐는데 옵션을 안 넘겨 축이 반만 켜지는 상태를 없앤다.
     * `false` 를 명시하면 필드가 실려 있어도 종전 축이다.
     */
    anchorAxis?: boolean;
    /** 노출 게이트의 "오늘"(KST). 테스트가 고정하기 위한 자리. */
    today?: string;
}): MentionsLive | null;
export interface CitationUrlLive {
    url: string;
    title: string;
    count: number;
    aiProvider: string;
    promptText: string;
    country?: string | null;
}
export interface CitationPromptLive {
    id: string;
    promptText: string;
    funnelStage: string | null;
    citations: number;
    ownedCitations?: number;
    providers: string[];
    answers: MentionAnswerLive[];
}
export interface CitationDomainLive {
    domain: string;
    citations: number;
    share: number;
    prompts: number;
    coverageRate: number;
    urls: CitationUrlLive[];
    promptList: CitationPromptLive[];
    isOurs: boolean;
    category: string | null;
    subcategory: string | null;
    /**
     * 이 행의 드릴다운(urls·promptList)을 **일부러 싣지 않았다**는 표시.
     * 미러 집계가 상위 N 밖 도메인의 드릴다운을 안 가져오거나, 캐시 예산 슬리밍이
     * 드릴다운을 떨궜을 때 붙는다(공식(HMG) 행에만 — 비공식 행은 화면 문구가
     * 종전 그대로라 표시가 필요 없고, 9천 행에 붙이면 페이로드만 는다).
     *
     * 화면이 "URL이 아직 없습니다"(정말 없음)와 "미제공"(우리가 안 실었음)을
     * 구분하는 데 쓴다 — 공식 도메인은 순위와 무관하게 드릴다운을 싣지만
     * 상한(CITATION_OFFICIAL_DRILLDOWN_MAX)을 넘는 초과분이 존재할 수 있고,
     * 그 행에 "아직 없습니다"를 띄우면 거짓말이 된다.
     * undefined = 표시 없음(구 캐시 엔트리 포함).
     */
    drilldownOmitted?: boolean;
    /**
     * 새 백엔드(API 원천, U4)만 채우는 출처 그룹 키(공식 소셜 계정 그룹 포함). 도메인
     * 드릴다운 상세(GET /v1/citations/domains/{skey})를 펼칠 때 부르는 키다(urls·promptList
     * 는 목록에 없다). 옛 경로는 채우지 않는다.
     */
    skey?: string;
}
export interface CitationCategorySlice {
    name: string;
    value: number;
}
export interface EngineCategorySlice {
    engine: string;
    total: number;
    byCategory: Record<string, number>;
}
export interface CitationsPromptSplit {
    owned: CitationPromptLive[];
    uncited: CitationPromptLive[];
    ownedCount: number;
    uncitedCount: number;
}
export interface CitationsLive {
    summary: {
        total: number;
        uniqueDomains: number;
        officialOwnShare?: number | null;
    };
    asOf: string | null;
    domains: CitationDomainLive[];
    categories: CitationCategorySlice[] | null;
    trend: CitationTrend | null;
    categoryTrend: CitationTrend | null;
    engineCategories: EngineCategorySlice[] | null;
    promptSplit?: CitationsPromptSplit | null;
}
export declare function aggregateCitations(client: ScopeClient, projectId: string, filters?: StandardFilters, overrides?: CitationOverrideMap): Promise<CitationsLive | null>;
export declare function aggregateMentionsFromPublic(rows: BrandMention[], filters?: StandardFilters): MentionsLive | null;
export declare function aggregateCitationsFromPublic(rows: Citation[], filters?: StandardFilters, overrides?: CitationOverrideMap): CitationsLive | null;
export declare function engineCategorySlices(m: Map<string, Map<string, number>>): EngineCategorySlice[] | null;
export declare function aggregateCitationsFrom(jobs: AnchoredJob[], promptMap: PromptMap, allResults: AnchoredResult[], filters?: StandardFilters, opts?: {
    snapshotJobIds?: Set<string> | null;
    anchorAxis?: boolean;
    today?: string;
}, overrides?: CitationOverrideMap): CitationsLive | null;
export declare function aggregateBrandCitationsFrom(jobs: AnchoredJob[], promptMap: PromptMap, allResults: AnchoredResult[], brandName: string, filters?: StandardFilters, opts?: {
    snapshotJobIds?: Set<string> | null;
    globalNames?: Map<string, string>;
    anchorAxis?: boolean;
    today?: string;
}, overrides?: CitationOverrideMap): CitationDomainLive[];
