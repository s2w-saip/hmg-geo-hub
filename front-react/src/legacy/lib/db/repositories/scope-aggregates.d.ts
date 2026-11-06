// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { normalizeUrlForMatch } from "@/lib/scope/url-match";
import { targetMatchSql } from "@/lib/scope/url-match-sql";
import { type WebsiteOwnedUnit } from "@/lib/scope/website-owned-unit";
import type { TrendGap } from "@/lib/viz/trend-gap";
import type { TrendGridSlotView } from "@/lib/period/trend-grid-axis";
import { type SentimentSpan } from "@/lib/answer-sentiment/spans";
import { type StanceEvidenceMatch } from "@/lib/answer-sentiment/stance-evidence";
import { type StandardFilters, type StandardAggregates, type MentionsLive, type CitationsLive, type CitationDomainLive, type MentionAnswerLive, type MentionsPromptLive, type AnchoredJob } from "@/lib/scope/result-adapter";
import { type CitationOverrideMap } from "@/lib/citation-categorizer";
import { type AnchorHiddenFamily } from "./scope-answer-anchors";
import type { ResolvedMention } from "@/lib/scope/types";
import type { AllowedScope } from "@/lib/auth/types";
export declare const ROLLUP_NAMES: SQL<unknown>;
export declare function canonRollupSql(f: StandardFilters, alias?: string): SQL;
export declare function trackedRollupPredicate(f: StandardFilters, alias?: string): SQL;
export declare function canonBrandNameSql(expr: SQL): SQL;
export declare function excludeNonCompetitorBrandsSql(brandCol: SQL, ownCol?: SQL): SQL;
export declare function excludeNonCompetitorBaresSql(bare: SQL, ownCol?: SQL): SQL;
export declare function ownBrandRankPerJobSql(f: StandardFilters): SQL;
export { normalizeUrlForMatch };
export declare function citationBaseNormSql(col: SQL): SQL;
export declare function citationTrackedNormSql(col: SQL): SQL;
export { targetMatchSql };
type CitationNormKind = "tracked" | "base";
/** 인용 URL 정규화 값 — 컬럼이 있으면 컬럼, NULL 이면 SQL 함수 폴백. */
export declare function citationNormExpr(kind: CitationNormKind, urlExpr: SQL, colExpr: SQL): SQL;
export declare function citationOwnedByUrlSelect(citSet: SQL, ownedClause: SQL): SQL;
/**
 * 유닛 판정(키 on)용 짝 — **정규화만** DISTINCT url 당 1회 하고 판정은 하지 않는다.
 *
 * 유닛 판정은 "그 프롬프트가 속한 유닛" 에 달려 있어 url 당 1회로 접을 수 없다. 그래서
 * 비싼 부분(정규화 사슬)만 여기서 접고, 값싼 문자열 비교인 판정은 인용 **행**에서 한다
 * — `aggregateWebsiteTargetHitRate` 의 `ub`/`pm` 분업과 같은 형태다.
 *
 * `base`(쿼리 제거)와 `cnorm`(tracked, 쿼리 보존)을 **둘 다** 낸다: 리포트 정본의 자사
 * 판정이 base 항은 base NORM, 타겟 항은 tracked NORM 이기 때문이다
 * (`websiteUnitOwnedTargetClause` 머리 주석). 정규화 사슬은 여전히 DISTINCT url 당
 * 각 1회다 — 행당이 아니다.
 */
export declare function citationBaseByUrlSelect(citSet: SQL): SQL;
export declare function ownedBasePrefixClause(cnorm: SQL, basePrefixes: string[], siblingUniverse?: string[]): SQL;
export declare const SNAPSHOT_CELL_STALE_DAYS = 7;
export declare function optionWindowPredicate(range?: {
    dateFrom?: string;
    dateTo?: string;
}): SQL;
export declare function brandPresenceResolvedSqlFor(brandCol: SQL, presenceCol: SQL): SQL;
/**
 * 추이 모수의 지역·한국어·카탈로그 판정을 **회차 dim 스냅샷**으로 바꾸는 semi-join.
 *
 * 축(앵커 표)이 꺼져 있으면 `null` — 셀의 회차를 얻을 길이 없다. 이 키(`X.trendGrid`)는
 * 축이 켜져 있어야만 참이므로 실제로는 `null` 이 안 나온다.
 *
 * ⚠️ 안쪽 스캔의 범위는 **루트 표면 전체**다(날짜 바닥을 안 건다). 날짜로 좁히면
 *    바깥 창이 그보다 넓은 호출부에서 셀이 조용히 빠진다 — 좁히는 방향의 오류가
 *    "값이 사라지는" 쪽이라 더 나쁘다. 비용은 G2d EXPLAIN 으로 잰다.
 */
/**
 * dim 스냅샷 **파생표 조인 조각** — `FROM scope_answers a JOIN … ca` 뒤에 그대로 붙인다.
 *
 * ── 왜 조인인가 (2026-09-20 4차, 미러 EXPLAIN) ─────────────────────────────
 *
 * 3차(사전 집계 CTE + semi-join)로 dim 쪽은 해결됐다: 13자리 창 4,324 → 2,947ms ·
 * shared hit 2,277,858 → 884,293 · `dim_small` 193,960행 CTE Scan loops=1 · Hash Left
 * Join Batches 1 · 22MB(디스크 유출 없음). **남은 약 2.1초는 semi-join 자신이었다** —
 * `a.job_id IN (SELECT a2.job_id FROM scope_answers a2 JOIN scope_answer_cycle_anchors ca2 …)`
 * 가 바깥이 이미 한 조인(`a` × `ca`)을 **한 번 더** 하고, 그 안쪽이 Nested Loop 으로
 * 풀려 인덱스 조회 20만 회(추정 rows=80 대 실제 209,480)가 됐다.
 *
 * 바깥 문장이 이미 `ca` 를 조인하는 경로에서는 그 중복이 통째로 필요 없다. dim 을
 * **바깥 FROM 에 직접** 걸고 술어는 WHERE 에 둔다 — 조인 하나, 스캔 하나.
 *
 * 꺼져 있으면 **빈 조각**이라 문장이 종전과 바이트 동일하다.
 * CTE 대신 파생표인 이유: 이 조각은 `FROM` 절 한가운데 붙으므로 `WITH` 를 쓸 자리가
 * 없다. 인덱스 없는 서브쿼리라 중첩 루프가 구조적으로 비싼 성질은 CTE 와 같다.
 */
export interface TrendMirrorJoins {
    /** `FROM scope_answers a … ca` 뒤에 붙이는 조각. 꺼져 있으면 **빈 조각**이다. */
    join: SQL;
    /**
     * 이 문장이 `d`·`sv` 를 **실제로 방출했는가**. 술어 쪽(`caJoined`·`svJoined`)에
     * 그대로 넘긴다 — 두 불리언이 어긋나면 `42P01 missing FROM-clause entry` 다.
     */
    joined: boolean;
}
/**
 * 추이 문장이 붙이는 조인 **한 벌**과 그 사실을 함께 낸다.
 *
 * ⚠️ 이 객체가 있는 이유가 **5f5b84e 의 차단 결함**이다. 종전에는 조인 조각(격자·축
 *    가드 있음)과 술어(가드 **없음**)가 따로 놀아서, `caJoined = anchorAxisKnownEnabled()`
 *    만 보고 조인을 안 붙이는 호출부 둘(`readCitationDomainDayCounts` ·
 *    `aggregateWebsiteCitationAccuracyTrend`)이 `sv` 를 참조해 죽었다. 격자가 꺼져
 *    있어도 **축만 켜지면** 발현하므로 통합 프리뷰(축 on)의 인용 화면이 즉시 장애였다.
 *    이제 호출부는 이 한 객체에서 둘을 함께 받는다.
 */
export declare function trendMirrorJoins(): TrendMirrorJoins;
export declare function trendDimJoinSql(alias?: string): SQL;
/**
 * **함대 게이트의 조인 판본** — 서빙 가능한 회차만 담은 소형 파생표 `sv`.
 *
 * ── 왜 (2026-09-20 5차, 미러 EXPLAIN) ──────────────────────────────────────
 *
 * 4차에서 dim 을 조인으로 옮겼는데도 순증이 +1.39초였다(A 674ms 대 B 2,065ms).
 * 분해해 보니 주범은 dim 이 아니라 **함대 게이트가 만드는 두 번째 앵커 조인**이었다:
 *   `a.job_id IN (SELECT ca.job_id FROM scope_answer_cycle_anchors ca
 *                  WHERE ca.surface='project' OR EXISTS (SELECT 1 FROM summary_cycles sc …))`
 * 바깥이 이미 `ca` 를 조인(loops=249,101)하는데 이 조각이 앵커 표를 `ca_1` 로 한 번 더
 * 찌르고(loops=187,233), 그 안의 상관 `EXISTS` 가 `summary_cycles` 를 행마다 조회한다
 * (`sc_1` loops=187,233). 최상위 Nested Loop 이 1,984ms 까지 끌고 간 몫이 약 1.06초다.
 *
 * 그래서 바깥 `ca.cycle_id` 를 재사용하고, 회차는 **소형 파생표에 등치 조인**한다.
 *
 * ── 의미 동치 ──────────────────────────────────────────────────────────────
 *
 * 원본: `ca.surface='project' OR EXISTS (… sc.cycle_id = ca.cycle_id AND <조건 셋>)`
 * 새것: `ca.surface='project' OR sv.cycle_id IS NOT NULL`  (sv = 그 조건 셋을 만족하는 회차)
 *   · `cycle_id` 가 PK 라 LEFT JOIN 이 행을 늘리지 않는다 → `IS NOT NULL` 은 `EXISTS` 와 같다.
 *   · `ca.cycle_id IS NULL`(원장에 귀속된 적 없는 앵커)은 양쪽 다 거짓이다.
 * ⚠️ `sv` 에 **표면·프로젝트 조건을 넣지 않는다** — 원본 `EXISTS` 도 안 넣는다.
 *    넣으면 동치가 "cycle_id 는 PK 이므로 표면이 하나뿐" 이라는 **추가 논증**에 기대게 된다.
 *    `summary_cycles` 는 수천 행이라 전량 해시해도 공짜다.
 */
declare function trendServableJoinSql(alias?: string): SQL;
/** 위 파생표를 쓰는 **술어**. 조인이 붙은 문장에서만 쓴다(없으면 42P01). */
declare function trendServableJoinedPred(alias?: string): SQL;
/**
 * **관찰 지점** — 추이 모수가 dim 스냅샷 경로를 탔는가, 현재값 폴백을 탔는가.
 *
 * 읽기 전용 단일 문장이고, 자리(`round_date`)별로 셋을 센다:
 *   · `dim_path`      회차의 활성 세대 dim 행으로 판정한 셀
 *   · `fallback_path` dim 행이 없어 현재값으로 판정한 셀(0 이어야 정상이다 —
 *     함대 게이트가 이미 "활성 세대 있음" 을 요구하므로 dim 이 있어야 한다)
 *   · `drift_cells`   두 판정이 **갈린** 셀 = 이 수리가 되살린 몫(08-03 176 · 08-17 180)
 *
 * 운영·하네스가 정기로 돌려 `fallback_path` 가 늘면 생성이 빠진 회차가 있다는 신호다.
 */
export declare function trendDimSnapshotAuditSql(rootProjectId: string, fromRoundDate: string): SQL;
export declare function answerWhere(f: StandardFilters, projectCtx?: string | string[], opts?: {
    allRuns?: boolean;
    recentDays?: number;
    /** 숨김 게이트 계열(검증 D·후속). 생략 = `DEFAULT_HIDDEN_FAMILY`. */
    hiddenFamily?: AnchorHiddenFamily;
    /**
     * 호출부가 `trendWindowFloor()`(= `round_date >= 오늘 − TREND_WINDOW_DAYS`)를
     * **자기 문장에 반드시 얹는가**. 참이면 dim semi-join 안쪽도 같은 바닥으로 좁힌다
     * (성능). 바깥이 안 거는데 참으로 넘기면 셀이 조용히 빠진다 — `trendRoundFloorSql`.
     */
    trendRoundFloor?: boolean;
    /**
     * 이 문장이 **이미 `ca`(앵커)와 `d`(dim 파생표)를 조인했는가**. 참이면 dim 술어가
     * semi-join 없이 조인된 컬럼을 그대로 본다. 호출부는 `AnswerSetBudget.join` 에
     * `anchorJoinSql(...)` **와** `trendDimJoinSql()` 을 함께 넣어야 한다.
     */
    caJoined?: boolean;
}): SQL;
type MirrorTx = Pick<ReturnType<typeof getDb>, "execute">;
/**
 * 답변셋 트랜잭션의 실행 예산 — 두 값의 **의미가 다르다**(2026-09-01 재검증 C1).
 *
 * 종전에 `timeoutMs` 하나만 두고 "이 값을 넘지 않는다"고 적었던 것은 거짓이었다:
 * `statement_timeout` 은 **문장당**이고 이 트랜잭션은 문장을 여러 개 발행한다
 * (`CREATE TEMP TABLE` + `ANALYZE` + fn 의 분석 쿼리들). 8s 를 주면 6~7문장짜리
 * 단계의 최악은 8s 가 아니라 48~56s 다 (2026-09-01 실측: 스냅샷 6문장·추이 7문장).
 *
 * 그래서 상한을 둘로 나눈다:
 *   - `statementTimeoutMs` — 문장 하나가 붙잡을 수 있는 시간(진짜 statement_timeout).
 *   - `deadlineAt` — 이 트랜잭션 전체의 벽시계 마감(epoch ms). **문장을 보내기 전마다**
 *     확인해 이미 지났으면 즉시 던진다(진행 중 문장을 취소하지는 못한다).
 *
 * 실효 최악 = (deadlineAt 까지 남은 시간) + statementTimeoutMs. 마지막으로 보낸
 * 문장 하나는 끝까지 기다려야 하기 때문이다. 이 한 줄이 정직한 상한이고,
 * 호출부 jsdoc 도 이 식으로 적어야 한다.
 *
 * 둘 다 생략하면 종전 동작 그대로(세션 기본 timeout, 마감 없음).
 */
