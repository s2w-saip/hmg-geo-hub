import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import { StandardPromptReadonlyList } from "./prompt-list-readonly";
import { collationOf, rereadAfterHydration } from "@/lib/standards/catalog-page";
import type { PromptRow, PromptsPage } from "../_data/screen-types";

// 대상 시장·언어·측정 상태 컬럼의 렌더 실측 (H4 수용 기준 1·2·3·5·6).
// 정적 검사가 아니라 실제 렌더러(react-dom/server)로 마크업을 뽑아 확인한다.
// 필터·정렬·페이지는 screen(catalog/prompts-page)이 정한다 — 그 규칙은
// back/bff/tests/test_screens_standard_prompts.py 가 지킨다.

function row(over: Partial<PromptRow>): PromptRow {
  return {
    id: "id-" + (over.text ?? "x"),
    text: "prompt text",
    brand: "Hyundai",
    brandPresence: "branded",
    listType: "Brand Message",
    depth1: "D1",
    depth2: null,
    depth3: null,
    depth4: null,
    funnelStage: "discovery",
    kind: "single",
    regions: null,
    lang: null,
    scopePromptId: "scope-1",
    presence: "branded",
    common: false,
    markets: { real: [], pseudo: [] },
    ...over,
  };
}

function page(rows: PromptRow[], over: Partial<PromptsPage> = {}): PromptsPage {
  return {
    rows,
    total: rows.length,
    count: rows.length,
    offset: 0,
    limit: 50,
    page: 1,
    pages: 1,
    rangeFrom: rows.length ? 1 : 0,
    rangeTo: rows.length,
    facets: { listType: ["Brand Message"], depth1: ["D1"], funnel: ["discovery"], market: ["CN", "KR", "x:WW"], marketSort: ["CN", "KR", "x:WW"], lang: ["EN", "KO", "ZH"] },
    columns: ["listType", "depth1"],
    collation: "ko",
    ...over,
  };
}

function render(rows: PromptRow[], locale: "ko" | "en") {
  const initial = page(rows);
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      <StandardPromptReadonlyList
        remote={{ initial, load: async () => initial, exportRows: async () => ({ rows, columns: initial.columns }) }}
        scopeAll
        scopeRole="admin"
        scopeBrands={[]}
        scopeRegions={[]}
        scopeCountries={[]}
      />
    </NextIntlClientProvider>,
  );
}

const ROWS: PromptRow[] = [
  row({ text: "ko row", lang: "KO", regions: ["KR"], markets: { real: ["KR"], pseudo: [] } }),
  row({ text: "ww row", lang: "EN", regions: ["x:WW"], markets: { real: [], pseudo: ["x:WW"] } }),
  row({ text: "unset row", lang: "EN", regions: null }),
  row({ text: "unmeasured row", lang: "ZH", regions: ["CN"], markets: { real: ["CN"], pseudo: [] }, scopePromptId: null }),
  row({
    text: "many row",
    lang: "EN",
    regions: ["US", "GB", "DE", "FR", "IT", "x:NBRAND"],
    markets: { real: ["DE", "FR", "GB", "IT", "US"], pseudo: ["x:NBRAND"] },
  }),
];

