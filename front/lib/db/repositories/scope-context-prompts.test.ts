import { describe, expect, it } from "vitest";
import type { GeneratedPrompt } from "@/components/social-scraping/types";

// The lost-update guard, tested against an in-memory stand-in for the row.
//
// The real repository is one UPDATE ... WHERE version = ? — there is no pure
// function to unit test, and no DB in CI. So this models the row and the two
// writers, and asserts the property that matters: an overlapping pair of edits
// must not silently drop one. The model mirrors setIfUnchanged exactly (compare
// token, bump on success, refuse otherwise); if that contract changes, this test
// is the thing that has to change with it.
//
// The bug this pins: "더 생성" and "선택 삭제" both do get() → mutate → write the
// WHOLE blob. Before the guard, the later write won unconditionally, so a user
// saw a deleted prompt reappear (or a generated batch vanish).

type Row = { prompts: GeneratedPrompt[]; version: number } | null;

function makePrompt(id: string): GeneratedPrompt {
  return {
    id,
    question: `q-${id}`,
    layer: "L1-context",
    funnelStage: "awareness",
    sourceLabel: id,
    priority: 50,
  };
}

/** Mirrors scopeContextPromptRepository.setIfUnchanged. */
function setIfUnchanged(
  store: { row: Row },
  prompts: GeneratedPrompt[],
  expectedVersion: number | null,
): boolean {
  if (expectedVersion === null) {
    if (store.row) return false; // someone inserted first → DO NOTHING
    store.row = { prompts, version: 1 };
    return true;
  }
  if (!store.row || store.row.version !== expectedVersion) return false;
  store.row = { prompts, version: expectedVersion + 1 };
  return true;
}

describe("prompt cache optimistic lock", () => {
  it("accepts a write when nothing changed underneath", () => {
    const store = { row: { prompts: [makePrompt("a")], version: 3 } as Row };
    expect(setIfUnchanged(store, [makePrompt("a"), makePrompt("b")], 3)).toBe(true);
    expect(store.row?.version).toBe(4);
  });

  it("refuses a write whose token is stale", () => {
    const store = { row: { prompts: [makePrompt("a")], version: 4 } as Row };
    // Reader saw v3; someone already bumped it to v4.
    expect(setIfUnchanged(store, [makePrompt("zzz")], 3)).toBe(false);
    expect(store.row?.prompts.map((p) => p.id)).toEqual(["a"]); // untouched
  });

  it("does not lose the delete when generate lands first (the reported bug)", () => {
    const store = { row: { prompts: [makePrompt("a"), makePrompt("b")], version: 1 } as Row };

    // Both read v1.
    const deleterSaw = { prompts: store.row!.prompts, version: store.row!.version };
    const generatorSaw = { prompts: store.row!.prompts, version: store.row!.version };

    // Generator writes first: appends c.
    expect(
      setIfUnchanged(store, [...generatorSaw.prompts, makePrompt("c")], generatorSaw.version),
    ).toBe(true);

    // Deleter's write is refused — its snapshot has no "c" and would drop it.
    const deleted = deleterSaw.prompts.map((p) =>
      p.id === "a" ? { ...p, removed: true } : p,
    );
    expect(setIfUnchanged(store, deleted, deleterSaw.version)).toBe(false);
    expect(store.row?.prompts.map((p) => p.id)).toEqual(["a", "b", "c"]); // c survived

    // Retry re-applies the delete intent onto the FRESH set — nothing is lost.
    const fresh = store.row!;
    const reapplied = fresh.prompts.map((p) => (p.id === "a" ? { ...p, removed: true } : p));
    expect(setIfUnchanged(store, reapplied, fresh.version)).toBe(true);
    expect(store.row?.prompts.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(store.row?.prompts.find((p) => p.id === "a")?.removed).toBe(true);
  });

  it("does not lose the generate when delete lands first", () => {
    const store = { row: { prompts: [makePrompt("a")], version: 1 } as Row };
    const generatorSaw = { prompts: store.row!.prompts, version: store.row!.version };

    const deleted = store.row!.prompts.map((p) => ({ ...p, removed: true }));
    expect(setIfUnchanged(store, deleted, 1)).toBe(true);

    // Generator's stale append is refused; retrying onto the fresh set keeps the
    // delete AND adds the new prompt.
    expect(
      setIfUnchanged(store, [...generatorSaw.prompts, makePrompt("b")], generatorSaw.version),
    ).toBe(false);
    const fresh = store.row!;
    expect(setIfUnchanged(store, [...fresh.prompts, makePrompt("b")], fresh.version)).toBe(true);
    expect(store.row?.prompts.find((p) => p.id === "a")?.removed).toBe(true);
    expect(store.row?.prompts.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("first-generation insert does not clobber a racer who inserted first", () => {
    const store = { row: null as Row };
    // Two requests both read "no row" → both carry null.
    expect(setIfUnchanged(store, [makePrompt("first")], null)).toBe(true);
    expect(setIfUnchanged(store, [makePrompt("second")], null)).toBe(false);
    expect(store.row?.prompts.map((p) => p.id)).toEqual(["first"]);
  });

  it("bumps the token on every accepted write so tokens are never reused", () => {
    const store = { row: null as Row };
    setIfUnchanged(store, [makePrompt("a")], null);
    const seen = new Set<number>([store.row!.version]);
    for (let i = 0; i < 5; i++) {
      const v = store.row!.version;
      setIfUnchanged(store, [makePrompt(`p${i}`)], v);
      expect(seen.has(store.row!.version)).toBe(false);
      seen.add(store.row!.version);
    }
  });
});
