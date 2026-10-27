import { describe, expect, it } from "vitest";
import { searchParamsToRecord } from "./search-params";

describe("searchParamsToRecord — Next 의미론", () => {
  it("같은 키가 여러 번이면 배열, 한 번이면 문자열", () => {
    const rec = searchParamsToRecord(
      new URLSearchParams("geography=KR&geography=US&q=GV80"),
    );
    expect(rec.geography).toEqual(["KR", "US"]);
    expect(rec.q).toBe("GV80");
  });

  it("없는 키는 undefined (빈 문자열이 아니다)", () => {
    const rec = searchParamsToRecord(new URLSearchParams("q=x"));
    expect(rec.geography).toBeUndefined();
  });

  it("`forEach` 평탄화와 결과가 다르다 — 이것이 이 함수가 있는 이유", () => {
    const sp = new URLSearchParams("geography=KR&geography=US");
    const flattened: Record<string, string> = {};
    sp.forEach((v, k) => {
      flattened[k] = v; // 기존 /api/scope/* 관례 — 마지막 값만 남는다
    });
    expect(flattened.geography).toBe("US");
    expect(searchParamsToRecord(sp).geography).toEqual(["KR", "US"]);
  });
});
