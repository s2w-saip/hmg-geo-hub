import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { answerWhere, detailAnswerWhere, snapshotRunFilter } from "./scope-aggregates";
import type { StandardFilters } from "@/lib/scope/result-adapter";

// 언어(lang) 축의 표면별 라우팅 고정 (2026-09-03).
//
// 배경: 표준(글로벌) 대시보드가 language 축을 노출하는데 술어는 무조건 website
// 전용(website_prompts.lang_code)이었다. 루트 카탈로그 프롬프트 ↔ website_prompts
// 겹침이 운영 DB 에서 0건이라, 언어를 하나라도 고르면 답변셋이 공집합 → 화면 전체가
// "데이터 없음"이 됐다. 정본:
// (내부 설계 문서) §2-A
//
// 이 파일이 지키는 것 두 가지:
//  ① 표면별 컬럼 라우팅 — standard=scope_prompts.lang / project=website_prompts.lang_code
//  ② **세 술어 빌더가 같은 규칙을 탄다** — answerWhere · detailAnswerWhere ·
//     snapshotRunFilter. 2026-08-25 에는 셋 중 하나(JS 드릴다운 경로)만 축을
//     빠뜨려 현대/인도 필터에 중국어·체코어 프롬프트가 노출된 사고가 났다.

const dialect = new PgDialect();
function compile(w: SQL): { text: string; params: unknown[] } {
  const q = dialect.sqlToQuery(w);
  return { text: q.sql, params: q.params };
}

// 세 빌더를 같은 입력으로 부르는 어댑터 — 표준 표면 / 프로젝트(웹사이트) 표면.
const STANDARD_BUILDERS: Array<[string, (f: StandardFilters) => SQL]> = [
  ["answerWhere", (f) => answerWhere(f, undefined)],
  ["detailAnswerWhere", (f) => detailAnswerWhere(f, undefined)],
  ["snapshotRunFilter", (f) => snapshotRunFilter(undefined, f)],
];

const PROJECT_BUILDERS: Array<[string, (f: StandardFilters) => SQL]> = [
  ["answerWhere", (f) => answerWhere(f, ["p1"])],
  ["detailAnswerWhere", (f) => detailAnswerWhere(f, ["p1"])],
  ["snapshotRunFilter", (f) => snapshotRunFilter(["p1"], f)],
];

describe("lang 축 — 표준(글로벌) 표면은 scope_prompts.lang 으로 판정한다", () => {
  it.each(STANDARD_BUILDERS)("%s: website_prompts 가 아니라 scope_prompts 를 본다", (_n, build) => {
    const { text } = compile(build({ lang: ["ko"] }));
    expect(text).toContain("FROM scope_prompts WHERE lang IS NOT NULL AND upper(lang) IN");
    // 결함의 정체 — 표준 경로가 website 서브쿼리를 타면 답변셋이 공집합이 된다.
    expect(text).not.toContain("website_prompts");
  });

  it.each(STANDARD_BUILDERS)("%s: 소문자 URL 값을 대문자 저장값에 맞춘다", (_n, build) => {
    const { params } = compile(build({ lang: ["ko", "en"] }));
    expect(params).toContain("KO");
    expect(params).toContain("EN");
    expect(params).not.toContain("ko");
  });

  it.each(STANDARD_BUILDERS)("%s: 이미 대문자로 들어와도 대문자 하나로 수렴한다", (_n, build) => {
    const { params } = compile(build({ lang: ["KO"] }));
    expect(params.filter((p) => p === "KO")).toHaveLength(1);
  });

  it.each(STANDARD_BUILDERS)("%s: lang 미선택이면 언어 술어를 만들지 않는다", (_n, build) => {
    const { text } = compile(build({}));
    expect(text).not.toContain("upper(lang)");
    expect(text).not.toContain("website_prompts");
  });
});

describe("lang 축 — 프로젝트/웹사이트 표면은 종전 website_prompts.lang_code 그대로", () => {
  it.each(PROJECT_BUILDERS)("%s: website_prompts.lang_code 세미조인 (판정 불변)", (_n, build) => {
    const { text, params } = compile(build({ lang: ["fr"] }));
    expect(text).toContain("FROM website_prompts WHERE lang_code IN");
    expect(text).not.toContain("upper(lang)");
    // 저장값도 소문자라 값 변환 없음 — 종전 술어와 바이트 동일.
    expect(params).toContain("fr");
    expect(params).not.toContain("FR");
  });

  it.each(PROJECT_BUILDERS)("%s: websiteCountry 는 표면과 무관하게 website_sites 기준", (_n, build) => {
    const { text, params } = compile(build({ websiteCountry: ["IN"] }));
    expect(text).toContain("JOIN website_sites");
    expect(text).toContain("country_code IN");
    expect(params).toContain("IN");
  });
});

describe("lang 축 — 다른 축과의 상호작용", () => {
  it("표준 lang 술어는 카탈로그 semi-join 을 쪼개지 않는다 (planner 안전)", () => {
    const { text } = compile(
      answerWhere({ lang: ["ko"], brand: ["Hyundai"], depth1: ["EV"] }, undefined),
    );
    // 카탈로그 축은 여전히 prompts 서브쿼리 1개로 병합돼 있어야 한다.
    const occurrences = text.split("SELECT scope_prompt_id FROM prompts WHERE").length - 1;
    expect(occurrences).toBe(1);
  });

  it("표준 lang 은 region(geography) 축과 독립적으로 결합된다", () => {
    const { text, params } = compile(answerWhere({ lang: ["ko"], region: ["KR"] }, undefined));
    expect(text).toMatch(/"?a"?\.region IN/i);
    expect(text).toContain("upper(lang) IN");
    expect(params).toContain("KR");
    expect(params).toContain("KO");
  });
});
