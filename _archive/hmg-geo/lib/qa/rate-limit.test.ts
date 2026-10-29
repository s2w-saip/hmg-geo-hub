import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hit, __resetRateLimit } from "./rate-limit";

beforeEach(() => {
  __resetRateLimit();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("rate limit", () => {
  it("한도까지는 통과, 넘으면 막는다", () => {
    for (let i = 0; i < 3; i++) expect(hit("k", 3, 60_000)).toBe(true);
    expect(hit("k", 3, 60_000)).toBe(false);
  });

  it("창이 지나면 초기화된다", () => {
    for (let i = 0; i < 3; i++) hit("k", 3, 60_000);
    expect(hit("k", 3, 60_000)).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(hit("k", 3, 60_000)).toBe(true);
  });

  it("키가 다르면 서로 영향이 없다", () => {
    for (let i = 0; i < 3; i++) hit("a", 3, 60_000);
    expect(hit("b", 3, 60_000)).toBe(true);
  });
});
