import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationDomainLive, CitationsLive } from "@/lib/scope/result-adapter";

// ════════════════════════════════════════════════════════════════════════════
// Renewal Citation body — static render of the states the local api demo cannot show
// ════════════════════════════════════════════════════════════════════════════
// Every read is a settled promise (React's use() reads it synchronously), so the whole body
// renders in one pass. The renewal model comes precomputed from the screen (rn); the fixture builds
// it with the same rules from the parts below and the page URL (citation-rn.fixture.ts): prompt tiles with counts and links, the legacy "not computed" reason under
// a 출처 filter, a competitor pick, one picked 출처 (counts in the matrix), the empty / delayed states.

let SEARCH = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(SEARCH),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { RnCitationBody } = await import("./citation-body");
const { rnVmFor } = await import("./citation-rn.fixture");
type Input = import("./citation-input").RnCitationInput;

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });

const HMG = "Official (HMG)";
const COMP = "Official (Competitor)";
const AUTO = "Automotive Media";
const NEWS = "News & Media";
const dom = (domain: string, category: string, citations: number, isOurs = false): CitationDomainLive => ({
  domain,
  category,
  citations,
  share: citations / 10,
  prompts: Math.round(citations / 9),
  coverageRate: citations / 20,
  urls: [{ url: `https://${domain}/a`, title: domain, count: 3, aiProvider: "chatgpt", promptText: "best SUV" }],
  promptList: [],
  isOurs,
  subcategory: null,
});
const weeks = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
const live = (over: Partial<CitationsLive> = {}): CitationsLive => ({
  summary: { total: 1000, uniqueDomains: 9 },
  asOf: "2026-10-12T09:00:00.000Z",
  domains: [dom("caranddriver.com", AUTO, 200), dom("hyundai.com", HMG, 150, true), dom("motortrend.com", AUTO, 100), dom("toyota.com", COMP, 80), dom("reuters.com", NEWS, 60), dom("kia.com", HMG, 50, true), dom("tesla.com", COMP, 40)],
  categories: [
    { name: AUTO, value: 400 },
    { name: HMG, value: 250 },
    { name: COMP, value: 150 },
    { name: NEWS, value: 200 },
  ],
  trend: { series: ["caranddriver.com", "hyundai.com", "motortrend.com", "toyota.com"], points: weeks.map((week, i) => ({ week, "caranddriver.com": 50 + i, "hyundai.com": 30 + i * 6, "motortrend.com": 45 - i * 4, "toyota.com": 20 + i })) },
  categoryTrend: { series: [AUTO, NEWS, HMG, COMP], points: weeks.map((week, i) => ({ week, [AUTO]: 100 + i, [NEWS]: 50, [HMG]: 60 + i * 2, [COMP]: 40 })) },
  engineCategories: [
    { engine: "chatgpt", total: 400, byCategory: { [AUTO]: 200, [HMG]: 60, [COMP]: 60, [NEWS]: 80 } },
    { engine: "gemini", total: 600, byCategory: { [AUTO]: 200, [HMG]: 190, [COMP]: 90, [NEWS]: 120 } },
  ],
  promptSplit: { owned: [], uncited: [], ownedCount: 57, uncitedCount: 39 },
  ...over,
});
const parts = (over: Partial<Parts> = {}, liveOver: Partial<CitationsLive> = {}): Parts => ({
  api: false,
  filtered: false,
  data: live(liveOver),
  dataDegraded: false,
  officialDelta: { delta: -1.4, basisDate: "2026-10-05" },
  prevCategories: { totals: { total: 1000, byCategory: { [AUTO]: 380, [HMG]: 270, [COMP]: 150, [NEWS]: 200 } }, asOf: "2026-10-05" },
  typeCategories: [
    { type: "mention", total: 500, byCategory: { [AUTO]: 200, [HMG]: 150, [NEWS]: 150 } },
    { type: "recommendation", total: 200, byCategory: { [AUTO]: 120, [HMG]: 30, [NEWS]: 50 } },
  ],
  ...over,
});
type Parts = {
  api: boolean;
  filtered: boolean;
  data: CitationsLive | null;
  dataDegraded: boolean;
  officialDelta: { delta: number; basisDate: string } | null;
  prevCategories: { totals: { total: number; byCategory: Record<string, number> }; asOf: string };
  typeCategories: import("@/lib/db/repositories/scope-aggregates").CitationTypeCategoryRow[] | null;
};
const input = parts;
const render = (p: Parts, search = "") => {
  SEARCH = search;
  const i: Input = {
    api: p.api,
    period: null,
    filtered: p.filtered,
    data: settled(p.data),
    dataDegraded: settled(p.dataDegraded),
    sectionDegraded: settled(null),
    prevCategories: settled(p.prevCategories),
    toneSummary: settled({ positive: { urls: 120, citations: 300, answers: 90 }, negative: { urls: 12, citations: 20, answers: 8 } }),
    tableSource: settled(null),
    periodView: settled(null),
    rn: settled(rnVmFor({ live: p.data, prev: p.prevCategories, card: p.officialDelta, typeRows: p.typeCategories, sections: null, search })),
  };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnFilterRuntime>
        <RnOverviewFilters props={{ stage: "citation", scope: { all: true } }} savedFilters={{ page: "citation", userId: "test", initial: [] }}>
          {(<RnCitationBody input={i} />) as ReactNode}
        </RnOverviewFilters>
      </RnFilterRuntime>
    </NextIntlClientProvider>,
  );
};
const T = ko.renewal.citation;

