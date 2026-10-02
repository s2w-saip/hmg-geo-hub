import { describe, expect, it } from "vitest";
import { pctOrNull } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view";
import {
  ascendingDates,
  asOfDate,
  filterNotices,
  pct1OrNull,
  pct1OrZero,
  rankAvg,
  ratioValue,
  suppressionOf,
  unlessSuppressed,
  wholeSuppression,
} from "./convert";

// dashboard/_data/live.ts keeps its rounding helper private; this is its body verbatim.
const livePct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

describe("Ratio -> percent: each helper reproduces the legacy rule it replaces", () => {
  it("pct1OrZero matches dashboard live.ts pct() for every n <= d <= 400", () => {
    for (let d = 0; d <= 400; d += 1) {
      for (let n = 0; n <= d; n += 1) {
        if (pct1OrZero({ num: n, den: d }) !== livePct(n, d)) throw new Error(`mismatch ${n}/${d}`);
      }
    }
  });

  it("pct1OrNull matches kpi-view.ts pctOrNull() for every n <= d <= 400", () => {
    for (let d = 0; d <= 400; d += 1) {
      for (let n = 0; n <= d; n += 1) {
        if (pct1OrNull({ num: n, den: d }) !== pctOrNull(n, d)) throw new Error(`mismatch ${n}/${d}`);
      }
    }
  });

  it("the two legacy rules really differ at .x5 boundaries (why there are two helpers)", () => {
    expect(pct1OrZero({ num: 201, den: 400 })).toBe(50.2);
    expect(pct1OrNull({ num: 201, den: 400 })).toBe(50.3);
  });

  it("den 0 or missing ratio: zero vs null", () => {
    expect(pct1OrZero({ num: 0, den: 0 })).toBe(0);
    expect(pct1OrZero(null)).toBe(0);
    expect(pct1OrNull({ num: 3, den: 0 })).toBeNull();
    expect(pct1OrNull(undefined)).toBeNull();
    expect(ratioValue({ num: 1, den: 4 })).toBe(0.25);
    expect(ratioValue({ num: 1, den: 0 })).toBeNull();
  });
});

describe("RankAvg", () => {
  it("sum/count rounded to one decimal, null without ranked answers", () => {
    expect(rankAvg({ sum: 7, count: 3 })).toBe(2.3);
    expect(rankAvg({ sum: 5, count: 2 })).toBe(2.5);
    expect(rankAvg({ sum: 0, count: 0 })).toBeNull();
    expect(rankAvg(null)).toBeNull();
  });
});

describe("meta.suppressed", () => {
  const meta = { suppressed: { visibility: "no_data", "*": "source_pending" } };

  it("key reason first, then the whole-response '*' reason", () => {
    expect(suppressionOf(meta, "visibility")).toBe("no_data");
    expect(suppressionOf(meta, "share_of_voice")).toBe("source_pending");
    expect(wholeSuppression(meta)).toBe("source_pending");
    expect(suppressionOf({ suppressed: {} }, "x")).toBeNull();
    expect(suppressionOf(null, "x")).toBeNull();
  });

  it("an unknown reason code still suppresses (as unsupported)", () => {
    expect(suppressionOf({ suppressed: { x: "brand_new_code" } }, "x")).toBe("unsupported");
  });

  it("unlessSuppressed keeps 0 and 'not measured' apart", () => {
    expect(unlessSuppressed({ suppressed: {} }, "k", 0)).toBe(0);
    expect(unlessSuppressed({ suppressed: { k: "hidden" } }, "k", 0)).toBeNull();
  });
});

describe("filter notices, as_of, dates", () => {
  it("collects ignored and non-empty dropped axes", () => {
    const n = filterNotices({ ignored_filters: ["lang"], dropped_filters: { brand: ["HMG"], country: [] } });
    expect(n).toEqual({ ignored: ["lang"], dropped: { brand: ["HMG"] }, hasAny: true });
    expect(filterNotices({ ignored_filters: [], dropped_filters: {} }).hasAny).toBe(false);
    expect(filterNotices(undefined).hasAny).toBe(false);
  });

  it("as_of passes through; dates become ascending (API sends newest first)", () => {
    expect(asOfDate({ as_of: "2026-09-25" })).toBe("2026-09-25");
    expect(asOfDate({})).toBeNull();
    expect(ascendingDates(["2026-09-25", "2026-09-18", "2026-09-11"])).toEqual(["2026-09-11", "2026-09-18", "2026-09-25"]);
    expect(ascendingDates(null)).toEqual([]);
  });
});
