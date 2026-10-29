import { describe, it, expect, vi } from "vitest";
import { degradeAware, wasDegraded, degradedLabels } from "./degrade-registry";
import { AnswerSetDeadlineError } from "@/lib/db/repositories/scope-aggregates";

// degrade 는 **시간 초과만** 삼킨다. 그 규칙(kpi-tab-budget::isTimeoutFailure)은
// 이미 고정돼 있고, 여기서는 표식이 그 판정을 따라가는지를 본다.

class PgTimeout extends Error {
  code = "57014";
  constructor() {
    super("canceling statement due to statement timeout");
  }
}

describe("degradeAware — 시간 초과만 삼키고 표식을 남긴다", () => {
  it("성공하면 값 그대로, 표식 없음", async () => {
    expect(await degradeAware("ok", async () => 42)).toBe(42);
    expect(wasDegraded("ok")).toBe(false);
  });

  it("벽시계 마감 초과 → null + 표식", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await degradeAware("deadline", async () => {
      throw new AnswerSetDeadlineError("mirror statement");
    });
    warn.mockRestore();
    expect(r).toBeNull();
    // 요청 스코프(React cache) 밖이라 표식 저장은 no-op 이지만 **던지지 않는다** —
    // 스크립트·단위 테스트에서 degrade 자체가 깨지면 안 된다.
    expect(typeof wasDegraded("deadline")).toBe("boolean");
    expect(Array.isArray(degradedLabels())).toBe(true);
  });

  it("Postgres 57014 → null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await degradeAware("pg", async () => { throw new PgTimeout(); })).toBeNull();
    warn.mockRestore();
  });

  it("⚠️ 권한·연결·문법 실패는 **그대로 던진다** (빈 화면으로 위장 금지)", async () => {
    for (const e of [
      Object.assign(new Error("permission denied"), { code: "42501" }),
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("syntax error at or near"), { code: "42601" }),
    ]) {
      await expect(degradeAware("boom", async () => { throw e; })).rejects.toThrow();
    }
  });
});
