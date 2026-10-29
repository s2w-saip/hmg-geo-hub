import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { MentionsLive } from "@/lib/scope/result-adapter";
import { MentionsPromptsSection } from "./mentions-prompts-section";
import { BrandRankTable } from "./brand-rank-table";

// 공통 하단(2026-09-02) 렌더 스모크 — 표 추출이 종전 마크업을 유지하는지, 토글 seam 이
// 복수 언급 값으로 바꾸는지, 상위 N 컷·i18n 키 누락 여부.

const DATA: MentionsLive = {
  summary: { total: 300, uniqueBrands: 3, totalPrompts: 50, totalAnswers: 200 },
  asOf: "2026-09-01",
  brands: [
    { brand: "Hyundai", mentions: 200, prompts: 40, share: 66.7, mentionRate: 60, avgPosition: 3.2, isTracked: true, multi: { mentions: 50, answers: 20, prompts: 10 } },
    { brand: "Tesla", mentions: 80, prompts: 30, share: 26.7, mentionRate: 30, avgPosition: 2.1, isTracked: false, multi: { mentions: 10, answers: 4, prompts: 3 } },
    { brand: "BMW", mentions: 20, prompts: 5, share: 6.6, mentionRate: 8, avgPosition: null, isTracked: false },
  ],
  perBrandPrompts: {},
  sentimentTotals: null,
  typeTotals: null,
  hasPosition: true,
  trend: { series: ["Hyundai", "Tesla"], points: [{ week: "2026-08-24", Hyundai: 90, Tesla: 40 }, { week: "2026-08-31", Hyundai: 110, Tesla: 40 }] },
};

function render(node: React.ReactNode, locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>,
  );
}

describe("MentionsPromptsSection", () => {
  it.each(["ko", "en"] as const)("renders heading · trend · table without raw keys (%s)", (locale) => {
    const html = render(<MentionsPromptsSection data={DATA} />, locale);
    expect(html).not.toMatch(/answerAnalysis\.mentions\./);
    expect(html).toContain(locale === "ko" ? "프롬프트 및 답변" : "Prompts &amp; answers");
    expect(html).toContain("Hyundai");
    expect(html).toContain("200"); // 언급 수 스냅샷
    expect(html).toContain('role="switch"'); // 복수 언급 토글
  });
  it("switches the table to multi-mention values when the seam is on, dash for rows without data", () => {
    const html = render(<MentionsPromptsSection data={DATA} initialMulti />);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(">50<"); // Hyundai multi mentions
    // 2026-09-02 피그마 1:1(운영 결정 Q42): 복수 언급 ON 은 값을 갈아끼우지 않고 2열을 추가한다.
    expect(html).toContain(ko.answerAnalysis.mentions.table.col.multiMentions);
    expect(html).toContain(ko.answerAnalysis.mentions.table.col.multiRate);
    expect(html).toContain("10.0%"); // 20/200 답변 단위
    expect(html).toContain(ko.answerAnalysis.mentions.table.multiUnavailable); // BMW 는 multi 없음
  });
  it("shows the empty state for a null aggregate", () => {
    expect(render(<MentionsPromptsSection data={null} />)).toContain(ko.answerAnalysis.empty);
  });
});

describe("BrandRankTable (shared with website/project)", () => {
  it("keeps the legacy shape by default — no toggle, all rows, snapshot values", () => {
    const html = render(<BrandRankTable brands={DATA.brands} perBrandPrompts={{}} />);
    expect(html).not.toContain('role="switch"');
    expect(html).toContain("BMW");
    expect(html).toContain("66.7%");
  });
  it("caps rows at the limit", () => {
    const html = render(<BrandRankTable brands={DATA.brands} perBrandPrompts={{}} limit={2} />);
    expect(html).toContain("Tesla");
    expect(html).not.toContain("BMW");
  });
});
