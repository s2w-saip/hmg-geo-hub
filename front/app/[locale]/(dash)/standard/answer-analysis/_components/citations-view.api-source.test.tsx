import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import u7ko from "@/messages/units/u7.ko.json";
import u7en from "@/messages/units/u7.en.json";
import { deepMergeMessages } from "@/i18n/request";
import type { CitationOwnedPromptPage } from "@/lib/db/repositories/scope-aggregates";
import type { CitationDomainLive, CitationsLive } from "@/lib/scope/result-adapter";
import { CitationsView, LoadMoreRow, hitRateDefPrefix } from "./citations-view";
import { CitationsStandardView } from "./citations-standard-view";
import { CitationPromptsPage, cursorPagingStep } from "./citation-prompts-page";
import {
  citationDrilldownEmptyKey,
  domainDetailUrl,
  domainExportUrl,
  domainListUrl,
  encodeSkeyForPath,
  isDefaultDomainQuery,
} from "../_data/citation-view";

// API source of the citation screens (unit U7), component side: the table reads its rows' '#'
// from the backend ranks (BG-21), shows "더 보기" while a next cursor exists (D5), rows carry the
// skey for the lazy drilldown (3.5 #6), the website cards switch their definition text to the
// measurement unit (DC-02), and the sub pages page with a cursor (next / previous). Legacy props
// (no tableSource, no unit, no nextCursor) render exactly as before (the existing render tests).

vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/website/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams("geography=US"),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));
vi.mock("server-only", () => ({}));
const { encodeSkey } = await import("@/lib/hgh/adapters/citations");

const MESSAGES = { ko: deepMergeMessages(ko, u7ko), en: deepMergeMessages(en, u7en) };
function render(node: React.ReactNode, locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}
const RAW = /answerAnalysis\.citations\./;

type Row = CitationDomainLive & { rank?: number; matchRank?: number };
const row = (domain: string, citations: number, o: Partial<Row> = {}): Row => ({
  domain,
  citations,
  share: 10,
  prompts: 3,
  coverageRate: 5,
  urls: [],
  promptList: [],
  isOurs: false,
  category: "Automotive Media",
  subcategory: null,
  skey: domain,
  ...o,
});
const LIVE: CitationsLive = {
  summary: { total: 100, uniqueDomains: 3, officialOwnShare: 12.5 },
  asOf: "2026-09-21",
  domains: [row("hyundai.com", 40, { rank: 7, matchRank: 1, isOurs: true, category: "Official (HMG)" }), row("toyota.com", 30, { rank: 8, matchRank: 2 })],
  categories: [{ name: "Official (HMG)", value: 40 }, { name: "Automotive Media", value: 60 }],
  trend: null,
  categoryTrend: null,
  engineCategories: null,
  promptSplit: null,
};
const tbodyOf = (html: string) => html.slice(html.lastIndexOf("<tbody"), html.lastIndexOf("</tbody>"));

