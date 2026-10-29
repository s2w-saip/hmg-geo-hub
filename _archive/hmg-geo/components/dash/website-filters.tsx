"use client";

import {
  DimensionFilterPanel,
  FILTER_SECTIONS,
  type CatalogTaxonomyRow,
  type MeasuredScopeCombo,
  type DimensionGroup,
} from "@/components/dash/dimension-filter-panel";
import { MeasurementBasisControl } from "@/components/dash/measurement-basis-control";

// 웹사이트 Overview 필터 — 웹사이트의 성격(권역별 공식 사이트)에 맞춘 축만 노출.
// 1차 축: geography(국가/공식 사이트) → language(국가 내 사이트 언어) → engine.
// country = 자국 사이트, region/hq = 권역 내 국가 종합.
//
// 표준과 달리 웹사이트 프롬프트(xlsx)는 target_url·text·lang 만 담고 HMG 카탈로그
// 분류(listType·depth1~4)나 funnel_stage·brandPresence 태깅이 없다. 따라서 그
// 축들은 값이 비어 무의미하므로 숨기고, 실제 데이터가 있는 축만 남긴다:
//   geography · language · engine (+ admin 전용 brand 통합).
// language 는 다국어 국가(캐나다 en/fr 등, 단일 scope 프로젝트로 통합)를 사이트
// 언어별로 좁히는 웹사이트 전용 축 — 옵션은 listMeasuredLanguages(scope) 실데이터.
//
// 브랜드 통합(종합) 축은 admin 에게만 노출 (사용자 결정 2026-06-30: "브랜드
// 통합은 admin 만"). admin 은 scope.all 이라 readStandardFilters 가 ?brand URL
// 값을 그대로 반영 → 브랜드별 종합 뷰가 동작. 그 외 role 은 scope.brands 가
// 하드락이라 brand 축을 띄워도 무의미하므로 숨긴다.
export function WebsiteFilters({
  scope,
  catalogRows,
  geographyOptions,
  languageOptions,
  optionMatrix,
  isAdmin = false,
  asOfSlot,
}: {
  scope?: import("@/lib/auth/types").AllowedScope;
  catalogRows?: CatalogTaxonomyRow[];
  geographyOptions?: string[];
  languageOptions?: string[];
  // 옵션 의존 매트릭스 — 패널이 draft 로 국가·언어를 좁힌다(2026-09-04).
  optionMatrix?: MeasuredScopeCombo[];
  isAdmin?: boolean;
  // 측정 기준일 슬롯 — 서버 렌더 <Suspense> 노드를 그대로 패널 최상단에 꽂는다.
  asOfSlot?: import("react").ReactNode;
}) {
  const brandAxis: DimensionGroup[] = isAdmin ? ["brand"] : [];
  return (
    <DimensionFilterPanel
      stage="overview"
      basis={<MeasurementBasisControl />}
      asOfSlot={asOfSlot}
      onlyGroups={["geography", "language", ...brandAxis, "engine", "time"]}
      primaryGroups={["geography", "language", ...brandAxis, "engine", "time"]}
      // 웹사이트 프롬프트엔 카탈로그 축(prompt)이 없어 dimension 행만 남는다
      // (빈 행은 패널이 자동으로 숨김).
      sections={FILTER_SECTIONS}
      sticky
      scope={scope}
      catalogRows={catalogRows}
      geographyOptions={geographyOptions}
      languageOptions={languageOptions}
      optionMatrix={optionMatrix}
    />
  );
}
