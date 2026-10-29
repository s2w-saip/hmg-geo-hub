import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { acrWhere } from "./scope-aggregates";

// ACR 언어 축 (2026-09-03).
//
// ACR 화면은 scope_acr_rollups 를 읽는 **독립 술어 빌더**(acrWhere)를 쓴다 —
// promptAxisPreds 를 타지 않는다. 그래서 language 축을 이 화면에 노출하기 전에
// 술어부터 넣었다. 순서가 반대였다면 "축은 켜졌는데 데이터가 안 좁혀지는" 죽은
// 필터가 됐고, 그것이 2026-08-25 사고의 형태다.
//
// 판정 규칙은 표준 표면과 **같아야** 한다 — scope_prompts.lang, upper() 비교,
// 소문자 입력. 여기가 갈라지면 같은 URL 이 화면마다 다른 모집단을 낸다.

const dialect = new PgDialect();
function compile(w: SQL): { text: string; params: unknown[] } {
  const q = dialect.sqlToQuery(w);
  return { text: q.sql, params: q.params };
}

describe("acrWhere — 언어 축", () => {
  it("scope_prompts.lang 으로 판정한다 (표준 표면과 같은 규칙)", () => {
    const { text } = compile(acrWhere({ lang: ["ko"] }));
    expect(text).toContain("FROM scope_prompts WHERE lang IS NOT NULL AND upper(lang) IN");
  });

  it("website 술어로 새지 않는다 (ACR 프롬프트는 website_prompts 밖)", () => {
    const { text } = compile(acrWhere({ lang: ["ko"] }));
    expect(text).not.toContain("website_prompts");
  });

  it("소문자 입력을 대문자 저장값에 맞춘다", () => {
    const { params } = compile(acrWhere({ lang: ["ko", "en"] }));
    expect(params).toContain("KO");
    expect(params).toContain("EN");
  });

  it("rollup 컬럼(x.prompt_id)에 건다 — 별칭이 어긋나면 SQL 이 깨진다", () => {
    const { text } = compile(acrWhere({ lang: ["ko"] }));
    expect(text).toMatch(/"?x"?\.prompt_id IN \(SELECT prompt_id FROM scope_prompts/i);
  });

  it("lang 미선택이면 언어 술어를 만들지 않는다 (회귀 0)", () => {
    const { text } = compile(acrWhere({}));
    expect(text).not.toContain("upper(lang)");
    expect(text).not.toContain("scope_prompts");
  });

  it("다른 축과 독립적으로 AND 결합된다", () => {
    const { text, params } = compile(acrWhere({ lang: ["ko"], region: ["KR"], engine: ["chatgpt"] }));
    expect(text).toMatch(/"?x"?\.region IN/i);
    expect(text).toMatch(/"?x"?\.target IN/i);
    expect(text).toContain("upper(lang) IN");
    expect(params).toContain("KR");
    expect(params).toContain("chatgpt");
    expect(params).toContain("KO");
  });
});
