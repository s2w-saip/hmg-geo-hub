import { describe, expect, it } from "vitest";
import {
  periodCompareForced,
  periodCompareOverrideAllowedHere,
} from "./period-compare-flag";

// 이 스위치의 기본값은 **off** 다. env 오버라이드는 프리뷰에서만 그것을 뒤집을 수 있어야
// 하고, 프로덕션에 그 변수가 실수로 설정돼도 판정이 바뀌면 안 된다 — 켜지면 고객이 보는
// 카드 값과 증감이 함께 바뀌기 때문이다.

describe("periodCompareOverrideAllowedHere", () => {
  it("Vercel 프리뷰에서만 허용된다", () => {
    expect(periodCompareOverrideAllowedHere({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv)).toBe(true);
    expect(periodCompareOverrideAllowedHere({ VERCEL_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(periodCompareOverrideAllowedHere({ VERCEL_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("Vercel 밖에서는 development 만", () => {
    expect(periodCompareOverrideAllowedHere({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
    expect(periodCompareOverrideAllowedHere({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(periodCompareOverrideAllowedHere({} as NodeJS.ProcessEnv)).toBe(false);
  });

  // `VERCEL_ENV=production` + `NODE_ENV=development` 조합에서 NODE_ENV 가 이기면
  // 프로덕션이 열린다 — VERCEL_ENV 가 있으면 그것만 본다.
  it("VERCEL_ENV 가 있으면 NODE_ENV 는 안 본다", () => {
    expect(
      periodCompareOverrideAllowedHere({
        VERCEL_ENV: "production",
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("periodCompareForced", () => {
  it("프로덕션에서는 변수가 켜져 있어도 무시한다", () => {
    expect(
      periodCompareForced({
        VERCEL_ENV: "production",
        PERIOD_COMPARE_FORCE: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("프리뷰 + '1' 일 때만 참", () => {
    expect(
      periodCompareForced({ VERCEL_ENV: "preview", PERIOD_COMPARE_FORCE: "1" } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      periodCompareForced({ VERCEL_ENV: "preview", PERIOD_COMPARE_FORCE: "true" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(periodCompareForced({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