export interface AnswerSetBudget {
    statementTimeoutMs?: number;
    deadlineAt?: number;
    dedupe?: {
        on: SQL;
        order: SQL;
    };
    join?: SQL;
}
export declare class AnswerSetDeadlineError extends Error {
    constructor(label: string);
}
/**
 * 측정 기준일의 **행 단위** 축 라우터. 집계 전 값이 필요한 자리(지역별 롤업의 CTE)가
 * 쓴다. 아래 `cycleAsOfSql()` 이 이 식을 `max()` 로 감싼 것이므로 **정의는 하나**다 —
 * 두 벌로 두면 한쪽만 축이 바뀌어 같은 화면의 기준일이 갈린다(이 전환 전에 실제로
 * 그랬다: 대시보드 pill 은 run 앵커, 언급·인용은 `round_date`).
 */
declare function cycleAsOfRowSql(): SQL;
/**
 * 측정 기준일의 **축 라우터**(계약 §3: 측정 기준일 = `max(ca.round_date)`).
 *
 * 앵커 축에서 `COALESCE(r.cycle_anchor_at, a.measured_at)` 를 그대로 두면 안 된다 —
 * 그 값은 run 앵커(UTC timestamptz)라 달력에서 고른 날짜(`round_date`, KST date)와
 * **하루 어긋날 수 있고**(회차 1,033 중 209개가 UTC↔KST 로 날짜가 갈린다), §9.2 의
 * 정규 요일 귀속을 통과하지 않은 날짜다. 같은 화면에서 "기간"과 "기준일"이 다른
 * 시계를 보는 것이 이 전환이 없애려는 결함이다.
 *
 * 이 식을 쓰는 문장은 앵커 축에서 `ca` 조인을 함께 가져야 한다(아래 `anchorAsOfJoinSql`).
 */
declare function cycleAsOfSql(): SQL;
/**
 * 같은 값을 **화면이 그대로 쓰는 텍스트**로 낸다 — 앵커 축이면 `YYYY-MM-DD`.
 *
 * 왜 SQL 에서 자르는가: raw `db.execute` 는 drizzle 컬럼 매퍼를 안 타고 postgres.js
 * 기본 파서를 타는데, `date`(OID 1082)도 `new Date(x)` 로 파싱된다
 * (`node_modules/postgres/src/types.js`). 그러면 JS 가 다시 `toISOString()` 해서
 * `2026-09-04T00:00:00.000Z` 라는 **없는 시각**이 붙고, JS 롤업 경로가 내는
 * `2026-09-04` 와 같은 필드의 형식이 갈린다(계약 §3 "축 안에서는 형식이 균일하다").
 *
 * 종전 축에서는 **감싸지 않는다** — 문장이 바이트 단위로 같아야 한다.
 */
declare function cycleAsOfDisplaySql(): SQL;
/**
 * 측정 기준일을 읽기 위한 `ca` 조인 — **값 투영 전용이라 LEFT 다.**
 *
 * `anchorJoinSql` 이 INNER 인 것은 그 조인이 **기간 술어를 거는 자리**이기 때문이다
 * (앵커 없는 답변을 통과시키면 기간이 샌다). 여기는 반대로 모집단이 이미
 * `_answer_set`(= `answerWhere` 의 앵커 semi-join 통과분)으로 **확정된 뒤**이고,
 * 조인의 용도는 `round_date` 를 꺼내는 것 하나다. INNER 로 두면 앵커 행이 없는
 * 답변이 `count(*)`·tracked 에서 **조용히 빠져** KPI 분모가 바뀐다 — 기준일 하나를
 * 고치려다 수치를 흔드는 것이라 값이 사라지는 방향으로도 허용하지 않는다.
 * `job_id` 가 PK 라 LEFT 여도 행이 불어나지 않고, 앵커가 없으면 `round_date` 가
 * NULL 이라 `max()` 가 알아서 무시한다.
 */
declare function anchorAsOfJoinSql(jobIdCol: SQL): SQL;
declare function normalizeAsOf(raw: Date | string | null | undefined): string | null;
/**
 * 트랜잭션 밖에서 도는 미러 집계에 **문장 상한 + 벽시계 마감**을 건다 (E-2).
 *
 * `withAnswerSet` 은 TEMP TABLE 경로라 이미 트랜잭션이고 거기 `SET LOCAL` 을 걸 수
 * 있다. 그런데 `aggregateCitationsFromMirror` 처럼 **`Promise.all` 로 독립 문장을
 * 병렬 발행**하는 집계는 트랜잭션이 없다 — 하나로 묶으면 한 커넥션에 직렬화되어
 * 정상 경로가 느려진다. 그래서 문장마다 **자기 트랜잭션**을 열어 `SET LOCAL
 * statement_timeout` 을 걸고 그 안에서 원 문장을 보낸다. 병렬성은 그대로다.
 *
 * ⚠️ `SET LOCAL` 이어야 한다. transaction-mode 풀러(Supavisor 6543)에서 맨
 *    `SET statement_timeout` 은 커넥션에 남아 **다음 요청으로 샌다**.
 *
 * 대가는 문장당 왕복 2회(BEGIN+SET, COMMIT)다. 25초짜리 집계에 문장 10개면 왕복이
 * 수십 ms 늘지만, 막는 것은 **함수 120s 초과로 HTML 이 절단되는 것**이다
 * (2026-09-10 T12 실측: `/ko/standard/answer-analysis/citation` 1,519 KB → 319 KB,
 * Vercel `Task timed out after 120 seconds` 2회).
 *
 * 실효 최악 = (deadlineAt 까지 남은 시간) + statementTimeoutMs — `withAnswerSet` 과
 * 같은 식이다. 진행 중 문장은 취소하지 못한다.
 *
 * 둘 다 없으면 **원본 db 를 그대로 돌려준다**(왕복 증가 0, 종전 동작 그대로).
 */
export declare function budgetedMirrorDb(db: ReturnType<typeof getDb>, budget: AnswerSetBudget | undefined): MirrorTx;
/** `budgetedReader` 가 넘겨주는 읽기 핸들 — drizzle 쿼리 빌더도 쓸 수 있어야 한다. */
type MirrorReader = Pick<ReturnType<typeof getDb>, "select" | "execute">;
export declare function withAnswerSet<T>(cols: SQL, W: SQL, fn: (tx: MirrorTx) => Promise<T>, budget?: AnswerSetBudget): Promise<T>;
export type SnapshotAnswerSetStore = Map<string, Promise<string>>;
export declare function createSnapshotAnswerSetStore(): SnapshotAnswerSetStore;
/** 요청 하나의 스냅샷 답변셋 공유 스코프를 연다 (게이트웨이 전용). */
export declare function withSnapshotAnswerSetScope<T>(store: SnapshotAnswerSetStore, fn: () => T): T;
/** 공유 스코프의 크기 — 테스트·진단용. 스코프 밖이면 null. */
export declare function snapshotAnswerSetScopeSize(): number | null;
/**
 * 스냅샷(비-allRuns) 읽기의 답변 술어. 공유 스코프 안에서는 요청단위로 1회
 * 확정된 job_id 목록을, 밖에서는 종전 `answerWhere` 를 그대로 돌려준다.
 * 두 경로의 행 집합은 항등(job_id 는 PK)이라 산식·모수가 바뀌지 않는다.
 */
export declare function snapshotAnswerWhere(filters: StandardFilters, projectCtx: string | string[] | undefined,
/** 숨김 게이트 계열. 요청단위 공유 키에도 들어간다(계열이 다르면 다른 집합이다). */
family?: AnchorHiddenFamily): Promise<SQL>;
export declare function aggregateStandardFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, ownedBasePrefixes: string[], ownedSiblingUniverse?: string[], websiteTargetsOwned?: boolean, budget?: AnswerSetBudget, ownedUnits?: readonly WebsiteOwnedUnit[], officialGroupKeys?: readonly string[]): Promise<StandardAggregates | null>;
export interface SubKpiEngineRow {
    engine: string;
    answers: number;
    tracked: number;
    multi: number;
    top1: number;
    top3: number;
    avgPosition: number | null;
    totalMentions: number;
    trackedMentions: number;
    sentMentions: number;
    positiveMentions: number;
    negativeMentions: number;
    citTotal: number;
    citOwned: number;
}
/**
 * Overview 카드 다섯 개의 **스냅샷 값**. 전부 한 `StandardAggregates` 에서 나온다
 * (`app/[locale]/(dash)/dashboard/_data/live.ts::buildMirrorKpis` 와 같은 식).
 *
 * ⚠️ 여기 **없는 것**이 있다(사실표·집계 스냅샷에 소스가 없다):
 *   · 우호도의 **부정률** — `StandardAggregates.sentiment` 는 positive/sampled 둘뿐이다.
 *   · 우선 노출도의 **최고 순위**(`rank`) — 스냅샷은 평균만 낸다.
 * 그 둘은 종전 미러 경로가 계속 담당한다(같은 탭 안에서 원천이 갈리므로 주석으로 박는다).
 */
export interface OverviewCardValues {
    /** ① AI 노출률 — 당사 언급 답변 ÷ 모니터링 답변. */
    visibility: {
        numerator: number;
        denominator: number;
    };
    /** ② AI 점유율 — 당사 언급 수 ÷ 전체 언급 수. */
    shareOfVoice: {
        numerator: number;
        denominator: number;
    };
    /** ③ AI 우호도 — 긍정 신호 ÷ 전체 감정 신호(**언급 단위 신호 수**). */
    sentiment: {
        numerator: number;
        denominator: number;
    };
    /** ④ AI 우선 노출도 — 평균 순위(낮을수록 좋다)와 그 모수. */
    position: {
        avgPosition: number | null;
        sampledAnswers: number;
    };
    /** ⑤ AI 인용 점유율 — 자사 도메인 인용 ÷ 전체 인용. */
    citationShare: {
        numerator: number;
        denominator: number;
    };
}
export interface StandardSubKpis {
    rows: SubKpiEngineRow[];
    promptsWithoutBrand: number | null;
    measuredPrompts: number | null;
    /**
     * **Overview 카드와 같은 원천에서 온 카드 값들**(제품 책임자 2026-09-20 "나머지 카드들도
     * 원천 일치인지?"). Overview 카드 다섯 개를 만드는 **바로 그 함수**
     * (`fetchStandardAggregates`)가 낸 값이고, 이 필드가 있으면 히어로 계산이 `rows` 합
     * 대신 이것을 쓴다.
     *
     * 왜 rows 를 고치지 않는가: `rows` 는 **엔진 분해행**인데 사실표 카드 리더는 엔진
     * 축을 그 화면과 같은 필터로 내지 않는다. 합계만 바꾸면 엔진 행과 합이 어긋나므로,
     * 합계를 **별도 필드**로 싣고 어느 쪽이 정본인지 타입으로 드러낸다.
     *
     * 없으면(격자 off·루트 없음) 종전 그대로 `rows` 합이다 — 필드가 안 실리므로
     * 캐시 셀·직렬화 모두 바이트 동일.
     */
    overviewCards?: OverviewCardValues;
}
/**
 * 이 집계가 발행하는 **문장 하나 = 파트 하나**. 화면이 실제로 읽는 파트만 계산해
 * 나머지 문장을 아예 보내지 않기 위한 선택 축이다 (2026-09-02).
 *
 * | 파트 | 문장 | 채우는 필드 |
 * | --- | --- | --- |
 * | `answers`   | Q1 | `rows[].{answers,tracked,multi,top1,top3,avgPosition}` |
 * | `mentions`  | Q2 | `rows[].{totalMentions,trackedMentions}` |
 * | `sentiment` | Q3 | `rows[].{sentMentions,positiveMentions,negativeMentions}` |
 * | `citations` | Q4 | `rows[].{citTotal,citOwned}` |
 * | `prompts`   | Q5 | `promptsWithoutBrand` · `measuredPrompts` |
 */
export declare const SUB_KPI_PARTS: readonly ["answers", "mentions", "sentiment", "citations", "prompts"];
export type SubKpiPart = (typeof SUB_KPI_PARTS)[number];
export interface SubKpiOptions {
    /**
     * 계산할 파트. **미지정 = 전량**(종전과 완전히 동일한 산출)이 불변식이다.
     *
     * ⚠️ `answers`(Q1)는 **행 골격**이라 목록에서 빠져도 항상 돈다 — 엔진(target)
     * 행 자체가 Q1 에서 나오므로, 빼면 다른 파트를 요청해도 `rows` 가 통째로 비어
     * "측정 없음"으로 위장된다. 그래서 이 옵션은 결과를 **요청한 것보다 비게**
     * 만들지 않는다(요청분의 상위집합이 나올 수는 있다).
     *
     * 계산하지 않은 파트의 필드는 `rows[]` 쪽은 0, prompts 쪽은 null 이다 —
     * 즉 **"측정 없음"과 구분되지 않는다.** 좁힌 결과를 그 파트를 읽는 지면으로
     * 흘리면 화면이 조용히 빈다. 좁히기 전에 소비 지점을 전수 확인할 것.
     */
    parts?: ReadonlyArray<SubKpiPart>;
    /** 문장 하나의 상한(ms). 실효 최악 = `budgetMs` + 이 값 (`withAnswerSet` 참조). */
    statementTimeoutMs?: number;
    /** 이 집계 전체의 벽시계 예산(ms). 미지정이면 종전대로 마감 없음. */
    budgetMs?: number;
}
export declare function aggregateSubKpisFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, ownedBasePrefixes: string[], ownedSiblingUniverse?: string[], websiteTargetsOwned?: boolean, opts?: SubKpiOptions, ownedUnits?: readonly WebsiteOwnedUnit[]): Promise<StandardSubKpis>;
export declare function latestMeasureDays(filters?: StandardFilters, projectCtx?: string | string[], limit?: number): Promise<string[]>;
export interface MeasureDayBounds {
    first: string | null;
    days: number;
}
export declare function measureDayBoundsInRange(filters?: StandardFilters, projectCtx?: string | string[]): Promise<MeasureDayBounds>;
export interface PromptTopicSlice {
    topic: string | null;
    prompts: number;
}
export declare function aggregatePromptTopicFromMirror(filters?: StandardFilters, projectCtx?: string | string[]): Promise<PromptTopicSlice[]>;
export type BucketUnit = "week" | "day";
/** 주 격자 원천. `measured` = 종전(측정 시각의 세션 TZ 주) · `anchorKst` = 회차 앵커의 KST 주. */
export type MirrorWeekGrid = "measured" | "anchorKst";
/** 표면 → 주 격자. projectCtx 가 없으면 글로벌(표준 루트)이다 — answerWhere 와 같은 판정. */
export declare function mirrorWeekGridFor(projectCtx: string | string[] | undefined): MirrorWeekGrid;
export interface MirrorWeekKey {
    /** `FROM scope_answers a` 바로 뒤에 이어 붙이는 조인 조각. `measured` 면 빈 SQL. */
    join: SQL;
    /** 주 키 식 — 종전 `date_trunc('week', a.measured_at)` 자리에 그대로 쓴다. */
    key: SQL;
    grid: MirrorWeekGrid;
}
/**
 * 주 격자 키 조각. `measured` 는 **종전 식과 문자 그대로 같다**(웹사이트·프로젝트 문장
 * 텍스트 무변경 → pg_stat_statements 정규화 텍스트도 그대로).
 */
