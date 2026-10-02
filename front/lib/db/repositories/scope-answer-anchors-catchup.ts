import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { isMockMode } from "@/lib/scope";
import { resolveAnchorRootProjectId } from "@/lib/scope/anchor-root";
import {
  ANCHOR_CATCHUP_LIMITS,
  ANCHOR_CATCHUP_MS_PER_ANSWER,
  ANCHOR_CATCHUP_WINDOW_DAYS,
  catchupWorklistSql,
  planAnchorCatchup,
  recheckOutcome,
  type WorklistCycle,
} from "@/lib/scope/anchor-worklist";
import {
  answerCycleAnchorsWritable,
  refreshAnchorsForRunsSql,
  runAnchorRefreshIsolated,
} from "./scope-answer-anchors";

// ════════════════════════════════════════════════════════════════════════════
// 앵커 공백 **따라잡기**: 표시 행 없는 완료 답변을 20분 크론이 메운다 (2026-09-29)
// ════════════════════════════════════════════════════════════════════════════
//
// 앵커 테이블(`scope_answer_cycle_anchors`)을 쓰는 자동 경로 셋은 전부 **변화 이벤트**
// 때만 돈다: 미러 싱크(그 run 을 (재)싱크할 때) · 회차 관제(새로 귀속된 run) · 회차 발행.
// 완료 run 은 증분 싱크가 다시 보지 않으므로(`shouldSkipMirroredRun`), 그 순간 전파가
// 없었거나 실패(savepoint 격리 롤백)하면 공백은 **저절로 안 메워진다.** 앵커 축 화면은
// 표시 행이 없는 답변을 조용히 뺀다: 2026-09-29 운영 전환 직후 6,608건(138회차)이
// 그렇게 사라졌다(docs: hmg-geo-anchor-gap-after-prod-switch-rca-2026-09-29).
//
// 이 모듈은 새 쓰기 경로가 아니다. 쓰기는 **기존 DB 함수**(`refresh_answer_cycle_anchors`)를
// 기존 격리 헬퍼(`runAnchorRefreshIsolated`)로 부를 뿐이고, 대상 회차는 백필과 **같은**
// 회차 키로 고른다(`lib/scope/anchor-worklist.ts`).

export interface AnchorCatchupReport {
  /** 이 단계를 통째로 건너뛴 사유. null = 실행했다. */
  skipped: null | "mock" | "table-unavailable" | "root-malformed" | "no-budget" | "deadline";
  /** 감지 쿼리가 찾은 공백 회차 수(창 안). */
  found: number;
  /** 감지된 공백 답변 수 합(창 안 회차의 pending 합). */
  pendingAnswers: number;
  /** 이번 틱에 전파 후 재확인 pending 이 0 이 된 회차 수. */
  cyclesFilled: number;
  /**
   * 채운 행 수 = 회차마다 **감지 시 pending − 처리 후 pending**(재확인 읽기) 의 합.
   * `unfilled` 회차의 부분 감소분도 포함한다. 함수 rowcount 가 아니다: 격리 헬퍼가 반환값을
   * 버리고, rowcount 는 회차 확장 시 이미 있던 행의 갱신까지 센다.
   */
  rowsFilled: number;
  /** 상한(`maxAnswers`)보다 커서 건너뛴 회차: 사람이 백필한다(6시간 감시가 잡는다). */
  oversized: Array<{ cycleKey: string; total: number; pending: number }>;
  /** 회차·답변·벽시계 상한에 막혀 다음 틱으로 넘긴 회차 수. */
  deferred: number;
  /** 전파가 격리 롤백된 회차(락 대기·타임아웃 등). 다음 틱이 다시 시도한다. */
  failed: string[];
  /**
   * 전파는 에러 없이 끝났는데 재확인에서 pending 이 남은 회차. 채울 수 없는 회차가 틱마다
   * 다시 뽑혀 상한을 잡아먹는 형태를 드러낸다(6시간 감시도 같은 공백을 잡는다).
   */
  unfilled: Array<{ cycleKey: string; pending: number }>;
  /** 전파는 성공했지만 재확인 읽기가 실패(타임아웃 등)해 채움 여부를 모르는 회차. */
  unverified: string[];
  /** 감지·쓰기 오류(단계 전체). 라우트를 죽이지 않는다. */
  error?: string;
  ms: number;
}

