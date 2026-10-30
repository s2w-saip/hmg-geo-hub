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

vi.mock("./citation-context", async (orig) => ({
  ...(await orig<typeof import("./citation-context")>()),
  useCitation: () => ({ input: { tableSource: SOURCE } }),
}));
let DETAIL_STATE: object = DETAIL;
vi.mock("@/app/[locale]/(dash)/standard/answer-analysis/_components/citations-view", async (orig) => ({
  ...(await orig<typeof import("@/app/[locale]/(dash)/standard/answer-analysis/_components/citations-view")>()),
  useDomainDetail: () => DETAIL_STATE,
}));

const { DomainDrawer } = await import("./citation-domains");

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
