import { describe, expect, it, vi, beforeEach } from "vitest";

// 회귀 — 2026-09-01 재검증 C1·C5.
//
// 검증자가 반증한 주장: "두 단계 합이 8s 를 넘지 않는다". `statement_timeout` 은
// **문장당**이고 한 단계가 4문장(SET·CREATE TEMP TABLE·ANALYZE·분석 쿼리)을
// 발행하므로, 문장 수를 세지 않은 상한 주장은 성립하지 않는다.
//
// 여기서는 가짜 드라이버로 트랜잭션을 가로채 ① 실제로 세팅된 statement_timeout
// ② 트랜잭션당 문장 수 ③ 마감(deadline)이 문장 발행을 실제로 막는지 를 관찰한다.
// (검증자 재현 픽스처 zzhold/zz-f7.test.ts 를 기반으로 픽스에 맞춰 확장.)

interface TxRecord {
  timeout: number | null;
  statements: number;
  aborted: boolean;
}

const txLog: TxRecord[] = [];
let phaseDelays: number[] = [];
let phaseIdx = 0;
/** 문장 하나가 소비하는 가짜 시간(ms) — 마감이 문장 사이에서 걸리는지 보기 위함. */
let perStatementDelay = 0;
/** 트랜잭션별 문장 지연(ms). 지정되면 그 트랜잭션에서 perStatementDelay 를 대체한다. */
let perTxStatementDelay: number[] = [];

function sqlTextOf(q: unknown): string {
  const anyQ = q as { queryChunks?: unknown[] } | string;
  if (typeof anyQ === "string") return anyQ;
  const chunks = (anyQ?.queryChunks ?? []) as Array<{ value?: unknown[] }>;
  return chunks
    .map((c) => (typeof c === "string" ? c : Array.isArray(c?.value) ? c.value.join("") : ""))
    .join("");
}

const makeTx = (rec: TxRecord, txIndex: number) => ({
  execute: async (q: unknown) => {
    const s = sqlTextOf(q);
    const m = s.match(/statement_timeout = (\d+)/);
    if (m) rec.timeout = Number(m[1]);
    else if (!/idle_in_transaction/.test(s)) rec.statements++;
    const d = perTxStatementDelay[txIndex] ?? perStatementDelay;
    if (d) await new Promise((r) => setTimeout(r, d));
    return [];
  },
});

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const rec: TxRecord = { timeout: null, statements: 0, aborted: false };
      txLog.push(rec);
      const txIndex = phaseIdx;
      const delay = phaseDelays[phaseIdx++] ?? 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        return await fn(makeTx(rec, txIndex));
      } catch (e) {
        rec.aborted = true;
        throw e;
      }
    },
    execute: async () => [],
  }),
}));

const load = () => import("./scope-aggregates");

beforeEach(() => {
  txLog.length = 0;
  phaseDelays = [];
  phaseIdx = 0;
  perStatementDelay = 0;
  perTxStatementDelay = [];
});

describe("withAnswerSet — 문장당 상한과 벽시계 마감은 다른 것이다 (C1)", () => {
  it("issues several statements under one statement_timeout — so N×timeout, not timeout", async () => {
    const { withAnswerSet } = await load();
    const { sql } = await import("drizzle-orm");
    await withAnswerSet(sql`a.job_id`, sql`true`, async (db) => {
      await db.execute(sql`SELECT 1`);
      await db.execute(sql`SELECT 2`);
      return null;
    }, { statementTimeoutMs: 8000 });

    // CREATE TEMP TABLE + ANALYZE + fn 의 2문장 = 4. 각각이 8s 를 쓸 수 있다.
    expect(txLog[0].statements).toBe(4);
    expect(txLog[0].timeout).toBe(8000);
  });

  // 마감은 문장을 보내기 **전에** 확인한다 — 진행 중 문장은 취소하지 못하므로
  // 정직한 상한은 (마감까지 남은 시간 + statementTimeoutMs) 다.
  it("aborts before issuing a statement once the wall-clock deadline has passed", async () => {
    const { withAnswerSet, AnswerSetDeadlineError } = await load();
    const { sql } = await import("drizzle-orm");
    perStatementDelay = 30;
    await expect(
      withAnswerSet(sql`a.job_id`, sql`true`, async (db) => {
        for (let i = 0; i < 20; i++) await db.execute(sql`SELECT ${i}`);
        return null;
      }, { statementTimeoutMs: 8000, deadlineAt: Date.now() + 100 }),
    ).rejects.toBeInstanceOf(AnswerSetDeadlineError);
    // 마감 전 몇 문장은 나갔고, 20개를 전부 보내지는 않았다.
    expect(txLog[0].statements).toBeGreaterThan(0);
    expect(txLog[0].statements).toBeLessThan(21);
  });

  it("leaves behaviour unchanged when no budget is given (existing callers)", async () => {
    const { withAnswerSet } = await load();
    const { sql } = await import("drizzle-orm");
    await withAnswerSet(sql`a.job_id`, sql`true`, async () => null);
    expect(txLog[0].timeout).toBeNull();
  });
});

