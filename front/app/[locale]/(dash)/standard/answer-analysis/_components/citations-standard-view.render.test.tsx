import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { CitationToneSummary, CitationTypeCategoryRow, CitationOwnedPromptPage, CitationToneUrlPage } from "@/lib/db/repositories/scope-aggregates";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import { CitationsStandardView } from "./citations-standard-view";
import { CitationPromptsPage } from "./citation-prompts-page";
import { CitationToneUrlsPage } from "./citation-tone-urls-page";
import { standardVmFor, typeChartFor } from "./citation-vm.fixture";

// next/navigation 훅은 라우터 없는 정적 렌더에서 null 을 준다 — 최소 mock.
import { vi } from "vitest";
vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const LIVE: CitationsLive = {
  summary: { total: 1000, uniqueDomains: 40, officialOwnShare: 9.6 },
  asOf: "2026-09-01",
  domains: [
    { domain: "hyundai.com", citations: 96, share: 9.6, prompts: 30, coverageRate: 5, urls: [], promptList: [], isOurs: true, category: "Official (HMG)", subcategory: null },
    { domain: "bmw.com", citations: 50, share: 5, prompts: 20, coverageRate: 3, urls: [], promptList: [], isOurs: false, category: "Official (Competitor)", subcategory: null },
    { domain: "toyota.com", citations: 40, share: 4, prompts: 18, coverageRate: 2, urls: [], promptList: [], isOurs: false, category: "Official (Competitor)", subcategory: null },
    { domain: "jdpower.com", citations: 30, share: 3, prompts: 12, coverageRate: 2, urls: [], promptList: [], isOurs: false, category: "Automotive Media", subcategory: null },
  ],
  categories: [
    { name: "Official (HMG)", value: 96 },
    { name: "Dealer & Marketplace", value: 149 },
    { name: "Other", value: 755 },
  ],
  trend: null,
  categoryTrend: null,
  engineCategories: [{ engine: "ChatGPT", total: 100, byCategory: { Other: 80, "Official (HMG)": 20 } }],
  promptSplit: { owned: [], uncited: [], ownedCount: 297, uncitedCount: 626 },
};
const TYPES: CitationTypeCategoryRow[] = [
  { type: "mention", total: 100, byCategory: { "Official (HMG)": 23, Other: 77 } },
  { type: "recommendation", total: 0, byCategory: {} },
  { type: "comparison", total: 0, byCategory: {} },
  { type: "definition", total: 0, byCategory: {} },
  { type: "final_choice", total: 0, byCategory: {} },
];
const TONE: CitationToneSummary = {
  positive: { urls: 348, citations: 900, answers: 200 },
  negative: { urls: 665, citations: 1200, answers: 300 },
};

function render(node: React.ReactNode, locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>,
  );
}
const RAW = /answerAnalysis\.citations\./;

describe("CitationsStandardView", () => {
  it.each(["ko", "en"] as const)("renders every section without raw i18n keys (%s)", (locale) => {
    const html = render(<CitationsStandardView data={LIVE} vm={standardVmFor(LIVE)} typeChart={typeChartFor(TYPES)} toneSummary={TONE} />, locale);
    expect(html).not.toMatch(RAW);
    expect(html).toContain("9.6%"); // 공식(당사) 비중
    expect(html).toContain("14.9%"); // 딜러·마켓 149/1000
    expect(html).toContain(">297<"); // 인용 프롬프트 수 배지
    expect(html).toContain(">626<");
    expect(html).toContain(">348<"); // 긍정 URL
    expect(html).toContain('data-type-category-track="mention"');
    expect(html).toContain("hyundai.com");
    // 하위 페이지 링크는 필터를 실어 나른다
    expect(html).toContain('href="/ko/standard/answer-analysis/citation/prompts?tab=owned"');
    expect(html).toContain('href="/ko/standard/answer-analysis/citation/tone-urls?tone=positive"');
  });
  it("narrows competitor-official rows to the picked competitors (the server vm)", () => {
    const html = render(<CitationsStandardView data={LIVE} vm={standardVmFor(LIVE, { search: "competitor=bmw.com" })} typeChart={typeChartFor(TYPES)} toneSummary={TONE} />);
    const tbody = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
    expect(tbody).toContain("bmw.com");
    expect(tbody).not.toContain("toyota.com");
    expect(tbody).toContain("jdpower.com"); // 다른 카테고리는 그대로
  });
  it("shows degrade notices when the side aggregates are null and the empty state for a null live", () => {
    const html = render(<CitationsStandardView data={LIVE} vm={standardVmFor(LIVE)} typeChart={null} toneSummary={null} />);
    // 문구에 괄호가 있어 RegExp 대신 split 으로 센다.
    expect(html.split(ko.answerAnalysis.mentions.kpi.degraded).length - 1).toBe(2);
    expect(render(<CitationsStandardView data={null} vm={null} typeChart={null} toneSummary={null} />)).toContain(ko.answerAnalysis.empty);
  });
});

