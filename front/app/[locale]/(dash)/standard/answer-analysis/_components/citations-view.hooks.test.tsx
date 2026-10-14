import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The client table and drilldown hooks of the API source (unit U7), run for real under a minimal
// hooks runtime with React's rules: state updates re-render (batched in a microtask), an effect
// re-runs only when a dep changed (Object.is) and the previous cleanup runs first, memo / callback
// keep their value while deps are equal, refs persist. There is no DOM renderer in this repo
// (no jsdom, no testing library), so the React hooks the module imports are swapped for this
// runtime; everything else in the module is the real code.
//
// Regressions of the U7 verification:
//   D1 an opened domain row kept the previous filter's drilldown (no new request) after the filters
//      changed, because the page's client state survives a search param change
//   D2 a 409 cursor_stale on "load more" emptied the table for good (search / sort mode), and in
//      the default order every further "load more" reused the stale server cursor
//   D3 a double click appended the same page twice; a "load more" answer that arrived after a
//      switch to search overwrote the search state
// P6:
//   B047 an opened row keeps the counts before the detail caps (urlTotal / promptTotal) for the
//        truncation line, only when the route sends them
//   B048/B049 the export buttons run one export at a time, a failure becomes the existing toast
//        (no raw JSON page, no silent failure), and the API file keeps its Content-Disposition name

type Deps = readonly unknown[] | undefined;
type Slot = { v?: unknown; deps?: Deps; cleanup?: (() => void) | void };

const rt = vi.hoisted(() => {
  let slots: Slot[] = [];
  let idx = 0;
  let pending: { i: number; fn: () => (() => void) | void; deps: Deps }[] = [];
  let renderFn: (() => void) | null = null;
  let scheduled = false;
  const changed = (a: Deps, b: Deps) => !a || !b || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
  const schedule = () => {
    if (scheduled || !renderFn) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      renderFn?.();
    });
  };
  function useState<T>(init: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const i = idx++;
    if (!slots[i]) slots[i] = { v: typeof init === "function" ? (init as () => T)() : init };
    const s = slots[i];
    const set = (next: T | ((prev: T) => T)) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(s.v as T) : next;
      if (Object.is(v, s.v)) return;
      s.v = v;
      schedule();
    };
    return [s.v as T, set];
  }
  function useEffect(fn: () => (() => void) | void, deps?: Deps) {
    const i = idx++;
    const prev = slots[i];
    if (!prev || changed(deps, prev.deps)) pending.push({ i, fn, deps });
  }
  function memoSlot<T>(fn: () => T, deps: Deps): T {
    const i = idx++;
    const prev = slots[i];
    if (!prev || changed(deps, prev.deps)) slots[i] = { v: fn(), deps };
    return slots[i].v as T;
  }
  function callbackSlot<T>(fn: T, deps: Deps): T {
    return memoSlot(() => fn, deps);
  }
  function useRef<T>(init: T): { current: T } {
    const i = idx++;
    if (!slots[i]) slots[i] = { v: { current: init } };
    return slots[i].v as { current: T };
  }
  function mount<P, R>(hook: (p: P) => R, props: NoInfer<P>) {
    slots = [];
    scheduled = false;
    let p = props;
    const result = { current: undefined as R };
    renderFn = () => {
      idx = 0;
      pending = [];
      result.current = hook(p);
      const effects = pending;
      for (const e of effects) slots[e.i]?.cleanup?.();
      for (const e of effects) slots[e.i] = { deps: e.deps, cleanup: e.fn() };
    };
    renderFn();
    return {
      result,
      rerender(next: NoInfer<P>) {
        p = next;
        renderFn!();
      },
    };
  }
  return { useState, useEffect, useMemo: memoSlot, useCallback: callbackSlot, useRef, mount };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: rt.useState,
    useEffect: rt.useEffect,
    useMemo: rt.useMemo,
    useCallback: rt.useCallback,
    useRef: rt.useRef,
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/website/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));
vi.mock("server-only", () => ({}));
// The export notice reads a message key and raises a toast: both are swapped for recorders here.
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return { ...actual, useTranslations: (ns: string) => (key: string) => `${ns}.${key}` };
});

const { downloadDomainExport, runExportTask, useDomainDetail, useExportFailedNotice, useExportTask, useServerDomainTable } = await import(
  "./citations-view"
);
const { domainDetailUrl } = await import("../_data/citation-view");

