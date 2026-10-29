import { describe, expect, it } from "vitest";
import type { PerspectiveBreakdown } from "./types";

// The perspective filter used to DIM (opacity-25) instead of filtering: rows
// stayed in the DOM and the group header still showed the unfiltered count, so
// picking "긍정" left you scanning the same list. This pins the predicate and
// the grouping behaviour the view now derives its memos from.
//
// Mirrors context-node-map-view's `inPerspective` + visibleThemes/visibleCategories
// shape. If that changes, this changes with it.

type Persp = "all" | "buyer" | "seller" | "neutral";

function inPerspective(pb: PerspectiveBreakdown | undefined, filter: Persp): boolean {
  return filter === "all" || (pb?.[filter] ?? 0) > 0;
}

type Item = { name: string; mention_count: number; perspective_breakdown?: PerspectiveBreakdown };

function visibleGroups(groups: Array<{ items: Item[] }>, filter: Persp) {
  return groups
    .map((g) => ({
      items: g.items
        .map((item, originalIndex) => ({ item, originalIndex }))
        .filter(({ item }) => inPerspective(item.perspective_breakdown, filter))
        .sort((a, b) => b.item.mention_count - a.item.mention_count),
    }))
    .filter((g) => g.items.length > 0);
}

const pb = (buyer: number, seller: number, neutral: number): PerspectiveBreakdown => ({
  buyer,
  seller,
  neutral,
});

describe("inPerspective", () => {
  it('keeps everything under "all"', () => {
    expect(inPerspective(pb(0, 0, 0), "all")).toBe(true);
    expect(inPerspective(undefined, "all")).toBe(true);
  });

  it("keeps a row with a non-zero count for the selected perspective", () => {
    expect(inPerspective(pb(3, 0, 0), "buyer")).toBe(true);
  });

  it("drops a row with zero for the selected perspective — it used to be dimmed, not dropped", () => {
    expect(inPerspective(pb(0, 5, 2), "buyer")).toBe(false);
  });

  it("drops a row with no breakdown at all rather than crashing", () => {
    expect(inPerspective(undefined, "buyer")).toBe(false);
  });
});

describe("visibleGroups", () => {
  const groups = [
    {
      items: [
        { name: "a", mention_count: 5, perspective_breakdown: pb(2, 0, 0) },
        { name: "b", mention_count: 9, perspective_breakdown: pb(0, 4, 0) },
        { name: "c", mention_count: 7, perspective_breakdown: pb(1, 1, 0) },
      ],
    },
    { items: [{ name: "d", mention_count: 3, perspective_breakdown: pb(0, 2, 0) }] },
  ];

  it("removes non-matching rows so the count reflects the filter", () => {
    const out = visibleGroups(groups, "buyer");
    expect(out).toHaveLength(1); // group 2 is entirely seller → gone
    expect(out[0].items.map((i) => i.item.name)).toEqual(["c", "a"]); // 7 then 5
  });

  it("drops a group whose rows are all filtered out — no empty header left behind", () => {
    expect(visibleGroups(groups, "neutral")).toHaveLength(0);
  });

  it("preserves the ORIGINAL index — node ids depend on it", () => {
    // Node id is `ctx-<themeIdx>-<originalIndex>`. Using the post-filter
    // position would point the graph highlight at the wrong node.
    const out = visibleGroups(groups, "buyer");
    expect(out[0].items.map((i) => i.originalIndex)).toEqual([2, 0]); // c=2, a=0
  });

  it("sorts by mention_count desc within a group", () => {
    const out = visibleGroups(groups, "all");
    expect(out[0].items.map((i) => i.item.mention_count)).toEqual([9, 7, 5]);
  });

  it("does not mutate the input", () => {
    const before = groups[0].items.map((i) => i.name);
    visibleGroups(groups, "all");
    expect(groups[0].items.map((i) => i.name)).toEqual(before);
  });
});
