import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  answerCycleAnchorsAvailable,
  hiddenCycleColumnsAvailable,
  hiddenCycleScopeAvailable,
} from "@/lib/db/column-availability";
import { summaryLedgerAvailable } from "@/lib/db/repositories/summary-settings";
// 앵커 축 SQL 조각의 **정본**(`lib/period/anchor-axis.ts`). 컬럼 리터럴을 여기 또
// 적지 않는다 — 두 벌이 되면 한쪽만 고쳐질 때 달력이 칠하는 날짜와 기간 술어가 거는
// 날짜가 갈린다. 그 모듈은 drizzle 만 import 하는 잎이라 순환이 생길 수 없다
// (사슬: anchor-axis-state → scope-answer-anchors → anchor-axis).
import { anchorDefaultEngineScope, anchorRoundDateSql } from "@/lib/period/anchor-axis";

// 답변 단위 회차 앵커 전수 테이블(0077)의 **읽기** 경로.
// 정본 스펙: internal-kb/hmg-geo-answer-anchor-table-spec-2026-09-19.md §5.1
//
// 이 단계(1단계)의 유일한 리더는 달력용 "선택 가능한 날짜 목록"이다. 기존 화면의
// 기간 술어 전환(스펙 §5 표)은 **이 단계 범위 밖**이므로 여기에 넣지 않는다 —
// 리더를 먼저 늘리면 화면 키가 붙기 전에 두 시계가 동시에 돌게 된다.

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
export const ANCHOR_TO_LEDGER_SURFACE = {
  standard: "global",
  website: "website",
  project: "project",
} as const satisfies Record<AnchorSurface, LedgerSurface>;

export const toLedgerSurface = (s: AnchorSurface): LedgerSurface => ANCHOR_TO_LEDGER_SURFACE[s];

export function toAnchorSurface(s: LedgerSurface): AnchorSurface {
  const hit = (Object.keys(ANCHOR_TO_LEDGER_SURFACE) as AnchorSurface[]).find(
    (k) => ANCHOR_TO_LEDGER_SURFACE[k] === s,
  );
  // 원장 CHECK 밖의 값이 들어오면 조용히 기본값으로 접지 않는다(표면이 섞인다).
  if (!hit) throw new Error(`unknown ledger surface: ${String(s)}`);
  return hit;
}

/**
 * 앵커 테이블의 `surface` 식을 원장 어휘로 바꾸는 SQL. 위 맵에서 **파생**한다(두 벌 금지).
 * 예) `... JOIN summary_cycles c ON c.surface = ${ledgerSurfaceSql("ca")}`
 * 값은 코드 상수뿐이라 리터럴로 넣는다(바인드로 넣으면 CASE 결과 타입이 text 로
 * 추론되지 않는 드라이버 함정을 피한다). 모르는 값은 NULL → 조인 불성립(기본 거부).
 */
export function ledgerSurfaceSql(alias = "ca"): SQL {
  const col = sql.raw(`${alias}.surface`);
  const arms = (Object.entries(ANCHOR_TO_LEDGER_SURFACE) as Array<[AnchorSurface, LedgerSurface]>).map(
    ([from, to]) => sql.raw(`WHEN '${from}' THEN '${to}'`),
  );
  return sql`(CASE ${col} ${sql.join(arms, sql.raw(" "))} END)`;
}

// ── 원장 → 앵커 테이블 **전파** (스펙 §4 · §9 "전파" · B2) ────────────────────
//
// 회차 원장(`summary_cycles`·`summary_cycle_runs`)이 바뀌면 이 테이블의 파생값
// (`anchor_date` 의 ledger 출처 · `view_anchor_date` · `cycle_id`)도 같이 움직여야 한다.
// 종전에는 `refresh_answer_cycle_anchors` 의 비테스트 호출이 **미러 재싱크와 백필뿐**
// 이라, 회차를 발행해도 그 run 이 우연히 재싱크될 때까지 `view_anchor_date` 가 NULL 로
// 남았다(B2 — 유령 회차 사고와 같은 종류).
//
// DB 트리거를 쓰지 않는 이유(스펙 §9 "전파"): 원장 UPDATE 는 관제 틱마다 대량으로
// 돌아서 트리거가 락·비용을 어디까지 끌어올지 EXPLAIN 없이는 알 수 없다. 대신
// **쓰는 코드 경로에서 명시 호출** + 야간 정합 감사로 누락을 잡는다
// (`scripts/db/answer-cycle-anchors-audit.sql`).
//
// ⚠️ 숨김(`hidden_reason`·`hidden_scope`)은 전파 대상이 **아니다** — 테이블에 복사하지
// 않고 리더가 조인하므로(R3), 숨기고 푸는 경로는 이 호출이 필요 없다.

