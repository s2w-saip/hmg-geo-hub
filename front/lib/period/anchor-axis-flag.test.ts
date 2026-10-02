import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  answerAnchorForced,
  answerAnchorOverrideAllowedHere,
  ANSWER_ANCHOR_SCREEN_KEY,
} from "./anchor-axis-flag";
import { SUMMARY_SCREEN_KEYS, SUMMARY_SCREEN_OPT_IN } from "@/lib/summary/read/screens";

// 이 스위치의 기본값은 **off** 다(계약 §4: "끄면 종전 동작이 바이트 단위로 같아야
// 한다"). env 오버라이드는 프리뷰에서만 그것을 뒤집을 수 있고, 프로덕션에 그 변수가
// 실수로 설정돼도 판정이 바뀌면 안 된다.

describe("answerAnchorOverrideAllowedHere", () => {
  it("Vercel 프리뷰에서만 허용된다", () => {
    expect(
      answerAnchorOverrideAllowedHere({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      answerAnchorOverrideAllowedHere({ VERCEL_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      answerAnchorOverrideAllowedHere({ VERCEL_ENV: "development" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("Vercel 밖에서는 development 만", () => {
    expect(
      answerAnchorOverrideAllowedHere({ NODE_ENV: "development" } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      answerAnchorOverrideAllowedHere({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(answerAnchorOverrideAllowedHere({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("VERCEL_ENV 가 있으면 NODE_ENV 는 안 본다", () => {
    expect(
      answerAnchorOverrideAllowedHere({
        VERCEL_ENV: "production",
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("answerAnchorForced", () => {
  it("프로덕션에서는 변수가 켜져 있어도 무시한다", () => {
    expect(
      answerAnchorForced({
        VERCEL_ENV: "production",
        ANSWER_ANCHOR_FORCE: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("프리뷰 + '1' 일 때만 참", () => {
    expect(
      answerAnchorForced({
        VERCEL_ENV: "preview",
        ANSWER_ANCHOR_FORCE: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      answerAnchorForced({
        VERCEL_ENV: "preview",
        ANSWER_ANCHOR_FORCE: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(answerAnchorForced({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv)).toBe(false);
  });

  // 계약 §4 의 env 이름은 고정이다 — 다른 이름으로 바뀌면 프리뷰에서 아무리 켜도
  // 안 켜지고, 그 사실이 화면에는 "종전 동작"으로만 보인다(조용한 실패).
  it("읽는 변수 이름은 ANSWER_ANCHOR_FORCE 다", () => {
    expect(
      answerAnchorForced({
        VERCEL_ENV: "preview",
        PERIOD_COMPARE_FORCE: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("화면 키 등록", () => {
  it("키 이름이 계약대로 X.answerAnchor 다", () => {
    expect(ANSWER_ANCHOR_SCREEN_KEY).toBe("X.answerAnchor");
    expect(SUMMARY_SCREEN_KEYS as readonly string[]).toContain("X.answerAnchor");
  });

  // 옵트인 집합에 없으면 `screens all`(= `'[]'`, 성능 스위치)로 켜진다.
  it("옵트인이다 — screens all 로 켜지지 않는다", () => {
    expect(SUMMARY_SCREEN_OPT_IN.has("X.answerAnchor")).toBe(true);
  });
});

describe("answerAnchorEnabled — 세 겹 판정", () => {
  const prevVercel = process.env.VERCEL_ENV;
  const prevForce = process.env.ANSWER_ANCHOR_FORCE;

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    if (prevVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prevVercel;
    if (prevForce === undefined) delete process.env.ANSWER_ANCHOR_FORCE;
    else process.env.ANSWER_ANCHOR_FORCE = prevForce;
    vi.restoreAllMocks();
  });

  async function load(opts: { table: boolean; screen: boolean }) {
    const screenSpy = vi.fn(async () => opts.screen);
    vi.doMock("@/lib/db/column-availability", () => ({
      answerCycleAnchorsAvailable: async () => opts.table,
    }));
    vi.doMock("@/lib/summary/read/screens", () => ({
      summaryScreenAllowed: screenSpy,
    }));
    const mod = await import("./anchor-axis-flag");
    return { enabled: mod.answerAnchorEnabled, screenSpy };
  }

  it("테이블이 없으면 env 강제도 화면 키도 이기지 못한다", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.ANSWER_ANCHOR_FORCE = "1";
    const { enabled, screenSpy } = await load({ table: false, screen: true });
    expect(await enabled()).toBe(false);
    // env 강제가 스위치를 켜므로 설정 읽기는 생략된다(단락 평가).
    expect(screenSpy).not.toHaveBeenCalled();
  });

  // 순서 계약(2026-09-20 개정, 검증 주의 A-1): **스위치 먼저, capability 나중.**
  // 스위치가 꺼져 있으면 capability 프로브를 쏘지 않는다 — 그 프로브는
  // `ensureColumnAvailability()` 배치 밖 별도 statement 라 콜드 왕복이 하나 는다.
  it("스위치가 꺼져 있으면 capability 프로브를 쏘지 않는다", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.ANSWER_ANCHOR_FORCE;
    const tableSpy = vi.fn(async () => true);
    vi.doMock("@/lib/db/column-availability", () => ({
      answerCycleAnchorsAvailable: tableSpy,
    }));
    vi.doMock("@/lib/summary/read/screens", () => ({
      summaryScreenAllowed: async () => false,
    }));
    const mod = await import("./anchor-axis-flag");
    expect(await mod.answerAnchorEnabled()).toBe(false);
    expect(tableSpy).not.toHaveBeenCalled();
  });

  it("스위치가 켜졌는데 테이블이 없으면 여전히 off 다 (42703 가드는 그대로)", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.ANSWER_ANCHOR_FORCE;
    const { enabled, screenSpy } = await load({ table: false, screen: true });
    expect(await enabled()).toBe(false);
    expect(screenSpy).toHaveBeenCalledWith("X.answerAnchor");
  });

  it("테이블 ✓ + 프리뷰 강제 → 화면 키와 무관하게 켜진다", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.ANSWER_ANCHOR_FORCE = "1";
    const { enabled, screenSpy } = await load({ table: true, screen: false });
    expect(await enabled()).toBe(true);
    expect(screenSpy).not.toHaveBeenCalled();
  });

  it("테이블 ✓ + 강제 없음 → 화면 키가 결정한다", async () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.ANSWER_ANCHOR_FORCE;
    const on = await load({ table: true, screen: true });
    expect(await on.enabled()).toBe(true);
    expect(on.screenSpy).toHaveBeenCalledWith("X.answerAnchor");

    vi.resetModules();
    const off = await load({ table: true, screen: false });
    expect(await off.enabled()).toBe(false);
  });
});