describe("CitationsView (website / project) with an API table source", () => {
  it.each(["ko", "en"] as const)("'#' = match rank, 'load more' while a next cursor exists, no raw keys (%s)", (locale) => {
    const html = render(
      <CitationsView data={LIVE} hideFilterPanel tableSource={{ query: "surface=website", nextCursor: "n1", total: 480 }} />,
      locale,
    );
    expect(html).not.toMatch(RAW);
    const body = tbodyOf(html);
    expect(body.indexOf(">1<")).toBeLessThan(body.indexOf("hyundai.com"));
    expect(body).not.toContain(">7<");
    expect(body).toContain((locale === "ko" ? u7ko : u7en).answerAnalysis.citations.table.loadMore);
  });

  it("no next cursor -> no 'load more'; legacy props (no tableSource) -> client numbering, no 'load more'", () => {
    const done = tbodyOf(render(<CitationsView data={LIVE} hideFilterPanel tableSource={{ query: "", nextCursor: null, total: 2 }} />));
    expect(done).not.toContain("더 보기");
    const legacy = tbodyOf(render(<CitationsView data={LIVE} hideFilterPanel />));
    expect(legacy).not.toContain("더 보기");
    expect(legacy.indexOf(">1<")).toBeLessThan(legacy.indexOf("hyundai.com"));
  });

  it("website cards: values render; the definition text switches to the measurement unit (DC-02) only with unit=measurement", () => {
    const card = { hitPrompts: 7, ownedPrompts: 11, measuredPrompts: 40, rate: 17.5, ownedRate: 27.5 };
    const api = render(<CitationsView data={LIVE} hideFilterPanel targetHitRate={{ ...card, unit: "measurement" }} />);
    expect(api).toContain("17.5%");
    expect(api).toContain("27.5%");
    // the tooltip body renders on open only; the key choice is the pure helper the card uses
    expect([hitRateDefPrefix("measurement"), hitRateDefPrefix(undefined)]).toEqual(["summary.defMeasured", "summary.def"]);
  });

  it("u7 messages: ko and en have the same keys, defMeasured mirrors def for both cards", () => {
    const keys = (o: unknown, p = ""): string[] =>
      typeof o === "object" && o !== null ? Object.entries(o).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k)) : [p];
    expect(keys(u7ko).sort()).toEqual(keys(u7en).sort());
    const def = ko.answerAnalysis.citations.summary.def;
    const measured = u7ko.answerAnalysis.citations.summary.defMeasured;
    expect(keys(measured).sort()).toEqual(keys({ ownedHitRate: def.ownedHitRate, targetHitRate: def.targetHitRate }).sort());
  });
});

describe("LoadMoreRow (D3: one request at a time)", () => {
  const table = { active: true, rows: [], total: 9, nextCursor: "n1", status: "ready" as const, loadingMore: false, loadMore: () => {} };
  const button = (html: string) => html.match(/<button[^>]*>/)?.[0] ?? "";
  it("the button is disabled and busy while a 'load more' request is out", () => {
    expect(button(render(<table><tbody><LoadMoreRow table={table} colSpan={7} /></tbody></table>))).not.toContain('disabled=""');
    const busy = button(render(<table><tbody><LoadMoreRow table={{ ...table, loadingMore: true }} colSpan={7} /></tbody></table>));
    expect(busy).toContain('disabled=""');
    expect(busy).toContain('aria-busy="true"');
  });
});

describe("CitationsStandardView with an API table source", () => {
  it("'#' = the backend rank (after the competitor pick, before search), top 100 rows", () => {
    const html = render(
      <CitationsStandardView
        data={LIVE}
        prevSubKpis={null}
        prevBasisDate={null}
        typeCategories={null}
        toneSummary={null}
        tableSource={{ query: "", nextCursor: null, total: 2 }}
      />,
    );
    const body = tbodyOf(html);
    expect(body.indexOf(">7<")).toBeLessThan(body.indexOf("hyundai.com"));
    expect(body.indexOf(">8<")).toBeLessThan(body.indexOf("toyota.com"));
    expect(html).not.toMatch(RAW);
  });
});

