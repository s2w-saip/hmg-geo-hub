import { describe, expect, it } from "vitest";
import { HghApiError } from "./errors";
import { fetchAllPages, fetchPageOrRestart, MAX_PAGES_CEILING, pageInfo, readCursorParam, type CursorPage } from "./paginate";

/** Fake keyset list: pages of `size` over `total` items; cursors "c<offset>". */
function list(total: number, size: number) {
  const seen: Array<string | null> = [];
  const fetchPage = async (cursor: string | null): Promise<CursorPage<number>> => {
    seen.push(cursor);
    const offset = cursor ? Number(cursor.slice(1)) : 0;
    const items = Array.from({ length: Math.min(size, total - offset) }, (_, i) => offset + i);
    const next = offset + size < total ? `c${offset + size}` : null;
    return { items, nextCursor: next, total };
  };
  return { fetchPage, seen };
}

const stale = () => new HghApiError(409, "cursor_stale", "generation moved");

describe("fetchAllPages", () => {
  it("reads to the end within maxPages", async () => {
    const { fetchPage, seen } = list(12, 5);
    const out = await fetchAllPages(fetchPage, { maxPages: 3 });
    expect(out).toEqual({ items: [...Array(12).keys()], pages: 3, total: 12, truncated: false, restarted: false });
    expect(seen).toEqual([null, "c5", "c10"]);
  });

  it("maxPages is mandatory and bounded", async () => {
    const { fetchPage } = list(1, 1);
    // @ts-expect-error maxPages is required
    await expect(fetchAllPages(fetchPage, {})).rejects.toThrow(RangeError);
    await expect(fetchAllPages(fetchPage, { maxPages: 0 })).rejects.toThrow(RangeError);
    await expect(fetchAllPages(fetchPage, { maxPages: MAX_PAGES_CEILING + 1 })).rejects.toThrow(RangeError);
    await expect(fetchAllPages(fetchPage, { maxPages: 1.5 })).rejects.toThrow(RangeError);
  });

  it("more pages than maxPages: throws by default (no silent partial list), stops fetching", async () => {
    const { fetchPage, seen } = list(100, 10);
    await expect(fetchAllPages(fetchPage, { maxPages: 3 })).rejects.toMatchObject({ code: "page_limit_exceeded" });
    expect(seen).toHaveLength(3);
  });

  it("onLimit truncate returns what was read and says so", async () => {
    const { fetchPage, seen } = list(100, 10);
    const out = await fetchAllPages(fetchPage, { maxPages: 2, onLimit: "truncate" });
    expect([out.items.length, out.pages, out.truncated]).toEqual([20, 2, true]);
    expect(seen).toHaveLength(2);
  });

  it("a repeated cursor aborts instead of looping", async () => {
    let n = 0;
    const loop = async (): Promise<CursorPage<number>> => ({ items: [n++], nextCursor: "same" });
    await expect(fetchAllPages(loop, { maxPages: 50 })).rejects.toMatchObject({ code: "page_limit_exceeded" });
    expect(n).toBe(2);
  });

  it("409 cursor_stale restarts from the first page once, dropping the earlier pass", async () => {
    const { fetchPage } = list(6, 3);
    const cursors: Array<string | null> = [];
    let failedOnce = false;
    const flaky = async (cursor: string | null) => {
      cursors.push(cursor);
      if (cursor === "c3" && !failedOnce) {
        failedOnce = true;
        throw stale();
      }
      return fetchPage(cursor);
    };
    const out = await fetchAllPages(flaky, { maxPages: 5 });
    expect(out.items).toEqual([0, 1, 2, 3, 4, 5]); // no duplicates from the first pass
    expect(out.restarted).toBe(true);
    expect(cursors).toEqual([null, "c3", null, "c3"]);
  });

  it("409 cursor_stale twice -> fails (only one restart)", async () => {
    const cursors: Array<string | null> = [];
    const alwaysStale = async (cursor: string | null): Promise<CursorPage<number>> => {
      cursors.push(cursor);
      // Without the one-restart rule this loop never yields to timers; fail instead of hanging.
      if (cursors.length > 20) throw new Error("runaway pagination");
      if (cursor) throw stale();
      return { items: [1], nextCursor: "c1" };
    };
    await expect(fetchAllPages(alwaysStale, { maxPages: 5 })).rejects.toMatchObject({ status: 409, code: "cursor_stale" });
    expect(cursors).toEqual([null, "c1", null, "c1"]);
  });

  it("422 cursor_invalid and other errors are not retried", async () => {
    let calls = 0;
    const invalid = async (): Promise<CursorPage<number>> => {
      calls += 1;
      throw new HghApiError(422, "cursor_invalid");
    };
    await expect(fetchAllPages(invalid, { maxPages: 5 })).rejects.toMatchObject({ code: "cursor_invalid" });
    expect(calls).toBe(1);
  });
});

describe("fetchPageOrRestart", () => {
  it("stale URL cursor -> first page once, flagged", async () => {
    const seen: Array<string | null> = [];
    const page = async (cursor: string | null): Promise<CursorPage<string>> => {
      seen.push(cursor);
      if (cursor) throw stale();
      return { items: ["first"], nextCursor: "n" };
    };
    await expect(fetchPageOrRestart(page, "old")).resolves.toEqual({ items: ["first"], nextCursor: "n", restarted: true });
    expect(seen).toEqual(["old", null]);
  });

  it("stale on the first page itself is not retried", async () => {
    let calls = 0;
    const page = async (): Promise<CursorPage<string>> => {
      calls += 1;
      throw stale();
    };
    await expect(fetchPageOrRestart(page, null)).rejects.toMatchObject({ code: "cursor_stale" });
    expect(calls).toBe(1);
  });
});

describe("pageInfo and readCursorParam", () => {
  it("meta.page -> PageInfo", () => {
    expect(pageInfo({ page: { next_cursor: "abc", limit: 50, total: 120 } })).toEqual({ nextCursor: "abc", limit: 50, total: 120, hasMore: true });
    expect(pageInfo({ page: { next_cursor: null, limit: 50 } })).toEqual({ nextCursor: null, limit: 50, total: null, hasMore: false });
    expect(pageInfo(undefined)).toEqual({ nextCursor: null, limit: null, total: null, hasMore: false });
  });

  it("only base64url strings are cursors", () => {
    expect(readCursorParam("eyJ2IjoxfQ")).toBe("eyJ2IjoxfQ");
    expect(readCursorParam(["a", "b"])).toBeNull();
    expect(readCursorParam("a b")).toBeNull();
    expect(readCursorParam("")).toBeNull();
    expect(readCursorParam(undefined)).toBeNull();
  });
});
