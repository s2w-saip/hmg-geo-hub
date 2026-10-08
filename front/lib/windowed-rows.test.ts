import { describe, expect, it } from "vitest";
import { RowHeights } from "./windowed-rows";

describe("variable rows preserve document scroll offsets", () => {
  it("finds a deep row without storing row content", () => {
    const rows = new RowHeights(25000, 72);
    expect(rows.indexAt(20000 * 72 + 1)).toBe(20000);
    expect(rows.offset(25000)).toBe(1800000);
  });
  it("accounts for wrapped text and resized rows at either end", () => {
    const rows = new RowHeights(4, 50);
    rows.measure(0, 100); rows.measure(2, 25);
    expect([0, 1, 2, 3, 4].map(i => rows.offset(i))).toEqual([0, 100, 150, 175, 225]);
    expect([0, 99, 100, 174, 175, 900].map(y => rows.indexAt(y))).toEqual([0, 0, 1, 2, 3, 3]);
    rows.measure(0, 30);
    expect(rows.offset(4)).toBe(155);
    expect(rows.measure(0, 30)).toBe(false);
    expect(rows.measure(5, 10)).toBe(false);
  });
});