// ── a controllable fetch: every call waits until the test answers it; abort rejects it ──
type Call = { url: string; signal?: AbortSignal; reply: (status: number, body: unknown) => void };
let calls: Call[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", (url: string, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      calls.push({ url, signal, reply: (status, body) => resolve(new Response(JSON.stringify(body), { status })) });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => {
  for (let k = 0; k < 20; k++) await new Promise((r) => setTimeout(r, 0));
};
const qs = (url: string) => new URLSearchParams(url.slice(url.indexOf("?") + 1));

// ── D1 ──────────────────────────────────────────────────────────────────────

describe("useDomainDetail: the loaded detail belongs to its URL (D1)", () => {
  const chat = domainDetailUrl("surface=website&engine=chatgpt", "a.example");
  const gem = domainDetailUrl("surface=website&engine=gemini", "a.example");
  const detail = (tag: string) => ({ urls: [{ url: `https://a.example/${tag}`, title: "", count: 1, aiProvider: "", promptText: "", country: null }], promptList: [] });

  it("open row + filter change -> a new request, the old filter's list is not shown, reopen keeps the new one", async () => {
    const h = rt.mount((p: { url: string; open: boolean }) => useDomainDetail(p.url, p.open), { url: chat, open: true });
    expect(calls.map((c) => c.url)).toEqual([chat]);
    calls[0].reply(200, detail("chatgpt"));
    await flush();
    expect(h.result.current).toMatchObject({ status: "ready", urls: [{ url: "https://a.example/chatgpt" }] });

    // filters change while the row stays open (the page keeps its client state)
    h.rerender({ url: gem, open: true });
    expect(h.result.current).toBeNull(); // never the chatgpt list under the gemini filters
    await flush();
    expect(calls.map((c) => c.url)).toEqual([chat, gem]);
    calls[1].reply(200, detail("gemini"));
    await flush();
    expect(h.result.current).toMatchObject({ status: "ready", urls: [{ url: "https://a.example/gemini" }] });

    // close and reopen on the same filters: kept, no request
    h.rerender({ url: gem, open: false });
    await flush();
    h.rerender({ url: gem, open: true });
    await flush();
    expect(calls).toHaveLength(2);
    expect(h.result.current).toMatchObject({ status: "ready", urls: [{ url: "https://a.example/gemini" }] });
  });

  it("closed row + filter change -> nothing is read until it opens, then the new URL", async () => {
    const h = rt.mount((p: { url: string; open: boolean }) => useDomainDetail(p.url, p.open), { url: chat, open: true });
    calls[0].reply(200, detail("chatgpt"));
    await flush();
    h.rerender({ url: chat, open: false });
    h.rerender({ url: gem, open: false });
    await flush();
    expect(calls).toHaveLength(1);
    h.rerender({ url: gem, open: true });
    await flush();
    expect(calls.map((c) => c.url)).toEqual([chat, gem]);
    expect(h.result.current).toMatchObject({ status: "loading" });
  });

  it("filter change while the first load is in flight: that load is cut and its late answer is dropped", async () => {
    const h = rt.mount((p: { url: string; open: boolean }) => useDomainDetail(p.url, p.open), { url: chat, open: true });
    h.rerender({ url: gem, open: true });
    await flush();
    expect(calls[0].signal?.aborted).toBe(true);
    calls[1].reply(200, detail("gemini"));
    await flush();
    expect(h.result.current).toMatchObject({ status: "ready", urls: [{ url: "https://a.example/gemini" }] });
  });
});

// ── D2 / D3 ─────────────────────────────────────────────────────────────────

type TableProps = { q: string; query?: string; nextCursor?: string | null };
const row = (domain: string, rank: number) => ({
  domain,
  citations: 10,
  share: 1,
  prompts: 1,
  coverageRate: 1,
  urls: [],
  promptList: [],
  isOurs: false,
  category: "Automotive Media",
  subcategory: null,
  skey: domain,
  rank,
  matchRank: rank,
});
const INITIAL = [row("a", 1), row("b", 2)];
const useTable = (p: TableProps) =>
  useServerDomainTable({
    source: { query: p.query ?? "surface=website", nextCursor: p.nextCursor === undefined ? "s1" : p.nextCursor, total: 9 },
    initial: INITIAL,
    q: p.q,
    sortKey: "citations",
    asc: false,
    pageSize: 2,
  });
const domains = (h: { result: { current: { rows: { domain: string }[] } } }) => h.result.current.rows.map((r) => r.domain);

