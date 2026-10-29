import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { CitationToneSummary, CitationTypeCategoryRow, CitationOwnedPromptPage, CitationToneUrlPage } from "@/lib/db/repositories/scope-aggregates";
import type { CitationsLive } from "@/lib/scope/result-adapter";
import { CitationsStandardView } from "./citations-standard-view";
import { CitationPromptsPage } from "./citation-prompts-page";
import { CitationToneUrlsPage } from "./citation-tone-urls-page";

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
    const html = render(<CitationsStandardView data={LIVE} prevSubKpis={null} prevBasisDate={null} typeCategories={TYPES} toneSummary={TONE} />, locale);
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
  it("narrows competitor-official rows to the picked competitors (seam)", () => {
    const html = render(<CitationsStandardView data={LIVE} prevSubKpis={null} prevBasisDate={null} typeCategories={TYPES} toneSummary={TONE} initialCompetitors={["bmw.com"]} />);
    const tbody = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
    expect(tbody).toContain("bmw.com");
    expect(tbody).not.toContain("toyota.com");
    expect(tbody).toContain("jdpower.com"); // 다른 카테고리는 그대로
  });
  it("shows degrade notices when the side aggregates are null and the empty state for a null live", () => {
    const html = render(<CitationsStandardView data={LIVE} prevSubKpis={null} prevBasisDate={null} typeCategories={null} toneSummary={null} />);
    // 문구에 괄호가 있어 RegExp 대신 split 으로 센다.
    expect(html.split(ko.answerAnalysis.mentions.kpi.degraded).length - 1).toBe(2);
    expect(render(<CitationsStandardView data={null} prevSubKpis={null} prevBasisDate={null} typeCategories={null} toneSummary={null} />)).toContain(ko.answerAnalysis.empty);
  });
});

describe("subpages", () => {
  const PROMPTS: CitationOwnedPromptPage = {
    rows: [{ id: "p1", promptText: "What should I do if my Kia's engine shuts down?", funnelStage: "evaluation", citations: 42, providers: ["ChatGPT"], answers: [] }],
    total: 120, page: 2, pageSize: 50,
  };
  const URLS: CitationToneUrlPage = {
    rows: [{ url: "https://www.hyundai.news/eu/x", domain: "hyundai.news", title: "The new IONIQ 6", promptText: "Hvad er…", citations: 42, providers: ["ChatGPT"], category: "Official (HMG)" }],
    total: 60, page: 1, pageSize: 50,
  };
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
});
