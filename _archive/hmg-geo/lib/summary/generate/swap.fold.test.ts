/**
 * 스왑 tx 안의 접기 (PR② T2 수용 기준 ⑤).
 *
 * 고정하는 것은 **순서와 원자성** 둘이다:
 *   · 지문 drift 가 잡히면 접기 문장이 **한 줄도** 나가지 않는다.
 *   · 접기 도중 실패하면 `activate`/`publish` 가 안 돌고 tx 가 통째로 깨진다
 *     → 집계층 행 잔존 0(롤백은 DB 가 한다. 여기서는 "그 tx 안에서 던진다"를 고정한다).
 */
import { describe, it, expect } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { swapGeneration } from "./swap";
import { FOLD_WORK_MEM, type FoldBatch } from "./fold";

const dialect = new PgDialect();
const CYCLE = "11111111-1111-4111-8111-111111111111";
const GEN = "22222222-2222-4222-8222-222222222222";

type Fake = {
  log: string[];
  db: {
    execute: (q: SQL) => Promise<unknown>;
    transaction: <T>(fn: (tx: { execute: (q: SQL) => Promise<unknown> }) => Promise<T>) => Promise<T>;
  };
  time: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  timings: Record<string, number>;
};

function fake(opts: { drift: number; throwOn?: string }): Fake {
  const log: string[] = [];
  const timings: Record<string, number> = {};
  const run = async (q: SQL) => {
    const t = dialect.sqlToQuery(q).sql;
    log.push(t);
    if (opts.throwOn && t.includes(opts.throwOn)) throw new Error("접기 실패(모의)");
    if (t.includes("AS drift")) return [{ drift: opts.drift }];
    return [];
  };
  return {
    log,
    timings,
    db: {
      execute: run,
      transaction: async (fn) => fn({ execute: run }),
    },
    time: async (key, fn) => {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        timings[key] = (timings[key] ?? 0) + (Date.now() - t0);
      }
    },
  };
}

const batches: FoldBatch[] = [
  {
    table: "summary_trend_answers",
    key: "fold_answers",
    statements: [
      sql`DELETE FROM summary_trend_answers WHERE cycle_id = ${CYCLE}::uuid`,
      sql`INSERT INTO summary_trend_answers (cycle_id) SELECT ${CYCLE}::uuid`,
    ],
  },
  {
    table: "summary_trend_own",
    key: "fold_own",
    statements: [sql`INSERT INTO summary_trend_own (cycle_id) SELECT ${CYCLE}::uuid`],
  },
];

describe("swapGeneration + 접기", () => {
  it("접기를 안 주면 종전 문장 순서 그대로다(회귀 방지)", async () => {
    const f = fake({ drift: 0 });
    expect(await swapGeneration(f, CYCLE, GEN, "global")).toBe(true);
    expect(f.log.some((s) => s.includes("statement_timeout"))).toBe(false);
    expect(f.log.some((s) => s.includes("work_mem"))).toBe(false);
    expect(f.log.some((s) => s.includes("summary_trend_"))).toBe(false);
    expect(f.log.filter((s) => s.includes("UPDATE summary_generations")).length).toBe(2);
  });

  it("drift 가 잡히면 접기 문장이 하나도 안 나간다", async () => {
    const f = fake({ drift: 1 });
    expect(await swapGeneration(f, CYCLE, GEN, "global", { batches })).toBe(false);
    expect(f.log.some((s) => s.includes("summary_trend_"))).toBe(false);
    expect(f.log.some((s) => s.includes("SET active_generation_id"))).toBe(false);
  });

  it("순서: GUC → drift → retire → 접기 → activate → publish", async () => {
    const f = fake({ drift: 0 });
    expect(
      await swapGeneration(f, CYCLE, GEN, "global", {
        batches,
        statementTimeout: "10min",
        workMem: FOLD_WORK_MEM,
      }),
    ).toBe(true);
    const at = (needle: string) => f.log.findIndex((s) => s.includes(needle));
    expect(at("SET LOCAL statement_timeout = '10min'")).toBe(0);
    // work_mem 은 GUC 두 번째 줄 — drift 검사(FOR SHARE)보다 **앞**이어야 접기가 그 값으로 돈다.
    // 값 고정: 기본 16MB 에서 fold_own 이 정렬 스필로 35.7 s, 256MB 에서 13.8 s (fold.ts 주석).
    expect(FOLD_WORK_MEM).toBe("256MB");
    expect(at(`SET LOCAL work_mem = '${FOLD_WORK_MEM}'`)).toBe(1);
    expect(at(`SET LOCAL work_mem = '${FOLD_WORK_MEM}'`)).toBeLessThan(at("AS drift"));
    expect(at("AS drift")).toBeLessThan(at("SET status = 'retired'"));
    expect(at("SET status = 'retired'")).toBeLessThan(at("DELETE FROM summary_trend_answers"));
    expect(at("INSERT INTO summary_trend_own")).toBeLessThan(at("SET status = 'active'"));
    expect(at("SET status = 'active'")).toBeLessThan(at("SET active_generation_id"));
  });

  it("접기가 실패하면 던지고 activate/publish 는 안 돈다(같은 tx → 롤백)", async () => {
    const f = fake({ drift: 0, throwOn: "INSERT INTO summary_trend_own" });
    await expect(swapGeneration(f, CYCLE, GEN, "global", { batches })).rejects.toThrow(/접기 실패/);
    expect(f.log.some((s) => s.includes("SET status = 'active'"))).toBe(false);
    expect(f.log.some((s) => s.includes("SET active_generation_id"))).toBe(false);
  });

  it("timings 에 접기 4키가 아니라 **준 배치의 키**가 쌓인다", async () => {
    const f = fake({ drift: 0 });
    await swapGeneration(f, CYCLE, GEN, "global", { batches });
    expect(Object.keys(f.timings).sort()).toEqual(["fold_answers", "fold_own"]);
    for (const v of Object.values(f.timings)) expect(v).toBeGreaterThanOrEqual(0);
  });
});