export declare function mirrorWeekKey(grid: MirrorWeekGrid, answerAlias?: string): MirrorWeekKey;
export declare const TREND_WINDOW_DAYS = 120;
/**
 * 지금 걸어야 할 바닥 일수. 격자가 꺼져 있으면 종전 상수 그대로다(바이트 동일).
 *
 * ⚠️ **단위를 받는다**(검증 W2, 2026-09-20). 격자는 **주 버킷에만** 얹힌다
 *    (`server.ts::trendSlotsFor` 가 `unit !== "week"` 에서 `null` 을 낸다). 단위를 모르면
 *    일 버킷 경로(프로젝트 일 추이 `getLiveTrend(filters, "day", projectId)`)가 격자를
 *    안 얹는데 바닥만 180 으로 넓어져 **스캔만 1.5배**가 된다. 값은 안 바뀌지만
 *    "격자가 안 갇히는 곳은 안 넓힌다" 는 이 상수의 취지와 어긋난다.
 *
 * 단위를 생략하면 종전 판정(주 취급)이다 — 단위를 모르는 호출부가 아직 없으므로
 * 기본값이 쓰이는 경로도 없지만, 시그니처를 선택적으로 두어 호출부를 강제하지 않는다.
 */
declare function trendFloorDays(unit?: BucketUnit): number;
/**
 * 추이 창의 **바닥**. 축 on 에서는 회차 귀속 날짜로 자른다(검증 B4 잔존 경로).
 *
 * 왜 축을 맞춰야 하나: 축 on 의 버킷은 `ca.anchor_week`/`ca.round_date` 인데 바닥만
 * 측정 시각이면, 회차의 꼬리 측정이 창 밖으로 밀린 회차에서 **대표가 바뀐다**
 * (그 회차의 일부 답변만 남는다). 회차는 통째로 들어오거나 나가야 한다(계약 §3).
 *
 * 형태는 **비상관 semi-join** 이다 — 이 술어가 붙는 문장 다섯 곳 중 일부만 `ca` 를
 * 조인하고 있어서, 조인 존재를 전제하면 나머지에서 42703 이 난다. 서브쿼리 안의
 * `ca` 는 바깥 `ca` 와 다른 스코프라 충돌하지 않는다(바깥 별칭을 참조하지 않으므로
 * 상관도 아니다).
 *
 * 날짜 산술은 `hmg_anchor_today()`(KST 오늘, `date`)에서 뺀다 — `now()` 를 쓰면
 * 세션 TimeZone 을 타고, `round_date` 는 KST 로 굳은 `date` 라 축이 어긋난다.
 */
declare function trendWindowFloor(col?: SQL, jobIdCol?: SQL,
/**
 * 이 문장이 **이미 `ca` 를 조인했는가**(검증 P2). 참이면 semi-join 대신 조인된
 * 컬럼에 범위 술어를 직접 건다 — 앵커 표를 한 번 더 해시할 이유가 없다. 값은 같다
 * (`job_id` 가 PK 라 semi-join 과 조인이 같은 집합을 고른다).
 */
caJoined?: boolean,
/**
 * 이 문장이 **`sv` 조인을 방출했는가**(`trendMirrorJoins().joined`). 거짓이면 함대
 * 게이트는 `ca` 만 참조하는 semi-join 판본으로 간다 — `caJoined` 하나로 묶으면
 * `ca` 만 조인한 호출부가 없는 별칭을 참조해 42P01 로 죽는다(5f5b84e 차단 결함).
 */
svJoined?: boolean,
/**
 * 바닥 일수. 기본은 종전 상수(120)다. **격자가 자리 바닥을 넘기는 호출부**만
 * `trendFloorDays()` 를 실어 격자 상한(180)까지 넓힌다 — 그 주석 참조.
 * 격자가 꺼져 있으면 `trendFloorDays()` 도 120 을 돌려주므로 텍스트가 같다.
 */
windowDays?: number): SQL;
export declare const TREND_HIDDEN_CYCLE_STATUSES: readonly ["open"];
/**
 * 뷰 앵커(V-1)가 아직 오지 않은 회차에 귀속된 run 을 빼는 술어.
 *
 * 규칙 정본은 쓰기 쪽 **V-1**(`lib/summary/generate/swap.ts::publishCycleSql`) 과 읽기 게이트
 * **V-2**(`lib/db/repositories/summary-cycles.ts::cycleViewableSql`) 다. 사실표 경로는 그 둘로
 * 이미 막혀 있었고, 미러 폴백 경로에만 없던 규칙을 여기에 옮긴다:
 *
 *   숨김 ⇔ `COALESCE(view_anchor_at, cycle_anchor_at + 표면 지연) > now()`
 *
 * ⚠️ V-2 와 **문자 그대로 같지는 않다**(2026-09-10 검증자 실측). `view_anchor_at` 이 있는
 *   published 회차에서는 같지만, 없는 회차(closed 141·open 96)에서 V-2 는 무조건 비노출이고
 *   이 술어는 `cycle_anchor_at + 지연` 으로 노출한다. V-2 를 그대로 쓰면 120일 창에서 답변
 *   85,452건(14.6%)이 사라진다 — 미러 폴백은 미발행 회차(백필 대기·분석 갭)의 답변도 보여야
 *   하므로 이 이탈은 의도다. "V-2 로 통일하자"로 되돌리지 말 것.
 * ⚠️ 술어는 `now()` 인데 결과는 `mirrorCache`(`unstable_cache`, TTL 7,200 s — `lib/scope/server.ts`)
 *   에 굳는다. 뷰 앵커 통과 후 최대 2시간(+SWR) 늦게 노출되고, 화면별 캐시 키가 달라 그 사이
 *   화면 간 모수가 다를 수 있다. 즉시 반영이 필요하면 `POST /api/internal/summary/published`.
 * ⚠️ 시간 규칙에는 완결·분석 갭 항이 없다 — 지연이 지났는데 관제가 닫지 않았거나 생성기가
 *   발행하지 않은 회차(미완결·gap > 5%)는 그대로 노출된다. 이것이 상태 규칙과의 트레이드다.
 *
 * · `view_anchor_at` 이 이미 찍힌(published) 회차는 **그 값이 이긴다** — V-1 이
 *   `GREATEST(cycle_anchor_at + 지연, 첫 스왑)` 이라 지연만으로는 재현되지 않는다
 *   (실측: 글로벌 8/31 회차 anchor+2일 = 9/02 인데 `view_anchor_at` 은 9/06).
 * · 표면 지연은 `VIEW_ANCHOR_DELAY`(코어 상수) 에서 **생성**한다 — 리터럴 복사 금지.
 * · 상수가 없는 표면(`project` 등 — 관제 원장에 실재하며 2026-09-10 기준 83개)은 노출
 *   리듬이 정의된 적이 없다. 없는 규칙을 지어내지 않고 **종전 `open` 규칙을 그대로 둔다**
 *   (`TREND_HIDDEN_CYCLE_STATUSES`). 그 표면에 지연이 정해지면 상수에 한 줄 추가하는 것만으로
 *   자동 전환된다 — 이 함수는 안 고친다.
 * · 원장 미적용 환경(0059 전)에서는 `true` 를 돌려준다 = 술어 없음 = **값 무변경**
 *   (`summaryLedgerAvailable()` 프로브 — 앵커·드롭 레지스트리와 같은 자세).
 * · 어느 회차에도 **미귀속**인 run 은 그대로 둔다(관제 반영 지연 ≤20분). 아직 안 온 회차를
 *   감추는 것이 목적이지 "원장에 없으면 숨긴다"가 아니다.
 *
 * 2026-09-10 관제 전수 대조(읽기 전용) — 이 교체로 판정이 바뀌는 회차는 **1개뿐**이다:
 * 글로벌 `9db294d8`(open · runs 1,263) 숨김→노출. 웹사이트 open 94개(anchor 9/10 → +1일 =
 * 9/11 미래)와 project open 2개(폴백)는 숨김 유지, published 631·closed 141 은 전부 무변경.
 *
 * ── **원장 숨김**(0070, 2026-09-10) ────────────────────────────────────────
 * 위 규칙에 사유 하나가 **OR 로** 더 붙는다: `c.hidden_reason IS NOT NULL`.
 *
 *   숨김 ⇔ `hidden_reason IS NOT NULL`  **OR**  <표면별 시각 규칙>
 *
 * · **CASE 밖·앞에 둔다.** 안에 넣으면 표면마다 따로 써야 하고(WHEN 절 3벌 + ELSE),
 *   `project` 처럼 규칙이 정의되지 않은 표면에서 조용히 빠진다. 숨김은 표면과 무관한
 *   사람의 판단이므로 **모든 표면에 동일하게** 걸려야 한다.
 * · 컬럼이 없는 배포(0070 미적용)에서는 절이 통째로 빠진다 — 종전 SQL 과 바이트 동일.
 *   판정은 `hiddenCycleColumnsAvailable()` 이 하고, 이 함수는 이미 async 다.
 * · 이 술어는 **run 단위**다. 숨긴 회차에 귀속된 run 의 답변이 전부 빠지므로, 그 주의
 *   미러 집계는 0 이 아니라 **행 자체가 없어진다** — 그래서 화면이 "골짜기" 대신
 *   빈 슬롯을 보고, 그 자리에 갭 마커를 얹을 수 있다(`hiddenCycleSlots`).
 *
 * ── **숨김 범위**(0071, 2026-09-11) ────────────────────────────────────────
 * 숨김이 계열별로 갈린다. 원장의 `hidden_scope`(NULL = `'all'`)가 "무엇을 숨겼나" 를
 * 말하고, 이 함수의 `family` 가 "누가 읽고 있나" 를 말한다.
 *
 *   family = "citation" → 숨긴 회차는 **범위와 무관하게 전부** 제외
 *   family = "mention"  → `hidden_scope = 'all'` 인 회차만 제외
 *                         (`citations` 범위 회차는 언급 값을 그대로 낸다)
 *
 * · **`family` 에 기본값을 두지 않는다.** `ownedBasePrefixes` 와 같은 "콜사이트 명시
 *   필수" 규율이다 — 새 리더가 조용히 틀린 쪽 기본값을 먹으면 숨겨야 할 인용을
 *   내보내거나(고객 오도) 살려야 할 언급을 지운다. 어느 쪽도 화면만 봐서는 안 보인다.
 * · **시각 규칙(`timeRule`)은 계열과 무관하게 그대로**다. 아직 노출일이 안 온 회차는
 *   언급이든 인용이든 보이면 안 된다 — 그건 품질이 아니라 시간의 문제다.
 * · 0071 미적용(`hiddenCycleScopeAvailable() === false`)이면 두 계열의 SQL 이 **서로
 *   같고**, 0070 만 적용된 종전 SQL 과 **문자열 동일**이다(교차 배포 내성).
 */
export type HiddenCycleFamily = "mention" | "citation";
export declare function excludeHiddenCycleRuns(runIdCol: SQL, family: HiddenCycleFamily,
/**
 * 앵커 축에서 게이트를 **답변 단위**로 옮기기 위한 job_id 표기(계약 §3).
 *
 * 없으면 앵커 축에서도 종전 run 단위 게이트로 간다 — 조용히 틀리는 방향이 아니라
 * "축 전환이 덜 됐다"는 방향이라 안전하지만, 그 자리는 보고 대상이다.
 */
jobIdCol?: SQL,
/**
 * `job_id` 가 없는 표(ACR 롤업)용 **run 축** 앵커 게이트. `jobIdCol` 이 있으면
 * 그쪽이 이긴다(답변 단위가 더 정확하다).
 */
anchorRunIdCol?: SQL): Promise<SQL>;
/**
 * **계열 델타 술어**(0071) — 이미 `excludeHiddenCycleRuns(…, "mention")` 로 걸러진 행
 * 집합에서 **인용 계열이 추가로 빼야 할** run 을 뺀다.
 *
 *   mention 술어 = 제외( hidden ∧ scope='all' )  ∪ 제외( timeRule )
 *   citation 술어 = 제외( hidden )               ∪ 제외( timeRule )
 *   차집합       = 제외( hidden ∧ scope='citations' )   ← 이 함수
 *
 * 즉 `mention 술어 AND 이 술어` ≡ `citation 술어` 다(항등 — 통계적 근사가 아니다).
 *
 * 왜 ⑤ 에서 `excludeHiddenCycleRuns(…, "citation")` 을 그대로 쓰지 않는가:
 * 그 술어는 표면별 `CASE` 시각 규칙을 통째로 안고 있고, ⑤ 는 **행 수가 답변이 아니라
 * 인용**이다(전 이력 allRuns — 수십만 행). 콜드 로드 최대 비용 문장(2026-09-01 실측
 * 3,912 ms)에 표면 CASE 를 행마다 다시 얹는 것은 피한다. 이 술어의 내부 집합은
 * `hidden_scope='citations'` 인 회차의 run 뿐이라 오늘 실측으로 **416 run**이다.
 *
 * 프로덕션 EXPLAIN (ANALYZE, BUFFERS) — ⑤ c2 형태 프록시(TEMP 대신 MATERIALIZED CTE,
 * 루트 무필터 120일, 3회):
 *   · 술어 없음(오늘)      3,297.7 / 3,193.3 / 3,187.0 ms  → 중앙값 **3,193 ms**
 *   · 술어 있음(0071 후)   2,435.6 / 2,409.7 / 3,079.8 ms  → 중앙값 **2,436 ms**
 * 플래너가 `Hash Anti Join (Hash Cond: a.run_id = cr.run_id)` 로 접는다 — 416행 해시
 * 하나를 만들고 끝이라 행마다 재평가하지 않는다(`summary_cycle_runs_run_id_key` UNIQUE).
 * 8/24 인용 행이 집계 전에 빠지므로 **오히려 빨라진다**. TEMP 테이블 경로의 실제 문장은
 * 읽기 전용 하네스에서 EXPLAIN 할 수 없어(read-only tx 는 TEMP 생성 불가) 이 프록시가
 * 근거의 한계다 — 배포 후 `chunk-trace` 로 재확인할 것.
 *
 * 0071 미적용이면 `sql\`true\`` = 절 없음(종전 SQL 과 동일). 0070 미적용도 마찬가지다 —
 * 범위 컬럼이 있는데 사유 컬럼이 없는 상태는 0071 의 가드가 만들어질 수 없게 막는다.
 */
