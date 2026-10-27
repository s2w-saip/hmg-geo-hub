import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { MentionsLive } from "@/lib/scope/result-adapter";

// 공통 하단(2026-09-02) 렌더 스모크 — 표 추출이 종전 마크업을 유지하는지, 토글 seam 이
// 복수 언급 값으로 바꾸는지, 상위 N 컷·i18n 키 누락 여부.
//
// B040(Excel): 이 리포에는 jsdom 이 없어 클릭을 못 한다. 그래서 Button 을 얇은 stub 으로 갈아
// 렌더 중에 받은 onClick(= 컴포넌트의 진짜 onExport 클로저)을 채집해 직접 호출한다
// (competitor-kpi-table.write-path.test.tsx 와 같은 방식). stub 은 같은 <button> 을 그리므로
// 다른 단언에는 영향이 없다.
const ui = vi.hoisted(() => ({
  clicks: [] as Array<{ label: string; onClick?: () => unknown; disabled?: boolean }>,
  toastError: [] as string[],
  download: { impl: (async () => undefined) as (...args: unknown[]) => Promise<void>, calls: 0 },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: { children?: React.ReactNode; onClick?: () => unknown; disabled?: boolean }) => {
    const label = (Array.isArray(children) ? children : [children]).filter((c) => typeof c === "string").join("");
    ui.clicks.push({ label, onClick, disabled });
    return (
      <button type="button" disabled={disabled}>
        {children}
      </button>
    );
  },
}));
vi.mock("sonner", () => ({ toast: { error: (m: string) => ui.toastError.push(m) } }));
vi.mock("@/lib/export/xlsx", () => ({
  downloadXlsx: (...args: unknown[]) => {
    ui.download.calls++;
    return ui.download.impl(...args);
  },
}));

const { MentionsPromptsSectionFromLegacy: MentionsPromptsSection, BrandRankTableFromLegacy: BrandRankTable } = await import("../_data/mention-screen.test-utils");

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
    // 2026-09-02 피그마 1:1(제품 결정 Q42): 복수 언급 ON 은 값을 갈아끼우지 않고 2열을 추가한다.
    expect(html).toContain(ko.answerAnalysis.mentions.table.col.multiMentions);
    expect(html).toContain(ko.answerAnalysis.mentions.table.col.multiRate);
    expect(html).toContain("10.0%"); // 20/200 답변 단위
    expect(html).toContain(ko.answerAnalysis.mentions.table.multiUnavailable); // BMW 는 multi 없음
  });
  it("shows the empty state for a null aggregate", () => {
    expect(render(<MentionsPromptsSection data={null} />)).toContain(ko.answerAnalysis.empty);
  });
  it("B034: a null aggregate from a transient failure says degraded, not 'no data'", () => {
    const html = render(<MentionsPromptsSection data={null} degraded />);
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.degraded);
    expect(html).toContain(ko.answerAnalysis.mentions.prompts.title);
    expect(html).not.toContain(ko.answerAnalysis.empty);
    // the flag never changes a section that has data
    expect(render(<MentionsPromptsSection data={DATA} degraded />)).toBe(render(<MentionsPromptsSection data={DATA} />));
  });
});

/** B039 line: the existing unmeasured-dialog copy (numbers as the formatter writes them). */
const cutLine = (shown: number, total: number) =>
  ko.answerAnalysis.mentions.kpi.overview.unmeasuredDialog.truncated.replace("{total}", String(total)).replace("{shown}", String(shown));

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
  it("B039: a list cut at the server cap gets one '{total}개 중 {shown}개' line; an uncut list is unchanged", () => {
    const cut = render(<BrandRankTable brands={DATA.brands} perBrandPrompts={{}} total={12000} />);
    expect(cut).toContain(cutLine(3, 12000));
    const plain = render(<BrandRankTable brands={DATA.brands} perBrandPrompts={{}} />);
    expect(plain).not.toContain(cutLine(3, 12000));
    // total not larger than the rows (or absent) draws nothing
    expect(render(<BrandRankTable brands={DATA.brands} perBrandPrompts={{}} total={3} />)).toBe(plain);
    // the standard section passes it through as well
    expect(render(<MentionsPromptsSection data={{ ...DATA, brandsTotal: 12000 }} />)).toContain(cutLine(3, 12000));
  });
});

describe("BrandRankTable Excel export (B040)", () => {
  afterEach(() => {
    ui.clicks.length = 0;
    ui.toastError.length = 0;
    ui.download = { impl: async () => undefined, calls: 0 };
  });
  /** Render once and hand back the export button's real onClick. */
  function exportButton() {
    ui.clicks.length = 0;
    render(<BrandRankTable brands={DATA.brands} perBrandPrompts={{}} />);
    const b = ui.clicks.find((c) => c.label.includes(ko.answerAnalysis.exportExcel));
    expect(b?.onClick).toBeTypeOf("function");
    return b!;
  }

  it("the button is enabled while idle (rows present) and writes the rows once per click", async () => {
    const b = exportButton();
    expect(b.disabled).toBe(false);
    await b.onClick!();
    expect([ui.download.calls, ui.toastError]).toEqual([1, []]);
  });

  it("a failed build shows the existing exportFailed toast instead of failing silently", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    ui.download.impl = async () => {
      throw new Error("chunk load failed");
    };
    await exportButton().onClick!();
    expect(ui.toastError).toEqual([ko.standardPromptsView.exportFailed]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("a second click while the file is being built does not start another export", async () => {
    let finish!: () => void;
    ui.download.impl = () => new Promise<void>((r) => (finish = r));
    const b = exportButton();
    const first = b.onClick!();
    await b.onClick!(); // returns at once: an export is in flight
    expect(ui.download.calls).toBe(1);
    finish();
    await first;
    // after it settled a new click exports again
    ui.download.impl = async () => undefined;
    await b.onClick!();
    expect(ui.download.calls).toBe(2);
  });
});
