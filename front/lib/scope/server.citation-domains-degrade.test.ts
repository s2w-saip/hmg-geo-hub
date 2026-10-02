/**
 * 인용 도메인 롤업의 예산·보호 (PR④ A3) — 실패 주입 행동 가드.
 *
 * `fetchStandardCitationDomains` 는 대시보드 경쟁사 경계의 네 read 중 **유일한 무보호
 * read** 였다. A3 가 `degradeAware` + `extras` 예산을 붙였고, 여기서 고정하는 것 셋:
 *
 *   ① 미러 폴백이 상한(`57014`)에 걸리면 **던지지 않고 `null`** 로 내려온다
 *      — 던지면 `Promise.all`(dashboard/page.tsx) 이 거부돼 카드 지면이 통째로
 *        에러 바운더리로 떨어진다(`use(competitors)`).
 *   ② `wasDegraded("standardCitationDomains")` 로 "데이터 없음"과 갈린다.
 *   ③ 시간 초과가 **아닌** 실패(권한·문법·연결)는 종전대로 던진다 — 삼키면 결함이
 *      "데이터 없음"으로 위장된다.
 *
 * 값 무변경은 이 파일의 대상이 아니다 — A3 는 예산·보호만 얹고 산식·인자를 안 건드린다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
// 집계층 스위치 off → 게이트가 `gate-disabled` 로 거부 → **미러 폴백**이 밟힌다.
vi.mock("@/lib/db/repositories/summary-settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readEnabled: async () => false };
});

const aggregateCitationsFromMirror = vi.fn();
vi.mock("@/lib/db/repositories/scope-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aggregateCitationsFromMirror: (...a: unknown[]) => aggregateCitationsFromMirror(...a),
  };
});

const { withRequestScope } = await import("@/test/request-scope");
const { fetchStandardCitationDomains, fetchStandardCitations, wasDegraded } =
  await import("./server");

/** 드라이버가 내는 진짜 형태 — drizzle 이 감싸고 원본은 `cause` 에 있다. */
function statementTimeout(): Error {
  const inner = Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });
  return Object.assign(new Error("Failed query: WITH …"), { cause: inner });
}

const DOMAINS = [{ domain: "hyundai.com", citations: 3, share: 30, isOurs: true }];

beforeEach(() => {
  process.env.SCOPE_ROOT_PROJECT_ID = "root-1";
  vi.clearAllMocks();
});

describe("A3 — 인용 도메인 롤업의 실패 주입", () => {
  it("① 예산 초과는 `null` 로 내려온다 — 던지지 않는다", async () => {
    aggregateCitationsFromMirror.mockRejectedValue(statementTimeout());
    const out = await withRequestScope(() => fetchStandardCitationDomains({}));
    expect(out).toBeNull();
    expect(aggregateCitationsFromMirror).toHaveBeenCalled();
  });

  it("② degrade 표식이 남아 '데이터 없음'과 갈린다", async () => {
    aggregateCitationsFromMirror.mockRejectedValue(statementTimeout());
    const seen = await withRequestScope(async () => {
      const v = await fetchStandardCitationDomains({});
      // 표식은 **같은 요청 스코프**에서만 보인다.
      return { v, degraded: wasDegraded("standardCitationDomains") };
    });
    expect(seen.v).toBeNull();
    expect(seen.degraded).toBe(true);
  });

  it("데이터가 없어서 `null` 인 경우에는 표식이 없다(둘이 구분된다)", async () => {
    aggregateCitationsFromMirror.mockResolvedValue(null);
    const seen = await withRequestScope(async () => {
      const v = await fetchStandardCitationDomains({});
      return { v, degraded: wasDegraded("standardCitationDomains") };
    });
    expect(seen.v).toBeNull();
    expect(seen.degraded).toBe(false);
  });

  it("③ 시간 초과가 아닌 실패는 그대로 던진다", async () => {
    aggregateCitationsFromMirror.mockRejectedValue(new Error("column does not exist"));
    await expect(
      withRequestScope(() => fetchStandardCitationDomains({})),
    ).rejects.toThrow("column does not exist");
  });

  it("정상 경로는 종전과 같은 값을 낸다(도메인 롤업만)", async () => {
    aggregateCitationsFromMirror.mockResolvedValue({ domains: DOMAINS, urls: [] });
    const out = await withRequestScope(() => fetchStandardCitationDomains({}));
    expect(out).toEqual(DOMAINS);
  });

  it("미러 폴백은 `extras` 예산으로 발행된다 — 실효 최악 45 s", async () => {
    aggregateCitationsFromMirror.mockResolvedValue({ domains: DOMAINS, urls: [] });
    const before = Date.now();
    await withRequestScope(() => fetchStandardCitationDomains({}));
    const budget = aggregateCitationsFromMirror.mock.calls[0]?.[5] as {
      statementTimeoutMs?: number;
      deadlineAt: number;
    };
    expect(budget.statementTimeoutMs).toBe(15_000);
    // 벽시계 30 s — S3 화면(`screen`, 45 s)이 아니라 대시보드 extras 다.
    // 창을 ±1 s 로 두는 이유는 `Date.now()` 두 번의 간격뿐이다(45 s 와는 못 헷갈린다).
    const wall = budget.deadlineAt - before;
    expect(wall).toBeGreaterThan(29_000);
    expect(wall).toBeLessThan(31_000);
  });

  it("S3 인용 화면은 같은 셀이 아니라 `screen` 예산(45 s)을 받는다 — 프로파일이 캐시 키다", async () => {
    aggregateCitationsFromMirror.mockResolvedValue({ domains: DOMAINS, urls: [] });
    const before = Date.now();
    await withRequestScope(() => fetchStandardCitations({}));
    const budget = aggregateCitationsFromMirror.mock.calls[0]?.[5] as {
      statementTimeoutMs?: number;
      deadlineAt: number;
    };
    expect(budget.statementTimeoutMs).toBe(15_000);
    const wall = budget.deadlineAt - before;
    expect(wall).toBeGreaterThan(44_000);
    expect(wall).toBeLessThan(46_000);
  });
});
