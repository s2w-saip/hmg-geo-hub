// Type-only snapshot; no database or server implementation is included.
import type { SubKpiPart } from "@/lib/db/repositories/scope-aggregates";
/**
 * 문장 하나의 상한(ms) — 진짜 `statement_timeout`.
 *
 * 2026-09-02 상향(8s → 20s). **8s 의 근거가 틀린 측정이었다.** 종전 주석은
 * "최장 문장은 엔진 추이의 멘션 조인 4.44s" 라 적었는데, 그 수치는 프로덕션
 * 경로(TEMP TABLE + ANALYZE)가 아니라 MATERIALIZED CTE 하네스로 잰 것이라
 * 비용 귀속이 틀렸다(같은 하네스가 ROLLUP_NAMES 를 ~1s 로 오진했다 — 실제 19ms).
 *
 * 실제 경로로 다시 재니 엔진 추이의 개별 문장이 **warm 8~10.6s** 다. 즉 8s 상한은
 * 최적화를 다 하고도 **매번 문장을 죽이고 있었다** — 2026-09-02 프리뷰에서 히어로
 * 스칼라(36.7%)는 정상인데 우측 추이만 계속 비던 것이 그 발현이다. 벽시계 예산을
 * 24s→60s 로 키워도 결과가 같았던 것도 같은 이유다(A/B 실증: 등장 시각·degrade
 * 여부 동일). **범인은 예산이 아니라 이 상수였다.**
 *
 * 산정: warm 최장 10.6s × 콜드 1.7 = 18.0s → 20s (여유 ~10%).
 * 실효 최악 = ENGINE_BUDGET + 이 값 = 50s 로 페이지 `maxDuration`(120s) 안.
 *
 * ⚠️ 이 값을 다시 올리는 것으로 느려진 문장을 덮지 마라. 자주 발동한다면 집계가
 * 회귀했다는 신호다 — **프로덕션과 같은 TEMP TABLE 경로로** EXPLAIN 하라
 * (CTE 하네스로 재면 이 주석이 한 번 겪은 오진을 반복한다).
 */
export declare const KPI_TAB_STATEMENT_TIMEOUT_MS = 20000;
/**
 * 엔진 집계(2단계 합)의 벽시계 예산.
 *
 * 2026-09-02 상향(12s → 20s). 이유는 성능이 나빠져서가 아니라 **예산의 성격**이다:
 * 이 값은 성능 목표가 아니라 "이 이상 걸리면 그 지면을 포기한다"는 안전망이다.
 *
 * 안전성: 실효 최악 = budgetMs + KPI_TAB_STATEMENT_TIMEOUT_MS = 50s 로,
 * 페이지 `maxDuration` 120s 안에 충분히 들어온다. 지면은 Suspense 경계 안이라
 * 셸·필터바·스칼라는 먼저 뜨고 이 섹션만 늦게 채워진다.
 *
 * ── 2026-09-02 후속: 남은 레버를 적용했고, 그래도 12s 로는 못 되돌린다 ──────
 *
 * 이 주석이 지목했던 `ansRows`+`menRows` 단일 패스 병합을 실제로 적용했다
 * (`ENGINE_KPI_PER_JOB`, 동치성 증명은 그쪽 주석 — 미러 전수 반증 포함).
 * 프로덕션 무필터 실측: **12.5s → 10.8s**(3회 중앙값, 콜드/웜 동일).
 *
 * 원복 판정(기준: warm × 1.7 ≤ 예산의 70%):
 *   10.8 × 1.7 = 18.4s.  12s 예산의 70% = 8.4s  →  **원복 불가**.
 *   현행 20s 예산 기준으로도 18.4/20 = 92% 라 여유가 크지 않다.
 *
 * 더 줄일 곳이 이 계층에 남아 있지 않다는 것이 EXPLAIN 의 결론이다. 병합 후 남은
 * 비용은 식 평가가 아니라 **행 인출**이다 — 언급 조인 Nested Loop 2,999 ms
 * (853,909행 · shared hit 403,486 · 100,130 loops). 커버링 인덱스로 index-only
 * scan 을 만드는 안은 loop 당 4.03 페이지 중 힙이 1 페이지뿐이라 상한이 ~25%,
 * 대가는 ~200MB 인덱스 + 미러 동기화 쓰기 증폭이라 기각했다.
 *
 * ⚠️ 다음 사람에게: 이 값을 **또 올려서 덮지 마라**. 다음 절감은 이 계층이 아니라
 * 모집단·저장 계층에서 온다(답변셋 창 축소, 또는 job 단위 언급 사전집계 테이블).
 *
 * ── 2026-09-02 하향(60s → 24s) ──────────────────────────────────────────────
 * 성능이 좋아져서가 아니라 **섹션별 스트리밍으로 초과의 대가가 작아져서**다
 * (위 재조정 블록). 근거: warm 10.8s × 콜드 1.7 × 여유 1.3 = 23.9s.
 * 종전의 원복 판정 기준(콜드 추정 ≤ 예산의 70%)으로는 18.4 / 24 = 77% 라 아슬하다.
 * 그 기준을 여기서 완화하는 이유를 분명히 적어 둔다: 그것은 **초과 = 빈 화면**이던
 * 단일 경계 시절의 안전율이다. 지금 초과는 이 섹션 하나의 degrade 이고 히어로·
 * 경쟁사 표는 이미 그려져 있다. 대신 여유분(×1.3)을 산정식에 명시적으로 넣었다.
 */
