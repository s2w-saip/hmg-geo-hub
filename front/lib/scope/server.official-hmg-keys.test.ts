/**
 * 글로벌 ⑤ 분자(공식(HMG) 카테고리, 제품 책임자 2026-09-29) — 코어 추이 셀 배선의 행동 가드.
 *
 * 고정하는 것:
 *   ① 코어 read(`readGlobalTrendCore`)가 **공식(HMG) 키 목록**을 스코프로 받는다 — 목록은
 *      그 집합의 group_key 후보를 JS 분류기(카테고리 차트와 같은 함수)로 고른 것이다.
 *   ② 목록은 캐시 경계를 JSON 으로 통과한다(문자열 배열 — Map 금지 규약).
 *   ③ 후보 조회는 인용 계열이 읽는 회차 쌍으로 한다(필터 무관).
 * 모킹 배선은 `server.kpi-brand-trend-card-align.test.ts` 와 같다(같은 경로를 탄다).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SummaryCyclePick } from "@/lib/db/repositories/summary-cycles";
import type { StandardFilters } from "@/lib/scope/result-adapter";

// react-server 빌드라야 `cache()` 가 실제로 memoize 한다(request-scope 참조).
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});
// 셀 결과는 **JSON 라운드트립**한다 — 실제 Data Cache 경계(`Map` 반환 결함 전례).
vi.mock("next/cache", () => ({
  unstable_cache: <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...args: A) => {
      const out = await fn(...args);
      return (out === undefined ? out : JSON.parse(JSON.stringify(out))) as R;
    },
  revalidateTag: () => {},
  revalidatePath: () => {},
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: "u1", role: "admin", scope: { all: true } } }),
}));
vi.mock("@/lib/audit", () => ({ auditScopeCall: () => {}, auditDataAccess: () => {} }));
vi.mock("@/lib/db/repositories/entity-registry", () => ({
  entityRegistryRepository: { listOwn: async () => [] },
}));

// ── 설정: `read_screens` 원문 ─────────────────────────────────────────────────
// 운영값(2026-09-29 실측)에는 `S1.brandTrend` 가 **없다**.
const PROD_SCREENS =
  '["S4.dashboard","S1.dashboard","S3.citation","S6.citation","S4.subkpi","S1.competitors","S2.mentionTrend"]';
let screensRaw: string | null = PROD_SCREENS;
vi.mock("@/lib/db/repositories/summary-settings", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readEnabled: async () => true,
    summaryLedgerAvailable: async () => true,
    summaryUnitFlagsAvailable: async () => true,
    websiteExcludedUnits: async () => [],
    readScreensRaw: async () => screensRaw,
  };
});

// ── 기간 판정: 회차 둘(9/21·9/28 자리) — 판정 본체는 이 파일의 관심사가 아니다 ──
const cycle = (n: number, anchor: string, week: string): SummaryCyclePick => ({
  cycleId: `aaaaaaaa-0000-0000-0000-00000000000${n}`,
  generationId: `bbbbbbbb-0000-0000-0000-00000000000${n}`,
  projectId: "mock-root-project",
  cycleAnchorAt: anchor,
  cycleWeek: week,
});
const C1 = cycle(1, "2026-09-20T15:00:00.000Z", "2026-09-21");
const C2 = cycle(2, "2026-09-27T15:00:00.000Z", "2026-09-28");
const resolveBase = vi.fn(async () => ({
  path: "summary" as const,
  surface: "global" as const,
  mode: "period" as const,
  cycles: [C1, C2],
  cycleKey: [C1, C2].map((c) => `${c.cycleId}:${c.generationId}`).join(","),
  projectIds: ["mock-root-project"],
  missingProjectIds: [],
  weeks: [C1.cycleWeek, C2.cycleWeek],
  anchorCount: 2,
  openRuns: false,
}));
vi.mock("@/lib/summary/read/gate", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveGlobalSummaryRouteBase: () => resolveBase() };
});

// 자리 목록·갭 후보 — 값이 아니라 경로를 본다. 자리 없음 = 종전 창.
vi.mock("@/lib/period/trend-grid", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, buildTrendGrid: async () => null };
});
vi.mock("@/lib/summary/read/trend-gaps", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, trendGapWeekKeys: async () => null };
});

// 접기 존재 프로브 — 기본 있음. ⑥ 에서 없음으로 뒤집는다.
let foldPresent = true;
vi.mock("@/lib/db/repositories/summary-trend-fold", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, trendFoldPresent: async () => foldPresent };
});

// ── 집계층 리더(3문장) — 스파이. 매핑(`attachBrandSeries`·`toBrandTrend`)은 실물. ──
const pt = (brand: string, isTracked: boolean, mentions: number) => ({
  brand, isTracked, mentions, answers: mentions, rankSum: 0, rankedAnswers: 0,
  compRankSum: 0, compRankedAnswers: 0,
});
const bucket = (anchor: string, compMentions: number) => ({
  anchor, bucketStart: anchor.slice(0, 10), monitored: 100, trackedAnswers: 50,
  ownMentions: 30, compMentions, ownPositive: 0, ownSignals: 0, rankSum: 0,
  rankedAnswers: 0, allCitations: 0, ownedCitations: 0, brands: [], engines: [],
});
const coreScopes: unknown[] = [];
const readCore = vi.fn(async () => ({
  empty: false as const,
  value: { buckets: [bucket(C1.cycleAnchorAt, 90), bucket(C2.cycleAnchorAt, 100)], brandTotals: [] },
}));
const readSnapshot = vi.fn(async () => ({
  empty: false as const,
  value: [pt("Kia", true, 30), pt("Hyundai", false, 9)],
}));
const readSeries = vi.fn(async () => ({
  empty: false as const,
  value: new Map([
    [C1.cycleAnchorAt, [pt("Kia", true, 27), pt("Hyundai", false, 8)]],
    [C2.cycleAnchorAt, [pt("Kia", true, 30), pt("Hyundai", false, 9)]],
  ]),
}));
vi.mock("@/lib/db/repositories/summary-global-trend-read", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readGlobalTrendCore: (scope: unknown) => { coreScopes.push(scope); return readCore(); },
    readGlobalBrandSnapshot: () => readSnapshot(),
    readGlobalBrandSeries: () => readSeries(),
  };
});

// 코어 셀이 읽기 전에 부르는 공식(HMG) 키 후보 — 이 파일의 관심사다.
const readUniverse = vi.fn(async (_set: unknown) => [
  "hyundai.com", "example.com", "linkedin.com/hyundai-motor-group", "linkedin.com", "kia.co.kr",
]);
vi.mock("@/lib/db/repositories/summary-trend-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readSummaryGroupKeyUniverse: (set: unknown) => readUniverse(set) };
});

// ── 미러 폴백 — 표식 값 ─────────────────────────────────────────────────────
const MIRROR_MARK = "mirror-window-start";
const mirrorBrandTrend = vi.fn(async () => ({
  unit: "week",
  brands: [],
  buckets: [],
  windowStartBucket: MIRROR_MARK,
  windowEndBucket: null,
}));
vi.mock("@/lib/db/repositories/scope-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aggregateBrandTrendFromMirror: () => mirrorBrandTrend(),
    websiteDeclaredOwnedBases: async () => ({ prefixes: [], universe: undefined }),
  };
});

const { resetSummaryScreensForTests } = await import("@/lib/summary/read/screens");
const { setTrendGridForTests, resetTrendGridForTests } = await import(
  "@/lib/period/trend-grid-flag"
);
const { withRequestScope } = await import("@/test/request-scope");
const { fetchStandardKpiBrandTrend } = await import("./server");

/** 언급 페이지(`mention/page.tsx`)가 실제로 넘기는 필터 형태 — `cumulative: true` 상시. */
const PAGE_FILTERS: StandardFilters = { brand: ["Kia"], region: ["IN"], cumulative: true };