/**
 * 감지 쿼리 문장 상한(ms). 실측(2026-09-29 운영 미러, 읽기 전용 EXPLAIN ANALYZE, 14일 창):
 *   · 공백 0: 497 ms
 *   · 창 안 회차 전부가 공백인 최악 모사(428회차·답변 19만 집계, 병렬 워커 4): 892~894 ms
 *   · 병렬 워커가 안 붙으면 느려진다. 같은 날 알림 쿼리가 워커 4 → 0 에서 414 → 1,823 ms(약 4.4배)
 *     였으므로 최악 모사의 워커 미할당 추정은 약 4 s 로 5 s 에 가깝다 → **10 s**.
 * 15 s 벽시계 안의 몫: 감지는 `min(10 s, 예산 − 1 s)` 까지 쓸 수 있고, 평시(0.5~0.9 s)에는
 * 14 s 이상이 쓰기에 남는다. 감지가 최악을 다 쓰면 쓰기 몫은 약 5 s 로 줄고 남은 회차는
 * `deferred` 로 다음 틱에 넘어간다(멈추지 않는다: 감지 실패로 진도 0 이 되는 쪽이 더 나쁘다).
 */
const DETECT_STATEMENT_TIMEOUT_MS = 10_000;
/** 회차 하나를 처리한 뒤 pending 재확인 읽기(run_id = ANY 한정)에 남겨 두는 몫(ms). */
const RECHECK_RESERVE_MS = 500;
/** 회차 한 건 쓰기의 문장 상한 하한(ms): 남은 예산이 이보다 작으면 시작하지 않는다. */
const MIN_CYCLE_STATEMENT_MS = 1_000;

export const emptyAnchorCatchupReport = (skipped: AnchorCatchupReport["skipped"], ms = 0): AnchorCatchupReport => ({
  skipped, found: 0, pendingAnswers: 0, cyclesFilled: 0, rowsFilled: 0,
  oversized: [], deferred: 0, failed: [], unfilled: [], unverified: [], ms,
});

