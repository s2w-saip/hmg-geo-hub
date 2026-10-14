import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Request-scoped concurrency limit of lib/hgh/client (G-25, D6): inside one server request at
// most HGH_MAX_CONCURRENT_CALLS backend calls are in flight, first come first served; outside a
// request scope nothing is limited. The request scope is React's request cache, so react is the
// react-server build here (see test/request-scope.ts).
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("./auth");
const { HGH_MAX_CONCURRENT_CALLS, HghCallLimiter, hghGet, hghPost, requestCallLimiter } = await import("./client");
const D = await import("./adapters/dashboard");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const FRESH = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ2In0.bmV3";
const BASE = "https://api.hgh.test";

// ── a fetch whose answers the test hands out one by one ──────────────────────

interface Pending {
  /** pathname + search */
  key: string;
  signal: AbortSignal | undefined;
  answer(res: Response): void;
  fail(err: unknown): void;
}

let pending: Pending[] = [];
let started: string[] = [];
let inFlight = 0;
let maxInFlight = 0;

/** Every fetch waits until the test answers it (or its signal aborts). */
function gatedFetch() {
  const fn = vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const key = `${u.pathname}${u.search}`;
    started.push(key);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<Response>((resolve, reject) => {
      let open = true;
      const close = () => {
        if (!open) return false;
        open = false;
        inFlight -= 1;
        pending = pending.filter((p) => p !== entry);
        return true;
      };
      const entry: Pending = {
        key,
        signal: init.signal ?? undefined,
        answer: (res) => close() && resolve(res),
        fail: (err) => close() && reject(err),
      };
      init.signal?.addEventListener("abort", () => close() && reject(init.signal?.reason), { once: true });
      pending.push(entry);
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Every fetch answers 200 by itself after `ms` (counts what is in flight at once). */
function autoFetch(ms: number, body: (path: string) => unknown = () => ({ data: {}, meta: { mode: "snapshot" } })) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const u = new URL(String(input));
    started.push(`${u.pathname}${u.search}`);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight -= 1;
    return json(200, body(u.pathname));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (data: unknown = { ok: true }) => json(200, { data, meta: { mode: "snapshot" } });
const envelopeErr = (status: number, code: string) => json(status, { error: { code, message: `m ${code}`, details: null } });

/** Polls until `cond` holds (the chain answer -> body read -> release -> next fetch spans ticks). */
async function until(cond: () => boolean, what: string, ms = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what} (started ${started.length}, pending ${pending.length})`);
    await new Promise((r) => setTimeout(r, 1));
  }
}
/** Answers every pending fetch (200) until `total` fetches were made and none is pending. */
const drain = (total: number) =>
  until(() => {
    while (pending.length) pending[0].answer(ok());
    return started.length >= total && pending.length === 0;
  }, `drain to ${total} fetches`);
/** Lets queued work run; used to show that something did NOT happen. */
const settleTicks = () => new Promise((r) => setTimeout(r, 20));
const summary = (i: number) => hghGet("/v1/kpi/summary", { query: { surface: "global", cycle_offset: i } });
const keyOf = (i: number) => `/v1/kpi/summary?cycle_offset=${i}&surface=global`;
const answerKey = (key: string, res: Response = ok()) => {
  const p = pending.find((x) => x.key === key);
  if (!p) throw new Error(`no pending fetch ${key}`);
  p.answer(res);
};

let refresh: () => Promise<string | null> = async () => FRESH;
beforeEach(() => {
  pending = [];
  started = [];
  inFlight = 0;
  maxInFlight = 0;
  refresh = async () => FRESH;
  vi.stubEnv("HGH_API_BASE_URL", BASE);
  vi.stubEnv("HGH_API_TIMEOUT_MS", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_API_TRACE_SELECT", "");
  vi.stubEnv("VERCEL", "");
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: () => refresh() });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  bindHghAuth(null);
});

describe("HghCallLimiter", () => {
  it("grants up to max at once, hands a released slot to the oldest waiter, release is idempotent", async () => {
    const lim = new HghCallLimiter(2);
    const order: string[] = [];
    const a = await lim.acquire();
    const b = await lim.acquire();
    const c = lim.acquire().then((s) => (order.push("c"), s));
    const d = lim.acquire().then((s) => (order.push("d"), s));
    expect([lim.inFlight, lim.queued]).toEqual([2, 2]);
    a.release();
    a.release(); // no second hand-over
    await settleTicks();
    expect(order).toEqual(["c"]);
    expect([lim.inFlight, lim.queued]).toEqual([2, 1]);
    b.release();
    (await c).release();
    (await d).release();
    expect(order).toEqual(["c", "d"]);
    expect([lim.inFlight, lim.queued]).toEqual([0, 0]);
    expect(() => new HghCallLimiter(0)).toThrow(RangeError);
  });

  it("an abort while queued leaves the queue with the signal's reason; an aborted signal never queues", async () => {
    const lim = new HghCallLimiter(1);
    const held = await lim.acquire();
    const ac = new AbortController();
    const waiting = lim.acquire(ac.signal);
    expect(lim.queued).toBe(1);
    const reason = new Error("left the page");
    ac.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(lim.queued).toBe(0);
    await expect(lim.acquire(ac.signal)).rejects.toBe(reason);
    held.release();
    expect([lim.inFlight, lim.queued]).toEqual([0, 0]);
  });
});

describe("request scope: at most HGH_MAX_CONCURRENT_CALLS backend calls in flight", () => {
  it("the limit is 4 (G-25, D6)", () => {
    expect(HGH_MAX_CONCURRENT_CALLS).toBe(4);
  });

  it("7 calls in one request: 4 go out, the rest wait; each answer lets exactly one more out", async () => {
    const f = gatedFetch();
    await withRequestScope(async () => {
      const calls = [0, 1, 2, 3, 4, 5, 6].map(summary);
      await until(() => f.mock.calls.length === 4, "4 fetches");
      await settleTicks();
      expect(f).toHaveBeenCalledTimes(4);
      expect(requestCallLimiter()).toMatchObject({ inFlight: 4, queued: 3 });
      answerKey(keyOf(0));
      await until(() => f.mock.calls.length === 5, "5th fetch after one answer");
      await settleTicks();
      expect(f).toHaveBeenCalledTimes(5);
      await drain(7);
      await Promise.all(calls);
      expect(requestCallLimiter()).toMatchObject({ inFlight: 0, queued: 0 });
    });
    expect(maxInFlight).toBe(4);
  });

  it("FIFO: queued calls go out in the order they were requested, whichever slot frees first", async () => {
    const f = gatedFetch();
    await withRequestScope(async () => {
      const calls = [0, 1, 2, 3, 4, 5, 6].map(summary);
      await until(() => f.mock.calls.length === 4, "4 fetches");
      answerKey(keyOf(3)); // the last of the first four frees a slot first
      await until(() => f.mock.calls.length === 5, "5th");
      answerKey(keyOf(1));
      await until(() => f.mock.calls.length === 6, "6th");
      answerKey(keyOf(4));
      await until(() => f.mock.calls.length === 7, "7th");
      await drain(7);
      await Promise.all(calls);
    });
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6].map(keyOf));
  });

  it("a slot comes back after an error answer, a network failure, a caller abort and a timeout", async () => {
    const f = gatedFetch();
    await withRequestScope(async () => {
      const ac = new AbortController();
      const notFound = hghGet("/v1/projects/{project_id}", { pathParams: { project_id: "p404" } });
      const network = hghPost("/v1/qa/sessions", { auth: "none", body: {} as never }); // POST: not retried
      const aborted = hghGet("/v1/auth/me", { signal: ac.signal });
      const timedOut = hghGet("/v1/filters/dates", { query: { surface: "global", family: "all" }, timeoutMs: 40 });
      const queued = [10, 11, 12, 13].map(summary);
      await until(() => f.mock.calls.length === 4, "4 fetches");
      expect(requestCallLimiter()).toMatchObject({ inFlight: 4, queued: 4 });

      answerKey("/v1/projects/p404", envelopeErr(404, "project_not_found"));
      await expect(notFound).rejects.toMatchObject({ status: 404 });
      pending.find((p) => p.key === "/v1/qa/sessions")!.fail(new TypeError("fetch failed"));
      await expect(network).rejects.toMatchObject({ status: 502, code: "network_error" });
      const reason = new Error("navigated away");
      ac.abort(reason);
      await expect(aborted).rejects.toBe(reason);
      await expect(timedOut).rejects.toMatchObject({ status: 504, code: "timeout" }); // gated fetch never answers it

      await until(() => f.mock.calls.length === 8, "the 4 queued calls got the freed slots");
      await drain(8);
      await Promise.all(queued);
      expect(requestCallLimiter()).toMatchObject({ inFlight: 0, queued: 0 });
    });
    expect(maxInFlight).toBe(4);
  });

  it("a caller abort while queued rejects with its reason and never fetches", async () => {
    const f = gatedFetch();
    await withRequestScope(async () => {
      const first = [0, 1, 2, 3].map(summary);
      await until(() => f.mock.calls.length === 4, "4 fetches");
      const ac = new AbortController();
      const waiting = hghGet("/v1/auth/me", { signal: ac.signal });
      const behind = summary(9);
      await settleTicks();
      expect(requestCallLimiter()).toMatchObject({ inFlight: 4, queued: 2 });
      const reason = new Error("left the page");
      ac.abort(reason);
      await expect(waiting).rejects.toBe(reason);
      expect(requestCallLimiter()).toMatchObject({ inFlight: 4, queued: 1 });
      answerKey(keyOf(0));
      await until(() => f.mock.calls.length === 5, "the call behind the aborted one");
      await drain(5);
      await Promise.all([...first, behind]);
    });
    expect(started).not.toContain("/v1/auth/me");
    expect(started.at(-1)).toBe(keyOf(9));
  });

  it("the timeout counts from the slot: a call queued longer than its timeout still succeeds", async () => {
    const f = gatedFetch();
    await withRequestScope(async () => {
      const first = [0, 1, 2, 3].map(summary);
      await until(() => f.mock.calls.length === 4, "4 fetches");
      const late = hghGet("/v1/auth/me", { timeoutMs: 60 });
      await new Promise((r) => setTimeout(r, 150)); // queued 150 ms > its 60 ms timeout
      answerKey(keyOf(0));
      await until(() => pending.some((p) => p.key === "/v1/auth/me"), "late call fetched");
      const p = pending.find((x) => x.key === "/v1/auth/me")!;
      expect(p.signal?.aborted).toBe(false);
      p.answer(ok({ user_id: "u" }));
      await expect(late).resolves.toEqual({ data: { user_id: "u" }, meta: { mode: "snapshot" } });
      await drain(5);
      await Promise.all(first);
    });
  });

  it("neither the retry delay nor a token refresh holds a slot", async () => {
    const f = gatedFetch();
    let releaseRefresh!: (t: string) => void;
    refresh = () => new Promise<string>((r) => (releaseRefresh = r));
    await withRequestScope(async () => {
      const retried = hghGet("/v1/auth/me"); // GET: network failure -> retried once after 200 ms
      const reauthed = hghGet("/v1/kpi/engines", { query: { surface: "global" }, retryOn401: true });
      const others = [0, 1].map(summary);
      const queued = [5, 6].map(summary);
      await until(() => f.mock.calls.length === 4, "4 fetches");
      pending.find((p) => p.key === "/v1/auth/me")!.fail(new TypeError("fetch failed"));
      // well inside the 200 ms retry delay: the failed attempt's slot is already free
      await until(() => started.includes(keyOf(5)), "a queued call used the slot during the retry delay", 150);
      expect(started.filter((k) => k === "/v1/auth/me")).toHaveLength(1);
      answerKey("/v1/kpi/engines?surface=global", envelopeErr(401, "token_expired"));
      // the refresh never ends by itself: a slot held across it would never free
      await until(() => started.includes(keyOf(6)), "a queued call used the slot during the refresh", 150);
      releaseRefresh(FRESH);
      // both retries (the GET after its 200 ms delay) now queue behind the 4 calls in flight
      await until(() => requestCallLimiter()?.queued === 2, "both retries queued");
      expect(requestCallLimiter()).toMatchObject({ inFlight: 4, queued: 2 });
      await drain(8);
      await Promise.all([retried, reauthed, ...others, ...queued]);
    });
    expect(started.filter((k) => k === "/v1/auth/me")).toHaveLength(2);
    expect(maxInFlight).toBe(4);
  });

  it("D6 kept promises: the essentials gate, 6 sections behind it and the shell calendar finish, 4 at most at once", async () => {
    autoFetch(5);
    const filters = { cumulative: false };
    const ctx = D.dashboardCtx("global", null);
    const sections = [
      "/v1/trend",
      "/v1/geo",
      "/v1/kpi/engines",
      "/v1/citations/domains",
      "/v1/filters/options",
      "/v1/mentions/brands",
    ] as const;
    const out = await withRequestScope(() =>
      Promise.allSettled([
        D.essentialsGate(filters, ctx),
        ...sections.map((route, i) =>
          D.afterFirstRender(filters, ctx, () => hghGet(route as "/v1/geo", { query: { surface: "global", top: i } as never })),
        ),
        D.loadEssentialFilterDates(ctx),
        D.essentialsGate(filters, ctx),
      ]),
    );
    expect(out).toHaveLength(9);
    expect(maxInFlight).toBe(4);
    // the three global essentials went out first (kept promises: each sent once), then the sections
    const paths = started.map((k) => k.split("?")[0]);
    expect(new Set(paths.slice(0, 3))).toEqual(new Set(["/v1/kpi/summary", "/v1/mentions/brands", "/v1/filters/dates"]));
    expect(paths).not.toContain("/v1/funnel/conversion");
    expect(paths.filter((p) => p === "/v1/filters/dates")).toHaveLength(1);
    expect(started).toHaveLength(3 + sections.length);
  });
});

describe("outside a request scope", () => {
  it("no limiter, no limit: 8 calls are all in flight at once", async () => {
    const f = gatedFetch();
    expect(requestCallLimiter()).toBeNull();
    const calls = [0, 1, 2, 3, 4, 5, 6, 7].map(summary);
    await until(() => f.mock.calls.length === 8, "8 fetches");
    expect(maxInFlight).toBe(8);
    await drain(8);
    await Promise.all(calls);
  });
});
