import { describe, it, expect } from "vitest";
import { readStandardFilters, standardFilterKey } from "./standard-filters";

// 언어 코드 케이싱 규약의 정본 테스트 (2026-09-03).
//
// 종전에는 세 갈래가 그대로 흘러다녔다: 정적 폴백(소문자) · website_prompts
// .lang_code(소문자) · scope_prompts.lang / prompts.lang(대문자). 표준 표면이
// language 축을 실제로 쓰게 되면서 한 규약으로 고정한다 —
// **URL·옵션·filters.lang 은 소문자 BCP-47**, 대문자 저장값은 술어가 upper() 로 맞춘다
// (lib/db/repositories/scope-aggregates::langAxisPred).
// 근거: (내부 설계 문서) §2-A

describe("readStandardFilters — language 축 케이싱", () => {
  it("?language= 값을 소문자로 정규화한다", () => {
    expect(readStandardFilters({ language: "KO" }).lang).toEqual(["ko"]);
  });

  it("이미 소문자면 그대로 통과한다", () => {
    expect(readStandardFilters({ language: "ko" }).lang).toEqual(["ko"]);
  });

  it("다중 선택도 전부 소문자화한다 (구분자는 filter-encoding 규약)", () => {
    const lang = readStandardFilters({ language: ["KO", "en"] }).lang;
    expect(lang).toEqual(["ko", "en"]);
  });

  it("미지정이면 undefined — 축을 만들지 않는다", () => {
    expect(readStandardFilters({}).lang).toBeUndefined();
  });

  it("노출 축 allowlist 밖이면 URL 값을 버린다 (숨은 필터 누수 방지)", () => {
    const lang = readStandardFilters({ language: "ko" }, undefined, ["geography", "engine"]).lang;
    expect(lang).toBeUndefined();
  });
});

describe("standardFilterKey — lang 이 캐시 키에 들어간다", () => {
  // STANDARD_FILTER_ARRAY_AXES 파생이라 구조적으로 보장되지만, 이 축이 키에서
  // 빠지면 언어별 결과가 같은 캐시 셀을 공유하는 stale-cache 버그가 된다
  // (brandPresence·sourceCategory 로 세 번 실제로 터졌던 종류).
  it("언어 선택이 다르면 키가 다르다", () => {
    expect(standardFilterKey({ lang: ["ko"] })).not.toEqual(standardFilterKey({ lang: ["en"] }));
  });

  it("선택 순서가 달라도 같은 키다 (정렬)", () => {
    expect(standardFilterKey({ lang: ["ko", "en"] })).toEqual(
      standardFilterKey({ lang: ["en", "ko"] }),
    );
  });

  it("무선택과 선택은 다른 키다", () => {
    expect(standardFilterKey({})).not.toEqual(standardFilterKey({ lang: ["ko"] }));
  });
});

describe("readStandardFilters — 웹사이트 브랜드 가상 지역 코드(HYUNDAI-N)", () => {
  const nBrandScope = { all: false, brands: ["Hyundai N"], countries: ["worldwide", "KR"] };

  it("스코프 브랜드가 그 브랜드면 국가 집합 밖이어도 통과한다 (계정 17)", () => {
    expect(readStandardFilters({ geography: "HYUNDAI-N" }, nBrandScope).region).toEqual(["HYUNDAI-N"]);
  });

  it("스코프 브랜드가 다르면 버리고 허용 국가 전체로 되돌린다 (권한 확장 불가)", () => {
    const scope = { all: false, brands: ["Hyundai"], countries: ["worldwide", "KR"] };
    expect(readStandardFilters({ geography: "HYUNDAI-N" }, scope).region).toEqual(["worldwide", "KR"]);
  });

  it("admin(scope.all)은 그대로 통과한다", () => {
    expect(readStandardFilters({ geography: ["HYUNDAI-N", "KR"] }, { all: true }).region).toEqual(["HYUNDAI-N", "KR"]);
  });
});
