import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceWeekView } from "@/lib/service-week";
import type { ServiceWeekContextValue } from "./provider";

// The shells' service week provider (provider.tsx) as it runs in a tab. What an answer does is sync.ts's
// (sync.test.ts); this is the wiring that feeds it: the layout's read is adopted and read again once known (review
// r1-16), a page or filter change and the tab coming back read it again, a moved week re-reads the page
// (router.refresh), and none of it happens on a page the BFF does not hold to the week. The render tests
// (service-week.render.test.tsx) run no effect, so any of it could be lost unnoticed (review r1-17, 2026-11-03).
//
// React DOM's client renders the provider here. It makes no element of its own, so a document that keeps its
// listeners is all it needs (the front has no DOM library for its tests).

const nav = vi.hoisted(() => ({ path: "/ko/renewal/dashboard", search: "", refresh: (() => {}) as () => void }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ refresh: nav.refresh, replace: () => {}, push: () => {} }),
}));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { RnServiceWeekProvider, ServiceWeekShownEnd, serviceWeekContext, useServiceWeekEnd } = await import("./provider");

type Visibility = "visible" | "hidden";

/** A tab's document as far as React DOM's root and the provider use it: listeners and the visibility state. */
function fakeDocument() {
  const listeners = new Map<string, Set<() => void>>();
  const doc = {
    visibilityState: "visible" as Visibility,
    activeElement: null,
    body: null,
    defaultView: null as unknown,
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    /** the tab turns hidden or visible */
    turn(state: Visibility) {
      doc.visibilityState = state;
      for (const fn of [...(listeners.get("visibilitychange") ?? [])]) fn();
    },
    listening: (type: string) => listeners.get(type)?.size ?? 0,
  };
  doc.defaultView = { document: doc, event: undefined, HTMLIFrameElement: class {} };
  return doc;
}

const PAGE = "/ko/renewal/dashboard";
const PROJECT = "/ko/renewal/projects";
const WEBSITE = "/ko/renewal/website/answer-analysis/citation";
const GA4 = "/ko/renewal/standard/ai-funnel/visibility";

const view = (end: string, over: Partial<ServiceWeekView> = {}): ServiceWeekView => ({
  state: "ok",
  week: { start: "2026-10-05", end, month: 10, nth: 2 },
  delay: null,
  checkedAt: "2026-11-02T12:10:00Z",
  recordedAt: "2026-10-12T01:10:00Z",
  notes: [],
  ...over,
});

let doc: ReturnType<typeof fakeDocument>;
/** what GET /api/service-week answers now */
let answer: ServiceWeekView;
const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }));
const refresh = vi.fn();
const reload = vi.fn();
const urls = () => fetchMock.mock.calls.map((c) => c[0]);
/** the provider's value as its children read it */
let ctxNow: ServiceWeekContextValue | null = null;
const mounted: Array<() => Promise<void>> = [];

function Probe() {
  ctxNow = React.useContext(serviceWeekContext());
  return null;
}

/** the pickers' end (useServiceWeekEnd) and the printed period's (ServiceWeekShownEnd) as the page's children read them */
let ends: { pickers?: string | null; printed?: string | null } = {};
function EndProbe() {
  ends.pickers = useServiceWeekEnd();
  return <ServiceWeekShownEnd>{(end) => <Printed end={end} />}</ServiceWeekShownEnd>;
}
function Printed({ end }: { end: string | null }) {
  ends.printed = end;
  return null;
}

/** lets the reads in flight land: the layout's promise, the fetch and its body, the state they set */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const goTo = (at: string) => {
  const [path, search = ""] = at.split("?");
  nav.path = path;
  nav.search = search;
};

