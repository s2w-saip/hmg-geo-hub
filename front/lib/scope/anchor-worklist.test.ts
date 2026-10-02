// 앵커 따라잡기 상한 판정·작업 목록 SQL 조립 (2026-09-29).
//
// 상한은 "크론이 sync 를 굶기지 않는다" 의 유일한 코드 근거다. 회차를 자르지 않는 것(B-1)과
// 대형 회차를 알림으로 넘기는 것이 깨지면 조용히 비용이 튄다.
import { describe, expect, it } from "vitest";
import {
  ANCHOR_CATCHUP_LIMITS,
  WORKLIST_SQL,
  catchupWorklistSql,
  planAnchorCatchup,
  recheckOutcome,
  ANCHOR_CATCHUP_WINDOW_DAYS,
  type WorklistCycle,
} from "./anchor-worklist";

const cyc = (key: string, total: number, pending = total): WorklistCycle => ({
  cycle_key: key,
  run_ids: [`${key}-r1`],
  total,
  pending,
});

describe("planAnchorCatchup", () => {
  const LIM = { maxCycles: 3, maxAnswers: 1_000 };

  it("상한 안이면 목록 순서대로 전부 고른다", () => {
    const p = planAnchorCatchup([cyc("a", 100), cyc("b", 200)], LIM);
    expect(p.picked.map((c) => c.cycle_key)).toEqual(["a", "b"]);
    expect(p.oversized).toEqual([]);
    expect(p.deferred).toBe(0);
  });

  it("회차 수 상한에서 멈추고 나머지를 deferred 로 센다", () => {
    const p = planAnchorCatchup([cyc("a", 1), cyc("b", 1), cyc("c", 1), cyc("d", 1), cyc("e", 1)], LIM);
    expect(p.picked.map((c) => c.cycle_key)).toEqual(["a", "b", "c"]);
    expect(p.deferred).toBe(2);
  });

  it("답변 수 상한에서 멈춘다: 뒤의 작은 회차를 건너뛰어 담지 않는다", () => {
    const p = planAnchorCatchup([cyc("a", 600), cyc("b", 500), cyc("c", 10)], LIM);
    expect(p.picked.map((c) => c.cycle_key)).toEqual(["a"]);
    expect(p.deferred).toBe(2);
  });

  it("단독으로 상한보다 큰 회차는 쪼개지 않고 oversized 로 뺀다", () => {
    const p = planAnchorCatchup([cyc("big", 1_001, 3), cyc("a", 100)], LIM);
    expect(p.oversized.map((c) => c.cycle_key)).toEqual(["big"]);
    expect(p.picked.map((c) => c.cycle_key)).toEqual(["a"]);
    expect(p.deferred).toBe(0);
  });

  it("상한과 정확히 같은 회차는 담는다(경계)", () => {
    const p = planAnchorCatchup([cyc("eq", 1_000)], LIM);
    expect(p.picked).toHaveLength(1);
    expect(p.oversized).toHaveLength(0);
  });

  it("비용은 pending 이 아니라 회차 전체 total 로 센다", () => {
    const p = planAnchorCatchup([cyc("a", 900, 1), cyc("b", 200, 1)], LIM);
    expect(p.picked.map((c) => c.cycle_key)).toEqual(["a"]);
    expect(p.deferred).toBe(1);
  });

  it("pending 0 은 무시한다", () => {
    const p = planAnchorCatchup([cyc("done", 100, 0)], LIM);
    expect(p).toEqual({ picked: [], oversized: [], deferred: 0 });
  });

  it("상한이 0 이하면 던진다", () => {
    expect(() => planAnchorCatchup([], { maxCycles: 0, maxAnswers: 1 })).toThrow();
    expect(() => planAnchorCatchup([], { maxCycles: 1, maxAnswers: 0 })).toThrow();
  });

  it("운영 상한은 회차 20 · 답변 5,000 이다", () => {
    expect(ANCHOR_CATCHUP_LIMITS).toEqual({ maxCycles: 20, maxAnswers: 5_000 });
  });
});

describe("작업 목록 SQL", () => {
  it("전 테이블 WORKLIST_SQL 에는 창·HAVING 이 없다(백필 계약 유지)", () => {
    expect(WORKLIST_SQL).not.toContain("gap_cycles");
    expect(WORKLIST_SQL).not.toContain("HAVING");
    expect(WORKLIST_SQL.trimStart().startsWith("WITH run_agg AS")).toBe(true);
  });

  it("따라잡기 SQL 은 같은 회차 키 식을 쓰고, 창·공백 회차만 거른다", () => {
    const q = catchupWorklistSql(ANCHOR_CATCHUP_WINDOW_DAYS);
    expect(ANCHOR_CATCHUP_WINDOW_DAYS).toBe(14);
    expect(q).toContain("interval '14 days'");
    expect(q).toContain("HAVING sum(pending) > 0");
    expect(q).toContain("a.run_id IN (SELECT run_id FROM scoped_runs)");
    const keyExpr = "COALESCE(cycle_anchor_at::text, 'run:' || run_id::text) AS cycle_key";
    expect(WORKLIST_SQL).toContain(keyExpr);
    expect(q).toContain(keyExpr);
  });

  it("창 인자는 1~60 정수만 받는다(SQL 조립 경로 방어)", () => {
    expect(() => catchupWorklistSql(0)).toThrow();
    expect(() => catchupWorklistSql(61)).toThrow();
    expect(() => catchupWorklistSql(1.5)).toThrow();
  });
});

describe("recheckOutcome (채움 확인)", () => {
  it("처리 후 pending 0 이면 채움, 줄어든 수는 감지 시 pending 전부", () => {
    expect(recheckOutcome(474, 0)).toEqual({ rowsFilled: 474, filled: true });
  });

  it("일부 남으면 채움 아님, 줄어든 수만 센다", () => {
    expect(recheckOutcome(474, 10)).toEqual({ rowsFilled: 464, filled: false });
  });

  it("하나도 못 쓰면 0 행·채움 아님(틱마다 다시 뽑히는 회차)", () => {
    expect(recheckOutcome(30, 30)).toEqual({ rowsFilled: 0, filled: false });
  });

  it("그 사이 새 싱크로 늘었으면 줄어든 수는 음수가 아니라 0", () => {
    expect(recheckOutcome(5, 8)).toEqual({ rowsFilled: 0, filled: false });
  });
});
