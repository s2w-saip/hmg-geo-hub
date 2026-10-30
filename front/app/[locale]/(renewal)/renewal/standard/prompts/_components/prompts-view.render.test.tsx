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
const { RnAuditHistory } = await import("./prompt-history");

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

const list = (page: PromptsPage = PAGE) =>
  wrap(
    <RnPromptsView
      remote={{ initial: page, load: async () => page }}
      scopeAll
      scopeRole="admin"
      scopeBrands={[]}
      scopeRegions={[]}
      scopeCountries={[]}
      period={null}
      history={HISTORY}
      initialTab="catalog"
      savedFilters={{ page: "prompts", userId: "test", initial: [] }}
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

// Renewal audit 13-1 · 13-2 (2026-10-31): brand presence and measurement kind are Gold's values only — an empty one
// shows '—' (no 포함 / 미포함 from the brand, no 단발 default), and the filter offers '값 없음' when the scope has one.
describe("renewal Global prompts: Gold's presence and kind only", () => {
  const empty = row("e", { presence: null, brandPresence: null, kind: null });
  const page = (facets: Record<string, string[]> = {}): PromptsPage => ({ ...PAGE, rows: [empty], total: 1, count: 1, rangeTo: 1, facets: { ...PAGE.facets, ...facets } });
  const open = (p: PromptsPage) =>
    wrap(
      <RnPromptsView
        remote={{ initial: p, load: async () => p }}
        scopeAll
        scopeRole="admin"
        scopeBrands={[]}
        scopeRegions={[]}
        scopeCountries={[]}
        period={null}
        history={HISTORY}
        initialTab="catalog"
        savedFilters={{ page: "prompts", userId: "test", initial: [] }}
        defaultOpen="all"
      />,
    );
  /** The option labels of one panel section, by its heading. */
  const section = (html: string, label: string) => {
    const at = html.indexOf(`>${label}</span>`);
    const part = html.slice(at, html.indexOf("</section>", at));
    return [...part.matchAll(/role="radio"[\s\S]*?<span[^>]*>[\s\S]*?<\/span><span[^>]*>([^<]*)<\/span>/g)].map(([, l]) => decode(l));
  };

  it("shows an empty presence and kind as '—'", () => {
    const r = rowOf(list(page()), "e");
    expect(r.cells[1]).toBe("Hyundai —");
    expect(r.cells[5]).toBe("— 측정중");
    expect(r.cells.join(" ")).not.toMatch(/포함|단발/);
  });

  it("says an empty kind is empty in the detail sheet", () => {
    const html = wrap(
      <RnToastProvider>
        <RnPromptDetail row={empty} taxonomy={() => []} marketLabel={(c) => c} onClose={() => {}} />
      </RnToastProvider>,
    );
    const fields = [...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/g)].map(([, k, v]) => `${strip(k)}: ${strip(v)}`);
    expect(fields).toContain("브랜드 포함 여부: —");
    expect(fields).toContain("측정 종류: —");
  });

  it("offers 값 없음 on presence and kind only when the scope has such a row", () => {
    const V = ko.standardPromptsView;
    const withNone = open(page({ presence: ["branded", "unbranded", "none"], kind: ["acr", "single", "none"] }));
    expect(section(withNone, V.presenceLabel)).toEqual(["전체", "브랜드 포함", "브랜드 미포함", "값 없음"]);
    expect(section(withNone, V.kindLabel)).toEqual(["전체", "ACR", "단발", "값 없음"]);
    const without = open(page({ presence: ["branded", "unbranded"], kind: ["acr", "single"] }));
    expect(section(without, V.presenceLabel)).toEqual(["전체", "브랜드 포함", "브랜드 미포함"]);
    expect(section(without, V.kindLabel)).toEqual(["전체", "ACR", "단발"]);
  });
});

