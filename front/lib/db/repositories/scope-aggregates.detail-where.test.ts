import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { detailAnswerWhere } from "./scope-aggregates";
import { STANDARD_ROOT_PROJECT_ID } from "./standards";

// 인용 상세 SQL 필터(detailAnswerWhere)의 머지 후 시맨틱 고정 —
// origin/main 의 표준 시맨틱 변화가 SQL 경로에도 그대로 걸리는지 문자열 수준에서
// 검증한다: ① 705 카탈로그 게이트(00fa333)는 표준(루트) 경로에만, ② brandPresence
// 는 prompts.brand_presence 정본 우선 + brand 태그 폴백(99db456, 상세 경로의
// "둘 다 선택 → presence 미상 제외" 규칙 포함), ③ 권역 격리(bd188bf 계열)가
// 주입하는 filters.region 이 a.region IN 으로 강제되는지.

const dialect = new PgDialect();
function compile(w: SQL): { text: string; params: unknown[] } {
  const q = dialect.sqlToQuery(w);
  return { text: q.sql, params: q.params };
}

describe("detailAnswerWhere — 표준 시맨틱 (merge 이후)", () => {
  it("표준(루트) 경로는 705 카탈로그 게이트를 prompts semi-join에 접는다", () => {
    const { text, params } = compile(detailAnswerWhere({}, undefined));
    expect(text).toContain("project_id =");
    expect(params).toContain(STANDARD_ROOT_PROJECT_ID);
    expect(text).toContain("scope_prompt_id IS NOT NULL");
  });

  it("프로젝트/웹사이트 경로에는 705 게이트가 없다", () => {
    const { params } = compile(detailAnswerWhere({}, ["proj-1", "proj-2"]));
    expect(params).not.toContain(STANDARD_ROOT_PROJECT_ID);
  });

  it("region 필터(스코프 격리 주입값)는 a.region IN 으로 강제된다", () => {
    const { text, params } = compile(detailAnswerWhere({ region: ["DE", "KR"] }, "p1"));
    expect(text).toMatch(/"?a"?\.region IN/i);
    expect(params).toContain("DE");
    expect(params).toContain("KR");
  });

  it("brandPresence 단일 선택은 brand_presence 정본 우선 + 태그 폴백 술어", () => {
    const { text, params } = compile(
      detailAnswerWhere({ brandPresence: ["unbranded"] }, "p1"),
    );
    expect(text).toContain("COALESCE(brand_presence");
    expect(params).toContain("unbranded");
  });

  it("brandPresence 둘 다 선택 시 presence 미상(null) 프롬프트는 제외 (상세 경로 규칙)", () => {
    const { text } = compile(
      detailAnswerWhere({ brandPresence: ["branded", "unbranded"] }, "p1"),
    );
    expect(text).toMatch(/COALESCE\(brand_presence[\s\S]*IS NOT NULL/);
  });

  it("카탈로그 축들은 하나의 prompts semi-join으로 병합된다 (planner 안전)", () => {
    const { text } = compile(
      detailAnswerWhere(
        { brand: ["Kia"], listType: ["Brand Message"], depth1: ["EV"] },
        undefined,
      ),
    );
    // 표준 게이트 + brand + list_type + depth1 이 전부 한 서브쿼리 안에 —
    // "SELECT scope_prompt_id FROM prompts WHERE" 가 정확히 1회만 등장.
    const occurrences = text.split("SELECT scope_prompt_id FROM prompts WHERE").length - 1;
    expect(occurrences).toBe(1);
  });

  // 2026-09-04: 종전에는 scope_prompts.funnel_stage(레거시 영문 5단계)만 봤다.
  // 필터 옵션은 HMG 3단계 한글 정본이라 어떤 값도 매칭되지 않아 퍼널을 걸면
  // 화면이 통째로 비었다. 카탈로그 우선(COALESCE) 으로 통일 — 이 테스트가
  // 옛 동작(빈 결과)을 고정하고 있었다.
  it("funnelStage 는 카탈로그 prompts.funnel_stage 우선 + scope 폴백", () => {
    const { text, params } = compile(detailAnswerWhere({ funnelStage: ["인지/탐색"] }, "p1"));
    expect(text).toContain("COALESCE(pc.funnel_stage, sp.funnel_stage) IN");
    expect(text).toContain("LEFT JOIN prompts pc ON pc.scope_prompt_id = sp.prompt_id");
    expect(text).not.toContain("FROM scope_prompts WHERE funnel_stage IN");
    expect(params).toContain("인지/탐색");
  });

  // 2026-08-06 고객 피드백: 프로젝트 Citation Tag Filter 미작동 — 상세 경로에
  // customFieldFilters 술어가 없어 조용히 무시됐다. answerWhere 와 동일 의미
  // (같은 태그 안 OR/IN, 태그 간 AND = fieldId 별 별도 조건) 적용을 고정한다.
  it("프로젝트 커스텀 태그는 prompt_custom_field_values 세미조인으로 적용된다", () => {
    const { text, params } = compile(
      detailAnswerWhere(
        {
          customFieldFilters: {
            "11111111-1111-1111-1111-111111111111": ["출시", "가격"],
            "22222222-2222-2222-2222-222222222222": ["EV"],
          },
        },
        "p1",
      ),
    );
    const joins = text.split("JOIN prompt_custom_field_values").length - 1;
    expect(joins).toBe(2); // 태그 간 AND = fieldId 별 별도 세미조인
    expect(params).toContain("출시");
    expect(params).toContain("가격");
    expect(params).toContain("EV");
  });

  // 2026-08-25 고객 검수: 웹사이트 언급 드릴다운(현대·인도)에 중국어·체코어 등
  // 다른 사이트 프롬프트가 노출 — 상세 경로가 website 전용 축을 무시했다.
  // 페이지 집계(answerWhere)와 같은 모집단이 되도록 두 축을 고정한다.
  it("website 국가 축은 website_sites.country_code 세미조인으로 적용된다", () => {
    const { text, params } = compile(
      detailAnswerWhere({ websiteCountry: ["IN"] }, ["p1"]),
    );
    expect(text).toContain("JOIN website_sites");
    expect(text).toContain("country_code IN");
    expect(params).toContain("IN");
  });

  it("website 언어 축은 website_prompts.lang_code 세미조인으로 적용된다", () => {
    const { text, params } = compile(detailAnswerWhere({ lang: ["en"] }, ["p1"]));
    expect(text).toContain("FROM website_prompts WHERE lang_code IN");
    expect(params).toContain("en");
  });

  it("website 축 미선택이면 술어를 만들지 않는다 (표준 경로 무영향)", () => {
    const { text } = compile(detailAnswerWhere({}, undefined));
    expect(text).not.toContain("website_prompts");
    expect(text).not.toContain("website_sites");
  });

  it("빈 값 태그는 술어를 만들지 않는다", () => {
    const { text } = compile(
      detailAnswerWhere({ customFieldFilters: { "11111111-1111-1111-1111-111111111111": [] } }, "p1"),
    );
    expect(text).not.toContain("prompt_custom_field_values");
  });

  // 2026-08-25 GGMD 버그: website 드릴다운 API 가 region→websiteCountry 로
  // 치환해 넘기는데 상세 경로가 이 축을 무시해 지오 필터가 통째로 사라졌다.
  // answerWhere 와 동일한 website_prompts→website_sites.country_code 세미조인을
  // 고정한다.
  it("websiteCountry 필터는 website_sites.country_code 세미조인으로 적용된다", () => {
    const { text, params } = compile(
      detailAnswerWhere({ websiteCountry: ["IN", "DE"] }, ["p1", "p2"]),
    );
    expect(text).toContain("website_prompts");
    expect(text).toContain("website_sites");
    expect(text).toMatch(/country_code IN/);
    expect(params).toContain("IN");
    expect(params).toContain("DE");
  });

  it("websiteCountry 미지정이면 website 세미조인이 없다", () => {
    const { text } = compile(detailAnswerWhere({}, ["p1"]));
    expect(text).not.toContain("website_sites");
  });
});
