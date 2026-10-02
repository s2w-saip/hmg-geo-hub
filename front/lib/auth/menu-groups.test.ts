import { describe, expect, it } from "vitest";
import { effectiveMenuGroups } from "./menu-groups";
import { defaultLandingFor } from "./route-policy";

describe("effectiveMenuGroups — 세션·로그인 착지 공용", () => {
  it("저장값 유효 그룹만 통과, 비면 null(제한 없음) — 종전 동작", () => {
    expect(effectiveMenuGroups(["standard", "website"], { all: false, countries: ["DE"] })).toEqual([
      "standard",
      "website",
    ]);
    expect(effectiveMenuGroups(["bogus"], { all: false })).toBeNull();
    expect(effectiveMenuGroups(null, { all: false })).toBeNull();
  });

  it("WW·CPO(글로벌 시장 없음)는 standard 를 뺀다 → 착지는 웹사이트", () => {
    const ww = effectiveMenuGroups(["standard", "website"], { all: false, countries: ["worldwide"] });
    expect(ww).toEqual(["website"]);
    expect(defaultLandingFor("hq", ww)).toMatch(/^\/website/);
    const cpo = effectiveMenuGroups(null, { all: false, countries: ["CPO"] });
    expect(cpo).not.toContain("standard");
    expect(defaultLandingFor("hq", cpo)).toMatch(/^\/website/);
  });

  it("현대 N 은 글로벌 유지", () => {
    expect(
      effectiveMenuGroups(["standard", "website"], { all: false, countries: ["HYUNDAI-N"] }),
    ).toEqual(["standard", "website"]);
  });

  it("글로벌만 허용된 계정은 비우지 않는다(빈 배열 = 제한 없음이라 넓어진다)", () => {
    expect(effectiveMenuGroups(["standard"], { all: false, countries: ["worldwide"] })).toEqual([
      "standard",
    ]);
  });
});
