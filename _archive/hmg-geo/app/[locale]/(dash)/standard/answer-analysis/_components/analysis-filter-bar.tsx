import { Suspense, type ReactNode } from "react";
import {
  DimensionFilterPanel,
  FILTER_SECTIONS,
  type CatalogTaxonomyRow,
  type DimensionGroup,
  type MeasuredScopeCombo,
} from "@/components/dash/dimension-filter-panel";
import { AsOfChip, AsOfChipSkeleton } from "@/components/dash/as-of-chip";
import type { AllowedScope } from "@/lib/auth/types";
import { composeGroups } from "./filter-groups";

// 답변분석(언급 / 인용) 화면의 필터바 — **본문과 분리된 <Suspense> 경계**에서
// 그린다.
//
// 배경: 이 화면들은 무거운 집계 read 하나(fetchStandardMentions 등)가 필터바까지
// 붙잡고 있었다. 필터를 바꿔 캐시 미스가 나면 화면 전체가 스켈레톤이 되고, 정작
// 사용자가 만지려는 필터바조차 사라졌다. 필터바에 필요한 것은 값싼 옵션 read
// (카탈로그 택소노미 / 측정 국가 / 언어)뿐이므로 먼저 그린다.
//
// 두 모드:
//   · 글로벌(standard) 화면 — `asOf` 를 넘기지 않는다. 2026-09-02 피그마 2행 정합(운영
//     결정)으로 측정 기준일은 측정 개요 카드(MeasurementOverviewCard) 첫 행으로 갔고,
//     패널의 기준일·측정 기준·권한 행은 `compact` 로 끈다.
//   · 웹사이트(website) 화면 — 피그마 범위 밖이라 종전 그대로. `asOf` 프로미스를 넘기면
//     기준일 배지를 중첩 <Suspense> 슬롯으로 흘려보낸다(값이 늦어도 행 높이 유지). 그
//     read 는 본문과 동일해 요청단위 dedup 으로 접히므로 DB 왕복이 늘지 않는다.
export function AnalysisFilterBar({
  stage,
  scope,
  catalogRows,
  geographyOptions,
  languageOptions,
  optionMatrix,
  competitorOptions,
  collectionStartDay,
  footerSlot,
  extraGroups,
  onlyGroups,
  primaryGroups,
  asOf,
  sticky = true,
}: {
  stage: "mentions" | "citations";
  scope?: AllowedScope;
  catalogRows?: CatalogTaxonomyRow[];
  geographyOptions?: string[];
  languageOptions?: string[];
  // 옵션 의존 매트릭스 — 패널이 draft 로 국가·언어를 좁힌다(2026-09-04).
  optionMatrix?: MeasuredScopeCombo[];
  /**
   * 경쟁사 축 옵션(인용 도메인). 값이 무거운 인용 집계에서 오므로 **프로미스로 넘긴다** —
   * 패널이 그 facet 하나만 <Suspense> 로 감싸므로 필터바는 집계를 기다리지 않는다
   * (이 파일 헤더의 설계 의도: 필터바는 값싼 옵션 read 만 소유한다).
   */
  competitorOptions?: string[] | Promise<string[]>;
  /** 데이터 수집 시작일(YYYY-MM-DD) — 기간 축 캘린더의 min·프리셋 클램프(QA #19·#20). */
  collectionStartDay?: string | null;
  /**
   * 필터 박스 **안쪽** 추가 행. 2026-09-10 QA 2차 #2 로 인용 화면의 칩이 필터 패널 축
   * (출처 카테고리·경쟁사)으로 흡수되면서 현재 소비처는 없다 — 패널의 슬롯 계약은
   * 남겨 둔다(안내 문구 `defaultScopeHint` 는 이 슬롯보다 **아래**가 정본이다).
   */
  footerSlot?: ReactNode;
  extraGroups?: DimensionGroup[];
  onlyGroups?: DimensionGroup[];
  primaryGroups?: DimensionGroup[];
  /** 측정 기준일 프로미스 — 웹사이트 화면 전용(글로벌 화면은 카드로 이동). */
  asOf?: Promise<string | null>;
  /**
   * 패널 자체를 sticky 로 둘지. 글로벌(standard) 화면은 필터 박스가 측정 개요 카드와
   * **한 grid 행**(QA 2차 #10)이라 패널의 sticky 이동거리가 0 이다 — 그 화면들은
   * false 를 주고 **행 래퍼**가 sticky 를 소유한다(dimension-filter-panel 의 sticky 주석).
   */
  sticky?: boolean;
}) {
  const groups = composeGroups(stage, { onlyGroups, primaryGroups, extraGroups, languageOptions });
  return (
    <DimensionFilterPanel
      stage={stage}
      scope={scope}
      catalogRows={catalogRows}
      geographyOptions={geographyOptions}
      languageOptions={languageOptions}
      optionMatrix={optionMatrix}
      competitorOptions={competitorOptions}
      collectionStartDay={collectionStartDay}
      onlyGroups={groups.only}
      primaryGroups={groups.primary}
      sections={FILTER_SECTIONS}
      sticky={sticky}
      compact={asOf == null}
      footerSlot={footerSlot}
      asOfSlot={
        asOf ? (
          <Suspense fallback={<AsOfChipSkeleton />}>
            <AsOfSlot asOf={asOf} />
          </Suspense>
        ) : undefined
      }
    />
  );
}

// 프로미스를 여기서만 await 한다 — 이 컴포넌트만 서스펜드하고 필터바는 이미 떠 있다.
async function AsOfSlot({ asOf }: { asOf: Promise<string | null> }): Promise<ReactNode> {
  const date = await asOf;
  // 측정이 없으면 배지 없이 빈 행(높이 유지) — 필터바가 통째로 리플로우되는 것보다 낫다.
  return date ? <AsOfChip date={date} /> : null;
}