const kpiTab = (f: StandardFilters = PAGE_FILTERS) =>
  withRequestScope(() => fetchStandardKpiBrandTrend(f, { weekAxis: "S2.mentionTrend" }));
const dashboard = (f: StandardFilters = PAGE_FILTERS) =>
  withRequestScope(() => fetchStandardKpiBrandTrend(f, { budget: "extras" }));

let info: ReturnType<typeof vi.spyOn>;
const infoLines = (): string[] => info.mock.calls.map((c: unknown[]) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  resetSummaryScreensForTests();
  resetTrendGridForTests();
  screensRaw = PROD_SCREENS;
  foldPresent = true;
  coreScopes.length = 0;
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("글로벌 ⑤ 분자 — 코어 셀이 공식(HMG) 키 목록을 싣는다", () => {
  it("① 코어 read 스코프에 분류된 목록이 실린다(비공식·같은 도메인 비공식 행 제외)", async () => {
    setTrendGridForTests(true);
    await kpiTab();
    expect(readCore).toHaveBeenCalled();
    const scope = coreScopes[0] as { officialGroupKeys?: string[] };
    expect(scope.officialGroupKeys).toEqual(
      ["hyundai.com", "kia.co.kr", "linkedin.com/hyundai-motor-group"].sort(),
    );
  });

  it("② 목록은 JSON 라운드트립을 통과한 문자열 배열이다", async () => {
    setTrendGridForTests(true);
    await kpiTab();
    const keys = (coreScopes[0] as { officialGroupKeys: unknown }).officialGroupKeys;
    expect(Array.isArray(keys)).toBe(true);
    expect(JSON.parse(JSON.stringify(keys))).toEqual(keys);
  });

  it("③ 후보 조회는 회차 쌍만으로 한다 — 필터가 달라도 같은 집합 인자", async () => {
    setTrendGridForTests(true);
    await kpiTab({ brand: ["Kia"], region: ["IN"], cumulative: true });
    await kpiTab({ brand: ["Hyundai"], cumulative: true });
    const sets = readUniverse.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(sets.length).toBeGreaterThan(0);
    expect(new Set(sets).size).toBe(1);
    const set = readUniverse.mock.calls[0][0] as { cycles: Array<{ cycleId: string }> };
    expect(set.cycles.map((c) => c.cycleId).sort()).toEqual([C1.cycleId, C2.cycleId].sort());
  });
});
