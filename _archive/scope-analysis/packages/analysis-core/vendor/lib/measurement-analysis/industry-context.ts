// Industry scope context shared across the measurement-analysis pipeline —
// change complete-project-industry-scoping.
//
// 배경: 분석 산업 스코프는 프로젝트 속성(projects.industry_id)이 정본이고 전역
// env 는 폴백일 뿐인데(0057), LLM 프롬프트·auto-seed 폴백이 Automotive 로
// 하드코딩돼 있어 비자동차 프로젝트가 자동차 온톨로지로 분석되는 오염이
// 반복됐다(2026-07-10 LG 가전, migration 0066 스마트폰 선례). 이 모듈은
// "어떤 산업으로, 어떤 출처로" 스코프됐는지를 한 타입으로 흘려보낸다.

/** Where the analysis industry scope came from — logged with every catalog load. */
export type IndustryScopeSource =
  /** projects.industry_id — the configured, per-project path. */
  | "project"
  /** Global MEASUREMENT_ANALYSIS_INDUSTRY_ID/_NAME env — legacy fallback. */
  | "env"
  /** Legacy tracked-brand heuristic (no project industry, no env). */
  | "tracked_brands"
  /** Nothing matched — catalog runs unscoped. */
  | "none";

export interface IndustryScopeContext {
  /** Scoped Industry entity ids (usually one; tracked-brand heuristic may yield more). */
  ids: string[];
  /** Canonical name of the primary scoped Industry entity, when known. */
  name: string | null;
  source: IndustryScopeSource;
}

export const UNSCOPED_INDUSTRY: IndustryScopeContext = {
  ids: [],
  name: null,
  source: "none",
};

/**
 * Whether an industry name denotes the automotive industry. The automotive
 * prompt variants carry hand-tuned HMG examples that MUST stay byte-identical
 * for regression safety — this predicate is the single gate deciding when they
 * apply. Same pattern auto-seed's brand vetting has used since its inception.
 */
export function isAutomotiveIndustryName(
  name: string | null | undefined,
): boolean {
  return typeof name === "string" && /auto|car|vehicle|자동차/i.test(name);
}