export declare function excludeCitationOnlyHiddenRuns(runIdCol: SQL): Promise<SQL>;
/** 주 격자 키의 원천. `measured` = 종전(측정시각 주) · `cycle` = 원장 회차 주. */
export type TrendWeekSource = "measured" | "cycle";
/**
 * 실제로 적용된 원천. `anchor` 는 앵커 축(0077 `ca.anchor_week`)이고 **요청과 무관하게**
 * 축 판정이 켜져 있으면 그것이 이긴다 — 한 요청 안에서 카드와 추이가 다른 시계를
 * 보면 안 되기 때문이다.
 */
export type TrendWeekApplied = TrendWeekSource | "anchor";
export interface TrendWeekKey {
    /** `FROM scope_answers a …` 뒤에 그대로 이어 붙이는 조인 조각. `measured` 면 빈 SQL. */
    join: SQL;
    /** 주 격자 키 식 — 종전 `date_trunc('week', a.measured_at)` 이 있던 자리에 그대로 쓴다. */
    key: SQL;
    /** 실제로 적용된 원천. 원장 미적용 환경에서는 `cycle` 을 요청해도 `measured` 다. */
    applied: TrendWeekApplied;
    /**
     * 측정 폴백(원장 미귀속 run · 원장 미적용 · `measured` 요청)의 **표면 격자**
     * (2026-09-28 main #300 — `mirrorWeekKey` 머리 주석). 글로벌 = `anchorKst`(회차 앵커의
     * KST 주), 웹사이트·프로젝트 = `measured`(종전 식 문자 그대로). 앵커 축이면 쓰이지 않는다.
     */
    grid: MirrorWeekGrid;
}
/**
 * 주 격자 키 조각. `measured` 는 **종전 식과 문자 그대로 같다**(문장 텍스트 무변경 →
 * pg_stat_statements 정규화 텍스트도 그대로라 배포 전후 비교가 성립한다).
 *
 * `cycle` 은 타입을 `date` 로 고정한다 — 종전 `date_trunc('week', timestamptz)` 는
 * **세션 TZ 의존**이고 `cycle_week` 는 `date` 라, 둘을 `COALESCE` 로 섞으면 암묵 캐스트가
 * 세션 TZ 를 탄다. 양쪽을 `::date` 로 맞춰 `to_char(…, 'YYYY-MM-DD')` 결과를 TZ 무관하게 둔다.
 * (UTC 세션에서 두 식의 출력은 같다 — 즉 폴백 경로의 값은 종전과 동일하다.)
 */
export declare function trendWeekKey(source: TrendWeekSource,
/**
 * 측정 폴백의 표면 격자(2026-09-28 main #300) — 호출부가 `mirrorWeekGridFor(projectCtx)`
 * 로 넘긴다. 생략 = `measured`(종전 식 문자 그대로)라 웹사이트·프로젝트·드릴다운은
 * 인자를 안 넘겨도 문장이 종전과 같다.
 */
grid?: MirrorWeekGrid,
/** 답변 테이블 별칭. 조인 별칭은 충돌을 피해 `_cw*`·`_wk*` 로 고정한다. */
answerAlias?: string): Promise<TrendWeekKey>;
/** 자리 × 엔진 하나. 필드 이름은 `StandardTrendBucket` 의 같은 이름과 같은 뜻이다. */
export interface StandardTrendEnginePoint {
    engine: string;
    answers: number;
    trackedAnswers: number;
    totalMentions: number;
    trackedMentions: number;
    sentMentions: number;
    positiveMentions: number;
    /** 서수 합·개수 — 평균은 소비자가 나눈다(평균의 평균 금지). */
    rankSum: number;
    rankedAnswers: number;
}
export interface StandardTrendBucket {
    bucketStart: string;
    /**
     * **회차 버킷 표시자**(PR③). 집계층 경로(`summaryWebsiteTrend`·글로벌
     * `summary-global-trend-read`)만 채운다 — 미러 경로는 항상 `undefined` 다. 값이 있으면
     * 이 버킷의 x 는 `date_trunc(unit, measured_at)` 주/일 격자가 아니라 **회차 anchor** 다.
     *
     * 화면 계약: 값이 있으면 `fillGaps`/`fillTrendGaps` 를 **건너뛴다** — 회차가 없는 주는
     * 점이 없는 것이 맞고(주 격자로 채우면 없던 자리를 만든다), 한 주에 회차가 둘이면 점도
     * 둘이다. Δ 는 `applyTrendDeltas` 그대로(값 있는 마지막 두 점 = **직전 회차 대비**).
     * 축이 바뀌었다는 사실을 화면까지 나르는 유일한 신호라, 값(anchor ISO)을 겸한다.
     */
    cycleAnchorAt?: string;
    /**
     * **축 on 의 x축 라벨 날짜**(`round_date`, `YYYY-MM-DD`). 버킷 키(`bucketStart`)는
     * 주 격자(`anchor_week`, 월요일)인데 화면이 찍어야 하는 날짜는 그 회차의 **귀속
     * 날짜**다 — website 는 금요일이라 둘이 다르다(글로벌은 같다).
     *
     * 달력에서 고르는 날짜 · 카드 기준일 · 추이 라벨이 같은 날짜여야 한다는 것이 이
     * 전환의 목적이다(2026-09-20 관찰: website 마지막 점 `9. 14.` vs 기준일 `09-11`).
     * 축 off 면 `undefined` = 종전 라벨 규칙.
     */
    roundDate?: string;
    /**
     * **수집 오류 회차 표시자**(2026-09-10). 값이 있으면 이 버킷은 수집이 깨진 회차라
     * 화면이 측정값 대신 음영 + 안내 문구를 낸다. 측정값 필드는 전부 `null` 이어야 한다
     * (계약 정본: lib/viz/trend-gap.ts).
     */
    gap?: TrendGap;
    /**
     * **공용 추이 격자(D5)가 만든 자리인가**(2026-09-20). 배열 전체가 이 표식을 가지면
     * 화면은 자기 채움(`fillGaps`/`fillTrendGaps`)을 건너뛴다 —
     * `lib/period/trend-grid-axis.ts::isTrendGridApplied`.
     *
     * ⚠️ 판정을 **스위치가 아니라 데이터**로 두는 이유가 계약이다. 키가 켜져 있어도 격자를
     *    안 얹는 경로가 둘 있다(일 버킷 · 자리를 못 세운 경우). 스위치로 물으면 그 두
     *    경로에서 종전 채움이 통째로 사라진다.
     */
    gridSlot?: true;
    /**
     * **엔진 분해**(2026-09-20). 사실표 경로(`toSeries`)만 채운다 — 미러는 `undefined`.
     *
     * 있으면 엔진별 라인도 히어로 주 계열과 **같은 배열·같은 자리·같은 갭 판정**을 쓴다.
     * 없으면 그 차트는 종전 미러 버킷으로 간다 = 한 차트 안에서 원천이 섞이지 않는다.
     * 직렬화 가능한 배열이다(`unstable_cache` 셀 규약 — Map 금지).
     */
    engines?: StandardTrendEnginePoint[];
    answers: number;
    trackedAnswers: number;
    totalMentions: number;
    trackedMentions: number;
    sentMentions: number;
    positiveMentions: number;
    avgPosition: number | null;
    totalCitations: number;
    ownedCitations: number;
    /**
     * **글로벌 ⑤ 분자**(제품 책임자 2026-09-29) — 출처 카테고리 `Official (HMG)` 인용 수.
     * 글로벌 리더(사실표 `toSeries` · 미러 `aggregateStandardTrendFromMirror` 의 글로벌 호출)만
     * 싣는다. website·project 추이에는 없고 ⑤ 는 종전 `ownedCitations` 다.
     * 소비는 `lib/kpi/overview-card-values.ts::citationShareNumerator` 로만.
     */
    officialHmgCitations?: number;
    measuredDays: number;
    firstAt: string | null;
    lastAt: string | null;
}
export declare function aggregateStandardTrendFromMirror(filters: StandardFilters | undefined, unit: BucketUnit | undefined, projectCtx: string | string[] | undefined, ownedBasePrefixes: string[], ownedSiblingUniverse?: string[], websiteTargetsOwned?: boolean, budget?: AnswerSetBudget, ownedUnits?: readonly WebsiteOwnedUnit[], officialGroupKeys?: readonly string[]): Promise<StandardTrendBucket[]>;
/** 테스트 전용 — 프로세스 상태를 초기화한다. */
export declare function __resetIsKoreanColumnStateForTests(): void;
/** 테스트 전용 — full-cycle 게이트 서브쿼리를 창 술어와 함께 그대로 컴파일한다(PGlite 실행용). */
export declare function __rootFullCycleAnswerIdsForTests(rootScopeR: SQL, windowPredicate: SQL): SQL;
export declare function snapshotRunFilter(scopeProjectId: string | string[] | undefined, f: StandardFilters, onlyBrand?: string,
/** 숨김 게이트 계열 — 카드와 같은 값을 내야 하므로 호출부가 화면 계열을 넘긴다. */
family?: AnchorHiddenFamily): SQL;
interface MirrorAnswerMeta {
    jobId: string;
    promptId: string | null;
    target: string;
    region: string | null;
    status: string | null;
    measuredAt: Date | null;
    roundDate?: string | null;
    anchorWeek?: string | null;
    measuredAtOrig?: string | null;
    isDefaultEngine?: boolean | null;
    viewAnchorDate?: string | null;
}
declare function readMirrorAnswerMeta(runFilter: SQL, db?: MirrorReader): Promise<MirrorAnswerMeta[]>;
declare function buildMirrorJobs(answers: MirrorAnswerMeta[], mentionsByJob: Map<string, ResolvedMention[]>): AnchoredJob[];
/** 미러 투영·측정 기준일 라우터의 SQL 텍스트를 고정하기 위한 테스트 진입점. */
export declare const __testables: {
    readMirrorAnswerMeta: typeof readMirrorAnswerMeta;
    buildMirrorJobs: typeof buildMirrorJobs;
    trendWindowFloor: typeof trendWindowFloor;
    trendFloorDays: typeof trendFloorDays;
    weeklyTopNTrendFloor: typeof weeklyTopNTrendFloor;
    cycleAsOfRowSql: typeof cycleAsOfRowSql;
    cycleAsOfSql: typeof cycleAsOfSql;
    cycleAsOfDisplaySql: typeof cycleAsOfDisplaySql;
    anchorAsOfJoinSql: typeof anchorAsOfJoinSql;
    normalizeAsOf: typeof normalizeAsOf;
    kpiTabTrendAxis: typeof kpiTabTrendAxis;
    kpiTabCellSnapshot: typeof kpiTabCellSnapshot;
    trendServableJoinSql: typeof trendServableJoinSql;
    trendServableJoinedPred: typeof trendServableJoinedPred;
};
/**
 * 주별 Top-N 두 리더(`readCitationDomainDayCounts`·`readMentionBrandDayCounts`)의
 * **창 바닥 — 한 벌**. 테스트가 리더와 같은 것을 컴파일할 수 있게 `__testables` 로 낸다.
 *
 * ── 왜 인자로 받는가 (통합 검증 B1, 2026-09-20 2차) ────────────────────────
 *
 * 이 두 리더의 산출물은 **주 격자에 얹힌다**(`withWeeklyTrendGrid`). 그런데 리더 자신은
 * 자기 출력이 격자에 갇히는지 알 수 없다 — 같은 함수가 격자 밖에서도 불릴 수 있다.
 * 그래서 **호출부가 그 사실을 인자로 명시**하고 리더는 추측하지 않는다.
 *
 * ⚠️ 이 한 줄이 없으면 수리가 반쪽이다. 호출부가 `withTrendGridWindow` 로 `dateFrom = S0`
 *    를 심어도, 여기 바닥이 120 이면 두 하한이 **AND** 라 **좁은 쪽이 이긴다**:
 *    `S0 < 오늘 − 120` 인 구간(= B1 의 정의)에서는 여전히 120일에서 잘린다. 1차 수리의
 *    "120 은 그보다 넓은 바깥 창일 뿐" 이라는 판단이 바로 그 지점에서 틀렸다
 *    (검증자 SQL 컴파일 실측: `ca.round_date >= hmg_anchor_today() - 120` AND
 *     `ca.round_date >= '2026-04-23'::date` → 실효 하한 `T-120`).
 *
 * 격자 off 에서는 `trendFloorDays` 가 단위와 무관하게 120 이라 **텍스트가 종전과 동일**하다.
 */
declare function weeklyTopNTrendFloor(onTrendGrid: boolean, caJoined?: boolean): SQL;
/**
 * 위 문장 본체 — **컴파일된 SQL 을 단언하기 위해** 떼어 놓은 순수 빌더다(`ROLLUP_NAMES`
 * 를 export 한 것과 같은 이유: 소스 grep 가드는 포맷 변경에 뚫린다).
 *
 * ⚠️ 주 격자 키 `wk.key` 가 **세 자리에 같은 식**으로 들어간다 — `DISTINCT ON` ·
 *    선택 리스트 · `ORDER BY`. 셋 중 하나만 바꾸면 dedup 격자와 표시 격자가 갈려
 *    한 셀이 두 점에 실리거나(그래프가 부풀고) `DISTINCT ON` 이 문법 오류가 된다.
 *    그 셋을 `scope-aggregates.mention-trend-week.sql.test.ts` 가 고정한다.
 */
