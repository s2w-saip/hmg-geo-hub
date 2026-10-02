import { describe, expect, it } from "vitest";
import { clampPaging, likePattern } from "./scope-context-map";

// The context map moved to page-sized server queries, and `page`/`size`/`search`
// now arrive from the client. These two functions are the whole guard between
// that input and the SQL — worth pinning, since the failure modes are exactly
// the ones this change exists to prevent (an unbounded payload) and a silently
// wrong result set.

describe("clampPaging", () => {
  it("caps size at the maximum", () => {
    // The point of the change is that no single request pulls the corpus.
    // size=100000 must not reinstate the 10MB payload.
    expect(clampPaging(0, 100_000).size).toBe(200);
  });

  it("keeps a size within range", () => {
    expect(clampPaging(0, 50).size).toBe(50);
  });

  it("floors size at 1", () => {
    expect(clampPaging(0, 0).size).toBe(50); // 0 is falsy → default
    expect(clampPaging(0, -5).size).toBe(1);
  });

  it("floors page at 0 — a negative offset would throw in Postgres", () => {
    expect(clampPaging(-3, 50)).toMatchObject({ page: 0, offset: 0 });
  });

  it("computes offset from page × size", () => {
    expect(clampPaging(3, 50).offset).toBe(150);
  });

  it("truncates fractional input", () => {
    // ?page=1.9 from a URL must not become a fractional OFFSET.
    expect(clampPaging(1.9, 50.7)).toMatchObject({ page: 1, size: 50, offset: 50 });
  });

  it("falls back to the default size for NaN", () => {
    expect(clampPaging(Number.NaN, Number.NaN)).toMatchObject({ page: 0, size: 50 });
  });
});

describe("likePattern", () => {
  it("wraps the term for a contains match", () => {
    expect(likePattern("아이오닉")).toBe("%아이오닉%");
  });

  it("escapes % — otherwise searching '50%' matches everything", () => {
    expect(likePattern("50%")).toBe("%50\\%%");
  });

  it("escapes _ — the single-char wildcard", () => {
    expect(likePattern("a_b")).toBe("%a\\_b%");
  });

  it("escapes backslashes so the escape char itself cannot be injected", () => {
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });

  it("leaves ordinary text alone", () => {
    expect(likePattern("3열 시트")).toBe("%3열 시트%");
  });
});
