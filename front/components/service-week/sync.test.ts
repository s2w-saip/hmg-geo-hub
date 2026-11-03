import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceWeekView } from "@/lib/service-week";
import { createServiceWeekSync, fetchServiceWeek } from "./sync";

// The shells keep their layout across soft navigations, so the service week they were rendered with would stay put
// while the cron advances it. The provider reads it again on a page or filter change and when the tab comes back
// (GET /api/service-week); a different end than the one the page body was read with re-reads the body
// (router.refresh), the same end only updates what the chip shows. A failed read changes nothing. Each read carries
// the page's site picks, its notes being those sites' (the layout's read has none: a page with some reads them). The
// layout's read is read again once known, and a week the BFF had just moved to re-reads the body (review r1-16).

const view = (end: string | null, over: Partial<ServiceWeekView> = {}): ServiceWeekView => ({
  state: end ? "ok" : "unconfigured",
  week: end ? { start: "2026-10-05", end, month: 10, nth: 2 } : null,
  delay: null,
  checkedAt: "2026-11-02T12:10:00Z",
  recordedAt: "2026-10-12T01:10:00Z",
  notes: [],
  ...over,
});

function harness(answers: Array<ServiceWeekView | Error | Promise<ServiceWeekView>>) {
  const seen: ServiceWeekView[] = [];
  // the site picks each view was read with
  const picks: string[] = [];
  const refresh = vi.fn();
  const signals: AbortSignal[] = [];
  const load = vi.fn(async (signal: AbortSignal, _sites: string) => {
    signals.push(signal);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next!;
  });
  const sync = createServiceWeekSync({
    load,
    onView: (v, sites) => {
      seen.push(v);
      picks.push(sites);
    },
    refresh,
  });
  return { sync, seen, picks, refresh, load, signals };
}

