/**
 * S4 추이 게이트 셀(PR③)의 **행동 가드** — 검증자 D-3.
 *
 * `websiteTrendSet`·`trendPeriodFilters`·`TREND_MIN_CYCLES`·`TREND_CYCLE_WEEKS` 는
 * `server.ts` 밖에서 참조가 0 이라, 이 파일이 없으면 판정 규칙이 **아무 그물도 없이**
 * 산다. 여기서 실행으로 고정하는 것 넷:
 *   ① 13주 창은 사용자가 기간을 **안 골랐을 때만** 걸린다(고르면 그 값 그대로).
 *   ② 하한은 `weeks.length` 다 — 함대 앵커가 여럿이어도 주가 하나면 `agg-single-cycle`.
 *   ③ 주가 둘 이상이면 집계층 경로로 간다.
 *   ④ ①추이와 ⑥추이가 **같은 판정**을 본다(한쪽만 넘어가면 ⑥ 병합 키가 어긋난다).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CycleRangeQuery, CycleRangeRow } from "@/lib/db/repositories/summary-cycles";

// react-server 빌드라야 `cache()` 가 실제로 memoize 한다(request-scope 참조).
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

const PROJECTS = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
vi.mock("@/lib/db/repositories/website-sites", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getProjectIdsForScope: async () => PROJECTS };
});

const pickCyclesInRange = vi.fn<[CycleRangeQuery], Promise<CycleRangeRow[] | null>>();
vi.mock("@/lib/db/repositories/summary-cycles", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    pickCyclesInRange: (q: CycleRangeQuery) => pickCyclesInRange(q),
    pickWebsiteCycles: async () => null,
    hasOpenCycle: async () => false,
  };
});
vi.mock("@/lib/db/repositories/summary-settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readEnabled: async () => true,
    summaryLedgerAvailable: async () => true,
    summaryUnitFlagsAvailable: async () => true,
    websiteExcludedUnits: async () => [],
    readScreensRaw: async () => "[]", // 빈 배열 = 전 화면 허용(screens.ts 계약)
  };
});
vi.mock("@/lib/db/repositories/summary-trend-fold", () => ({
  trendFoldPresent: async () => true,
}));

const summaryTrend = vi.fn(async () => [] as unknown[]);
const summaryAccuracyTrend = vi.fn(async () => [] as unknown[]);
vi.mock("@/lib/db/repositories/summary-website-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    summaryWebsiteTrend: () => summaryTrend(),
    summaryWebsiteCitationAccuracyTrend: () => summaryAccuracyTrend(),
  };
});

const mirrorTrend = vi.fn(async () => [] as unknown[]);
const mirrorAccuracyTrend = vi.fn(async () => [] as unknown[]);
vi.mock("@/lib/db/repositories/scope-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aggregateStandardTrendFromMirror: () => mirrorTrend(),
    aggregateWebsiteCitationAccuracyTrend: () => mirrorAccuracyTrend(),
    websiteDeclaredOwnedBases: async () => ({ prefixes: [], universe: undefined }),
  };
});

const { withRequestScope } = await import("@/test/request-scope");
const { fetchWebsiteTrend, fetchWebsiteCitationAccuracyTrend } = await import("./server");

/**
 * 한 주 = 함대 회차 **하나**. anchor 는 프로젝트마다 다르게 준다(라이브 형태 —
 * 2026-09-10 실측 open 9/07주 66회차의 anchor 가 전부 distinct 였다).
 * ⚠️ 프로젝트를 하나로 두면 `judgeCycleRange` 의 `duplicate-cycle-in-week` 에 걸려
 *    **다른 이유로** 폴백한다 — 그러면 주 하한을 검증하지 못한다. 프로젝트를 나눈다.
 */
