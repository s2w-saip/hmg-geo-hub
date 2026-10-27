import { describe, expect, it } from "vitest";
import { pct1OrNull, ratioValue } from "./convert";

// The legacy pctOrNull() (answer-analysis view model) the helper reproduces bit for bit.
const round1 = (n: number) => Math.round(n * 10) / 10;
const legacyPctOrNull = (n: number, d: number) => (d > 0 ? round1((100 * n) / d) : null);

describe("Ratio -> percent", () => {
  it("pct1OrNull matches the legacy pctOrNull() for every n <= d <= 400", () => {
    for (let d = 0; d <= 400; d += 1) {
      for (let n = 0; n <= d; n += 1) {
        if (pct1OrNull({ num: n, den: d }) !== legacyPctOrNull(n, d)) throw new Error(`mismatch ${n}/${d}`);
      }
    }
  });

  it("rounds half up at .x5 boundaries (201/400 -> 50.3)", () => {
    expect(pct1OrNull({ num: 201, den: 400 })).toBe(50.3);
  });

  it("den 0 or missing ratio: null", () => {
    expect(pct1OrNull({ num: 3, den: 0 })).toBeNull();
    expect(pct1OrNull(undefined)).toBeNull();
    expect(ratioValue({ num: 1, den: 4 })).toBe(0.25);
    expect(ratioValue({ num: 1, den: 0 })).toBeNull();
  });
});
