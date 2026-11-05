import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationDomainLive } from "@/lib/scope/result-adapter";

// The renewal Citation domain sheet (도메인 상세): the reader sends at most 100 URLs and 12 prompts of a domain with
// their totals. The tabs count the domain's URLs and prompts (they counted the rows received: "인용 URL 100" beside
// "25283개 중 100개 표시"), the cut notes group thousands, and the prompt list says how many answers a prompt opens
// (2026-10-29 metric review, sub pages #40 #41 #45 #46 #50).

vi.mock("next-intl/server", () => ({ getRequestConfig: <T,>(fn: T) => fn }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(),
}));

const settled = <T,>(v: T): Promise<T> => Object.assign(Promise.resolve(v), { status: "fulfilled", value: v });
const SOURCE = settled({ query: "geography=US", nextCursor: null, total: 1 });

const url = (i: number) => ({ url: `https://www.kia.com/us/${i}`, title: `page ${i}`, count: 3, aiProvider: "chatgpt", promptText: "", country: null });
const prompt = (i: number) => ({ id: `p${i}`, promptText: `prompt ${i}`, funnelStage: null, citations: 1200 - i, providers: ["chatgpt"], answers: [{ jobId: "j", provider: "chatgpt" }], share: 1 });
const DETAIL = {
  url: "x",
  status: "ready" as const,
  urls: Array.from({ length: 100 }, (_, i) => url(i)),
  promptList: Array.from({ length: 12 }, (_, i) => prompt(i)),
  urlTotal: 25283,
  promptTotal: 2534,
};

let CTX: object = { input: { tableSource: SOURCE } };
vi.mock("./citation-context", async (orig) => ({
  ...(await orig<typeof import("./citation-context")>()),
  useCitation: () => CTX,
}));
let DETAIL_STATE: object = DETAIL;
vi.mock("@/app/[locale]/(dash)/standard/answer-analysis/_components/citations-view", async (orig) => ({
  ...(await orig<typeof import("@/app/[locale]/(dash)/standard/answer-analysis/_components/citations-view")>()),
  useDomainDetail: () => DETAIL_STATE,
}));

const { DomainBumpCard, DomainDrawer, DomainTableCard } = await import("./citation-domains");
const between = (html: string, from: string, to: string) => {
  const at = html.indexOf(from);
  return at < 0 ? "" : html.slice(at, html.indexOf(to, at + from.length));
};
const { CitationProvider } = await import("./citation-context");
const { loadMessages } = await import("@/i18n/request");
// the messages a request serves: ko.json merged with the unit files (the drawer's loading copy is units/u7's)
const MERGED = (await loadMessages("ko")) as typeof ko;

const ROW = {
  domain: "kia.com",
  skey: "kia.com",
  category: "Official (HMG)",
  citations: 25283,
  share: 2.7,
  prompts: 2534,
  coverageRate: 22.2,
  urls: [],
  promptList: [],
  isOurs: true,
  subcategory: null,
} as unknown as CitationDomainLive;

const render = (messages: typeof ko = ko) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={messages} timeZone="Asia/Seoul">
      <DomainDrawer row={ROW} onClose={() => {}} />
    </NextIntlClientProvider>,
  );

describe("renewal Citation domain sheet", () => {
  it("tabs count the domain's URLs and prompts, not the rows received", () => {
    const html = render();
    expect(html).toMatch(/인용 URL<span[^>]*>25,283</);
    expect(html).toMatch(/프롬프트<span[^>]*>2,534</);
    expect(html).not.toMatch(/인용 URL<span[^>]*>100</);
  });

  it("the cut note groups thousands", () => {
    const html = render();
    expect(html).toContain("25,283개 중 100개 표시");
    expect(html).not.toContain("25283개");
  });

  it("while the detail loads or after it failed the sheet says so in words (the served messages, units/u7)", () => {
    const drill = MERGED.answerAnalysis.citations.drilldown as Record<string, string>;
    for (const [status, key] of [["loading", "loading"], ["error", "loadFailed"]] as const) {
      DETAIL_STATE = { url: "x", status };
      const html = render(MERGED);
      expect(html).not.toContain(`drilldown.${key}`);
      expect(drill[key]).toBeTruthy();
      expect(html).toContain(drill[key]);
    }
    DETAIL_STATE = DETAIL;
  });
});