export declare function mentionBrandDayCountsQuery(p: {
    filters: StandardFilters;
    wk: TrendWeekKey;
    trendFloor: SQL;
    answerWhere: SQL;
    notHidden: SQL;
    seriesClause: SQL;
}): SQL;
export declare const CITATION_OFFICIAL_DRILLDOWN_MAX = 250;
export declare const CITATION_OFFICIAL_TAIL_URLS = 5;
export declare function slimMentionsLiveForCache(live: MentionsLive): MentionsLive;
export declare function slimCitationsLiveForCache(live: CitationsLive): CitationsLive;
export declare function slimBrandCitationDomainsForCache(domains: CitationDomainLive[]): CitationDomainLive[];
export declare function aggregateMentionsFromMirror(filters?: StandardFilters, scopeProjectId?: string | string[], brandPrompts?: "all" | "none" | {
    onlyBrand: string;
}, budget?: AnswerSetBudget, weekSource?: TrendWeekSource): Promise<MentionsLive | null>;
/**
 * 필터가 걸린 **카탈로그 프롬프트 수**("적용 프롬프트") — 측정 개요 카드용.
 *
 * 미러(측정된 것)가 아니라 카탈로그(측정 대상)를 센다: "적용 233 / 측정 230 /
 * 미측정 3"의 첫 칸이 이 값이고, 미측정은 두 수의 차다. 카탈로그는 수백 행
 * 규모라 스캔이 상수급이다(미러 집계와 달리 timeout 가드가 필요 없다).
 *
 * **비교 상대는 카드의 "측정" 칸**, 즉 `aggregateSubKpisFromMirror` → `answerWhere`
 * 다(2026-09-01 재검증 C6 — 종전 주석이 상대를 `detailAnswerWhere` 로 잘못 지목했다).
 * 두 경로는 같은 카탈로그 컬럼을 본다: `answerWhere` 의 퍼널은
 * `catalogIn("funnel_stage", …)` 로 **카탈로그 `prompts.funnel_stage`** 이고
 * (2026-06-10 D6 — HMG 3단계 한국어 어휘가 정본), 이 카운트도 같은 컬럼을 쓴다.
 * 따라서 이 카드의 두 수 사이에 퍼널 해석 차이는 없다.
 *
 * **프롬프트 축은 빠짐없이 반영해야 한다.** 2026-09-01 실측: 퍼널(promptContext)이
 * 카운트 쪽에만 빠져 있어, 퍼널을 고르면 "적용"은 그대로인데 "측정"만 줄어
 * **미측정이 통째로 부풀려졌다**. 퍼널은 필터 바의 프롬프트 행
 * (FILTER_SECTIONS.prompt)이므로 이 카운트에도 걸려야 한다.
 *
 * `deleted_at` 은 **일부러 걸지 않는다** — 두 상대 경로의 카탈로그 semi-join 에도
 * 없다. 한쪽에만 걸면 소프트삭제 행만큼 모집단이 어긋난다. 소프트삭제를 실제로
 * 제외하려면 세 경로를 함께 바꿔야 한다(후속).
 *
 * 답변 축(지역·엔진·기간)은 계속 무시한다 — 그 축들은 "이 프롬프트가 카탈로그에
 * 있는가"가 아니라 "측정이 있었는가"만 바꾼다. 대신 그 축이 걸린 화면은
 * 뺄셈을 멈추고 문구를 바꾼다(`hasAnswerOnlyAxes` / `promptCoverage`).
 */
/** exported for tests (SQL 텍스트 검증) — 런타임 호출부는 아래 카운트 하나뿐. */
export declare function catalogPromptCountWhere(filters: StandardFilters, projectCtx?: string | string[]): SQL;
export declare function countCatalogPromptsFromCatalog(filters?: StandardFilters, projectCtx?: string | string[]): Promise<number | null>;
export interface UnmeasuredPrompt {
    id: string;
    text: string;
    listType: string | null;
    depth1: string | null;
    depth2: string | null;
    funnelStage: string | null;
}
/**
 * 미측정 프롬프트 목록(2026-09-02 피그마 1:1 — 측정 개요 카드 "미측정" 모달).
 * 적용 = 카탈로그(countCatalogPromptsFromCatalog 와 같은 술어), 측정 = 스냅샷 답변셋에
 * 답변이 있는 prompt_id. 차집합이 미측정이다 — 카드의 "적용 − 측정" 과 같은 정의.
 * 답변 축(지역·엔진·기간)이 걸리면 "그 조건에서 안 잡힌 것"이지 미측정이 아니므로
 * 호출부(카드)가 conditional 이면 이 목록을 열지 않는다.
 */
export declare function listUnmeasuredPromptsFromCatalog(filters?: StandardFilters, projectCtx?: string | string[], opts?: {
    limit?: number;
    statementTimeoutMs?: number;
    budgetMs?: number;
}): Promise<{
    total: number;
    rows: UnmeasuredPrompt[];
} | null>;
export declare function detailAnswerWhere(f: StandardFilters, projectCtx?: string | string[], opts?: {
    allRuns?: boolean;
    hiddenFamily?: AnchorHiddenFamily;
}): SQL;
export declare function citationOwnedClause(ownedBasePrefixes: string[], ownedSiblingUniverse?: string[], targetOwned?: {
    projectCtx: string | string[] | undefined;
    filters: StandardFilters;
    enabled: boolean;
}): SQL;
export declare function citationOwnedBaseSql(ownedBasePrefixes: string[]): SQL;
export interface CitDomainGroupRow {
    domain: string;
    category: string | null;
    target: string;
    citations: number;
    owned: boolean;
    owned_citations: number;
}
export interface CitDomainStatRow {
    domain: string;
    citing_answers: number;
    prompts: number;
}
export interface CitUrlRow {
    domain: string;
    url: string;
    title: string | null;
    prompt_text: string | null;
    cites: number;
    targets: string[];
}
export interface CitPromptRow {
    domain: string;
    prompt_id: string;
    text: string | null;
    funnel: string | null;
    cites: number;
    owned_cites: number;
    targets: string[];
}
export interface CitPromptRefRow {
    domain: string;
    prompt_id: string;
    job_id: string;
    target: string;
    region: string | null;
    cites: number;
}
export interface CitSplitPromptRow {
    prompt_id: string;
    text: string | null;
    funnel: string | null;
    cites: number;
    targets: string[];
    owned: boolean;
    bucket_total: number;
}
export interface CitSplitRefRow {
    prompt_id: string;
    job_id: string;
    target: string;
    region: string | null;
    cites: number;
}
/** 도메인 단위 롤업 한 줄 — 인용수·자사 여부·대표 카테고리. */
export interface CitationDomainAgg {
    citations: number;
    isOurs: boolean;
    /** 대표 카테고리 = 인용수 최다 그룹의 분류(동률 시 먼저 집계된 것). */
    category: string | null;
}
/**
 * SQL 롤업 행 → 도메인 단위 집계. `foldCitationsLive`(화면 행·배지)와 미러
 * 집계의 드릴다운 대상 선정이 **같은 함수**를 보게 하려고 따로 뺐다 — 도메인의
 * 대표 카테고리를 두 곳에서 각자 계산하면 "배지는 공식 (HMG) 인데 드릴다운은
 * 비어 있다" 는 어긋남이 조용히 생긴다(2026-09-16 고객 QA 대응).
 *
 * `sourceCats` 는 행 단위 분류 필터로, 두 호출부가 같은 지점에서 적용한다.
 */
export declare function citationDomainRollup(groups: CitDomainGroupRow[], overrides: CitationOverrideMap | undefined, sourceCats: ReadonlySet<string> | null): Map<string, CitationDomainAgg>;
/** 드릴다운 fetch 대상 선정 결과. */
export interface CitationDrilldownSelection {
    /** SQL IN 리스트 — 상위 N + 공식 꼬리 (이 순서). */
    domains: string[];
    /** 상위 N 안 — urls + promptList 를 싣는다. */
    top: string[];
    /** 상위 N 밖 공식(HMG) — URL 샘플만 싣는다. */
    officialTail: string[];
    /** 공식이지만 상한(officialMax) 초과로 드릴다운을 못 실은 도메인. */
    officialOmitted: string[];
}
/**
 * 인용 드릴다운을 가져올 도메인 선정 — **순수 함수**.
 *
 * `상위 top개 ∪ (상위 밖 공식(HMG) 최대 officialMax개)`. 공식 합집합이 곧
 * 2026-09-16 고객(GGMD) 요구("인용 수와 상관 없이 공식 도메인이면 샘플 URL도
 * 제공")의 집행 지점이라, 인라인으로 두지 않고 따로 뺐다 — 이 술어가 조용히
 * 무력화되면(예: officialMax=0) 고객 요구가 그대로 사라지는데 SQL 안에 섞여
 * 있으면 테스트가 닿지 않는다.
 *
 * `ranked` 는 인용수 desc · 도메인 asc 로 이미 정렬된 도메인 롤업이다.
 * 수치(citations·share·prompts·coverage)는 이 선정과 무관하게 groups/stats
 * 전량에서 나오므로 어떤 값을 넘겨도 영향이 없다.
 */
export declare function selectCitationDrilldownDomains(ranked: ReadonlyArray<readonly [string, CitationDomainAgg]>, top: number, officialMax: number): CitationDrilldownSelection;
export declare function foldCitationsLive(input: {
    sampledAnswers: number;
    groups: CitDomainGroupRow[];
    stats: CitDomainStatRow[];
    urls: CitUrlRow[];
    promptRows: CitPromptRow[];
    promptRefs: CitPromptRefRow[];
    split: {
        rows: CitSplitPromptRow[];
        refs: CitSplitRefRow[];
    } | null;
    filters: StandardFilters;
    overrides?: CitationOverrideMap;
    drilldownOmitted?: readonly string[];
}): CitationsLive;
export declare function aggregateCitationsFromMirror(filters: StandardFilters | undefined, scopeProjectId: string | string[] | undefined, ownedBasePrefixes: string[], ownedSiblingUniverse?: string[], websiteTargetsOwned?: boolean, budget?: AnswerSetBudget, ownedUnits?: readonly WebsiteOwnedUnit[]): Promise<CitationsLive | null>;
export interface SourceDomainSlice {
    domain: string;
    citations: number;
    share: number;
    isOurs: boolean;
}
export declare function aggregateSourceCompositionFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, ownedBasePrefixes: string[], ownedUnits?: readonly WebsiteOwnedUnit[]): Promise<SourceDomainSlice[]>;
export interface GeoBrandMention {
    code: string;
    brand: string;
    mentions: number;
    isTracked: boolean;
    /**
     * 명부 제외 엔티티(entity_registry role='excluded') 표식: 집계가 아니라 게이트웨이가
     * **캐시 밖에서** 단다(`lib/scope/excluded-brands.ts::markExcludedGeo`). 행을 빼지 않는
     * 이유: 시장 SOV 분모가 이 행들의 합이다. 소비자는 최대 경쟁사·순위 모수에서만 건너뛴다.
     */
    excluded?: boolean;
}
export declare function aggregateGeoCompetitionFromMirror(filters?: StandardFilters, projectCtx?: string | string[], budget?: AnswerSetBudget): Promise<GeoBrandMention[]>;
export declare const SIGNAL_COLUMNS: {
    readonly positive: "sentiment_positive";
    readonly neutral: "sentiment_neutral";
    readonly mixed: "sentiment_mixed";
    readonly negative: "sentiment_negative";
    readonly mention: "type_mention";
    readonly recommendation: "type_recommendation";
    readonly comparison: "type_comparison";
    readonly definition: "type_definition";
    readonly final_choice: "type_final_choice";
};
export type SignalKey = keyof typeof SIGNAL_COLUMNS;
export declare const isSignalKey: (v: string) => v is SignalKey;
export declare function aggregateSignalPromptsFromMirror(signal: SignalKey, filters?: StandardFilters, projectCtx?: string | string[]): Promise<MentionsPromptLive[]>;
/**
 * 답변 단위 브랜드 스탠스 분포 (0072 · 우호도 탭의 **답변 축** 카드).
 *
 * ⚠️ 발생 단위 감정 분포(`aggregateMentionsHeadlineSql` 의 `sig`)를 **대체하지 않는다.**
 * 두 축은 세는 단위가 다르다:
 *   · 발생 축 = 언급 발생마다 1 신호. 한 답변이 브랜드를 5번 언급하면 5.
 *   · 답변 축 = (답변 × 브랜드) 1행. 같은 답변·같은 브랜드면 언제나 1.
 * 그래서 두 숫자를 더하거나 한 차트에 섞지 않고, 화면이 축을 라벨로 말한다(스펙 R6).
 *
 * 당사 판정은 미러의 `is_tracked`(코어 판정)가 아니라 이 파일의 단일 정본
 * `trackedRollupPredicate` 를 쓴다 — 단위 컨텍스트(프로젝트 brand)·자사 명부·표기
 * 접두 교정이 전부 거기 있고, 우호도 히어로(Q3)와 같은 술어여야 두 지면이 안 갈린다.
 *
 * 반환 null = 스탠스 축이 이 배포에 없다(테이블 미적용) 또는 루트 미설정.
 * 행 0건은 null 이 아니라 `pairs: 0` 이다 — 화면이 "측정 대기"와 "0건"을 구분한다.
 */
