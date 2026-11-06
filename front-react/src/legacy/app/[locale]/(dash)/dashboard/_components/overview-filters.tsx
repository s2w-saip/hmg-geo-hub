"use client";

import type { ReactNode } from "react";

import {
  DimensionFilterPanel,
  FILTER_SECTIONS,
  type CatalogTaxonomyRow,
  type MeasuredScopeCombo,
  type DimensionGroup,
} from "@/components/dash/dimension-filter-panel";

import { MeasurementBasisControl } from "@/components/dash/measurement-basis-control";

// Overview 필터 — scope가 실제로 거를 수 있는 차원만 노출.
// brand는 필터 축에서 제거 (2026-06-10): 사용자의 권한이라 AccountScopeChips로만
// 노출하고 SQL 필터는 session에서 자동 주입. Product/Source/Competitor 는
// scope 소스가 없어 숨김 — 작동하지 않는 필터를 띄우지 않기 위함.
// time (2026-07-02): measured_at 기간 필터 — 프리셋(주간/월간/연간) + from/to.
// catalogRows (2026-06-11): cascading filter — depth1 ← listType, depth2 ←
// depth1, depth3 ← depth2, depth4 ← depth3. 서버가 prompts 카탈로그에서
// DISTINCT taxonomy를 끌어와 전달.

/**
 * 글로벌 대시보드 디멘션 축의 정본 (2026-09-04 고객 검수).
 *
 * 기대값(권한별 노출):
 *   HQ      → 권역 · 국가 · 언어 · AI 엔진 · 기간
 *   권역담당 → 국가 · 언어 · AI 엔진 · 기간      (권역은 스코프가 고정 → 자동 숨김)
 *   국가담당 → 언어 · AI 엔진 · 기간             (국가도 스코프가 고정 → 자동 숨김)
 * 권역/국가의 숨김은 패널이 scope 에서 파생한다(DimensionFilterPanel lockSet) —
 * 여기서는 "축의 우주"만 정한다. admin(scope.all)은 브랜드가 추가로 붙는다.
 *
 * 종전에는 이 목록 없이 패널 기본 ALL_GROUPS 가 그대로 떠서 **기획에 없는 축이
 * 노출**됐다 — 경쟁사(scope 소스 없음) · 디바이스/신규·재방문(GA4 전환 화면 전용)
 * · 출처 카테고리(인용 화면 전용). 프롬프트 필터 행(promptContext/brandPresence/
 * listType/depth)은 종전대로 유지한다.
 */
const OVERVIEW_DIMENSION_GROUPS: DimensionGroup[] = [
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
 * 대시보드가 패널에 넘길 `onlyGroups`. 실측 언어가 없으면 language 축을 뺀다 —
 * 값 없는 드롭다운은 죽은 필터다(2026-09-03).
 * exported for tests.
 */
export function overviewOnlyGroups(languageOptions?: string[]): DimensionGroup[] {
  return languageOptions?.length
    ? OVERVIEW_DIMENSION_GROUPS
    : OVERVIEW_DIMENSION_GROUPS.filter((g) => g !== "language");
}

export function OverviewFilters({
  scope,
  catalogRows,
  geographyOptions,
  languageOptions,
  optionMatrix,
  collectionStartDay,
  latestAnchorDay,
  selectableDates,
  asOfSlot,
  onlyGroups,
}: {
  scope?: import("@/lib/auth/types").AllowedScope;
  catalogRows?: CatalogTaxonomyRow[];
  geographyOptions?: string[];
  // 2026-09-03 — 스코프·국가로 좁힌 실측 언어(소문자 BCP-47,
  // scope-aggregates::listMeasuredStandardLanguages). 종전에는 아무것도 안 넘겨
  // 패널이 정적 폴백 en/ko/fr 를 그렸고, 그건 스코프와 무관해 KR 계정에 프랑스어가
  // 떴다(고객 제보). 빈 배열이면 축 자체를 숨긴다 — 값 없는 드롭다운은 죽은 필터다.
  languageOptions?: string[];
  // 옵션 의존 매트릭스 — 패널이 draft 로 국가·언어를 좁힌다(2026-09-04).
  optionMatrix?: MeasuredScopeCombo[];
  // 데이터 수집 시작일(YYYY-MM-DD) — 기간 축 캘린더의 min·프리셋 클램프(QA #19·#20).
  collectionStartDay?: string | null;
  /**
   * 기간 프리셋의 **끝점** `E` = 최신 노출 회차 앵커일(YYYY-MM-DD). 없으면 오늘 =
   * 종전 동작 (GGMD-107 C2, 스펙 `period-comparison-delta`).
   */
  latestAnchorDay?: string | null;
  /**
   * 앵커 축(0077) 옵트인 — 회차가 있는 KST 날짜 목록. `undefined`(축 off·미적용)면
   * 달력은 종전대로 전 날짜를 연다(스펙 §5.1).
   */
  selectableDates?: string[];
  // 측정 기준일 슬롯 — 서버에서 렌더된 <Suspense> 노드를 그대로 받아 패널 최상단에
  // 꽂는다(답변분석 AnalysisFilterBar 와 동일 패턴). 값이 늦게 와도 행 높이 유지.
  asOfSlot?: ReactNode;
  /** The panel's axes as the overview screen computed them (overview/filters). Without it (other
   *  callers) the axes follow overviewOnlyGroups(languageOptions). */
  onlyGroups?: DimensionGroup[];
}) {
  return (
    <DimensionFilterPanel
      stage="overview"
      basis={<MeasurementBasisControl />}
      asOfSlot={asOfSlot}
      // 2026-07-08 (피드백): geography 축을 노출하되 권역만 렌더(geographyRegionOnly)
      // 했다 — HQ는 40~80개 국가가 아니라 권역 단위로 거른다는 이유였다.
      // 2026-09-01 (제품 결정): 대시보드에서도 국가를 직접 고를 수 있어야 한다 →
      // 권역 전용 모드를 걷어내 답변분석(언급/인용)과 동일한 구성으로 통일한다.
      // 패널은 권역 필터 + 국가 드롭다운을 함께 그리고(권역 ≥2개일 때), 권역 토글은
      // 그 권역의 측정 국가를 일괄 선택하므로 기존 권역 단위 사용법도 그대로 남는다.
      sections={FILTER_SECTIONS}
      sticky
      // 2026-09-02 피그마 2행(제품 결정): 기준일·측정 기준·권한 행 제거 — 기준일은 헤더 칩.
      compact
      scope={scope}
      catalogRows={catalogRows}
      geographyOptions={geographyOptions}
      languageOptions={languageOptions}
      optionMatrix={optionMatrix}
      collectionStartDay={collectionStartDay}
      latestAnchorDay={latestAnchorDay}
      selectableDates={selectableDates}
      onlyGroups={onlyGroups ?? overviewOnlyGroups(languageOptions)}
    />
  );
}
