// Type-only snapshot; no database or server implementation is included.
import "server-only";
import { type SQL } from "drizzle-orm";
import { answerCycleAnchorsAvailable } from "@/lib/db/column-availability";
/** 앵커 테이블의 표면 값. ⚠️ `summary_cycles.surface` 는 같은 개념을 'global' 로 부른다. */
export type AnchorSurface = "standard" | "website" | "project";
/** 회차 원장(`summary_cycles.surface`, 0059 CHECK)의 표면 어휘. */
export type LedgerSurface = "global" | "website" | "project";
/**
 * 앵커 테이블 ↔ 회차 원장의 표면 어휘 매핑 — **정의는 여기 한 곳**이다.
 *
 * 같은 개념을 두 테이블이 다르게 부른다: 앵커 테이블은 스펙 §3 대로 `'standard'`,
 * 원장은 `'global'`. 나머지 둘은 같다. 두 테이블을 표면으로 조인·비교하는 코드는
 * 리터럴을 직접 쓰지 말고 이 맵(TS)이나 아래 `ledgerSurfaceSql`(SQL)을 경유한다 —
 * 리터럴이 흩어지면 한쪽 어휘가 바뀔 때 조인이 **에러 없이 0행**이 된다.
 */
export declare const ANCHOR_TO_LEDGER_SURFACE: {
    readonly standard: "global";
    readonly website: "website";
    readonly project: "project";
};
export declare const toLedgerSurface: (s: AnchorSurface) => LedgerSurface;
export declare function toAnchorSurface(s: LedgerSurface): AnchorSurface;
/**
 * 앵커 테이블의 `surface` 식을 원장 어휘로 바꾸는 SQL. 위 맵에서 **파생**한다(두 벌 금지).
 * 예) `... JOIN summary_cycles c ON c.surface = ${ledgerSurfaceSql("ca")}`
 * 값은 코드 상수뿐이라 리터럴로 넣는다(바인드로 넣으면 CASE 결과 타입이 text 로
 * 추론되지 않는 드라이버 함정을 피한다). 모르는 값은 NULL → 조인 불성립(기본 거부).
 */
export declare function ledgerSurfaceSql(alias?: string): SQL;
/** 0077 전파 호출을 발행해도 되는가 — 함수·테이블이 한 마이그레이션에서 함께 생긴다. */
export declare const answerCycleAnchorsWritable: typeof answerCycleAnchorsAvailable;
/**
 * run 집합의 앵커 행을 다시 계산한다. `runIds` 가 비면 `null` — 호출부가 문장을
 * 발행하지 않는다(빈 배열로 부르면 함수가 0을 돌려주지만 왕복이 낭비다).
 *
 * `rootProjectId` 는 표면 판정의 'standard' 근거(B4). 앱 정본은
 * `lib/scope/result-adapter.ts::getRootConfig()?.projectId` 이고, NULL 이면 DB 함수가
 * 원장 출력 폴백으로 돌며 NOTICE 를 남긴다.
 */
export declare function refreshAnchorsForRunsSql(runIds: string[], rootProjectId: string | null): SQL | null;
/**
 * 한 회차에 귀속된 run 전체의 앵커 행을 다시 계산한다.
 *
 * run 목록을 앱으로 가져왔다가 다시 넣지 않고 **서브쿼리로 넘긴다** — 회차 발행은
 * 스왑 트랜잭션 안이라 왕복을 늘리지 않는 편이 낫고, 그 사이 귀속이 바뀔 창도 없앤다.
 * 귀속된 run 이 하나도 없으면 빈 배열이 들어가 함수가 0을 돌려준다(무해).
 */
