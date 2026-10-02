import { describe, expect, it, vi } from "vitest";

// API 경로의 degrade 표식(U4, 부록 A R-degrade): 일시 실패(5xx·시간 초과·연결 실패·중단)는
// 옛 예산 초과와 같은 라벨로 기록하고 null, 4xx 와 그 밖의 예외는 그대로 던진다.
// 기록은 요청 스코프(React cache) 안에서만 보인다. react-server 빌드로 요청 하나를 재현한다.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

const { withRequestScope } = await import("@/test/request-scope");
const { degradeOnApiFailure, isDegradableApiFailure, markDegraded, wasDegraded, degradedLabels, degradeAware } = await import(
  "./degrade-registry"
);
const { HghApiError, LOCAL_CODES } = await import("@/lib/hgh/errors");

const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("isDegradableApiFailure", () => {
  it.each([
    [new HghApiError(503, "upstream"), true],
    [new HghApiError(502, LOCAL_CODES.network), true],
    [new HghApiError(504, LOCAL_CODES.timeout), true],
    [new HghApiError(502, LOCAL_CODES.nonJson), true],
    [new HghApiError(500, "internal"), true],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), true],
    [Object.assign(new Error("t"), { name: "TimeoutError" }), true],
    [new HghApiError(401, "unauthenticated"), false],
    [new HghApiError(403, "role_forbidden"), false],
    [new HghApiError(404, "not_found"), false],
    [new HghApiError(422, "unprocessable"), false],
    [new Error("boom"), false],
  ])("%s -> %s", (e, want) => {
    expect(isDegradableApiFailure(e)).toBe(want);
  });
});

describe("degradeOnApiFailure", () => {
  it("success: value, no mark", async () => {
    await withRequestScope(async () => {
      expect(await degradeOnApiFailure("ok", async () => 7)).toBe(7);
      expect(wasDegraded("ok")).toBe(false);
    });
  });

  it("5xx / timeout: null and the legacy label is marked in this request only", async () => {
    const warn = quiet();
    await withRequestScope(async () => {
      expect(await degradeOnApiFailure("standardAggregates", async () => { throw new HghApiError(504, LOCAL_CODES.timeout); })).toBeNull();
      expect(wasDegraded("standardAggregates")).toBe(true);
      expect(degradedLabels()).toEqual(["standardAggregates"]);
    });
    await withRequestScope(async () => {
      expect(wasDegraded("standardAggregates")).toBe(false); // next request starts clean
    });
    // one log line with code, status, request id; never the body
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("504 timeout");
    expect(String(warn.mock.calls[0][0])).toContain("degraded=standardAggregates");
    warn.mockRestore();
  });

  it("4xx and other errors: rethrown, not marked", async () => {
    await withRequestScope(async () => {
      for (const e of [new HghApiError(403, "role_forbidden"), new HghApiError(422, "unprocessable"), new Error("x")]) {
        await expect(degradeOnApiFailure("w", async () => { throw e; })).rejects.toBe(e);
      }
      expect(wasDegraded("w")).toBe(false);
    });
  });

  it("outside a request scope: still null, recording is a no-op (never throws)", async () => {
    const warn = quiet();
    expect(await degradeOnApiFailure("x", async () => { throw new HghApiError(503, "upstream"); })).toBeNull();
    expect(() => markDegraded("x")).not.toThrow();
    warn.mockRestore();
  });

  it("the legacy degradeAware is unchanged (timeouts only, same label store)", async () => {
    await withRequestScope(async () => {
      markDegraded("a");
      expect(await degradeAware("b", async () => 1)).toBe(1);
      expect(degradedLabels()).toEqual(["a"]);
    });
  });
});
