import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  trendGridForced,
  trendGridOverrideAllowedHere,
  TREND_GRID_SCREEN_KEY,
} from "./trend-grid-flag";
import { SUMMARY_SCREEN_KEYS, SUMMARY_SCREEN_OPT_IN } from "@/lib/summary/read/screens";

// 기본값은 **off** 다. 켜면 추이의 점 개수와 x축 라벨이 바뀐다(창이 날짜에서 자리
// 개수로, 빈 자리 정책이 원장 기준으로). env 오버라이드는 프리뷰에서만 그것을
// 뒤집을 수 있고, 프로덕션에 그 변수가 실수로 설정돼도 판정이 바뀌면 안 된다.

describe("trendGridOverrideAllowedHere", () => {
  it("Vercel 프리뷰에서만 허용된다", () => {
    expect(trendGridOverrideAllowedHere({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv)).toBe(true);
    expect(trendGridOverrideAllowedHere({ VERCEL_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(trendGridOverrideAllowedHere({ VERCEL_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("Vercel 밖에서는 development 만", () => {
    expect(trendGridOverrideAllowedHere({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
    expect(trendGridOverrideAllowedHere({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(trendGridOverrideAllowedHere({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("VERCEL_ENV 가 있으면 NODE_ENV 는 안 본다", () => {
    expect(
      trendGridOverrideAllowedHere({
        VERCEL_ENV: "production",
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("trendGridForced", () => {
  it("프로덕션에서는 변수가 켜져 있어도 무시한다", () => {
    expect(
      trendGridForced({ VERCEL_ENV: "production", TREND_GRID_FORCE: "1" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("프리뷰 + '1' 일 때만 참", () => {
    expect(
      trendGridForced({ VERCEL_ENV: "preview", TREND_GRID_FORCE: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      trendGridForced({ VERCEL_ENV: "preview", TREND_GRID_FORCE: "true" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(trendGridForced({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv)).toBe(false);
  });

  // 이름이 바뀌면 프리뷰에서 아무리 켜도 안 켜지고, 화면에는 "종전 동작" 으로만 보인다.
  it("읽는 변수 이름은 TREND_GRID_FORCE 다", () => {
    expect(
      trendGridForced({ VERCEL_ENV: "preview", ANSWER_ANCHOR_FORCE: "1" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("화면 키 등록", () => {
  it("키 이름이 계약대로 X.trendGrid 다", () => {
    expect(TREND_GRID_SCREEN_KEY).toBe("X.trendGrid");
    expect(SUMMARY_SCREEN_KEYS as readonly string[]).toContain("X.trendGrid");
  });

  // 옵트인 집합에 없으면 `screens all`(= `'[]'`, 성능 스위치)로 켜진다 — 이 키는
  // 과거 점의 모수를 바꾸므로(08-03 미러 8,386 → 2,640) 그 경로로 켜지면 안 된다.
  it("옵트인이다 — screens all 로 켜지지 않는다", () => {
    expect(SUMMARY_SCREEN_OPT_IN.has("X.trendGrid")).toBe(true);
  });

  // 축과 **다른 키**여야 한다: 격자가 이상하면 격자만 끄고 축은 유지할 수 있어야 한다.
  it("앵커 축 키와 다른 키다", () => {
    expect(TREND_GRID_SCREEN_KEY).not.toBe("X.answerAnchor");
  });
});

describe("trendGridEnabled — 스위치 먼저, 선행 축 나중", () => {
  const prevVercel = process.env.VERCEL_ENV;
  const prevForce = process.env.TREND_GRID_FORCE;

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    if (prevVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prevVercel;
    if (prevForce === undefined) delete process.env.TREND_GRID_FORCE;
    else process.env.TREND_GRID_FORCE = prevForce;
    vi.restoreAllMocks();
  });

  async function load(opts: { axis: boolean; screen: boolean }) {
    const screenSpy = vi.fn(async () => opts.screen);
    const axisSpy = vi.fn(async () => opts.axis);
    vi.doMock("@/lib/summary/read/screens", () => ({ summaryScreenAllowed: screenSpy }));
    vi.doMock("./anchor-axis-state", () => ({ ensureAnchorAxis: axisSpy }));
    const mod = await import("./trend-grid-flag");
    return { mod, screenSpy, axisSpy };
  }

  it("스위치가 꺼져 있으면 축 판정을 건드리지 않는다", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.TREND_GRID_FORCE;
    const { mod, axisSpy } = await load({ axis: true, screen: false });
    expect(await mod.trendGridEnabled()).toBe(false);
    expect(axisSpy).not.toHaveBeenCalled();
  });

  // 선행 조건: 축이 꺼져 있으면 자리 키(`round_date`)가 없다 → 모든 점이 갭이 된다.
  it("축이 꺼져 있으면 env 강제도 화면 키도 이기지 못한다", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.TREND_GRID_FORCE = "1";
    const { mod, screenSpy } = await load({ axis: false, screen: true });
    expect(await mod.trendGridEnabled()).toBe(false);
    // env 강제가 스위치를 켜므로 설정 읽기는 생략된다(단락 평가).
    expect(screenSpy).not.toHaveBeenCalled();
  });

  it("축 ✓ + 프리뷰 강제 → 화면 키와 무관하게 켜진다", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.TREND_GRID_FORCE = "1";
    const { mod, screenSpy } = await load({ axis: true, screen: false });
    expect(await mod.trendGridEnabled()).toBe(true);
    expect(screenSpy).not.toHaveBeenCalled();
  });

  it("축 ✓ + 강제 없음 → 화면 키가 결정한다", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.TREND_GRID_FORCE;
    const on = await load({ axis: true, screen: true });
    expect(await on.mod.trendGridEnabled()).toBe(true);
    expect(on.screenSpy).toHaveBeenCalledWith("X.trendGrid");

    vi.resetModules();
    const off = await load({ axis: true, screen: false });
    expect(await off.mod.trendGridEnabled()).toBe(false);
  });
});

describe("ensureTrendGrid — 요청 단위 확정", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("동시에 여러 번 불러도 판정은 1회다", async () => {
    const screenSpy = vi.fn(async () => true);
    vi.doMock("@/lib/summary/read/screens", () => ({ summaryScreenAllowed: screenSpy }));
    vi.doMock("./anchor-axis-state", () => ({ ensureAnchorAxis: async () => true }));
    const mod = await import("./trend-grid-flag");
    mod.resetTrendGridForTests();
    const [a, b, c] = await Promise.all([
      mod.ensureTrendGrid(),
      mod.ensureTrendGrid(),
      mod.ensureTrendGrid(),
    ]);
    expect([a, b, c]).toEqual([true, true, true]);
    // 확정 뒤에 다시 불러도 왕복이 늘지 않는다(TTL 안).
    expect(await mod.ensureTrendGrid()).toBe(true);
    expect(screenSpy).toHaveBeenCalledTimes(1);
    expect(mod.trendGridKnownEnabled()).toBe(true);
  });

  it("판정이 throw 해도 종전 격자(false)로 수렴한다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("@/lib/summary/read/screens", () => ({
      summaryScreenAllowed: async () => {
        throw new Error("설정 읽기 실패");
      },
    }));
    vi.doMock("./anchor-axis-state", () => ({ ensureAnchorAxis: async () => true }));
    const mod = await import("./trend-grid-flag");
    mod.resetTrendGridForTests();
    await expect(mod.ensureTrendGrid()).resolves.toBe(false);
  });

  // 던지는 쪽이 **축**일 때도 같아야 한다. 판정 실패가 화면 장애가 되면 안 되고,
  // 실패의 의미는 "종전 추이" 라 그 방향으로는 값이 틀릴 수 없다.
  it("축 판정이 throw 해도 종전 격자(false)로 수렴한다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("@/lib/summary/read/screens", () => ({ summaryScreenAllowed: async () => true }));
    vi.doMock("./anchor-axis-state", () => ({
      ensureAnchorAxis: async () => {
        throw new Error("boom");
      },
    }));
    const mod = await import("./trend-grid-flag");
    mod.resetTrendGridForTests();
    expect(await mod.ensureTrendGrid()).toBe(false);
    expect(mod.trendGridKnownEnabled()).toBe(false);
  });

  // 미확정 상태에서 동기 읽기는 **false** 다 — 값이 틀리는 방향이 아니라 안 켜지는 방향.
  it("확정 전 동기 읽기는 false 다", async () => {
    vi.doMock("@/lib/summary/read/screens", () => ({ summaryScreenAllowed: async () => true }));
    vi.doMock("./anchor-axis-state", () => ({ ensureAnchorAxis: async () => true }));
    const mod = await import("./trend-grid-flag");
    mod.resetTrendGridForTests();
    expect(mod.trendGridKnownEnabled()).toBe(false);
  });
});
