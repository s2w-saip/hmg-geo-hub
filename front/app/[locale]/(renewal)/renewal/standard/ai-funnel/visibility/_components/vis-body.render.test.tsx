import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnVisBody as Body, VisTab } from "../_data/screen-types";
import fixture from "./vis-body.fixture.json";

// ════════════════════════════════════════════════════════════════════════════
// Renewal AI Visibility body — static render of every tab and state
// ════════════════════════════════════════════════════════════════════════════
// The fixture is the BFF's own output (back/bff/screens/visibility.py visibility_view over the
// reader answers of back/bff/tests/test_screens_visibility.py; test_front_fixture_is_current keeps
// it in step), so the page renders exactly the model the screen sends.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/ai-funnel/visibility",
  useSearchParams: () => new URLSearchParams(""),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { RnVisBody } = await import("./vis-body");
const { RnVisPageProvider, RnVisTabs } = await import("./vis-context");
const { tabOf } = await import("../_data/tab");

const body = fixture as unknown as Body;

function render(node: ReactNode, tab: VisTab = "sum"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnFilterRuntime>
        <RnOverviewFilters props={{ stage: "visibility", scope: { all: true } }} storageKey="test">
          <RnVisPageProvider initialTab={tab}>{node}</RnVisPageProvider>
        </RnOverviewFilters>
      </RnFilterRuntime>
    </NextIntlClientProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("RnVisBody", () => {
  it("요약: five metrics on the hero, the findings, the cards", () => {
    const html = render(<RnVisBody input={body} />);
    expect(count(html, "data-rn-kpi=")).toBe(5);
    expect(count(html, "data-rn-finding=")).toBe(body.view!.findings.length);
    expect(html).toContain("이 기간 요약");
    expect(html).toContain("우선순위 1 페이지 1개가 7일 넘게 AI 크롤 없음");
    expect(html).toContain("66.7"); // P1 coverage 2 / 3
    expect(html).toContain("AI 크롤 추이 · 엔진별");
    expect(html).toContain("우선순위별 몫");
    expect(html).toContain("AI 크롤 집중도");
    expect(html).toContain("기기별 검색 노출");
    // one page is incomplete: the notice says it is out of the sums
    expect(html).toContain("페이지 1개는 합계 · 비율에서 뺐습니다");
  });

  it("페이지 진단: the work list by 부족분, the scatter bands, the changes, the table", () => {
    const html = render(<RnVisBody input={body} />, "page");
    expect(html).toContain("AI 크롤 부족 페이지");
    // offers (prio 2, short ≈ 14.8) before ioniq-5 (prio 1, never read)
    expect(html.indexOf("/us/en/shopping-tools/offers")).toBeLessThan(html.indexOf("/us/en/vehicles/ioniq-5"));
    expect(html).toContain("기간 내 없음");
    expect(html).toContain("기대의 50% 미만");
    expect(html).toContain("읽기가 끊긴 페이지");
    expect(html).toContain("새로 읽힌 페이지");
    expect(html).toContain("전체 페이지");
    expect(html).toContain("AI 노출 보강");
  });

  it("AI 엔진 and 사이트 · 섹션", () => {
    const engine = render(<RnVisBody input={body} />, "engine");
    expect(count(engine, "data-rn-engine=")).toBe(2);
    expect(engine).toContain("ChatGPT");
    expect(engine).toContain("Gemini");
    expect(engine).toContain("페이지를 읽은 엔진 조합");
    expect(engine).toContain("ChatGPT만"); // two engines: a one-engine set reads "X만", not "Y 빼고 모두"
    const site = render(<RnVisBody input={body} />, "site");
    expect(site).toContain("사이트 벤치마크");
    expect(site).toContain("/shopping-tools");
    expect(site).toContain("/ (첫 페이지)");
  });

  it("states", () => {
    const base = { ...body, view: null };
    expect(render(<RnVisBody input={{ ...base, state: "nosite" }} />)).toContain("연결된 사이트가 없습니다");
    expect(render(<RnVisBody input={{ ...base, state: "empty" }} />)).toContain("AI 가시성 측정 대기");
    expect(render(<RnVisBody input={{ ...base, state: "down" }} />)).toContain("데이터를 불러오지 못했습니다");
    const nomatch = render(<RnVisBody input={{ ...base, state: "nomatch" }} />);
    expect(nomatch).toContain("이 조건에 해당하는 사이트가 없습니다");
    expect(nomatch).toContain("필터 초기화");
  });

  it("tab rail and ?view=", () => {
    const html = render(<RnVisTabs view={body.view} />, "engine");
    expect(count(html, "data-rn-tab=")).toBe(4);
    expect(html).toMatch(/data-rn-tab="engine"[^>]*aria-current="page"/);
    expect(html).toContain("?view=page");
    expect(tabOf("site")).toBe("site");
    expect(tabOf(["page"])).toBe("page");
    expect(tabOf("x")).toBe("sum");
    expect(tabOf(undefined)).toBe("sum");
  });
});