export interface AnswerStanceDistribution {
    positive: number;
    neutral: number;
    mixed: number;
    negative: number;
    /**
     * 4계열 합 = 이 회차의 (답변 × 브랜드) 쌍 수. WU8 AC3 의 SQL 대조 대상.
     *
     * ⚠️ **턴은 접는다.** 미러 행의 단위는 (답변 × 턴 × 브랜드)이고 2턴 답변(ACR
     * 후속 선택)이 라이브의 8.2% 다 — 그대로 세면 그 답변들이 두 번 계상되어
     * "답변 × 브랜드" 라는 이 지표의 정의가 깨진다(검증자 F2). 대표 턴 규칙은
     * **가장 낮은 turn_index**(= 본답변)다: ACR 2턴은 강제 선택 후속이라 답변 전체의
     * 태도를 대표하지 않고, 규칙이 결정적이어야 같은 필터가 같은 수를 낸다.
     */
    pairs: number;
}
export declare function aggregateAnswerStanceDistributionFromMirror(filters?: StandardFilters, projectCtx?: string | string[],
/**
 * 문장 상한 + 전체 벽시계 예산. 실효 최악 = budgetMs + statementTimeoutMs
 * (`aggregateTypeKpiFromMirror` 와 같은 모양). 없으면 문장 상한도 마감도 없어서
 * 느린 조합이 `kpiDegrade` 에 안 잡히고 우호도 탭 전체가 에러가 된다(검증자 F7).
 */
opts?: {
    statementTimeoutMs?: number;
    budgetMs?: number;
}): Promise<AnswerStanceDistribution | null>;
export declare function aggregateBrandCitationsFromMirror(brandName: string, filters?: StandardFilters, scopeProjectId?: string | string[]): Promise<CitationDomainLive[]>;
export declare function listMeasuredRegions(scope?: {
    all?: boolean;
    brands?: string[];
    countries?: string[];
    regions?: string[];
}, projectIds?: string[], rootScoped?: boolean, dateRange?: {
    dateFrom?: string;
    dateTo?: string;
}): Promise<string[]>;
export interface MeasuredScopeCombo {
    brand: string | null;
    region: string;
    lang: string | null;
}
export declare function listMeasuredScopeMatrix(scope?: {
    all?: boolean;
    brands?: string[];
    countries?: string[];
    regions?: string[];
}, dateRange?: {
    dateFrom?: string;
    dateTo?: string;
}): Promise<MeasuredScopeCombo[]>;
export declare function listMeasuredStandardLanguages(scope?: {
    all?: boolean;
    brands?: string[];
    countries?: string[];
    regions?: string[];
}, countryFilter?: string[], dateRange?: {
    dateFrom?: string;
    dateTo?: string;
}): Promise<string[]>;
export declare function listMeasuredAcrLanguages(scope?: {
    all?: boolean;
    brands?: string[];
    countries?: string[];
    regions?: string[];
}, countryFilter?: string[],
/**
 * 측정 창(검증 P3). 종전에는 이 인자가 없어 축 on 에서 옵션이 **항상 최신 회차
 * 하나**였다 — 기간을 건 화면의 데이터는 그 기간의 회차 전부라 1:1 이 깨진다.
 */
dateRange?: {
    dateFrom?: string;
    dateTo?: string;
}): Promise<string[]>;
export declare function listMeasuredEngines(projectIds: string[], f?: StandardFilters): Promise<string[]>;
export interface MirrorAnswerDetail {
    available: boolean;
    answerText?: string;
    measuredAt?: string | null;
    citations?: {
        url: string | null;
        domain: string | null;
        title: string | null;
        category: string | null;
    }[];
    brandMentions?: {
        name: string;
        count: number;
        tracked: boolean;
    }[];
    modelMentions?: {
        name: string;
        count: number;
        brand: string | null;
    }[];
    sentiment?: {
        spans: SentimentSpan[];
        skipped: number;
    };
    stances?: AnswerStanceView[];
}
/** 답변 모달의 브랜드 스탠스 태그 1개. */
export interface AnswerStanceView {
    /**
     * 답변 턴 인덱스. **뷰에 반드시 실린다** — 미러 PK 는 (job, turn, entity)인데
     * 뷰에서 턴을 떨어뜨리면 2턴 답변(ACR)에서 같은 브랜드가 두 번 나오면서
     * "브랜드가 중복된 배지"로 보이고 React key 도 충돌한다. 라이브 실측(2026-09-14
     * 검증자): 2턴 답변이 전체의 **8.2%**(52,698/642,521).
     */
    turnIndex: number;
    entityId: string;
    /** 표시명 — 멘션 사전(brandById)으로 해소 후 정본 표기로 정규화. 없으면 미러의 brand_label. */
    brand: string;
    tracked: boolean;
    stance: "positive" | "negative" | "mixed" | "neutral";
    confidence: number | null;
    evidenceText: string | null;
    /**
     * **미러 원문과 실제로 대조한 결과**(검증자 F5). 코어가 오프셋을 줬다는 사실이
     * 아니라 이 판정이 화면 문구를 결정한다:
     *   verified    — 원문에서 확인됨(원문 위치를 주장해도 되는 유일한 상태)
     *   mismatch    — 대조했는데 원문에 없다 = 코어 인용의 문제
     *   unavailable — 대조 자체 불가(그 턴의 원문이 미러에 없다 — turn>0)
     * 파일럿 실측: 완전일치 79.2% · 불일치 8.6%. 산식 정본은 `verifyStanceEvidence`.
     */
    evidenceMatch: StanceEvidenceMatch;
    reason: string | null;
}
export declare function getMirrorAnswerBody(jobId: string, f?: StandardFilters, opts?: {
    runProjectIds?: string | string[];
}): Promise<MirrorAnswerDetail>;
export interface MirrorStatus {
    totalAnswers: number;
    measuredAnswers: number;
    distinctWeeks: number;
    distinctDays: number;
    firstMeasuredAt: string | null;
    lastMeasuredAt: string | null;
    mentionRows: number;
    citationRows: number;
    trackedMentionRows: number;
    brandSample: Array<{
        brand: string;
        rows: number;
    }>;
}
export declare function getMirrorStatus(): Promise<MirrorStatus>;
export interface CitationAccuracyResult {
    ownedAnswers: number;
    targetAnswers: number;
    rate: number | null;
}
export interface CitationAccuracyTrendBucket {
    bucketStart: string;
    ownedAnswers: number;
    targetAnswers: number;
    rate: number | null;
    measuredDays: number;
    firstAt: string | null;
    lastAt: string | null;
}
export declare function aggregateCitationAccuracy(filters: StandardFilters, trackedUrls: string[], ownedPrefix?: string, scopeProjectId?: string): Promise<CitationAccuracyResult>;
export declare function aggregateCitationAccuracyTrend(filters: StandardFilters, trackedUrls: string[], unit?: BucketUnit, ownedPrefix?: string, scopeProjectId?: string): Promise<CitationAccuracyTrendBucket[]>;
export declare function websiteDeclaredOwnedBases(filters: StandardFilters, scopeProjectIds: string[]): Promise<{
    prefixes: string[];
    universe: string[];
}>;
export declare function websiteOwnedUnits(): Promise<WebsiteOwnedUnit[]>;
export declare function aggregateWebsiteCitationAccuracy(filters: StandardFilters, scopeProjectIds: string[], ownedBasePrefixes?: string[], ownedSiblingUniverse?: string[], ownedUnits?: readonly WebsiteOwnedUnit[]): Promise<CitationAccuracyResult>;
export interface WebsiteTargetHitRateResult {
    hitPrompts: number;
    ownedPrompts: number;
    measuredPrompts: number;
    rate: number | null;
    ownedRate: number | null;
}
export declare function aggregateWebsiteTargetHitRate(filters: StandardFilters, scopeProjectIds: string[], ownedBasePrefixes?: string[], ownedSiblingUniverse?: string[], ownedUnits?: readonly WebsiteOwnedUnit[]): Promise<WebsiteTargetHitRateResult>;
/**
 * 자사·타겟 URL 인용률(GGMD-61)의 **job 단위 플래그**: 사실표(`summary_url_hits`, 0081)
 * 생성기가 굳히는 값. 바로 위 `aggregateWebsiteTargetHitRate` 의 **유닛 판정 경로**와
 * 같은 판정을 job 그레인으로 낸다(그 함수는 같은 판정을 프롬프트로 접는다).
 *
 * 출력 열: `job_id uuid, prompt_id uuid, registered bool, owned_hit bool, target_hit bool`.
 *   registered  그 job 의 프롬프트가 `projectIds` 사이트의 `website_prompts` 에 등록돼 있다
 *               (= 위 함수의 `snap ⋈ wp`, 두 카드 공통 분모의 자격)
 *   target_hit  그 job 의 인용 중 하나가 **그 프롬프트의** 타겟 URL 과 정확 일치
 *               (위 함수 `pm.target_hit` 와 같은 `targetMatchSql(cit.cnorm, wp.turl)`)
 *   owned_hit   유닛 자사 판정(`websiteUnitOwnedTargetClause`) 또는 target_hit
 *               (위 함수 `pm.owned_base_hit OR pm.target_hit` 와 같은 식)
 * 미등록 프롬프트의 job 은 `registered=false` 이고 두 플래그도 false 다: 위 함수에서
 * 그 프롬프트는 `cit ⋈ wp` 에 안 붙어 어느 분자에도 못 들어간다.
 *
 * 프롬프트 단위 값은 리더가 `bool_or` 로 복원한다. `bool_or` 는 job 들로 먼저 접고 다시
 * 접어도 같다(결합법칙): 그래서 job 그레인에 굳혀도 필터(엔진·국가·언어)가 고른 job
 * 부분집합마다 위 함수와 같은 프롬프트 판정이 나온다.
 *
 * ⚠️ **유닛 판정 전용**이다. flat 판정(키 `X.websiteOwnedUnit` off)의 자사 base 는 화면
 *    필터(언어·국가)의 함수라 생성 시점에 굳힐 수 없다: 그 경우 호출부는 이 사실표를
 *    쓰지 않고 위 함수(라이브)로 간다.
 * ⚠️ 판정 식을 옮겨 적지 않았다: 정규화(`citationNormProjection`·`citation_url_norm`
 *    폴백), 타겟 일치(`targetMatchSql`), 유닛 판정(`websiteUnitOwnedTargetClause` + `wup`)
 *    모두 위 함수와 같은 빌더다. 위 함수의 유닛 경로를 바꾸면 이 함수도 같이 고친다 :
 *    `lib/scope/server.website-url-rates-summary.test.ts`("판정 한 벌") 가 두 문장의 판정 조각이
 *    같은지 대조하고, `summary-url-hits.pglite.test.ts` 가 실행으로 판정을 고정한다.
 *
 * `jobs` 는 `(job_id uuid, prompt_id uuid)` 를 내는 SELECT 다(생성기 = 굳힌
 * `summary_cycle_jobs`). `wup` 은 그 job 들의 프롬프트로 좁힌다: 좁히지 않으면 인용 행 ×
 * 함대 전체 `wup` Nested Loop 가 잡힐 수 있다(`websiteUnitPromptCtes` 의 `promptScope` 주석).
 */
export declare function websitePromptUrlHitJobFlagsSql(args: {
    jobs: SQL;
    projectIds: string[];
    units: readonly WebsiteOwnedUnit[];
}): SQL;
export declare function aggregateWebsiteCitationAccuracyTrend(filters: StandardFilters, unit: BucketUnit, scopeProjectIds: string[], ownedBasePrefixes?: string[], ownedSiblingUniverse?: string[], ownedUnits?: readonly WebsiteOwnedUnit[]): Promise<CitationAccuracyTrendBucket[]>;
export interface AcrBrandAgg {
    brand: string;
    isOurs: boolean;
    choiceCount: number;
    appearanceCount: number;
    choiceShare: number | null;
    coverage: number | null;
}
export interface AcrTrendBucket {
    date: string;
    series: Record<string, number | null>;
}
export interface AcrBattleRow {
    promptId: string;
    promptText: string | null;
    cells: {
        engine: string;
        winner: string | null;
        winnerIsOurs: boolean;
        choiceCount: number;
    }[];
}
export interface AcrModelConversionRow {
    brand: string | null;
    model: string;
    isOurs: boolean;
    conversionRate: number | null;
    shortlistCount: number;
    top1Count: number;
}
export interface AcrTerritorySheet {
    region: string | null;
    engine: string;
    rows: {
        promptId: string;
        promptText: string | null;
        validAcr: number;
        entries: {
            brand: string;
            choice: number;
            isOurs: boolean;
        }[];
    }[];
}
export interface StandardAcr {
    measured: boolean;
    brands: AcrBrandAgg[];
    /**
     * 관점 당사(합친 당사) 합계 — KPI 카드 원천(API 원천만). 브랜드 행은 브랜드별·상위 12 라 다중 관점(HMG)은 첫 당사만,
     * 상한 밖 당사는 값이 없었다. 없으면(legacy·옛 캐시) 카드는 첫 당사 브랜드 행을 읽는다.
     */
    own?: Omit<AcrBrandAgg, "brand" | "isOurs">;
    trend: AcrTrendBucket[];
    battle: AcrBattleRow[];
    modelConversion: AcrModelConversionRow[];
    territory: AcrTerritorySheet[];
    totals: {
        promptRuns: number;
        prompts: number;
        iterations: number;
        engines: string[];
    };
}
export declare function acrWhere(f: StandardFilters): SQL;
export declare function latestAcrPromptRunIds(f: StandardFilters): SQL;
export declare function aggregateAcrFromMirror(filters?: StandardFilters): Promise<StandardAcr>;
export interface AcrOwnCounts {
    choiceCount: number;
    appearanceCount: number;
    cells: number;
}
export declare function aggregateAcrOwnFromMirror(filters?: StandardFilters): Promise<AcrOwnCounts>;
export interface StandardCollectionDates {
    firstMeasuredAt: Date | null;
    lastMeasuredAt: Date | null;
}
export declare function standardCollectionDates(scope: AllowedScope | null | undefined): Promise<StandardCollectionDates>;
/**
 * 엔진 × 브랜드 스냅샷(`latestBrands`)의 **엔진당 경쟁 브랜드 표시 상한**.
 * 브랜드 수백~천 개를 전부 내려보내지 않기 위한 절단이다(당사는 상한 밖으로 늘 포함).
 *
 * ⚠️ 이 값은 "그 엔진의 경쟁 브랜드 수"가 아니다 — 라이브 실측(2026-09-10 검증자)에서
 * chatgpt 850 · gemini 1,115 개 중 상위 30 만 내려간다. 그래서 이 배열에서 센 어떤
 * 수도 모수로 말하면 안 되고, 화면 라벨은 `상위 N` 으로만 쓴다
 * (`engine.competitorAvgWithCount`, kpi-view.ts `EngineCompetitorBar.competitorCount`).
 */
