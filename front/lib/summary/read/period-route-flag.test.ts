import { describe, it, expect, vi, beforeEach } from "vitest";

const summaryScreenAllowed = vi.fn<[string], Promise<boolean>>();
vi.mock("./screens", () => ({
  summaryScreenAllowed: (s: string) => summaryScreenAllowed(s),
}));

const {
  hasPeriod,
  periodRouteEnabled,
  periodRouteEnabledForScreen,
  periodRouteForced,
  periodRouteOverrideAllowedHere,
  periodRouteScreenKeyFor,
} = await import("./period-route-flag");

// 기간 경로 스위치: 화면 키 옵트인 + **프리뷰 전용** env.
// 계약은 GGMD-107 `period-compare-flag.ts` 와 같다: 값보다 **환경**을 먼저 본다.

describe("env 오버라이드는 프리뷰·로컬 개발에서만 읽힌다", () => {
  const E = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
    over as NodeJS.ProcessEnv;

  it("VERCEL_ENV 가 있으면 preview 일 때만 허용", () => {
    expect(periodRouteOverrideAllowedHere(E({ VERCEL_ENV: "preview" }))).toBe(true);
    expect(periodRouteOverrideAllowedHere(E({ VERCEL_ENV: "production" }))).toBe(false);
    expect(periodRouteOverrideAllowedHere(E({ VERCEL_ENV: "development" }))).toBe(false);
  });

  it("Vercel 밖에서는 NODE_ENV=development 만 허용", () => {
    expect(periodRouteOverrideAllowedHere(E({ NODE_ENV: "development" }))).toBe(true);
    expect(periodRouteOverrideAllowedHere(E({ NODE_ENV: "production" }))).toBe(false);
    expect(periodRouteOverrideAllowedHere(E({}))).toBe(false);
  });

  // 이 단언이 이 파일의 존재 이유다: 프로덕션에 변수가 실수로 들어가도 판정 불변.
  it("프로덕션에 PERIOD_ROUTE_FORCE=1 이 있어도 켜지지 않는다", () => {
    expect(periodRouteForced(E({ VERCEL_ENV: "production", PERIOD_ROUTE_FORCE: "1" }))).toBe(false);
    expect(periodRouteForced(E({ NODE_ENV: "production", PERIOD_ROUTE_FORCE: "1" }))).toBe(false);
    // 프리뷰에서는 켜진다. 값은 정확히 "1" 이다(true·yes 는 켜지 않는다).
    expect(periodRouteForced(E({ VERCEL_ENV: "preview", PERIOD_ROUTE_FORCE: "1" }))).toBe(true);
    expect(periodRouteForced(E({ VERCEL_ENV: "preview", PERIOD_ROUTE_FORCE: "true" }))).toBe(false);
    expect(periodRouteForced(E({ VERCEL_ENV: "preview" }))).toBe(false);
  });
});

describe("hasPeriod: 모드 선택 규칙의 단일 정의", () => {
  it("dateFrom 또는 dateTo 하나면 기간이다", () => {
    expect(hasPeriod({})).toBe(false);
    expect(hasPeriod({ dateFrom: null, dateTo: null })).toBe(false);
    expect(hasPeriod({ dateFrom: "" })).toBe(false);
    expect(hasPeriod({ dateFrom: "2026-08-20" })).toBe(true);
    expect(hasPeriod({ dateTo: "2026-09-18" })).toBe(true);
  });
});

describe("periodRouteEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    summaryScreenAllowed.mockResolvedValue(true);
  });

  // 회귀 0 의 근거: 기간이 없으면 스위치를 보지도 않는다.
  it("기간이 없으면 키가 켜져 있어도 false 이고 스위치를 읽지 않는다", async () => {
    expect(await periodRouteEnabled("S1.periodRoute", {})).toBe(false);
    expect(summaryScreenAllowed).not.toHaveBeenCalled();
  });

  it("기간이 있으면 화면 키 옵트인이 판정한다", async () => {
    expect(await periodRouteEnabled("S1.periodRoute", { dateFrom: "2026-08-20" })).toBe(true);
    expect(summaryScreenAllowed).toHaveBeenCalledWith("S1.periodRoute");

    summaryScreenAllowed.mockResolvedValue(false);
    expect(await periodRouteEnabled("S1.periodRoute", { dateFrom: "2026-08-20" })).toBe(false);
  });
});

// ── 화면별 판정 (F2) ────────────────────────────────────────────────────────
//
// 게이트 하나를 여러 화면이 공유하므로, 판정 입력은 게이트가 아니라 **화면 키**다.
// 매핑에 없는 화면은 스위치가 켜져 있어도 기간 모드를 타지 않는다.
describe("periodRouteEnabledForScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    summaryScreenAllowed.mockResolvedValue(true);
  });

  it("매핑에 있는 화면만 켜지고, 그때 **그 화면의 키**로 스위치를 본다", async () => {
    const period = { dateFrom: "2026-08-20" };
    expect(await periodRouteEnabledForScreen("S4.dashboard", period)).toBe(true);
    expect(summaryScreenAllowed).toHaveBeenCalledWith("S4.periodRoute");
    expect(await periodRouteEnabledForScreen("S1.dashboard", period)).toBe(true);
    expect(summaryScreenAllowed).toHaveBeenCalledWith("S1.periodRoute");
  });

  it("인용·언급 화면은 스위치를 **읽지도 않는다**", async () => {
    const period = { dateFrom: "2026-08-20" };
    for (const s of ["S5.mention", "S6.citation", "S2.mention", "S3.citation"] as const) {
      expect(await periodRouteEnabledForScreen(s, period), s).toBe(false);
    }
    expect(summaryScreenAllowed).not.toHaveBeenCalled();
    expect(periodRouteScreenKeyFor("S6.citation")).toBeNull();
  });
});