export declare const KPI_TAB_ENGINE_BUDGET_MS = 30000;
/**
 * 단일 단계 집계(브랜드 추이·유형)의 벽시계 예산.
 * 2026-09-02 상향(9s → 12s) — 최적화 후 warm 실측 brandTrend 5.5s · typeKpi 4.4s
 * 로 여유가 있으나, 콜드 배수(~1.7)를 곱하면 9.4s/7.5s 라 brandTrend 가 종전
 * 예산을 넘긴다. 엔진 예산과 같은 취지(안전망이지 성능 목표가 아니다).
 *
 * 2026-09-02 재측정(pg_stat_statements 리셋 후 콜드 1회): brandTrend 7.5s ·
 * typeKpi 4.2s. brandTrend × 1.7 = 12.7s 로 이 예산을 살짝 넘으므로 9s 로는
 * 되돌릴 수 없고 12s 도 여유가 없다 — 두 집계는 이 라운드의 대상이 아니었다.
 *
 * ── 2026-09-02 하향(40s → 18s) ──────────────────────────────────────────────
 * 엔진 예산과 같은 이유(섹션별 스트리밍 — 위 재조정 블록). 이 예산은 두 집계가
 * 공유하므로 **느린 쪽**으로 잡는다: brandTrend 7.5s × 1.7 × 1.3 = 16.6s → 18s.
 * typeKpi 는 4.2s × 1.7 × 1.3 = 9.3s 라 여유가 크다.
 */
export declare const KPI_TAB_SINGLE_BUDGET_MS = 24000;
/** 무거운 미러 read 의 문장 상한(진짜 `statement_timeout`). */
export declare const MIRROR_HEAVY_STATEMENT_TIMEOUT_MS = 15000;
/** 무거운 미러 read 의 벽시계 예산(한 페처 기준). */
export declare const MIRROR_HEAVY_BUDGET_MS = 45000;
/**
 * 위 예산을 그대로 실은 `AnswerSetBudget` — **호출 시점**에 마감을 계산한다.
 *
 * ⚠️ 반드시 캐시 콜백 **안에서** 부를 것. 모듈 로드 시점이나 캐시 키 자리에서 만들면
 *    (a) 마감이 프로세스 기동 시각 기준이 되고 (b) `Date.now()` 가 캐시 키에 섞여
 *    셀이 매 요청 갈린다.
 */