/** The shell rendered at `at` with the layout's read `week`; `go` = a soft navigation (the layout keeps its read), `layout` = the layout rendered anew (router.refresh). */
async function mount(week: ServiceWeekView | null, at: string, notes = false, page = <Probe />) {
  goTo(at);
  const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", textContent: "", ownerDocument: doc, addEventListener() {}, removeEventListener() {} };
  const root = createRoot(container as unknown as Element);
  let read = Promise.resolve(week);
  const render = async () => {
    await React.act(async () => {
      root.render(
        <RnServiceWeekProvider week={read} notes={notes}>
          {page}
        </RnServiceWeekProvider>,
      );
    });
    await settle();
  };
  let gone = false;
  const unmount = async () => {
    if (gone) return;
    gone = true;
    await React.act(async () => root.unmount());
  };
  mounted.push(unmount);
  await render();
  return {
    go: async (to: string) => {
      goTo(to);
      await render();
    },
    layout: async (next: ServiceWeekView | null) => {
      read = Promise.resolve(next);
      await render();
    },
    unmount,
  };
}

const turn = async (state: Visibility) => {
  await React.act(async () => doc.turn(state));
  await settle();
};

beforeEach(() => {
  doc = fakeDocument();
  vi.stubGlobal("window", doc.defaultView);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  refresh.mockClear();
  reload.mockClear();
  (doc.defaultView as unknown as { location: unknown }).location = { reload };
  nav.refresh = refresh;
  ctxNow = null;
  ends = {};
});

afterEach(async () => {
  for (const unmount of mounted.splice(0)) await unmount();
  vi.unstubAllGlobals();
});

