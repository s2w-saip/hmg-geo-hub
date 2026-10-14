import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_EXPORT_PAGE_SIZE, CATALOG_PAGE_LIMIT_MAX, CATALOG_ROWS_LIMIT_MAX, catalogPageQuery, collationOf, exportCatalogPages,
  rereadAfterHydration, reuseCatalogMeta, type CatalogPage, type CatalogRowsPage,
} from "./catalog-page";

const page = (offset: number, total = 1001): CatalogPage => ({
  rows: Array.from({ length: Math.min(500, total - offset) }, (_, i) => ({ id: String(offset + i) })) as CatalogPage["rows"],
  total, count: total, offset, limit: 500, facets: {}, columns: [],
});

describe("catalog export never publishes a partial workbook", () => {
  it("rejects a failed page without retrying", async () => {
    const load = vi.fn().mockResolvedValueOnce(page(0)).mockRejectedValueOnce(new Error("read failed"));
    await expect(exportCatalogPages(load, {})).rejects.toThrow("read failed");
    expect(load).toHaveBeenCalledTimes(2);
  });
  it.each(["count", "duplicate", "short", "offset"])("rejects %s drift", async kind => {
    const next = page(500);
    if (kind === "count") next.total++;
    if (kind === "duplicate") next.rows[0].id = "0";
    if (kind === "short") next.rows.pop();
    if (kind === "offset") next.offset = 0;
    const load = vi.fn().mockResolvedValueOnce(page(0)).mockResolvedValueOnce(next);
    await expect(exportCatalogPages(load, {})).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("accepts an empty result", async () => {
    expect(await exportCatalogPages(async () => page(0, 0), {})).toEqual([]);
  });
  it.each([{ limit: 10001 }, { offset: -1 }, { sort: "text; DROP TABLE prompts" }, { filters: { projectId: "foreign" } }])("rejects invalid input %j", q => {
    expect(() => catalogPageQuery(q as Parameters<typeof catalogPageQuery>[0])).toThrow();
  });
});

describe("export batches (B078): rows-only reads up to 5,000, page reads keep 500", () => {
  it("page reads with metadata are bounded at 500, rows-only reads at 5,000", () => {
    expect(catalogPageQuery({ limit: 500 }, CATALOG_PAGE_LIMIT_MAX).limit).toBe(500);
    expect(() => catalogPageQuery({ limit: 501 }, CATALOG_PAGE_LIMIT_MAX)).toThrow();
    expect(catalogPageQuery({ limit: CATALOG_ROWS_LIMIT_MAX }).limit).toBe(5000);
    expect(() => catalogPageQuery({ limit: CATALOG_ROWS_LIMIT_MAX + 1 })).toThrow();
  });

  it("5,000-row batches give the same rows in the same order as 500-row pages, in a tenth of the reads", async () => {
    const all = Array.from({ length: 12005 }, (_, i) => ({ id: `r${i}` })) as CatalogRowsPage["rows"];
    const reader = (calls: number[]) => async (q: { offset?: number; limit?: number }): Promise<CatalogRowsPage> => {
      calls.push(q.limit!);
      return { rows: all.slice(q.offset!, q.offset! + q.limit!), total: all.length, offset: q.offset!, limit: q.limit! };
    };
    const small: number[] = [], big: number[] = [];
    const a = await exportCatalogPages(reader(small), { sort: "text" });
    const b = await exportCatalogPages(reader(big), { sort: "text" }, CATALOG_EXPORT_PAGE_SIZE);
    expect(b).toEqual(a);
    expect(a).toEqual(all);
    expect([small.length, big]).toEqual([25, [5000, 5000, 5000]]);
  });

  it("a short batch or drift still rejects the whole export at any batch size", async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ rows: Array.from({ length: 5000 }, (_, i) => ({ id: String(i) })), total: 6000, offset: 0, limit: 5000 })
      .mockResolvedValueOnce({ rows: [{ id: "x" }], total: 6001, offset: 5000, limit: 5000 });
    await expect(exportCatalogPages(load, {}, CATALOG_EXPORT_PAGE_SIZE)).rejects.toThrow();
  });
});

describe("first page collation (B077): the server render sorts like the browser, so hydration does not read it again", () => {
  it("Korean locale or Accept-Language -> ko, anything else (or nothing) -> en", () => {
    expect(["ko", "ko-KR", "ko-KR,ko;q=0.9,en-US;q=0.8", " KO-kr"].map(collationOf)).toEqual(["ko", "ko", "ko", "ko"]);
    expect(["en-US", "en-US,ko;q=0.9", "ja", "", null, undefined].map(collationOf)).toEqual(["en", "en", "en", "en", "en", "en"]);
  });

  it("re-read only when the browser's collation differs from the server read's (absent = en, the former first read)", () => {
    expect(rereadAfterHydration({ collation: "ko" }, "ko")).toBe(false);
    expect(rereadAfterHydration({ collation: "en" }, "en")).toBe(false);
    expect(rereadAfterHydration({ collation: "en" }, "ko")).toBe(true);
    expect(rereadAfterHydration({ collation: "ko" }, "en")).toBe(true);
    // Former behaviour without a reported collation: Korean browsers re-read, English ones did not.
    expect(rereadAfterHydration({}, "ko")).toBe(true);
    expect(rereadAfterHydration({}, "en")).toBe(false);
  });
});

describe("reuseCatalogMeta: scope metadata depends on the draft only", () => {
  const meta = (tag: string) => ({ count: 9, facets: { depth1: [tag] }, columns: [tag], stats: null });
  const initial: CatalogPage = { rows: [], total: 9, offset: 0, limit: 50, ...meta("initial") };
  const rowsPage = (offset: number): CatalogRowsPage => ({ rows: [{ id: `r${offset}` }] as CatalogRowsPage["rows"], total: 3, offset, limit: 50 });

  it("same draft (page, filters, search, sort): rows-only reads carry the last metadata", async () => {
    const load = vi.fn();
    const rows = vi.fn(async (q: { offset?: number }) => rowsPage(q.offset ?? 0));
    const read = reuseCatalogMeta({ initial, load, rows });
    const q = { filters: { depth1: "A" }, search: "x", sort: "text" as const, offset: 50, draft: { depth2: "all" } };
    expect(await read(q)).toEqual({ ...rowsPage(50), ...meta("initial") });
    expect(rows).toHaveBeenCalledWith(q);
    expect(load).not.toHaveBeenCalled();
  });

  it("a new draft reads the full page once, then reuses that metadata", async () => {
    const full: CatalogPage = { ...rowsPage(0), ...meta("depth1=A") };
    const load = vi.fn(async () => full);
    const rows = vi.fn(async (q: { offset?: number }) => rowsPage(q.offset ?? 0));
    const read = reuseCatalogMeta({ initial, load, rows });
    expect(await read({ draft: { depth1: "A" } })).toBe(full);
    expect(await read({ draft: { depth1: "A" }, offset: 50 })).toEqual({ ...rowsPage(50), ...meta("depth1=A") });
    expect(await read({ draft: {} })).toBe(full);                     // back to another draft: read again
    expect([load.mock.calls.length, rows.mock.calls.length]).toEqual([2, 1]);
  });

  it("without a rows-only reader the plain loader is used", () => {
    const load = vi.fn();
    expect(reuseCatalogMeta({ initial, load })).toBe(load);
  });
});