export declare const ENGINE_BRAND_TOP_N = 30;
declare function kpiTabCellSnapshot(): SQL;
/**
 * 4-KPI 탭 추이의 **주 격자 축 조각** (2026-09-18) — 답변셋 컬럼 + 조인 한 쌍.
 *
 * 정본 주석은 `trendWeekKey` 머리다(원천·매칭률·불일치율). 여기서 더하는 규칙은 하나뿐:
 * **`day` 축에는 회차 주를 얹지 않는다.** `cycle_week` 는 월요일 격자라 일 단위 축에
 * 끼우면 없던 날을 만든다(같은 이유로 갭 슬롯도 `day` 에는 안 들어간다 —
 * `lib/summary/read/trend-gaps.ts` 머리 주석). 오늘 KPI 탭 호출부는 전부 `week` 지만,
 * `opts.unit` 이 열려 있으므로 여기서 막는다.
 *
 * ── EXPLAIN (프로덕션 미러 · ANALYZE+BUFFERS · 같은 세션 A→B 교대 ×2, 2026-09-18) ──
 * 하네스: `scripts/summary/explain-kpi-trend-week.ts`(쓰기 0).
 * **텍스트가 바뀌는 문장은 답변셋 SELECT 하나뿐**이고, 그 문장은 오히려 빨라졌다 —
 * 조인 때문에 플래너가 병렬(`Parallel Hash Left Join`, 7 워커)로 내려간다:
 *
 *   글로벌 무필터  exec 677·682 ms → **276·279 ms** · shared 942,816 → 1,227,7xx · 노드 20 → 28
 *   region=KR      exec 104·104 ms → **115·115 ms** · shared 856,3xx → 1,104,7xx · 노드 21 → 27
 *
 * 산출 행수는 동일(216,908)하고 `scope_answers_run_cycle_idx` Index Only Scan·Nested Loop
 * 없음도 그대로다. buffers 증가는 병렬 워커의 중복 읽기 몫이다.
 *
 * ⚠️ **늘어난 것은 뒤따르는 문장이고, 그건 의도한 결과다.** 무필터 엔진 추이의 최장 문장
 *    (`ENGINE_KPI_PER_JOB`, 텍스트 무변경)이 **10.1 → 11.3 s** 다 — 회차 격자에서는 셀
 *    스냅샷 `DISTINCT ON` 이 09-08 회차를 **안 지우므로** `ans` 행이 더 남는다(그것이 이
 *    변경의 목적). 문장 상한 **20 s** 대비 여유가 충분하다.
 *    **예산 상수는 올리지 않았다** — 상한을 올려 느려진 문장을 덮지 말라는 것이
 *    `kpi-tab-budget.ts` 의 규율이다.
 *    ⚠️ **경로 합계(함수 wall)는 여기 적지 않는다.** 로컬→풀러 RTT(문장당 ~140 ms)가
 *       섞여 있고, 검증자의 프로덕션 재현(창 84일 ×2)에서 A/B 방향이 반대로 나왔다 —
 *       재현되지 않는 수치를 주석에 두면 다음 사람이 그것을 기준으로 판단한다.
 */
declare function kpiTabTrendAxis(unit: BucketUnit, weekSource: TrendWeekSource,
/**
 * 측정 폴백의 표면 격자(2026-09-28 main #300) — 호출부가 `mirrorWeekGridFor(projectCtx)`
 * 로 넘긴다. `day` 축에는 얹지 않는다(위 규칙과 같은 이유 — 월요일 격자).
 */
grid: MirrorWeekGrid): Promise<{
    cols: SQL;
    join: SQL;
    applied: TrendWeekApplied;
}>;
export interface BrandTrendPoint {
    brand: string;
    isTracked: boolean;
    mentions: number;
    /** 그 브랜드가 등장한 답변 수 (노출률 분자). */
    answers: number;
    /** answers / 버킷 답변 수. 버킷에 답변이 없으면 그 버킷 자체가 없다. */
    exposurePct: number | null;
    /** mentions / 버킷 전체 브랜드 언급 합 (cap 밖 브랜드도 분모에 포함). */
    sharePct: number | null;
}
export interface BrandTrendBucket {
    bucketStart: string;
    answers: number;
    /** cap 과 무관한 전 브랜드 언급 합 — 점유율 분모. */
    totalMentions: number;
    measuredDays: number;
    firstAt: string | null;
    lastAt: string | null;
    /** 시리즈 브랜드마다 1점. 측정은 있었으나 언급이 없으면 0(갭 아님). */
    brands: BrandTrendPoint[];
}
/** 추이 축의 창 경계 — 측정이 없는 앞뒤 회차까지 포함한다(readWindowBounds). */
export interface TrendWindowBounds {
    windowStartBucket: string | null;
    windowEndBucket: string | null;
}
/**
 * **숨긴 회차의 갭 슬롯 후보 키**(0070, 2026-09-10) — 주 격자 키(`cycle_week`) 목록.
 *
 * 이 결과를 만든 것은 미러 집계지만, 값은 미러가 아니라 **원장**에서 온다
 * (`lib/summary/read/trend-gaps.ts::trendGapWeekKeys` 가 페처 경계에서 얹는다).
 * 여기 두는 이유는 화면(kpi-view.ts)까지 나르는 그릇이 이 타입뿐이기 때문이다.
 *
 * ⚠️ **후보**다 — 마커를 찍는 판정은 축을 쥔 화면이 한다(축 안쪽인가 · 그 주에 다른
 * 회차 측정이 남아 있지 않은가). 판정 정본은 `lib/viz/trend-gap.ts::trendGapKeysToMark`.
 */
export interface TrendGapBucketKeys {
    gapBuckets?: string[];
    /**
     * **공용 추이 격자의 자리 목록**(D5, 2026-09-20). 있으면 화면은 축을 스스로 채우지
     * 않고(`trendAxis` 의 `fillTrendGaps`) **이 목록 그대로** 축을 세운다.
     *
     * `gapBuckets` 와 같은 자세다 — 값은 미러가 아니라 **원장**에서 오고
     * (`lib/period/trend-grid.ts::buildTrendGrid`), 페처 경계(`withKpiTrendGaps`)가 얹는다.
     * 여기 두는 이유도 같다: 화면까지 나르는 그릇이 이 타입뿐이다.
     *
     * ⚠️ 이쪽은 **후보가 아니라 축 그 자체**다. `gapBuckets` 는 화면이 판정할 후보 키지만
     *    자리 목록은 이미 판정이 끝난 격자다(점이냐 갭이냐가 `gapReason` 에 실려 있다).
     */
    trendGrid?: TrendGridSlotView[];
}
export interface BrandTrendResult extends TrendWindowBounds, TrendGapBucketKeys {
    unit: BucketUnit;
    /** cap 적용 후 시리즈 브랜드 (창 전체 언급 합 내림차순, 당사 우선 보존). */
    brands: Array<{
        brand: string;
        isTracked: boolean;
        mentions: number;
    }>;
    buckets: BrandTrendBucket[];
}
/**
 * 회차(measured_at 버킷) × 브랜드 언급 수·노출률·점유율.
 * 주별 상위 N 브랜드 라인차트와 경쟁사 스파크라인(직전 4회차)·WoW 의 원천.
 */
export declare function aggregateBrandTrendFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, opts?: {
    unit?: BucketUnit;
    topBrands?: number;
    trendDays?: number;
    /** 문장 하나의 상한(ms). 실효 최악 = budgetMs + 이 값 (withAnswerSet 참조). */
    statementTimeoutMs?: number;
    /** 이 집계 전체의 벽시계 예산(ms). 문장 발행 전마다 확인한다. */
    budgetMs?: number;
    weekSource?: TrendWeekSource;
}): Promise<BrandTrendResult>;
export interface EngineKpiPoint {
    engine: string;
    answers: number;
    /** 당사가 1회 이상 등장한 답변 수. */
    trackedAnswers: number;
    exposurePct: number | null;
    totalMentions: number;
    trackedMentions: number;
    sovPct: number | null;
    /**
     * 우호도 입력(2026-09-02) — 당사 언급의 감정 신호 합. 답변 수가 아니다.
     * 산식은 Sub KPI Q3(대시보드 우호도 카드)와 동일: positive ÷ (P+NE+NG+MX).
     */
    sentSignals: number;
    positiveSignals: number;
    negativeSignals: number;
}
export interface EngineKpiBucket {
    bucketStart: string;
    measuredDays: number;
    firstAt: string | null;
    lastAt: string | null;
    engines: EngineKpiPoint[];
}
/**
 * 엔진 × 브랜드 스냅샷(2026-09-02 피그마 1:1 D24 — "경쟁사 평균 / 선택 경쟁사" 엔진 바).
 * 브랜드 표기는 언급 집계(MentionsLive.brands[].brand)와 같은 rollupDisplayName 이라
 * 경쟁사 선택 드롭다운의 값으로 바로 조회할 수 있다.
 */
