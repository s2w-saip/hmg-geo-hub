import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReport } from "./client";
const auth = vi.hoisted(() => ({ token: vi.fn() }));
vi.mock("./auth", () => ({ getGa4AccessToken: auth.token }));
beforeEach(() => { vi.useFakeTimers(); auth.token.mockReset().mockResolvedValue("fixture-token"); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("GA4 runReport deadline", () => {
  it("preserves the request body and normal response", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ rows: [] }));
    expect(await runReport("123", { metrics: [{ name: "activeUsers" }] })).toEqual({ rows: [] });
    expect(fetcher).toHaveBeenCalledWith("https://analyticsdata.googleapis.com/v1beta/properties/123:runReport", expect.objectContaining({
      method: "POST", body: JSON.stringify({ metrics: [{ name: "activeUsers" }] }), signal: expect.any(AbortSignal),
    }));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps transient HTTP retry behavior within one total deadline", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("retry", { status: 502 }))
      .mockResolvedValueOnce(new Response("retry", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ rows: [] }));
    const result = runReport("123", {});
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual({ rows: [] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("does not retry a permanent HTTP error", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("invalid", { status: 400 }));
    await expect(runReport("123", {})).rejects.toThrow("(400)");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("aborts an indefinitely pending report after 30 seconds", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const result = expect(runReport("123", {})).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("also bounds token acquisition and never fetches after a late token arrives", async () => {
    let resolve!: (token: string) => void;
    auth.token.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const fetcher = vi.spyOn(globalThis, "fetch");
    const result = expect(runReport("123", {})).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    resolve("late-token");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
