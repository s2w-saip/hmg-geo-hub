"use client";

import {
  DimensionFilterPanel,
  FILTER_SECTIONS,
  type DimensionGroup,
} from "@/components/dash/dimension-filter-panel";

// 웹사이트 프롬프트 조회 필터.
//
// WebsiteFilters(Overview)와 축 구성은 같지만 두 가지가 다르다:
//   1. MeasurementBasisControl(일/주 집계 단위)이 없다 — 추이 차트용 컨트롤이라
//      목록 화면에는 걸 자리가 없다.
//   2. catalogRows 를 넘기지 않는다 — 웹사이트 프롬프트엔 HMG 카탈로그 분류
//      (listType/depth1~4)가 없어 prompt 섹션 행이 통째로 비고, 빈 행은 패널이
//      자동으로 숨긴다.
//
// 축의 의미가 두 갈래인 점은 화면(lensHint)에서 안내한다:
//   geography·language·brand → 행 필터 (프롬프트 카탈로그의 실제 컬럼)
//   engine·time              → 측정 렌즈 (행이 아니라 측정 컬럼의 계산 범위)
// 이 구분은 listWebsitePromptsScoped 의 주석에 근거가 있다.
//
// 브랜드 축은 admin 에게만 — Overview 와 같은 정책(2026-06-30). 그 외 role 은
// scope.brands 가 하드락이라 축을 띄워도 고를 게 없다.
export function WebsitePromptFilters({
  scope,
  geographyOptions,
  languageOptions,
  isAdmin = false,
}: {
  scope?: import("@/lib/auth/types").AllowedScope;
  geographyOptions?: string[];
  languageOptions?: string[];
  isAdmin?: boolean;
}) {
  const brandAxis: DimensionGroup[] = isAdmin ? ["brand"] : [];
  const groups: DimensionGroup[] = [
    "geography",
    "language",
    ...brandAxis,
    "engine",
    "time",
  ];
  return (
    <DimensionFilterPanel
      stage="overview"
      onlyGroups={groups}
      primaryGroups={groups}
      sections={FILTER_SECTIONS}
      sticky
      scope={scope}
      geographyOptions={geographyOptions}
      languageOptions={languageOptions}
    />
  );
}
