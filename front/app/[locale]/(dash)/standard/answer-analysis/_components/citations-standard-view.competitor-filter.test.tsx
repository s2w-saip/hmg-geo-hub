import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import { CitationsStandardView } from "./citations-standard-view";
import { standardVmFor } from "./citation-vm.fixture";

// GGMD "KPI 고도화 QA" #12 — "인용 화면에서 도메인 카테고리·경쟁사를 고른 뒤 적용이
// 되지 않는다(기존 필터와 함께 적용돼야 함)".
//
// 원인은 경쟁사 선택이 **클라이언트 state** 였다는 것 — 칩을 누르거나 필터를 적용해
// 서버 렌더가 한 번 돌면 다른 필터와 함께 실려 나가지 않았고, 하위 페이지 링크에도
// 안 붙었다. 이제 `?competitor=` URL 축이다. 이 파일은 URL → 화면 방향을 고정한다
// (seam prop 없이 URL 만으로 좁혀지는가).

vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation",
  // 기존 필터(?geography=KR)와 **함께** 걸린 상태.
  useSearchParams: () => new URLSearchParams("geography=KR&competitor=bmw.com"),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const LIVE: CitationsLive = {
  summary: { total: 1000, uniqueDomains: 40, officialOwnShare: 9.6 },
  asOf: "2026-09-01",
  domains: [
    { domain: "hyundai.com", citations: 96, share: 9.6, prompts: 30, coverageRate: 5, urls: [], promptList: [], isOurs: true, category: "Official (HMG)", subcategory: null },
    { domain: "bmw.com", citations: 50, share: 5, prompts: 20, coverageRate: 3, urls: [], promptList: [], isOurs: false, category: "Official (Competitor)", subcategory: null },
    { domain: "toyota.com", citations: 40, share: 4, prompts: 18, coverageRate: 2, urls: [], promptList: [], isOurs: false, category: "Official (Competitor)", subcategory: null },
    { domain: "jdpower.com", citations: 30, share: 3, prompts: 12, coverageRate: 2, urls: [], promptList: [], isOurs: false, category: "Automotive Media", subcategory: null },
  ],
  categories: [
    { name: "Official (HMG)", value: 96 },
    { name: "Official (Competitor)", value: 90 },
    { name: "Automotive Media", value: 30 },
  ],
  categoryTrend: null,
  engineCategories: null,
  trend: null,
  promptSplit: { ownedCount: 297, uncitedCount: 626 },
} as unknown as CitationsLive;

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("CitationsStandardView — 경쟁사 필터는 URL 축이다 (QA #12)", () => {
  const html = render(
    <CitationsStandardView data={LIVE} vm={standardVmFor(LIVE, { search: "geography=KR&competitor=bmw.com" })} typeChart={null} toneSummary={null} />,
  );

  it("?competitor= 로 좁힌 서버 vm 의 도메인 표를 그린다", () => {
    const tbody = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
    expect(tbody).toContain("bmw.com");
    expect(tbody).not.toContain("toyota.com");
    expect(tbody).toContain("jdpower.com"); // 다른 카테고리는 그대로
  });

  it("경쟁사 드롭다운 라벨이 선택을 반영한다", () => {
    expect(html).toContain("bmw.com");
  });

  it("하위 페이지 링크가 기존 필터와 경쟁사 선택을 함께 실어 나른다", () => {
    expect(html).toContain("geography=KR");
    expect(html).toContain("competitor=bmw.com");
  });
});
