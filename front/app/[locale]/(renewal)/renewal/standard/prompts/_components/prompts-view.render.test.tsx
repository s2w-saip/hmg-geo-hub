import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { PromptRow, PromptsHistory, PromptsPage } from "@/app/[locale]/(dash)/standard/prompts/_data/screen-types";

// Renewal Global prompts list (2026-10-28, for a 1920×1050 window): one line per prompt, a column per
// attribute, cut-off cells tipped on hover; a row opens the detail sheet with everything it carries.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/prompts",
  useSearchParams: () => new URLSearchParams(),
}));

const { RnToastProvider } = await import("@/components/renewal-ui");
const { RnPromptsView } = await import("./prompts-view");
const { RnPromptDetail } = await import("./prompt-detail");

const row = (id: string, over: Partial<PromptRow> = {}): PromptRow => ({
  id,
  text: `prompt ${id}`,
  brand: "Hyundai",
  brandPresence: "branded",
  listType: "Brand Message",
  depth1: "1. Brand Image/key value",
  depth2: "Brand Awareness",
  depth3: "-",
  depth4: null,
  funnelStage: "인지/탐색",
  kind: "single",
  regions: ["ES", "MX", "US"],
  lang: "ko",
  scopePromptId: "s1",
  presence: "branded",
  common: false,
  markets: { real: ["ES", "MX", "US"], pseudo: [] },
  ...over,
});
const ROWS = [
  row("a"),
  row("b", {
    brand: null,
    common: true,
    presence: "unbranded",
    lang: "es",
    listType: "Strategic Model",
    depth1: null,
    depth2: null,
    depth3: null,
    funnelStage: null,
    kind: "acr",
    scopePromptId: null,
    regions: null,
    markets: { real: [], pseudo: [] },
  }),
];
const PAGE: PromptsPage = {
  rows: ROWS,
  total: ROWS.length,
  count: ROWS.length,
  offset: 0,
  limit: 50,
  page: 1,
  pages: 1,
  rangeFrom: 1,
  rangeTo: ROWS.length,
  facets: { listType: ["Brand Message", "Strategic Model"], depth1: ["1. Brand Image/key value"], depth2: ["Brand Awareness"], depth3: ["-"], depth4: [], funnel: ["인지/탐색"], market: ["ES", "MX", "US"], marketSort: ["ES", "MX", "US"], lang: ["es", "ko"] },
  columns: ["depth1", "depth2", "depth3"],
  collation: "ko",
};
const HISTORY: PromptsHistory = { available: true, shown: 0, groups: [] };

const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const list = () =>
  wrap(
    <RnPromptsView
      remote={{ initial: PAGE, load: async () => PAGE }}
      scopeAll
      scopeRole="admin"
      scopeBrands={[]}
      scopeRegions={[]}
      scopeCountries={[]}
      period={null}
      history={HISTORY}
      initialTab="catalog"
      storageKey="test"
    />,
  );
/** A row's cells as text, and its markup. */
function rowOf(html: string, id: string): { cells: string[]; html: string } {
  const from = html.indexOf(`data-rn-prompt-row="${id}"`);
  const part = html.slice(from, html.indexOf("</tr>", from));
  return { cells: [...part.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, c]) => strip(c)), html: part };
}

describe("renewal Global prompts list", () => {
  it("heads a column per attribute, sorted by Depth1 at first", () => {
    const html = list();
    const heads = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(([, h]) => strip(h));
    expect(heads).toEqual(["프롬프트", "브랜드", "퍼널", "분류", "대상 시장", "측정"]);
    expect(html).toMatch(new RegExp(`<th[^>]*aria-sort="ascending"[^>]*><button[^>]*><span[^>]*>${ko.renewal.prompts.columnTaxonomy}<`));
  });

  it("puts each attribute on one line in its column", () => {
    const html = list();
    expect(rowOf(html, "a").cells).toEqual(["ko prompt a", "Hyundai 포함", "인지/탐색", "1. Brand Image/key value › Brand Awareness", "스페인 +2", "단발 측정중"]);
    // no taxonomy below the list type: the list type; no market = 전체; ACR and 미측정 side by side
    expect(rowOf(html, "b").cells).toEqual(["es prompt b", "공통 미포함", "—", "Strategic Model", "전체", "ACR 미측정"]);
  });

  it("tips what a cell leaves out: every taxonomy level by name, every market, the long labels", () => {
    const a = rowOf(list(), "a").html;
    const tips = [...a.matchAll(/data-rn-tip="([^"]*)"/g)].map(([, v]) => decode(v)).filter(Boolean);
    expect(tips).toEqual(["한국어", "브랜드 포함", "리스트 유형: Brand Message\nDepth1: 1. Brand Image/key value\nDepth2: Brand Awareness", "스페인 · 멕시코 · 미국", "측정중"]);
  });
});

describe("prompt detail sheet", () => {
  it("shows the full text and every attribute of the row", () => {
    const html = wrap(
      <RnToastProvider>
        <RnPromptDetail
          row={ROWS[0]}
          taxonomy={(r) => [
            { label: "리스트 유형", value: r.listType },
            { label: "Depth1", value: r.depth1 },
            { label: "Depth3", value: null },
          ]}
          marketLabel={(c) => ({ ES: "스페인", MX: "멕시코", US: "미국" })[c] ?? c}
          onClose={() => {}}
        />
      </RnToastProvider>,
    );
    expect(html).toContain(">prompt a</p>");
    const fields = [...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/g)].map(([, k, v]) => `${strip(k)}: ${strip(v)}`);
    expect(fields).toEqual([
      "브랜드: Hyundai",
      "브랜드 포함 여부: 브랜드 포함",
      "언어: 한국어 (KO)",
      "리스트 유형: Brand Message",
      "Depth1: 1. Brand Image/key value",
      "Depth3: —",
      "퍼널: 인지/탐색",
      "대상 시장: 스페인 멕시코 미국",
      "측정 종류: 단발",
      "측정 상태: 측정중",
    ]);
  });
});
