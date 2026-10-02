import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";

// ════════════════════════════════════════════════════════════════════════════
// 현재 노출 회차의 **지문** 읽기 — 앵커 축 캐시 셀 키의 회차 정체성 (2026-09-27)
// ════════════════════════════════════════════════════════════════════════════
//
// 왜·어디에 쓰는지는 소비자 `lib/period/cycle-fingerprint.ts` 머리 주석이 정본이다.
// 여기는 **문장·가용성 프로브·실행 상한**만 쥔다(`@/lib/db` 는 lib/db 밖에서 import 금지).
//
// ── 지문은 둘이다 (hmg-geo PR #297 검증 C4 반영, 2026-09-27 개정) ─────────────
//
// 초판은 원장 전 행의 상태·세대 id·노출 규칙을 해시해, 요약 생성 구간(9/26 13:09~14:11Z,
// 세대 107개·원장 이벤트 213개)에 지문이 30초마다 바뀌었다. 콜드 계산(20~56초)이 끝나기
// 전에 키가 바뀌어 그 1시간 축 on 적중률이 사실상 0 이었다. 그래서 **셀이 실제로 읽는
// 게이트 입력만** 싣는다.
//
//   · `fp_gate`(일반 미러 셀) — 앵커 축 셀이 읽는 게이트는 셋이다.
//       ① 서빙 게이트 `anchorLedgerServableSql`(scope-answer-anchors.ts:351-360)
//          = fleet_visible ∧ view_anchor_at ≤ now() ∧ active_generation_id IS NOT NULL
//       ② 숨김 게이트 `anchorNotHiddenSql` = hidden_reason 유무 + hidden_scope
//       ③ 노출일 게이트 `anchorViewableSql` = 행 view_anchor_date ≤ hmg_anchor_today()
//     그래서 회차마다 (① 불리언, ② 숨김 여부·범위)를 싣되 **① 이 참이거나 숨긴 회차만**
//     넣는다(새로 열린 회차·생성 중 회차는 행이 늘어도 지문이 그대로다). state(0078)는
//     **노출일이 지난 회차만** (회차 키·표면·round_date·anchor_date·노출일)을 싣는다.
//     오늘(KST, `hmg_anchor_today()`)도 싣는다 — 추이 바닥(`trendWindowFloor`)과 노출일
//     게이트가 이 날짜를 직접 읽으므로(검증 G2·G4) 하루 한 번 바뀌는 것을 수용한다.
//     서빙 중 회차는 **run 멤버십**(수·run_id 해시 합, 재검증 V4)을, 서빙 중 **global**
//     회차는 세대 id(재검증 V1, global 세대별 dim 조인)를 함께 싣는다(`gateLedgerComponentSql`).
//     `status` 문자열·website/project 세대 id·진행률은 **안 싣는다**: 앵커 축 게이트가 안 읽는다.
//     (축 on 의 미러 경로에서 `summary_cycles.status` 를 읽는 유일한 자리는
//      `excludeHiddenCycleRuns` 의 원장 분기(scope-aggregates.ts:3858)인데, 축 on 이고
//      job/run 열을 넘기면 그 앞(3838)에서 앵커 게이트로 반환한다. 호출부 8곳이 전부
//      job 또는 run 열을 넘긴다.)
//   · `fp_ledger`(`period-compare` 셀) — 기간 비교 리더(`summary-period-compare.ts`
//     `ledgerScopeConds`)는 `status <> 'open'/'generating'`·`view_anchor_at > now()`·
//     fleet_visible·숨김을 읽고, 사실표를 **`active_generation_id` 로 조인**한다. 그래서
//     `fp_gate` 성분에 더해 종결 회차의 (표면·fleet·노출 전후·세대 id·앵커 시각·숨김)을 싣는다.
//
// ── 실행 상한 (검증 C3) ─────────────────────────────────────────────────────
// 읽기 전용 트랜잭션 + `statement_timeout` 2초 + `lock_timeout` 1초. 커넥션 획득 대기까지
// 포함한 벽시계 상한(4초)은 소비자가 건다. 이 상한은 **지문 조회만** 묶는다 — 같은 경로의
// `ensureAnchorAxis`·`ensureTrendGrid`(설정 행 읽기)는 상한 없이 풀 대기에 묶이므로, 풀
// 포화나 DDL 락이 캐시 적중 요청을 붙잡는 것을 이 PR 이 막지는 못한다(재검증, 범위 밖).
// 상한을 넘기면 요청은 풀려나지만 뒤에 걸린 트랜잭션 자체는 취소되지 않는다.
//
// 비용(2026-09-27 미러 실측, 3차 문장 EXPLAIN ANALYZE): 실행 **36.6 ms**. 대부분이 멤버십
// `GROUP BY`(약 13 ms)이고 `fp_gate`·`fp_ledger` 가 같은 성분을 품어 **두 번** 돈다. 5.2 ms 는
// 멤버십이 없던 초판 수치다. 메모가 5분 경계라 람다당 5분에 1회다.

