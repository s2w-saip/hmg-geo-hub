import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/db/repositories/keyword-cache", () => ({ keywordCacheRepository: repo }));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
  repo.get.mockReset().mockResolvedValue({ recovered: true });
  repo.set.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("keyword cache outage recovery", () => {
  it("retries reads after cooldown and resumes reuse after a transient failure", async () => {
    const cache = await import("./cache");
    repo.get.mockRejectedValueOnce(new Error("temporarily unavailable"));
    expect(await cache.cacheGet("key")).toBeNull();
    await cache.cacheSet("key", {}, 1000);
    expect(await cache.cacheGet("key")).toBeNull();
    expect(repo.get).toHaveBeenCalledTimes(1);
    expect(repo.set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(await cache.cacheGet("key")).toEqual({ recovered: true });
    expect(await cache.cacheGet("key")).toEqual({ recovered: true });
    expect(repo.get).toHaveBeenCalledTimes(3);
  });
  it("recovers from write failures without changing TTL or cached values", async () => {
    const cache = await import("./cache");
    repo.set.mockRejectedValueOnce(new Error("write outage"));
    await cache.cacheSet("key", { value: 3 }, 4000);
    vi.advanceTimersByTime(30_000);
    await cache.cacheSet("key", { value: 4 }, 4000);
    expect(repo.set).toHaveBeenLastCalledWith("key", { value: 4 }, new Date(Date.now() + 4000));
    expect(await cache.cacheGet("key")).toEqual({ recovered: true });
  });
  it("allows only one recovery probe while the database is still responding", async () => {
    const cache = await import("./cache");
    repo.get.mockRejectedValueOnce(new Error("down"));
    await cache.cacheGet("key");
    vi.advanceTimersByTime(30_000);
    let resolve!: (value: unknown) => void;
    repo.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const probe = cache.cacheGet("key");
    expect(await cache.cacheGet("other")).toBeNull();
    await cache.cacheSet("other", {}, 1000);
    expect(repo.get).toHaveBeenCalledTimes(2);
    expect(repo.set).not.toHaveBeenCalled();
    resolve({ ready: true });
    expect(await probe).toEqual({ ready: true });
    await cache.cacheSet("other", {}, 1000);
    expect(repo.set).toHaveBeenCalledTimes(1);
  });
  it("restarts cooldown after a failed probe instead of hammering the database", async () => {
    const cache = await import("./cache");
    repo.get.mockRejectedValue(new Error("still down"));
    await cache.cacheGet("key");
    vi.advanceTimersByTime(30_000);
    await cache.cacheGet("key");
    vi.advanceTimersByTime(29_999);
    await cache.cacheGet("key");
    expect(repo.get).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await cache.cacheGet("key");
    expect(repo.get).toHaveBeenCalledTimes(3);
  });
});
