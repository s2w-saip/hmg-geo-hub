import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { answerWhere, catalogPromptCountWhere, detailAnswerWhere } from "./scope-aggregates";
import { STANDARD_ROOT_PROJECT_ID } from "./standards";

// 측정 개요 카드의 "적용 프롬프트" 카운트 술어 —
// 회귀 고정 (2026-09-01 적대적 검증 F2).
//
// 카드의 두 수: "적용" = catalogPromptCountWhere, "측정" = aggregateSubKpisFromMirror
// → answerWhere. 둘이 같은 카탈로그 컬럼을 봐야 뺄셈이 성립한다(재검증 C6 —
// 종전 주석이 상대를 detailAnswerWhere 로 잘못 지목했다).
//
// 결함이었던 것: 카운트가 "측정" 경로와 **다른 필터를 봤다**.
//   ① funnelStage(=promptContext, 필터 바의 프롬프트 행)가 카운트에만 없어서,
//      퍼널을 고르면 "적용"은 그대로인데 "측정"만 줄어 미측정이 부풀려졌다.
//   ② deleted_at 이 카운트에만 있어 소프트삭제만큼 모집단이 어긋났다.

const dialect = new PgDialect();
function compile(w: SQL): { text: string; params: unknown[] } {
  const q = dialect.sqlToQuery(w);
  return { text: q.sql, params: q.params };
}

describe("catalogPromptCountWhere", () => {
  it("applies the funnel (promptContext) axis — the prompt-row filter", () => {
    const { text, params } = compile(
      catalogPromptCountWhere({ funnelStage: ["비교/검증"] }, undefined),
    );
    expect(text).toContain("funnel_stage IN");
    expect(params).toContain("비교/검증");
  });

  // C6: "측정" 칸의 실제 상대는 answerWhere 이고, 그쪽도 **카탈로그**
  // prompts.funnel_stage 를 본다(2026-06-10 D6 — HMG 3단계 한국어 어휘가 정본).
  // 두 술어가 같은 컬럼·같은 값을 쓰는지 여기서 대조한다.
  it("reads the funnel from the same catalog column as the measured-side predicate", () => {
    const count = compile(catalogPromptCountWhere({ funnelStage: ["비교/검증"] }, undefined));
    const measured = compile(answerWhere({ funnelStage: ["비교/검증"] }, undefined));
    expect(count.text).toContain("funnel_stage IN");
    expect(measured.text).toContain("funnel_stage IN");
    // 미러(scope_prompts) 쪽 퍼널로 새지 않는다.
    expect(count.text).not.toContain("scope_prompts");
    expect(measured.params).toContain("비교/검증");
    expect(count.params).toContain("비교/검증");
  });

  it("does NOT filter deleted_at — detailAnswerWhere does not either", () => {
    const { text } = compile(catalogPromptCountWhere({}, undefined));
    expect(text).not.toContain("deleted_at");
    expect(compile(detailAnswerWhere({}, undefined)).text).not.toContain("deleted_at");
  });

  it("keeps the same catalog axes as the detail path", () => {
    const filters = {
      brand: ["Kia"],
      listType: ["Brand Message"],
      depth1: ["EV"],
      depth2: ["EV,Hybrid Brand Awareness"],
      depth3: ["x"],
      brandPresence: ["unbranded"],
    };
    const count = compile(catalogPromptCountWhere(filters, undefined));
    const detail = compile(detailAnswerWhere(filters, undefined));
    for (const value of ["Kia", "Brand Message", "EV", "EV,Hybrid Brand Awareness", "x", "unbranded"]) {
      expect(count.params).toContain(value);
      expect(detail.params).toContain(value);
    }
    expect(count.text).toContain("COALESCE(brand_presence");
  });

  it("keeps the 705 root catalog gate and the linkage requirement", () => {
    const { text, params } = compile(catalogPromptCountWhere({}, undefined));
    expect(params).toContain(STANDARD_ROOT_PROJECT_ID);
    expect(text).toContain("scope_prompt_id IS NOT NULL");
  });

  // 답변 축은 계속 무시한다 — 카탈로그 행 존재 여부를 바꾸지 않기 때문이다.
  // 대신 화면이 뺄셈을 멈춘다(hasAnswerOnlyAxes / promptCoverage).
  it("ignores answer-only axes (region / engine / date)", () => {
    const { text, params } = compile(
      catalogPromptCountWhere(
        { region: ["KR"], engine: ["chatgpt"], dateFrom: "2026-07-01", dateTo: "2026-08-01" },
        undefined,
      ),
    );
    expect(text).not.toContain("region");
    expect(text).not.toContain("target");
    expect(text).not.toContain("measured_at");
    expect(params).not.toContain("KR");
    expect(params).not.toContain("chatgpt");
  });
});