async function readCatchupWorklist(timeoutMs: number): Promise<WorklistCycle[]> {
  return getDb().transaction(async (tx) => {
    // 읽기 전용은 세션이 아니라 트랜잭션에서 건다(Supavisor 가 startup 파라미터를 버린다).
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(`'${Math.floor(timeoutMs)}ms'`)}`);
    const rows = (await tx.execute(
      sql.raw(catchupWorklistSql(ANCHOR_CATCHUP_WINDOW_DAYS)),
    )) as unknown as Array<{ cycle_key: string; run_ids: string[]; total: number; pending: number }>;
    return rows.map((r) => ({
      cycle_key: r.cycle_key,
      run_ids: Array.isArray(r.run_ids) ? r.run_ids : [],
      total: Number(r.total),
      pending: Number(r.pending),
    }));
  });
}

/**
 * 따라잡기 한 패스. **던지지 않는다**: 실패는 보고서의 `error`·`failed` 로 나간다.
 *
 * 벽시계: `budgetMs` 안에서만 새 회차를 시작한다. 회차 하나의 추정 비용
 * (`total × ANCHOR_CATCHUP_MS_PER_ANSWER`)이 남은 예산을 넘으면 거기서 멈추고
 * 나머지는 `deferred` 로 넘긴다. 시작한 회차는 `statement_timeout = 남은 예산` 으로
 * 눌러 잡는다. 호출부(라우트)는 이 위에 하드 월클럭 race 를 한 번 더 씌운다.
 */
export async function runAnchorCatchup(opts: { budgetMs: number }): Promise<AnchorCatchupReport> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (isMockMode()) return emptyAnchorCatchupReport("mock");
  if (opts.budgetMs < MIN_CYCLE_STATEMENT_MS * 2) return emptyAnchorCatchupReport("no-budget");
  try {
    if (!(await answerCycleAnchorsWritable())) return emptyAnchorCatchupReport("table-unavailable", elapsed());
    // 루트 id 는 정본 한 곳(`anchor-root.ts`). 형식이 틀리면 **쓰지 않는다**: 표면을
    // 잘못 기록하느니 공백으로 두고 env 수리 후 회수한다(미러 싱크와 같은 정책, N-14).
    const root = resolveAnchorRootProjectId();
    if (root.kind === "malformed") {
      console.error("[anchor-catchup] SCOPE_ROOT_PROJECT_ID 형식 오류: 따라잡기를 건너뛴다.");
      return emptyAnchorCatchupReport("root-malformed", elapsed());
    }

    // 감지 몫: min(10 s, 예산 − 1 s). 예산 하한(2 s)은 위에서 걸렀다.
    const cycles = await readCatchupWorklist(
      Math.min(DETECT_STATEMENT_TIMEOUT_MS, opts.budgetMs - elapsed() - MIN_CYCLE_STATEMENT_MS),
    );
    const plan = planAnchorCatchup(cycles, ANCHOR_CATCHUP_LIMITS);
    const report: AnchorCatchupReport = {
      skipped: null,
      found: cycles.length,
      pendingAnswers: cycles.reduce((s, c) => s + c.pending, 0),
      cyclesFilled: 0,
      rowsFilled: 0,
      oversized: plan.oversized.map((c) => ({ cycleKey: c.cycle_key, total: c.total, pending: c.pending })),
      deferred: plan.deferred,
      failed: [],
      unfilled: [],
      unverified: [],
      ms: 0,
    };
    if (plan.oversized.length) {
      console.error(
        `[anchor-catchup] 상한(${ANCHOR_CATCHUP_LIMITS.maxAnswers})보다 큰 공백 회차 ${plan.oversized.length}개를 건너뛴다: ` +
          `npm run db:backfill:answer-anchors 로 회수할 것. ` +
          plan.oversized.map((c) => `${c.cycle_key}(total=${c.total},pending=${c.pending})`).join(" "),
      );
    }

    for (let i = 0; i < plan.picked.length; i++) {
      const c = plan.picked[i];
      const remaining = opts.budgetMs - elapsed();
      // 쓰기 추정 비용 + 재확인 몫까지 남아 있어야 시작한다(재확인도 벽시계 예산 안에서 돈다).
      if (
        remaining < MIN_CYCLE_STATEMENT_MS + RECHECK_RESERVE_MS ||
        c.total * ANCHOR_CATCHUP_MS_PER_ANSWER + RECHECK_RESERVE_MS > remaining
      ) {
        report.deferred += plan.picked.length - i;
        break;
      }
      const stmt = refreshAnchorsForRunsSql(c.run_ids, root.projectId);
      if (!stmt) continue;
      let ok = false;
      try {
        ok = await getDb().transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
          await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(`'${Math.floor(remaining - RECHECK_RESERVE_MS)}ms'`)}`);
          return runAnchorRefreshIsolated(tx, "anchor-catchup", c.cycle_key, stmt);
        });
      } catch (e) {
        // SET LOCAL·커밋 단계 실패. 이 회차만 실패로 두고 다음으로 간다.
        console.warn(`[anchor-catchup] cycle=${c.cycle_key} tx 실패: ${e instanceof Error ? e.message : String(e)}`);
        ok = false;
      }
      if (!ok) {
        report.failed.push(c.cycle_key);
        continue;
      }
      // ── 채움 확인: 함수가 에러 없이 끝나도 일부 답변을 못 쓸 수 있다 ──────────
      let after: number;
      try {
        after = await countPendingForRuns(
          c.run_ids,
          Math.max(RECHECK_MIN_MS, Math.min(RECHECK_RESERVE_MS, opts.budgetMs - elapsed())),
        );
      } catch (e) {
        console.warn(`[anchor-catchup] cycle=${c.cycle_key} 재확인 실패: ${e instanceof Error ? e.message : String(e)}`);
        report.unverified.push(c.cycle_key);
        continue;
      }
      const outcome = recheckOutcome(c.pending, after);
      report.rowsFilled += outcome.rowsFilled;
      if (outcome.filled) {
        report.cyclesFilled += 1;
      } else {
        report.unfilled.push({ cycleKey: c.cycle_key, pending: after });
        console.error(
          `[anchor-catchup] cycle=${c.cycle_key} 전파 후에도 pending ${after}건(감지 시 ${c.pending}): ` +
            "채울 수 없는 회차일 수 있다. 다음 틱에 다시 뽑힌다.",
        );
      }
    }
    report.ms = elapsed();
    return report;
  } catch (err) {
    console.error("[anchor-catchup] 단계 실패:", err);
    return {
      ...emptyAnchorCatchupReport(null, elapsed()),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 재확인 문장 상한 하한(ms). */
const RECHECK_MIN_MS = 250;

/**
 * 회차 run 들의 남은 pending(완료 답변인데 앵커 행 없음) 수. `run_id = ANY` 한정이라
 * `scope_answers_run_cycle_idx` + 앵커 PK 로 회차 크기에 비례한다(상한 5,000 답변).
 * 실측(2026-09-29 운영 미러, 읽기 전용): run 32개·답변 319건 회차 한 번 13.7 ms(회차 고르는
 * 부속 쿼리 포함). 재확인 몫 500 ms 는 상한 크기 회차에도 넉넉하다.
 */
async function countPendingForRuns(runIds: string[], timeoutMs: number): Promise<number> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(`'${Math.floor(timeoutMs)}ms'`)}`);
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS n
        FROM scope_answers a
        JOIN scope_runs r ON r.run_id = a.run_id
        LEFT JOIN scope_answer_cycle_anchors c ON c.job_id = a.job_id
       WHERE a.run_id = ANY(${sql.param(runIds)}::uuid[])
         AND a.status = 'completed'
         AND r.project_id IS NOT NULL
         AND c.job_id IS NULL
    `)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  });
}