describe("subpages", () => {
  const PROMPTS = {
    rows: [{ id: "p1", promptText: "What should I do if my Kia's engine shuts down?", funnelStage: "evaluation", citations: 42, providers: ["ChatGPT"], answers: [] }],
    total: 120, page: 2, pageSize: 50, win: { page: 2, pages: 3, from: 51, to: 100 },
  } satisfies CitationOwnedPromptPage & { win: unknown };
  const URLS = {
    rows: [{ url: "https://www.hyundai.news/eu/x", domain: "hyundai.news", title: "The new IONIQ 6", promptText: "Hvad er…", citations: 42, providers: ["ChatGPT"], category: "Official (HMG)" }],
    total: 60, page: 1, pageSize: 50, win: { page: 1, pages: 2, from: 1, to: 50 },
  } satisfies CitationToneUrlPage & { win: unknown };
  it("prompts page renders tabs · range · rows · pager without raw keys", () => {
    const html = render(<CitationPromptsPage tab="owned" page={PROMPTS} q="" ownedCount={348} uncitedCount={665} />);
    expect(html).not.toMatch(RAW);
    expect(html).toContain("인용 프롬프트(348)");
    expect(html).toContain("51–100 / 총 120개");
    expect(html).toContain("2 / 3");
    expect(html).toContain("engine shuts down");
  });
  it("tone urls page renders category chip · url · counts", () => {
    const html = render(<CitationToneUrlsPage tone="positive" page={URLS} q="" byDomain={false} counts={{ positive: 348, negative: 665 }} />);
    expect(html).not.toMatch(RAW);
    expect(html).toContain("긍정 답변에 인용된 URL(348)");
    expect(html).toContain("hyundai.news/eu/x");
    expect(html).toContain("42 회 인용");
    expect(html).toContain("공식 (HMG)");
  });
  it("tone urls page seeds the search box from the server query and wraps the list in the pending dim", () => {
    // 2026-09-16 GGMD QA — 검색창 값의 정본은 서버가 준 `q` 다(URL 소유). 그래야
    // 지우기가 URL 로 나갔다가 빈 q 로 돌아와 목록에 반영된다. `aria-busy` 래퍼는
    // 왕복 동안 목록을 흐리는 FilterContentDim(= "안 바뀐다" 오인 방지).
    const html = render(<CitationToneUrlsPage tone="positive" page={URLS} q="youtube" byDomain={false} counts={{ positive: 348, negative: 665 }} />);
    expect(html).toContain('value="youtube"');
    expect(html).toContain('aria-busy="false"');
    // 검증자 F1 — 컨트롤 행(검색창·도메인 스위치)은 dim **밖**이어야 한다. 안에 있으면
    // 왕복 중 입력창이 흐려지고 pointer-events 가 막힌다.
    expect(html).toContain("<form");
    expect(html).toContain('role="switch"');
    expect(html.indexOf("<form")).toBeLessThan(html.indexOf("aria-busy"));
    expect(html.indexOf('role="switch"')).toBeLessThan(html.indexOf("aria-busy"));
    // 목록은 dim 안이다.
    expect(html.indexOf("aria-busy")).toBeLessThan(html.indexOf("hyundai.news"));
  });
  it.each([
    ["tone urls", () => <CitationToneUrlsPage tone="positive" page={URLS} q="you" byDomain={false} counts={{ positive: 348, negative: 665 }} />],
    ["prompts", () => <CitationPromptsPage tab="owned" page={PROMPTS} q="you" ownedCount={348} uncitedCount={665} />],
  ] as const)("%s page: 검색 버튼(submit)이 입력창 뒤·폼 안·dim 밖에 있다 (2026-09-17 Enter/버튼 검색)", (_name, el) => {
    // 검색은 Enter(폼 submit) 또는 이 버튼에서만 나간다 — 버튼이 폼 안의 submit 이어야
    // 둘이 같은 onSubmit 경로를 탄다. 왕복 중에도 누를 수 있게 dim 밖이다.
    const html = render(el());
    const form = html.indexOf("<form");
    const formEnd = html.indexOf("</form>");
    const inputAt = html.indexOf('value="you"');
    const button = html.indexOf('type="submit"');
    expect(html).toContain('role="search"');
    expect(button).toBeGreaterThan(-1);
    expect(html.slice(button, html.indexOf("</button>", button))).toContain("검색");
    expect(form).toBeLessThan(inputAt);
    expect(inputAt).toBeLessThan(button);
    expect(button).toBeLessThan(formEnd);
    expect(formEnd).toBeLessThan(html.indexOf("aria-busy"));
    // 버튼 자체는 pending 으로 막지 않는다(disabled 없음) — 중복 클릭은 순수 로직이 무시한다.
    expect(html.slice(html.lastIndexOf("<button", button), html.indexOf(">", button) + 1)).not.toMatch(/\sdisabled(=|\s|>)/);
  });
  it("SubpageSearchBox 의 입력·submit 핸들러는 applySearchEvent 를 부른다 (배선 최소 고정)", () => {
    // 정적 SSR 에는 이벤트가 없다(jsdom 미도입). 상태 반영·push 조건의 **행동**은
    // subpage-search.test.ts 의 applySearchEvent 테스트가 지킨다. 여기서는 컴포넌트가 그
    // 함수를 import 해 두 핸들러(입력·submit)에서 부른다는 것 하나만 본다. 주석은 지운 뒤
    // 세고, 인자 모양·변수명은 보지 않는다(의미 동치 리팩터에 깨지지 않게).
    const src = readFileSync(new URL("./citation-prompts-page.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
    expect(src).toMatch(/import\s*\{[^}]*\bapplySearchEvent\b[^}]*\}\s*from\s*"\.\.\/_data\/subpage-search"/);
    expect((src.match(/\bapplySearchEvent\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("검색 버튼 라벨은 en 사전에서 온다", () => {
    const html = render(<CitationToneUrlsPage tone="positive" page={URLS} q="" byDomain={false} counts={{ positive: 348, negative: 665 }} />, "en");
    expect(html).not.toMatch(RAW);
    const button = html.indexOf('type="submit"');
    expect(html.slice(button, html.indexOf("</button>", button))).toContain(">Search");
  });
});
