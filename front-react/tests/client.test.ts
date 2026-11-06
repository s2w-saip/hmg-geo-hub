import { describe, expect, it, vi } from "vitest";
import { queryString, request } from "../src/api/client";
import { HghApiError } from "../src/legacy/lib/hgh/errors";
import { safeNext } from "../src/app/auth-pages";
import { replaceUiHistory } from "../src/app/navigation";

describe("browser-to-HUB contract", () => {
  it("does not issue requests until connection is enabled", async () => {
    const fetcher = vi.fn();
    await expect(request("/api/screens/overview/cards", { connected: false, fetcher })).rejects.toMatchObject({ code: "hub_not_connected" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps repeated filters and preserves real zero and false values", () => {
    expect(queryString({ country: ["KR", "US"], page: 0, enabled: false, empty: "", absent: null })).toBe("country=KR&country=US&enabled=false&page=0");
  });
  it("only calls same-origin API paths and sends cookies rather than bearer secrets", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"value":null}', { headers: { "Content-Type": "application/json" } }));
    await expect(request("/api/screens/overview/cards", { connected: true, fetcher })).resolves.toEqual({ value: null });
    const [, options] = fetcher.mock.calls[0];
    expect(options).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(options?.headers).not.toHaveProperty("Authorization");
    await expect(request("https://data.internal/v1/screens/overview/cards", { connected: true, fetcher })).rejects.toThrow(TypeError);
    await expect(request("/api/../internal", { connected: true, fetcher })).rejects.toThrow(TypeError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves 503 and never converts an unavailable rollup to an empty success", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":{"code":"source_unavailable","message":"not ready"}}', { status: 503, headers: { "Content-Type": "application/json" } }));
    await expect(request("/api/screens/overview/cards", { connected: true, fetcher })).rejects.toMatchObject({ status: 503, code: "source_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects successful HTML fallback responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }));
    await expect(request("/api/screens/overview/cards", { connected: true, fetcher })).rejects.toMatchObject({ status: 502, code: "upstream_non_json" });
  });
  it("passes navigation cancellation to fetch without reporting a source failure", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      controller.abort();
      throw options?.signal?.reason;
    });
    await expect(request("/api/screens/overview/cards", { connected: true, fetcher, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not retry writes or hide version conflicts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":{"code":"conflict"}}', { status: 409, headers: { "Content-Type": "application/json" } }));
    await expect(request("/api/hub/global-prompts", { method: "POST", body: { expectedVersion: 2 }, connected: true, fetcher })).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps login redirects inside the selected locale’s renewal pages", () => {
    expect(safeNext("/ko/renewal/website?engine=chatgpt", "ko")).toBe("/ko/renewal/website?engine=chatgpt");
    for (const path of ["https://example.org", "https://hub.invalid/ko/renewal/admin", "//example.org", "/en/renewal/admin", "/ko/renewal-evil", "/ko/renewal/../../login", "/ko/renewal/..%2f..%2flogin"]) {
      expect(safeNext(path, "ko")).toBe("/ko/renewal/dashboard");
    }
  });
  it("falls back when the login return URL cannot be parsed", () => {
    for (const path of ["http://[", "http://[::invalid]", "https://example.org:invalid"])
      expect(safeNext(path, "ko")).toBe("/ko/renewal/dashboard");
  });
  it("preserves the router’s history index when UI state changes the URL", () => {
    const state = { idx: 3, key: "existing-route", usr: null };
    const replaceState = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { history: { state, replaceState }, dispatchEvent });
    try {
      replaceUiHistory(null, "", "/ko/renewal/admin?q=Kia");
      expect(replaceState).toHaveBeenCalledWith(state, "", "/ko/renewal/admin?q=Kia");
      expect(dispatchEvent.mock.calls[0][0].type).toBe("hgh-ui-url");
    } finally { vi.unstubAllGlobals(); }
  });
});
