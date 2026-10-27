import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import { CitationsStandardView } from "./citations-standard-view";
import { standardVmFor } from "./citation-vm.fixture";

// QA 2차 #5-(c) — "경쟁사 선택 시 출처 카테고리별 현황 공식(경쟁사)에 수치가
// 반영되지 않음". `?competitor=` 는 도메인 표(DomainsBlock)에만 전달됐다.
// 반영 범위 = 출처 카테고리별 현황 + 도메인 표 (제품 결정 D6), Δ 는 선택 중 숨김(D5).
// 값은 화면 API(back/bff/screens/citation.py)가 URL 의 선택으로 계산해 vm 으로 보낸다 — 이 파일은
// 그 vm(같은 규칙의 fixture)을 그리는 쪽을 고정한다.

let SEARCH = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(SEARCH),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const LIVE: CitationsLive = {
  summary: { total: 216, uniqueDomains: 4, officialOwnShare: 44.4 },
  asOf: "2026-09-01",
  domains: [
    { domain: "hyundai.com", citations: 96, share: 44.4, prompts: 30, coverageRate: 5, urls: [], promptList: [], isOurs: true, category: "Official (HMG)", subcategory: null },
    { domain: "bmw.com", citations: 50, share: 23.1, prompts: 20, coverageRate: 3, urls: [], promptList: [], isOurs: false, category: "Official (Competitor)", subcategory: null },
    { domain: "toyota.com", citations: 40, share: 18.5, prompts: 18, coverageRate: 2, urls: [], promptList: [], isOurs: false, category: "Official (Competitor)", subcategory: null },
    { domain: "jdpower.com", citations: 30, share: 13.9, prompts: 12, coverageRate: 2, urls: [], promptList: [], isOurs: false, category: "Automotive Media", subcategory: null },
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

const PREV = { totals: { total: 200, byCategory: { "Official (HMG)": 80, "Official (Competitor)": 80, "Automotive Media": 40 } }, asOf: "2026-08-25" } as never;

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

/** 출처 카테고리별 현황 섹션만 잘라낸다(섹션 도착 마커까지). */
function categorySection(html: string): string {
  const title = ko.answerAnalysis.citations.v2.categoryStatus.title;
  const from = html.indexOf(title);
  expect(from).toBeGreaterThan(-1);
  return html.slice(from, html.indexOf('data-hmg-section-done="standard-citation:category"'));
}

function view() {
  return render(
    <CitationsStandardView
      data={LIVE}
      vm={standardVmFor(LIVE, { search: SEARCH, prev: PREV })}
      typeChart={null}
      toneSummary={null}
    />,
  );
}

const COMP_LABEL = ko.citationCategories.officialCompetitor;
/** DeltaBadge 의 표기(`14.5pp`). 클래스명("recharts-wrapper")의 pp 와 헷갈리지 않게. */
const DELTA_PP = /\d+\.\dpp/;

/** 카테고리 막대 목록의 `<라벨> … <값>` 중 값만 뽑는다. */
function barValue(section: string, label: string): string {
  const i = section.indexOf(`>${label}</span>`);
  expect(i, `bar not rendered: ${label}`).toBeGreaterThan(-1);
  const m = section.slice(i).match(/tabular-nums text-foreground">([\d,]+)</);
  return m![1];
}

describe("출처 카테고리별 현황 × 경쟁사 선택", () => {
  it("선택 전에는 공식(경쟁사) 전량(90)과 Δ 배지가 보인다", () => {
    SEARCH = "";
    const s = categorySection(view());
    expect(barValue(s, COMP_LABEL)).toBe("90");
    expect(s).toMatch(DELTA_PP);
  });

  it("경쟁사 1개 선택 → 공식(경쟁사)가 그 도메인 인용 수(50)로 재계산된다", () => {
    SEARCH = "competitor=bmw.com";
    const s = categorySection(view());
    expect(barValue(s, COMP_LABEL)).toBe("50");
    // 다른 카테고리는 그대로.
    expect(barValue(s, ko.citationCategories.officialHmg)).toBe("96");
    expect(barValue(s, ko.citationCategories.automotiveMedia)).toBe("30");
  });

  it("경쟁사 2개 선택 → 두 도메인 인용 수의 합(90)", () => {
    SEARCH = "competitor=bmw.com~toyota.com";
    expect(barValue(categorySection(view()), COMP_LABEL)).toBe("90");
  });

  it("선택 중에는 카테고리 Δ 배지를 숨긴다 (제품 결정 D5 — 비교 기준이 다르다)", () => {
    SEARCH = "competitor=bmw.com";
    expect(categorySection(view())).not.toMatch(DELTA_PP);
  });

  it("반영 범위 안내 문구가 선택 중에만 뜬다 (제품 결정 D6)", () => {
    SEARCH = "competitor=bmw.com";
    expect(categorySection(view())).toContain(ko.answerAnalysis.citations.v2.competitor.scopeNote);
    SEARCH = "";
    expect(categorySection(view())).not.toContain(ko.answerAnalysis.citations.v2.competitor.scopeNote);
  });

  it("도메인 표는 종전대로 선택 도메인만 남는다 (회귀)", () => {
    SEARCH = "competitor=bmw.com";
    const html = view();
    const tbody = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
    expect(tbody).toContain("bmw.com");
    expect(tbody).not.toContain("toyota.com");
    expect(tbody).toContain("jdpower.com");
  });
});