describe("prompts sub page in cursor mode (D5)", () => {
  const PAGE: CitationOwnedPromptPage & { nextCursor: string | null } = {
    rows: [{ id: "p1", promptText: "best EV", funnelStage: null, citations: 3, providers: ["ChatGPT"], answers: [] }],
    total: 120,
    page: 2,
    pageSize: 50,
    nextCursor: null,
  };
  it("next is disabled without a next cursor even when the total says more pages", () => {
    const html = render(<CitationPromptsPage tab="owned" page={PAGE} q="" ownedCount={2} uncitedCount={5} />);
    expect(html).toContain("2 / 3");
    // two buttons: prev (enabled on page 2), next (disabled: no cursor)
    const { prev, next } = ko.answerAnalysis.citations.v2.pager;
    const pagerButtons = (h: string) =>
      [...h.matchAll(new RegExp(`<button[^>]*>(${prev}|${next})</button>`, "g"))].map((m) => [m[1], m[0].includes('disabled=""')]);
    expect(pagerButtons(html)).toEqual([
      [prev, false],
      [next, true],
    ]);
    const more = render(<CitationPromptsPage tab="owned" page={{ ...PAGE, nextCursor: "c3" }} q="" ownedCount={2} uncitedCount={5} />);
    expect(pagerButtons(more)).toEqual([
      [prev, false],
      [next, false],
    ]);
  });

  it("cursorPagingStep: next remembers the current cursor, previous uses it, unknown -> first page", () => {
    // on page 2 opened with cursor c2, next cursor c3
    const s = { page: 2, next: "c3", current: "c2", cursors: [null] as (string | null)[] };
    expect(cursorPagingStep(s, 3)).toEqual({ push: { cursor: "c3", page: "3" }, remember: { index: 1, cursor: "c2" } });
    // back to page 1: always the first page (no cursor)
    expect(cursorPagingStep(s, 1)).toEqual({ push: { cursor: "", page: "1" } });
    // on page 3 after two nexts: previous -> the cursor that opened page 2
    expect(cursorPagingStep({ page: 3, next: null, current: "c3", cursors: [null, "c2"] }, 2)).toEqual({ push: { cursor: "c2", page: "2" } });
    // opened directly on page 3 (nothing remembered): previous -> first page (U7-N7)
    expect(cursorPagingStep({ page: 3, next: "c4", current: "c3", cursors: [] }, 2)).toEqual({ push: { cursor: "", page: "1" } });
    // no next cursor, or the same page: no move
    expect(cursorPagingStep({ page: 3, next: null, current: "c3", cursors: [] }, 4)).toBeNull();
    expect(cursorPagingStep(s, 2)).toBeNull();
  });
});

describe("table and drilldown URLs (client side of /api/citations/domains*)", () => {
  it("the client path segment is the same base64url as the route decodes (social keys, non-ASCII)", () => {
    for (const k of ["instagram.com/hyundai", "hyundai.com", "현대자동차.kr", "a+b/c?d"]) expect(encodeSkeyForPath(k)).toBe(encodeSkey(k));
  });

  it("list / detail / export URLs carry the page's filter query plus the table state", () => {
    const src = { query: "surface=website&geography=US" };
    expect(domainListUrl(src, { q: " kia ", sortKey: "coverageRate", asc: true }, 200, "n1")).toBe(
      "/api/citations/domains?surface=website&geography=US&q=kia&sort=coverage&dir=asc&limit=200&cursor=n1",
    );
    expect(domainListUrl(src, { q: "", sortKey: "domain", asc: false }, 100)).toBe(
      "/api/citations/domains?surface=website&geography=US&sort=skey&dir=desc&limit=100",
    );
    expect(domainDetailUrl("projectId=p", "instagram.com/hyundai")).toBe(`/api/citations/domains/${encodeSkey("instagram.com/hyundai")}?projectId=p`);
    expect(domainExportUrl(src, { q: "", sortKey: "prompts", asc: false }, "en")).toBe(
      "/api/citations/domains/export?surface=website&geography=US&sort=prompts&dir=desc&locale=en",
    );
    expect([isDefaultDomainQuery({ q: " ", sortKey: "citations", asc: false }), isDefaultDomainQuery({ q: "", sortKey: "citations", asc: true })]).toEqual([true, false]);
  });

  it("empty drilldown text: an API row (skey) is complete when loaded ('no URLs', never 'top domains only')", () => {
    const api = { category: "Automotive Media", urls: [], promptList: [], skey: "x.example" };
    expect(citationDrilldownEmptyKey(api, "urls")).toBe("drilldown.noUrlsOfficial");
    expect(citationDrilldownEmptyKey({ ...api, category: "Official (HMG)", urls: [{ url: "u", title: "", count: 1, aiProvider: "", promptText: "", country: null }] }, "prompts")).toBe(
      "drilldown.noPrompts",
    );
    // legacy rows keep the legacy keys
    expect(citationDrilldownEmptyKey({ category: "Automotive Media", urls: [], promptList: [] }, "urls")).toBe("drilldown.noUrls");
  });
});
