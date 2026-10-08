import { describe, expect, it, vi } from "vitest";
import { catalogPageQuery, exportCatalogPages, type CatalogPage } from "./catalog-page";

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
