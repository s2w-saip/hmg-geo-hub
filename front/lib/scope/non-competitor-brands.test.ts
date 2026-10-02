import { describe, expect, it } from "vitest";
import {
  BARE_ONLY_NON_COMPETITOR_PATTERNS,
  isNonCompetitorBrand,
  isNonCompetitorMention,
} from "./non-competitor-brands";
import { POSIX_LEADING_TRIM } from "./text-trim";

describe("isNonCompetitorBrand", () => {
  it("flags Apple/Google/Samsung", () => {
    expect(isNonCompetitorBrand("Apple")).toBe(true);
    expect(isNonCompetitorBrand("Google")).toBe(true);
    expect(isNonCompetitorBrand("Samsung")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isNonCompetitorBrand("apple")).toBe(true);
    expect(isNonCompetitorBrand("SAMSUNG")).toBe(true);
  });

  it("leaves real competitor brands untouched", () => {
    expect(isNonCompetitorBrand("Kia")).toBe(false);
    expect(isNonCompetitorBrand("Tesla")).toBe(false);
  });

  it("handles null/undefined/empty", () => {
    expect(isNonCompetitorBrand(null)).toBe(false);
    expect(isNonCompetitorBrand(undefined)).toBe(false);
    expect(isNonCompetitorBrand("")).toBe(false);
  });

  it("2026-08-28 확장 — 보통명사·국가명·범주 서술어 NER 오탐을 제외한다", () => {
    // AE/Genesis 슬라이스에서 언급의 ~9% 를 차지하던 실측 상위 오탐들
    expect(isNonCompetitorBrand("Modern")).toBe(true);
    expect(isNonCompetitorBrand("Status")).toBe(true);
    expect(isNonCompetitorBrand("Power Performance")).toBe(true);
    expect(isNonCompetitorBrand("Advanced")).toBe(true);
    expect(isNonCompetitorBrand("Global Pet Foods")).toBe(true);
    expect(isNonCompetitorBrand("German Automotive Industry")).toBe(true);
    expect(isNonCompetitorBrand("Canada")).toBe(true);
    expect(isNonCompetitorBrand("JD Power")).toBe(true);
    // 99% 이상이 형용사 용법으로 실측된 셋
    expect(isNonCompetitorBrand("Smart")).toBe(true);
    expect(isNonCompetitorBrand("Cruise")).toBe(true);
    expect(isNonCompetitorBrand("International")).toBe(true);
  });

  it("2026-08-29 한국어 확장 — 라틴 쪽과 같은 부류를 같은 기준으로 제외한다", () => {
    // 미러 전수 실측 상위(괄호 = 언급 수). 라틴 목록의 대응 항목을 옆에 적는다.
    expect(isNonCompetitorBrand("삼성전자")).toBe(true); // 468, cf. samsung
    expect(isNonCompetitorBrand("중고차 플랫폼")).toBe(true); // 79, cf. retailer
    expect(isNonCompetitorBrand("순정부품")).toBe(true); // 74, cf. original equipment manufacturer
    expect(isNonCompetitorBrand("캐피탈사")).toBe(true); // 39, cf. credit union
    expect(isNonCompetitorBrand("자동차리콜센터")).toBe(true); // 26
    expect(isNonCompetitorBrand("국토교통부")).toBe(true); // 22
    expect(isNonCompetitorBrand("보배드림")).toBe(true); // 10, cf. motor trend
    expect(isNonCompetitorBrand("사설 정비소")).toBe(true); // 3, cf. automotive repair shop
    expect(isNonCompetitorBrand("독일 자동차 브랜드")).toBe(true); // 3, cf. german luxury car brands
    expect(isNonCompetitorBrand("아우디 공식 딜러")).toBe(true); // 2, cf. local dealership
    expect(isNonCompetitorBrand("레카로")).toBe(true); // 2 (시트), cf. alcantara
    expect(isNonCompetitorBrand("요코하마")).toBe(true); // 1 (타이어), cf. event tires
    expect(isNonCompetitorBrand("말레이시아")).toBe(true); // 1, cf. canada/china/usa
    // 부분문자열 오탐 — 답변 원문 확인: "인포테인먼트" / "자동차세나 보험"
    expect(isNonCompetitorBrand("테인")).toBe(true); // 8
    expect(isNonCompetitorBrand("세나")).toBe(true); // 3
  });

  it("한국어 확장 후에도 진짜 경쟁 브랜드는 남는다 (라틴 가드의 대칭판)", () => {
    // ⚠️ 이 목록은 **자국어 표기가 알리아스 사전으로 접히는** 브랜드들이다.
    // 제외 목록에 잘못 넣으면 진짜 경쟁사 언급이 통째로 사라진다 —
    // 두 갈래의 구분 근거는 non-competitor-brands.ts "비라틴 표기 감사" 절.
    for (const b of [
      "테슬라", "루시드", "기아", "현대", "현대자동차", "제네시스", "폭스바겐",
      "메르세데스-벤츠", "마쓰다", "르노", "링컨", "미니", "대우", "링크앤코",
      "红旗", "奔驰", "宝马", "تويوتا", "نيسان", "هوندا", "هيونداي",
      "טויוטה", "זיקר", "מרצדס", "שברולט", "ב.מ.וו", "קיה",
      "KG 모빌리티", "엑스펑", "피닌파리나", "범한자동차", "싱어",
      // 판단 보류(c) — 제외하지 않기로 한 것들이 조용히 제외되면 이 가드가 깨진다
      "벤츠/BMW", "아우디코리아", "폭스바겐 그룹", "토요타 GR", "기아커넥트",
      "현대오토에버", "현대트랜시스", "튜익스",
    ]) {
      expect(isNonCompetitorBrand(b), b).toBe(false);
    }
  });

  it("한국어 노이즈는 하위 Product 를 갖지 않는다 → BARE_ONLY 불필요", () => {
    // 미러 전수 대조: (a) 29개 중 하위 Product 가 있는 것은 삼성전자 하나이고
    // 그 하위는 전부 비자동차(Galaxy·비스포크·SmartThings)라 제외가 옳다.
    // 이름을 확장한 하위가 없으므로 #120 의 되살리기 메커니즘은 걸 필요가 없다.
    expect(BARE_ONLY_NON_COMPETITOR_PATTERNS.some(([n]) => /[가-힣]/.test(n))).toBe(false);
    expect(isNonCompetitorMention("삼성전자", "Samsung Galaxy Z Flip")).toBe(true);
    expect(isNonCompetitorMention("삼성전자", "비스포크(BESPOKE)")).toBe(true);
  });

  it("확장 후에도 진짜 경쟁 브랜드는 남는다 (과잉 제외 회귀 가드)", () => {
    for (const b of [
      "Lexus", "Porsche", "BMW", "Mercedes-Benz", "Audi", "Toyota", "Honda",
      "Volkswagen", "Volvo", "Tesla", "Rivian", "Lucid", "BYD", "Ford",
      "Nissan", "Mazda", "Subaru", "Rolls-Royce", "Bentley", "MINI", "Škoda",
      "Renault", "Peugeot", "Polestar", "Genesis", "Hyundai", "Kia",
    ]) {
      expect(isNonCompetitorBrand(b), b).toBe(false);
    }
  });
});

