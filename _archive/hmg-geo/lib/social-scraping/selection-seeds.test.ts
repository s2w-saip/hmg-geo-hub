import { describe, expect, it } from "vitest";
import {
  buildSelectionSeeds,
  MAX_SEL_CROSSES,
  type SelectionInput,
} from "./selection-seeds";

// The seed ids this builder emits are the dedup keys against every project's
// persisted prompt cache (see generate-context-prompts.ts buildSeeds). These
// tests pin the id formats and the skip/cap behaviour — a format drift would
// silently resurrect already-generated prompts on the next round.

function base(over: Partial<SelectionInput> = {}): SelectionInput {
  return {
    contexts: [],
    conditions: [],
    combinations: [],
    cross: false,
    excludeIds: new Set(),
    ...over,
  };
}

describe("buildSelectionSeeds", () => {
  it("emits the load-bearing id formats per layer", () => {
    const { seeds } = buildSelectionSeeds(
      base({
        contexts: [{ id: "c1", name: "캠핑족", mentionCount: 10 }],
        conditions: [{ id: "r1", name: "가성비", mentionCount: 8 }],
        combinations: [{ aId: "r1", aName: "가성비", bId: "r2", bName: "연비" }],
        cross: true,
      }),
    );
    expect(seeds.map((s) => s.id)).toEqual([
      "l1-c1",
      "l2-r1",
      "l3-r1:r2",
      "l3-c1-r1",
    ]);
    expect(seeds.map((s) => s.layer)).toEqual([
      "L1-context",
      "L2-condition",
      "L3-intersection",
      "L3-intersection",
    ]);
  });

  it("skips already-generated ids and counts them", () => {
    const { seeds, skippedExisting } = buildSelectionSeeds(
      base({
        contexts: [
          { id: "c1", name: "A", mentionCount: 10 },
          { id: "c2", name: "B", mentionCount: 5 },
        ],
        excludeIds: new Set(["l1-c1"]),
      }),
    );
    expect(seeds.map((s) => s.id)).toEqual(["l1-c2"]);
    expect(skippedExisting).toBe(1);
  });

  it("recognizes a combination excluded in the reversed orientation", () => {
    const { seeds, skippedExisting } = buildSelectionSeeds(
      base({
        combinations: [{ aId: "r1", aName: "가성비", bId: "r2", bName: "연비" }],
        excludeIds: new Set(["l3-r2:r1"]),
      }),
    );
    expect(seeds).toHaveLength(0);
    expect(skippedExisting).toBe(1);
  });

  it("caps crosses and keeps the strongest pairs first", () => {
    const contexts = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      name: `ctx${i}`,
      mentionCount: 100 - i,
    }));
    const conditions = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      name: `cond${i}`,
      mentionCount: 50 - i,
    }));
    const { seeds } = buildSelectionSeeds(base({ contexts, conditions, cross: true }));
    const crosses = seeds.filter((s) => s.id.startsWith("l3-c"));
    expect(crosses).toHaveLength(MAX_SEL_CROSSES);
    // Strongest pair (top context × top condition) survives the cap.
    expect(crosses[0].id).toBe("l3-c0-r0");
  });

  it("does not cross when cross=false", () => {
    const { seeds } = buildSelectionSeeds(
      base({
        contexts: [{ id: "c1", name: "A", mentionCount: 1 }],
        conditions: [{ id: "r1", name: "B", mentionCount: 1 }],
        cross: false,
      }),
    );
    expect(seeds.map((s) => s.id)).toEqual(["l1-c1", "l2-r1"]);
  });
});
