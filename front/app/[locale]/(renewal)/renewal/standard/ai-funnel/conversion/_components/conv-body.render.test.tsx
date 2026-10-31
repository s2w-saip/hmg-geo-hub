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
  it("요약: six metrics on the hero, the site line and the findings", () => {
    const html = render(<RnConvBody input={body} />);
    expect(count(html, "data-rn-kpi=")).toBe(6);
    expect(count(html, "data-rn-finding=")).toBe(body.view!.findings.length);
    expect(html).toContain("이 기간 요약");
    expect(html).toContain("2026-10-12 ~ 2026-10-25 · 직전 14일 대비");
    // AI 7.5% vs 일반 4.7%: the gap is +2.8pp and AI converts better
    expect(html).toContain("7.5");
    expect(html).toContain("+2.8");
    expect(html).toContain("AI 유입 전환율이 일반보다 높습니다");
    expect(html).toContain("전환 27건 ÷ 사용자 360명");
    expect(html).toContain("AI 유입 전환율 7.5% — 일반 유입 4.7%보다 2.8pp 높음");
    expect(html).toContain("GA4 속성 3개 중 2개 측정 중");
    expect(html).toContain("AI 유입 세션 ▲19.2% · 직전 14일 대비");
    // the change finding names the conversions per 100 sessions of both periods, not a split (renewal audit 15, ⛔L)
    expect(html).toContain("AI 유입 전환 ▲35.0% · 세션 100회당 전환 5.5건 → 6.2건");
    expect(html).toContain("AI Assistant 채널: 채널 4개 중 세션 4위 (1.53%)");
    // 채널 합계 = the channel rows' own total; 사이트 전체 = GA4's totals report on the site line (renewal audit 12-2)
    expect(html).toContain("세션 100회당 주요 이벤트 4.8건 — 1위 · 채널 합계 1.6건");
    // the site line restores the original's page views
    expect(html).toContain('<b class="font-semibold text-white/90">사이트 전체</b>');
    expect(html).toContain("세션 28,434회");
    expect(html).toContain("페이지 조회 84,000회");
    expect(html).toContain("일반 유입 세션 100회당 전환 2.5건");
    expect(html).not.toContain("전환율과 격차를 계산하지 않습니다");
  });

  it("the trend: four charts, AI vs general rate, and a table of every day", () => {
    const html = render(<RnConvBody input={body} />);
    expect(html).toContain("일별 AI 유입 · 전환");
    expect(html).toContain("일별 전환율 — AI vs 일반");
    expect(html).toContain("일별 AI 세션 비중");
    expect(html).toContain('data-rn-seg="table"');
    expect(html).not.toContain("data-rn-trend-table");
  });

  it("channels: the AI row among GA4's channel groups, its ranks and the site total", () => {
    const html = render(<RnConvBody input={body} />);
    expect(count(html, "data-rn-channel=")).toBe(4);
    expect(html.indexOf('data-rn-channel="Organic Search"')).toBeLessThan(html.indexOf('data-rn-channel="AI Assistant"'));
    expect(html).toContain("AI Assistant는 채널 4개 중 세션 4위(1.53%) · 세션 100회당 주요 이벤트 1위(4.8건, 채널 합계 1.6건)");
    expect(html).toContain("data-rn-channel-total");
    expect(html).toMatch(/data-rn-channel-total=""[^>]*><b class="font-semibold">채널 합계<\/b>/);
    expect(html).toContain("28,434");
  });

  it("a missed collection day: the summary says which property and why the sums read '—' (renewal audit 12-1)", () => {
    const view = body.view!;
    const unknown = {
      ...view,
      missing: [{ id: "310000001", country: "DE", brand: "Hyundai", days: ["2026-10-20"] }],
      totals: { ...view.totals, aiSessions: null, aiConv: null, aiRate: null, genRate: null, lift: null, share: null, siteSessions: null, pageViews: null },
      channels: { ...view.channels, rows: view.channels.rows.map((r) => ({ ...r, sessions: null, share: null, keyEvents: null, per100: null, pps: null })),
        total: { sessions: null, keyEvents: null, per100: null, pps: null }, aiRank: { sessions: null, per100: null, pps: null, n: 4 } },
      findings: [],
    };
    const html = render(<RnConvBody input={{ ...body, view: unknown }} />);
    expect(html).toContain("GA4 속성 1개에 이 기간 수집되지 않은 날이 있습니다(독일 · Hyundai 1일)");
    expect(html).toContain("일부 날짜만의 합이 되므로 계산하지 않습니다");
    // the AI row is there, its values are unknown: not the engine-filter message
    expect(html).not.toContain("이 조건에서는 GA4 채널 보고서에 AI Assistant 행이 없습니다");
    expect(render(<RnConvBody input={body} />)).not.toContain("수집되지 않은 날이 있습니다");
  });

  // renewal audit 15 (⛔L, HUB rule 5): the two factors side by side; the split of the conversion change into a 유입 규모
  // part and a 세션당 전환 part took the previous period's rate as the base, a HUB choice
  it("the change card: AI sessions and conversions per 100 sessions of both periods, no split into parts", () => {
    const html = render(<RnConvBody input={body} />);
    expect(html).not.toContain("유입 규모");
    expect(count(html, "data-rn-step=")).toBe(0);
    expect(count(html, "data-rn-factor=")).toBe(3);
    expect(html).toContain("AI 유입 세션 ▲19.2% · 세션 100회당 전환 +0.7건 · AI 유입 전환 ▲35.0%");
    for (const v of ["364회", "434회", "+70회", "5.5건", "6.2건", "+0.7건", "20건", "27건", "+7건"]) expect(html).toContain(`>${v}<`);
    expect(html).toContain("AI 유입 세션 변화 +70회 — 엔진별");
    expect(count(html, "data-rn-share=")).toBe(3);
    expect(html).toContain("+42");
    const noPrev = render(<RnConvBody input={{ ...body, view: { ...body.view!, prevOk: false, factors: null } }} />);
    expect(noPrev).toContain("직전 같은 길이 기간의 데이터가 없어 비교하지 않습니다.");
  });

  it("segments: the device mix of AI vs general and conversions per 100 sessions", () => {
    const html = render(<RnConvBody input={body} />);
    expect(html).toContain("AI 유입의 모바일 비중 74% — 일반 유입 55%");
    expect(count(html, "data-rn-segment=")).toBe(2);
    expect(html).toContain("+19.2pp");
    expect(html).toContain('data-rn-seg="visitorType"');
  });

  it("the cards: engines, markets, landing pages with the same page's general sessions, events split AI · general", () => {
    const html = render(<RnConvBody input={body} />);
    expect(count(html, "data-rn-engine=")).toBe(3);
    expect(html).toContain("Perplexity");
    expect(html).toContain("세션당 페이지");
    // three markets, the waiting one last and out of the totals; Kia IT: AI 9.1% vs general 4.7%
    expect(count(html, "data-rn-prop=")).toBe(3);
    expect(html).toContain("측정 중 2 / 3");
    expect(html).toContain("권한 대기");
    expect(html).toContain("GA4 469542848 · 주요 이벤트 기준");
    expect(html).toContain("이탈리아 · Kia");
    expect(html).toContain("9.1%");
    expect(html).toContain("+4.5pp");
    // eight landing pages, all on the first screen (10 rows), the top one first, with its general sessions
    expect(count(html, "data-rn-page=")).toBe(8);
    expect(html.indexOf("/it/<")).toBeLessThan(html.indexOf("/it/modelli/ev3/scopri/"));
    expect(html).not.toContain("개 더 보기");
    expect(html).toContain("AI 유입 1위 입구 /it/: 이 페이지 세션의 0.7%가 AI 유입 · 세션 100회당 주요 이벤트 AI 12.5건 · 일반 0.5건");
    expect(html).toContain("16,800");
    // tracked events first, each split AI · general
    expect(html.indexOf("book_a_test_drive")).toBeLessThan(html.indexOf("page_view"));
    expect(html).toContain("전환 집계 이벤트 2개 · 454회");
    expect(html).toContain("AI 유입 6회 · 일반 유입 280회");
    expect(html).toContain("측정 중인 GA4 속성 2개");
  });

  it("the raw period users: folded, with every window counted", () => {
    const html = render(<RnConvBody input={body} />);
    expect(html).toContain("측정 원자료 · 기간 사용자 수");
    expect(html).toContain("60행");
    expect(html).toContain("펼치기");
    expect(count(html, "data-rn-window=")).toBe(0);
  });

  it("a user filter: no rates, the reason in the summary", () => {
    const view = body.view!;
    const filtered = {
      ...body,
      view: {
        ...view,
        filtered: true,
        totals: { ...view.totals, aiUsers: null, aiRate: null, genUsers: null, genRate: null, lift: null, perUser: null },
        trend: { ...view.trend, rate: view.trend.rate.map(() => null), genRate: view.trend.genRate.map(() => null) },
      },
    };
    const html = render(<RnConvBody input={filtered} />);
    expect(html).toContain("엔진 · 기기 · 방문자 유형 필터를 고르면");
    expect(html).toContain("전환율이 없어 계산하지 않습니다");
    expect(html).toContain("이 조건에서는 일별 사용자 수가 없어 전환율을 그리지 않습니다.");
  });

  it("an engine filter: the channel report has no AI row", () => {
    const view = body.view!;
    const rows = view.channels.rows.filter((r) => !r.ai);
    const html = render(<RnConvBody input={{ ...body, view: { ...view, channels: { ...view.channels, rows, aiRank: null } } }} />);
    expect(html).toContain("이 조건에서는 GA4 채널 보고서에 AI Assistant 행이 없습니다");
  });

  it("states", () => {
    const base = { ...body, view: null };
    expect(render(<RnConvBody input={{ ...base, state: "noprop", properties: [] }} />)).toContain("연결된 GA4 속성이 없습니다");
    expect(render(<RnConvBody input={{ ...base, state: "down" }} />)).toContain("데이터를 불러오지 못했습니다");
    const pending = render(<RnConvBody input={{ ...base, state: "pending", properties: [{ id: "310000002", country: "FR", brand: "Hyundai", status: "pending_grant" }, { id: "310000003", country: "JP", brand: "Hyundai", status: "unmapped" }] }} />);
    expect(pending).toContain("GA4 속성 2개가 아직 측정 중이 아닙니다");
    expect(pending).toContain("권한 대기");
    // a stopped property is the administrator's stop (the collector's unmapped), not a market without a link (12-3)
    expect(pending).toContain("수집 중지");
    expect(pending).not.toContain("시장 미연결");
    const empty = render(<RnConvBody input={{ ...base, state: "empty", period: { from: null, to: null, days: 28 } }} />);
    expect(empty).toContain("AI 유입 전환 측정 대기");
    expect(empty).toContain("측정 중인 GA4 속성 2개가 있지만 측정 데이터가 아직 없습니다");
    const nomatch = render(<RnConvBody input={{ ...base, state: "nomatch" }} />);
    expect(nomatch).toContain("이 조건에 해당하는 측정 데이터가 없습니다");
    // the country options are the GA4 properties' markets since W0, not the answer-measurement countries (12-4)
    expect(nomatch).toContain("국가 선택지는 계정이 읽을 수 있는 GA4 속성의 시장입니다");
    expect(nomatch).not.toContain("답변 측정 국가");
    expect(nomatch).toContain("필터 초기화");
  });
});
