import { describe, expect, it } from "vitest";
import {
  nextActiveAfterRemoval,
  restoreHidden,
  type KeywordTab,
} from "./keyword-selection";

const tabs: KeywordTab[] = [
  { id: "a", label: "아이오닉5" },
  { id: "b", label: "EV3" },
  { id: "c", label: "전기차 보조금" },
  { id: "d", label: "아이오닉6" },
];

describe("nextActiveAfterRemoval", () => {
  it("keeps the active tab when it is not being deleted", () => {
    expect(nextActiveAfterRemoval(tabs, new Set(["a", "d"]), "b")).toBe("b");
  });

  it("falls back to the nearest surviving tab on the left", () => {
    expect(nextActiveAfterRemoval(tabs, new Set(["c"]), "c")).toBe("b");
  });

  it("skips over other deleted tabs when walking left", () => {
    expect(nextActiveAfterRemoval(tabs, new Set(["b", "c"]), "c")).toBe("a");
  });

  it("falls back to the right when nothing survives on the left", () => {
    expect(nextActiveAfterRemoval(tabs, new Set(["a", "b"]), "a")).toBe("c");
  });

  it("returns empty string when every tab is deleted", () => {
    expect(
      nextActiveAfterRemoval(tabs, new Set(["a", "b", "c", "d"]), "b"),
    ).toBe("");
  });

  it("handles the active tab being unknown to the list", () => {
    expect(nextActiveAfterRemoval(tabs, new Set(["zz"]), "zz")).toBe("a");
  });

  it("returns empty string for an empty tab list", () => {
    expect(nextActiveAfterRemoval([], new Set(["a"]), "a")).toBe("");
  });

  it("does not mutate the caller's tab array", () => {
    const input = [...tabs];
    nextActiveAfterRemoval(input, new Set(["c"]), "c");
    expect(input).toEqual(tabs);
  });
});

describe("restoreHidden", () => {
  it("removes only the named keys", () => {
    const hidden = new Set(["a|KR|serp-1", "a|KR|serp-2", "b|KR|serp-1"]);
    const restored = restoreHidden(hidden, new Set(["a|KR|serp-1", "a|KR|serp-2"]));
    expect([...restored]).toEqual(["b|KR|serp-1"]);
  });

  it("leaves another tab's hidden rows alone — ids are positional and collide", () => {
    // serp-1 exists under every tab; restoring tab a must not unhide tab b's.
    const hidden = new Set(["a|KR|serp-1", "b|KR|serp-1"]);
    expect([...restoreHidden(hidden, new Set(["a|KR|serp-1"]))]).toEqual([
      "b|KR|serp-1",
    ]);
  });

  it("is a no-op when no key matches", () => {
    const hidden = new Set(["a|KR|serp-1"]);
    expect([...restoreHidden(hidden, new Set(["c|US|serp-9"]))]).toEqual([
      "a|KR|serp-1",
    ]);
  });

  it("does not mutate the input set", () => {
    const hidden = new Set(["a|KR|serp-1", "b|KR|serp-1"]);
    restoreHidden(hidden, new Set(["a|KR|serp-1"]));
    expect(hidden.size).toBe(2);
  });
});
