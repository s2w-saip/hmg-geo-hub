import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchContextMapPage, rememberCursor } from "./use-paged-tab";

// Cursor paging of the context map tabs (decision D5, unit U10 C3). The hook itself needs a
// DOM to run its effect; its bookkeeping is the pure rememberCursor, tested here, and the
// fetcher's query string.

describe("rememberCursor", () => {
  it("records the next page's cursor and keeps earlier ones (prev reuses them)", () => {
    const m = new Map<number, string>([[1, "c1"]]);
    expect(rememberCursor(m, 1, { page: 1, nextCursor: "c2" })).toBe(false);
    expect([...m]).toEqual([
      [1, "c1"],
      [2, "c2"],
    ]);
  });

  it("forgets the following cursor on the last page", () => {
    const m = new Map<number, string>([
      [1, "c1"],
      [2, "c2"],
    ]);
    expect(rememberCursor(m, 1, { page: 1, nextCursor: null })).toBe(false);
    expect([...m]).toEqual([[1, "c1"]]);
  });

  it("a restart (server answered page 0 for page 2) drops every cursor and asks to move", () => {
    const m = new Map<number, string>([
      [1, "old1"],
      [2, "old2"],
    ]);
    expect(rememberCursor(m, 2, { page: 0, nextCursor: "n1" })).toBe(true);
    expect([...m]).toEqual([[1, "n1"]]);
  });

  it("offset sources (no nextCursor field) leave the map alone", () => {
    const m = new Map<number, string>([[1, "c1"]]);
    expect(rememberCursor(m, 3, { page: 3 })).toBe(false);
    expect([...m]).toEqual([[1, "c1"]]);
  });
});

describe("fetchContextMapPage (client fetcher)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the cursor when known, next to the page number the legacy source reads", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        return new Response(JSON.stringify({ success: true, paged: { rows: [], total: 0, page: 2, size: 50 } }), {
          status: 200,
        });
      }),
    );
    const f = fetchContextMapPage<unknown, "mentions">("contexts");
    await f({ sort: "mentions", dir: "desc", page: 2, size: 50, cursor: "abc", search: "suv" });
    await f({ sort: "mentions", dir: "desc", page: 0, size: 50 });
    const a = new URL(urls[0], "http://x").searchParams;
    expect(Object.fromEntries(a)).toEqual({ tab: "contexts", sort: "mentions", dir: "desc", page: "2", size: "50", search: "suv", cursor: "abc" });
    expect(new URL(urls[1], "http://x").searchParams.has("cursor")).toBe(false);
  });

  it("a failed answer throws (the tab shows its error state)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 })));
    await expect(fetchContextMapPage("contexts")({ sort: "mentions", dir: "desc", page: 0, size: 50 })).rejects.toThrow();
  });
});
