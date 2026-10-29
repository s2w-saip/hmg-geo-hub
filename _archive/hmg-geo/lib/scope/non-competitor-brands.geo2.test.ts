/**
 * GEO-2 회귀 그물 — 일반 영어 단어와 겹치는 차종명 처리.
 *
 * 문서(브랜드-판정-정합화-개발인계.md)의 완료 기준을 고정한다:
 *   · 오탐(`is`·`focus`·`charger`)은 bare 표기로 제외된다
 *   · 정탐(`i30`·`i20`·`Fiat 500`)은 **수 변화 없음**
 *   · 이름붙은 제품(`Focus ST`·`Golf GTI`)은 되살아난다
 *
 * ⚠️ 이 파일이 지키는 것은 **판정 함수**다. SQL 경로와의 패리티는
 * 같은 상수에서 파생된다는 구조로 담보되며(BARE_ONLY_NON_COMPETITOR_PATTERNS),
 * 그 등가성은 기존 패리티 테스트가 본다.
 */
import { describe, expect, it } from "vitest";
import {
  isNonCompetitorBrand,
  NON_COMPETITOR_BRANDS,
  BARE_ONLY_NON_COMPETITOR_PATTERNS,
} from "./non-competitor-brands";

const GEO2 = [
  "focus", "legacy", "charger", "city", "edge", "is", "vision",
  "volt", "crown", "golf", "transit", "gravity", "fastback", "dual electronics",
  // 2026-08-31 2차 — 실화면 검수에서 Honda 롤업 밑에 남아 있던 것들
  "pilot", "falcon", "century", "element", "lightning", "punch", "one",
  "integra", "bolt", "fit",
] as const;

/**
 * ⚠️ **당사 모델은 절대 넣지 않는다.** 2차 후보 중 excel·seven·stellar·click
 * 은 소문자 비중이 같은 부류였지만 **전량 당사 언급**이었다(Hyundai
 * Excel/Stellar/Click, 총 9,178건). 넣었으면 당사 지표를 그만큼 깎았다.
 * 이 목록이 이 회귀를 고정한다.
 */
const OURS_MODELS = ["excel", "seven", "stellar", "click"] as const;

describe("GEO-2 · 오탐 제외", () => {
  it("14개 전부 bare 표기로 비경쟁 판정된다", () => {
    for (const n of GEO2) expect(isNonCompetitorBrand(n), n).toBe(true);
  });

  it("대소문자·공백에 무관하게 판정된다", () => {
    expect(isNonCompetitorBrand("Focus")).toBe(true);
    expect(isNonCompetitorBrand("  IS  ")).toBe(true);
    expect(isNonCompetitorBrand("Dual Electronics")).toBe(true);
  });
});

describe("GEO-2 · 정탐 보호 (문서가 경고한 함정)", () => {
  it("i30·i20 은 소문자 전용이지만 정식 모델명이라 건드리지 않는다", () => {
    for (const n of ["i30", "i20", "i10", "i4", "i5", "i7", "e-tron"]) {
      expect(isNonCompetitorBrand(n), n).toBe(false);
    }
  });

  it("Fiat 500 · 숫자 모델명도 그대로다", () => {
    for (const n of ["fiat 500", "500", "300", "911", "2008"]) {
      expect(isNonCompetitorBrand(n), n).toBe(false);
    }
  });

  it("당사 모델은 배제되지 않는다 — 2차 후보에서 걸러낸 것들", () => {
    for (const n of OURS_MODELS) expect(isNonCompetitorBrand(n), n).toBe(false);
  });

  it("실제 경쟁 브랜드는 영향 없다", () => {
    for (const n of ["toyota", "honda", "ford", "bmw", "tesla"]) {
      expect(isNonCompetitorBrand(n), n).toBe(false);
    }
  });
});

describe("GEO-2 · 이름붙은 제품 되살림", () => {
  it("14개 전부 BARE_ONLY 패턴을 갖는다 — 없으면 정탐이 함께 죽는다", () => {
    const named = new Set(BARE_ONLY_NON_COMPETITOR_PATTERNS.map(([n]) => n));
    for (const n of GEO2) expect(named.has(n), n).toBe(true);
  });

  it("패턴은 경계를 요구한다 — bare 자신과 접두 부분일치는 매치되지 않는다", () => {
    const [, focusPattern] = BARE_ONLY_NON_COMPETITOR_PATTERNS.find(
      ([n]) => n === "focus",
    )!;
    // POSIX 패턴을 JS 로 옮겨 같은 경계 성질을 확인한다.
    const re = new RegExp(focusPattern.replace("[^[:alnum:]]", "[^\\p{L}\\p{Nd}]"), "iu");
    expect(re.test("Focus ST")).toBe(true);      // 되살아나야 함
    expect(re.test("Focus")).toBe(false);        // bare — 제외 유지
    expect(re.test("Focusing")).toBe(false);     // 부분일치 — 제외 유지
  });
});

describe("GEO-2 · 두 상수가 한 세트로 유지된다", () => {
  it("BARE_ONLY 항목은 반드시 NON_COMPETITOR_BRANDS 에도 있다", () => {
    for (const [n] of BARE_ONLY_NON_COMPETITOR_PATTERNS) {
      expect(NON_COMPETITOR_BRANDS.has(n), n).toBe(true);
    }
  });
});
