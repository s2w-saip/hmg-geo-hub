import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { CitationToneUrlPage } from "@/lib/db/repositories/scope-aggregates";

// Tone URL sub page tab counts (B045). The server skips with_counts on a cursor / search move made
// inside the screen and hands `counts` null; the screen then draws the counts it got for the same
// filters (the tab, q, page, cursor and domain switch never change them, BG-27). The values shown
// are the same as when the server counted them again; with nothing remembered it is the former
// degrade text ("—").

const st = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation/tone-urls",
  useSearchParams: () => new URLSearchParams(st.search),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const { CitationToneUrlsPage, recallToneCounts, rememberToneCounts, toneCountsKey } = await import("./citation-tone-urls-page");

const PAGE: CitationToneUrlPage & { nextCursor?: string | null; win: { page: number; pages: number; from: number; to: number } } = {
  rows: [{ url: "https://hyundai.news/eu/x", domain: "hyundai.news", title: "Hyundai news", promptText: null, citations: 42, providers: ["ChatGPT"], category: "Official (HMG)" }],
  total: 120,
  page: 2,
  pageSize: 50,
  nextCursor: "n3",
  win: { page: 2, pages: 3, from: 51, to: 100 },
};
const T = ko.answerAnalysis.citations.v2.toneUrlsPage;
const tab = (k: "positiveTab" | "negativeTab", n: string) => T[k].replace("{n}", n);

function render(counts: { positive: number | null; negative: number | null } | null) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <CitationToneUrlsPage tone="positive" page={PAGE} q="ev" byDomain={false} counts={counts} />
    </NextIntlClientProvider>,
  );
}

/** A tab's sessionStorage (the screen only touches it in the browser: `window` present). */
function stubBrowserStore(): Map<string, string> {
  const m = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
  });
  return m;
}

beforeEach(() => {
  st.search = "geography=US&tone=positive&q=ev&page=2&cursor=c1";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toneCountsKey: the filters only", () => {
  it("drops tab, search, page, cursor and the domain switch; order does not matter", () => {
    expect(toneCountsKey("tone=negative&q=ev&page=3&cursor=c9&by=domain&geography=US&engine=chatgpt")).toBe("engine=chatgpt&geography=US");
    expect(toneCountsKey("engine=chatgpt&geography=US")).toBe(toneCountsKey("geography=US&engine=chatgpt&tone=positive"));
    expect(toneCountsKey("geography=KR")).not.toBe(toneCountsKey("geography=US"));
  });
});

describe("remember / recall", () => {
  it("keeps numeric counts per filter key; degrade values never overwrite; no browser -> nothing", () => {
    expect(recallToneCounts("geography=US")).toBeNull(); // server render: no window
    rememberToneCounts("geography=US", { positive: 3, negative: 1 }); // no-op without window
    const m = stubBrowserStore();
    expect(m.size).toBe(0);
    rememberToneCounts("geography=US", { positive: 3, negative: 1 });
    rememberToneCounts("geography=US", { positive: null, negative: null });
    expect(recallToneCounts("geography=US")).toEqual({ positive: 3, negative: 1 });
    expect(recallToneCounts("geography=KR")).toBeNull();
    m.set("hgh.toneUrlCounts:geography=KR", "{bad json");
    expect(recallToneCounts("geography=KR")).toBeNull();
  });
});

describe("CitationToneUrlsPage tab counts", () => {
  it("served counts are drawn as before", () => {
    const html = render({ positive: 348, negative: 665 });
    expect(html).toContain(tab("positiveTab", "348"));
    expect(html).toContain(tab("negativeTab", "665"));
  });

  it("counts null with the counts of the same filters remembered: the same markup as if counted again", () => {
    stubBrowserStore();
    rememberToneCounts(toneCountsKey(st.search), { positive: 348, negative: 665 });
    expect(render(null)).toBe(render({ positive: 348, negative: 665 }));
  });

  it("counts null with counts of other filters only, or nothing remembered: the former degrade text '—'", () => {
    stubBrowserStore();
    rememberToneCounts(toneCountsKey("geography=KR"), { positive: 1, negative: 2 });
    const html = render(null);
    expect(html).toBe(render({ positive: null, negative: null }));
    expect(html).toContain(tab("positiveTab", "—"));
    vi.unstubAllGlobals();
    expect(render(null)).toBe(render({ positive: null, negative: null }));
  });
});