export declare function refreshAnchorsForCycleSql(cycleId: string, rootProjectId: string | null): SQL;
/** 격리 실행이 받는 최소 계약. `transaction` 이 있으면 savepoint 경로를 탄다. */
export interface AnchorRefreshTx {
    execute(query: SQL): Promise<unknown>;
    transaction?<T>(fn: (inner: {
        execute(query: SQL): Promise<unknown>;
    }) => Promise<T>): Promise<T>;
}
/**
 * 전파 문장을 savepoint 안에서 발행한다. savepoint 경로에서는 **던지지 않는다.**
 *
 * ⚠️ `tx.transaction` 이 없는 실행자(테스트 더블 등)에서는 **격리할 수 없다** —
 * savepoint 없이 예외를 삼키면 트랜잭션이 aborted(25P02) 상태로 남아 이어지는 문장이
 * 전부 죽는다. 삼키는 쪽이 더 나쁘므로 그때는 종전대로 직접 발행하고 던진다.
 * 프로덕션 경로(drizzle postgres-js 트랜잭션)는 둘 다 `transaction` 을 갖는다.
 *
 * @returns 성공하면 `true`, 격리 롤백됐으면 `false`.
 */
export declare function runAnchorRefreshIsolated(tx: AnchorRefreshTx,
/** 로그 식별자 — `mirror-sync` · `cycle-publish` 처럼 호출 지점을 가리킨다. */
op: string,
/** 대상 식별자(run_id·cycle_id). 비밀값이 아니다. */
scope: string, stmt: SQL): Promise<boolean>;
export type SelectableAnchorDateFilters = {
    /** 포함 하한(YYYY-MM-DD). 생략하면 제한 없음. */
    from?: string;
    /** 포함 상한(YYYY-MM-DD). 생략하면 제한 없음. */
    to?: string;
    /** `scope_answers.target` (chatgpt·gemini…). 비면 전체. */
    engines?: string[];
    /** `scope_answers.region` (KR·US…). 비면 전체. */
    countries?: string[];
};
/**
 * 노출 **시간** 게이트(스펙 §3.3).
 *
 * `view_anchor_date` 는 "그날부터 보인다"이고 NULL 은 "보이면 안 된다"이다. 둘을
 * 한 술어로 묶어 두는 이유는 `summary-cycles.ts::cycleViewableSql` 과 같다 — 정의가
 * 두 벌이 되면 "게이트는 통과했는데 조회는 빈" 날짜가 생긴다.
 *
 * ⚠️ **이것만으로는 완결된 노출 게이트가 아니다.** 기존 미러 폴백 게이트
 * (`scope-aggregates.ts::excludeHiddenCycleRuns`)는 **세 축**의 AND 다:
 *   ① 시간   — `view_anchor_at`(또는 앵커+표면 지연) ≤ now   ← 이 함수가 대체한다
 *   ② 숨김   — 0070 `hidden_reason` · 0071 `hidden_scope`    ← `anchorNotHiddenSql`
 *   ③ 대량 미러 진행 중 run — `bulkMirrorRunVisibleSql`      ← **아직 대응이 없다**
 * ①과 ②는 "아직 날짜가 안 됐다"(시간)와 "이 회차는 값이 틀렸다"(품질)로 직교하므로
 * 합치지 않고 나란히 AND 한다(`summary-cycles.ts:78-86` 의 같은 문단).
 *
 * ⛔ **축 전환(C 단계) 전에 ③을 반드시 채운다.** 지금은 이 경로의 리더가 달력 하나뿐이고
 * 그 화면은 대량 미러 중 run 을 특별히 가리지 않아 무해하지만, `excludeHiddenCycleRuns`
 * 호출부 8곳을 이 술어로 갈아 끼우는 순간 ③이 통째로 사라진다 — 적재 중인 run 의
 * 반쪽 데이터가 고객 화면에 나온다.
 *
 * 고객 대상 리더는 반드시 `anchorViewableSql()` **AND** `await anchorNotHiddenSql(family)`
 * 를 함께 건다 — 시간 게이트만 걸면 수집이 깨져 숨긴 회차
 * (`hidden_reason='collection_error'`)가 화면에 되살아난다. 값이 사라지는 방향이 아니라
 * **틀린 값이 나오는** 방향이라 화면만 봐서는 안 보인다.
 *
 * ⚠️ 조인 키도 다르다: 기존은 `summary_cycle_runs`(run_id) 경유, 이 술어는
 * `ca.cycle_id` 직접이다. 귀속 드리프트가 있으면 두 게이트가 갈린다 —
 * 감사 SQL 의 `attribution_drift` 가 그것을 긴급(2)으로 잡는다.
 *
 * `hmg_anchor_today()` 를 쓰고 `current_date` 를 쓰지 않는다: `current_date` 는 세션
 * 타임존을 따르는데 서버는 UTC 라 KST 자정~09:00 구간에서 하루 어긋난다. 게이트를
 * 앵커 날짜와 **같은 함수**로 잘라야 조용히 갈리지 않는다.
 */
