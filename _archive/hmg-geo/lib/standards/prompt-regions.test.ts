import { describe, expect, it } from "vitest";
import {
  normalizePromptRegions,
  normalizePromptLang,
  regionsForAudit,
  sameRegions,
} from "./prompt-regions";

const VOCAB = ["KR", "US", "DE", "CN", "x:WW", "x:CPO"];

describe("normalizePromptRegions", () => {
  it("null 은 미지정(상속) 그대로 — '아무 시장도 아님'이 아니다", () => {
    expect(normalizePromptRegions(null, VOCAB)).toEqual({
      value: null,
      invalid: [],
      outOfVocabulary: [],
    });
    expect(normalizePromptRegions(undefined, VOCAB).value).toBeNull();
  });

  it("빈 배열은 null 로 접는다 — 저장 시맨틱을 하나로 모은다", () => {
    expect(normalizePromptRegions([], VOCAB).value).toBeNull();
    expect(normalizePromptRegions(["", "  "], VOCAB).value).toBeNull();
  });

  it("트림·대문자화·중복 제거·정렬", () => {
    expect(normalizePromptRegions([" us ", "kr", "US"], VOCAB).value).toEqual(["KR", "US"]);
  });

  it("정렬은 감사 로그의 가짜 변경을 막기 위한 것이다", () => {
    // computeChanges 가 String(v) 직렬화라, 순서만 다르면 다른 변경으로 기록된다.
    const a = normalizePromptRegions(["US", "KR"], VOCAB).value;
    const b = normalizePromptRegions(["KR", "US"], VOCAB).value;
    expect(regionsForAudit(a)).toBe(regionsForAudit(b));
  });

  it("의사코드(x:)를 지원하고 접두사 대소문자를 흡수한다", () => {
    expect(normalizePromptRegions(["X:WW", "x:cpo"], VOCAB).value).toEqual(["x:CPO", "x:WW"]);
  });

  it("★ 형식 오류와 어휘 밖을 구분해서 돌려준다", () => {
    // 뭉뚱그리면 사용자가 '오타'인지 '권한 밖'인지 모른다 — 벌크에서는 그 구분이
    // "행을 고치면 되는가 / 프로젝트 설정을 바꿔야 하는가"다.
    const r = normalizePromptRegions(["KR", "ZZZZ", "JP"], VOCAB);
    expect(r.value).toEqual(["KR"]);
    expect(r.invalid).toEqual(["ZZZZ"]); // 형식 아님
    expect(r.outOfVocabulary).toEqual(["JP"]); // 형식은 맞으나 루트 시장 밖
  });

  it("거절된 코드는 값에 섞이지 않는다", () => {
    const r = normalizePromptRegions(["JP", "ZZZZ"], VOCAB);
    expect(r.value).toBeNull();
  });

  it("★ 어휘가 비면 상한이 없다 — 없는 상한을 있는 것처럼 굴지 않는다", () => {
    // 루트 프로젝트가 아직 시장을 안 정한 상태에서 전부 거절하면 정상 입력이 막힌다.
    expect(normalizePromptRegions(["JP", "BR"], []).value).toEqual(["BR", "JP"]);
    expect(normalizePromptRegions(["JP"], null).outOfVocabulary).toEqual([]);
    // 그래도 형식 검사는 남는다.
    expect(normalizePromptRegions(["nope!"], null).invalid).toEqual(["NOPE!"]);
  });

  it("같은 오류를 중복 보고하지 않는다", () => {
    expect(normalizePromptRegions(["JP", "JP"], VOCAB).outOfVocabulary).toEqual(["JP"]);
  });
});

describe("normalizePromptLang", () => {
  it("빈 값·null 은 미지정", () => {
    expect(normalizePromptLang(null)).toEqual({ value: null, invalid: null });
    expect(normalizePromptLang("  ")).toEqual({ value: null, invalid: null });
  });

  it("대문자화한다 (시트 코드 규약)", () => {
    expect(normalizePromptLang("ko").value).toBe("KO");
  });

  it("두 글자가 아니면 invalid — 조용히 버리지 않는다", () => {
    expect(normalizePromptLang("kor")).toEqual({ value: null, invalid: "KOR" });
    expect(normalizePromptLang("k")).toEqual({ value: null, invalid: "K" });
  });
});

describe("regionsForAudit · sameRegions", () => {
  it("null 과 빈 배열은 둘 다 null — '전체'로 같다", () => {
    expect(regionsForAudit(null)).toBeNull();
    expect(regionsForAudit([])).toBeNull();
    expect(sameRegions(null, [])).toBe(true);
  });

  it("순서·중복이 달라도 같은 집합이면 같다", () => {
    expect(sameRegions(["US", "KR"], ["KR", "US"])).toBe(true);
  });

  it("실제로 다르면 다르다", () => {
    expect(sameRegions(["KR"], ["KR", "US"])).toBe(false);
    expect(sameRegions(null, ["KR"])).toBe(false);
  });

  it("정렬 CSV 로 직렬화한다", () => {
    expect(regionsForAudit(["US", "KR", "DE"])).toBe("DE,KR,US");
  });
});
