import "server-only";
import { RUN_RECHECK_WINDOW_DAYS } from "@/lib/db/repositories/scope-mirror";
import {
  applyCycleControl,
  APPLY_STATEMENT_COUNT,
  APPLY_STATEMENT_TIMEOUT_MS,
  DEFAULT_COMPLETE_QUIET_HOURS,
  ensureSummaryWeekPartitions,
  readCycleControlPlan,
  type CycleControlPlan,
} from "@/lib/db/repositories/summary-cycles";
import { summaryLedgerAvailable } from "@/lib/db/repositories/summary-settings";

// 회차 관제 (설계 v4.1 §2 · PR① A1) — sync 크론 말미에 매 20분 도는 소형 작업.
//
// 하는 일은 넷뿐이다:
//   ① 미러에 새 `cycle_anchor_at` 이 나타나면 회차를 **연다**
//   ② 미귀속 run 을 회차에 **굳힌다**(§2-3: scope / derived / late)
//   ③ 열린 회차의 **카운터**를 다시 센다(expected·completed·분석 갭)
//   ④ 조건이 서면 **종결**한다((a) 다음 anchor · (b) 100% · (c) 재확인 창 밖)
//
// 안 하는 일 — 여기가 더 중요하다:
//   · 미러(`scope_runs`·`scope_answers`·`scope_mentions`·`scope_citations`)를 **쓰지 않는다**(P5).
//     `replaceRun` 은 이 모듈의 존재를 모르고, 알 필요도 없다.
//   · 사실표를 **생성하지 않는다**. 생성은 별도 러너(A2)의 일이고, 관제는 "생성해도
//     되는 회차" 를 원장에 표시할 뿐이다.
//   · `view_anchor_at` 을 **건드리지 않는다**. 노출 시각은 스왑 tx 만 쓴다(§7-1).
//
// 내성(§7-6): 원장 표가 아직 없는 배포(마이그레이션 선/후 어느 쪽이든)에서는
// `summaryLedgerAvailable()` 프로브가 false 를 주고 이 모듈은 **아무것도 하지 않는다**.
// 크론 응답은 200 을 유지한다 — 관제 실패가 미러 동기화를 죽이면 안 된다.

/** 파티션을 몇 주 앞까지 미리 만들 것인가. 4주 = 생성 러너가 늦어도 여유가 남는 창. */
export const PARTITION_LOOKAHEAD_DAYS = 28;

/**
 * 종결 (b) "100% 완료" 의 정온(quiet) 창 — **시간** 단위.
 *
 * 한 디스패치의 run 은 동시에 도착하지 않는다(실측: 글로벌 8/31 회차 216 run 이 39.9시간에
 * 걸쳐 도착, 최대 도착 간격 19.2시간). 가드 없이 100% 를 종결로 보면 첫 run 이 자기 셀을
 * 채운 순간 회차가 닫히고 나머지가 전부 `late` + `stale_since` 로 들어온다.
 *
 * 값은 **36시간** — 처음 넣은 6시간은 그 두 회차 안에서 뚫렸다(관측 최대 구멍 29.1 h).
 * 정의·근거·상하한은 리포지터리의
 * `DEFAULT_COMPLETE_QUIET_HOURS` 주석이 정본이고, 여기서는 **그 값을 그대로** 다시 내보낸다
 * (두 벌로 갈라지면 한쪽만 고치는 결함이 생긴다 — 이 리포가 이미 겪은 형태다).
 */
export const CYCLE_COMPLETE_QUIET_HOURS = DEFAULT_COMPLETE_QUIET_HOURS;

/**
 * 관제 한 주기의 **총 벽시계 예산**(ms). 호출부가 남은 요청 시간을 넘기지 않으면 이 값.
 *
 * 왜 필요한가 (T16 검증 6-① + D2): DB 쪽 상한만으로는 요청이 안 지켜진다.
 *   · `SET LOCAL statement_timeout` 은 tx 가 아니라 **문장마다** 걸린다 →
 *     적용 5문장 × 15 s = 최악 75 s.
 *   · 파티션 경로의 문장 천장은 120 s(ANALYZE 63표·562 MB 대비).
 *   합치면 195 s 다. sync 가 이미 250 s 를 쓴 뒤라면 `maxDuration` 300 s 를 넘겨
 *   **관제가 아니라 라우트 전체가 죽는다.**
 *
 * 그래서 상한을 두 겹으로 둔다: DB 쪽 천장(위 두 값)은 그대로 두고, **호출부가 남은
 * 예산을 넘겨** 실제 `statement_timeout` 을 그 안으로 눌러 준다. 파티션은 남은 예산의
 * 절반, 적용은 나머지를 문장 수로 나눈 값이다.
 *
 * 예산이 바닥나면 그 단계를 **건너뛴다** — 관제는 20분마다 돌고 파티션 생성은 주 1회
 * 필요할 뿐이라, 바쁜 틱 하나를 거르는 비용이 라우트를 죽이는 비용보다 훨씬 싸다.
 */
