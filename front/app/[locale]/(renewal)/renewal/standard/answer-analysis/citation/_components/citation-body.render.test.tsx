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
let PATH = "/ko/renewal/standard/answer-analysis/citation";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => PATH,
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
// `website`: the website page's parts; its tests reuse the frozen model of the bare URL (`rnSearch`) and parts (`rnBase`)
type Vm = import("./citation-input").RnCitationVm;
const render = (p: Parts, search = "", website?: Input["website"], rnSearch = website ? "" : search, rnBase: Parts = p, rnEdit?: (vm: Vm) => Vm) => {
  SEARCH = search;
  PATH = website ? "/ko/renewal/website/answer-analysis/citation" : "/ko/renewal/standard/answer-analysis/citation";
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
    rn: settled(((vm) => (vm && rnEdit ? rnEdit(vm) : vm))(rnVmFor({ live: rnBase.data, prev: rnBase.prevCategories, card: rnBase.officialDelta, typeRows: rnBase.typeCategories, sections: null, search: rnSearch }))),
    website,
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
  it("matrix: a column without citations reads '—' and is not coloured; no type with citations says so (renewal audit 9-1)", () => {
    const blank = <T,>(m: { rows: string[] }, v: T) => Object.fromEntries(m.rows.map((k) => [k, v]));
    const html = render(input(), "", undefined, "", input(), (vm) => {
      const m = vm.engineMatrix.m!;
      const zero = { key: "perplexity", n: 0, shares: blank(m, null), counts: blank(m, 0) };
      return { ...vm, engineMatrix: { status: "ok", m: { ...m, cols: [...m.cols, zero], gaps: { ...m.gaps, perplexity: blank(m, null) } } } };
    });
    const cells = [...html.matchAll(/data-rn-cell="perplexity\|[^"]*"([^>]*)>([^<]*)</g)];
    expect(cells.length).toBe(4);
    expect(cells.every(([, attrs, text]) => text === "—" && !attrs.includes("background"))).toBe(true);
    expect((html.match(/data-rn-cell="[^"]*"[^>]*style="background:rgb/g) ?? []).length).toBe(8);
    const empty = render(input(), "", undefined, "", input(), (vm) => ({ ...vm, engineMatrix: { status: "empty", m: null } as unknown as Vm["engineMatrix"] }));
    expect(empty).toContain(ko.answerAnalysis.citations.v2.typeCategory.empty);
    expect(empty).not.toContain("data-rn-matrix=");
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

// The website page (W3, 2026-10-30): the same body with the website parts — the screen's model is the frozen
// one above (its Δ basis does not matter here), the website part comes as citation/website sends it.
type Website = Awaited<NonNullable<Input["website"]>>;
type Reach = Extract<Website["reach"], { status: "ok" }>;
const REACH: Reach = {
  status: "ok",
  measured: 10021,
  owned: 8815,
  target: 6673,
  ownedRate: 88.0,
  targetRate: 66.6,
  prev: { measured: 9982, owned: 8826, target: 6509, ownedRate: 88.4, targetRate: 65.2 },
  delta: { ownedRate: -0.5, targetRate: 1.4, basis: "round", date: "2026-10-02" },
  engines: [
    { engine: "ChatGPT", measured: 10021, owned: 8016, target: 5333, ownedRate: 80.0, targetRate: 53.2 },
    { engine: "Gemini", measured: 10021, owned: 6825, target: 4349, ownedRate: 68.1, targetRate: 43.4 },
  ],
  enginesDegraded: false,
  source: "live",
};
const OWN: NonNullable<Website["own"]> = { value: 24.9, delta: { value: -3.6, basis: "card", date: "2026-10-02" }, spark: [28.5, 28.5, 24.9], sparkOn: true };
const site = (over: Partial<Website> = {}) => settled<Website>({ own: OWN, reach: REACH, ...over });
const W = ko.renewal.website.citation;
const tile = (html: string, kind: string) => {
  const at = html.indexOf(`data-rn-tile="${kind}"`);
  const next = html.indexOf('data-rn-tile="', at + 10);
  return at < 0 ? "" : html.slice(at, next > 0 ? next : undefined);
};
const between = (html: string, from: string, to: string) => {
  const at = html.indexOf(from);
  return at < 0 ? "" : html.slice(at, html.indexOf(to, at + from.length));
};
const fill = (s: string, v: Record<string, string>) => Object.entries(v).reduce((o, [k, x]) => o.replace(`{${k}}`, x), s);

describe("renewal Citation body — website page", () => {
  it("sections per prompt first, then per citation", () => {
    const html = render(input(), "", site());
    const ids = [...html.matchAll(/id="(sec-[a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["sec-summary", "sec-reach", "sec-prompts", "sec-overview", "sec-comp", "sec-mix", "sec-dom"]);
  });
  it("headline: the URL funnel and the shares with their Δ", () => {
    const html = render(input(), "", site());
    const head = between(html, 'id="sec-summary"', "</p>");
    expect(head).toContain(`${W.summary.ownedUrl} <b>88.0%</b> (▼0.5pp)`);
    expect(head).toContain(`${W.summary.targetUrl} <b>66.6%</b> (▲1.4pp)`);
    expect(head).toContain(`${W.summary.own} <b>24.9%</b> (▼3.6pp)`);
  });
  it("reach: three steps on one denominator, the two drops, the Δ basis and the engines with 전체 first", () => {
    const html = render(input(), "", site());
    const reach = between(html, 'data-rn-reach=""', "</table>");
    expect(between(reach, 'data-rn-step="owned"', "</div>")).toMatch(/8,815.*88\.0%/);
    expect(between(reach, 'data-rn-step="target"', "</div>")).toMatch(/6,673.*66\.6%/);
    expect(reach).toContain(fill(W.reach.dropOwned, { n: "1,206" }));
    expect(reach).toContain(fill(W.reach.dropTarget, { n: "2,142" }));
    expect(between(reach, 'data-rn-step="owned"', ">")).toContain(fill(W.reach.tipPrev, { rate: "88.4%", n: "8,826", measured: "9,982" }));
    expect(html).toContain(fill(W.reach.chipDelta, { date: "2026-10-02" }));
    expect([...reach.matchAll(/data-rn-engine="([^"]+)"/g)].map((m) => m[1])).toEqual(["all", "ChatGPT", "Gemini"]);
    expect(between(reach, 'data-rn-engine="Gemini"', "</tr>")).toMatch(/68\.1%.*43\.4%/);
  });
  it("reach under a 출처 filter says why it is not computed", () => {
    const html = render(input(), `source=${encodeURIComponent(HMG)}`, site({ reach: { status: "notComputed" } }));
    expect(html).toContain(W.reach.notComputed);
    expect(html).not.toContain('data-rn-reach=""');
  });
  it("prompts: both buckets with counts, the top prompts and links to the website sub page", () => {
    const owned = [{ id: "p1", promptText: "best kia suv", funnelStage: null, citations: 203, providers: ["ChatGPT", "Gemini"], answers: [] }];
    const html = render(input({ data: live({ promptSplit: { owned, uncited: [], ownedCount: 57, uncitedCount: 39 } }) }), "geography=US", site(), "", input());
    const bucket = between(html, 'data-rn-bucket="owned"', 'data-rn-bucket="uncited"');
    expect(bucket).toContain("best kia suv");
    expect(bucket).toContain(fill(W.prompts.cites, { n: "203" }));
    expect(bucket).toContain('href="/ko/renewal/website/answer-analysis/citation/prompts?geography=US&amp;tab=owned"');
    expect(between(html, 'data-rn-bucket="uncited"', "</a>")).toContain(W.prompts.empty);
  });
  it("shares: 공식(HMG) · 공식(당사) · 딜러 and the original's totals (출처 분류 수 too)", () => {
    const html = render(input(), "", site());
    const order = [...html.matchAll(/data-rn-tile="([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["hmg", "own", "dealer"]);
    expect(tile(html, "own")).toMatch(/24\.9<small[^>]*>%<\/small>/);
    expect(tile(html, "own")).toContain(T.delta.basisPrev.replace("{date}", "2026-10-02"));
    expect(html).not.toMatch(/data-rn-b="[^"]*" data-rn-tile="own"/);
    expect(html).toContain(fill(W.lens.categories, { n: "4" }));
  });
  it("the rank bump names the site's own domains 당사, as the table tag does; the standard page keeps 공식(HMG) (renewal audit 9-3)", () => {
    const bump = T.bump as Record<string, string>;
    const legend = (html: string) => between(html, 'data-rn-bumplg=""', "</span>");
    expect(legend(render(input(), "", site()))).toContain(bump.legendOwnWebsite);
    expect(bump.legendOwnWebsite).toBe("당사 도메인");
    expect(legend(render(input()))).toContain(T.bump.legendOwn);
  });
  it("the standard page keeps its layout", () => {
    const html = render(input());
    expect([...html.matchAll(/data-rn-tile="([a-zA-Z]+)"/g)].map((m) => m[1])).toEqual(["hmg", "dealer", "owned", "uncited"]);
    expect(html).not.toContain('id="sec-reach"');
  });
});
