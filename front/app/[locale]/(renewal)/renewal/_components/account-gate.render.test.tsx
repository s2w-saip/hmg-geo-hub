import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";

// The pages waiting on an outside account (2026-11-02, user): the screen on sample data, inert under a translucent veil,
// with a notice naming the account. The AI Conversion sample is the body's render fixture; the keyword tools sample is
// made-up rows whose summary follows the original's tiers.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/ai-funnel/conversion",
  useSearchParams: () => new URLSearchParams(""),
}));

const { RnFilterRuntime } = await import("./filter-runtime");
const { RnOverviewFilters } = await import("./overview-filters");
const { RnAccountGate, RnSampleVeil } = await import("./account-gate");
const { RnConvSample } = await import("../standard/ai-funnel/conversion/_components/conv-sample");
const { KeywordSample } = await import("../admin/keyword-tools/_components/keyword-sample");
const { ProjectKeywordSample } = await import("../projects/_components/project-keyword-sample");
const { ProjectSocialSample } = await import("../projects/_components/project-social-sample");

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnFilterRuntime>
        <RnOverviewFilters props={{ stage: "conversion", scope: { all: true } }} savedFilters={{ page: "conversion", userId: "test", initial: [] }}>
          {node}
        </RnOverviewFilters>
      </RnFilterRuntime>
    </NextIntlClientProvider>,
  );
}

/** the inert part (the sample) and the veil after it (with the notice) */
function split(html: string): { inert: string; veil: string } {
  const open = '<div inert="" class="h-full select-none">';
  const a = html.indexOf(open);
  const b = html.lastIndexOf('<div class="absolute inset-0');
  if (a < 0 || b < a) throw new Error("no veil");
  return { inert: html.slice(a + open.length, b - "</div>".length), veil: html.slice(b) };
}

describe("RnAccountGate", () => {
  it.each(["ga4", "dataforseo"] as const)("names the %s account above an inert sample", (account) => {
    const { inert, veil } = split(render(<RnAccountGate account={account}><button type="button">sample</button></RnAccountGate>));
    expect(inert).toBe('<button type="button">sample</button>');
    expect(veil).toContain(`data-rn-account-gate="${account}"`);
    for (const text of [ko.accountGate.sample, ko.accountGate[account].label, ko.accountGate.note]) expect(veil).toContain(text);
    expect(veil).toContain(ko.accountGate[account].body.replaceAll("'", "&#x27;"));
  });

  it("veils without a notice where only the inert part is wanted (the filter panel)", () => {
    const html = render(<RnSampleVeil className="h-full"><span>panel</span></RnSampleVeil>);
    expect(html).toContain('<div data-rn-sample-veil="" class="relative h-full">');
    const { inert, veil } = split(html);
    expect(inert).toBe("<span>panel</span>");
    expect(veil).toMatch(/^<div class="absolute inset-0[^"]*"><\/div>/);
  });
});

describe("samples", () => {
  it("AI Conversion: the whole measured body, inert, under the GA4 notice", () => {
    const { inert, veil } = split(render(<RnConvSample />));
    expect(veil).toContain('data-rn-account-gate="ga4"');
    expect(inert.split("data-rn-kpi=").length - 1).toBe(6);
    expect(inert).toContain("이 기간 요약");
  });

  it("keyword tools: both tools with the summary computed from the rows", () => {
    const { inert } = split(render(<RnAccountGate account="dataforseo"><KeywordSample /></RnAccountGate>));
    expect(inert).toContain('data-rn-keyword-sample="volume"');
    expect(inert).toContain('data-rn-keyword-sample="prompts"');
    // 8 keywords, total 606,200, average 75,775; high (≥ 100,000) 2 · mid 5 · low 1
    const tiles = [...inert.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*>([^<]+)<\/dd>/g)].map(([, k, v]) => `${k} ${v}`);
    expect(tiles).toEqual(["키워드 수 8", "평균 검색량 75,775", "총 검색량 606,200", "고볼륨 2", "중볼륨 5", "저볼륨 1"]);
    expect(inert).toContain("🇰🇷 한국 · ko");
  });

  // 2026-11-03 (user): Project › Intent waits on the same accounts (U3)
  it("project Google Keyword: tracked keywords, related searches, the trend's average and the search-result prompts", () => {
    const { inert, veil } = split(render(<RnAccountGate account="dataforseo"><ProjectKeywordSample /></RnAccountGate>));
    expect(veil).toContain('data-rn-account-gate="dataforseo"');
    for (const part of ["keywords", "related", "trend", "average", "serp"]) expect(inert).toContain(`data-rn-keyword-sample="${part}"`);
    // the average of the 12 monthly index values (911 / 12)
    expect(inert).toMatch(/text-rn-28[^>]*>76<span[^>]*>\/ 100<\/span>/);
    expect(inert).toContain("적용 4개");
    expect(inert).toContain("선택한 키워드 추가 · 2개 선택");
  });

  it("project Social Scraping: the context map's tables, the composer and the recommended prompts", () => {
    const { inert, veil } = split(render(<RnAccountGate account="dataforseo"><ProjectSocialSample /></RnAccountGate>));
    expect(veil).toContain('data-rn-account-gate="dataforseo"');
    for (const part of ["summary", "composer", "contexts", "conditions", "combinations", "catalog"]) expect(inert).toContain(`data-rn-social-sample="${part}"`);
    // the picks of the three tables are the composer's chips
    expect([...inert.matchAll(/aria-label="([^"]+) 빼기"/g)].map(([, name]) => name)).toEqual(["첫 차 구매", "자녀 출산 · 육아", "실구매가 · 보조금", "1회 충전 주행거리 × 충전 인프라 접근성"]);
    expect(inert).toContain("1–6 / 전체 48");
    expect(inert).toContain("3개 선택됨");
  });
});
