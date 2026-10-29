import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";

// 답변분석(언급 / 인용) 필터 축 구성의 정본.
//
// 원래 각 뷰(mentions-view / citations-view) 안에 상수로 있었는데, 2026-08-27
// 스트리밍 분할에서 필터바를 뷰 밖으로 꺼내면서 **뷰와 바가 같은 축 구성을
// 봐야** 한다(프로젝트 화면은 여전히 뷰 안쪽 바를 쓴다). 두 벌로 두면 조용히
// 드리프트하므로 한 곳에 둔다.
// language (2026-09-03): 표준 답변 분석에도 언어 축을 노출한다(운영 결정). 술어는
// 대시보드와 **공통**이라 새로 만들 것이 없다 — 언급·인용·SubKPI·드릴다운이 전부
// promptAxisPreds(standard) = scope_prompts.lang 을 타는 세 빌더(answerWhere ·
// detailAnswerWhere · snapshotRunFilter) 위에 있다. 자리는 geography 바로 뒤로
// 통일(대시보드 FILTER_SECTIONS·ACR 과 같은 순서).
export const STANDARD_MENTION_ONLY_GROUPS: DimensionGroup[] = [
  "geography",
  "language",
  "engine",
  "time",
  "promptContext",
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
];

export const STANDARD_MENTION_PRIMARY: DimensionGroup[] = [
  "geography",
  "language",
  "engine",
  "time",
  "promptContext",
];

// 2026-09-02 피그마 2행(운영 결정): 글로벌 인용 화면의 출처 카테고리는 필터바 축이 아니라
// 상단 카테고리 칩(citation-category-chips, 같은 `?source=` 계약)이 담당한다 — 축을 빼면
// "답변 필터" 행이 비어 자동으로 사라진다. website/project 인용은 CitationsView 내부 상수.
export const STANDARD_CITATION_ONLY_GROUPS: DimensionGroup[] = [
  "geography",
  "language",
  "engine",
  "time",
  "promptContext",
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
];

/**
 * 표준(글로벌) 인용 화면 전용 축 — 위 공유 기본 목록에 `source`(출처 카테고리)와
 * `competitor`(경쟁사)를 더한 것.
 *
 * 2026-09-10 QA 2차 #2·#5(고객 요청): 2026-09-02 에 두 축을 필터바 밖 칩·드롭다운으로
 * 내린 결정을 되돌린다. 칩은 클릭 즉시 `router.replace` 라 서버 왕복이 끝나야 선택이
 * 보였고(= "도메인 카테고리 선택이 안 된다"), 공유 전이 밖이라 그 사이 피드백도 없었다.
 *
 * **기본 목록(STANDARD_CITATION_ONLY_GROUPS)에 넣지 않는 이유**: website/project 인용
 * 화면(CitationsView)이 같은 기본값을 공유한다 — 거기 축을 추가하면 요청 범위 밖 화면이
 * 바뀐다. 표준 인용 페이지만 이 목록을 명시적으로 넘긴다.
 */
export const STANDARD_CITATION_V2_ONLY_GROUPS: DimensionGroup[] = [
  ...STANDARD_CITATION_ONLY_GROUPS,
  "source",
  "competitor",
];

export const STANDARD_CITATION_PRIMARY: DimensionGroup[] = [
  "geography",
  "language",
  "engine",
  "time",
  "promptContext",
];

/**
 * 뷰와 필터바가 공유하는 축 조립 규칙. extraGroups(웹사이트 admin 의 brand 통합
 * 축)는 onlyGroups 끝에, primaryGroups 는 첫 축(geography) 바로 뒤에 끼운다 —
 * 기존 뷰 내부 로직과 동일한 자리다.
 *
 * `languageOptions` (2026-09-03): 그 화면이 실제로 측정한 언어. **비어 있으면
 * language 축을 only·primary 양쪽에서 뺀다.** 옵션 없이 축을 띄우면 패널이 정적
 * 폴백(DIMENSIONS.language = en/ko/fr, 스코프 무관)을 그리는데, 그것이 KR 계정에
 * 프랑스어가 뜬 원인이었다. 이 한 곳에서 걸러 모든 소비처(표준 필터바 · 웹사이트
 * 필터바 · 프로젝트 뷰 내부 패널)가 같은 보호를 받는다 — 옵션을 안 넘기는 표면이
 * 새 축을 조용히 노출하는 일이 없다.
 */
export function composeGroups(
  stage: "mentions" | "citations",
  {
    onlyGroups,
    primaryGroups,
    extraGroups = [],
    languageOptions,
  }: {
    onlyGroups?: DimensionGroup[];
    primaryGroups?: DimensionGroup[];
    extraGroups?: DimensionGroup[];
    languageOptions?: string[];
  },
): { only: DimensionGroup[]; primary: DimensionGroup[] } {
  const defaultOnly =
    stage === "mentions" ? STANDARD_MENTION_ONLY_GROUPS : STANDARD_CITATION_ONLY_GROUPS;
  const defaultPrimary =
    stage === "mentions" ? STANDARD_MENTION_PRIMARY : STANDARD_CITATION_PRIMARY;
  const dropLang = !languageOptions?.length;
  const keep = (gs: DimensionGroup[]) =>
    dropLang ? gs.filter((g) => g !== "language") : gs;
  const only = keep([...(onlyGroups ?? defaultOnly), ...extraGroups]);
  const primary = keep(
    primaryGroups
      ? [...primaryGroups, ...extraGroups]
      : [defaultPrimary[0], ...extraGroups, ...defaultPrimary.slice(1)],
  );
  return { only, primary };
}