// ── 6시간 감시용 읽기: 싱크된 지 오래인데 여전히 표시 없는 완료 답변 ─────────────

/** 표면·프로젝트 묶음 한 행. */
export interface AnchorGapGroup {
  /** 원장 표면(global·website·project) 또는 원장 귀속 전 `unattributed`. 루트 프로젝트는 global. */
  surface: string;
  projectId: string;
  projectName: string | null;
  answers: number;
  cycles: number;
  /** 가장 오래된 회차 앵커(UTC ISO 문자열): 앵커가 없는 단독 run 만 있으면 null */
  oldestAnchorAt: string | null;
  /** 가장 오래된 싱크 시각(UTC ISO 문자열) */
  oldestSyncedAt: string;
}

/**
 * 완료 답변인데 앵커 행이 없고, 그 run 이 싱크된 지 `graceHours` 가 지난 것을
 * 표면·프로젝트로 묶는다. **창 없음**(전 테이블): 따라잡기 창(14일) 밖 공백도 여기서
 * 잡는다. 실측(2026-09-29 운영 미러, 읽기 전용 EXPLAIN ANALYZE, 공백 0 상태 전 테이블):
 * 병렬 워커 4개 414 ms · 워커 미할당 1,823 ms. 6시간 크론이라 문장 상한 30 s 로 충분하다.
 *
 * 테이블이 없으면(0077 미적용) `null`: 판정 불가(통과가 아니다).
 */
export async function readAnchorGapGroups(
  graceHours: number,
): Promise<AnchorGapGroup[] | null> {
  if (!(await answerCycleAnchorsWritable())) return null;
  const root = resolveAnchorRootProjectId().projectId;
  const hours = Math.max(0, Math.floor(graceHours));
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    // 상관 서브쿼리를 쓰지 않는다: 원장 조인은 run 단위 LEFT JOIN(summary_cycle_runs.run_id UNIQUE).
    const rows = (await tx.execute(sql`
      WITH gap AS (
        SELECT r.run_id, r.project_id, r.cycle_anchor_at, r.synced_at, count(*)::int AS n
          FROM scope_runs r
          JOIN scope_answers a ON a.run_id = r.run_id
          LEFT JOIN scope_answer_cycle_anchors c ON c.job_id = a.job_id
         WHERE a.status = 'completed'
           AND r.project_id IS NOT NULL
           AND c.job_id IS NULL
           AND r.synced_at < now() - make_interval(hours => ${hours}::int)
         GROUP BY r.run_id, r.project_id, r.cycle_anchor_at, r.synced_at
      ), tagged AS (
        SELECT g.*,
               CASE WHEN g.project_id = ${root}::uuid THEN 'global'
                    ELSE COALESCE(y.surface, 'unattributed') END AS surface,
               g.project_id::text || '|' ||
                 COALESCE(g.cycle_anchor_at::text, 'run:' || g.run_id::text) AS cycle_key
          FROM gap g
          LEFT JOIN summary_cycle_runs scr ON scr.run_id = g.run_id
          LEFT JOIN summary_cycles     y   ON y.cycle_id = scr.cycle_id
      )
      SELECT t.surface,
             t.project_id::text                                          AS project_id,
             max(p.name)                                                 AS project_name,
             sum(t.n)::int                                               AS answers,
             count(DISTINCT t.cycle_key)::int                            AS cycles,
             to_char(min(t.cycle_anchor_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS oldest_anchor_at,
             to_char(min(t.synced_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')       AS oldest_synced_at
        FROM tagged t
        LEFT JOIN projects p ON p.scope_project_id = t.project_id
       GROUP BY t.surface, t.project_id
       ORDER BY answers DESC, project_id
       LIMIT 500
    `)) as unknown as Array<{
      surface: string; project_id: string; project_name: string | null; answers: number;
      cycles: number; oldest_anchor_at: string | null; oldest_synced_at: string;
    }>;
    return rows.map((r) => ({
      surface: r.surface,
      projectId: r.project_id,
      projectName: r.project_name,
      answers: Number(r.answers),
      cycles: Number(r.cycles),
      oldestAnchorAt: r.oldest_anchor_at,
      oldestSyncedAt: r.oldest_synced_at,
    }));
  });
}
