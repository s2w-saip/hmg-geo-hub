import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { __testables } from "./website-sites";
import type { AllowedScope } from "@/lib/auth/types";

// /website/prompts 행 필터의 **SQL 형태** 고정.
//
// 이 술어의 결함은 예외를 내지 않는다 — 조용히 0건이 되고, 화면은 "조건에 맞는
// 프롬프트가 없습니다"를 정상처럼 띄운다. 2026-09-06 에 도입된 브랜드 가상 코드
// (HYUNDAI-N)가 정확히 그 형태로 죽어 있었다: 옵션 드롭다운에는 떴는데
// (listWebsiteCountries) 목록 질의는 `ws.country_code IN ('HYUNDAI-N')` 이라
// **admin 포함 전 계정이 0건**이었다. 그래서 값이 아니라 형태를 못 박는다.

const dialect = new PgDialect();
const compile = (w: SQL) => {
  const q = dialect.sqlToQuery(w);
  return { text: q.sql, params: q.params };
};

const admin: AllowedScope = { all: true };

describe("websitePromptRowWhere — 브랜드 가상 지역 코드", () => {
  it("HYUNDAI-N 은 country_code 가 아니라 brand 로 푼다", () => {
    const { text, params } = compile(
      __testables.websitePromptRowWhere(admin, { countries: ["HYUNDAI-N"] }),
    );
    expect(text).toContain("ws.brand IN (");
    expect(text).not.toContain("ws.country_code IN (");
    // 가상 코드가 파라미터로 새면 그 자체가 0건 지문이다.
    expect(params).toEqual(["Hyundai N"]);
  });

  it("실 국가와 섞이면 OR 로 결합한다 (worldwide 선택은 종전 그대로)", () => {
    const { text, params } = compile(
      __testables.websitePromptRowWhere(admin, { countries: ["worldwide", "HYUNDAI-N"] }),
    );
    expect(text).toMatch(/ws\.country_code IN \(.+\) OR ws\.brand IN \(/);
    expect(params).toEqual(["worldwide", "Hyundai N"]);
  });

  it("가상 코드가 없으면 종전 형태 그대로", () => {
    const { text, params } = compile(
      __testables.websitePromptRowWhere(admin, { countries: ["KR", "US"] }),
    );
    expect(text).toContain("ws.country_code IN (");
    expect(text).not.toContain("ws.brand IN (");
    expect(params).toEqual(["KR", "US"]);
  });
});

describe("websitePromptRowWhere — scope 하드락", () => {
  const kr: AllowedScope = { all: false, brands: ["Kia"], countries: ["KR"] };

  it("스코프 밖 국가를 요청하면 `false` 다 (조건 누락으로 전체가 열리지 않는다)", () => {
    const { text } = compile(__testables.websitePromptRowWhere(kr, { countries: ["US"] }));
    expect(text).toContain("false");
  });

  it("브랜드 가상 코드는 **그 브랜드가 스코프에 있을 때만** 통과한다", () => {
    const nScope: AllowedScope = {
      all: false,
      brands: ["Hyundai N"],
      countries: ["KR", "worldwide"],
    };
    const ok = compile(__testables.websitePromptRowWhere(nScope, { countries: ["HYUNDAI-N"] }));
    expect(ok.params).toContain("Hyundai N");

    // Kia 계정이 같은 URL 을 들고 와도 열리면 안 된다.
    const denied = compile(__testables.websitePromptRowWhere(kr, { countries: ["HYUNDAI-N"] }));
    expect(denied.text).toContain("false");
    expect(denied.params).not.toContain("Hyundai N");
  });

  it("스코프 브랜드는 요청으로 넓힐 수 없다", () => {
    const { params } = compile(
      __testables.websitePromptRowWhere(kr, { brands: ["Genesis", "Kia"] }),
    );
    expect(params).toContain("Kia");
    expect(params).not.toContain("Genesis");
  });
});

describe("websitePromptLens — 측정 렌즈", () => {
  it("엔진·기간은 렌즈에만 들어간다 (행 WHERE 에는 없다)", () => {
    const filters = { engines: ["chatgpt"], dateFrom: "2026-09-01", dateTo: "2026-09-08" };
    const row = compile(__testables.websitePromptRowWhere(admin, filters));
    expect(row.params).toEqual([]);

    const lens = compile(__testables.websitePromptLens(filters));
    expect(lens.text).toContain("a.status = 'completed'");
    expect(lens.text).toContain("a.target IN (");
    expect(lens.params).toEqual(["chatgpt", "2026-09-01", "2026-09-08"]);
  });

  it("검색어의 %/_ 는 이스케이프된다 (와일드카드로 승격되지 않는다)", () => {
    const { params } = compile(
      __testables.websitePromptRowWhere(admin, { search: "100%_off" }),
    );
    // prompt_text·target_url 두 ILIKE 가 같은 패턴을 쓰므로 파라미터는 2개다.
    expect(params).toEqual(["%100\\%\\_off%", "%100\\%\\_off%"]);
  });
});