/** 0077 전파 호출을 발행해도 되는가 — 함수·테이블이 한 마이그레이션에서 함께 생긴다. */
export const answerCycleAnchorsWritable = answerCycleAnchorsAvailable;

/**
 * run 집합의 앵커 행을 다시 계산한다. `runIds` 가 비면 `null` — 호출부가 문장을
 * 발행하지 않는다(빈 배열로 부르면 함수가 0을 돌려주지만 왕복이 낭비다).
 *
 * `rootProjectId` 는 표면 판정의 'standard' 근거(B4). 앱 정본은
 * `lib/scope/result-adapter.ts::getRootConfig()?.projectId` 이고, NULL 이면 DB 함수가
 * 원장 출력 폴백으로 돌며 NOTICE 를 남긴다.
 */
export function refreshAnchorsForRunsSql(
  runIds: string[],
  rootProjectId: string | null,
): SQL | null {
  if (runIds.length === 0) return null;
  return sql`SELECT refresh_answer_cycle_anchors(${sql.param(runIds)}::uuid[], ${rootProjectId}::uuid)`;
}

/**
 * 한 회차에 귀속된 run 전체의 앵커 행을 다시 계산한다.
 *
 * run 목록을 앱으로 가져왔다가 다시 넣지 않고 **서브쿼리로 넘긴다** — 회차 발행은
 * 스왑 트랜잭션 안이라 왕복을 늘리지 않는 편이 낫고, 그 사이 귀속이 바뀔 창도 없앤다.
 * 귀속된 run 이 하나도 없으면 빈 배열이 들어가 함수가 0을 돌려준다(무해).
 */
export function refreshAnchorsForCycleSql(
  cycleId: string,
  rootProjectId: string | null,
): SQL {
  return sql`SELECT refresh_answer_cycle_anchors(
      ARRAY(SELECT run_id FROM summary_cycle_runs WHERE cycle_id = ${cycleId}::uuid)::uuid[],
      ${rootProjectId}::uuid)`;
}

// ════════════════════════════════════════════════════════════════════════════
// 전파 호출의 **격리** — 앵커 쓰기가 본 작업을 죽이면 안 된다 (검증 D3·D2·D13)
// ════════════════════════════════════════════════════════════════════════════
//
// 이 전파는 **옵트인 밖**이다: 화면 키가 꺼져 있어도 배포 즉시 돈다(미러 싱크 1문장,
// 회차 발행 1문장). 그런데 지금까지는 본 트랜잭션 안에서 맨몸으로 발행됐고, 그래서
// 앵커 재계산이 던지면 **그 run 의 미러 싱크 전체**(답변·언급·인용·ACR 삽입)나
// **회차 발행 전체**가 함께 롤백됐다.
//
// capability 프로브는 컬럼 존재만 본다 — 막지 못하는 실패가 남아 있다:
//   · `pg_advisory_xact_lock` 대기 → `lock_timeout`
//   · 회차 전체 확장의 `statement_timeout`(최대 회차 run 1,348 · 답변 약 5.6만)
//   · 교착
//
// 그래서 **savepoint 안에서** 부른다. 실패하면 savepoint 만 되감고 경고를 남긴 뒤
// 본 작업은 계속한다. 축은 옵트인이라 앵커 행이 없어도 화면은 종전 축으로 돈다.
//
// ── 누락은 어떻게 회수되나 ────────────────────────────────────────────────
// `scripts/db/answer-cycle-anchors-audit.sql` 의 `missing_rows`(완료 답변인데 앵커 행
// 없음)와 `view_anchor_drift`(원장 노출일과 앵커 노출일 불일치)가 **긴급(2)** 으로
// 잡는다. 회수는 같은 함수를 다시 부르는 것뿐이다 — 재계산은 멱등이고, 다음 정규
// 재싱크나 `npm run db:backfill:answer-anchors` 가 그 창을 메운다.
//
// ── savepoint 는 drizzle 의 중첩 트랜잭션이다 ────────────────────────────
// postgres-js 드라이버에서 `tx.transaction(cb)` 은 `client.savepoint(cb)` 로 내려간다
// (`node_modules/drizzle-orm/postgres-js/session.cjs`). 콜백이 던지면 드라이버가
// `ROLLBACK TO SAVEPOINT` 를 내고 다시 던지므로, 바깥 트랜잭션은 **살아 있다**.

