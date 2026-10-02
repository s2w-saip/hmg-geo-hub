/**
 * 백필의 **작업 단위와 배치 구성**. DB 접속이 없는 순수 모듈이라 테스트가 직접 부른다.
 *
 * ── 왜 run 이 아니라 회차가 단위인가 (B-1) ─────────────────────────────────
 * `refresh_answer_cycle_anchors(run_ids, root)` 는 받은 run 을 **회차 전체로 넓혀서**
 * 쓸 수 있다(0077 의 `seed`/`expanded` CTE: 같은 `project_id` + 같은 `cycle_anchor_at`
 * 인 run 전부). 0078 부터 그 확장은 **회차 해소 결과가 달라졌을 때만** 일어나지만,
 * 백필은 첫 계산이라 사실상 매번 넓어진다. 그래서 배치에 회차의 일부 run 만 들어 있으면
 * 함수가 돌려주는 rowcount 가
 * **배치 밖 run 의 답변까지** 세고, 배치 상한(`n > cap`)이 첫 배치에서 거짓으로 터진다.
 * 첫 백필은 테이블이 비어 있어 전 행이 INSERT 라 변경 감지 WHERE 가 깎아 주지도 않는다.
 * 배치 트랜잭션은 이미 커밋된 뒤에 throw 가 나므로 재실행해도 같은 경보가 반복된다.
 *
 * 고치는 방법은 상한을 느슨하게 하는 것이 아니라 **배치가 회차를 자르지 않게** 하는
 * 것이다. 그러면 확장 집합이 배치를 벗어나지 않으므로
 *   · rowcount 상한이 다시 "한정 조건이 깨졌다"는 진짜 신호가 되고
 *   · 같은 회차를 여러 배치가 중복 재계산하는 비용도 사라진다.
 *
 * 회차 키는 0077 의 확장 키와 **같은 정의**다:
 *   `project_id || '|' || COALESCE(cycle_anchor_at, 'run:' || run_id)`
 * (`cycle_anchor_at` 이 NULL 인 run 은 회차를 이루지 못해 단독으로 남는다 — 0077 도
 *  `seed` 에서 `cycle_anchor_at IS NOT NULL` 만 씨앗으로 쓴다.)
 */

/** 한 회차 = 배치 구성의 최소 단위. 절대 쪼개지 않는다. */
export type CycleRow = {
  /** `project_id|cycle_anchor_at` 또는 `project_id|run:run_id` (0077 확장 키와 동일) */
  cycle_key: string;
  /** 이 회차에 속한 run 전부 (completed 답변이 하나라도 있는 run) */
  run_ids: string[];
  /** 이 회차의 completed 답변 수 = 배치 상한의 단위이자 rowcount 상한의 근거 */
  total: number;
  /** 아직 앵커 테이블에 없는 답변 수 (0 이면 재개 시 건너뛴다) */
  pending: number;
};

export type BatchPlan = {
  /** 이 배치에 든 회차 */
  cycles: CycleRow[];
  /** 함수에 넘길 run id (회차 전원) */
  ids: string[];
  /** 이 배치의 completed 답변 수 = rowcount 상한 `cap` */
  answers: number;
};

export type BatchLimits = {
  /** 배치 누적 답변 수 상한 */
  maxAnswers: number;
  /** 배치 run 수 상한 (보조 — uuid 배열 파라미터가 무한정 커지지 않게) */
  maxRuns: number;
};

/**
 * 회차 목록을 배치로 묶는다. **한 회차는 반드시 한 배치 안에 통째로 들어간다** —
 * 회차 하나가 상한보다 커도 쪼개지 않고 자기 배치를 혼자 쓴다(상한은 "여러 회차를
 * 얼마나 모을지" 의 기준이지 회차를 자르는 칼이 아니다).
 */
export function planBatches(cycles: CycleRow[], limits: BatchLimits): BatchPlan[] {
  if (limits.maxAnswers <= 0 || limits.maxRuns <= 0) {
    throw new Error("배치 상한은 1 이상이어야 한다");
  }
  const out: BatchPlan[] = [];
  let cur: BatchPlan = { cycles: [], ids: [], answers: 0 };
  for (const c of cycles) {
    const overAnswers = cur.answers + c.total > limits.maxAnswers;
    const overRuns = cur.ids.length + c.run_ids.length > limits.maxRuns;
    if (cur.cycles.length > 0 && (overAnswers || overRuns)) {
      out.push(cur);
      cur = { cycles: [], ids: [], answers: 0 };
    }
    cur.cycles.push(c);
    cur.ids.push(...c.run_ids);
    cur.answers += c.total;
  }
  if (cur.cycles.length > 0) out.push(cur);
  return out;
}

/**
 * 처리 대상 **회차** 목록. 재개 경로는 이 재조회다(스냅샷 파일이 없다).
 *
 * SQL 정본은 `lib/scope/anchor-worklist.ts` 다(2026-09-29 이동). 20분 크론의 앵커 따라잡기가
 * 같은 회차 키 정의를 좁은 창으로 다시 쓰므로 한 곳에 둔다: 여기서는 다시 내보내기만 한다.
 */
export { WORKLIST_SQL } from "@/lib/scope/anchor-worklist";