// ── bare-only 제외 (2026-08-29) ──────────────────────────────────────────────
// 프로덕션 미러 실측(rollup 그룹 전수)을 회귀 가드로 고정한다.
describe("isNonCompetitorMention — bare 만 제외, 이름붙은 하위 제품은 살린다", () => {
  it("bare 표기는 여전히 제외된다 (노이즈 41,438 / 17,502 / 7,803 언급)", () => {
    expect(isNonCompetitorMention("Smart", "Smart")).toBe(true);
    expect(isNonCompetitorMention("Cruise", "Cruise")).toBe(true);
    expect(isNonCompetitorMention("International", "International")).toBe(true);
  });

  it("이름을 확장한 하위 제품은 살아난다 (진짜 브랜드 161 / 5 언급)", () => {
    // 미러 실측: Smart Fortwo 148 · Smart Fortwo EQ 8 · Smart EQ Fortwo 5
    expect(isNonCompetitorMention("Smart", "Smart Fortwo")).toBe(false);
    expect(isNonCompetitorMention("Smart", "Smart Fortwo EQ")).toBe(false);
    expect(isNonCompetitorMention("Smart", "Smart EQ Fortwo")).toBe(false);
    // 현행 smart 라인업 표기(#1/#3)도 경계 문자로 잡힌다
    expect(isNonCompetitorMention("Smart", "smart #1")).toBe(false);
    // 미러 실측: Cruise Origin 5
    expect(isNonCompetitorMention("Cruise", "Cruise Origin")).toBe(false);
  });

  it("이름을 확장하지 않는 오귀속 하위는 계속 제외된다", () => {
    // 미러 실측 — 이 rollup 들에 잘못 매달린 하위 Product 전수
    expect(isNonCompetitorMention("Smart", "Charge point")).toBe(true);
    expect(isNonCompetitorMention("Smart", "Fiat Avventura")).toBe(true);
    expect(isNonCompetitorMention("Smart", "Hyundai Venue N Line N10")).toBe(true);
    expect(isNonCompetitorMention("Cruise", "2nd gen")).toBe(true);
    // International 의 유일한 하위 — Navistar 제품이 아니라 경주장(오귀속) 109 언급
    expect(isNonCompetitorMention("International", "Mission Raceway Park")).toBe(true);
  });

  it("접두 부분일치는 살리지 않는다 (경계 문자 필수)", () => {
    expect(isNonCompetitorMention("Smart", "Smartphone")).toBe(true);
    expect(isNonCompetitorMention("Smart", "Smarter")).toBe(true);
    expect(isNonCompetitorMention("Cruise", "Cruiser")).toBe(true);
    expect(isNonCompetitorMention("International", "Internationale")).toBe(true);
  });

  it("bare-only 가 아닌 비경쟁 브랜드의 하위 제품은 계속 제외된다", () => {
    // 미러 실측: 같은 규칙을 전 목록에 걸면 되살아나는 것들 — 자동차 경쟁사가 아니다
    expect(isNonCompetitorMention("Google", "Google Maps")).toBe(true); // 372 언급
    expect(isNonCompetitorMention("Samsung", "Samsung Galaxy Z Fold")).toBe(true);
    expect(isNonCompetitorMention("Apple", "Apple iPhone SE")).toBe(true);
  });

  it("진짜 경쟁 브랜드는 rollup·하위 모두 통과한다", () => {
    expect(isNonCompetitorMention("Genesis", "Genesis GV80")).toBe(false);
    expect(isNonCompetitorMention("Hyundai", "Hyundai Ioniq 5")).toBe(false);
    expect(isNonCompetitorMention("Kia", "Kia EV9")).toBe(false);
  });

  it("ownName 을 안 주면 bare 판정과 동일 (하위 호환)", () => {
    expect(isNonCompetitorMention("Smart")).toBe(true);
    expect(isNonCompetitorMention("Kia")).toBe(false);
    expect(isNonCompetitorMention(null, "Smart Fortwo")).toBe(false);
  });

  it("SQL 쌍둥이 패턴 목록이 JS 판정과 같은 이름 집합을 덮는다", () => {
    // 목록을 하드코딩으로 고정하지 않는다 — 항목 추가가 곧 이 테스트의 실패가
    // 되어 버려, 2026-08-31 GEO-2 에서 14개를 넣자 main 이 깨졌다. 지켜야 할 것은
    // "무엇이 들어 있나"가 아니라 **아래 세 성질**이다: 비어 있지 않고, 항목이
    // 유일하며, 모두 제외 목록의 부분집합이고 패턴 형태가 SQL 쌍둥이와 같다.
    const names = BARE_ONLY_NON_COMPETITOR_PATTERNS.map(([n]) => n);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    // 창립 3개는 계약의 앵커로 남긴다 — 사라지면 그건 회귀다.
    expect(names).toEqual(expect.arrayContaining(["smart", "cruise", "international"]));
    for (const [name, pattern] of BARE_ONLY_NON_COMPETITOR_PATTERNS) {
      // 선행 트림 클래스(JS `.trim()` 쌍둥이) + 이름 + 경계 요구.
      expect(pattern).toBe(`^${POSIX_LEADING_TRIM}${name}[^[:alnum:]]`);
      // 그 이름은 반드시 제외 목록 안에 있어야 한다 (bare-only 는 제외의 부분집합)
      expect(isNonCompetitorBrand(name)).toBe(true);
    }
  });
});