export const CYCLE_CONTROL_BUDGET_MS = 45_000;

/** 예산이 이보다 적게 남으면 적용 자체를 건너뛴다(문장당 최소 2 s × 5문장 + 여유). */
const MIN_APPLY_BUDGET_MS = 12_000;

export interface CycleControlOptions {
  /** 판정 기준 시각(테스트 고정용). 생략 시 호출 시점. */
  now?: Date;
  /** true = **SELECT 만**. 쓰기 0 을 계약으로 한다(T16 드라이런이 실 DB 에서 돈다). */
  dryRun?: boolean;
  /** `surface='global'` 로 볼 scope 루트. 생략 시 `SCOPE_ROOT_PROJECT_ID`. */
  rootProjectId?: string | null;
  /** 한 틱 귀속 상한. 첫 패스의 적체를 나눠 삼킨다. */
  maxAttributions?: number;
  /** 파티션 선생성을 건너뛴다(테스트·드라이런). */
  skipPartitions?: boolean;
  /** 종결 (b) 정온 창(시간). 생략 시 `CYCLE_COMPLETE_QUIET_HOURS`. */
  completeQuietHours?: number;
  /**
   * 이 주기에 쓸 수 있는 총 벽시계 예산(ms). 생략 시 `CYCLE_CONTROL_BUDGET_MS`.
   * 크론은 `maxDuration` 에서 이미 쓴 시간을 뺀 값을 넘긴다.
   */
  budgetMs?: number;
}

export interface CycleControlResult {
  dryRun: boolean;
  /** 연 회차 수(드라이런이면 **열릴** 회차 수). */
  opened: number;
  /** 종결한 회차 수(드라이런이면 **종결될** 회차 수 — `blockedBy` 는 제외). */
  closed: number;
  /** 귀속한 run 수(드라이런이면 **귀속될** run 수). */
  attributed: number;
  /** 종결 회차에 뒤늦게 붙은 run 수. */
  late: number;
  /** 어느 회차에도 속하지 않는 run 수(첫 anchor 이전) — 사실표 밖. */
  unattributed: number;
  /** 이번 호출이 만든 주 파티션 수. `null` = 0064 미적용(함수 없음) 또는 실패. */
  partitionsCreated: number | null;
  /**
   * 파티션 선생성이 실패한 이유(타임아웃·락). `null` 이면 실패 없음.
   * **관제 본체는 이것과 무관하게 돈다** — 파티션은 생성 러너의 전제조건이지
   * 열기·귀속·종결의 전제조건이 아니다(T16 검증 D2).
   */
  partitionsError: string | null;
  /** 관제를 통째로 건너뛴 사유. `null` 이면 돌았다. */
  skipped: string | null;
  /** 치명적이지 않은 실패 — 크론 응답은 200 을 유지한다. */
  errors: string[];
  /** 판정 표. **드라이런에서만** 채운다(적용 경로는 같은 판정을 두 번 돌리지 않는다). */
  table: CycleControlPlan | null;
  ms: number;
}

function emptyResult(
  dryRun: boolean,
  skipped: string | null,
  ms: number,
): CycleControlResult {
  return {
    dryRun,
    opened: 0,
    closed: 0,
    attributed: 0,
    late: 0,
    unattributed: 0,
    partitionsCreated: null,
    partitionsError: null,
    skipped,
    errors: [],
    table: null,
    ms,
  };
}

/**
 * 회차 관제 1주기.
 *
 * `dryRun: true` 는 **SELECT 만** 낸다 — 파티션 생성도 하지 않는다. 판정 표
 * (`table`)를 그대로 돌려주므로 "무엇이 열리고 무엇이 닫히는가" 를 쓰기 전에 볼 수 있다.
 *
 * `dryRun: false` 는 판정 표를 따로 만들지 않는다. 같은 판정 SQL 을 두 번 돌리면
 * 틱 예산이 두 배가 되고, 그 사이 미러가 바뀌면 표와 실제가 어긋난다 —
 * 적용 경로의 정본은 쓰기 문장 자신이다.
 */
