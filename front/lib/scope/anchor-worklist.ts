/**
 * 앵커 테이블(0077) **회차 작업 목록**의 정본 + 크론 따라잡기(catch-up) 상한 판정.
 * DB 접속이 없는 순수 모듈이다(백필 스크립트·크론·테스트가 함께 부른다).
 *
 * ── 왜 여기로 옮겼나 (2026-09-29) ───────────────────────────────────────────
 * 작업 목록 SQL 은 원래 `scripts/db/answer-cycle-anchors-batching.ts` 에 있었다(백필 전용).
 * 앵커 축 운영 전환 직후 전환 전 싱크분 6,608건(138회차)이 표시 없이 남은 사고
 * (docs: hmg-geo-anchor-gap-after-prod-switch-rca-2026-09-29)로 **20분 크론이 같은
 * 목록을 좁은 창으로 다시 읽게** 됐다. 회차 키 정의가 두 벌이 되면 크론과 백필이 서로
 * 다른 단위로 회차를 자르므로(B-1 사고와 같은 종류), SQL 을 lib 로 올리고 백필 모듈은
 * 이것을 다시 내보낸다. 새 SQL 을 한 벌 더 만들지 않는다.
 *
 * 회차 키는 0077 의 확장 키와 **같은 정의**다:
 *   `project_id || '|' || COALESCE(cycle_anchor_at, 'run:' || run_id)`
 */

/**
 * 회차 작업 목록 SQL 을 만든다.
 *
 * - 인자 없이 부르면 **전 테이블** 목록(백필 `WORKLIST_SQL`)이고, 결과 문자열은 옮기기 전
 *   리터럴과 같다(`preCtes`·`runFilter` 가 빈 문자열).
 * - `preCtes` 는 `run_agg` 앞에 끼우는 CTE 들(끝에 `, ` 포함), `runFilter` 는 `run_agg`
 *   의 WHERE 에 붙는 추가 술어(앞에 공백·AND 포함)다. 둘 다 이 모듈 안에서만 만든다:
 *   외부 문자열을 받지 않는다(주입 경로 없음).
 */
function cycleWorklistSql(preCtes = "", runFilter = "", having = ""): string {
  return `
    WITH ${preCtes}run_agg AS (
      SELECT a.run_id,
             r.project_id,
             r.cycle_anchor_at,
             count(*)::int                                 AS total,
             count(*) FILTER (WHERE c.job_id IS NULL)::int  AS pending
        FROM scope_answers a
        JOIN scope_runs    r ON r.run_id = a.run_id
        LEFT JOIN scope_answer_cycle_anchors c ON c.job_id = a.job_id
       WHERE a.status = 'completed'
         AND r.project_id IS NOT NULL${runFilter}
       GROUP BY a.run_id, r.project_id, r.cycle_anchor_at
    ), keyed AS (
      SELECT run_id, cycle_anchor_at, total, pending,
             project_id::text || '|' ||
               COALESCE(cycle_anchor_at::text, 'run:' || run_id::text) AS cycle_key
        FROM run_agg
    )
    SELECT cycle_key,
           array_agg(run_id::text ORDER BY run_id) AS run_ids,
           sum(total)::int                         AS total,
           sum(pending)::int                       AS pending
      FROM keyed
     GROUP BY cycle_key${having}
     ORDER BY min(cycle_anchor_at) NULLS LAST, cycle_key`;
}

/**
 * 처리 대상 **회차** 목록(전 테이블). 백필의 재개 경로는 이 재조회다(스냅샷 파일이 없다).
 *
 * 정렬: 회차 앵커 오름차순: 증분 배정이 프로젝트 안에서 이른 회차부터 보게 한다.
 * 앵커가 NULL 인 단독 회차는 맨 뒤로 보낸다. 같은 앵커 시각을 여러 프로젝트가 공유
 * 하므로(함대가 한 웨이브로 돈다) 2차 키로 회차 키를 쓴다: 같은 프로젝트의 회차가
 * 흩어지지 않는다.
 */
export const WORKLIST_SQL = cycleWorklistSql();