export declare const anchorViewableSql: (alias?: string) => SQL;
/**
 * 숨김 게이트가 보는 **지표 계열**. `summary_cycles.hidden_scope`(0071)가 `'all'` 과
 * `'citations'` 처럼 계열 단위라 술어도 계열을 받는다.
 *
 * - `"citations"` — 인용 계열 화면(인용 추이·점유율·도메인/카테고리·정확도)
 * - `"mentions"`  — 언급 계열 화면(노출률·점유율·우호도·우선 노출도·브랜드 언급 추이·ACR)
 * - `"all"`       — 회차 **집합** 판정(달력·기간 후보). 범위와 무관하게 전부 제외한다
 *   (0071 COMMENT: "회차는 7 KPI 를 한 덩어리로 싣는 그레인이라 반쪽만 넣을 수 없다").
 */
export type AnchorHiddenFamily = "mentions" | "citations" | "all";
/**
 * 숨김 게이트 — **R3: 숨김을 앵커 테이블에 복사하지 않는다.**
 *
 * 복사하면 전파 지점이 또 하나 늘어난다(B2 와 같은 종류의 결함). 숨김은 회차 단위로
 * 사람이 켜고 끄는 값이므로, `cycle_id` 로 원장을 조인해 **그때그때 읽는다**.
 *
 * 의미는 기존 술어와 **같아야 한다**. 대조 대상:
 *   · `scope-aggregates.ts:2494-2503` `excludeHiddenCycleRuns` 의 `hiddenClause` —
 *     숨기는 조건이 `family='mention'` 이면
 *     `hidden_reason IS NOT NULL AND COALESCE(hidden_scope,'all')='all'`,
 *     그 외에는 `hidden_reason IS NOT NULL`. 이 함수는 그 **부정**이다.
 *   · `summary-cycles.ts:90-95` `cycleNotHiddenSql` = `hidden_reason IS NULL`
 *     (회차 집합 판정) → 여기서는 `family='all'`·`'citations'` 와 같은 식이다.
 *
 * 컬럼 가용성:
 *   · 0070 미적용 → `true`(제약 없음). 종전과 바이트 동일한 SQL 이 나간다.
 *   · 0070 ✓ / 0071 ✗ → 범위를 모르므로 `hidden_reason IS NULL` 로만 본다
 *     (= 회차 전체 숨김. `hiddenCycleScopeAvailable` 주석이 경계하는 방향과 같다).
 *
 * `cycle_id` 가 NULL 인 행(회차에 귀속되지 않은 run)은 `NOT EXISTS` 가 참이라
 * **숨김 없음**이다 — 스펙 §9 R3 의 "회차에 귀속되지 않은 행은 숨김 없음".
 */
