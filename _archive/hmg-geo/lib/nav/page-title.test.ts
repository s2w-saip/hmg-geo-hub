import { describe, expect, it } from "vitest";
import { resolvePageTitleRef } from "./page-title";

// 웹사이트 라우트 키는 "website" 접두사를 떼어 표준 라벨로 착지하는 게 기본이다.
// 예외(자체 라벨)를 놓치면 존재하지 않는 nav 키로 매핑돼 탭 타이틀이 조용히
// 깨진다 — 화면은 정상으로 보이고 <title>만 원시 키가 되므로 눈에 안 띈다.
describe("resolvePageTitleRef — website 접두사 처리", () => {
  it("표준 트윈이 있는 웹사이트 라우트는 접두사를 떼고 공유 라벨로 간다", () => {
    expect(resolvePageTitleRef("/ko/website/answer-analysis/citation")).toEqual({
      namespace: "nav",
      key: "answerAnalysisCitation",
    });
    expect(resolvePageTitleRef("/ko/website/ai-funnel/conversion")).toEqual({
      namespace: "nav",
      key: "aiFunnelConversion",
    });
  });

  it("웹사이트 프롬프트는 자체 라벨을 유지한다 (nav.prompts 로 새지 않음)", () => {
    // 표준프롬프트(nav.standardPrompts)와 다른 카탈로그라 라벨을 공유하지 않는다.
    // 접두사를 떼면 nav.prompts — 사전에 없는 키다.
    expect(resolvePageTitleRef("/ko/website/prompts")).toEqual({
      namespace: "nav",
      key: "websitePrompts",
    });
  });

  it("/website 대시보드는 표준 Dashboard 라벨을 재사용한다 (접두사 제거 기본 경로)", () => {
    // websiteDashboard → 접두사 제거 → nav.dashboard. WEBSITE_SUB_ITEMS 가
    // /website 에 i18nKey "dashboard" 를 쓰는 것과 같은 의도 — 예외 목록에
    // 넣으면 안 되는 쪽의 대조군이다.
    expect(resolvePageTitleRef("/ko/website")).toEqual({
      namespace: "nav",
      key: "dashboard",
    });
  });

  it("/website/prompts 가 /website 로 흡수되지 않는다 (최장 매치)", () => {
    // 두 라우트 다 /website 로 시작한다 — 최단 매치면 프롬프트 탭이 대시보드
    // 라벨을 달게 된다.
    expect(resolvePageTitleRef("/ko/website/prompts").key).not.toBe("dashboard");
  });

  it("표준 프롬프트는 접두사 규칙과 무관하게 그대로다", () => {
    expect(resolvePageTitleRef("/en/standard/prompts")).toEqual({
      namespace: "nav",
      key: "standardPrompts",
    });
  });
});
