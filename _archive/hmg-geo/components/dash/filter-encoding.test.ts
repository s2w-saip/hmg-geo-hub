import { describe, expect, it } from "vitest";
import { encodeTimeRange, parseTimeRange } from "./filter-encoding";

// 기간(time) 축 인코딩 계약 — 클라이언트 패널(write)과 서버 파서
// readStandardFilters(read)가 공유하는 round-trip 이므로 양방향을 고정한다.

describe("encodeTimeRange", () => {
  it("encodes a full range", () => {
    expect(encodeTimeRange({ from: "2026-06-01", to: "2026-06-30" })).toBe(
      "2026-06-01..2026-06-30",
    );
  });

  it("encodes open-ended sides", () => {
    expect(encodeTimeRange({ from: "2026-06-01" })).toBe("2026-06-01..");
    expect(encodeTimeRange({ to: "2026-06-30" })).toBe("..2026-06-30");
  });

  it("drops malformed dates; both empty → null", () => {
    expect(encodeTimeRange({ from: "june 1st", to: "2026-06-30" })).toBe(
      "..2026-06-30",
    );
    expect(encodeTimeRange({})).toBeNull();
    expect(encodeTimeRange({ from: "nope" })).toBeNull();
  });
});

describe("parseTimeRange", () => {
  it("round-trips what encodeTimeRange produced", () => {
    expect(parseTimeRange("2026-06-01..2026-06-30")).toEqual({
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(parseTimeRange("2026-06-01..")).toEqual({ from: "2026-06-01", to: undefined });
    expect(parseTimeRange("..2026-06-30")).toEqual({ from: undefined, to: "2026-06-30" });
  });

  it("swaps from > to (클라이언트가 뒤집힌 범위를 보내도 서버는 복원)", () => {
    expect(parseTimeRange("2026-06-30..2026-06-01")).toEqual({
      from: "2026-06-01",
      to: "2026-06-30",
    });
  });

  it("rejects malformed input → null (축 미적용)", () => {
    expect(parseTimeRange(null)).toBeNull();
    expect(parseTimeRange(undefined)).toBeNull();
    expect(parseTimeRange("")).toBeNull();
    expect(parseTimeRange("2026-06-01")).toBeNull(); // separator 없음
    expect(parseTimeRange("abc..def")).toBeNull();
    expect(parseTimeRange("2026-6-1..2026-6-30")).toBeNull(); // zero-pad 필수
  });

  it("accepts Next server searchParams array form (first value wins)", () => {
    expect(parseTimeRange(["2026-06-01..2026-06-30", "junk"])).toEqual({
      from: "2026-06-01",
      to: "2026-06-30",
    });
  });
});
