import { beforeEach, describe, expect, it, vi } from "vitest";
import { HghApiError } from "@/lib/hgh/errors";

// The page's read of the account's saved filters (2026-10-28): the list for the first render, or null so
// the panel asks again from the browser. A failed read never fails the page.

const hub = vi.hoisted(() => ({ fetch: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/hub/client", () => ({ hubFetch: hub.fetch }));
vi.mock("@/lib/hub/session", () => ({ hubToken: hub.token }));

const { loadSavedFilters } = await import("./saved-filters-server");

beforeEach(() => {
  hub.fetch.mockReset();
  hub.token.mockReset().mockResolvedValue("tok");
});

describe("loadSavedFilters", () => {
  it("reads the page's list with the session token", async () => {
    const items = [{ id: "a", name: "독일", query: "geography=DE", isDefault: true }];
    hub.fetch.mockResolvedValue({ data: { items } });
    expect(await loadSavedFilters("mention")).toEqual(items);
    expect(hub.fetch).toHaveBeenCalledWith("GET", "/v1/hub/saved-filters", { token: "tok", query: "page=mention" });
  });

  it("is null without a session or when the BFF refuses or cannot be reached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    hub.token.mockResolvedValueOnce(null);
    expect(await loadSavedFilters("overview")).toBeNull();
    expect(hub.fetch).not.toHaveBeenCalled();
    hub.fetch.mockRejectedValueOnce(new HghApiError(503, "source_unavailable", "HUB operations store is not configured"));
    expect(await loadSavedFilters("overview")).toBeNull();
    hub.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await loadSavedFilters("overview")).toBeNull();
  });
});