export declare function mirrorHeavyBudget(profile?: MirrorHeavyProfile): {
    statementTimeoutMs?: number;
    deadlineAt: number;
};
/** S1 대시보드 extras(추이·언급·스파크·순위)의 벽시계 예산(경로당). */
export declare const MIRROR_EXTRAS_BUDGET_MS = 30000;
/** 위 예산 + S3 과 공유하는 문장 상한. `mirrorHeavyBudget()` 과 같은 규약(호출 시점 마감). */
export declare function mirrorExtrasBudget(): {
    statementTimeoutMs: number;
    deadlineAt: number;
};
/**
 * 같은 집계를 부르는 **호출자별 예산 프로파일**.
 *   `kpi-tab` — 4-KPI 탭(S2). 종전 값 그대로(20 s / 30 s).
 *   `extras`  — S1 대시보드 경쟁사 행·Δ. 한 경계에서 넷이 함께 도므로 더 짧다(15 s / 30 s).
 * ⚠️ 이 값은 **캐시 키의 일부**여야 한다(`cachedKpi*` 인자로 넘긴다).
 */
export type KpiBudgetProfile = "kpi-tab" | "extras";
export declare function kpiBudgetOf(profile: KpiBudgetProfile): {
    statementTimeoutMs: number;
    budgetMs: number;
};
/**
 * 언급 헤드라인 집계(`aggregateMentionsFromMirror(..., "none")`)의 **호출자별 프로파일**
 * — 위 `KpiBudgetProfile` 과 같은 패턴이고, 같은 이유로 **캐시 키의 일부**여야 한다.
 *
 * 왜 갈랐나(PR③ 통합, 2026-09-11): 한 셀(`standard-mentions`)을 두 지면이 나눠 쓰는데
 * **초과의 대가가 다르다**.
 *   · `extras` — 대시보드 경쟁사 행. 빠져도 카드 본체(①~⑤)는 이미 그려져 있고
 *     `DegradeNotice` 가 지연을 고지한다. 그래서 짧게 가고 degrade 를 감수한다(15/30).
 *   · `screen` — S2 언급 화면. 이 집계가 **화면의 본문 그 자체**라 degrade 되면 지면이
 *     통째로 빈다. 그래서 실측이 요구하는 만큼 준다(25/35 — 산정식과 재산정 경위는
 *     `MIRROR_HEAVY_PROFILES.mentions` 주석이 정본이다).
 *
 * 문장 상한의 근거는 오폴백 방지다 — 이 집계의 최장 문장이 **warm exec 11.2 s**
 * (2026-09-17 재측정, 추이 주 격자 키가 회차 주로 바뀐 뒤)라 콜드 배수 1.7 을 곱하면
 * **19.1 s** 로 `extras` 의 문장 상한 15 s 를 넘는다. 즉 S2 를 `extras` 로 두면
 * **정상 결과가 콜드에서 죽는다**(8 s 상한이 매번 문장을 죽이던
 * `KPI_TAB_STATEMENT_TIMEOUT_MS` 주석의 사고와 같은 형태).
 *
 * ⚠️ 기본값은 **보수적인 쪽(`screen`)** 이다. 새 호출부가 옵션을 잊어도 화면이 죽지 않는
 *    방향으로 틀리게 두는 것이 이 기본값의 목적이다 — 대시보드만 명시한다.
 */
export type MentionsBudgetProfile = "screen" | "extras";
/**
 * ⚠️ 반드시 캐시 콜백 **안에서** 부를 것 — 두 갈래 다 `Date.now()` 로 마감을 만든다
 * (`mirrorHeavyBudget()` 주석과 같은 이유).
 */