/**
 * 따라잡기 감지 창(일). `scope_runs.synced_at` 이 이 안인 run 에서만 공백을 찾는다.
 *
 * 공백은 **싱크가 만든다**(전파가 run 을 쓸 때만 돈다): 그러니 공백 run 의 `synced_at`
 * 은 공백이 생긴 시각이다. 14일 = 주간 회차 두 번분이고 20분 틱 1,008회의 기회다. 창 밖으로
 * 밀려난 공백은 6시간 감시(`cycle-chain-watch` 의 앵커 공백 감시, 창 없음)가 긴급으로 잡는다.
 *
 * 3일이 아니라 14일인 이유(2026-09-29 PR #327 검토): 이번 사고처럼 전환 시점에 이미 며칠 지난
 * run 의 공백(09-22~29, 약 1주)을 3일 창은 못 보고 알림으로만 넘긴다.
 *
 * 비용은 창과 거의 무관하다. 본체가 `scope_answer_cycle_anchors_pkey` 전체 index-only scan
 * (613,194행)이고 창은 hash 빌드 행 수에만 영향을 준다. 실측(2026-09-29 운영 미러, 읽기 전용
 * EXPLAIN ANALYZE, 공백 0): 3일 528 ms · 14일 497 ms(빌드 142,947행).
 */
export const ANCHOR_CATCHUP_WINDOW_DAYS = 14;

/**
 * 창 안에서 공백이 있는 회차만, **회차 전원**을 모아 목록을 만든다.
 *
 * 공백 판정은 창으로 좁히지만 회차의 run 은 창과 무관하게 전부 모은다: 전파 함수가
 * 받은 run 을 회차 전체로 넓혀 쓸 수 있으므로(0077 `expanded`), 상한 판정의 `total` 은
 * 회차 전체 답변 수여야 한다(창 안 run 만 세면 비용을 과소 추정한다).
 */
export function catchupWorklistSql(windowDays: number = ANCHOR_CATCHUP_WINDOW_DAYS): string {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 60) {
    throw new Error(`windowDays 는 1~60 정수여야 한다: ${windowDays}`);
  }
  const preCtes = `gap_cycles AS (
      SELECT DISTINCT r.project_id, r.cycle_anchor_at,
             CASE WHEN r.cycle_anchor_at IS NULL THEN r.run_id END AS solo_run_id
        FROM scope_runs r
        JOIN scope_answers a ON a.run_id = r.run_id
        LEFT JOIN scope_answer_cycle_anchors c ON c.job_id = a.job_id
       WHERE r.synced_at >= now() - interval '${windowDays} days'
         AND r.project_id IS NOT NULL
         AND a.status = 'completed'
         AND c.job_id IS NULL
    ), scoped_runs AS (
      SELECT r.run_id
        FROM scope_runs r
        JOIN gap_cycles g ON g.project_id = r.project_id
                         AND g.cycle_anchor_at = r.cycle_anchor_at
      UNION
      SELECT solo_run_id FROM gap_cycles WHERE solo_run_id IS NOT NULL
    ), `;
  return cycleWorklistSql(
    preCtes,
    `
         AND a.run_id IN (SELECT run_id FROM scoped_runs)`,
    `
    HAVING sum(pending) > 0`,
  );
}

// ── 크론 따라잡기 상한 ─────────────────────────────────────────────────────

/** 작업 목록 한 행(`WORKLIST_SQL`·`catchupWorklistSql` 공통). */
export type WorklistCycle = {
  cycle_key: string;
  run_ids: string[];
  /** 회차 completed 답변 수 = 비용 추정 단위 */
  total: number;
  /** 앵커 행이 없는 답변 수 */
  pending: number;
};

export type CatchupLimits = {
  /** 틱당 회차 수 상한 */
  maxCycles: number;
  /** 틱당 답변 수 상한(회차 `total` 누적). 이보다 큰 회차 하나는 건너뛴다. */
  maxAnswers: number;
};