describe("aggregateEngineKpiTrendFromMirror — 두 단계가 마감을 공유한다 (C1/C5)", () => {
  it("gives both phases the SAME deadline, not a fresh budget each", async () => {
    const { aggregateEngineKpiTrendFromMirror } = await load();
    phaseDelays = [120, 0];
    await aggregateEngineKpiTrendFromMirror({}, "proj-x", {
      statementTimeoutMs: 8000,
      budgetMs: 5000,
    });
    expect(txLog).toHaveLength(2);
    // 문장 상한은 두 단계 모두 같다(문장당 값이므로 나눌 대상이 아니다).
    expect(txLog[0].timeout).toBe(8000);
    expect(txLog[1].timeout).toBe(8000);
  });

  // M10 회귀(뮤테이션 생존): 예산 공유를 지우면 1단계가 예산을 다 써도 2단계가
  // 통째로 돌아버린다. 마감을 공유하면 2단계는 첫 문장에서 즉시 중단된다.
  it("does not start the trend work when the shared deadline is already spent", async () => {
    const { aggregateEngineKpiTrendFromMirror } = await load();
    // 1단계는 예산 안에 끝나고, 그 뒤 시간이 흘러 2단계 시작 시점엔 마감이 지났다.
    phaseDelays = [0, 300];
    const r = await aggregateEngineKpiTrendFromMirror({}, "proj-x", {
      statementTimeoutMs: 8000,
      budgetMs: 200,
    });
    // 2단계는 열리되 첫 문장에서 마감에 걸려 즉시 중단된다.
    expect(txLog.length).toBe(2);
    expect(txLog[1].statements).toBe(0);
    expect(txLog[1].aborted).toBe(true);
    // 그리고 **던지지 않는다** — 스냅샷 결과는 살아남는다(C2).
    expect(r.trendDegraded).toBe(true);
    expect(r.buckets).toEqual([]);
  });

  // 1단계에서 이미 예산이 끝나면 스냅샷도 못 냈다는 뜻이라 던진다 —
  // 상위 kpiDegrade 가 시간 초과로 판정해 그 지면만 null 로 내린다.
  it("throws when even the snapshot phase cannot finish inside the budget", async () => {
    const { aggregateEngineKpiTrendFromMirror, AnswerSetDeadlineError } = await load();
    phaseDelays = [150, 0];
    await expect(
      aggregateEngineKpiTrendFromMirror({}, "proj-x", {
        statementTimeoutMs: 8000,
        budgetMs: 100,
      }),
    ).rejects.toBeInstanceOf(AnswerSetDeadlineError);
    expect(txLog).toHaveLength(1);
  });

  it("does not mark the trend degraded on a healthy run", async () => {
    const { aggregateEngineKpiTrendFromMirror } = await load();
    const r = await aggregateEngineKpiTrendFromMirror({}, "proj-x", {
      statementTimeoutMs: 8000,
      budgetMs: 12_000,
    });
    expect(r.trendDegraded).toBe(false);
  });

  it("applies no timeout at all when the caller passes no budget", async () => {
    const { aggregateEngineKpiTrendFromMirror } = await load();
    await aggregateEngineKpiTrendFromMirror({}, "proj-x", {});
    expect(txLog[0].timeout).toBeNull();
    expect(txLog[1].timeout).toBeNull();
  });

  // C5 보강 — 검증자가 "빌더 픽스처는 마감 '공유'와 '리셋'을 구분하지 못한다"고
  // 지적했다(지연을 트랜잭션 open 시점에만 줘서, 예산 인자가 그 이전에 평가되는
  // 탓에 두 구현이 같은 결과를 냈다). 문장 지연을 2단계에만 줘서 둘을 가른다:
  // 공유면 잔액만 갖고 중간에 마감되고, 리셋이면 예산을 새로 받아 더 진행한다.
  it("shares one deadline across both phases (a per-phase reset would run further)", async () => {
    const { aggregateEngineKpiTrendFromMirror } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 예산 400ms: 1단계가 250ms 를 쓰고 성공 → 잔액 150ms.
    // 2단계는 문장당 60ms 라 잔액으로는 2~3문장이면 마감에 걸린다.
    phaseDelays = [250, 0];
    perTxStatementDelay = [0, 60];
    const r = await aggregateEngineKpiTrendFromMirror({}, "proj-x", {
      statementTimeoutMs: 8000,
      budgetMs: 400,
    });
    expect(r.trendDegraded).toBe(true);
    // 리셋 구현이면 2단계가 예산 400ms 를 새로 받아 문장을 더 흘려보낸다.
    expect(txLog[1].statements).toBeLessThanOrEqual(4);
    // 1단계 결과(latest)는 살아 있어야 한다 — 결합 제거의 핵심.
    expect(r.latest).not.toBeNull();
    warn.mockRestore();
  });
});