/** 지문 성분이 기대는 스키마 — 없으면 그 성분이 빠진다(에러가 아니다). */
export type CycleFingerprintCaps = {
  /** 0078 `scope_cycle_anchor_state` */
  stateTable: boolean;
  /** 0077 `hmg_anchor_view_date(text,date,date)` · `hmg_anchor_today()` */
  viewFns: boolean;
  /** 0059 `summary_cycles`·`summary_cycle_runs`(한 마이그레이션) */
  ledger: boolean;
  /** 0070 `summary_cycles.hidden_reason` */
  hiddenCols: boolean;
  /** 0071 `summary_cycles.hidden_scope` */
  hiddenScope: boolean;
};

/** 두 지문(md5 hex 32자). */
export type CycleFingerprints = { gate: string; ledger: string };

const day = (e: SQL): SQL => sql`coalesce(to_char(${e}, 'YYYY-MM-DD'), '~')`;
// timestamptz 는 세션 TimeZone·DateStyle 을 타지 않게 epoch 로 적는다(0078 hmg_cycle_key 와 같은 이유).
const epoch = (e: SQL): SQL => sql`coalesce(extract(epoch from ${e})::text, '~')`;

/** 성분 ③ — 노출일이 지난 회차의 회차 수준 값. */
function stateComponentSql(): SQL {
  const view = sql`hmg_anchor_view_date(st.surface, st.anchor_date, st.ledger_view_date)`;
  return sql`(SELECT coalesce(string_agg(concat_ws(':',
        st.cycle_key, st.surface, ${day(sql`st.round_date`)}, ${day(sql`st.anchor_date`)},
        ${day(view)}), ',' ORDER BY st.cycle_key), '')
     FROM scope_cycle_anchor_state st
    WHERE ${view} <= hmg_anchor_today())`;
}

/** 숨김 여부·범위 — `'-'`(숨김 없음) 또는 범위(`all`·`citations`). */
function hiddenFlagSql(caps: CycleFingerprintCaps): SQL {
  if (!caps.hiddenCols) return sql`'-'`;
  const scope = caps.hiddenScope ? sql`coalesce(sc.hidden_scope, 'all')` : sql`'all'`;
  return sql`CASE WHEN sc.hidden_reason IS NULL THEN '-' ELSE ${scope} END`;
}

const hiddenPredSql = (caps: CycleFingerprintCaps): SQL =>
  caps.hiddenCols ? sql`sc.hidden_reason IS NOT NULL` : sql`false`;

/** 서빙 게이트 — `anchorLedgerServableSql` 의 원장 조건과 같은 식. */
const SERVABLE_SQL = sql`(sc.fleet_visible AND sc.view_anchor_at IS NOT NULL
      AND sc.view_anchor_at <= now() AND sc.active_generation_id IS NOT NULL)`;

/**
 * 성분 ①② — 서빙 가능하거나 숨긴 회차의 (서빙 여부, 숨김, 서빙 중이면 멤버십·global 세대).
 *
 * ── 서빙 중 회차의 **run 멤버십** (재검증 V4) ──────────────────────────────
 * 앵커 행의 `cycle_id` 는 `summary_cycle_runs` 귀속을 따라간다. 요약 생성기
 * (`upsertCycleRunsSql`, attributed_by='operator')가 이미 서빙 중인 회차에 run 을 늦게
 * 붙이면 그 셀 값이 바뀌는데, 그 경로는 싱크 무효화를 안 거친다. 14일 실측: 생성기
 * (operator) 경로 14건(website, 최대 5h45m)에 더해 **관제 late 경로**로 서빙 중 global 회차
 * 8907690a 에 17건(9/15 18:40~9/16 04:40Z)이 있었다. 이 성분은 둘 다 잡는다.
 * 그래서 서빙 중 회차마다 (run 수, run_id 해시 합)을 싣는다 — 합은 순서와 무관하고
 * **같은 수로 다른 run 이 된 경우**(이동)도 잡는다(`ON CONFLICT` 가 `attributed_at` 을
 * 안 고치므로 시각 최대값으로는 이동을 못 본다). 서빙 전 회차는 싣지 않는다 — 드레인
 * 중 귀속이 매 틱 전 셀을 콜드로 만들지 않게.
 *
 * ── 서빙 중 **global** 회차의 세대 id (재검증 V1) ───────────────────────────
 * `trendDimJoinSql`·`trendDimScopedJobIds`(scope-aggregates.ts:1389-1403·1499-1555)가
 * `pd.generation_id = sc.active_generation_id` 로 global 세대별 dim 을 조인한다(축·격자 on).
 * website·project 표면에는 세대 정체성을 읽는 미러 리더가 없다(`trendDimSnapshotAuditSql`
 * 은 감사 전용). 그래서 global 에만 싣는다(14일 관측 0건이라 콜드 비용은 사실상 없다).
 */