describe("StandardPromptReadonlyList — 시장·언어·상태 렌더", () => {
  it("KO 행이 KR 단일 배지(국가명)로 렌더된다 — ko", () => {
    const html = render([ROWS[0]], "ko");
    expect(html).toContain("대한민국");
    expect(html).toContain(ko.standardPromptsView.marketLabel);
    expect(html).toContain(ko.standardPromptsView.langLabel);
    // 언어 컬럼은 로케일 언어명으로 — 코드 그대로 노출하지 않는다.
    expect(html).toContain("한국어");
  });

  it("x:WW 행은 의사코드 라벨 + 점선 outline 배지로 실국가와 구분된다", () => {
    const html = render([ROWS[1]], "ko");
    expect(html).toContain(ko.dashboard.filters.value.pseudoWorldwide);
    expect(html).toContain("border-dashed");
    // 실국가 배지(solid=secondary)와 다른 variant 여야 한다.
    expect(html).toContain('data-variant="outline"');
  });

  it("시장 미지정 행은 빈칸이 아니라 '전체' 배지", () => {
    expect(render([ROWS[2]], "ko")).toContain(ko.standardPromptsView.marketAll);
    expect(render([ROWS[2]], "en")).toContain(en.standardPromptsView.marketAll);
  });

  it("scope 링크 없는 행은 '미측정' 상태 배지로 보인다 (D15 게이트 해제)", () => {
    const html = render([ROWS[3]], "ko");
    expect(html).toContain(ko.standardPromptsView.statusUnmeasured);
    expect(html).toContain("중국"); // ZH 행의 대상 시장 CN — ko 로케일 국가명
  });

  it("배지가 많은 행은 **실국가만** 접히고 의사코드는 남는다", () => {
    // 접기를 배열 순서대로 하면 실국가가 많은 행에서 의사코드가 통째로 `+N` 뒤로
    // 숨는다(2026-08-29 렌더 실측 회귀). 실국가 5 + 의사코드 1 → 실국가 3 표시 / 2 접힘.
    const html = render([ROWS[4]], "ko");
    expect(html).toContain("+2");
    expect(html).not.toContain("이탈리아");
    expect(html).toContain(ko.dashboard.filters.value.pseudoNBrand);
  });

  it("실국가가 10개여도 의사코드 4종이 전부 보인다 (14-region 실표본 형태)", () => {
    const html = render(
      [
        row({
          text: "real 10 + pseudo 4",
          lang: "EN",
          markets: { real: ["AU", "CA", "GB", "ID", "IN", "MY", "PH", "SA", "TH", "US"], pseudo: ["x:EU", "x:ME", "x:NBRAND", "x:WW"] },
        }),
      ],
      "ko",
    );
    expect(html).toContain("+7"); // 실국가 10 중 3 표시 → 7 접힘
    for (const key of ["pseudoEuRegion", "pseudoMiddleEast", "pseudoNBrand", "pseudoWorldwide"] as const) {
      expect(html).toContain(ko.dashboard.filters.value[key]);
    }
  });

  it("공통(브랜드 없음·엄브렐러) 행과 브랜드 노출 배지는 서버 판정대로 그린다", () => {
    const html = render([row({ text: "common row", brand: "HMG", common: true, presence: "unbranded" })], "ko");
    expect(html).toContain(ko.standardPromptsView.common);
    expect(html).toContain(ko.dashboard.filters.value.unbranded);
  });

  it("3축 필터(시장·언어·상태) 컨트롤이 렌더된다", () => {
    const html = render(ROWS, "ko");
    expect(html).toContain('id="sp-view-market"');
    expect(html).toContain('id="sp-view-lang"');
    expect(html).toContain('id="sp-view-status"');
  });

  it("en 로케일에서도 전 컬럼이 렌더된다", () => {
    const html = render(ROWS, "en");
    expect(html).toContain(en.standardPromptsView.marketLabel);
    expect(html).toContain(en.standardPromptsView.langLabel);
    expect(html).toContain(en.standardPromptsView.statusLabel);
    expect(html).toContain(en.standardPromptsView.statusUnmeasured);
    expect(html).toContain("South Korea");
    expect(html).toContain(en.dashboard.filters.value.pseudoWorldwide);
  });

  it("페이지 라벨은 서버가 읽은 페이지 그대로", () => {
    const rows = [row({ text: "r1" })];
    const initial = page(rows, { total: 120, page: 3, pages: 3, offset: 100, rangeFrom: 101, rangeTo: 120 });
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <StandardPromptReadonlyList remote={{ initial, load: async () => initial, exportRows: async () => ({ rows, columns: [] }) }}
          scopeAll scopeRole="admin" scopeBrands={[]} scopeRegions={[]} scopeCountries={[]} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain("101");
    expect(html).toContain("120");
  });
});

describe("remote first page — server render order (B077)", () => {
  // The server render reads with the browser's collation (Accept-Language). Korean ICU puts Hangul
  // before Latin, English ICU the other way round: the first render must already be the order the
  // former hydration re-read (collation ko) produced, and no re-read is needed.
  const texts = ["b row", "가 행", "a row", "나 행"];
  const koOrder = [...texts].sort(new Intl.Collator("ko").compare);
  const enOrder = [...texts].sort(new Intl.Collator("en").compare);
  function renderRemote(initial: PromptsPage) {
    const load = vi.fn(), exportRows = vi.fn();
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <StandardPromptReadonlyList remote={{ initial, load, exportRows }}
          scopeAll scopeRole="admin" scopeBrands={[]} scopeRegions={[]} scopeCountries={[]} />
      </NextIntlClientProvider>,
    );
    return { html, load };
  }
  const ordered = (order: string[], collation: "ko" | "en") => page(order.map((text) => row({ text })), { collation });
  const shown = (html: string) => texts.map((t) => [t, html.indexOf(t)] as const).sort((a, b) => a[1] - b[1]).map(([t]) => t);

  it("a Korean browser: the first render is the Korean ICU order and it is not read again", () => {
    expect(koOrder).not.toEqual(enOrder);
    const { html, load } = renderRemote(ordered(koOrder, "ko"));
    expect(shown(html)).toEqual(koOrder);
    expect(load).not.toHaveBeenCalled();
    expect(rereadAfterHydration({ collation: "ko" }, collationOf("ko-KR"))).toBe(false);
  });

  it("a browser other than the request's language still re-reads (the final order is the browser's, as before)", () => {
    const { html } = renderRemote(ordered(enOrder, "en"));
    expect(shown(html)).toEqual(enOrder);
    expect(rereadAfterHydration({ collation: "en" }, collationOf("ko-KR"))).toBe(true);
    expect(rereadAfterHydration({ collation: "en" }, collationOf("en-US"))).toBe(false);
  });
});