// Renewal audit 13-3 (2026-10-31): the 열람 범위 pill opens the whole scope — brands, regions and every country the
// list keeps (the original's dropdown), with what the countries mean; the pill alone folds them into "N개국".
describe("renewal Global prompts: the scope pill", () => {
  const COUNTRIES = ["AE", "BH", "KW", "OM", "QA", "SA"];
  const scoped = (role: "region" | "country", countries: string[]) =>
    wrap(
      <RnPromptsView
        remote={{ initial: PAGE, load: async () => PAGE }}
        scopeAll={false}
        scopeRole={role}
        scopeBrands={["Genesis"]}
        scopeRegions={["genesis-middle-east"]}
        scopeCountries={countries}
        period={null}
        history={HISTORY}
        initialTab="catalog"
        savedFilters={{ page: "prompts", userId: "test", initial: [] }}
      />,
    );
  const dialog = (html: string) => {
    const at = html.indexOf('role="dialog"');
    return at < 0 ? "" : html.slice(at, html.indexOf("</p>", at));
  };

  it("lists every country of the scope behind the pill", () => {
    const html = scoped("region", COUNTRIES);
    expect(strip(html)).toMatch(/열람 범위 · Genesis · .+ · 6개국/);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-haspopup="dialog"/);
    const d = strip(dialog(html));
    for (const name of ["아랍에미리트", "바레인", "쿠웨이트", "오만", "카타르", "사우디아라비아"]) expect(d).toContain(name);
    expect(d).toContain(`${ko.standardPromptsView.scopeCountryLabel} (6)`);
    expect(d).toContain(ko.standardPromptsView.scopeMarketHintDetail);
  });

  it("keeps the administrator's pill a plain 전체", () => {
    const html = list();
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(strip(html)).toContain(`${ko.renewal.prompts.scopePill.replace("{scope}", ko.standardPromptsView.scopeAll)}`);
  });
});

// Gold metric review ⚠️ (2026-10-29, Global prompts #6 #9 #21 #37 #40): counts group their thousands, 미측정
// says what it is (no answer counted, whether or not answers were collected), a list emptied by the picks
// does not read as a scope problem, the sort offers no empty Depth axis, and a change history the source
// does not supply shows that notice alone.
describe("renewal Global prompts wording", () => {
  const P = ko.renewal.prompts;
  const V = ko.standardPromptsView;

  it("groups the thousands of the toolbar count and the pager", () => {
    const out = strip(list({ ...PAGE, total: 12164, count: 12164, pages: 244, rangeFrom: 1, rangeTo: 50 }));
    expect(out).toContain("표시 12,164 / 전체 12,164");
    expect(out).toContain("1–50 / 12,164");
    expect(out).not.toMatch(/12164/);
  });

  it("says 미측정 = no answer of the prompt counts toward the KPIs, in the list and the detail sheet", () => {
    const tips = [...rowOf(list(), "b").html.matchAll(/data-rn-tip="([^"]*)"/g)].map(([, v]) => decode(v));
    expect(tips).toContain(P.unmeasuredHint);
    expect(tips).not.toContain(V.statusUnmeasuredHint);
    const html = wrap(
      <RnToastProvider>
        <RnPromptDetail row={ROWS[1]} taxonomy={() => []} marketLabel={(c) => c} onClose={() => {}} />
      </RnToastProvider>,
    );
    const status = [...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/g)].map(([, k, v]) => `${strip(k)}: ${strip(v)}`).at(-1);
    expect(status).toBe(`${V.statusLabel}: ${V.statusUnmeasured} ${P.unmeasuredHint}`);
  });

  it("tells a list the picks emptied from a scope with no prompts", () => {
    const none: PromptsPage = { ...PAGE, rows: [], total: 0, rangeFrom: 0, rangeTo: 0 };
    expect(strip(list(none))).toContain(P.emptyFiltered);
    expect(strip(list(none))).not.toContain(V.empty);
    expect(strip(list({ ...none, count: 0 }))).toContain(V.empty);
  });

  it("offers no sort by a Depth the scope has no value for", () => {
    const sorts = (html: string) => {
      const select = html.match(new RegExp(`<select[^>]*aria-label="${P.sortLabel}"[^>]*>([\\s\\S]*?)</select>`))?.[1] ?? "";
      return [...select.matchAll(/<option value="([^"]+)"/g)].map(([, v]) => v);
    };
    expect(sorts(list())).toEqual(["text", "brand", "presence", "listType", "depth1", "depth2", "depth3", "funnel", "kind", "market", "lang", "status"]);
    expect(sorts(list({ ...PAGE, columns: ["listType", "depth1", "depth2", "depth3", "depth4"] }))).toContain("depth4");
  });

  it("shows the change history's source notice alone when the source supplies none", () => {
    const H = ko.promptAudit;
    const off = strip(wrap(<RnAuditHistory initial={{ available: false, shown: 0, groups: [] }} load={async () => ({ available: false, shown: 0, groups: [] })} />));
    expect(off).toContain(H.sourceUnavailable);
    for (const gone of [H.history.shownCount.replace("{count}", "0"), H.history.days90, H.history.exportCsv, H.history.sectionDescription]) expect(off).not.toContain(gone);
    const on = strip(wrap(<RnAuditHistory initial={HISTORY} load={async () => HISTORY} />));
    expect(on).toContain(H.history.shownCount.replace("{count}", "0"));
    expect(on).toContain(H.empty);
  });
});
