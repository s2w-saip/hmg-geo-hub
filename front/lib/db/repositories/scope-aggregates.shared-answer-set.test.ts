import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveColumnAvailabilityForTests } from "@/lib/db/column-availability";
import { setAnchorAxisForTests } from "@/lib/period/anchor-axis-state";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// 요청단위 공유 답변셋(2026-09-03)의 계약을 고정한다.
//
// 배경(프로덕션 EXPLAIN ANALYZE, admin 무필터·표준 루트): 스냅샷 답변셋
// `SELECT … FROM scope_answers WHERE ${answerWhere(...)}` 는 1,025ms / 30,080행.
// 대시보드 콜드 로드 1회에 이 계산이 5번(집계·SubKPI·GEO·주제구성·출처구성),
// 언급 화면은 2번 돈다. job_id 목록으로 받으면 101ms 다.
//
// 고정할 것 세 가지:
//   ① 공유 스코프 **밖**에서는 종전 `answerWhere` SQL 그대로 (동작 불변).
//   ② 스코프 **안**에서는 같은 (filters, projectCtx) 가 DB 를 1회만 때린다.
//   ③ 산출 술어가 job_id 항등 — `job_id = ANY(string_to_array($1, ',')::uuid[])`.
//      (scope_answers.job_id 는 PK 라 이 술어의 행 집합은 원래 W 와 항등이다.
//       프로덕션 대조: 30,080/30,080·584/584·39,876/39,876, md5 digest 동일.)

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q);

let rows: Array<{ job_id: string }> = [];
let failNext = false;
const execute = vi.fn(async () => {
  if (failNext) {
    failNext = false;
    throw new Error("boom");
  }
  return rows as unknown as never;
});
// 게이트 프로브에도 예산이 걸린다(2026-09-10) — `budgetedMirrorDb` 가 문장마다 자기
// 트랜잭션을 열고 `SET LOCAL statement_timeout` 을 먼저 보낸다. 그 형태를 흉내내되
// **세는 것은 본 문장뿐**이라 SET 은 통과시킨다(이 파일의 계약은 "DB 를 몇 번 때리나").
function isSetLocal(q: unknown): boolean {
  const chunks = (q as { queryChunks?: Array<{ value?: unknown }> })?.queryChunks ?? [];
  return chunks.some((c) => String(c?.value ?? "").startsWith("SET LOCAL"));
}
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute,
    transaction: async (cb: (tx: { execute: (q: unknown) => Promise<unknown> }) => Promise<unknown>) =>
      cb({ execute: (q: unknown) => (isSetLocal(q) ? Promise.resolve([]) : execute()) }),
  }),
}));

beforeEach(() => {
  // 컬럼 존재 판정을 **미리 확정**해 둔다(= 프로브가 끝난 웜 프로세스). 이걸 안 하면
  // 진입점의 `await ensureColumnAvailability()` 가 프로브 쿼리를 날려 이 파일의
  // "DB 를 안 때린다" 계약과 호출 횟수 단언이 프로브를 함께 세게 된다.
  resolveColumnAvailabilityForTests();
  // 같은 이유로 앵커 축 판정도 확정해 둔다 — 미확정이면 진입점의
  // `await ensureAnchorAxis()` 가 0077 테이블 프로브를 한 번 더 쏜다.
  setAnchorAxisForTests(false);
  execute.mockClear();
  rows = [{ job_id: "11111111-1111-1111-1111-111111111111" }];
  failNext = false;
});

describe("snapshotAnswerWhere — 요청단위 공유 답변셋", () => {
  it("공유 스코프 밖에서는 answerWhere 와 동일한 SQL 이고 데이터 조회를 안 때린다", async () => {
    const m = await import("./scope-aggregates");
    const shared = compile(await m.snapshotAnswerWhere({ region: ["KR"] }, undefined));
    const plain = compile(m.answerWhere({ region: ["KR"] }, undefined));
    expect(shared.sql).not.toContain("string_to_array(");
    expect(shared.sql).toContain("_fc_gate"); // full-cycle 게이트 그대로
    expect(shared.sql.replace(/\s+/g, " ")).toBe(plain.sql.replace(/\s+/g, " "));
    expect(shared.params).toEqual(plain.params);
    // 진행상태 테이블 가시성 probe는 reader gate의 필수 1회 조회이며,
    // snapshot 데이터 조회/공유셋 생성은 발생하지 않는다.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(m.snapshotAnswerSetScopeSize()).toBeNull();
  });

  it("스코프 안에서 같은 (filters, ctx) 는 DB 1회 — 결과는 job_id 항등 술어", async () => {
    const m = await import("./scope-aggregates");
    rows = [
      { job_id: "11111111-1111-1111-1111-111111111111" },
      { job_id: "22222222-2222-2222-2222-222222222222" },
    ];
    const out = await m.withSnapshotAnswerSetScope(
      m.createSnapshotAnswerSetStore(),
      async () => {
        // 같은 값의 **다른 객체**를 넘겨도 접혀야 한다(stableKey 는 값 기반).
        const [a, b] = await Promise.all([
          m.snapshotAnswerWhere({ region: ["KR"] }, undefined),
          m.snapshotAnswerWhere({ region: ["KR"] }, undefined),
        ]);
        return [compile(a), compile(b)] as const;
      },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(out[0].sql).toBe(out[1].sql);
    expect(out[0].sql).toContain("string_to_array(");
    expect(out[0].sql).toContain("::uuid[]");
    expect(out[0].params).toEqual([
      "11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222",
    ]);
  });

  it("필터가 다르면 접히지 않는다", async () => {
    const m = await import("./scope-aggregates");
    await m.withSnapshotAnswerSetScope(m.createSnapshotAnswerSetStore(), async () => {
      await m.snapshotAnswerWhere({ region: ["KR"] }, undefined);
      await m.snapshotAnswerWhere({ region: ["DE"] }, undefined);
      await m.snapshotAnswerWhere({ region: ["KR"] }, "proj-1");
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("빈 답변셋은 false — string_to_array('') 의 22P02 를 피한다", async () => {
    const m = await import("./scope-aggregates");
    rows = [];
    const w = await m.withSnapshotAnswerSetScope(
      m.createSnapshotAnswerSetStore(),
      async () => compile(await m.snapshotAnswerWhere({}, "proj-1")),
    );
    expect(w.sql.trim()).toBe("false");
    expect(w.params).toEqual([]);
  });

  it("실패한 조회는 스토어에 남지 않는다 — 같은 요청의 다른 섹션이 재시도할 수 있다", async () => {
    const m = await import("./scope-aggregates");
    await m.withSnapshotAnswerSetScope(m.createSnapshotAnswerSetStore(), async () => {
      failNext = true;
      await expect(m.snapshotAnswerWhere({}, "proj-1")).rejects.toThrow("boom");
      const retry = compile(await m.snapshotAnswerWhere({}, "proj-1"));
      expect(retry.sql).toContain("string_to_array(");
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("스코프는 중첩 async 경계를 넘어 전파된다 (unstable_cache 콜백 안까지)", async () => {
    const m = await import("./scope-aggregates");
    const size = await m.withSnapshotAnswerSetScope(
      m.createSnapshotAnswerSetStore(),
      async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        await m.snapshotAnswerWhere({}, "proj-1");
        return m.snapshotAnswerSetScopeSize();
      },
    );
    expect(size).toBe(1);
  });
});
