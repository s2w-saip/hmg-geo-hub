import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn<[unknown], Promise<unknown>>();
const transaction = vi.fn();
vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: (q: unknown) => execute(q), transaction: (fn: never) => transaction(fn) }),
}));

const { budgetedMirrorDb, AnswerSetDeadlineError } = await import("./scope-aggregates");
const { getDb } = await import("@/lib/db");

// 이 헬퍼가 지켜야 할 것 셋:
//   ① 예산이 없으면 **원본 db 를 그대로** 돌려준다(왕복 증가 0 · 종전 동작).
//   ② 문장마다 자기 트랜잭션 + `SET LOCAL statement_timeout` (풀러 누수 방지).
//   ③ 문장을 보내기 **전에** 마감을 확인한다(진행 중 문장은 취소 못 하므로).
beforeEach(() => {
  execute.mockReset();
  transaction.mockReset();
  transaction.mockImplementation(async (fn: (tx: { execute: typeof execute }) => unknown) =>
    fn({ execute }));
});

describe("budgetedMirrorDb", () => {
  it("예산이 없으면 원본 db 를 그대로 돌려준다", () => {
    const db = getDb();
    expect(budgetedMirrorDb(db, undefined)).toBe(db);
    expect(budgetedMirrorDb(db, {})).toBe(db);
  });

  it("문장마다 트랜잭션을 열고 SET LOCAL statement_timeout 을 먼저 보낸다", async () => {
    execute.mockResolvedValue([]);
    const d = budgetedMirrorDb(getDb(), { statementTimeoutMs: 15_000 });
    await d.execute("SELECT 1" as never);
    expect(transaction).toHaveBeenCalledTimes(1);
    const first = execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] };
    // drizzle `sql.raw` 는 문자열 청크를 그대로 담는다.
    expect(JSON.stringify(first)).toContain("SET LOCAL statement_timeout = 15000");
    // ⚠️ `SET LOCAL` 이어야 한다 — 맨 SET 은 transaction-mode 풀러에서 다음 요청으로 샌다.
    expect(JSON.stringify(first)).not.toMatch(/(?<!LOCAL )statement_timeout *= *15000/);
    expect(execute).toHaveBeenCalledTimes(2); // SET LOCAL + 원 문장
  });

  it("마감이 이미 지났으면 문장을 **보내지 않고** 던진다", async () => {
    const d = budgetedMirrorDb(getDb(), { statementTimeoutMs: 15_000, deadlineAt: Date.now() - 1 });
    expect(() => d.execute("SELECT 1" as never)).toThrow(AnswerSetDeadlineError);
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("마감 전이면 그대로 통과한다", async () => {
    execute.mockResolvedValue([{ n: 1 }]);
    const d = budgetedMirrorDb(getDb(), { deadlineAt: Date.now() + 60_000 });
    await expect(d.execute("SELECT 1" as never)).resolves.toEqual([{ n: 1 }]);
  });
});
