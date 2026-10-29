import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeClient } from "./client";
import { HttpScopeClient } from "./http";
import { pageAll, ScopeDeadlineExceededError } from "./paging";
import { withScopeReadDeadline } from "./read-deadline";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mirror read deadlines", () => {
  it("aborts a hung HTTP request and does not leak the signal into query params", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const client = withScopeReadDeadline(new HttpScopeClient("https://scope.invalid", "test"), Date.now() + 50);
    const request = client.listRunJobs("project", "run", { limit: 200, include: "result,occurrences" });
    const assertion = expect(request).rejects.toBeInstanceOf(ScopeDeadlineExceededError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("limit=200");
    expect(url).not.toContain("signal");
    expect(options.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["prompts", "runs", "run", "jobs", "answer"])("passes cancellation through the %s HTTP read", async (method) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [], next_cursor: null })));
    vi.stubGlobal("fetch", fetchMock);
    const client = withScopeReadDeadline(new HttpScopeClient("https://scope.invalid", "test"), Date.now() + 5000);
    if (method === "prompts") await client.listPrompts("p");
    if (method === "runs") await client.listMeasurementRuns("p");
    if (method === "run") await client.getMeasurementRun("p", "r");
    if (method === "jobs") await client.listRunJobs("p", "r");
    if (method === "answer") await client.getQueryRun("j");
    const [, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
    expect(new Headers(options.headers).get("Accept-Encoding")).toBe(method === "jobs" ? "gzip" : null);
  });

  it("forwards the existing status filter to the jobs feed without adding result payloads", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [], next_cursor: null })));
    vi.stubGlobal("fetch", fetchMock);
    await new HttpScopeClient("https://scope.invalid", "test").listRunJobs("p", "r", { status: "failed", limit: 200, cursor: "next" });
    const [requestedUrl] = fetchMock.mock.calls[0] as unknown as [string];
    const url = new URL(requestedUrl);
    expect(url.searchParams.get("status")).toBe("failed");
    expect(url.searchParams.get("cursor")).toBe("next");
    expect(url.searchParams.has("include")).toBe(false);
  });

  it("keeps a shared client's later request independent of an expired wrapper", async () => {
    vi.useFakeTimers();
    const listPrompts = vi.fn().mockResolvedValue({ data: [], next_cursor: null });
    const original = { listPrompts } as unknown as ScopeClient;
    const wrapped = withScopeReadDeadline(original, Date.now() + 10);
    await wrapped.listPrompts("p");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    await expect(wrapped.listPrompts("p")).rejects.toBeInstanceOf(ScopeDeadlineExceededError);
    await original.listPrompts("p");
    expect(listPrompts).toHaveBeenCalledTimes(2);
    expect(listPrompts.mock.calls[1]).toEqual(["p"]);
  });

  it("respects caller cancellation and does not start an already cancelled read", async () => {
    const listPrompts = vi.fn();
    const client = withScopeReadDeadline({ listPrompts } as unknown as ScopeClient, Date.now() + 5000);
    const external = new AbortController();
    external.abort(new Error("caller stopped"));
    await expect(client.listPrompts("p", undefined, { signal: external.signal })).rejects.toThrow("caller stopped");
    expect(listPrompts).not.toHaveBeenCalled();
  });

  it("does not return a page that completed after the deadline", async () => {
    vi.useFakeTimers();
    const deadlineAt = Date.now() + 10;
    const fetchPage = vi.fn(async () => {
      vi.setSystemTime(deadlineAt);
      return { data: ["partial"], next_cursor: "next" };
    });
    await expect(pageAll(fetchPage, { maxPages: 50, label: "jobs", deadlineAt })).rejects.toBeInstanceOf(ScopeDeadlineExceededError);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