export declare function anchorNotHiddenSql(family: AnchorHiddenFamily, alias?: string): Promise<SQL>;
/**
 * 원장이 이 회차를 **지금 서빙해도 된다고 말하는가** — 함대 규칙 셋(대표·노출일·발행).
 * 원장이 없는 배포·프로젝트 표면에서는 `true`(제약 없음).
 *
 * ── ⚠️ **숨김은 여기서 안 본다** (2026-09-20 수리, G2 가 드러냄) ─────────────
 *
 * 초판은 `AND sc.hidden_reason IS NULL` 을 이 조각 안에 묶고 있었다. 그런데 그 항은
 * **범위(`hidden_scope`)를 안 본다** — 0071 이 만든 `'citations'`(인용만 깨진 회차)까지
 * 통째로 떨어뜨린다. 그 결과 **언급 계열에서도** 그 회차가 사라졌고, 그것은 0071 결정
 * ("멘션은 살려줘야 해")과 정면으로 어긋난다. 사실표는 반대로 동작한다:
 * `cycle-set.ts::judgeCycleRange` 가 `'citations'` 회차를 집합에 남기고
 * (`citationExcludedCycleIds` 로 인용 계열에서만 뺀다), 08-24 자리의 분모 18,716 이
 * 그 회차(9,650셀)를 포함한 값이다. 즉 **미러만 조용히 좁았다.**
 *
 * 그래서 숨김은 **계열 판정 한 곳**이 건다. 이 조각의 소비자 다섯 곳이 전부 그것을
 * 이미 나란히 걸고 있거나(앞 셋), 일부러 안 거는 자리다(뒤 둘):
 *   · `anchorPeriodPreds` · `anchorSnapshotPreds` · `anchorRunClause`
 *     → `anchorNotHiddenKnownSql(alias, family)` 가 **같은 배열 안에** 있다.
 *   · `listSelectableAnchorDates`(달력) → `anchorNotHiddenSql(family)` 를 함께 넘긴다.
 *   · `trendWindowFloor` · `trendAlignedRootPreds`(추이) → 숨긴 회차를 **갭 슬롯으로
 *     그려야** 하므로 값 술어 `excludeHiddenCycleRuns(family)` 가 따로 건다.
 *     (`trendWindowFloor` 머리 주석이 이미 그렇게 적혀 있었는데, 이 조각이 그 의도를
 *      뒤에서 깨고 있었다.)
 *
 * 이 수리로 **축 on 문장이 바뀐다**(축 off·키 off 는 무변경): 언급 계열의 기간·스냅샷·
 * run·달력 술어에서 `sc.hidden_reason IS NULL` 항이 빠지고, 대신 이미 있던
 * `NOT EXISTS (… hidden_scope='all')` 하나가 판정을 쥔다.
 */
export declare function anchorLedgerServableSql(alias?: string): Promise<SQL>;
/**
 * 표면별 "화면이 부르는 날짜" 컬럼 — **전 표면이 `round_date` 하나다**(스펙 §9 "귀속").
 *
 * `round_date` 는 회차의 **정규 요일 귀속 날짜**다(글로벌 = 월요일, 웹사이트 = 금요일,
 * KST. 프로젝트 표면은 정규 요일이 없어 `anchor_date` 와 같다). 달력이 칠하는 날짜와
 * 기간 술어가 거는 날짜가 **같은 컬럼**이어야 "고른 날짜에 데이터가 없는" 형태가
 * 생기지 않으므로, 두 축을 이 하나로 묶는다.
 *
 * ⚠️ `anchor_date`(실제 측정 회차의 KST 일자)는 **기록용**이다. 둘이 다른 것이 정상이고,
 * 화면·기간·주·월은 어느 것도 `anchor_date` 를 보지 않는다.
 *
 * 종전 판의 `fleet_round_date`(주별 최빈 대표일)와 그것을 대신하던 정렬 백필
 * (`align-website-anchor-weeks.ts`, `source='fleet_align'`)은 이 규칙으로 대체돼
 * 사라졌다. 정렬은 앵커 값을 옮겨야 했지만 귀속은 별도 컬럼이라 원본을 건드리지 않는다.
 *
 * 인자를 남겨 둔 이유는 표면별 축이 다시 갈릴 때 **여기 한 곳만** 고치기 위해서다.
 */
