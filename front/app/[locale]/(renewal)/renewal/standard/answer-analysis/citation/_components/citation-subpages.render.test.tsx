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
const { rememberToneCounts, toneCountsKey } = await import("@/app/[locale]/(dash)/standard/answer-analysis/_components/citation-tone-urls-page");
const ServiceWeekContext = (await import("@/components/service-week/provider")).serviceWeekContext();

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

  // The service week (2026-11-02): tab counts kept for the same filters before the week advanced are not drawn
  // beside the new week's rows (an in-page move gets counts null from the BFF). The week is the one the page's answer
  // was read under (citation/tone-urls `weekEnd`), not the shell's, which moves first (review r3-5).
  it("tone URL tab counts kept under the previous service week are not drawn under the new one", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    try {
      const next = { state: "ok" as const, week: { start: "2026-10-12", end: "2026-10-18", month: 10, nth: 3 }, delay: null, checkedAt: null, recordedAt: null, notes: [] };
      const under = (end: string) =>
        render(
          // the shell already shows the next week: the counts follow the answer's
          <ServiceWeekContext.Provider value={{ initial: Promise.resolve(next), latest: next, applies: true, surface: "global" }}>
            <RnCitationToneUrlsView tone="positive" q="" byDomain={false} counts={null} weekEnd={end} page={{ rows: [], total: 1, page: 1, pageSize: 50, nextCursor: null, win: { page: 1, pages: 1, from: 1, to: 1 } } as never} />
          </ServiceWeekContext.Provider>,
        );
      rememberToneCounts(toneCountsKey("page=100&cursor=4950", "2026-10-11"), { positive: 348, negative: 665 });
      expect(under("2026-10-18")).toContain("긍정 답변에 인용된 URL(—)");
      expect(under("2026-10-11")).toContain("긍정 답변에 인용된 URL(348)");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an empty list of a snapshot the service week holds no round of says 측정 없음 and the week, not the conditions", () => {
    // review r1-19 (2026-11-03): the BFF reads no snapshot of a surface the week holds no round of, and the lists said
    // '조건에 맞는 프롬프트가 없습니다' — no condition brings a round back
    const view = (global: boolean) => ({ state: "ok" as const, week: { start: "2026-07-27", end: "2026-08-02", month: 7, nth: 5 }, delay: null, checkedAt: null, recordedAt: null, rounds: { global, website: true }, notes: [] });
    const empty = { rows: [], total: 0, page: 1, pageSize: 50, nextCursor: null, win: { page: 1, pages: 1, from: 0, to: 0 } } as never;
    const under = (global: boolean, node: ReactNode) =>
      render(<ServiceWeekContext.Provider value={{ initial: Promise.resolve(view(global)), latest: view(global), applies: true, surface: "global" }}>{node}</ServiceWeekContext.Provider>);
    const prompts = <RnCitationPromptsView tab="owned" q="SUV" ownedCount={null} uncitedCount={null} page={empty} />;
    const tones = <RnCitationToneUrlsView tone="positive" q="" byDomain={false} counts={null} page={empty} />;
    const said = "서비스 기준 주 7월 5주차(7/27~8/2)에는 Global 측정 회차가 없습니다.";
    expect(under(false, prompts)).toContain(said);
    expect(under(false, prompts)).not.toContain(ko.answerAnalysis.citations.v2.promptsPage.empty);
    expect(under(false, tones)).toContain(said);
    // a round of the surface in the week: the list's own words
    expect(under(true, prompts)).toContain(ko.answerAnalysis.citations.v2.promptsPage.empty);
    expect(under(true, tones)).not.toContain(said);
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

  it("a tone URL row whose source has no category shows '—', not Gold's Other (renewal audit 9-6)", () => {
    const row = (category: string | null, domain: string) => ({ url: `https://${domain}/a`, domain, title: domain, promptText: null, citations: 2, providers: ["chatgpt"], category });
    const html = render(
      <RnCitationToneUrlsView
        tone="negative"
        q=""
        byDomain={false}
        counts={{ positive: 2, negative: 2 }}
        page={{ rows: [row(null, "a.com"), row("Other", "b.com")], total: 2, page: 1, pageSize: 50, nextCursor: null, win: { page: 1, pages: 1, from: 1, to: 2 } } as never}
      />,
    );
    const chips = [...html.matchAll(/text-rn-11 text-rn-ink-2">([^<]*)</g)].map((m) => m[1]);
    expect(chips).toEqual(["—", ko.citationCategories.other]);
  });

  it("the tone list says what the URLs are, no advice (renewal audit 9-2)", () => {
    const sub = ko.renewal.citation.sub;
    for (const s of [sub.positiveSub, sub.negativeSub, ko.renewal.citation.tone.subtitle]) {
      expect(s).not.toMatch(/유지|확산|대응|필요/);
    }
  });
});
