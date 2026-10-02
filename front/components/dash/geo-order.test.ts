import { describe, expect, it } from "vitest";
import { orderGeographyOptions } from "@/components/dash/dimension-filter-panel";

// 2026-09-04 고객 요청 (전 영역 공통): 국가 필터 최상단에 대한민국.
//   Global   → 대한민국이 목록 최상단
//   Website  → 월드와이드(글로벌) 아래 대한민국
//   Project  → 아시아·태평양 권역에서 대한민국이 오스트레일리아 위
// 세 요구가 한 규칙에서 나온다: 가상 코드 → 대한민국 → 나머지(원래 순서 유지).
// Project 의 "권역 안 최상단"이 성립하는 이유는 FacetedFilter 의 그룹이 **첫 등장
// 순서**로 쌓이기 때문이다 — 목록에서 KR 이 앞이면 그 권역이 먼저 오고 그 안에서도 맨 위다.
describe("orderGeographyOptions", () => {
  it("Global — 대한민국이 최상단", () => {
    expect(orderGeographyOptions(["AU", "CN", "JP", "KR", "US"])).toEqual([
      "KR", "AU", "CN", "JP", "US",
    ]);
  });

  it("Website — 가상 코드 다음이 대한민국", () => {
    expect(orderGeographyOptions(["AU", "KR", "US", "worldwide", "EU"])).toEqual([
      "worldwide", "EU", "KR", "AU", "US",
    ]);
  });

  it("Project — 대한민국이 오스트레일리아 위 (권역 그룹은 첫 등장 순서)", () => {
    const ordered = orderGeographyOptions(["AU", "JP", "KR", "TH"]);
    expect(ordered.indexOf("KR")).toBeLessThan(ordered.indexOf("AU"));
    expect(ordered[0]).toBe("KR");
  });

  it("나머지의 상대 순서는 바꾸지 않는다 (서버 정렬 유지)", () => {
    expect(orderGeographyOptions(["US", "DE", "AU"])).toEqual(["US", "DE", "AU"]);
  });

  it("대한민국이 없어도 안전하다", () => {
    expect(orderGeographyOptions(["US", "DE"])).toEqual(["US", "DE"]);
    expect(orderGeographyOptions([])).toEqual([]);
  });

  it("가상 코드끼리의 순서도 유지된다", () => {
    expect(orderGeographyOptions(["EU", "worldwide", "KR"])).toEqual([
      "EU", "worldwide", "KR",
    ]);
  });
});
