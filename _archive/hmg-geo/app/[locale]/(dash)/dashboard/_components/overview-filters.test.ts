import { describe, it, expect } from "vitest";
import { overviewOnlyGroups } from "./overview-filters";

// 표준(글로벌) 대시보드의 language 축 노출 규칙 (2026-09-03).
// 종전 결함은 "onlyGroups 를 안 넘겨서 language 가 우연히 노출되고, 옵션은 정적
// 폴백 en/ko/fr 였다"였다 — 스코프와 무관한 목록이라 KR 계정에 프랑스어가 떴고
// 고르면 화면이 비었다. 이제 축 노출은 **실측 옵션 유무**에 종속된다.
// 근거: (내부 설계 문서) §2-A

describe("overviewOnlyGroups", () => {
  it("실측 언어가 있으면 language 축을 포함한다", () => {
    expect(overviewOnlyGroups(["ko", "en"])).toContain("language");
  });

  it("실측 언어가 없으면 language 축을 숨긴다", () => {
    expect(overviewOnlyGroups([])).not.toContain("language");
  });

  it("옵션 미전달(서버가 안 넘김)도 숨김 — 정적 폴백으로 새지 않는다", () => {
    expect(overviewOnlyGroups(undefined)).not.toContain("language");
  });

  it("숨길 때도 language 말고는 아무 축도 잃지 않는다", () => {
    const withLang = overviewOnlyGroups(["ko"]);
    const withoutLang = overviewOnlyGroups([]);
    expect(withoutLang).toEqual(withLang.filter((g) => g !== "language"));
  });

  // 2026-09-04 고객 검수: 기획에 없는 축이 대시보드 디멘션 행에 떠 있었다
  // (경쟁사 · 디바이스 · 신규/재방문 · 출처 카테고리). onlyGroups 를 안 넘겨
  // 패널 기본 ALL_GROUPS 가 그대로 노출된 것이 원인 — 목록을 명시로 되돌린다.
  it("기획 밖 축(경쟁사·디바이스·신규재방문·출처)은 노출하지 않는다", () => {
    const groups = overviewOnlyGroups(["ko"]);
    for (const g of ["competitor", "device", "visitorType", "source"]) {
      expect(groups).not.toContain(g);
    }
  });

  it("기대 축은 전부 포함한다 (국가·언어·엔진·기간 + 프롬프트 필터)", () => {
    const groups = overviewOnlyGroups(["ko"]);
    for (const g of ["geography", "language", "engine", "time", "promptContext"]) {
      expect(groups).toContain(g);
    }
  });
});
