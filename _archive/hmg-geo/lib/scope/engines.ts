// AI 엔진(측정 타깃) 카탈로그 — 프로젝트가 "어느 AI 엔진에서 답변을 수집할지"
// 선택하는 단일 어휘. 값은 scope 의 schedule `targets` 토큰(소문자, scope
// lib/scheduling/schema.ts TargetCode zod enum)과 동일하며, 미러 DB
// scope_answers.target 도 같은 값을 쓴다 — 필터 URL 파라미터(?engine=)와
// 저장값·측정 요청이 전부 한 토큰으로 이어진다(브리징 없음).
//
// 표시 라벨(product name)은 로케일 무관 고유명사라 i18n 키가 아니라 여기 상수다
// (dimension-filter-panel ENGINE_LABEL, result-adapter TARGET_LABEL 과 같은 자세).
// 모델 부표기(GPT-x / Flash / V3)는 **표시하지 않는다**(운영 결정 2026-08-18) —
// 웹 UI lane 은 모델을 고정하지 않고 그 시점 서빙 모델을 재므로 특정 버전 표기가
// 사실과 어긋날 수 있다.
//
// 이 파일은 클라이언트에서도 import 된다(폼 체크박스) — "server-only" 금지,
// 비밀값·env 참조 금지.

export const AI_ENGINE_IDS = ["chatgpt", "gemini", "deepseek"] as const;
export type AiEngineId = (typeof AI_ENGINE_IDS)[number];

export interface AiEngineOption {
  id: AiEngineId;
  label: string; // 제품명 (ChatGPT / Gemini / DeepSeek)
}

export const AI_ENGINES: readonly AiEngineOption[] = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "gemini", label: "Gemini" },
  // deepseek — scope 측 API 레인(OpenRouter+Exa). scope 정책상 SaaS 고객 표면엔
  // 미노출(운영자 옵트인)이지만 공개 API 의 schedule targets 는 받는다. HMG 는
  // 엔터프라이즈 워크스페이스라 프로젝트 단위 선택을 허용한다. 한국어 질의에서
  // 인용 축 오염 실측(scope 2026-08-13)이 있으니 KR 프로젝트는 신중히.
  { id: "deepseek", label: "DeepSeek" },
];

// 엔진을 한 번도 지정하지 않은(레거시, ai_engines IS NULL) 프로젝트가 실제로
// 측정되는 엔진 = scope planner 의 DEFAULT_TARGETS(chatgpt·gemini). 설정 화면은
// NULL 을 이 값으로 표시하고, 저장하는 순간 명시값이 된다.
export const DEFAULT_AI_ENGINES: readonly AiEngineId[] = ["chatgpt", "gemini"];

export function isAiEngineId(value: string): value is AiEngineId {
  return (AI_ENGINE_IDS as readonly string[]).includes(value);
}

// 입력(폼·URL)에서 온 문자열 배열을 카탈로그 순서로 정규화한다 — 중복·미지값
// 제거, 순서 고정(비교·이력 표시가 순서에 흔들리지 않게).
export function normalizeAiEngines(values: readonly string[] | null | undefined): AiEngineId[] {
  const set = new Set((values ?? []).filter(isAiEngineId));
  return AI_ENGINE_IDS.filter((id) => set.has(id));
}

// 저장값(NULL 허용) → 화면·스케줄에 쓰는 유효 엔진 목록.
export function effectiveAiEngines(stored: readonly string[] | null | undefined): AiEngineId[] {
  if (stored == null) return [...DEFAULT_AI_ENGINES];
  return normalizeAiEngines(stored);
}

export function aiEngineLabel(id: string): string {
  return AI_ENGINES.find((e) => e.id === id)?.label ?? id;
}

export function sameAiEngines(a: readonly string[], b: readonly string[]): boolean {
  const na = normalizeAiEngines(a);
  const nb = normalizeAiEngines(b);
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}