describe("createServiceWeekSync", () => {
  it("the same week: the chip takes the new answer (a later Gold check), the body stays", async () => {
    const h = harness([view("2026-10-11", { checkedAt: "2026-11-02T13:10:00Z" })]);
    h.sync.adopt(view("2026-10-11"));
    await h.sync.check();
    expect(h.seen.map((v) => v.checkedAt)).toEqual(["2026-11-02T13:10:00Z"]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("an advanced week re-reads the body once", async () => {
    const h = harness([view("2026-10-18"), view("2026-10-18")]);
    h.sync.adopt(view("2026-10-11"));
    await h.sync.check();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.seen.map((v) => v.week?.end)).toEqual(["2026-10-18"]);
    await h.sync.check(); // the body now has 10-18
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("any other end re-reads the body, an earlier one too (the cron never moves back, the front does not assume it)", async () => {
    const h = harness([view("2026-10-04")]);
    h.sync.adopt(view("2026-10-11"));
    await h.sync.check();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("from no week (unconfigured) to a week re-reads the body", async () => {
    const h = harness([view("2026-10-11")]);
    h.sync.adopt(view(null));
    await h.sync.check();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("the layout could not read the week: the first answer is shown, nothing to compare it with", async () => {
    const h = harness([view("2026-10-11")]);
    h.sync.adopt(null);
    await h.sync.check();
    expect(h.seen).toHaveLength(1);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a failed read changes nothing and the body's week is still the one compared", async () => {
    const h = harness([new Error("503"), view("2026-10-18")]);
    h.sync.adopt(view("2026-10-11"));
    await h.sync.check();
    expect(h.seen).toEqual([]);
    expect(h.refresh).not.toHaveBeenCalled();
    await h.sync.check();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("a newer check wins: the older read is aborted and its answer dropped", async () => {
    let releaseFirst!: (v: ServiceWeekView) => void;
    const first = new Promise<ServiceWeekView>((r) => (releaseFirst = r));
    const h = harness([first, view("2026-10-11", { checkedAt: "2026-11-02T14:10:00Z" })]);
    h.sync.adopt(view("2026-10-11"));
    const a = h.sync.check();
    const b = h.sync.check();
    expect(h.signals[0].aborted).toBe(true);
    await b;
    releaseFirst(view("2026-10-18"));
    await a;
    expect(h.seen.map((v) => v.checkedAt)).toEqual(["2026-11-02T14:10:00Z"]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("stop() drops a read in flight", async () => {
    let release!: (v: ServiceWeekView) => void;
    const h = harness([new Promise<ServiceWeekView>((r) => (release = r))]);
    h.sync.adopt(view("2026-10-11"));
    const a = h.sync.check();
    h.sync.stop();
    expect(h.signals[0].aborted).toBe(true);
    release(view("2026-10-18"));
    await a;
    expect(h.seen).toEqual([]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a new layout read (after a refresh) becomes the week compared", async () => {
    const h = harness([view("2026-10-18")]);
    h.sync.adopt(view("2026-10-11"));
    h.sync.adopt(view("2026-10-18"));
    await h.sync.check();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("reads with the page's site picks and hands the view on with them", async () => {
    const h = harness([view("2026-10-11"), view("2026-10-11")]);
    h.sync.adopt(view("2026-10-11"));
    await h.sync.check("brand=Genesis");
    await h.sync.check();
    expect(h.load.mock.calls.map((c) => c[1])).toEqual(["brand=Genesis", ""]);
    expect(h.picks).toEqual(["brand=Genesis", ""]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("the layout's read has no site picks: adopting it on a page with some reads the page's notes", async () => {
    // review r1-7 (2026-11-03): the layout's notes are every site of the account's, a Genesis page's are Genesis'
    const h = harness([view("2026-10-11")]);
    await h.sync.adopt(view("2026-10-11"), "brand=Genesis");
    expect(h.load.mock.calls.map((c) => c[1])).toEqual(["brand=Genesis"]);
    expect(h.picks).toEqual(["brand=Genesis"]);
    expect(h.refresh).not.toHaveBeenCalled();
    // a page the BFF does not hold to the week (no picks given) reads nothing more
    const g = harness([]);
    await g.sync.adopt(view("2026-10-11"));
    await g.sync.adopt(null);
    expect(g.load).not.toHaveBeenCalled();
  });

  // Review r1-16 (2026-11-03): the layout's read and the page body's screens are separate BFF requests, and the BFF
  // serves its kept week at once while it reads the next one behind it. A page read as the BFF moved on can show the
  // chip on 10-11 and a body on 10-18: the layout's read is read again once it is known, and another end re-reads the
  // body (a page with no site picks read nothing more, and the two stayed apart until a page change or a tab switch).
  it("adopting the layout's read on a page held to the week reads it once more: another end re-reads the body", async () => {
    const h = harness([view("2026-10-18")]);
    await h.sync.adopt(view("2026-10-11"), "");
    expect(h.load.mock.calls.map((c) => c[1])).toEqual([""]);
    expect(h.seen.map((v) => v.week?.end)).toEqual(["2026-10-18"]);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // the same end: the chip takes the answer, the body stays
    const g = harness([view("2026-10-11", { checkedAt: "2026-11-02T13:10:00Z" })]);
    await g.sync.adopt(view("2026-10-11"), "");
    expect(g.seen.map((v) => v.checkedAt)).toEqual(["2026-11-02T13:10:00Z"]);
    expect(g.refresh).not.toHaveBeenCalled();
  });

  it("the BFF moved to the layout's week moments before it read it: the body re-reads once, not again for that week", async () => {
    // the other order (review r1-16): the body's screens were read just before the move, the layout's just after —
    // the chip on 10-18, a body on 10-11, and a read again answers 10-18 too. The BFF says so (justMoved)
    const h = harness([view("2026-10-18"), view("2026-10-18")]);
    await h.sync.adopt(view("2026-10-18", { justMoved: true }), "");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // the refresh renders the layout anew: its read, moments after the move too, does not ask again
    await h.sync.adopt(view("2026-10-18", { justMoved: true }), "");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // nor after a read again that found the move itself
    const g = harness([view("2026-10-18"), view("2026-10-18")]);
    await g.sync.adopt(view("2026-10-11"), "");
    expect(g.refresh).toHaveBeenCalledTimes(1);
    await g.sync.adopt(view("2026-10-18", { justMoved: true }), "");
    expect(g.refresh).toHaveBeenCalledTimes(1);
    // a week moved to long before: nothing to re-read
    const k = harness([view("2026-10-18")]);
    await k.sync.adopt(view("2026-10-18", { justMoved: false }), "");
    expect(k.refresh).not.toHaveBeenCalled();
  });

  it("a page the BFF does not hold to the week reads nothing again and re-reads nothing, a move or not", async () => {
    const h = harness([]);
    await h.sync.adopt(view("2026-10-18", { justMoved: true }));
    expect(h.load).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe("fetchServiceWeek: GET /api/service-week", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("reads the route without a cache and hands the screen's answer on", async () => {
    const fetchMock = reply(200, view("2026-10-11"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchServiceWeek(new AbortController().signal)).resolves.toEqual(view("2026-10-11"));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/service-week");
    expect(init.cache).toBe("no-store");
  });

  it("the page's site picks go with the read", async () => {
    const fetchMock = reply(200, view("2026-10-11"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchServiceWeek(new AbortController().signal, "brand=Genesis&geography=IT%7EUS");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/service-week?brand=Genesis&geography=IT%7EUS");
  });

  it("a failed status or an answer of another shape is a failed read", async () => {
    vi.stubGlobal("fetch", reply(503, { error: { code: "service_week_unavailable" } }));
    await expect(fetchServiceWeek(new AbortController().signal)).rejects.toThrow();
    vi.stubGlobal("fetch", reply(200, { error: { code: "x" } }));
    await expect(fetchServiceWeek(new AbortController().signal)).rejects.toThrow();
  });
});