describe("renewal Citation body", () => {
  it("prompt tiles: counts, share of all and links to the sub page with the filters", () => {
    const html = render(input(), "geography=US");
    expect(html).toContain('href="/ko/renewal/standard/answer-analysis/citation/prompts?geography=US&amp;tab=owned"');
    expect(html).toContain('href="/ko/renewal/standard/answer-analysis/citation/prompts?geography=US&amp;tab=uncited"');
    expect(html).toMatch(/57<small[^>]*>개<\/small><\/span><span[^>]*>59%/); /* i18n-ignore */
    expect(html).toContain("41%");
  });
  it("findings include the uncited-prompt opportunity; the headline carries the split", () => {
    const html = render(input());
    expect(html).toContain("공식(당사) URL이 한 번도 인용되지 않은 프롬프트 39개 (41%)");
    expect(html).toContain("공식(당사) URL 인용 프롬프트 57개 / 미인용 39개");
  });
  it("legacy + 출처 filter: the split is not computed — the tiles say so", () => {
    const html = render(input({ data: live({ promptSplit: undefined }) }), `source=${encodeURIComponent(HMG)}`);
    expect(html).toContain(T.lens.split.notComputed);
    expect(html).not.toContain(T.lens.split.noOwnCategory);
  });
  it("출처 filter without 공식(HMG): the HMG tile and the prompt tiles explain why", () => {
    const html = render(input({ data: live({ categories: [{ name: AUTO, value: 400 }], promptSplit: undefined }) }), `source=${encodeURIComponent(AUTO)}`);
    expect(html).toContain(T.lens.hmg.excluded);
    expect(html).toContain(T.lens.split.noOwnCategory);
    expect(html).toContain(T.matrix.oneSource);
  });
  it("a competitor pick: the 공식(경쟁사) row shows the picked domains, no Δ, and the scope note", () => {
    const html = render(input(), "competitor=toyota.com");
    const row = html.slice(html.indexOf(`data-rn-src="${COMP}"`), html.indexOf("</button>", html.indexOf(`data-rn-src="${COMP}"`)));
    expect(row).toContain(">80<");
    expect(row).not.toContain("pp");
    expect(html).toContain(ko.answerAnalysis.citations.v2.competitor.scopeNote);
  });
  it("matrix: engine columns, every cell coloured; composition rows with the previous-round tick", () => {
    const html = render(input());
    expect((html.match(/data-rn-cell="/g) ?? []).length).toBe(8);
    expect((html.match(/data-rn-cell="[^"]*"[^>]*style="background:rgb/g) ?? []).length).toBe(8);
    expect((html.match(/data-rn-src="/g) ?? []).length).toBe(4);
    expect(html).toContain(T.comp.chipDelta.replace("{date}", "2026-10-05"));
  });
  it("출처 구성: Δ bars on one axis (largest change), direction only, no tick", () => {
    const html = render(input());
    const row = (name: string) => {
      const at = html.indexOf(`data-rn-src="${name.replace(/&/g, "&amp;")}"`);
      return at < 0 ? "" : html.slice(at, html.indexOf("</button>", at));
    };
    // 자동차 미디어 38% → 40% = +2.0pp is the largest change → the axis is ±2
    expect(html).toMatch(/data-rn-daxis="">.*?−2.*?\+2/);
    expect(row(AUTO)).toContain('data-rn-dbar="up"');
    expect(row(AUTO)).toMatch(/width:50%/);
    expect(row(HMG)).toContain('data-rn-dbar="down"');
    expect(row(HMG)).toMatch(/width:35%/);
    expect(row(NEWS)).toContain('data-rn-dbar="flat"');
    expect(html).not.toContain("-translate-x-1/2 rounded-[1px] bg-rn-ink");
  });
  it("no data: empty, filtered and delayed states", () => {
    expect(render(input({ data: null }))).toContain(ko.answerAnalysis.empty);
    expect(render(input({ data: null, filtered: true }))).toContain(T.states.noResultTitle);
    // a failed read says it could not load (the shared copy said every failure "timed out")
    expect(render(input({ data: null, dataDegraded: true }))).toContain(ko.renewal.mention.degraded.all);
  });
  it("tone tiles: api vs legacy basis chip", () => {
    expect(render(input())).toContain(T.tone.chipLegacy);
    expect(render(input({ api: true }))).toContain(T.tone.chipApi);
  });
});
