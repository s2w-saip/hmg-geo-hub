/**
 * 언급 화면 경쟁사 값 보강 read 의 **실패 격리** (2026-09-20 검증자 N-d).
 *
 * `fetchStandardMentionCompetitorBrands` 는 **장식적 보강**이다 — 없으면 화면은 종전
 * 미러 값을 그대로 그리고 정상 동작한다. 그런데 이 프로미스는 페이지가 컴포넌트
 * prop 으로 넘기므로(`mention/page.tsx`), 거부되면 **그 KPI 탭 경계가 통째로 에러**다.
 *
 * 종전 보호는 `kpiDegrade`(`kpi-tab-budget.ts`) 하나였고 그것은 **타임아웃만** 삼킨다
 * (`if (!isTimeoutFailure(e)) throw e`). 즉 SQL 문법·커넥션·권한 오류는 그대로 올라와
 * 지면을 내렸다. 여기서 고정하는 것 셋:
 *
 *   ① 타임아웃이 **아닌** 오류도 `null` 로 떨어진다(= 종전 미러 값 유지).
 *   ② 타임아웃도 `null` 이다(종전 동작 유지).
 *   ③ 삼키되 **조용하지 않다** — `console.error` 한 줄이 남는다.
 *
 * 대조군: 같은 실패를 **다른 페처**(`fetchStandardMentions`)에 주입하면 종전대로 던진다.
 * 이 보호가 전역 삼킴이 아니라 이 한 페처의 것임을 보여야 테스트가 공허하지 않다.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => fn,
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", role: "admin", scope: { all: true } } }),
}));
vi.mock("@/lib/audit", () => ({ auditScopeCall: () => {} }));
vi.mock("@/lib/db/repositories/entity-registry", () => ({
  entityRegistryRepository: { listOwn: async () => [] },
}));
// 집계층 스위치 off → 게이트가 거부 → **미러 폴백**이 밟힌다(주입 지점이 거기다).
vi.mock("@/lib/db/repositories/summary-settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readEnabled: async () => false };
});

const aggregateMentionsFromMirror = vi.fn();
vi.mock("@/lib/db/repositories/scope-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aggregateMentionsFromMirror: (...a: unknown[]) => aggregateMentionsFromMirror(...a),
  };
});

const { withRequestScope } = await import("@/test/request-scope");
const { setTrendGridForTests, resetTrendGridForTests } = await import(
  "@/lib/period/trend-grid-flag"
);
const { fetchStandardMentionCompetitorBrands, fetchStandardMentions } = await import("./server");

/** 드라이버가 내는 진짜 타임아웃 형태 — drizzle 이 감싸고 원본은 `cause` 에 있다. */
function statementTimeout(): Error {
  const inner = Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });
  return Object.assign(new Error("Failed query: WITH …"), { cause: inner });
}

const BRANDS = [
  { brand: "Tesla", mentions: 10, prompts: 2, share: 5.8, mentionRate: 30.4, avgPosition: 21.3, isTracked: false },
];

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.SCOPE_ROOT_PROJECT_ID = "root-1";
  vi.clearAllMocks();
  // 격자가 꺼져 있으면 이 페처는 왕복 0 으로 null 이라 실패 경로 자체가 안 밟힌다.
  setTrendGridForTests(true);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetTrendGridForTests();
  errorSpy.mockRestore();
});

describe("N-d — 경쟁사 보강 read 는 어떤 오류든 지면을 내리지 않는다", () => {
  it("① 타임아웃이 **아닌** 오류도 `null` 이다 (종전 미러 값이 남는다)", async () => {
    aggregateMentionsFromMirror.mockRejectedValue(new Error("column does not exist"));
    const out = await withRequestScope(() => fetchStandardMentionCompetitorBrands({}));
    expect(out).toBeNull();
    expect(aggregateMentionsFromMirror).toHaveBeenCalled();
  });

  it("② 타임아웃도 `null` 이다 (종전 동작 유지)", async () => {
    aggregateMentionsFromMirror.mockRejectedValue(statementTimeout());
    const out = await withRequestScope(() => fetchStandardMentionCompetitorBrands({}));
    expect(out).toBeNull();
  });

  it("③ 삼키되 **로그가 남는다** — 조용히 옛 값으로 돌아가지 않는다", async () => {
    aggregateMentionsFromMirror.mockRejectedValue(new Error("connection terminated"));
    await withRequestScope(() => fetchStandardMentionCompetitorBrands({}));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
      "standardMentionCompetitorBrands failed",
    );
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain("connection terminated");
  });

  it("**대조군**: 같은 실패를 다른 페처에 주면 종전대로 던진다(전역 삼킴이 아니다)", async () => {
    aggregateMentionsFromMirror.mockRejectedValue(new Error("column does not exist"));
    await expect(withRequestScope(() => fetchStandardMentions({}))).rejects.toThrow(
      "column does not exist",
    );
  });

  it("정상 경로는 그대로 값을 낸다 (보호가 성공까지 삼키지 않는다)", async () => {
    aggregateMentionsFromMirror.mockResolvedValue({
      summary: { total: 10, uniqueBrands: 1, totalPrompts: 2 },
      asOf: null,
      brands: BRANDS,
      perBrandPrompts: {},
      sentimentTotals: null,
      typeTotals: null,
      hasPosition: false,
      trend: null,
    });
    const out = await withRequestScope(() => fetchStandardMentionCompetitorBrands({}));
    expect(out).toEqual(BRANDS);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("격자 off 면 왕복 0 으로 `null` — 실패 경로에 닿지 않는다", async () => {
    setTrendGridForTests(false);
    aggregateMentionsFromMirror.mockRejectedValue(new Error("column does not exist"));
    const out = await withRequestScope(() => fetchStandardMentionCompetitorBrands({}));
    expect(out).toBeNull();
    expect(aggregateMentionsFromMirror).not.toHaveBeenCalled();
  });
});
