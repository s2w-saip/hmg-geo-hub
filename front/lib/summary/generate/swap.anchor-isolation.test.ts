/**
 * 회차 발행의 앵커 전파 **격리** (통합 검증 D2·D13).
 *
 * 이 전파는 옵트인 밖이라 화면 키가 꺼져 있어도 배포 즉시 돈다. 고정하는 것 셋:
 *   ① 전파가 실패해도 **발행은 커밋된다**(savepoint 만 되감는다)
 *   ② 실패는 구조화 경고 한 줄로 남는다(조용히 사라지지 않는다)
 *   ③ 쓸 수 없는 환경(0077 미적용)에서는 **루트 env 를 읽지도 않는다** — 형식 오류가
 *      요약 생성을 죽이던 경로(D13)를 닫는다
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const CYCLE = "11111111-1111-4111-8111-111111111111";
const GEN = "22222222-2222-4222-8222-222222222222";

const anchorsWritable = vi.fn();
const rootOrThrow = vi.fn();

vi.mock("@/lib/db/repositories/scope-answer-anchors", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/db/repositories/scope-answer-anchors")
  >("@/lib/db/repositories/scope-answer-anchors");
  return {
    ...actual,
    answerCycleAnchorsWritable: () => anchorsWritable(),
  };
});

vi.mock("@/lib/scope/anchor-root", () => ({
  anchorRootProjectIdOrThrow: () => rootOrThrow(),
}));

const { swapGeneration } = await import("./swap");

/** 발행까지는 정상이고 전파 문장만 `onRefresh` 가 정하는 스왑 하네스. */
function harness(onRefresh: () => Promise<unknown>) {
  const log: string[] = [];
  const exec = async (q: SQL) => {
    const t = dialect.sqlToQuery(q).sql;
    log.push(t);
    if (t.includes("AS drift")) return [{ drift: 0 }];
    if (t.includes("refresh_answer_cycle_anchors")) return onRefresh();
    return [];
  };
  let savepoints = 0;
  const tx = {
    execute: exec,
    transaction: async <T>(fn: (t: { execute: typeof exec }) => Promise<T>) => {
      savepoints += 1;
      return fn({ execute: exec });
    },
  };
  return {
    log,
    savepointCount: () => savepoints,
    rt: {
      db: {
        execute: exec,
        transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
      },
      time: async <T>(_k: string, fn: () => Promise<T>) => fn(),
    },
  };
}

const published = (log: string[]) => log.some((t) => t.includes("SET active_generation_id"));
const refreshed = (log: string[]) =>
  log.some((t) => t.includes("refresh_answer_cycle_anchors"));

beforeEach(() => {
  anchorsWritable.mockReset();
  rootOrThrow.mockReset();
  rootOrThrow.mockReturnValue("33333333-3333-4333-8333-333333333333");
});
afterEach(() => vi.restoreAllMocks());

describe("D2 — 전파 실패가 회차 발행을 죽이지 않는다", () => {
  it("전파가 statement_timeout 으로 죽어도 스왑은 true 로 커밋된다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    anchorsWritable.mockResolvedValue(true);
    const h = harness(() =>
      Promise.reject(
        Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        }),
      ),
    );

    await expect(swapGeneration(h.rt, CYCLE, GEN, "global")).resolves.toBe(true);

    expect(published(h.log), "발행 문장이 나갔다").toBe(true);
    expect(refreshed(h.log), "전파도 시도했다").toBe(true);
    expect(h.savepointCount(), "savepoint 하나").toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("op=cycle-publish");
    expect(String(warn.mock.calls[0]?.[0])).toContain(`scope=${CYCLE}`);
  });

  it("전파가 성공하면 경고가 없다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    anchorsWritable.mockResolvedValue(true);
    const h = harness(async () => []);

    await expect(swapGeneration(h.rt, CYCLE, GEN, "website")).resolves.toBe(true);
    expect(refreshed(h.log)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("전파는 savepoint **안**에서 나간다 (발행 문장과 같은 자리가 아니다)", async () => {
    anchorsWritable.mockResolvedValue(true);
    const h = harness(async () => []);
    await swapGeneration(h.rt, CYCLE, GEN, "global");
    // 발행이 먼저, 전파가 나중 — 순서 계약(원장이 쓴 노출일을 앵커가 읽는다).
    const iPublish = h.log.findIndex((t) => t.includes("SET active_generation_id"));
    const iRefresh = h.log.findIndex((t) => t.includes("refresh_answer_cycle_anchors"));
    expect(iPublish).toBeGreaterThan(-1);
    expect(iRefresh).toBeGreaterThan(iPublish);
    expect(h.savepointCount()).toBe(1);
  });
});

describe("D13 — 쓸 수 없으면 루트 env 를 읽지 않는다", () => {
  it("anchorsWritable 이 거짓이면 anchorRootProjectIdOrThrow 를 부르지 않는다", async () => {
    anchorsWritable.mockResolvedValue(false);
    const h = harness(async () => []);

    await expect(swapGeneration(h.rt, CYCLE, GEN, "global")).resolves.toBe(true);

    expect(rootOrThrow).not.toHaveBeenCalled();
    expect(refreshed(h.log), "전파 문장이 안 나간다").toBe(false);
    expect(published(h.log), "발행은 종전대로").toBe(true);
    expect(h.savepointCount(), "savepoint 도 안 연다").toBe(0);
  });

  it("env 가 형식 오류여도 0077 미적용 환경에서는 생성이 안 죽는다", async () => {
    anchorsWritable.mockResolvedValue(false);
    rootOrThrow.mockImplementation(() => {
      throw new Error("SCOPE_ROOT_PROJECT_ID is not a uuid");
    });
    const h = harness(async () => []);

    // 종전에는 이 줄이 던졌다(루트 해소가 capability 와 무관하게 먼저 평가됐다).
    await expect(swapGeneration(h.rt, CYCLE, GEN, "global")).resolves.toBe(true);
  });

  it("쓸 수 있으면 여전히 던진다 — 잘못된 env 로 조용히 NULL 을 쓰지 않는다", async () => {
    anchorsWritable.mockResolvedValue(true);
    rootOrThrow.mockImplementation(() => {
      throw new Error("SCOPE_ROOT_PROJECT_ID is not a uuid");
    });
    const h = harness(async () => []);

    await expect(swapGeneration(h.rt, CYCLE, GEN, "global")).rejects.toThrow(
      "SCOPE_ROOT_PROJECT_ID",
    );
    expect(published(h.log), "트랜잭션을 아예 열지 않는다").toBe(false);
  });
});
