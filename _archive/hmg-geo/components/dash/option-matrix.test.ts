import { describe, expect, it } from "vitest";
import {
  deriveMatrixOptions,
  type MeasuredScopeCombo,
} from "@/components/dash/dimension-filter-panel";

// 2026-09-04 고객 검수 — "권역을 고르면 화면마다 국가·언어가 다르다".
//
// 원인은 데이터가 아니라 **시점**이었다. 국가·언어 옵션은 서버가 *적용된* 필터로
// 좁혀 내려주는데 상위 축(브랜드·국가) 선택은 클라이언트 draft 라, 둘이 서로 다른
// 시점을 봤다. 프로덕션 실측이 두 증상을 그대로 설명한다:
//   · 측정 국가가 브랜드마다 다르다 — Hyundai 중동 = AE·SA / Kia 중동 = AE·IL.
//     브랜드를 draft 로 고르고 곧장 권역을 누르면 브랜드 미적용 시점 목록(AE·IL·SA)이 채워졌다.
//   · 태국만 적용된 상태에서 APAC 8개국을 draft 로 채워도 언어는 en·th 뿐이었다
//     (listMeasuredStandardLanguages(Hyundai, ["TH"]) = ["en","th"] 와 정확히 일치).
// 이제 두 축을 같은 draft 스냅샷에서 파생시킨다 — 이 함수가 그 규칙의 정본이다.
const M: MeasuredScopeCombo[] = [
  // 중동 — 브랜드마다 측정 국가가 다르다(실측 반영)
  { brand: "Hyundai", region: "AE", lang: "ar" },
  { brand: "Hyundai", region: "AE", lang: "en" },
  { brand: "Hyundai", region: "SA", lang: "ar" },
  { brand: "Kia", region: "AE", lang: "ar" },
  { brand: "Kia", region: "IL", lang: "he" },
  // APAC
  { brand: "Hyundai", region: "TH", lang: "th" },
  { brand: "Hyundai", region: "TH", lang: "en" },
  { brand: "Hyundai", region: "JP", lang: "ja" },
  { brand: "Hyundai", region: "KR", lang: "ko" },
  // 공통(브랜드 무관) 프롬프트 — 어느 브랜드에서도 남아야 한다
  { brand: null, region: "US", lang: "en" },
  // 언어 태그 없는 프롬프트 — 국가에는 기여, 언어에는 기여하지 않는다
  { brand: "Hyundai", region: "CN", lang: null },
];

describe("deriveMatrixOptions — 국가·언어를 같은 draft 에서 파생", () => {
  it("브랜드 미선택이면 전 브랜드의 국가·언어", () => {
    const { regions, languages } = deriveMatrixOptions(M, null, undefined);
    expect(regions).toEqual(["AE", "CN", "IL", "JP", "KR", "SA", "TH", "US"]);
    expect(languages).toEqual(["ar", "en", "he", "ja", "ko", "th"]);
  });

  it("브랜드를 고르면 그 브랜드가 측정한 국가만 — Kia 는 SA 가 없고 IL 이 있다", () => {
    expect(deriveMatrixOptions(M, ["Kia"], undefined).regions).toEqual(["AE", "IL", "US"]);
    expect(deriveMatrixOptions(M, ["Hyundai"], undefined).regions).toEqual([
      "AE", "CN", "JP", "KR", "SA", "TH", "US",
    ]);
  });

  it("공통(brand=null) 행은 어떤 브랜드 선택에서도 남는다", () => {
    expect(deriveMatrixOptions(M, ["Kia"], undefined).regions).toContain("US");
    expect(deriveMatrixOptions(M, ["Hyundai"], undefined).languages).toContain("en");
  });

  it("국가 draft 가 언어를 즉시 좁힌다 (적용을 기다리지 않는다)", () => {
    // 이 리포트의 증상: 태국만 잡혀 있으면 en·th
    expect(deriveMatrixOptions(M, ["Hyundai"], ["TH"]).languages).toEqual(["en", "th"]);
    // APAC 을 draft 로 채우면 즉시 넓어진다
    expect(deriveMatrixOptions(M, ["Hyundai"], ["TH", "JP", "KR"]).languages).toEqual([
      "en", "ja", "ko", "th",
    ]);
  });

  it("국가 draft 는 국가 옵션 자체를 좁히지 않는다 (자기 목록을 지우면 안 된다)", () => {
    expect(deriveMatrixOptions(M, ["Hyundai"], ["TH"]).regions).toEqual([
      "AE", "CN", "JP", "KR", "SA", "TH", "US",
    ]);
  });

  it("lang=null 행은 국가에만 기여한다 (죽은 언어 옵션 방지)", () => {
    const { regions, languages } = deriveMatrixOptions(M, ["Hyundai"], ["CN"]);
    expect(regions).toContain("CN");
    expect(languages).toEqual([]);
  });
});
