import { describe, it, expect } from "vitest";
import { marketInScope } from "@/lib/standards/prompt-markets";
import { effectiveScopeCountries } from "@/lib/rhq";
import type { AllowedScope } from "@/lib/auth/types";

/**
 * B1 (운영 결정 2026-09-03): 글로벌 프롬프트 열람(/standard/prompts)의 행을
 * **계정 국가 스코프 ∩ 프롬프트 대상 시장**으로 좁힌다. 이 파일은 그 순수 규칙을
 * 5역할 × 시장 축으로 고정한다 — SQL 정본은
 * `lib/db/repositories/standards.ts::catalogMarketScopeCondition` 이고,
 * 형태 계약은 `standards.market-scope.test.ts` 가 지킨다.
 *
 * 규칙 3줄:
 *   ① 허용 국가 없음(admin/scope.all) → 제한 없음
 *   ② 실국가 태그 없음(NULL·[]·의사코드만) → 미지정(상속) = 전 시장 → 보인다
 *   ③ 그 외 → 실국가 겹침
 */

// 실데이터 표본 (hmg 운영 DB 2026-09-03 실측 조합).
const KR_ONLY = ["KR", "x:WW"];
const KR_CPO = ["KR", "x:CPO", "x:NBRAND", "x:WW"];
const NINE_MARKETS = ["x:WW", "AE", "BE", "BR", "CA", "DE", "EG", "FR", "US"];
const EU_TAGGED = ["x:EU", "x:ME", "x:NBRAND", "x:WW", "AE", "BE", "BR", "CA", "DE", "EG", "FR", "US"];
const LATAM = ["CL", "CO", "ES", "PE", "PR"];
const ME_ONLY = ["x:ME", "AE", "SA"];

// 5역할 × 스코프 (profiles 실제 값 형태 — 2026-09-03 운영 DB).
const SCOPES: Record<string, AllowedScope> = {
  admin: { all: true },
  hq: { all: false, brands: ["Hyundai"] },
  region: { all: false, brands: ["Hyundai"], regions: ["hyundai-asia-pacific"] },
  country: { all: false, brands: ["Hyundai"], regions: ["hyundai-asia-pacific"], countries: ["KR"] },
  // vendor 는 operator 축만 강제 none 이고 데이터 스코프는 country 와 같은 모양이다.
  vendor: { all: false, brands: ["Hyundai"], regions: ["hyundai-asia-pacific"], countries: ["KR"] },
};

const allowedFor = (role: keyof typeof SCOPES) => effectiveScopeCountries(SCOPES[role]);

describe("marketInScope — 5역할 × 대상 시장", () => {
  it("admin(scope.all)은 허용 국가가 undefined 라 전부 본다", () => {
    expect(allowedFor("admin")).toBeUndefined();
    for (const regions of [KR_ONLY, NINE_MARKETS, LATAM, ME_ONLY]) {
      expect(marketInScope(regions, allowedFor("admin"))).toBe(true);
    }
  });

  it("hq(브랜드만·국가 미설정)도 좁혀지지 않는다 — 종전 동작 유지", () => {
    expect(allowedFor("hq")).toBeUndefined();
    expect(marketInScope(LATAM, allowedFor("hq"))).toBe(true);
  });

  it("country(KR)는 자국 태그 행만 본다 — 스페인어 LATAM 행은 사라진다", () => {
    const allowed = allowedFor("country");
    expect(allowed).toEqual(["KR"]);
    expect(marketInScope(KR_ONLY, allowed)).toBe(true);
    expect(marketInScope(KR_CPO, allowed)).toBe(true);
    expect(marketInScope(LATAM, allowed)).toBe(false); // 고객 제보의 그 행
    expect(marketInScope(NINE_MARKETS, allowed)).toBe(false); // KR 미포함 9시장 행
  });

  it("vendor 도 country 와 동일하게 좁혀진다 (operator 축과 직교)", () => {
    expect(marketInScope(LATAM, allowedFor("vendor"))).toBe(false);
    expect(marketInScope(KR_ONLY, allowedFor("vendor"))).toBe(true);
  });

  it("region(아시아&태평양)은 권역 국가로 펼쳐 판정한다", () => {
    const allowed = allowedFor("region")!;
    expect(allowed).toContain("KR");
    expect(allowed).toContain("JP");
    expect(allowed).not.toContain("CL");
    expect(marketInScope(KR_ONLY, allowed)).toBe(true);
    expect(marketInScope(["JP"], allowed)).toBe(true);
    expect(marketInScope(LATAM, allowed)).toBe(false);
  });

  it("region(중동)은 ME 태그 행의 실국가(AE/SA)로 걸린다", () => {
    const me: AllowedScope = {
      all: false,
      brands: ["Hyundai"],
      regions: ["hyundai-middle-east"],
    };
    const allowed = effectiveScopeCountries(me)!;
    expect(marketInScope(ME_ONLY, allowed)).toBe(true);
    expect(marketInScope(KR_ONLY, allowed)).toBe(false);
  });
});

describe("marketInScope — 미지정(상속) 의미", () => {
  const kr = ["KR"];

  it("NULL·빈 배열은 상속 = 전 시장이므로 보인다", () => {
    expect(marketInScope(null, kr)).toBe(true);
    expect(marketInScope(undefined, kr)).toBe(true);
    expect(marketInScope([], kr)).toBe(true);
  });

  it("의사코드만 가진 행은 시장 귀속이 없으므로 보인다(안전판)", () => {
    expect(marketInScope(["x:WW"], kr)).toBe(true);
    expect(marketInScope(["x:EU", "x:ME"], kr)).toBe(true);
  });

  it("의사코드는 국가로 펼치지 않는다 — x:EU 가 있어도 실국가로만 판정", () => {
    // 실측 조합: x:EU 를 달고 있으나 실국가 목록에 IT 가 없다.
    expect(marketInScope(EU_TAGGED, ["IT"])).toBe(false);
    expect(marketInScope(EU_TAGGED, ["DE"])).toBe(true);
  });
});

describe("marketInScope — 정규화", () => {
  it("대소문자·공백을 정규화해 비교한다 (옵션 목록과 같은 규칙)", () => {
    expect(marketInScope([" kr "], ["KR"])).toBe(true);
    expect(marketInScope(["KR"], [" kr "])).toBe(true);
  });

  it("허용 국가에 섞인 비ISO 값(website 가상코드)은 아무 행에도 안 걸린다", () => {
    // profiles.countries 실측 오염: ["worldwide","KR"] · ["EU", …] · ["CPO","US"].
    // `x:` 접두사가 있어 카탈로그의 x:EU 와 충돌하지 않는다.
    expect(marketInScope(["x:EU", "DE"], ["EU"])).toBe(false);
    expect(marketInScope(["KR", "x:CPO"], ["CPO"])).toBe(false);
    expect(marketInScope(["KR", "x:CPO"], ["CPO", "KR"])).toBe(true);
  });

  it("허용 국가가 전부 무효면 좁히지 않는다 (국가 스코프 미설정과 동일)", () => {
    expect(marketInScope(LATAM, ["   "])).toBe(true);
  });
});