function gateLedgerComponentSql(caps: CycleFingerprintCaps): SQL {
  return sql`(SELECT coalesce(string_agg(concat_ws(':', sc.cycle_id::text,
        ${SERVABLE_SQL}::text, ${hiddenFlagSql(caps)},
        CASE WHEN ${SERVABLE_SQL} AND sc.surface = 'global'
             THEN coalesce(sc.active_generation_id::text, '~') ELSE '-' END,
        CASE WHEN ${SERVABLE_SQL}
             THEN coalesce(m.n::text, '0') || '/' || coalesce(m.h::text, '0') ELSE '-' END),
        ',' ORDER BY sc.cycle_id)
        FILTER (WHERE ${SERVABLE_SQL} OR ${hiddenPredSql(caps)}), '')
     FROM summary_cycles sc
     LEFT JOIN (SELECT r.cycle_id, count(*) AS n, sum(hashtext(r.run_id::text)::bigint) AS h
                  FROM summary_cycle_runs r GROUP BY r.cycle_id) m
       ON m.cycle_id = sc.cycle_id)`;
}

/** 기간 비교 전용 성분 — 종결 회차의 (표면·fleet·노출 전후·세대 id·앵커 시각·숨김). */
function periodLedgerComponentSql(caps: CycleFingerprintCaps): SQL {
  return sql`(SELECT coalesce(string_agg(concat_ws(':', sc.cycle_id::text, sc.surface,
        sc.fleet_visible::text,
        (sc.view_anchor_at IS NOT NULL AND sc.view_anchor_at > now())::text,
        coalesce(sc.active_generation_id::text, '~'), ${epoch(sql`sc.cycle_anchor_at`)},
        ${hiddenFlagSql(caps)}), ',' ORDER BY sc.cycle_id)
        FILTER (WHERE sc.status <> 'open' AND sc.status <> 'generating'), '')
     FROM summary_cycles sc)`;
}

/**
 * 지문 문장(한 행 · `fp_gate`·`fp_ledger`). 가용성은 호출부가 먼저 확정한다 —
 * 없는 표를 참조하는 문장은 파싱 단계에서 죽기 때문이다.
 */
export function cycleFingerprintSql(caps: CycleFingerprintCaps): SQL {
  const flags = [caps.stateTable, caps.viewFns, caps.ledger, caps.hiddenCols, caps.hiddenScope]
    .map((b) => (b ? "1" : "0"))
    .join("");
  const today = caps.viewFns ? day(sql`hmg_anchor_today()`) : sql`'~'`;
  const state = caps.stateTable && caps.viewFns ? stateComponentSql() : sql`'~'`;
  const gate = caps.ledger ? gateLedgerComponentSql(caps) : sql`'~'`;
  const period = caps.ledger ? periodLedgerComponentSql(caps) : sql`'~'`;
  return sql`SELECT
      md5(concat_ws('#', ${flags}::text, ${today}, ${state}, ${gate})) AS fp_gate,
      md5(concat_ws('#', ${flags}::text, ${today}, ${state}, ${gate}, ${period})) AS fp_ledger`;
}

/**
 * 가용성 프로브 — 한 문장. **실패는 throw 다**(= 지문 실패). `column-availability` 의
 * 프로브를 쓰지 않는 이유: 그쪽은 DB 오류를 "컬럼 없음(false)"으로 접는다. 여기서 그렇게
 * 접으면 성분이 조용히 빠진 **거친 지문이 성공으로** 나가고, 그 키에 셀이 굳는다.
 */
export const CYCLE_FINGERPRINT_CAPS_SQL = sql`SELECT
    to_regclass('public.scope_cycle_anchor_state') IS NOT NULL AS state_table,
    (to_regprocedure('public.hmg_anchor_view_date(text,date,date)') IS NOT NULL
      AND to_regprocedure('public.hmg_anchor_today()') IS NOT NULL) AS view_fns,
    (to_regclass('public.summary_cycles') IS NOT NULL
      AND to_regclass('public.summary_cycle_runs') IS NOT NULL) AS ledger,
    EXISTS (SELECT 1 FROM pg_attribute
             WHERE attrelid = to_regclass('public.summary_cycles')
               AND attname = 'hidden_reason' AND NOT attisdropped) AS hidden_cols,
    EXISTS (SELECT 1 FROM pg_attribute
             WHERE attrelid = to_regclass('public.summary_cycles')
               AND attname = 'hidden_scope' AND NOT attisdropped) AS hidden_scope`;