export async function runCycleControl(
  opts: CycleControlOptions = {},
): Promise<CycleControlResult> {
  const t0 = Date.now();
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const rootProjectId =
    opts.rootProjectId ?? process.env.SCOPE_ROOT_PROJECT_ID ?? null;

  let available = false;
  try {
    available = await summaryLedgerAvailable();
  } catch {
    available = false;
  }
  if (!available)
    return emptyResult(dryRun, "ledger-unavailable", Date.now() - t0);

  const budgetMs = Math.max(0, opts.budgetMs ?? CYCLE_CONTROL_BUDGET_MS);
  const remaining = () => budgetMs - (Date.now() - t0);

  const errors: string[] = [];
  const sqlOpts = {
    now,
    rootProjectId,
    maxAttributions: opts.maxAttributions,
    recheckWindowDays: RUN_RECHECK_WINDOW_DAYS,
    completeQuietHours: opts.completeQuietHours ?? CYCLE_COMPLETE_QUIET_HOURS,
  };

  // ── 파티션 선생성 ─────────────────────────────────────────────────────────
  // 왜 관제가 하는가: 파티션이 없으면 **적재가 실패한다**(RANGE 파티션은 대상 자식이
  // 없으면 INSERT 가 에러다). 생성 러너는 회차가 닫힌 뒤에야 돌므로, 그때 만들면
  // 이미 늦다. 20분마다 도는 이 작업이 4주 앞까지 밀어 둔다.
  //
  // 관제 **본체보다 먼저** 돈다 — 파티션이 없으면 나중에 생성이 죽기 때문이다.
  // 그러나 실패해도 본체는 계속한다: 열기·귀속·종결은 파티션과 무관하다.
  // 자체 트랜잭션 + `SET LOCAL lock_timeout/statement_timeout` 은 리포지터리가 건다
  // (T16 검증 D2 — 종전에는 이 경로에 아무 상한이 없어 250 s 를 쓴 요청 뒤에
  //  무상한 DDL + 562 MB ANALYZE 가 붙었다).
  let partitionsCreated: number | null = null;
  let partitionsError: string | null = null;
  if (!dryRun && !opts.skipPartitions) {
    // 남은 예산의 절반까지만 쓴다 — 나머지 절반은 관제 본체 몫이다.
    const partitionBudget = Math.floor(remaining() / 2);
    if (partitionBudget < 2_000) {
      partitionsError = `budget: ${remaining()}ms 남음 — 파티션 선생성 건너뜀`;
      console.warn(`[cycle-control] ${partitionsError}`);
    } else {
      try {
        const r = await ensureSummaryWeekPartitions(
          now,
          new Date(
            now.getTime() + PARTITION_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
          ),
          { statementTimeoutMs: partitionBudget },
        );
        partitionsCreated = r.created;
        partitionsError = r.error ?? null;
        if (r.error) {
          // 상한에 걸렸거나 락을 못 잡았다. 다음 틱이 다시 시도한다(멱등).
          console.error(`[cycle-control] 파티션 선생성 실패: ${r.error}`);
          errors.push(`partitions: ${r.error}`);
        } else if (r.created === null) {
          // 0064 미적용 — 결함이 아니라 순서다(마이그레이션이 배포보다 늦을 수 있다).
          console.warn(
            "[cycle-control] summary_ensure_week_partitions 없음 — 파티션 선생성 건너뜀(0064 미적용)",
          );
        }
      } catch (err) {
        // 리포지터리가 이미 삼키지만, 프로브 단계의 예외까지 여기서 막는다.
        partitionsError = err instanceof Error ? err.message : String(err);
        errors.push(`partitions: ${partitionsError}`);
      }
    }
  }

  if (dryRun) {
    const plan = await readCycleControlPlan(sqlOpts);
    return {
      dryRun: true,
      opened: plan.open.length,
      closed: plan.close.filter((r) => !r.blockedBy).length,
      attributed:
        plan.attribution.scope +
        plan.attribution.derived +
        plan.attribution.late,
      late: plan.attribution.late,
      unattributed: plan.attribution.unattributed,
      partitionsCreated,
      partitionsError,
      skipped: null,
      errors,
      table: plan,
      ms: Date.now() - t0,
    };
  }

  // 남은 예산이 바닥이면 적용을 건너뛴다 — 다음 틱(20분 뒤)이 이어받는다.
  // 관제는 멱등이라 거른 틱이 손실이 아니다.
  if (remaining() < MIN_APPLY_BUDGET_MS) {
    const msg = `budget: ${remaining()}ms 남음 — 적용 건너뜀(다음 틱이 이어받는다)`;
    console.warn(`[cycle-control] ${msg}`);
    return {
      ...emptyResult(false, "budget", Date.now() - t0),
      partitionsCreated,
      partitionsError,
      errors,
    };
  }

  try {
    const w = await applyCycleControl({
      ...sqlOpts,
      // 문장당 상한 = 남은 예산 / 문장 수. DB 천장(15 s)을 넘지 않는다.
      statementTimeoutMs: Math.min(
        APPLY_STATEMENT_TIMEOUT_MS,
        Math.floor(remaining() / APPLY_STATEMENT_COUNT),
      ),
    });
    return {
      dryRun: false,
      opened: w.opened,
      closed: w.closed,
      attributed: w.attributed,
      late: w.late,
      unattributed: 0, // 적용 경로는 미귀속을 세지 않는다(추가 스캔 1회 값이 없다)
      partitionsCreated,
      partitionsError,
      skipped: null,
      errors,
      table: null,
      ms: Date.now() - t0,
    };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    console.error("[cycle-control] 적용 실패:", err);
    return {
      ...emptyResult(false, null, Date.now() - t0),
      partitionsCreated,
      partitionsError,
      errors,
    };
  }
}