export declare function mentionsBudgetOf(profile: MentionsBudgetProfile): {
    statementTimeoutMs?: number;
    deadlineAt: number;
};
/**
 * 표준 인용 미러 집계(`aggregateCitationsFromMirror`)의 호출자별 프로파일 (PR④ A3).
 *
 * 언급 셀과 **같은 문제·같은 해법**이다 — 한 셀(`standard-citations`)을 S3 인용 화면과
 * 대시보드 경쟁사 행이 나눠 쓰는데 초과의 대가가 다르다:
 *   · `screen` — S3 인용 화면. 이 집계가 화면 본문이라 degrade 되면 지면이 통째로 빈다.
 *     종전 값 그대로 `citationsGlobal`(15/45, 실효 최악 60 s).
 *   · `extras` — 대시보드 경쟁사 행의 **미러 폴백**. 그 경계는 네 read 의 실효 최악을
 *     45 s 로 묶는 것이 규약이라(`MIRROR_EXTRAS_BUDGET_MS` 주석) 60 s 짜리를 끼워 넣으면
 *     그 계산이 깨진다. 빠져도 카드 본체(①~⑤)는 이미 그려져 있다.
 *
 * 두 프로파일의 **문장 상한은 같다**(15 s) — 갈리는 것은 벽시계뿐(45 → 30 s)이다.
 * 그래서 이 분기가 정상 문장을 죽이지는 않는다: 죽는 것은 "문장 여럿을 다 돌기엔
 * 시간이 모자란" 경우이고, 그때 대시보드는 degrade 를, 화면은 완주를 택한다.
 *
 * ⚠️ 프로파일은 **캐시 키**다(`mirrorCache` 가 인자를 키에 넣는다) — 두 호출자가 셀을
 *    공유하지 않는다. 대시보드 폴백이 S3 의 warm 셀에 얹혀 가던 것이 없어지는 것이
 *    이 분리의 대가이고, 그 경로는 `S3.citation` 이 켜져 있는 한 거의 밟히지 않는다.
 * ⚠️ 반드시 캐시 콜백 **안에서** 부를 것(`mentionsBudgetOf` 와 같은 이유).
 */
