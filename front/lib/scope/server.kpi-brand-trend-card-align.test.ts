/**
 * 언급 KPI 탭 **브랜드 추이 = 카드 원천** 배선의 행동 가드 (2026-09-29 제품 책임자 A안).
 *
 * 결함(운영 담당 실측, 통합 프리뷰 · 계정 스코프 Kia·IN · AI 점유율 탭):
 *   · 히어로 카드 29.6% — `withOverviewCards` → `fetchStandardAggregates`(집계층 회차 스냅샷)
 *   · 같은 히어로의 브랜드 추이 9/28 점 29.9% — `fetchStandardKpiBrandTrend` 가
 *     `S1.brandTrend`(옵트인, 운영 `read_screens` 에 없음) 게이트에 막혀 **항상 미러**.
 *   같은 필터로 집계층 시계열을 읽으면 9/28 점이 카드와 정확히 같다(29.6).
 *
 * 수리: KPI 탭 호출(`weekAxis: "S2.mentionTrend"`) + 격자 on(`ensureTrendGrid()`) 이면
 * `S1.brandTrend` 옵트인이 꺼져 있어도 **카드와 같은 게이트(`S1.dashboard`)** 로 집계층
 * 시계열을 탄다. 카드가 집계층을 읽는 조건과 같다.
 *
 * 이 파일이 실행으로 고정하는 것:
 *   ① 격자 on + KPI 탭 + 옵트인 off + 카드 게이트 on → 집계층(미러 미호출).
 *   ② 격자 off → 미러(종전 그대로).
 *   ③ 대시보드 호출(`weekAxis` 없음) → 격자 on 이어도 미러.
 *   ④ 카드 게이트(`S1.dashboard`)가 꺼져 있으면 → 미러(카드도 미러이므로 같은 원천).
 *   ⑤ 로그가 우회를 **정직하게** 말한다 — 화면 키는 `S1.brandTrend` 그대로.
 *   ⑥ 집계층이 거부되면(접기 없음) 종전 미러 폴백 그대로.
 *   ⑦ 언급 페이지의 실제 필터 형태(`cumulative: true`)에서도 ① 이 성립한다.
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
    readGlobalTrendCore: () => readCore(),
    readGlobalBrandSnapshot: () => readSnapshot(),
    readGlobalBrandSeries: () => readSeries(),
  };
});

// 코어 셀이 읽기 전에 부르는 공식(HMG) 키 후보(2026-09-29 ⑤ 분자) — 이 파일의 관심사는
// 경로이지 값이 아니므로 빈 후보로 둔다(DB 미접속).
vi.mock("@/lib/db/repositories/summary-trend-aggregates", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readSummaryGroupKeyUniverse: async () => [] };
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
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("KPI 탭 브랜드 추이 — 카드와 같은 원천", () => {
  it("① 격자 on + KPI 탭 + `S1.brandTrend` 옵트인 off → 집계층(미러 미호출)", async () => {
    setTrendGridForTests(true);
    const out = await kpiTab();
    expect(readCore).toHaveBeenCalled();
    expect(readSeries).toHaveBeenCalled();
    expect(mirrorBrandTrend).not.toHaveBeenCalled();
    // 값도 집계층 매핑이다 — 9/28 자리 Kia 30/100 = 30.0%.
    const last = out?.buckets.at(-1);
    expect(last?.brands.find((b) => b.brand === "Kia")?.sharePct).toBe(30);
  });

  it("② 격자 off → 미러(종전 그대로)", async () => {
    setTrendGridForTests(false);
    const out = await kpiTab();
    expect(mirrorBrandTrend).toHaveBeenCalledTimes(1);
    expect(readCore).not.toHaveBeenCalled();
    expect(out?.windowStartBucket).toBe(MIRROR_MARK);
    // 종전 로그 그대로 — 우회 꼬리표가 붙지 않는다.
    expect(infoLines().some((l) => l.includes("opt-in-bypass"))).toBe(false);
    expect(infoLines()).toContain("x-hmg-summary(global S1.brandTrend period): fallback:screen-not-allowed");
  });

  it("③ 대시보드 호출(`weekAxis` 없음)은 격자 on 이어도 미러", async () => {
    setTrendGridForTests(true);
    const out = await dashboard();
    expect(mirrorBrandTrend).toHaveBeenCalledTimes(1);
    expect(readCore).not.toHaveBeenCalled();
    expect(out?.windowStartBucket).toBe(MIRROR_MARK);
    expect(infoLines().some((l) => l.includes("opt-in-bypass"))).toBe(false);
  });

  it("④ 카드 게이트(`S1.dashboard`)가 꺼져 있으면 미러 — 카드도 미러이므로 같은 원천", async () => {
    setTrendGridForTests(true);
    screensRaw = '["S3.citation"]';
    await kpiTab();
    expect(mirrorBrandTrend).toHaveBeenCalledTimes(1);
    expect(readCore).not.toHaveBeenCalled();
  });

  it("⑤ 로그는 화면 키를 바꾸지 않고 우회 사유를 말한다", async () => {
    setTrendGridForTests(true);
    await kpiTab();
    const route = infoLines().filter((l) => l.startsWith("x-hmg-summary(global S1.brandTrend period): hit"));
    expect(route).toHaveLength(1);
    expect(route[0]).toContain("opt-in-bypass:kpi-card-align");
    expect(route[0]).toContain("S1.dashboard");
    // 화면 키를 카드 키로 바꿔 끼운 로그가 없다.
    expect(infoLines().some((l) => l.startsWith("x-hmg-summary(global S1.dashboard period)"))).toBe(false);
  });

  it("⑥ 집계층이 거부되면(접기 없음) 종전 미러 폴백", async () => {
    setTrendGridForTests(true);
    foldPresent = false;
    const out = await kpiTab();
    expect(mirrorBrandTrend).toHaveBeenCalledTimes(1);
    expect(out?.windowStartBucket).toBe(MIRROR_MARK);
    expect(infoLines()).toContain(
      "x-hmg-summary(global S1.brandTrend period): fallback:agg-fold-missing → mirror",
    );
  });

  it("⑦ 옵트인을 명시로 켠 경우는 종전 hit 그대로 — 우회 꼬리표 없음", async () => {
    setTrendGridForTests(true);
    screensRaw = '["S1.dashboard","S1.brandTrend"]';
    await kpiTab();
    expect(readCore).toHaveBeenCalled();
    expect(mirrorBrandTrend).not.toHaveBeenCalled();
    expect(infoLines().some((l) => l.includes("opt-in-bypass"))).toBe(false);
  });

  it("⑧ `cumulative` 가 없어도 같은 경로다(필터 형태가 라우팅을 가르지 않는다)", async () => {
    setTrendGridForTests(true);
    await kpiTab({ brand: ["Kia"], region: ["IN"] });
    expect(readCore).toHaveBeenCalled();
    expect(mirrorBrandTrend).not.toHaveBeenCalled();
  });
});

// 위 describe 는 판정 본체(`resolveGlobalSummaryRouteBase`)를 mock 한다. 페이지 필터의
// `cumulative: true` 가 **기간 모드 판정**에서 폴백 사유가 아닌지는 실물로 본다 —
// 스냅샷 모드에서만 사유라서(`gate.ts::commonUnsupportedReason`) 카드는
// `overviewReadFilters` 로 그 축을 다시 맞추지만, 추이는 기간 모드라 맞출 필요가 없다.
describe("기간 모드 판정 — `cumulative` 는 사유가 아니다", () => {
  it("글로벌 미지원 축 판정: period 는 통과, snapshot 은 `cumulative`", async () => {
    const actual = await vi.importActual<typeof import("@/lib/summary/read/gate")>(
      "@/lib/summary/read/gate",
    );
    expect(actual.unsupportedGlobalFilterReason(PAGE_FILTERS, "period")).toBeNull();
    expect(actual.unsupportedGlobalFilterReason(PAGE_FILTERS, "snapshot")).toBe("cumulative");
  });
});
