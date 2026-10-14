import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import {
  StandardPromptReadonlyList,
  filterRows,
  EMPTY_FILTER,
  STATUS_MEASURED,
  STATUS_UNMEASURED,
  type FilterState,
  type StandardPromptViewRow,
} from "./prompt-list-readonly";
import { collationOf, rereadAfterHydration, type CatalogPage } from "@/lib/standards/catalog-page";

// 대상 시장·언어·측정 상태 컬럼의 렌더 실측 (H4 수용 기준 1·2·3·5·6).
// 정적 검사가 아니라 실제 렌더러(react-dom/server)로 마크업을 뽑아 확인한다.

function row(over: Partial<StandardPromptViewRow>): StandardPromptViewRow {
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
    ...over,
  };
}

function render(rows: StandardPromptViewRow[], locale: "ko" | "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <StandardPromptReadonlyList
        rows={rows}
        scopeAll
        scopeRole="admin"
        scopeBrands={[]}
        scopeRegions={[]}
        scopeCountries={[]}
      />
    </NextIntlClientProvider>,
  );
}

const ROWS: StandardPromptViewRow[] = [
  row({ text: "ko row", lang: "KO", regions: ["KR"] }),
  row({ text: "ww row", lang: "EN", regions: ["x:WW"] }),
  row({ text: "unset row", lang: "EN", regions: null }),
  row({ text: "unmeasured row", lang: "ZH", regions: ["CN"], scopePromptId: null }),
  row({
    text: "many row",
    lang: "EN",
    regions: ["US", "GB", "DE", "FR", "IT", "x:NBRAND"],
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

  it("regions 미지정 행은 빈칸이 아니라 '전체' 배지", () => {
    const html = render([ROWS[2]], "ko");
    expect(html).toContain(ko.standardPromptsView.marketAll);
    const en_html = render([ROWS[2]], "en");
    expect(en_html).toContain(en.standardPromptsView.marketAll);
  });

  it("scope 링크 없는 행은 '미측정' 상태 배지로 보인다 (D15 게이트 해제)", () => {
    const html = render([ROWS[3]], "ko");
    expect(html).toContain(ko.standardPromptsView.statusUnmeasured);
    expect(html).toContain("중국"); // ZH 행의 대상 시장 CN — ko 로케일 국가명
  });

  it("배지가 많은 행은 **실국가만** 접히고 의사코드는 남는다", () => {
    // 2026-08-29 렌더 실측 회귀: 접기를 배열 순서대로 하면 실국가가 많은 행에서
    // 의사코드가 통째로 `+N` 뒤로 숨어 D4("별도 배지로 구분 표시")가 정작 구분할
    // 대상 없이 무력화된다. 실국가 5 + 의사코드 1 → 실국가 3 표시 / 2 접힘.
    const html = render([ROWS[4]], "ko");
    expect(html).toContain("+2");
    // 접힌 것은 실국가뿐 — 셀에 5개가 다 나열되지 않는다.
    expect(html).not.toContain("이탈리아");
    // 의사코드는 실국가가 접혔어도 살아 있어야 한다.
    expect(html).toContain(ko.dashboard.filters.value.pseudoNBrand);
  });

  it("실국가가 10개여도 의사코드 4종이 전부 보인다 (14-region 실표본 형태)", () => {
    // 운영 DB 실표본(EN, regions 14개)의 형태 그대로. 수정 전에는 이 행이
    // "오스트레일리아·캐나다·영국 +11" 로만 보였다.
    const html = render(
      [
        row({
          text: "real 10 + pseudo 4",
          lang: "EN",
          regions: ["AU", "CA", "GB", "ID", "IN", "MY", "PH", "SA", "TH", "US",
                    "x:EU", "x:ME", "x:NBRAND", "x:WW"],
        }),
      ],
      "ko",
    );
    expect(html).toContain("+7"); // 실국가 10 중 3 표시 → 7 접힘
    for (const key of ["pseudoEuRegion", "pseudoMiddleEast", "pseudoNBrand", "pseudoWorldwide"] as const) {
      expect(html).toContain(ko.dashboard.filters.value[key]);
    }
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
});

describe("filterRows — 시장·언어·상태 3축 필터 (수용 기준 4)", () => {
  const F = (over: Partial<FilterState>): FilterState => ({ ...EMPTY_FILTER, ...over });

  it("기본값(전체)은 아무 행도 떨어뜨리지 않는다 — 미측정 행 포함", () => {
    expect(filterRows(ROWS, EMPTY_FILTER, "")).toHaveLength(ROWS.length);
  });

  it("시장 축: 실국가·의사코드 둘 다 걸린다. 미지정 행은 특정 시장에 안 걸린다", () => {
    expect(filterRows(ROWS, F({ market: "KR" }), "").map((r) => r.text)).toEqual(["ko row"]);
    expect(filterRows(ROWS, F({ market: "x:WW" }), "").map((r) => r.text)).toEqual(["ww row"]);
    expect(filterRows(ROWS, F({ market: "US" }), "").map((r) => r.text)).toEqual(["many row"]);
  });

  it("언어 축: lang distinct 로 좁힌다", () => {
    expect(filterRows(ROWS, F({ lang: "EN" }), "").map((r) => r.text)).toEqual([
      "ww row",
      "unset row",
      "many row",
    ]);
    expect(filterRows(ROWS, F({ lang: "ZH" }), "").map((r) => r.text)).toEqual([
      "unmeasured row",
    ]);
  });

  it("상태 축: 측정중 / 미측정 이 상보적으로 갈린다", () => {
    const measured = filterRows(ROWS, F({ status: STATUS_MEASURED }), "");
    const unmeasured = filterRows(ROWS, F({ status: STATUS_UNMEASURED }), "");
    expect(unmeasured.map((r) => r.text)).toEqual(["unmeasured row"]);
    expect(measured.length + unmeasured.length).toBe(ROWS.length);
    expect(measured.every((r) => r.scopePromptId !== null)).toBe(true);
  });

  it("3축은 AND 로 겹친다", () => {
    expect(
      filterRows(ROWS, F({ market: "CN", lang: "ZH", status: STATUS_UNMEASURED }), "").map(
        (r) => r.text,
      ),
    ).toEqual(["unmeasured row"]);
    expect(
      filterRows(ROWS, F({ market: "CN", status: STATUS_MEASURED }), ""),
    ).toHaveLength(0);
  });
});

describe("remote first page — server render order (B077)", () => {
  // The server render reads with the browser's collation (Accept-Language). Korean ICU puts Hangul
  // before Latin, English ICU the other way round: the first render must already be the order the
  // former hydration re-read (collation ko) produced, and no re-read is needed.
  const texts = ["b row", "가 행", "a row", "나 행"];
  const koOrder = [...texts].sort(new Intl.Collator("ko").compare);
  const enOrder = [...texts].sort(new Intl.Collator("en").compare);
  const page = (order: string[], collation: "ko" | "en"): CatalogPage => ({
    rows: order.map((text) => ({ ...row({ text }), id: `id-${text}` })) as unknown as CatalogPage["rows"],
    total: order.length, count: order.length, offset: 0, limit: 50, facets: {}, columns: [], collation,
  });
  function renderRemote(initial: CatalogPage) {
    const load = vi.fn(), rows = vi.fn();
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <StandardPromptReadonlyList rows={initial.rows as unknown as StandardPromptViewRow[]} remote={{ initial, load, rows }}
          scopeAll scopeRole="admin" scopeBrands={[]} scopeRegions={[]} scopeCountries={[]} />
      </NextIntlClientProvider>,
    );
    return { html, load, rows };
  }
  const shown = (html: string) => texts.map((t) => [t, html.indexOf(t)] as const).sort((a, b) => a[1] - b[1]).map(([t]) => t);

  it("a Korean browser: the first render is the Korean ICU order and it is not read again", () => {
    expect(koOrder).not.toEqual(enOrder);
    const { html, load, rows } = renderRemote(page(koOrder, "ko"));
    expect(shown(html)).toEqual(koOrder);
    expect(load).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
    expect(rereadAfterHydration({ collation: "ko" }, collationOf("ko-KR"))).toBe(false);
  });

  it("a browser other than the request's language still re-reads (the final order is the browser's, as before)", () => {
    const { html } = renderRemote(page(enOrder, "en"));
    expect(shown(html)).toEqual(enOrder);
    expect(rereadAfterHydration({ collation: "en" }, collationOf("ko-KR"))).toBe(true);
    expect(rereadAfterHydration({ collation: "en" }, collationOf("en-US"))).toBe(false);
  });
});