// 2026-10-31 renewal audit 10-2: the domain table cut every list at 100 rows. The Website screen sends 200 and the
// original Website table loaded 200 more per '더 보기' over all its sources (14,687 on 2026-10-31), so rows 101+ could
// not be seen at all. The Website table shows every row it loaded and reads the next page of the same route; the
// standard table keeps the original Global top 100.
describe("renewal Citation domain table — every row on the Website (renewal audit 10-2)", () => {
  const TT = ko.renewal.citation.table as typeof ko.renewal.citation.table & Record<string, string>;
  const fill = (str: string, v: Record<string, string>) => Object.entries(v).reduce((o, [k, x]) => o.replace(`{${k}}`, x), str);
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...ROW, domain: `d${i + 1}.com`, skey: `d${i + 1}.com`, citations: 1000 - i, isOurs: false, no: i + 1, rank: i + 1, matchRank: i + 1 }));
  const table = (website: boolean, n: number, initialAll = false, total = 14687) => {
    const list = rows(n);
    const shown = website ? n : Math.min(n, 100);
    CTX = {
      input: {
        tableSource: settled({ query: website ? "surface=website" : "", nextCursor: String(n), total }),
        rn: settled({ table: { rows: list, views: { "": { idx: Array.from({ length: shown }, (_, i) => i), maxCit: 1000, maxCov: 30 } }, categories: ["Official (HMG)"] } }),
        ...(website ? { website: settled({ own: null, reach: { status: "none" } }) } : {}),
      },
      lit: null,
      hover: () => {},
      openDomain: () => {},
      tables: new Set(),
      toggleTable: () => {},
    };
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        {/* the card's ⋯ menu reads the context itself (not the mocked hook) */}
        <CitationProvider value={CTX as import("./citation-context").CitationCtx}>
          <DomainTableCard initialAll={initialAll} />
        </CitationProvider>
      </NextIntlClientProvider>,
    );
    CTX = { input: { tableSource: SOURCE } };
    return html;
  };
  const count = (html: string) => (html.match(/data-rn-domain="/g) ?? []).length;

  it("website: the loaded 230 rows behind '모두 보기', the chip names every source", () => {
    const html = table(true, 230);
    expect(html).toContain(fill(TT.showAll, { n: "230" }));
    expect(html).toContain(fill(TT.chipAll, { n: "14,687" }));
    expect(count(html)).toBe(20);
  });
  it("website, all shown: rank 150 is there, then how many of all and '200개 더 보기' (the next route page)", () => {
    const html = table(true, 230, true);
    expect(count(html)).toBe(230);
    expect(html).toContain('data-rn-domain="d150.com"');
    expect(html).toContain(fill(TT.loadedOf, { shown: "230", total: "14,687" }));
    expect(html).toContain(fill(TT.more, { n: "200" }));
    expect(html).toContain(fill(TT.showFirst, { n: "20" }));
    // the last page asks for what is left
    expect(table(true, 230, true, 300)).toContain(fill(TT.more, { n: "70" }));
  });
  it("standard: the top 100 as the original Global table, no '더 보기'", () => {
    expect(table(false, 230)).toContain(fill(TT.showAll, { n: "100" }));
    expect(table(false, 230)).toContain(fill(TT.chip, { n: "100" }));
    const html = table(false, 230, true);
    expect(count(html)).toBe(100);
    expect(html).not.toContain(fill(TT.more, { n: "200" }));
    expect(html).not.toContain('data-rn-more=""');
  });
});

