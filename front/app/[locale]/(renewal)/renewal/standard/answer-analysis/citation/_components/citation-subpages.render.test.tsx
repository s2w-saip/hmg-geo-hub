import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";

// Renewal Citation sub pages (공식(당사) URL 인용/미인용 프롬프트 · 긍정/부정 답변에 인용된 URL): the numbers in the
// list header and pager read like the tab counts next to them (2026-10-29 metric review, sub pages #4 #5 #21 #22:
// "1–50 / 총 5646개" beside "인용 프롬프트(5,646)"), and the row count says it is the prompt's every citation (#7).

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/answer-analysis/citation/prompts",
  useSearchParams: () => new URLSearchParams("page=100&cursor=4950"),
}));

const { RnCitationPromptsView, RnCitationToneUrlsView } = await import("./citation-subpages");

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );

const prompt = { id: "p1", promptText: "best family SUV", funnelStage: null, citations: 3330, providers: ["chatgpt"], answers: [] };

describe("renewal Citation sub pages", () => {
  it("prompt list: range, total and pager with thousands separators; the count column is every citation", () => {
    const html = render(
      <RnCitationPromptsView
        tab="owned"
        q=""
        ownedCount={5646}
        uncitedCount={5758}
        page={{ rows: [prompt], total: 5646, page: 100, pageSize: 50, nextCursor: "5000", win: { page: 100, pages: 113, from: 4951, to: 5000 } } as never}
      />,
    );
    expect(html).toContain("인용 프롬프트(5,646)");
    expect(html).toContain("4,951–5,000 / 총 5,646개");
    expect(html).not.toContain("총 5646개");
    expect(html).toContain("3,330");
    expect(html).toContain(ko.renewal.citation.sub.colCitations);
  });

  it("tone URL list: range, total and pager with thousands separators", () => {
    const html = render(
      <RnCitationToneUrlsView
        tone="positive"
        q=""
        byDomain={false}
        counts={{ positive: 226805, negative: 10877 }}
        page={{ rows: [], total: 226805, page: 1, pageSize: 50, nextCursor: "50", win: { page: 1, pages: 4537, from: 1, to: 50 } } as never}
      />,
    );
    expect(html).toContain("(226,805)");
    expect(html).toContain("1–50 / 총 226,805개");
    expect(html).toContain("1 / 4,537");
    expect(html).not.toContain("226805");
  });
});
