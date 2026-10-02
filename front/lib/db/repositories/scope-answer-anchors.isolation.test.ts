import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { runAnchorRefreshIsolated } from "./scope-answer-anchors";

// ════════════════════════════════════════════════════════════════════════════
// 앵커 전파 격리 (통합 검증 D3·D2)
// ════════════════════════════════════════════════════════════════════════════
//
// 이 전파는 **옵트인 밖**이다: 화면 키가 꺼져 있어도 배포 즉시 돈다. 그래서 실패가
// 본 작업(미러 싱크·회차 발행)을 죽이면 축을 켜 보지도 못한 채 적재가 멈춘다.
// savepoint 안에서 부르고, 실패하면 savepoint 만 되감고 경고를 남긴 뒤 계속한다.

const STMT = sql`SELECT refresh_answer_cycle_anchors('{}'::uuid[], NULL::uuid)`;

/** drizzle postgres-js 트랜잭션의 모양 — `transaction` 이 savepoint 로 내려간다. */
function savepointTx(inner: { execute: ReturnType<typeof vi.fn> }) {
  return {
    execute: vi.fn(),
    // 콜백이 던지면 드라이버가 ROLLBACK TO SAVEPOINT 후 **다시 던진다**.
    transaction: vi.fn(async (fn: (t: typeof inner) => Promise<unknown>) => fn(inner)),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("savepoint 를 지원하면 격리한다", () => {
  it("성공하면 savepoint 안에서 한 번 발행하고 true", async () => {
    const inner = { execute: vi.fn().mockResolvedValue(undefined) };
    const tx = savepointTx(inner);
    await expect(runAnchorRefreshIsolated(tx, "mirror-sync", "run-1", STMT)).resolves.toBe(
      true,
    );
    expect(tx.transaction).toHaveBeenCalledTimes(1);
    expect(inner.execute).toHaveBeenCalledTimes(1);
    // 바깥 트랜잭션에는 이 문장이 직접 나가지 않는다.
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("던져도 **본 트랜잭션은 살아 있다** — false 를 돌려주고 삼킨다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = {
      execute: vi.fn().mockRejectedValue(
        Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        }),
      ),
    };
    await expect(
      runAnchorRefreshIsolated(savepointTx(inner), "cycle-publish", "cyc-1", STMT),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("경고 한 줄이 구조화돼 있고 비밀값을 싣지 않는다", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) =>
      lines.push(a.map(String).join(" ")),
    );
    const inner = {
      execute: vi.fn().mockRejectedValue(
        Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      ),
    };
    await runAnchorRefreshIsolated(savepointTx(inner), "mirror-sync", "run-9", STMT);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[anchor-refresh] isolated-rollback");
    expect(lines[0]).toContain("op=mirror-sync");
    expect(lines[0]).toContain("scope=run-9");
    expect(lines[0]).toContain("code=40P01");
    expect(lines[0]).toContain("msg=deadlock detected");
    // 접속 문자열·자격증명이 섞일 경로가 없어야 한다.
    expect(lines[0]).not.toMatch(/postgres(ql)?:\/\//);
    expect(lines[0]).not.toMatch(/password/i);
  });

  it("코드가 없는 오류도 한 줄로 닫는다", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) =>
      lines.push(a.map(String).join(" ")),
    );
    const inner = { execute: vi.fn().mockRejectedValue("문자열 오류") };
    await runAnchorRefreshIsolated(savepointTx(inner), "mirror-sync", "run-1", STMT);
    expect(lines[0]).toContain("code=none");
    expect(lines[0]).toContain("msg=문자열 오류");
  });
});

describe("savepoint 를 못 쓰면 **삼키지 않는다**", () => {
  // 삼키면 트랜잭션이 aborted(25P02)로 남아 이어지는 문장이 전부 죽는다.
  // 격리할 수 없을 때는 종전 동작(직접 발행·전파)이 덜 나쁘다.
  it("execute 만 있는 실행자는 직접 발행한다", async () => {
    const tx = { execute: vi.fn().mockResolvedValue(undefined) };
    await expect(runAnchorRefreshIsolated(tx, "mirror-sync", "run-1", STMT)).resolves.toBe(
      true,
    );
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("그 경로의 실패는 그대로 던진다", async () => {
    const tx = { execute: vi.fn().mockRejectedValue(new Error("boom")) };
    await expect(
      runAnchorRefreshIsolated(tx, "mirror-sync", "run-1", STMT),
    ).rejects.toThrow("boom");
  });
});
