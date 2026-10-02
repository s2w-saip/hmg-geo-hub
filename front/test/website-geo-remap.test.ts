import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 회귀 가드 — 웹사이트 표면의 지오 축 리맵(geography → websiteCountry)이
// 어느 한 경로에서만 빠지는 것을 막는다.
//
// 두 축은 이름만 비슷하고 값 공간이 다르다:
//   · website_sites.country_code = **사이트 국가**. 가상 코드를 갖는다
//     (worldwide · EU · MIDDLEEAST).
//   · scope_answers.region       = **측정 로케일**. 실 ISO 뿐이다.
// 실측(2026-09-04): Genesis `worldwide` 사이트의 답변 region 은 전부 KR/US 다.
// 그래서 리맵 없이 URL 의 ?geography 를 region 으로 흘리면 술어가 아무것도
// 매칭하지 못하고 화면이 조용히 빈다.
//
// 2026-09-04 고객 리포트: Website > Mention(제네시스·월드와이드)에서 답변
// 모달이 "본문이 아직 수집되지 않았습니다"만 띄웠다 — /api/scope/answer 만
// 이 리맵이 없어 getMirrorAnswerBody 의 IDOR 게이트가
// `region IN ('worldwide')` 로 전부 걸러낸 것이었다. 형제 드릴다운 API 3종은
// 처음부터 리맵을 하고 있었다.

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

// surface=website 를 받아 표준 필터를 해석하는 모든 BFF 라우트.
const WEBSITE_AWARE_ROUTES = [
  "app/api/scope/answer/route.ts",
  "app/api/scope/brand-citations/route.ts",
  "app/api/scope/brand-mention-prompts/route.ts",
  "app/api/scope/signal-prompts/route.ts",
];

// 서버 컴포넌트 쪽 정본 — 같은 리맵을 하는 페이지들.
const WEBSITE_PAGES = [
  "app/[locale]/(dash)/website/page.tsx",
  "app/[locale]/(dash)/website/answer-analysis/mention/page.tsx",
  "app/[locale]/(dash)/website/answer-analysis/citation/page.tsx",
];

describe("웹사이트 지오 축 리맵 (geography → websiteCountry)", () => {
  it.each(WEBSITE_AWARE_ROUTES)("%s 가 리맵한다", (rel) => {
    const src = read(rel);
    // surface=website 를 판정하고 있어야 하고
    expect(src).toContain('surface") === "website"');
    // region 을 websiteCountry 로 옮기고 region 은 비워야 한다.
    expect(src).toContain("websiteCountry: rawFilters.region");
    expect(src).toContain("region: undefined");
  });

  it.each(WEBSITE_PAGES)("%s 도 같은 리맵을 쓴다", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/websiteCountry: \w+\.region/);
    expect(src).toContain("region: undefined");
  });
});