export declare const anchorDateColumnSql: (_surface: AnchorSurface, alias?: string) => SQL;
export declare function selectableAnchorDatesSql(surface: AnchorSurface, projectIds: string[], filters?: SelectableAnchorDateFilters,
/**
 * 숨김 게이트 — 호출부가 `anchorNotHiddenSql(family)` 를 await 해서 넘긴다.
 * 계열 선택의 근거는 `listSelectableAnchorDates` 의 `family` 주석에 있다.
 * 생략하면 제약 없음 — SQL 형태 테스트용이다.
 */
notHidden?: SQL,
/**
 * 함대 게이트 — 원장이 서빙을 허락한 회차만(`anchorLedgerServableSql`). 달력이 카드와
 * **같은 회차 집합**을 칠하게 하는 술어다. 생략하면 제약 없음(SQL 형태 테스트용).
 */
ledgerServable?: SQL): SQL;
/**
 * 달력이 **활성화할** 귀속 날짜 목록(스펙 §5.1). 오름차순 `YYYY-MM-DD` 문자열.
 *
 * 정규 요일 귀속이 들어간 뒤로 이 목록은 **글로벌 화면이면 월요일들, 웹사이트 화면이면
 * 금요일들**이다(프로젝트 표면만 실제 앵커 날짜 그대로). 목록이 요일 하나로 정렬돼
 * 보이는 것이 정상이고, 그렇지 않으면 배정이 어긋난 것이다 — 감사 SQL 의
 * `off_canonical_round_date` 가 그것을 잡는다.
 *
 * 반환값은 **직렬화 가능한 plain 값만**이다(문자열 배열). `unstable_cache` 셀에
 * Map 을 넣었다가 첫 로드만 정상이고 HIT 부터 세그먼트가 죽은 전례가 있다
 * (2026-09-18) — 이 리더는 캐시 셀 안쪽에서 불릴 것을 전제한다.
 *
 * 마이그레이션 미적용 배포에서는 **빈 배열**이다. 그때 달력은 종전대로(전 날짜 활성)
 * 동작해야 한다 — 빈 목록을 "선택 가능한 날짜가 없다"로 읽어 달력을 통째로 잠그면
 * 적용 전 창에 화면이 죽는다. 그 판단은 호출부(UI)의 몫이고, 여기서는 "모른다"를
 * 빈 배열로 표현할 뿐이다.
 */
export declare function listSelectableAnchorDates(surface: AnchorSurface, projectIds: string[], filters?: SelectableAnchorDateFilters,
/**
 * 숨김 게이트의 **지표 계열** — 그 달력이 붙은 화면의 계열이다.
 *
 * 기본이 느슨한 `'mentions'` 인 이유는 집계층 `DEFAULT_HIDDEN_FAMILY` 와 같다:
 * `'all'` 로 두면 인용만 깨져 숨긴 회차(`hidden_scope='citations'`)의 **멀쩡한
 * 언급 값까지** 달력에서 사라진다. 그러면 언급 화면에서 행은 보이는데 그 날짜를
 * 고를 수 없는 상태가 된다 — 이 전환이 없애려는 "달력 축 ≠ 기간 술어 축" 결함의
 * 거울상이다.
 *
 * 인용 화면의 달력은 `'citations'` 을 넘긴다. 그 회차는 인용 값이 없으므로 고를 수
 * 없는 것이 맞다.
 *
 * ⚠️ 계열이 **기준 회차를 가를 수 있다**(검증 N2 계약): 인용만 숨긴 회차가 최신이면
 * 언급 화면은 그 회차를, 인용 화면은 그 앞 회차를 본다. 한 화면 안에서는 달력·카드·
 * 드릴다운이 같은 계열을 쓰므로 갈리지 않는다.
 */
family?: AnchorHiddenFamily): Promise<string[]>;