export interface EngineBrandPoint {
    engine: string;
    brand: string;
    isTracked: boolean;
    /** 이 엔진에서 그 브랜드가 1회 이상 등장한 답변 수(노출률 분자). */
    answersWithBrand: number;
    mentions: number;
}
/** 유형 × 회차(2026-09-02 D29) — 당사 언급에 그 유형 신호가 있는 답변 수(노출률 분자). */
export interface TypeTrendBucket {
    bucketStart: string;
    answers: number;
    byType: Record<MentionTypeKey, number>;
}
export interface EngineKpiTrend extends TrendWindowBounds, TrendGapBucketKeys {
    unit: BucketUnit;
    /** 창 안에서 관측된 엔진 목록 (이름 오름차순 — 라인 색 고정용). */
    engines: string[];
    buckets: EngineKpiBucket[];
    /**
     * 엔진 × 브랜드 스냅샷 — 스냅샷 창(latest 와 같은 모집단).
     * 엔진당 언급 상위 `ENGINE_BRAND_TOP_N` + 당사. **전체 경쟁 브랜드가 아니다.**
     * 화면은 여기서 경쟁사 평균(브랜드별 노출률의 평균)을 낸다 — 그 평균의 모수는
     * "그 엔진의 경쟁사 수"가 아니라 상위 N 이며, 라벨도 그렇게 말해야 한다(검증자 B4).
     */
    latestBrands: EngineBrandPoint[];
    /** 유형 × 회차 시계열(allRuns 창, buckets 와 같은 축). 시계열 degrade 시 빈 배열. */
    typeTrend: TypeTrendBucket[];
    /**
     * 최신 스칼라 — 추이의 마지막 버킷이 아니라 **스냅샷 창**(detailAnswerWhere
     * 기본 모드)에서 낸다. 탭 히어로·요약 카드와 같은 모집단이어야 하기 때문이다
     * (스펙 "모집단 일치"). 마지막 버킷 값은 재측정 진행 중이면 반토막일 수 있다.
     */
    latest: EngineKpiPoint[];
    latestMeasuredAt: string | null;
    /**
     * 시계열 단계만 실패했는가(2026-09-01 재검증 C2). true 면 `buckets` 는 비었지만
     * `latest`(스냅샷 스칼라)는 유효하다 — 엔진 바는 그대로 두고 시계열만 "표시 불가"로
     * 그려야 한다. 종전에는 단계 하나가 죽으면 집계 전체를 null 로 던져 히어로 추이·
     * 엔진 섹션·유형 콤보·커버리지가 **동시에** 비었다.
     */
    trendDegraded: boolean;
    /**
     * **Overview 추이의 자리 배열 그대로**(제품 책임자 2026-09-20). Overview 를 만드는 **바로 그
     * 함수**(`fetchStandardTrend`)가 낸 배열이다 — 자리 목록·게이트·회차 대표 선택·폴백
     * 판정까지 전부 그 함수 안에서 한 번만 일어난다.
     *
     * 두 가지가 여기서 나온다:
     *   · **노출률 추이**(`kpiTrendPoints(_, "exposure")`) — 축과 값 둘 다.
     *   · **카드 Δ 셋**(노출률·점유율·우호도) — `overviewCardDelta(slots, key)`.
     *     Overview 카드의 Δ 도 같은 배열·같은 규칙이다(`live.ts::applyTrendDeltas`).
     *
     * ⚠️ **추이 차트는 노출률만** 이 배열을 쓴다. 점유율·우호도·엔진별 라인의 **선**은
     *    그대로 `buckets`(미러)다 — 사실표에 그 축이 없다(`own_negative` 부재 ·
     *    `(cycle, engine, brand)` 축 부재). 그래서 같은 탭에서 **카드(사실표)와 추이의
     *    마지막 점(미러)이 다를 수 있다.** 후속 범위이고, 그 사실을 여기에 박아 둔다.
     *
     * 없으면 종전 그대로다(격자 off·루트 없음) — 필드가 안 실리므로 캐시 셀 바이트 동일.
     */
    overviewSlots?: readonly StandardTrendBucket[];
    /**
     * **카드 Δ 의 입력** — Overview 카드가 쓰는 **바로 그 Δ 롤업** 배열이다
     * (`deltaTrendFilters(filters)` + `DELTA_TREND_BUCKET`, 2026-09-20 독립 검증 N2).
     *
     * 추이 차트가 쓰는 `overviewSlots`(13자리 주 격자)와 **다른 배열**이다. 둘을 하나로
     * 합치지 않는 이유: Overview 는 화면 추이와 Δ 롤업을 일부러 갈라 두었고
     * (`live.ts` 의 Δ 출처 주석), 그것을 합치는 것은 **Overview 숫자를 바꾸는 산식 변경**이라
     * 제품 결정 사항이다. 그래서 언급 화면이 Overview 쪽 입력에 맞춘다.
     */
    overviewDeltaSlots?: readonly StandardTrendBucket[];
}
/** 엔진별 노출률·점유율 — 시계열(allRuns) + 최신 스칼라(스냅샷). */
export declare function aggregateEngineKpiTrendFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, opts?: {
    unit?: BucketUnit;
    trendDays?: number;
    /** 문장 하나의 상한(ms) — 진짜 statement_timeout. */
    statementTimeoutMs?: number;
    /**
     * 이 집계 **전체**(두 단계 합)의 벽시계 예산(ms).
     *
     * 이 함수는 트랜잭션을 두 번 연다(스냅샷 창 + allRuns 창). 종전 구현은 1단계
     * 소요를 빼고 남은 예산을 2단계 `statement_timeout` 으로 넘기며 "두 단계 합이
     * 예산을 넘지 않는다"고 적었는데, **그것은 거짓이었다**(2026-09-01 재검증 C1):
     * `statement_timeout` 은 문장당이고 한 단계가 여러 문장(SET·CREATE TEMP·ANALYZE·
     * 분석 쿼리들 — 2026-09-01 실측 6~7개)을 발행하므로 1단계만으로 6~7×timeout 을
     * 쓸 수 있었다.
     *
     * 지금은 **하나의 마감(deadlineAt)** 을 두 단계가 공유하고, withAnswerSet 이
     * 모든 문장 앞에서 그 마감을 확인한다. 정직한 상한은:
     *   실효 최악 = budgetMs + statementTimeoutMs
     * (마감 직전에 보낸 문장 하나는 끝까지 기다려야 한다).
     */
    budgetMs?: number;
    /**
     * 주 격자 키의 원천(2026-09-18). **추이 단계에만** 적용된다 — 스냅샷 단계
     * (`latest`·`latestBrands`)는 버킷이 없는 "지금 시점 상태" 라 대상이 아니다.
     * 기본값은 종전(측정시각 주). 정본은 `trendWeekKey` 머리 주석.
     */
    weekSource?: TrendWeekSource;
}): Promise<EngineKpiTrend>;
export declare const MENTION_TYPE_KEYS: readonly ["mention", "recommendation", "comparison", "definition", "final_choice"];
export type MentionTypeKey = (typeof MENTION_TYPE_KEYS)[number];
export interface TypeKpiRow {
    type: MentionTypeKey;
    /** 당사(tracked rollup) 유형 신호 합. */
    ownMentions: number;
    /** 비교(당사 아닌 경쟁 브랜드) 유형 신호 합. */
    otherMentions: number;
    totalMentions: number;
    /** 그 유형 신호가 1개 이상인 답변 수 — 노출률 분자(당사/비교 각각). */
    ownAnswers: number;
    otherAnswers: number;
    /** ownAnswers / 전체 답변 수. */
    ownExposurePct: number | null;
    otherExposurePct: number | null;
    /** ownMentions / (own+other) — 그 유형 안에서의 당사 점유율. */
    ownSharePct: number | null;
}
export interface TypeSentimentRow {
    type: MentionTypeKey;
    /** 그 유형 신호가 있는 (답변×브랜드) 행 수 — 매트릭스 셀의 모수. */
    rows: number;
    positive: number;
    neutral: number;
    negative: number;
    mixed: number;
}
export interface TypeKpi {
    /** 모집단 답변 수 — 노출률 분모. 요약 카드(Sub KPI)의 분모와 같은 창. */
    totalAnswers: number;
    totalMentions: number;
    ownMentions: number;
    rows: TypeKpiRow[];
    /**
     * 유형×감정 매트릭스. `own` = 당사만(기본), `all` = 타사 포함(토글) —
     * 스택바 분모가 당사 한정 ↔ 전 브랜드로 바뀌는 UI 토글에 대응한다.
     *
     * ⚠️ 근사임을 명시한다: 미러의 `type_*` 5컬럼과 `sentiment_*` 4컬럼은 같은
     * (답변×브랜드) 행의 **독립된 분해**라, 진짜 교차(이 유형의 이 감정이 몇 건)는
     * 원자료에 없다. 여기서는 "그 유형 신호가 있는 행들의 감정 신호 합"을 낸다 —
     * 한 행이 두 유형을 가지면 그 행의 감정이 두 유형에 각각 계상된다(중복).
     * 따라서 셀 합계는 총 감정 신호 수와 일치하지 않는다. 화면은 유형 **안에서의
     * 감정 구성비**로만 읽어야 하며, 유형 간 합산은 하지 않는다.
     * 엄밀 교차는 scope 분류 패스가 교차 카운트를 내려줘야 가능하다(후속).
     */
    sentimentMatrix: {
        own: TypeSentimentRow[];
        all: TypeSentimentRow[];
    };
}
/** 멘션 유형 5종 × 브랜드군(당사/비교) 노출·점유율 + 유형×감정 매트릭스. */
export declare function aggregateTypeKpiFromMirror(filters?: StandardFilters, projectCtx?: string | string[],
/** 문장 상한 + 전체 벽시계 예산. 실효 최악 = budgetMs + statementTimeoutMs. */
opts?: {
    statementTimeoutMs?: number;
    budgetMs?: number;
}): Promise<TypeKpi>;
export interface FirstPositionPoint {
    brand: string;
    isTracked: boolean;
    /** 회차 평균 등장 순위. 순위가 매겨진 답변이 없으면 null(= 측정 없음). */
    avgPosition: number | null;
    /** 순위가 매겨진 답변 수 (avgPosition 의 모수). */
    rankedAnswers: number;
}
export interface FirstPositionBucket {
    bucketStart: string;
    measuredDays: number;
    firstAt: string | null;
    lastAt: string | null;
    brands: FirstPositionPoint[];
}
export interface FirstPositionRow {
    brand: string;
    isTracked: boolean;
    /** null = 그 창에 순위 데이터 없음. **0 이 아니다** (스펙: "측정 없음" 표기). */
    avgPosition: number | null;
    /** avgPosition 오름차순 경쟁 순위(동률 공동, 다음 순위 건너뜀). null 전파. */
    rank: number | null;
    rankedAnswers: number;
    mentions: number;
}
export interface FirstPositionResult extends TrendGapBucketKeys {
    unit: BucketUnit;
    brands: string[];
    buckets: FirstPositionBucket[];
    /** 최신 순위 테이블 — 스냅샷 창(요약 카드와 같은 모집단). */
    latest: FirstPositionRow[];
    /**
     * Overview 카드와 같은 원천(제품 책임자 2026-09-20). 우선 노출도 탭은 `engineTrend` 를 안
     * 받으므로(자기 프로미스 하나뿐) 카드 값과 Δ 입력을 **여기에** 싣는다.
     *
     * ⚠️ `overviewCards.position.avgPosition` 만 정본으로 쓴다. 히어로의 **최고 순위**
     *    (`rank`)는 스냅샷 집계에 소스가 없어 종전 미러 경로(`latest`)가 계속 낸다.
     */
    overviewCards?: OverviewCardValues;
    /** 추이 축용 — `EngineKpiTrend.overviewSlots` 와 같은 배열. */
    overviewSlots?: readonly StandardTrendBucket[];
    /** Δ 의 유일한 입력 — `EngineKpiTrend.overviewDeltaSlots` 와 같은 배열(N2). */
    overviewDeltaSlots?: readonly StandardTrendBucket[];
}
/** 브랜드별 등장 순위 — 회차 시계열 + 최신 순위 테이블(순위 정렬). */
export declare function aggregateFirstPositionFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, opts?: {
    unit?: BucketUnit;
    topBrands?: number;
    trendDays?: number;
    /** 문장 하나의 상한(ms). 두 단계(스냅샷·추이)가 마감 하나를 공유한다 — 엔진 추이와 동일 규약. */
    statementTimeoutMs?: number;
    budgetMs?: number;
}): Promise<FirstPositionResult>;
/** 카테고리별 인용 수 합(2026-09-02 피그마 D13/C09 — 카테고리 Δ의 직전 스냅샷 원천). */
export interface CitationCategoryTotals {
    total: number;
    byCategory: Record<string, number>;
}
/**
 * 스냅샷 창의 카테고리별 인용 수 — 인용 집계(categories)와 같은 정의(도메인 단위 read-time
 * 분류)를 **가볍게** 낸다. 직전 측정일(`dateTo = days[1]`)로 부르면 카테고리 Δ 의 분모가
 * 된다. 도메인 표·URL 은 필요 없으므로 GROUP BY 도메인 한 문장이다.
 */
export declare function aggregateCitationCategoryTotalsFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, opts?: {
    statementTimeoutMs?: number;
    budgetMs?: number;
}): Promise<CitationCategoryTotals | null>;
export interface CitationTypeCategoryRow {
    type: MentionTypeKey;
    /** 그 유형 신호가 있는 당사 언급 답변들이 인용한 총 인용 수. */
    total: number;
    /** 카테고리(영문 택소노미 값) → 인용 수. */
    byCategory: Record<string, number>;
}
/**
 * 멘션 유형별 출처 카테고리 구성(디자인 "멘션 유형별 출처 카테고리 구성").
 * 답변에 당사 언급이 유형 X 신호를 가지면 그 답변의 인용 전부를 유형 X 에 귀속한다 —
 * 한 답변이 여러 유형 신호를 가지면 여러 유형에 중복 계상된다(유형 5종 신호 합 규약과
 * 동일). 분류는 도메인 단위 read-time.
 */
export declare function aggregateCitationTypeCategoriesFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, opts?: {
    statementTimeoutMs?: number;
    budgetMs?: number;
}): Promise<CitationTypeCategoryRow[]>;
export type CitationTone = "positive" | "negative";
export interface CitationToneSummary {
    positive: {
        urls: number;
        citations: number;
        answers: number;
    };
    negative: {
        urls: number;
        citations: number;
        answers: number;
    };
}
/**
 * 답변 우호도별 인용 요약(타일 2장의 카운트). 톤 = 답변 안 당사 언급의 감정 신호 합
 * 비교: positive = P>NG, negative = NG>P (동률·둘 다 0은 어느 쪽도 아니다).
 * URL 수는 DISTINCT url. 카테고리 필터(sourceCategory)는 도메인 분류가 JS 파생이라
 * 여기서는 적용하지 않는다(타일은 전체 인용 기준 — 캡션이 말한다).
 */
export declare function aggregateCitationToneSummaryFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, opts?: {
    statementTimeoutMs?: number;
    budgetMs?: number;
}): Promise<CitationToneSummary>;
export interface CitationToneUrlRow {
    /** groupBy=domain 이면 null. */
    url: string | null;
    domain: string;
    title: string | null;
    promptText: string | null;
    citations: number;
    providers: string[];
    /** read-time 분류(영문 택소노미 값). 출처에 카테고리가 없으면 null('—', Gold 의 Other 와 다름). */
    category: string | null;
}
export interface CitationToneUrlPage {
    rows: CitationToneUrlRow[];
    total: number;
    page: number;
    pageSize: number;
}
/**
 * 화면에 보이는 인용 URL 라벨의 SQL 쌍둥이 — `displayCitationUrl`(lib/url-display.ts)과
 * **같은 문자열**을 만든다: `#` 이후(프래그먼트) 제거 + 앞머리 `http://`·`https://` 제거.
 *
 * 순서가 JS(스킴 → 프래그먼트)와 반대여도 결과는 같다 — 스킴에는 `#` 가 없다.
 * 둘 다 대소문자를 구분한다(JS 정규식 플래그 없음 = PG regexp_replace 기본).
 * 의미 대조 표는 scope-aggregates.citation-url-search.test.ts.
 */
export declare function citationDisplayUrlSql(urlCol: SQL): SQL;
/**
 * 긍정/부정 URL 하위 페이지의 검색 술어.
 * - domain 모드: 그룹 키(화면의 도메인 라벨)에 ILIKE — 종전 그대로.
 * - url 모드: **화면에 보이는 URL**(`citationDisplayUrlSql`)에 ILIKE.
 *   2026-09-17 GGMD QA: 원본 URL 전체에 걸었더니 Gemini 인용의 `#:~:text=If%20you%20are…`
 *   조각에서 "you" 가 걸려, 화면 URL 에 검색어가 없는 행이 섞여 나왔다.
 * 빈 q 는 술어 없음. `%`·`_` 이스케이프는 하지 않는다(종전 유지).
 */
export declare function citationToneUrlSearchSql(q: string, byDomain: boolean, groupKey: SQL, urlCol: SQL): SQL;
/**
 * 긍정/부정 답변에 인용된 URL 목록(하위 페이지 585:1820) — 페이지·검색·도메인별 보기.
 * 정렬 = 인용 수 내림차순. total 은 검색 반영 전체 행 수(윈도 count).
 */
export declare function aggregateCitationToneUrlsFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, opts: {
    tone: CitationTone;
    page?: number;
    pageSize?: number;
    q?: string;
    groupBy?: "url" | "domain";
    statementTimeoutMs?: number;
    budgetMs?: number;
}): Promise<CitationToneUrlPage>;
export interface CitationOwnedPromptRow {
    id: string;
    promptText: string;
    funnelStage: string | null;
    citations: number;
    providers: string[];
    answers: MentionAnswerLive[];
}
export interface CitationOwnedPromptPage {
    rows: CitationOwnedPromptRow[];
    total: number;
    page: number;
    pageSize: number;
}
/**
 * 공식(당사) URL 인용/미인용 프롬프트 전량 목록(하위 페이지 580:1146) — 페이지·검색.
 * 판정 규칙은 기존 promptSplit 과 동일(인용한 도메인 중 하나라도 도메인 단위 owned).
 * 기존 promptSplit 은 상위 20개만 실어 오므로 전량 목록은 이 경로가 담당한다.
 */
export declare function aggregateCitationOwnedPromptsFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, ownedBasePrefixes: string[], opts: {
    owned: boolean;
    page?: number;
    pageSize?: number;
    q?: string;
    ownedSiblingUniverse?: string[];
    statementTimeoutMs?: number;
    budgetMs?: number;
}): Promise<CitationOwnedPromptPage>;
export interface GeoBrandKpiRow extends GeoBrandMention {
    /** 이 브랜드가 1회 이상 등장한 답변 수(distinct job). */
    answers: number;
    posSum: number;
    posCnt: number;
    sentPositive: number;
    sentTotal: number;
}
export interface GeoCodeTotals {
    code: string;
    answers: number;
    /** 당사(tracked) 브랜드가 1회 이상 등장한 답변 수. */
    ownAnswers: number;
    citTotal: number;
    citOwned: number;
    /**
     * 글로벌 ⑤ 분자 — 공식(HMG) 카테고리 인용 수(제품 책임자 2026-09-29, 카드 ⑤ 와 같은 정의).
     * 글로벌 리더만 싣는다. 소비는 `citationShareNumerator` 규약과 같게 "있으면 이것, 없으면
     * `citOwned`" 다(`overview-metrics.ts::marketMetrics`).
     */
    citOfficialHmg?: number;
}
export interface GeoKpiResult {
    brands: GeoBrandKpiRow[];
    codes: GeoCodeTotals[];
}
export declare function aggregateGeoKpiFromMirror(filters: StandardFilters | undefined, projectCtx: string | string[] | undefined, ownedBasePrefixes: string[], opts?: {
    statementTimeoutMs?: number;
    budgetMs?: number;
    /** 글로벌 ⑤ 분자용 공식(HMG) 그룹 키 목록 — 주면 `codes[].citOfficialHmg` 를 싣는다. */
    officialGroupKeys?: readonly string[];
}): Promise<GeoKpiResult>;