type CapsRow = {
  state_table: unknown;
  view_fns: unknown;
  ledger: unknown;
  hidden_cols: unknown;
  hidden_scope: unknown;
};

/** 문장 상한(ms). 실측 5 ms 의 400배 — 정상 경로를 자르지 않는다. */
export const CYCLE_FINGERPRINT_STATEMENT_TIMEOUT_MS = 2_000;
/** 락 대기 상한(ms). `summary_cycles`·state 표 DDL 이 적중 경로까지 멈추지 않게. */
export const CYCLE_FINGERPRINT_LOCK_TIMEOUT_MS = 1_000;

/**
 * 가용성은 **전부 참일 때만** 프로세스 수명 동안 기억한다. 하나라도 거짓이면 매 판정마다
 * 다시 묻는다(적용 직후 곧바로 성분이 붙게). 기억한 표·함수가 **사라지면**(0078 롤백 등,
 * 검증 D5) 문장이 42P01·42883·42703 으로 죽는다 — 그때 기억을 비워 다음 판정이 다시
 * 프로브하게 한다. 비우지 않으면 매 판정이 같은 오류로 실패해 5분 버킷 콜드가 이어진다.
 */
let capsCache: CycleFingerprintCaps | null = null;
const MISSING_OBJECT_CODES = new Set(["42P01", "42883", "42703"]);

type Exec = { execute: (q: SQL) => Promise<unknown> };

async function readCaps(tx: Exec): Promise<CycleFingerprintCaps> {
  if (capsCache) return capsCache;
  const rows = (await tx.execute(CYCLE_FINGERPRINT_CAPS_SQL)) as unknown as CapsRow[];
  const r = rows[0];
  if (!r) throw new Error("cycle-fingerprint: 가용성 프로브가 행을 돌려주지 않았다");
  const caps: CycleFingerprintCaps = {
    stateTable: r.state_table === true,
    viewFns: r.view_fns === true,
    ledger: r.ledger === true,
    hiddenCols: r.hidden_cols === true,
    hiddenScope: r.hidden_scope === true,
  };
  if (Object.values(caps).every(Boolean)) capsCache = caps;
  return caps;
}

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * 오류의 SQLSTATE. drizzle-orm 0.45 의 `queryWithCache` 는 쿼리 오류를 `DrizzleQueryError`
 * 로 **감싸** 원래 코드를 `cause.code` 에 둔다(재검증 K4: 표 rename 재현에서 `e.code` 는
 * undefined, `e.cause.code` = 42P01). 리포 관례(`project-members.ts` 의
 * `projectMemberSchemaErrorCode`)대로 원인 먼저, 없으면 최상위를 본다.
 */
export function cycleFingerprintErrorCode(err: unknown): string | undefined {
  const e = err as { cause?: { code?: unknown }; code?: unknown } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 현재 노출 회차 지문 둘. DB 오류·형식 오류는 **throw** — 폴백은 소비자
 * (`lib/period/cycle-fingerprint.ts`)가 정한다. 읽기 전용 트랜잭션 안에서 문장·락 상한을 건다.
 */
export async function readCycleFingerprints(): Promise<CycleFingerprints> {
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(
        sql`SET LOCAL statement_timeout = ${sql.raw(`'${CYCLE_FINGERPRINT_STATEMENT_TIMEOUT_MS}ms'`)}`,
      );
      await tx.execute(
        sql`SET LOCAL lock_timeout = ${sql.raw(`'${CYCLE_FINGERPRINT_LOCK_TIMEOUT_MS}ms'`)}`,
      );
      const caps = await readCaps(tx);
      const rows = (await tx.execute(cycleFingerprintSql(caps))) as unknown as Array<{
        fp_gate: unknown;
        fp_ledger: unknown;
      }>;
      const r = rows[0];
      if (!r || typeof r.fp_gate !== "string" || typeof r.fp_ledger !== "string"
        || !HEX32.test(r.fp_gate) || !HEX32.test(r.fp_ledger)) {
        throw new Error("cycle-fingerprint: 지문 형식이 아니다");
      }
      return { gate: r.fp_gate, ledger: r.fp_ledger };
    });
  } catch (e) {
    const code = cycleFingerprintErrorCode(e);
    if (code && MISSING_OBJECT_CODES.has(code)) capsCache = null;
    throw e;
  }
}

/** 테스트 전용 — 가용성 메모를 비운다. */
export function resetCycleFingerprintCapsForTests(): void {
  capsCache = null;
}

/** 테스트 전용 — 가용성 메모가 차 있는가. */
export function cycleFingerprintCapsCachedForTests(): boolean {
  return capsCache !== null;
}
