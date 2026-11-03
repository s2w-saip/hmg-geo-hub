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

const st = vi.hoisted(() => ({ search: "", refresh: (() => {}) as () => void }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation/tone-urls",
  useSearchParams: () => new URLSearchParams(st.search),
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => st.refresh() }),
}));

const React = await import("react");
const { CitationToneUrlsPage, recallToneCounts, rememberToneCounts, toneCountsKey, useShownToneCounts } = await import("./citation-tone-urls-page");
const { RnServiceWeekProvider, serviceWeekContext } = await import("@/components/service-week/provider");
const { clientRoot } = await import("@/test/client-root");
const ServiceWeekContext = serviceWeekContext();

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

// The service week (2026-11-02): a snapshot URL names no round, so counts kept for the same filters before the week
// advanced would sit next to the new week's rows. The week's end is part of the key: the week the page's answer was
// read under (citation/tone-urls `weekEnd`), not the one the shell shows (review r3-5).
const view = (start: string, end: string) => ({
  state: "ok" as const,
  week: { start, end, month: 10, nth: start === "2026-10-05" ? 2 : 3 },
  delay: null,
  checkedAt: null,
  recordedAt: null,
  notes: [],
});

describe("toneCountsKey: the service week is part of it", () => {
  it("another week is another key; no week known keeps the filters-only key", () => {
    expect(toneCountsKey("geography=US", "2026-10-11")).not.toBe(toneCountsKey("geography=US", "2026-10-18"));
    expect(toneCountsKey("tone=negative&geography=US", "2026-10-11")).toBe(toneCountsKey("geography=US&q=ev", "2026-10-11"));
    expect(toneCountsKey("geography=US", null)).toBe(toneCountsKey("geography=US"));
  });

  it("counts kept under the previous week are not drawn under the new one", () => {
    stubBrowserStore();
    const under = (end: string) =>
      renderToStaticMarkup(
        <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
          <CitationToneUrlsPage tone="positive" page={PAGE} q="ev" byDomain={false} counts={null} weekEnd={end} />
        </NextIntlClientProvider>,
      );
    rememberToneCounts(toneCountsKey(st.search, "2026-10-11"), { positive: 348, negative: 665 });
    expect(under("2026-10-18")).toContain(tab("positiveTab", "—"));
    expect(under("2026-10-11")).toContain(tab("positiveTab", "348"));
  });

  it("the week is the answer's, not the one the shell already shows", () => {
    // the shell knows of the next week before the page is read again: the page's answer is still the week before's
    stubBrowserStore();
    const next = view("2026-10-12", "2026-10-18");
    rememberToneCounts(toneCountsKey(st.search, "2026-10-11"), { positive: 348, negative: 665 });
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
        <ServiceWeekContext.Provider value={{ initial: Promise.resolve(next), latest: next, applies: true, surface: "global" }}>
          <CitationToneUrlsPage tone="positive" page={PAGE} q="ev" byDomain={false} counts={null} weekEnd="2026-10-11" />
        </ServiceWeekContext.Provider>
      </NextIntlClientProvider>,
    );
    expect(html).toContain(tab("positiveTab", "348"));
  });
});

// Review r3-5 (2026-11-03): the shell learns of a moved week before the page is read again (sync.ts: the chip's view,
// then router.refresh). The key took its week from that view, so at that moment the counts of the week before were
// kept under the next week's key — and the re-read, an in-page move (q, a cursor: counts null), drew them beside the
// next week's rows. Run in React DOM's client with the shell's provider, as a tab meets it.
describe("tone tab counts across a service-week move (review r3-5)", () => {
  const W1 = view("2026-10-05", "2026-10-11");
  const W2 = view("2026-10-12", "2026-10-18");
  const shown: unknown[] = [];
  function Tabs({ served, weekEnd }: { served: { positive: number | null; negative: number | null } | null; weekEnd: string }) {
    shown.push(useShownToneCounts(served, weekEnd));
    return null;
  }
  async function settle() {
    for (let i = 0; i < 6; i += 1) await React.act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  }

  it("the week before's counts are neither kept nor drawn under the next week; the next week's are", async () => {
    let answer = W1;
    const refresh = vi.fn();
    st.refresh = refresh;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }));
    const root = clientRoot();
    const kept = new Map<string, string>();
    Object.assign(window, { sessionStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
    const nextKey = `hgh.toneUrlCounts:${toneCountsKey(st.search, "2026-10-18")}`;
    const shell = (week: Promise<typeof W1>, served: { positive: number | null; negative: number | null } | null, weekEnd: string) => (
      <RnServiceWeekProvider week={week}>
        <Tabs served={served} weekEnd={weekEnd} />
      </RnServiceWeekProvider>
    );
    // a document load under W1: the BFF counted
    const layoutW1 = Promise.resolve(W1);
    await root.render(shell(layoutW1, { positive: 348, negative: 665 }, "2026-10-11"));
    await settle();
    expect(shown.at(-1)).toEqual({ positive: 348, negative: 665 });
    // the cron moved the week; the tab comes back: the shell reads it, shows it and asks for the page again
    answer = W2;
    await root.turn("hidden");
    await root.turn("visible");
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(kept.get(nextKey)).toBeUndefined();
    // the page read again (the layout and the body anew): an in-page move, counts null, under W2
    const layoutW2 = Promise.resolve(W2);
    await root.render(shell(layoutW2, null, "2026-10-18"));
    await settle();
    expect(shown.at(-1)).toEqual({ positive: null, negative: null });
    expect(kept.get(nextKey)).toBeUndefined();
    // W2's own counts (a document load) are kept under its key and drawn on its next in-page move
    await root.render(shell(layoutW2, { positive: 400, negative: 700 }, "2026-10-18"));
    await root.render(shell(layoutW2, null, "2026-10-18"));
    await settle();
    expect(shown.at(-1)).toEqual({ positive: 400, negative: 700 });
    expect(kept.get(nextKey)).toBe(JSON.stringify({ positive: 400, negative: 700 }));
    await root.unmount();
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
