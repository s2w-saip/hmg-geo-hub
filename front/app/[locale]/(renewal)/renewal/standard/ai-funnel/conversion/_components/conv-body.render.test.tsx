import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnConvBody as Body } from "../_data/screen-types";
import fixture from "./conv-body.fixture.json";

// ════════════════════════════════════════════════════════════════════════════
// Renewal AI Conversion body — static render of the measured page and every state
// ════════════════════════════════════════════════════════════════════════════
// The fixture is the BFF's own output (back/bff/screens/conversion.py renewal over the real reader's answers
// in back/bff/tests/test_screens_conversion.py; test_front_fixture_is_current keeps it in step), so the page
// renders exactly the model the screen sends.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/ai-funnel/conversion",
  useSearchParams: () => new URLSearchParams(""),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { RnConvBody } = await import("./conv-body");

const body = fixture as unknown as Body;

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnFilterRuntime>
        <RnOverviewFilters props={{ stage: "conversion", scope: { all: true } }} savedFilters={{ page: "conversion", userId: "test", initial: [] }}>
          {node}
        </RnOverviewFilters>
      </RnFilterRuntime>
    </NextIntlClientProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("RnConvBody", () => {
  it("요약: six metrics on the hero and the findings", () => {
    const html = render(<RnConvBody input={body} />);
    expect(count(html, "data-rn-kpi=")).toBe(6);
    expect(count(html, "data-rn-finding=")).toBe(body.view!.findings.length);
    expect(html).toContain("이 기간 요약");
    expect(html).toContain("2026-10-12 ~ 2026-10-25 · 직전 14일 대비");
    // AI 7.5% vs 일반 4.7%: the gap is +2.8pp and AI converts better
    expect(html).toContain("7.5");
    expect(html).toContain("+2.8");
    expect(html).toContain("AI 유입이 일반보다 잘 전환합니다");
    expect(html).toContain("전환 27건 ÷ 사용자 360명");
    expect(html).toContain("AI 유입 전환율 7.5% — 일반 유입 4.7%보다 2.8pp 높음");
    expect(html).toContain("GA4 속성 3개 중 2개만 측정 중");
    expect(html).toContain("AI 유입 세션 ▲19.2% · 직전 14일 대비");
    expect(html).toContain("세션 100회당 전환은 Gemini 7.1건이 가장 높습니다(ChatGPT 6.5건).");
    expect(html).not.toContain("전환율과 격차를 계산하지 않습니다");
  });

  it("the cards: trend, engines, properties, landing pages, events", () => {
    const html = render(<RnConvBody input={body} />);
    expect(html).toContain("일별 AI 유입 · 전환");
    expect(html).toContain("일별 AI 유입 전환율");
    expect(count(html, "data-rn-engine=")).toBe(3);
    expect(html).toContain("Perplexity");
    // three properties, the waiting one last and out of the totals
    expect(count(html, "data-rn-prop=")).toBe(3);
    expect(html).toContain("측정 중 2 / 3");
    expect(html).toContain("권한 대기");
    expect(html).toContain("GA4 469542848 · 주요 이벤트 기준");
    expect(html).toContain("이탈리아 · Kia");
    // eight landing pages, all on the first screen (10 rows), the top one first
    expect(count(html, "data-rn-page=")).toBe(8);
    expect(html.indexOf("/it/<")).toBeLessThan(html.indexOf("/it/modelli/ev3/scopri/"));
    expect(html).not.toContain("개 더 보기");
    // tracked events first
    expect(html.indexOf("book_a_test_drive")).toBeLessThan(html.indexOf("page_view"));
    expect(html).toContain("전환 집계 이벤트 2개 · 454회");
    expect(html).toContain("측정 중인 GA4 속성 2개");
  });

  it("a user filter: no rates, the reason in the summary", () => {
    const view = body.view!;
    const filtered = { ...body, view: { ...view, filtered: true, totals: { ...view.totals, aiUsers: null, aiRate: null, genUsers: null, genRate: null, lift: null, perUser: null }, trend: { ...view.trend, rate: view.trend.rate.map(() => null) } } };
    const html = render(<RnConvBody input={filtered} />);
    expect(html).toContain("엔진 · 기기 · 방문자 유형 필터를 고르면");
    expect(html).toContain("전환율이 없어 계산하지 않습니다");
    expect(html).toContain("이 조건에서는 일별 사용자 수가 없어 전환율을 그리지 않습니다.");
  });

  it("states", () => {
    const base = { ...body, view: null };
    expect(render(<RnConvBody input={{ ...base, state: "noprop", properties: [] }} />)).toContain("연결된 GA4 속성이 없습니다");
    expect(render(<RnConvBody input={{ ...base, state: "down" }} />)).toContain("데이터를 불러오지 못했습니다");
    const pending = render(<RnConvBody input={{ ...base, state: "pending", properties: [{ id: "310000002", country: "FR", brand: "Hyundai", status: "pending_grant" }] }} />);
    expect(pending).toContain("GA4 속성 1개가 연결을 기다립니다");
    expect(pending).toContain("권한 대기");
    const empty = render(<RnConvBody input={{ ...base, state: "empty", period: { from: null, to: null, days: 28 } }} />);
    expect(empty).toContain("AI 유입 전환 측정 대기");
    expect(empty).toContain("측정 중인 GA4 속성 2개가 있지만 측정 데이터가 아직 없습니다");
    const nomatch = render(<RnConvBody input={{ ...base, state: "nomatch" }} />);
    expect(nomatch).toContain("이 조건에 해당하는 측정 데이터가 없습니다");
    expect(nomatch).toContain("필터 초기화");
  });
});