/**
 * 틱당 상한: 근거(2026-09-29 운영 미러 실측):
 *
 * - 회차 크기 분포(최근 30일 회차 677개): p50 134 · p90 300 · p99 501, 최대 56,383
 *   (글로벌 루트 회차 run 1,304). 5,000 을 넘는 회차는 **5개뿐이고 전부 글로벌 루트**다.
 * - 쓰기 비용: 09-29 복구 백필이 6,608행을 5배치 18.9 s(배치 간 sleep 0.5 s × 4 포함)
 *   → 순수 ≈ 2.6 ms/답변. 5,000 답변 ≈ 13 s 로 벽시계 상한 15 s 안에 든다.
 * - 회차 20개 × 대표 크기 250 ≈ 5,000: 두 상한이 같은 규모를 가리키게 맞췄다.
 * - 이번 사고 규모(138회차·6,608행)는 회차 상한 기준 7틱 ≈ 2시간 20분에 자동 회수된다.
 *
 * 5,000 을 넘는 회차(글로벌 루트)는 쪼개지 않고 건너뛴다: 회차를 자르면 전파 함수의
 * 회차 확장이 배치 밖 답변까지 써서 비용 상한이 무의미해진다(B-1). 그런 회차는 응답의
 * `oversized` 와 로그에 남고, 6시간 감시가 긴급으로 올려 사람이 백필한다.
 */
export const ANCHOR_CATCHUP_LIMITS: CatchupLimits = { maxCycles: 20, maxAnswers: 5_000 };

/** 따라잡기 단계 벽시계 상한(ms). 라우트가 남은 시간으로 더 줄일 수 있다. */
export const ANCHOR_CATCHUP_BUDGET_MS = 15_000;

/** 답변 1건당 쓰기 비용 추정(ms): 벽시계 안에서 다음 회차를 시작할지 판정한다. 실측 2.6 ms 에 여유. */
export const ANCHOR_CATCHUP_MS_PER_ANSWER = 3;

export type CatchupPlan = {
  /** 이번 틱에 채울 회차(목록 순서 유지) */
  picked: WorklistCycle[];
  /** 단독으로 `maxAnswers` 를 넘어 건너뛴 회차: 알림 대상 */
  oversized: WorklistCycle[];
  /** 상한에 막혀 다음 틱으로 넘긴 회차 수 */
  deferred: number;
};

/**
 * 공백 회차 목록을 이번 틱 작업으로 고른다. 회차는 **절대 쪼개지 않는다.**
 *
 * - `pending === 0` 인 행은 무시한다(창 SQL 이 이미 거르지만 전 테이블 목록도 받을 수 있게).
 * - `total > maxAnswers` 인 회차는 `oversized` 로 뺀다(다음 틱에도 같은 결과: 사람 몫).
 * - 나머지는 목록 순서대로 담다가 회차 수·답변 수 상한에 닿으면 멈춘다. 뒤에 더 작은
 *   회차가 있어도 건너뛰어 담지 않는다: 순서(이른 회차 먼저)를 지키는 편이 매 틱 같은
 *   큰 회차가 영원히 밀리는 기아를 막는다.
 */
export function planAnchorCatchup(cycles: WorklistCycle[], limits: CatchupLimits): CatchupPlan {
  if (limits.maxCycles <= 0 || limits.maxAnswers <= 0) {
    throw new Error("따라잡기 상한은 1 이상이어야 한다");
  }
  const picked: WorklistCycle[] = [];
  const oversized: WorklistCycle[] = [];
  let answers = 0;
  let deferred = 0;
  let full = false;
  for (const c of cycles) {
    if (c.pending <= 0) continue;
    if (c.total > limits.maxAnswers) {
      oversized.push(c);
      continue;
    }
    if (full || picked.length >= limits.maxCycles || answers + c.total > limits.maxAnswers) {
      full = true;
      deferred += 1;
      continue;
    }
    picked.push(c);
    answers += c.total;
  }
  return { picked, oversized, deferred };
}

/**
 * 회차 하나를 전파한 뒤 재확인한 pending 으로 결과를 가른다(2026-09-29 PR #327 검토).
 *
 * 전파 함수가 에러 없이 끝나도 일부 답변을 못 쓸 수 있다. 그런 회차를 "채움" 으로 세면 틱마다
 * 다시 뽑혀 상한을 잡아먹는데도 응답은 성공으로 보인다. 그래서:
 *   · `rowsFilled` = 감지 시 pending − 처리 후 pending (음수는 0: 그 사이 새 싱크로 늘 수 있다)
 *   · `filled` = 처리 후 pending 이 0 인가
 */
export function recheckOutcome(
  pendingBefore: number,
  pendingAfter: number,
): { rowsFilled: number; filled: boolean } {
  return {
    rowsFilled: Math.max(0, pendingBefore - pendingAfter),
    filled: pendingAfter <= 0,
  };
}
