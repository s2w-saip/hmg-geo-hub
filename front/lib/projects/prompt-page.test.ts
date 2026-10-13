import { describe, expect, it, vi } from "vitest";
import { projectPageQuery, reuseProjectValues, type ProjectRowsPage } from "./prompt-page";

const page = (offset: number, values: Record<string, string[]> = {}): ProjectRowsPage<{ id: string }> => ({
  rows: [{ id: `p${offset}` }], ids: [], total: 3, offset, limit: 1, show_brand: true, show_category: false, draft_count: 2, values,
});

describe("reuseProjectValues: tag value suggestions are project-wide", () => {
  it("page and sort reads skip the values aggregation and carry the server render's values", async () => {
    const load = vi.fn(async (q: { offset?: number }) => page(q.offset ?? 0));
    const read = reuseProjectValues({ initial: page(0, { f1: ["A", "B"] }), load });
    expect(await read({ offset: 1, sort: "text", direction: "asc" })).toEqual(page(1, { f1: ["A", "B"] }));
    expect(load).toHaveBeenCalledWith({ offset: 1, sort: "text", direction: "asc", include_values: false });
  });

  it("include_values defaults to true and must be a boolean", () => {
    expect(projectPageQuery({}).include_values).toBe(true);
    expect(() => projectPageQuery({ include_values: "no" as unknown as boolean })).toThrow();
  });
});