export type CitationsBudgetProfile = "screen" | "extras";
export declare function citationsBudgetOf(profile: CitationsBudgetProfile): {
    statementTimeoutMs?: number;
    deadlineAt: number;
};
export declare const MIRROR_HEAVY_PROFILES: {
    /** S3 표준 인용 — E-2(2026-09-10) 에서 정한 값. 실효 최악 60 s. */
    readonly citationsGlobal: {
        readonly statementTimeoutMs: 15000;
        readonly budgetMs: 45000;
    };
    /**
     * 인용 계열 넓은 모수 — S6 웹사이트(126 프로젝트) · 프로젝트 인용.
     * 문장 8.89 × 1.7 × 1.3 = 19.6 → 20 s · 경로 26.0 × 1.7 = 44.1 → 45 s. 실효 최악 65 s.
     */
    readonly citationsWide: {
        readonly statementTimeoutMs: 20000;
        readonly budgetMs: 45000;
    };
    /**
     * 언급 계열(SQL 헤드라인 경로) — S2 표준 · S5 웹사이트.
     *
     * 2026-09-17 재산정 — 추이 주 격자 키가 원장 회차 주로 바뀌면서 이 경로의 **최장 문장이
     * 늘었다**(`scope-aggregates.ts::trendWeekKey`: `ans` CTE 에 LEFT JOIN 하나 추가).
     * 프로덕션 warm 실측(같은 세션 A/B 교대, 중앙값): measured **9,966 ms** → cycle **11,219 ms**.
     *   문장 11.219 × 1.7 × 1.3 = 24.8 → **25 s** (종전 9.19 기준 22 s)
     *   경로 (16.6 + 1.1 + TEMP 1.6) × 1.7 = 32.8 → **35 s**(무변경)
     * 실효 최악 **60 s** — 답변분석 `maxDuration` 120 s 안이고, 같은 지면의 S3 인용(60 s)과
     * 같은 수준이다. 대시보드 경계는 이 프로파일을 쓰지 않는다(`extras` = 15/30 → 45 s).
     *
     * ⚠️ 화면 키 `S2.mentionTrend` 가 **off 인 경로도 같은 프로파일을 쓴다** — off 면 문장이
     *    종전(9,966 ms)이므로 25 s 는 그만큼 **상한만 느슨해지는 것**이고 값·동작은 안 바뀐다.
     *    프로파일을 키별로 가르지 않는 이유는 그 방향이 안전한 쪽이기 때문이다(상한이 늘면
     *    degrade 가 덜 난다 — `KpiBudgetProfile` 의 "유지 또는 완화" 와 같은 판단).
     * ⚠️ 프로젝트 JS 경로의 최장 문장(9.95 s)도 여전히 덮는다.
     */
    readonly mentions: {
        readonly statementTimeoutMs: 25000;
        readonly budgetMs: 35000;
    };
    /**
     * 프로젝트 언급(JS 경로) — **문장 상한 없음**(위 ⚠️: `statement_timeout` 이 전송을
     * 포함해서, 서버 작업량으로 잡은 상한이 정상 결과를 죽인다. 22 s 로 실증했다).
     * 벽시계 마감만 둬서 "이미 늦었으면 다음 문장을 안 보낸다" 까지만 한다.
     */
    readonly mentionsJs: {
        readonly statementTimeoutMs: undefined;
        readonly budgetMs: 75000;
    };
    /**
     * **카드 계열 미러 폴백** — S1 카드(`aggregateStandardFromMirror`, 루트) · S4 카드
     * (같은 함수, 웹사이트 126 프로젝트) · GEO 경쟁(`aggregateGeoCompetitionFromMirror`).
     *
     * 게이트가 summary 경로를 거부했을 때 가는 길이고, 여기가 **캡이 없는 마지막 경계**
     * 였다(2026-09-10 PR #235 프리뷰: `/ko/dashboard` 콜드 18건 중 3건이 120.5 s 절단,
     * 절단 응답은 `dashboard:filters` 만 도착하고 `kpi-cards` 는 미도착).
     *
     * 실측(같은 하네스, warm exec): S1 카드 문장 12개 **16.2 s**(최장 4.16 s) ·
     * S4 카드 10개 **9.7 s**(최장 4.47 s) · GEO 4개 **2.5 s**(최장 2.51 s).
     *   문장 4.47 × 1.7 × 1.3 = 9.9 → **10 s** · 경로 16.2 × 1.7 = 27.6 → **30 s**
     * 실효 최악 **40 s** ≤ 대시보드 경계 목표 45 s.
     */
    readonly cardsMirror: {
        readonly statementTimeoutMs: 10000;
        readonly budgetMs: 30000;
    };
    /**
     * **집계층 읽기**(`readTrendAggregates` 경유 문장 + 게이트 프로브). 정상값이 수백 ms
     * 인 경로라 이 상한은 성능 목표가 아니라 **순수 안전망**이다 — 발동하면 그건 집계층이
     * 회귀했거나 락·풀 경합이 있다는 신호다.
     *
     * 15 s 는 실측 대비 ~20 배 여유다(집계층 read 415 ms · 게이트 프로브 ~1 s).
     * 실효 최악 20 + 15 = **35 s** ≤ 45 s.
     */
    readonly summaryRead: {
        readonly statementTimeoutMs: 15000;
        readonly budgetMs: 20000;
    };
    /**
     * **세부층 폴백**(`onDetail`) — R2. 집계층이 거부된 축에서 가는 길이라 미러보다 훨씬
     * 싸지만(T11 재검 실측 **2.4~4.3 s**) 상한이 없는 것은 마찬가지였다.
     *
     * 산정: 그 실측은 경로 합이므로 어떤 단일 문장도 그보다 클 수 없다 — 상한으로 쓴다.
     *   문장 4.3 × 1.7 × 1.3 = 9.5 → **10 s**
     *   경로 — 4.3 × 1.7 = 7.3 s 지만 측정이 1회뿐이라 여유를 크게 둔다 → **20 s**
     * 실효 최악 30 s. 초과하면 **미러가 아니라 degrade** 다(T11 기준 6: 세부층이 거부됐다고
     * 미러로 내려가면 한 화면에 두 원천이 섞인다 — 느린 것보다 그쪽이 나쁘다).
     */
    readonly detail: {
        readonly statementTimeoutMs: 10000;
        readonly budgetMs: 20000;
    };
};
export type MirrorHeavyProfile = keyof typeof MIRROR_HEAVY_PROFILES;
/**
 * 히어로 KPI 추이 · 엔진별 시계열 — 12주. 현재 미러 전 구간(10 버킷)을 덮고,
 * 데이터가 길어져도 스캔을 상수화한다. 트렌드 트랜잭션 실측 합 ≈ 5.6s
 * (답변셋 ~0.2s + 1.0s + 4.4s) < 8s 가드. 여유가 ~2.4s 라 넉넉하지 않으므로,
 * 초과하면 설계대로 그 지면만 degrade 된다. 근본 절감은 ROLLUP_NAMES 슬림화
 * (집계 계층, 후속)가 맡는다.
 */