describe("useServerDomainTable: 409 cursor_stale restarts from page one (D2)", () => {
  it("search mode: the table reloads page one instead of staying empty", async () => {
    const h = rt.mount(useTable, { q: "k" });
    await flush();
    expect(qs(calls[0].url).get("cursor")).toBeNull();
    calls[0].reply(200, { rows: [row("k1", 1), row("k2", 2)], nextCursor: "c2", total: 5 });
    await flush();
    expect(domains(h)).toEqual(["k1", "k2"]);

    h.result.current.loadMore();
    await flush();
    expect(qs(calls[1].url).get("cursor")).toBe("c2");
    calls[1].reply(409, { error: "cursor_stale" });
    await flush();
    // a new first-page request is out (no cursor, same search)
    expect(calls).toHaveLength(3);
    expect([qs(calls[2].url).get("cursor"), qs(calls[2].url).get("q")]).toEqual([null, "k"]);
    expect(h.result.current.status).toBe("loading");
    calls[2].reply(200, { rows: [row("k1", 1), row("k3", 2)], nextCursor: "d2", total: 5 });
    await flush();
    expect([h.result.current.status, domains(h), h.result.current.nextCursor, h.result.current.total]).toEqual(["ready", ["k1", "k3"], "d2", 5]);
  });

  it("default order: page one is read again through the route and the fresh cursor is used after", async () => {
    const h = rt.mount(useTable, { q: "" });
    await flush();
    expect(calls).toHaveLength(0); // the server render's first page
    expect(domains(h)).toEqual(["a", "b"]);

    h.result.current.loadMore();
    await flush();
    expect(qs(calls[0].url).get("cursor")).toBe("s1");
    calls[0].reply(409, { error: "cursor_stale" });
    await flush();
    expect(calls).toHaveLength(2);
    const reread = qs(calls[1].url);
    expect([reread.get("cursor"), reread.get("sort"), reread.get("dir"), reread.get("q")]).toEqual([null, "citations", "desc", null]);
    calls[1].reply(200, { rows: [row("a", 1), row("z", 2)], nextCursor: "f2", total: 12 });
    await flush();
    expect([domains(h), h.result.current.nextCursor, h.result.current.total]).toEqual([["a", "z"], "f2", 12]);

    h.result.current.loadMore();
    await flush();
    expect(qs(calls[2].url).get("cursor")).toBe("f2"); // not the stale s1 again
    calls[2].reply(200, { rows: [row("y", 3)], nextCursor: null, total: 12 });
    await flush();
    expect([domains(h), h.result.current.nextCursor]).toEqual([["a", "z", "y"], null]);
  });

  it("a filter change after a 409 goes back to the new server page (the restart is tied to its filters)", async () => {
    const h = rt.mount(useTable, { q: "" });
    h.result.current.loadMore();
    await flush();
    calls[0].reply(409, { error: "cursor_stale" });
    await flush();
    calls[1].reply(200, { rows: [row("z", 1)], nextCursor: null, total: 1 });
    await flush();
    h.rerender({ q: "", query: "surface=website&engine=gemini", nextCursor: "g1" });
    await flush();
    expect(calls).toHaveLength(2);
    expect([domains(h), h.result.current.nextCursor]).toEqual([["a", "b"], "g1"]);
  });
});

describe("useServerDomainTable: one 'load more' at a time, stale answers dropped (D3)", () => {
  it("double click -> one request, no duplicate rows, busy while it is out", async () => {
    const h = rt.mount(useTable, { q: "" });
    h.result.current.loadMore();
    h.result.current.loadMore(); // same render: the click handler of the same button
    await flush();
    h.result.current.loadMore(); // after the re-render too
    await flush();
    expect(calls).toHaveLength(1);
    expect(h.result.current.loadingMore).toBe(true);
    calls[0].reply(200, { rows: [row("c", 3), row("d", 4)], nextCursor: "s2", total: 9 });
    await flush();
    expect([domains(h), h.result.current.loadingMore]).toEqual([["a", "b", "c", "d"], false]);
  });

  it("switch to search while 'load more' is out: it is cut, a late answer is ignored, the search shows", async () => {
    const h = rt.mount(useTable, { q: "" });
    h.result.current.loadMore();
    await flush();
    const more = calls[0];
    h.rerender({ q: "k" });
    await flush();
    expect(more.signal?.aborted).toBe(true);
    calls[1].reply(200, { rows: [row("k1", 1)], nextCursor: null, total: 1 });
    await flush();
    more.reply(200, { rows: [row("c", 3), row("d", 4)], nextCursor: "s2", total: 9 });
    await flush();
    expect([h.result.current.status, domains(h), h.result.current.loadingMore]).toEqual(["ready", ["k1"], false]);
    // back to the default order: the server page, the cut "load more" left nothing behind
    h.rerender({ q: "" });
    await flush();
    expect([domains(h), h.result.current.nextCursor, h.result.current.loadingMore]).toEqual([["a", "b"], "s1", false]);
    h.result.current.loadMore();
    await flush();
    expect(calls).toHaveLength(3);
  });
});

