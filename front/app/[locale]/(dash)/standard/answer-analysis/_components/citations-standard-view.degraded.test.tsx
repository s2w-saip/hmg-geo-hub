import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import type { CitationSectionDegraded } from "../_data/citation-view";
import { CitationsStandardView } from "./citations-standard-view";

// 인용 집계가 `null` 일 때 화면이 두 사실을 구분하는가 (E-2 degrade-registry 연계).
//
//   ① 이 필터에 데이터가 없다        → "데이터 없음"
//   ② 집계가 예산에 걸려 못 끝냈다   → "시간 안에 끝나지 않았습니다 · 다른 수치는 정상"
//
// 값으로는 구분이 안 된다(둘 다 `null`) — 그래서 서버의 요청 스코프 표식
// `wasDegraded("standardCitations")` 을 `dataDegraded` 로 받아 분기한다. 종전에는
// ②를 ①로 오독해 "데이터 없음"을 띄웠고, 고객에게는 측정 실패로 보였다.

vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const EMPTY = ko.answerAnalysis.empty;
const DEGRADED = ko.answerAnalysis.mentions.kpi.degraded;

/**
 * 인용 **현황** 블록만 잘라 본다 — 같은 화면의 유형별 구성·우호도 블록도 입력이
 * null 이라 같은 문구를 내므로, 문서 전체에서 문자열을 세면 셋이 섞인다.
 * 경계는 그 블록의 도착 마커(`standard-citation:status`)다.
 */
function statusBlock(html: string): string {
  const end = html.indexOf('data-hmg-section-done="standard-citation:status"');
  expect(end, "인용 현황 블록의 마커를 못 찾았다").toBeGreaterThan(0);
  return html.slice(0, end);
}

function render(dataDegraded: boolean | undefined) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <CitationsStandardView
        data={null}
        prevSubKpis={null}
        prevBasisDate={null}
        typeCategories={null}
        toneSummary={null}
        dataDegraded={dataDegraded}
      />
    </NextIntlClientProvider>,
  );
}

describe("인용 현황 — 예산 초과를 '데이터 없음'으로 오독하지 않는다", () => {
  it("degrade 표식이 있으면 지연 안내를 띄운다", () => {
    const block = statusBlock(render(true));
    expect(block).toContain(DEGRADED);
    expect(block).not.toContain(EMPTY);
  });

  it("표식이 없으면 종전대로 '데이터 없음'", () => {
    const block = statusBlock(render(false));
    expect(block).toContain(EMPTY);
    expect(block).not.toContain(DEGRADED);
  });

  it("prop 자체가 없어도 종전 동작(데이터 없음)이 기본값이다", () => {
    const block = statusBlock(render(undefined));
    expect(block).toContain(EMPTY);
    expect(block).not.toContain(DEGRADED);
  });
});

// ── P6 B041: 보조 블록(추이·구성 추이·프롬프트 분할)의 일시 실패 ─────────────────
//
// API 원천에서 이 셋은 각자 degrade 라벨(standardCitations.trend·.categoryTrend·.split)로 null 이
// 된다. 종전에는 '준비 중'(추이)·블록 숨김(구성 추이)·'—' 비활성 타일(분할)로 보여 "데이터가
// 원래 없다"로 읽혔다. 페이지가 같은 요청 스코프 표식을 `sectionDegraded` 로 넘기면 그 자리에
// 기존 지연 안내(kpi.degraded)를 낸다. 표식이 없으면(정상·legacy) 마크업이 종전과 같다.

const PENDING = ko.answerAnalysis.pending;
const TREND_TITLE = ko.answerAnalysis.citations.trend.title;
const CATEGORY_TREND_TITLE = ko.answerAnalysis.citations.categoryTrend.title;
const OWNED_PROMPTS = ko.answerAnalysis.citations.v2.status.ownedPrompts;

const LIVE: CitationsLive = {
  summary: { total: 100, uniqueDomains: 2, officialOwnShare: 40 },
  asOf: "2026-09-21",
  domains: [
    { domain: "hyundai.com", citations: 40, share: 40, prompts: 3, coverageRate: 5, urls: [], promptList: [], isOurs: true, category: "Official (HMG)", subcategory: null },
    { domain: "jdpower.com", citations: 60, share: 60, prompts: 2, coverageRate: 4, urls: [], promptList: [], isOurs: false, category: "Automotive Media", subcategory: null },
  ],
  categories: [
    { name: "Official (HMG)", value: 40 },
    { name: "Automotive Media", value: 60 },
  ],
  trend: null,
  categoryTrend: null,
  engineCategories: null,
  promptSplit: null,
};

function renderLive(sectionDegraded: CitationSectionDegraded | null | undefined) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <CitationsStandardView data={LIVE} typeCategories={[]} toneSummary={null} dataDegraded={false} sectionDegraded={sectionDegraded} />
    </NextIntlClientProvider>,
  );
}

/** 블록 하나: 앞 블록 마커 뒤부터 이 블록 마커까지. */
function between(html: string, from: string | null, to: string): string {
  const start = from ? html.indexOf(`data-hmg-section-done="${from}"`) : 0;
  const end = html.indexOf(`data-hmg-section-done="${to}"`);
  expect(end, `${to} 마커를 못 찾았다`).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("인용 보조 블록 — 일시 실패는 '준비 중'·숨김이 아니라 지연 안내 (P6 B041)", () => {
  it("추이 실패: 도메인 블록의 추이 카드가 지연 안내", () => {
    const domains = between(renderLive({ trend: true }), "standard-citation:tone", "standard-citation:domains");
    expect(domains).toContain(TREND_TITLE);
    expect(domains).toContain(DEGRADED);
    expect(domains).not.toContain(PENDING);
  });

  it("구성 추이 실패: 숨기지 않고 카테고리 블록 안에 지연 안내", () => {
    const category = between(renderLive({ categoryTrend: true }), "standard-citation:status", "standard-citation:category");
    expect(category).toContain(CATEGORY_TREND_TITLE);
    expect(category).toContain(DEGRADED);
  });

  it("분할 실패: '—' 비활성 타일 대신 지연 안내(우호도 블록의 실패 문단과 같은 모양)", () => {
    const status = statusBlock(renderLive({ split: true }));
    expect(status).toContain(DEGRADED);
    expect(status).not.toContain(OWNED_PROMPTS);
    expect(status).not.toContain("data-link-tile-disabled");
  });

  it("표식이 없으면(정상·legacy) 종전 마크업 그대로: 추이 '준비 중', 구성 추이 숨김, 비활성 타일", () => {
    const html = renderLive(undefined);
    expect(renderLive(null)).toBe(html);
    expect(renderLive({ trend: false, categoryTrend: false, split: false })).toBe(html);
    expect(between(html, "standard-citation:tone", "standard-citation:domains")).toContain(PENDING);
    const category = between(html, "standard-citation:status", "standard-citation:category");
    expect(category).not.toContain(CATEGORY_TREND_TITLE);
    expect(category).not.toContain(DEGRADED);
    const status = statusBlock(html);
    expect(status).toContain(OWNED_PROMPTS);
    expect(status).toContain("data-link-tile-disabled");
    expect(status).not.toContain(DEGRADED);
  });
});