export declare const KPI_TAB_HERO_TREND_DAYS = 84;
/**
 * 경쟁사 스파크라인 — 직전 4회차만 그리므로 28일. 여기서는 창 축소가 실제로
 * 유효하다(브랜드 추이는 버킷×브랜드 GROUP BY 라 행수에 비례). 다만 절감폭은
 * 창 비율이 아니라 행 비율(28일 = 92,576/132,687 ≈ 70%)이다.
 */
export declare const KPI_TAB_SPARK_TREND_DAYS = 28;
export declare const KPI_TAB_SUB_KPI_PARTS: Record<"exposure" | "sov" | "favorability" | "citation", readonly SubKpiPart[]>;
export declare const S4_BADGE_SUB_KPI_PARTS: readonly SubKpiPart[];
export declare function isTimeoutFailure(e: unknown): boolean;
/**
 * 시간 초과로 죽은 집계만 그 지면 null 로 내린다. 그 외 실패는 그대로 던진다.
 * 삼킬 때도 warn 을 남긴다(readMentionBrandDayCounts 호출부와 같은 형태).
 */
export declare function kpiDegrade<T>(label: string, run: () => Promise<T>): Promise<T | null>;
/**
 * 부분 degrade 결과(예: `trendDegraded: true`)를 **캐시에 넣지 않게** 하는 장치.
 *
 * 2026-09-02 프리뷰 실증: 배포 직후 콜드 첫 요청 두 건에서만
 * `[engineKpiTrend] trend phase degraded` 경고가 찍히고, 그 뒤 수 시간 동안 화면은
 * 계속 "집계가 시간 안에 끝나지 않아…" 인데 로그는 0건이었다. degrade 는 예외가
 * 아니라 **정상 반환값**이어서 `unstable_cache`(TTL 30분) 에 그대로 저장됐고, 이후
 * 요청은 전부 캐시 HIT 라 DB 도 안 가고 warn 도 안 남긴 것이다. TTL 뒤에도
 * stale-while-revalidate 가 옛 값을 먼저 내주므로 사실상 굳는다.
 *
 * 규칙: 캐시 안쪽 함수는 degrade 결과를 이 예외로 **던져** 저장을 막고, 캐시 바깥
 * 호출부가 `recoverDegraded` 로 그 값을 회수해 화면엔 종전처럼 내린다. 다음 요청은
 * 캐시 MISS 라 다시 계산한다 — 성공하면 그때 저장된다.
 */
export declare class DegradedResultUncached<T = unknown> extends Error {
    readonly result: T;
    constructor(result: T);
}
/** 캐시 안쪽 래퍼: `isDegraded(result)` 면 저장 대신 던진다. */
export declare function uncachedIfDegraded<A extends unknown[], R>(isDegraded: (r: R) => boolean, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
/** 캐시 바깥 호출부: 위 예외면 감싸 둔 결과를 그대로 돌려준다. 다른 실패는 통과. */
export declare function recoverDegraded<R>(run: () => Promise<R>): Promise<R>;
/**
 * Δ 전용 추이 롤업의 창(일) — **정본은 여기다**(2026-09-11, PR③ GG-4).
 *
 * 종전 정본은 `app/[locale]/(dash)/dashboard/_data/live.ts` 였는데, 집계층 추이 경로
 * (`lib/scope/server.ts::globalSeriesFilters`)가 "이 바닥은 사용자 기간이 아니라 Δ 페처가
 * 얹은 것" 을 알아야 하면서 lib → app 역방향 import 가 필요해졌다. 값을 두 곳에 적는
 * 대신 중립 모듈로 올린다 — `live.ts` 는 재수출만 한다.
 */
export declare const DELTA_TREND_WINDOW_DAYS = 30;