/** 격리 실행이 받는 최소 계약. `transaction` 이 있으면 savepoint 경로를 탄다. */
export interface AnchorRefreshTx {
  execute(query: SQL): Promise<unknown>;
  transaction?<T>(fn: (inner: { execute(query: SQL): Promise<unknown> }) => Promise<T>): Promise<T>;
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
export async function runAnchorRefreshIsolated(
  tx: AnchorRefreshTx,
  /** 로그 식별자 — `mirror-sync` · `cycle-publish` 처럼 호출 지점을 가리킨다. */
  op: string,
  /** 대상 식별자(run_id·cycle_id). 비밀값이 아니다. */
  scope: string,
  stmt: SQL,
): Promise<boolean> {
  if (typeof tx.transaction !== "function") {
    await tx.execute(stmt);
    return true;
  }
  try {
    await tx.transaction(async (inner) => {
      await inner.execute(stmt);
    });
    return true;
  } catch (e) {
    // 구조화 한 줄. 비밀값을 싣지 않는다 — 메시지와 SQLSTATE 만.
    const err = e as { message?: unknown; code?: unknown };
    console.warn(
      `[anchor-refresh] isolated-rollback op=${op} scope=${scope} ` +
        `code=${typeof err?.code === "string" ? err.code : "none"} ` +
        `msg=${typeof err?.message === "string" ? err.message : String(e)}`,
    );
    return false;
  }
}

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

/** 달력이 한 번에 칠할 수 있는 날짜 수의 상한 — 무제한 스캔 방지. */
const MAX_DATES = 400;

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
export const anchorViewableSql = (alias = "ca"): SQL =>
  sql`${sql.raw(alias)}.view_anchor_date IS NOT NULL
      AND ${sql.raw(alias)}.view_anchor_date <= hmg_anchor_today()`;

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
export async function anchorNotHiddenSql(
  family: AnchorHiddenFamily,
  alias = "ca",
): Promise<SQL> {
  if (!(await hiddenCycleColumnsAvailable())) return sql`true`;
  const scopeAware = family === "mentions" && (await hiddenCycleScopeAvailable());
  const hidden = scopeAware
    ? sql`(c.hidden_reason IS NOT NULL AND COALESCE(c.hidden_scope, 'all') = 'all')`
    : sql`c.hidden_reason IS NOT NULL`;
  return sql`NOT EXISTS (
    SELECT 1 FROM summary_cycles c
     WHERE c.cycle_id = ${sql.raw(alias)}.cycle_id
       AND ${hidden}
  )`;
}

// ════════════════════════════════════════════════════════════════════════════
// **함대 규칙** — 집계층이 "지금 서빙해도 되는 회차" 를 고르는 술어 (프리뷰 실측)
// ════════════════════════════════════════════════════════════════════════════
//
// 2026-09-20 프리뷰 실측: `/ko/website` 에서 메인 카드는 09-11 인데 달력의 기본 회차
// 표식과 하위 탭은 **09-18** 이었다. 한 지면이 블록마다 다른 회차를 봤다.
//
// 원인은 두 경로가 **다른 완결성 기준**을 쓰는 것이다:
//   · 집계층(카드) — `summary-cycles.ts::pickWebsiteCycles` 가 원장에서 고른다:
//     `fleet_visible` · `view_anchor_at <= now()` · **`active_generation_id IS NOT NULL`**
//     (= 요약 세대가 발행됐다) · 숨김 아님. 즉 "원장이 서빙을 허락한 회차" 다.
//   · 앵커 축(달력·미러 스냅샷) — 행 단위 게이트만 봤다: `ca.view_anchor_date` ·
//     숨김 · 기본 엔진. 미러에 답변이 들어오면 요약 발행 전에도 최신 회차가 된다.
// 미러 싱크는 요약 생성과 독립이라 그 창에서 두 값이 갈린다.
//
// 결정(메인 2026-09-20): **집계층의 함대 규칙이 정본이다.** 고객이 지금 보는 값이 그
// 기준이므로, 축을 켠다고 카드 이외 블록만 앞서가면 안 된다.
//
// ── 왜 표면을 인자로 받지 않는가 ───────────────────────────────────────────
// 술어가 **행의 `surface` 를 스스로 본다**. `answerWhere` 계열 빌더는 표면을 모르고
// (프로젝트 id 목록만 받는다) 표면을 인자로 흘리면 호출부 열몇 곳을 고쳐야 한다.
// 프로젝트 표면은 회차 원장이 없으므로(스펙 §3.3) 그 팔에서 통과시킨다.
//
// ⚠️ `cycle_id` 가 NULL 인 website·global 행은 **빠진다**. 원장이 허락한 적 없는 행이고
//    (`source='fallback_measured'`), 스펙 R4 의 그 두 프로젝트는 project 표면이라 위
//    팔에서 통과한다.
//
// ⚠️ 정의가 두 벌이 된다 — `summary-cycles.ts` 를 import 하면 순환이다(저쪽이 이 파일을
//    이미 import 한다: 원장 → 앵커 전파). 그래서 술어를 여기 복제하고, 두 텍스트가
//    같은지는 `scope-answer-anchors.fleet-gate.test.ts` 가 컴파일 결과로 대조한다.

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
export async function anchorLedgerServableSql(alias = "ca"): Promise<SQL> {
  if (!(await summaryLedgerAvailable())) return sql`true`;
  const a = sql.raw(alias);
  return sql`(${a}.surface = 'project' OR EXISTS (
    SELECT 1 FROM summary_cycles sc
     WHERE sc.cycle_id = ${a}.cycle_id
       AND sc.fleet_visible
       AND sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at <= now()
       AND sc.active_generation_id IS NOT NULL
  ))`;
}

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
export const anchorDateColumnSql = (_surface: AnchorSurface, alias = "ca"): SQL =>
  anchorRoundDateSql(alias);

/** 배열 바인드는 `sql.param` 으로만 — 템플릿에 JS 배열을 직접 넣으면 record 로 묶인다. */
const uuidArray = (ids: string[]): SQL => sql`${sql.param(ids)}::uuid[]`;
const textArray = (vs: string[]): SQL => sql`${sql.param(vs)}::text[]`;

export function selectableAnchorDatesSql(
  surface: AnchorSurface,
  projectIds: string[],
  filters: SelectableAnchorDateFilters = {},
  /**
   * 숨김 게이트 — 호출부가 `anchorNotHiddenSql(family)` 를 await 해서 넘긴다.
   * 계열 선택의 근거는 `listSelectableAnchorDates` 의 `family` 주석에 있다.
   * 생략하면 제약 없음 — SQL 형태 테스트용이다.
   */
  notHidden: SQL = sql`true`,
  /**
   * 함대 게이트 — 원장이 서빙을 허락한 회차만(`anchorLedgerServableSql`). 달력이 카드와
   * **같은 회차 집합**을 칠하게 하는 술어다. 생략하면 제약 없음(SQL 형태 테스트용).
   */
  ledgerServable: SQL = sql`true`,
): SQL {
  const dateCol = anchorDateColumnSql(surface);
  const conds: SQL[] = [
    sql`ca.surface = ${surface}`,
    sql`ca.project_id = ANY(${uuidArray(projectIds)})`,
    anchorViewableSql(),
    notHidden,
    ledgerServable,
  ];
  // ⚠️ **기본 엔진 범위** — 집계층의 회차 선택(`anchorSnapshotPreds` ·
  // `anchorPeriodPreds`)이 엔진 필터가 비었을 때 `is_default_engine` 을 거는 것과
  // 같은 규칙이다. 안 걸면 옵트인 엔진(DeepSeek 파일럿)만 있는 회차가 달력에는
  // 뜨는데 화면은 비는, "고를 수 있는데 데이터가 없는 날짜"가 생긴다.
  const engineScope = anchorDefaultEngineScope(filters.engines);
  if (engineScope) conds.push(engineScope);
  // ⚠️ 날짜 경계는 **명시 캐스트**다. 바인드가 text 로 추론되면 42883 으로 화면이
  // 통째로 죽는다(2026-09-16 인용 화면 전면 실패의 형태).
  if (filters.from) conds.push(sql`${dateCol} >= ${filters.from}::date`);
  if (filters.to) conds.push(sql`${dateCol} <= ${filters.to}::date`);

  // 엔진·국가 필터는 미러 답변 쪽 차원이라 그때만 조인한다(없으면 앵커 테이블 단독).
  const needsAnswers = Boolean(filters.engines?.length || filters.countries?.length);
  if (filters.engines?.length) {
    conds.push(sql`a.target = ANY(${textArray(filters.engines)})`);
  }
  if (filters.countries?.length) {
    conds.push(sql`a.region = ANY(${textArray(filters.countries)})`);
  }

  const join = needsAnswers ? sql` JOIN scope_answers a ON a.job_id = ca.job_id` : sql``;
  const where = sql.join(conds, sql` AND `);
  // ⚠️ 상한은 **최신 날짜부터** 자른다(B10). 종전에는 오름차순 + LIMIT 이라 목록이
  // 상한을 넘으면 잘려 나가는 쪽이 **최근 날짜**였다 — 달력에서 이번 주가 비활성으로
  // 보이는, 화면만 봐서는 원인을 알 수 없는 형태다. 안쪽에서 DESC 로 상한을 걸고
  // 바깥에서 오름차순으로 되돌린다(반환 계약은 그대로 오름차순).
  return sql`
    SELECT to_char(d, 'YYYY-MM-DD') AS d
      FROM (
        SELECT d FROM (
          SELECT DISTINCT ${dateCol} AS d
            FROM scope_answer_cycle_anchors ca${join}
           WHERE ${where}
        ) s
         WHERE d IS NOT NULL
         ORDER BY d DESC
         LIMIT ${MAX_DATES}::int
      ) t
     ORDER BY d
  `;
}

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
export async function listSelectableAnchorDates(
  surface: AnchorSurface,
  projectIds: string[],
  filters: SelectableAnchorDateFilters = {},
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
  family: AnchorHiddenFamily = "mentions",
): Promise<string[]> {
  if (projectIds.length === 0) return [];
  if (!(await answerCycleAnchorsAvailable())) return [];
  try {
    // 시간 게이트(`anchorViewableSql`) **와** 숨김 게이트를 나란히 건다.
    const notHidden = await anchorNotHiddenSql(family);
    // 함대 게이트 — 달력이 카드와 같은 회차 집합을 칠하게 한다(프리뷰 실측 2026-09-20).
    const ledgerServable = await anchorLedgerServableSql();
    const rows = (await getDb().execute(
      selectableAnchorDatesSql(surface, projectIds, filters, notHidden, ledgerServable),
    )) as unknown as Array<{ d: string | null }>;
    return rows.map((r) => r.d).filter((d): d is string => typeof d === "string");
  } catch (e) {
    // 달력 하나 때문에 화면이 죽지 않게 한다. 프로브가 true 인데 실패했다면 그건
    // 결함이므로 로그에는 남긴다(조용한 빈 목록은 "선택지 없음"과 구분되지 않는다).
    // 구조화 한 줄 — 비밀값 없이 표면·계열·프로젝트 수·SQLSTATE·메시지만.
    const err = e as { message?: unknown; code?: unknown };
    console.warn(
      `[answer-anchors] selectable-dates-query-failed surface=${surface} ` +
        `family=${family} projects=${projectIds.length} ` +
        `code=${typeof err?.code === "string" ? err.code : "none"} ` +
        `msg=${typeof err?.message === "string" ? err.message : String(e)}`,
    );
    return [];
  }
}
