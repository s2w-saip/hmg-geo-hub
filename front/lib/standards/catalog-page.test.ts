import { describe, expect, it, vi } from "vitest";
import { catalogPageQuery, exportCatalogPages, reuseCatalogMeta, type CatalogPage, type CatalogRowsPage } from "./catalog-page";

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