describe("RnServiceWeekProvider: once the layout's read is known (review r1-16)", () => {
  // The layout's read and the page body's screens are separate BFF requests, and the BFF serves its kept week at once
  // while it reads the next one behind it: a page read as the BFF moved on showed the chip on one week and the body on
  // another until the next page change or tab switch.
  it("the week is read once more; another end re-reads the page", async () => {
    answer = view("2026-10-18");
    await mount(view("2026-10-11"), PAGE);
    expect(urls()).toEqual(["/api/service-week"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(ctxNow?.latest?.week?.end).toBe("2026-10-18");
  });

  it("the same end: the chip takes the answer (a later Gold check), the page is not read again", async () => {
    answer = view("2026-10-11", { checkedAt: "2026-11-02T13:10:00Z" });
    await mount(view("2026-10-11"), PAGE);
    expect(urls()).toEqual(["/api/service-week"]);
    expect(refresh).not.toHaveBeenCalled();
    expect(ctxNow?.latest?.checkedAt).toBe("2026-11-02T13:10:00Z");
  });

  it("in the renewal shell a moved week loads the page again; the URL and its filters stay, nothing else re-reads", async () => {
    answer = view("2026-10-11");
    await mount(view("2026-10-11"), PAGE, true);
    expect(reload).not.toHaveBeenCalled();
    answer = view("2026-10-18");
    await turn("visible");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("the (dash) shell keeps its refresh", async () => {
    answer = view("2026-10-11");
    await mount(view("2026-10-11"), PAGE);
    answer = view("2026-10-18");
    await turn("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("a week just moved to, read by the page load the move brought, does not load it again", async () => {
    answer = view("2026-10-18");
    await mount(view("2026-10-18", { justMoved: true }), PAGE, true);
    expect(reload).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a week the BFF had just moved to when the layout read it re-reads the page once", async () => {
    // the other order: the body read just before the move, the layout just after — the read again answers the
    // layout's week, so only the BFF can tell (justMoved)
    answer = view("2026-10-18");
    const tab = await mount(view("2026-10-18", { justMoved: true }), PAGE);
    expect(refresh).toHaveBeenCalledTimes(1);
    // the refresh renders the layout anew: its read, moments after the move as well, asks for nothing more
    await tab.layout(view("2026-10-18", { justMoved: true }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(urls()).toEqual(["/api/service-week", "/api/service-week"]);
  });

  it("a Website page reads it with its site picks in the renewal shell (its notes), the (dash) shell without", async () => {
    answer = view("2026-10-11");
    await mount(view("2026-10-11"), `${WEBSITE}?brand=Genesis&time=2026-07-01..2026-07-31`, true);
    expect(urls()).toEqual(["/api/service-week?brand=Genesis"]);
    fetchMock.mockClear();
    // the language and the engine pick its sites too (review r5-1)
    await mount(view("2026-10-11"), `${WEBSITE}?language=de&engine=deepseek&time=2026-07-01..2026-07-31`, true);
    expect(urls()).toEqual(["/api/service-week?language=de&engine=deepseek"]);
    fetchMock.mockClear();
    await mount(view("2026-10-11"), "/ko/website/answer-analysis/citation?brand=Genesis");
    expect(urls()).toEqual(["/api/service-week"]);
  });
});

describe("RnServiceWeekProvider: read again later (review r1-17)", () => {
  it("on a page or filter change; not on a render of the same page", async () => {
    answer = view("2026-10-11");
    const tab = await mount(view("2026-10-11"), PAGE);
    const known = fetchMock.mock.calls.length;
    await tab.go(PAGE);
    expect(fetchMock.mock.calls.length).toBe(known);
    await tab.go(`${PAGE}?time=2026-09-01..2026-09-30`);
    expect(fetchMock.mock.calls.length).toBe(known + 1);
    await tab.go("/ko/renewal/standard/answer-analysis/citation?time=2026-09-01..2026-09-30");
    expect(fetchMock.mock.calls.length).toBe(known + 2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a change that finds another end re-reads the page once, and the chip shows it", async () => {
    answer = view("2026-10-11");
    const tab = await mount(view("2026-10-11"), PAGE);
    answer = view("2026-10-18"); // the cron advanced the week
    await tab.go(`${PAGE}?time=2026-09-01..2026-09-30`);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(ctxNow?.latest?.week?.end).toBe("2026-10-18");
    await tab.go(PAGE);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("when the tab comes back; not when it goes hidden", async () => {
    answer = view("2026-10-11");
    await mount(view("2026-10-11"), PAGE);
    const known = fetchMock.mock.calls.length;
    await turn("hidden");
    expect(fetchMock.mock.calls.length).toBe(known);
    answer = view("2026-10-18");
    await turn("visible");
    expect(fetchMock.mock.calls.length).toBe(known + 1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a new layout read (the refresh's) is the week compared and the one the chip shows", async () => {
    answer = view("2026-10-11");
    const tab = await mount(view("2026-10-11"), PAGE);
    answer = view("2026-10-18");
    await tab.layout(view("2026-10-18"));
    expect(ctxNow?.latest?.week?.end).toBe("2026-10-18");
    await tab.go(`${PAGE}?time=2026-09-01..2026-09-30`);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("nothing on a page the BFF does not hold to the week: no read, no re-read, a move or not", async () => {
    answer = view("2026-10-18");
    const tab = await mount(view("2026-10-18", { justMoved: true }), PROJECT);
    await tab.go(`${PROJECT}?tab=prompts`);
    await turn("hidden");
    await turn("visible");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(ctxNow?.applies).toBe(false);
  });

  it("인용 출처 분류 by its tab: nothing on 코드표 (no Gold round), read again on a tab of the latest round (review r3-9)", async () => {
    const SOURCES = "/ko/renewal/admin/standards/citation-sources";
    answer = view("2026-10-11");
    const tab = await mount(view("2026-10-11"), `${SOURCES}?tab=codes`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctxNow?.applies).toBe(false);
    await tab.go(`${SOURCES}?tab=seeds`);
    expect(urls()).toEqual(["/api/service-week"]);
    expect(ctxNow?.applies).toBe(true);
    await tab.go(`${SOURCES}?tab=codes`);
    await turn("hidden");
    await turn("visible");
    expect(urls()).toEqual(["/api/service-week"]);
    expect(ctxNow?.applies).toBe(false);
  });

  it("unmounted, it stops listening to the tab", async () => {
    answer = view("2026-10-11");
    const tab = await mount(view("2026-10-11"), PAGE);
    expect(doc.listening("visibilitychange")).toBe(1);
    await tab.unmount();
    expect(doc.listening("visibilitychange")).toBe(0);
  });
});

describe("RnServiceWeekProvider: a soft navigation over a move (review r5-2)", () => {
  // The read again on a page change goes out while the new page renders, so it can reach the BFF before the page's
  // screens — first in, or while a read of the week one of them started is out. The BFF reads the week again before
  // it answers the shell (back/bff/hub_stores/service_week.py fresh()), so the answer is the week those screens take,
  // not the kept one before it: the chip, the delay note and the pickers on 10-11 over a body of 10-18, with nothing
  // read again, was what a check served the kept week left.
  it("the check names the week the new page's screens take: the page is read again once, the chip and the pickers move with it", async () => {
    answer = view("2026-10-11");
    const tab = await mount(view("2026-10-11"), PAGE, false, (
      <>
        <Probe />
        <EndProbe />
      </>
    ));
    expect(refresh).not.toHaveBeenCalled();
    answer = view("2026-10-18", { justMoved: true }); // the BFF moved on as it answered the check
    await tab.go("/ko/renewal/standard/answer-analysis/citation");
    expect([refresh.mock.calls.length, ctxNow?.latest?.week?.end, ends.pickers]).toEqual([1, "2026-10-18", "2026-10-18"]);
    // the re-read renders the layout anew: its read, moments after the move as well, asks for nothing more
    await tab.layout(view("2026-10-18", { justMoved: true }));
    expect([refresh.mock.calls.length, ctxNow?.read]).toEqual([1, 1]);
    await tab.go(PAGE);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(urls()).toEqual(["/api/service-week", "/api/service-week", "/api/service-week", "/api/service-week"]);
  });
});

describe("RnServiceWeekProvider: the page's read (review r3-4)", () => {
  // The browser's reads on top of the page's answer (a table's next rows, a 분포 sheet, a row's detail) were kept by
  // the URL alone, and router.refresh keeps client state: they went on showing the week before. They are kept by the
  // page's read, which only the layout's render anew moves — the body takes its new answer in the same render.
  it("one more when the layout renders anew (router.refresh); not on a page change, a read again or the chip's move", async () => {
    answer = view("2026-10-11");
    const tab = await mount(view("2026-10-11"), PAGE);
    expect(ctxNow?.read).toBe(0);
    await tab.go(`${PAGE}?time=2026-09-01..2026-09-30`);
    await turn("hidden");
    await turn("visible");
    expect(ctxNow?.read).toBe(0);
    // the move: the chip takes the new week at once and the page is asked for again — its answer is not there yet
    answer = view("2026-10-18");
    await turn("hidden");
    await turn("visible");
    expect([refresh.mock.calls.length, ctxNow?.latest?.week?.end, ctxNow?.read]).toEqual([1, "2026-10-18", 0]);
    // the refresh lands: the layout renders anew, the body with it
    await tab.layout(view("2026-10-18"));
    expect(ctxNow?.read).toBe(1);
    await tab.go(PAGE);
    expect(ctxNow?.read).toBe(1);
  });
});

describe("RnServiceWeekProvider: the end the page's pickers and printed period take (review r3-8)", () => {
  // The shell reads the week on every page, the GA4 pages among them, where the BFF reads GA4's days up to its latest
  // one: only `applies` keeps the week's end off their date pickers (useServiceWeekEnd) and their printed period
  // (ServiceWeekShownEnd, review r3-6). No test held it — without it the GA4 pickers stopped at the Gold week.
  it("the week's end on a page held to it; none on a GA4 page of either shell or on Project", async () => {
    answer = view("2026-10-11");
    for (const [at, end] of [
      [PAGE, "2026-10-11"],
      [GA4, null],
      ["/ko/standard/ai-funnel/visibility", null],
      [PROJECT, null],
    ] as const) {
      ends = {};
      const tab = await mount(view("2026-10-11"), at, false, <EndProbe />);
      expect(ends, at).toEqual({ pickers: end, printed: end });
      await tab.unmount();
    }
  });
});