// 2026-11-05 Global 지표 정리: the Global page says each number once — the table's share sits small in the citations cell
// (one sort), the sheet's numbers and URL count go on its subtitle line, the bump drops the last round's count beside
// each label (its points carry every round's). Website and Project keep their layout. Restored on every page: the
// sheet's prompt list sorts by citations or by prompt (the original's headers, the server's orders).
describe("renewal Citation — Global 지표 정리 (2026-11-05)", () => {
  const TT = ko.renewal.citation.table as typeof ko.renewal.citation.table & Record<string, string>;
  const D = ko.renewal.citation.drawer as typeof ko.renewal.citation.drawer & Record<string, string>;
  const tC = ko.answerAnalysis.citations.table;
  const fill = (str: string, v: Record<string, string>) => Object.entries(v).reduce((o, [k, x]) => o.replace(`{${k}}`, x), str);
  const LIVE = { summary: { total: 935282, uniqueDomains: 25818 }, trend: { series: [], points: [] }, domains: [] };
  const withCtx = (input: object, node: ReactNode) => {
    CTX = { input: { tableSource: SOURCE, ...input }, live: LIVE, lit: null, hover: () => {}, openDomain: () => {}, tables: new Set(), toggleTable: () => {} };
    try {
      return renderToStaticMarkup(
        <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
          <CitationProvider value={CTX as import("./citation-context").CitationCtx}>{node}</CitationProvider>
        </NextIntlClientProvider>,
      );
    } finally {
      CTX = { input: { tableSource: SOURCE } };
    }
  };
  const tableRow = { ...ROW, no: 1, rank: 1, matchRank: 1, share: 8.2 };
  const RN = settled({ table: { rows: [tableRow], views: { "": { idx: [0], maxCit: 25283, maxCov: 22.2 } }, categories: ["Official (HMG)"] } });
  const surfaces = { global: { global: true }, project: {}, website: { website: settled({ own: null, reach: { status: "none" } }) } };

  it("domain table: Global puts the share small in the citations cell and sorts by citations once; Website and Project keep the column", () => {
    const html = withCtx({ ...surfaces.global, rn: RN }, <DomainTableCard />);
    expect(html).not.toContain('data-rn-sort="share"');
    expect(html).toContain(`${tC.col.citations} · ${tC.col.share}`);
    expect(between(html, 'data-rn-cit=""', "</td>")).toMatch(/25,283<\/b><small[^>]*>8\.2%<\/small>/);
    expect((between(html, "<thead", "</thead>").match(/<th /g) ?? []).length).toBe(6);
    expect(html).toContain(fill(TT.chipGlobal, { n: "100", domains: "25,818", total: "935,282" }));
    expect(html).toContain(TT.infoGlobal);
    for (const s of [surfaces.project, surfaces.website]) {
      const other = withCtx({ ...s, rn: RN }, <DomainTableCard />);
      expect(other).toContain('data-rn-sort="share"');
      expect(between(other, 'data-rn-cit=""', "</td>")).not.toContain("8.2%");
      expect((between(other, "<thead", "</thead>").match(/<th /g) ?? []).length).toBe(7);
      expect(other).not.toContain(fill(TT.chipGlobal, { n: "100", domains: "25,818", total: "935,282" }));
    }
  });

  it("domain sheet: Global names the row's numbers and the URL count on the subtitle line, no head cells or tab counts", () => {
    const html = withCtx(surfaces.global, <DomainDrawer row={ROW} onClose={() => {}} />);
    const sub = fill(D.subStats, { citations: "25,283", share: "2.7%", prompts: "2,534", coverage: "22.2%" });
    expect(html).toContain(`${ko.citationCategories.officialHmg} · ${sub} · ${fill(D.subUrls, { n: "25,283" })}`);
    expect(html).not.toContain("<dl");
    expect(html).not.toMatch(/인용 URL<span[^>]*>25,283</);
    expect(html).not.toMatch(/프롬프트<span[^>]*>2,534</);
    for (const s of [surfaces.project, surfaces.website]) {
      const other = withCtx(s, <DomainDrawer row={ROW} onClose={() => {}} />);
      expect(other).toContain("<dl");
      expect(other).toMatch(/인용 URL<span[^>]*>25,283</);
      expect(other).not.toContain(sub);
    }
  });

  it("domain sheet › prompts (every page): two sorts, citations first — the server's orders, one direction each", async () => {
    const { promptsInOrder } = await import("./citation-domains");
    const prompts = [{ promptText: "b" }, { promptText: "a" }, { promptText: "c" }];
    const orders = { prompt: { asc: [1, 0, 2], desc: [2, 0, 1] }, citations: { asc: [2, 1, 0], desc: [0, 1, 2] }, share: { asc: [2, 1, 0], desc: [0, 1, 2] } };
    expect(promptsInOrder(prompts, orders, "prompt").map((p) => p.promptText)).toEqual(["a", "b", "c"]);
    expect(promptsInOrder(prompts, orders, "citations").map((p) => p.promptText)).toEqual(["b", "a", "c"]);
    // no orders (or orders of another list): as received
    expect(promptsInOrder(prompts, undefined, "prompt").map((p) => p.promptText)).toEqual(["b", "a", "c"]);
    expect(promptsInOrder(prompts, { ...orders, prompt: { asc: [1], desc: [1] } }, "prompt").map((p) => p.promptText)).toEqual(["b", "a", "c"]);
    // the sheet's list shows the two keys (no share key) with the detail's orders
    const { PromptList } = await import("./citation-domains");
    const list = (o?: typeof orders) =>
      renderToStaticMarkup(
        <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
          <PromptList row={ROW} prompts={DETAIL.promptList as unknown as import("@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view").DomainDetailView["promptList"]} answersCap={8} onAnswer={() => {}} orders={o} />
        </NextIntlClientProvider>,
      );
    const html = list(orders);
    expect([...html.matchAll(/data-rn-seg="([a-z]+)"/g)].map((m) => m[1])).toEqual(["citations", "prompt"]);
    expect(html).toMatch(/aria-checked="true" data-rn-seg="citations"/);
    expect(html).toContain(D.sortCitations);
    expect(html).toContain(D.sortPrompt);
    expect(list()).not.toContain("data-rn-seg=");
  });

  it("weekly rank bump: Global drops the last round's count beside each label (each point has every round's); Project keeps it", () => {
    const x = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
    const bump = {
      x,
      first: 0,
      last: 3,
      measured: 4,
      movers: [{ key: "motortrend.com", move: -1 }],
      drawOrder: [0, 2, 1],
      series: [
        { key: "caranddriver.com", own: false, values: [50, 51, 52, 53], ranks: [1, 1, 1, 1], move: 0, domainIndex: 0 },
        { key: "hyundai.com", own: true, values: [30, 36, 42, 1200], ranks: [3, 3, 2, 2], move: 1, domainIndex: 1 },
        { key: "motortrend.com", own: false, values: [45, 41, 37, 33], ranks: [2, 2, 3, 3], move: -1, domainIndex: 2 },
      ],
    };
    const card = (s: object) => withCtx({ ...s, rn: settled({ bump }), sectionDegraded: settled(null) }, <DomainBumpCard initialWidth={1000} />);
    const html = card(surfaces.global);
    expect(html).toContain("<svg");
    expect(html).not.toContain("data-rn-bumpn");
    expect(html).not.toContain(">1.2K<");
    expect(html).toContain(fill(ko.renewal.citation.bump.tip, { x: "10/12", domain: "hyundai.com", rank: "2", n: "1,200" }));
    // the rank move stays beside the label
    expect(html).toMatch(/▲(<!-- -->)?1<\/text>/);
    const project = card(surfaces.project);
    expect((project.match(/data-rn-bumpn=""/g) ?? []).length).toBe(3);
    expect(project).toContain(">1.2K<");
  });
});

describe("bumpMoveFill", () => {
  it("colours 당사's rank move only: a rival's is neutral (Global score sheet, 2026-11-02)", async () => {
    const { bumpMoveFill } = await import("./citation-domains");
    expect(bumpMoveFill(true, 2)).toContain("up-ink");
    expect(bumpMoveFill(true, -2)).toContain("danger-ink");
    expect(bumpMoveFill(false, 2)).toBe(bumpMoveFill(false, -2));
    expect(bumpMoveFill(false, 2)).not.toMatch(/up-ink|danger-ink/);
  });
});
