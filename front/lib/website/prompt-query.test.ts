import { describe, expect, it } from "vitest";
import {
  readWebsitePromptQuery,
  searchParamsToRecord,
  websitePromptFilterGroups,
} from "./prompt-query";
import type { AllowedScope } from "@/lib/auth/types";

// 이 모듈의 존재 이유는 하나다 — **화면과 내보내기가 같은 술어를 보게 하는 것**.
// 화면은 Next 가 파싱한 `searchParams`(중복 키 → 배열)를, 라우트는 URLSearchParams
// 를 받는다. 두 입구가 같은 결과로 수렴하는지를 여기서 고정한다.

const admin: AllowedScope = { all: true };

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

describe("readWebsitePromptQuery — 화면/내보내기 동일 파생", () => {
  const qs = "geography=KR&geography=US&language=ko&engine=chatgpt&q=GV80&sort=brand&dir=asc&page=3";

  it("두 입구(서버 컴포넌트 searchParams · URLSearchParams)가 같은 결과로 수렴한다", () => {
    // 서버 컴포넌트가 받는 형태를 손으로 흉내낸 것
    const fromPage = readWebsitePromptQuery(
      {
        geography: ["KR", "US"],
        language: "ko",
        engine: "chatgpt",
        q: "GV80",
        sort: "brand",
        dir: "asc",
        page: "3",
      },
      admin,
      true,
    );
    const fromRoute = readWebsitePromptQuery(
      searchParamsToRecord(new URLSearchParams(qs)),
      admin,
      true,
    );
    expect(fromRoute).toEqual(fromPage);
  });

  it("geography → website country 로 옮겨진다 (region 이 아니다)", () => {
    const q = readWebsitePromptQuery({ geography: "KR~US" }, admin, true);
    expect(q.filters.countries).toEqual(["KR", "US"]);
  });

  it("정렬 화이트리스트 밖 / 잘못된 page 는 기본값", () => {
    const q = readWebsitePromptQuery(
      { sort: "1=1", dir: "nope", page: "-2" },
      admin,
      true,
    );
    expect(q.sort).toBe("lastMeasuredAt");
    expect(q.dir).toBe("desc");
    expect(q.page).toBe(1);
  });

  it("비 admin 에겐 brand 축이 노출 축이 아니다 — URL ?brand 가 무시된다", () => {
    expect(websitePromptFilterGroups(false)).not.toContain("brand");
    expect(websitePromptFilterGroups(true)).toContain("brand");
    // scope.all 인데 brand 축이 숨겨진 가상의 계정: 숨은 축 URL 누수 방지
    // (readStandardFilters 의 visibleGroups) 가 걸려 brand 가 적용되지 않는다.
    const q = readWebsitePromptQuery({ brand: "Genesis" }, admin, false);
    expect(q.filters.brands).toBeUndefined();
  });

  it("브랜드 스코프는 URL 로 넓힐 수 없다 (D4 하드락)", () => {
    const kia: AllowedScope = { all: false, brands: ["Kia"], countries: ["KR"] };
    const q = readWebsitePromptQuery({ brand: "Genesis" }, kia, true);
    expect(q.filters.brands).toContain("Kia");
    expect(q.filters.brands).not.toContain("Genesis");
  });

  it("웹사이트 브랜드 가상 지역 코드(HYUNDAI-N)는 그 브랜드 계정에서 살아남는다", () => {
    // 기존 링크·북마크 호환. 옵션 드롭다운에서는 내렸지만(브랜드 축으로 이동)
    // URL 로 들어오면 술어가 그대로 해석한다.
    const n: AllowedScope = { all: false, brands: ["Hyundai N"], countries: ["KR", "worldwide"] };
    const q = readWebsitePromptQuery({ geography: "HYUNDAI-N" }, n, false);
    expect(q.filters.countries).toEqual(["HYUNDAI-N"]);
  });
});