const fleetWeek = (week: string, anchors: string[]): CycleRangeRow[] =>
  anchors.map((anchor, i) => ({
    cycleId: `aaaaaaaa-0000-0000-0000-${week.replace(/-/g, "")}${i}`,
    generationId: `bbbbbbbb-0000-0000-0000-${week.replace(/-/g, "")}${i}`,
    projectId: PROJECTS[i % PROJECTS.length],
    cycleAnchorAt: anchor,
    cycleWeek: week,
    status: "published",
    renderable: true,
    pending: false,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  pickCyclesInRange.mockResolvedValue([]);
});

describe("S4 추이 기간 게이트", () => {
  it("① 기간 미지정이면 13주 창을 건다 — 지정하면 그 값 그대로", async () => {
    const now = Date.now();
    await withRequestScope(() => fetchWebsiteTrend({}));
    const auto = pickCyclesInRange.mock.calls[0][0];
    expect(auto.dateTo ?? null).toBeNull();
    const days = (now - Date.parse(`${auto.dateFrom}T00:00:00Z`)) / 86_400_000;
    expect(Math.floor(days)).toBe(13 * 7); // 정오(UTC) 이후 round 가 92 로 튀던 시각 의존 제거

    vi.clearAllMocks();
    pickCyclesInRange.mockResolvedValue([]);
    await withRequestScope(() =>
      fetchWebsiteTrend({ dateFrom: "2026-01-01", dateTo: "2026-02-01" }),
    );
    const picked = pickCyclesInRange.mock.calls[0][0];
    expect(picked.dateFrom).toBe("2026-01-01");
    expect(picked.dateTo).toBe("2026-02-01");
  });

  it("② 주가 하나면 미러 — 함대 앵커가 여럿이어도(자정 걸침 포함) 마찬가지", async () => {
    // 같은 `cycle_week` 인데 anchor 가 UTC 자정을 걸쳐 2일에 걸친다 = 여전히 **한 회차**.
    pickCyclesInRange.mockResolvedValue(
      fleetWeek("2026-09-07", ["2026-09-10T23:30:00.000Z", "2026-09-11T00:30:00.000Z"]),
    );
    await withRequestScope(() => fetchWebsiteTrend({}));
    expect(summaryTrend).not.toHaveBeenCalled();
    expect(mirrorTrend).toHaveBeenCalledTimes(1);
  });

  it("③ 주가 둘이면 집계층으로 간다", async () => {
    pickCyclesInRange.mockResolvedValue([
      ...fleetWeek("2026-08-31", ["2026-09-04T00:00:00.000Z"]),
      ...fleetWeek("2026-09-07", ["2026-09-10T23:30:00.000Z"]),
    ]);
    await withRequestScope(() => fetchWebsiteTrend({}));
    expect(summaryTrend).toHaveBeenCalledTimes(1);
    expect(mirrorTrend).not.toHaveBeenCalled();
  });

  it("④ ①·⑥ 이 같은 판정을 본다 — 한쪽만 넘어가면 ⑥ 병합 키가 어긋난다", async () => {
    pickCyclesInRange.mockResolvedValue([
      ...fleetWeek("2026-08-31", ["2026-09-04T00:00:00.000Z"]),
      ...fleetWeek("2026-09-07", ["2026-09-10T23:30:00.000Z"]),
    ]);
    await withRequestScope(async () => {
      await Promise.all([fetchWebsiteTrend({}), fetchWebsiteCitationAccuracyTrend({})]);
    });
    expect(summaryTrend).toHaveBeenCalledTimes(1);
    expect(summaryAccuracyTrend).toHaveBeenCalledTimes(1);
    expect(mirrorTrend).not.toHaveBeenCalled();
    expect(mirrorAccuracyTrend).not.toHaveBeenCalled();
    // 판정 셀은 요청당 1회 — 두 페처가 같은 React cache 셀을 공유한다.
    expect(pickCyclesInRange).toHaveBeenCalledTimes(1);
  });

  it("⑤ 주가 하나인 창에서도 ①·⑥ 이 **함께** 미러로 떨어진다", async () => {
    pickCyclesInRange.mockResolvedValue(fleetWeek("2026-08-31", ["2026-09-04T00:00:00.000Z"]));
    await withRequestScope(async () => {
      await Promise.all([fetchWebsiteTrend({}), fetchWebsiteCitationAccuracyTrend({})]);
    });
    expect(mirrorTrend).toHaveBeenCalledTimes(1);
    expect(mirrorAccuracyTrend).toHaveBeenCalledTimes(1);
    expect(summaryTrend).not.toHaveBeenCalled();
    expect(summaryAccuracyTrend).not.toHaveBeenCalled();
  });
});
