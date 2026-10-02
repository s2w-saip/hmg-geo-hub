import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { resolveColumnAvailabilityForTests } from "@/lib/db/column-availability";
import { setAnchorAxisForTests } from "@/lib/period/anchor-axis-state";

// withAnswerSet(#104) 의 트랜잭션 계약을 고정한다.
//
// 2026-08-27 프로덕션 실측: 이 트랜잭션이 `idle in transaction` 으로 215~346초
// 방치돼 scope_answers·scope_prompts 에 AccessShareLock 을 쥐었고, 0046 의
// ALTER TABLE 이 55P03(lock timeout)으로 거부됐다. 서버 기본값
// idle_in_transaction_session_timeout = 0 이라 수거자가 없다.
// → 트랜잭션이 스스로 죽을 상한을 **첫 문장으로** 걸어야 한다.

const dialect = new PgDialect();
const compile = (q: SQL) => dialect.sqlToQuery(q).sql;

const executed: string[] = [];
const tx = { execute: vi.fn(async (q: SQL) => { executed.push(compile(q)); return []; }) };
const transaction = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
vi.mock("@/lib/db", () => ({ getDb: () => ({ transaction, execute: tx.execute }) }));

beforeEach(() => {
  // 컬럼 존재 판정 확정(웜 프로세스) — 미확정이면 진입점의 ensure 프로브가
  // `executed[0]` 자리를 차지해 "첫 문장 = SET LOCAL" 단언이 프로브를 보게 된다.
  resolveColumnAvailabilityForTests();
  // 앵커 축 판정도 확정해 둔다 — 미확정이면 진입점의 `await ensureAnchorAxis()` 가
  // 0077 테이블 프로브를 한 문장 더 쏴서 이 파일의 문장 순서·호출 횟수 단언이 흔들린다.
  setAnchorAxisForTests(false);
  executed.length = 0;
  tx.execute.mockClear();
  transaction.mockClear();
});

describe("withAnswerSet — 버려진 트랜잭션 자가 종료 상한", () => {
  it("첫 문장으로 idle_in_transaction_session_timeout 을 SET LOCAL 한다", async () => {
    const mod = await import("./scope-aggregates");
    await mod.withAnswerSet(sql`a.job_id`, sql`true`, async () => "ok");
    expect(executed[0]).toMatch(/SET LOCAL idle_in_transaction_session_timeout = '\d+s'/);
  });

  it("상한이 TEMP 테이블 생성보다 먼저 걸린다 (생성 중 방치도 덮는다)", async () => {
    const mod = await import("./scope-aggregates");
    await mod.withAnswerSet(sql`a.job_id`, sql`true`, async () => "ok");
    const guard = executed.findIndex((q) => q.includes("idle_in_transaction_session_timeout"));
    const create = executed.findIndex((q) => q.includes("CREATE TEMP TABLE _answer_set"));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(guard);
  });

  it("SET LOCAL 이다 — 커밋 시 해제돼 다른 요청으로 새지 않는다", async () => {
    const mod = await import("./scope-aggregates");
    await mod.withAnswerSet(sql`a.job_id`, sql`true`, async () => "ok");
    const guard = executed.find((q) => q.includes("idle_in_transaction_session_timeout"))!;
    expect(guard).toContain("SET LOCAL");
    expect(guard).not.toMatch(/^\s*SET\s+idle/);
  });

  it("서버 statement_timeout 은 건드리지 않는다 (무관한 동작 변경 금지)", async () => {
    const mod = await import("./scope-aggregates");
    await mod.withAnswerSet(sql`a.job_id`, sql`true`, async () => "ok");
    expect(executed.some((q) => q.includes("statement_timeout"))).toBe(false);
  });

  it("콜백 결과를 그대로 반환하고 ANALYZE 를 수행한다 (#104 계약 보존)", async () => {
    const mod = await import("./scope-aggregates");
    const out = await mod.withAnswerSet(sql`a.job_id`, sql`true`, async () => ({ n: 7 }));
    expect(out).toEqual({ n: 7 });
    expect(executed.some((q) => q.includes("ANALYZE _answer_set"))).toBe(true);
  });
});
