import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationDomainLive } from "@/lib/scope/result-adapter";

// The renewal Citation domain sheet (도메인 상세): the reader sends at most 100 URLs and 12 prompts of a domain with
// their totals. The tabs count the domain's URLs and prompts (they counted the rows received: "인용 URL 100" beside
// "25283개 중 100개 표시"), the cut notes group thousands, and the prompt list says how many answers a prompt opens
// (2026-10-29 metric review, sub pages #40 #41 #45 #46 #50).

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

const { DomainDrawer, DomainTableCard } = await import("./citation-domains");
const { CitationProvider } = await import("./citation-context");

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

const render = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
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

  it("while the detail loads or after it failed the sheet says so in words (renewal audit 9-9: the key showed)", () => {
    const drill = (ko.answerAnalysis.citations.drilldown as Record<string, string>);
    for (const [status, key] of [["loading", "loading"], ["error", "loadFailed"]] as const) {
      DETAIL_STATE = { url: "x", status };
      const html = render();
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