// ── P6 B047: the counts before the detail caps ──────────────────────────────

describe("useDomainDetail: urlTotal / promptTotal when the route sends them (B047)", () => {
  const url = domainDetailUrl("surface=website", "a.example");
  const list = { urls: [{ url: "https://a.example/1", title: "", count: 1, aiProvider: "", promptText: "", country: null }], promptList: [] };

  it("kept on the ready state when the caps cut the lists; absent otherwise (the legacy keys only)", async () => {
    const h = rt.mount((p: { url: string; open: boolean }) => useDomainDetail(p.url, p.open), { url, open: true });
    calls[0].reply(200, { ...list, urlTotal: 37, promptTotal: 250 });
    await flush();
    expect(h.result.current).toMatchObject({ status: "ready", urlTotal: 37, promptTotal: 250 });
    const other = domainDetailUrl("surface=website&engine=gemini", "a.example");
    h.rerender({ url: other, open: true });
    await flush();
    calls[1].reply(200, list);
    await flush();
    expect(Object.keys(h.result.current ?? {}).sort()).toEqual(["promptList", "status", "url", "urls"]);
  });
});

// ── P6 B048 / B049: one export at a time, failure -> the existing toast ──────

describe("export buttons: one export at a time, failures reach the existing toast (B048 / B049)", () => {
  beforeEach(() => toastError.mockReset());

  it("runExportTask: a second click while one runs is ignored; busy true while it runs; a failure goes to onError", async () => {
    const guard = { current: false };
    const busy: boolean[] = [];
    const onError = vi.fn();
    let finish!: () => void;
    const task = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const first = runExportTask(guard, (b) => busy.push(b), task, onError);
    await runExportTask(guard, (b) => busy.push(b), task, onError); // double click
    expect([task.mock.calls.length, busy]).toEqual([1, [true]]);
    finish();
    await first;
    expect([busy, onError.mock.calls.length, guard.current]).toEqual([[true, false], 0, false]);
    const boom = new Error("exceljs chunk failed");
    await runExportTask(guard, (b) => busy.push(b), () => Promise.reject(boom), onError);
    expect([onError.mock.calls, busy.slice(2), guard.current]).toEqual([[[boom]], [true, false], false]);
  });

  it("useExportTask: busy re-renders the button state; the failure notice is the existing message key", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let finish!: (fail: boolean) => void;
    const h = rt.mount(() => useExportTask(useExportFailedNotice()), undefined);
    expect(h.result.current.busy).toBe(false);
    const run = h.result.current.run(() => new Promise<void>((ok, no) => (finish = (fail) => (fail ? no(new Error("x")) : ok()))));
    await flush();
    expect(h.result.current.busy).toBe(true);
    void h.result.current.run(() => Promise.resolve()); // ignored while busy
    finish(true);
    await run;
    await flush();
    expect(h.result.current.busy).toBe(false);
    expect(toastError.mock.calls).toEqual([["standardPromptsView.exportFailed"]]);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("downloadDomainExport: 2xx -> the bytes saved under the Content-Disposition name; non-2xx -> thrown, nothing saved", async () => {
    const saved: [string, string][] = [];
    const save = async (blob: Blob, name: string) => void saved.push([await blob.text(), name]);
    const fetchOk = (cd: string | null) => async () =>
      new Response("xlsx-bytes", { status: 200, headers: cd ? { "content-disposition": cd } : {} });
    await downloadDomainExport("/api/citations/domains/export?surface=website", {
      fetchImpl: fetchOk(`attachment; filename="citation-domains.xlsx"; filename*=UTF-8''%EC%9D%B8%EC%9A%A9.xlsx`) as typeof fetch,
      save: (b, n) => void save(b, n),
    });
    await downloadDomainExport("/x", { fetchImpl: fetchOk('attachment; filename="d.xlsx"') as typeof fetch, save: (b, n) => void save(b, n) });
    await flush();
    expect(saved).toEqual([
      ["xlsx-bytes", "인용.xlsx"],
      ["xlsx-bytes", "d.xlsx"],
    ]);
    // a JSON error (401 / 403 / 422 / 5xx / timeout) no longer navigates to the raw body: it throws for the toast
    const fail = async () => new Response(JSON.stringify({ error: { code: "upstream" } }), { status: 503 });
    await expect(downloadDomainExport("/x", { fetchImpl: fail as typeof fetch, save: (b, n) => void save(b, n) })).rejects.toMatchObject({ status: 503 });
    expect(saved).toHaveLength(2);
  });
});
