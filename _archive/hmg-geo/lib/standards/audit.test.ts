import { describe, it, expect } from "vitest";
import { computeChanges } from "@/lib/standards/audit";

describe("computeChanges — 바뀐 필드만 old/new로", () => {
  it("변경된 필드만 담는다", () => {
    const before = { text: "old text", brand: "Kia", depth1: null };
    const after = { text: "new text", brand: "Kia", depth1: null };
    expect(computeChanges(before, after, ["text", "brand", "depth1"])).toEqual({
      text: { old: "old text", new: "new text" },
    });
  });

  it("null↔값 전이를 기록한다", () => {
    expect(computeChanges({ depth4: null }, { depth4: "EV" }, ["depth4"])).toEqual({
      depth4: { old: null, new: "EV" },
    });
    expect(computeChanges({ depth4: "EV" }, { depth4: null }, ["depth4"])).toEqual({
      depth4: { old: "EV", new: null },
    });
  });

  it("after에 없는(undefined) 필드는 건드리지 않은 것으로 본다", () => {
    expect(computeChanges({ text: "t" }, {}, ["text"])).toEqual({});
    expect(computeChanges({ text: "t" }, { text: undefined }, ["text"])).toEqual({});
  });

  it("전부 동일하면 빈 객체", () => {
    expect(computeChanges({ text: "t" }, { text: "t" }, ["text"])).toEqual({});
  });

  it("fields에 없는 키는 after에 있어도 무시한다", () => {
    expect(computeChanges({ a: "1" }, { a: "2", b: "x" }, ["a"])).toEqual({
      a: { old: "1", new: "2" },
    });
  });
});
