import { describe, expect, it } from "vitest";
import { RN_COMPARE, RN_OTHER, RN_SERIES, rnCompareColor } from "./palette";

// Chart - Other is the palette's 15 competitor colours (the user's list, 2026-11-05): every one of them marks a
// competitor brand. It was read as three compare colours (orange · pink · purple bases) plus tints, with a fourth
// orange taken off the image, and that capped the compare brands at three.
const USER_LIST = [
  "#ffbe42", "#ffce71", "#ffdfa0", "#ffebc6",
  "#ff7651", "#ff9174", "#ffb49f",
  "#ff0082", "#ff59ae", "#ff99cd", "#ffbfe0",
  "#c00ced", "#d355f3", "#ecb6fa", "#f2cefb",
];

describe("renewal palette: Chart - Other", () => {
  it("is the user's 15 colours, each once, with no fourth orange", () => {
    expect([...RN_COMPARE].sort()).toEqual([...USER_LIST].sort());
    expect(Object.values(RN_OTHER).flat().sort()).toEqual([...USER_LIST].sort());
    expect(RN_COMPARE).not.toContain("#ffd6cb");
  });

  it("gives competitors each hue's base first (orange · pink · purple · yellow), then the next steps", () => {
    expect(RN_COMPARE.slice(0, 4)).toEqual(["#ff7651", "#ff0082", "#c00ced", "#ffbe42"]);
    expect(RN_COMPARE.slice(4, 8)).toEqual(["#ff9174", "#ff59ae", "#d355f3", "#ffce71"]);
    // orange has three steps, so the last step is pink · purple · yellow only
    expect(RN_COMPARE.slice(12)).toEqual(["#ffbfe0", "#f2cefb", "#ffebc6"]);
    // the non-competitor hued series stay the first three
    expect([...RN_SERIES]).toEqual(RN_COMPARE.slice(0, 3));
  });

  it("colours any number of picks: past the fifteenth the list starts again", () => {
    expect(rnCompareColor(3)).toBe("#ffbe42");
    expect(rnCompareColor(14)).toBe("#ffebc6");
    expect(rnCompareColor(15)).toBe(rnCompareColor(0));
  });
});
