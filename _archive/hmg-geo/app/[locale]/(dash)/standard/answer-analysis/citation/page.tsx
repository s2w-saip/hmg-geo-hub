import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import {
  fetchStandardAppliedPromptCount,
  fetchStandardCitationToneSummary,
  fetchStandardCitationTypeCategories,
  fetchStandardCitations,
  fetchStandardKpiHeroSubKpisPrev,
  wasDegraded,
  fetchStandardSubKpis,
  fetchStandardCitationCategoriesPrev,
} from "@/lib/scope/server";
import { getSession } from "@/lib/auth/session";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import {
  listMeasuredRegions,
  listMeasuredStandardLanguages,
  listMeasuredScopeMatrix,
  standardCollectionDates,
} from "@/lib/db/repositories/scope-aggregates";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import type { AllowedScope } from "@/lib/auth/types";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { AnalysisFilterBar } from "../_components/analysis-filter-bar";
import { STANDARD_CITATION_V2_ONLY_GROUPS } from "../_components/filter-groups";
import { UnmeasuredPromptsButton } from "../_components/unmeasured-prompts-dialog";
import {
  MeasurementOverviewCard,
  MeasurementOverviewCardSkeleton,
} from "../_components/measurement-overview-card";
import { CitationsStandardView } from "../_components/citations-standard-view";
import { hasAnswerOnlyAxes } from "../_data/kpi-view";
import { AnswerAnalysisBodySkeleton, FilterBarSkeleton } from "@/components/dash/section-skeleton";
import {
  LastMeasuredPill,
  LastMeasuredPillSkeleton,
} from "@/components/dash/last-measured-pill";
import { competitorDomainOptions } from "../_data/citation-view";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";

// 인용 집계 + 부속 집계(유형별 구성·우호도 요약)가 플랫폼 기본 함수 시간제한을 넘길 수
// 있다 — mention/page.tsx 와 같은 이유로 여유를 확보한다.
export const maxDuration = 120;

// 표준 > 답변 분석 > 인용 — 개편 화면(PR ④, 디자인 571:380). website/project 인용
// 페이지는 종전 CitationsView 를 그대로 쓴다.
export default async function StandardAnswerAnalysisCitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("answerAnalysis");
  const session = await getSession();
  // 2026-09-04 기획 수정 — 답변분석은 '기간 내 누적' 의미론을 쓴다(대시보드·
  // 웹사이트 KPI 의 스냅샷과 구분). 기간을 7일/30일로 바꿔도 숫자가 그대로였던
  // 원인이 스냅샷(기간 내 최신 배치) 선택이었다. cumulative 는 캐시 키에 들어간다.
  const filters = { ...readStandardFilters(await searchParams, session?.user.scope), cumulative: true };

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      {/* QA 2차 #3·#10 — 헤더 우측 = 측정 기준일 pill(대시보드 Overview 와 동일),
          측정 개요 카드 = 아래 필터 박스 우측(같은 grid 행). */}
      <PageHeader
        title={t("title")}
        description={t("pageSubtitle", { tab: t("tabs.citations"), description: t("citations.description") })}
        actions={
          <Suspense fallback={<LastMeasuredPillSkeleton />}>
            <LastMeasuredPill asOf={fetchStandardCitations(filters).then((d) => d?.asOf ?? null)} />
          </Suspense>
        }
      />
      <FilterTransitionProvider>
        {/* QA 2차 #10(운영 결정) — 필터 박스와 측정 개요 카드는 **한 grid 행**이다.
            `items-stretch` + 각 카드 h-full → 두 박스의 top·bottom 이 같다. 인용은
            칩 2행(#2) 때문에 필터 박스가 높아지므로, 개요 카드가 그 높이를 따라간다.
            2026-09-10 핫픽스 — sticky 는 **이 행 래퍼**가 소유한다. 패널에 sticky 를
            두면 포함 블록이 자기와 같은 높이의 grid 행이라 이동거리가 0 이고, 그대로
            스크롤돼 올라가 베타 배너를 덮었다. 래퍼는 페이지 flex 열의 직접 자식이라
            (대시보드 Overview 와 같은 구조) 이동거리가 본문 전체다. bg-background 는
            정지 상태와 동일한 색이지만, 고정됐을 때 두 열 사이 gap 으로 본문이
            비쳐 지나가는 것을 막는다. sticky 는 `lg:` 부터 — 그 아래에서는 두 열이
            세로로 쌓여 행 높이가 뷰포트를 크게 먹는다(GNB·SNB 도 같은 lg 경계다). */}
        <div className="grid items-stretch gap-4 bg-background lg:sticky lg:top-24 lg:z-20 lg:grid-cols-[1fr_auto]">
          <Suspense fallback={<FilterBarSkeleton />}>
            <CitationsFilterBar filters={filters} scope={session?.user.scope} />
          </Suspense>
          <Suspense fallback={<MeasurementOverviewCardSkeleton />}>
            <CitationsOverview filters={filters} />
          </Suspense>
        </div>
        {/* 필터 적용 전이 — 필터바와 본문이 같은 transition pending 을 공유한다.
            어느 경계도 re-key 하지 않으므로(이전 결과 유지) 적용 중 화면은 옛
            필터의 숫자를 그대로 보여준다 → FilterContentDim 으로 본문을 흐리고
            "재조회 중" 필을 띄워야 옛 결과를 새 결과로 오독하지 않는다
            (dashboard/page.tsx 와 동일한 짝). */}
        <FilterContentDim>
          <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
            <CitationsBody filters={filters} />
          </Suspense>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// 필터바 — 값싼 옵션 read 만 소유. 측정 개요 카드는 QA #16(2026-09-08) 이후
// 여기가 아니라 PageHeader의 actions 슬롯(페이지 타이틀 옆)에 산다.
async function CitationsFilterBar({ filters, scope }: { filters: StandardFilters; scope?: AllowedScope }) {
  // 브랜드 선택을 반영한 유효 스코프로 옵션을 좁힌다 (dashboard/page.tsx와 동일).
  const optionScope = scope ? narrowScopeBrands(scope, filters.brand) : undefined;
  // 옵션의 측정 창 = 화면의 기간 필터. 데이터와 같은 창을 봐야 죽은 옵션이 안 생긴다.
  const dateRange = { dateFrom: filters.dateFrom, dateTo: filters.dateTo };
  const [catalogRows, geographyOptions, languageOptions, optionMatrix, collection] = await Promise.all([
    listCatalogTaxonomy(),
    listMeasuredRegions(
      optionScope,
      undefined,
      true, // 표준(글로벌): 루트 카탈로그로 옵션 제한 — 데이터와 동일 국가 집합
      dateRange, // 측정 창도 데이터와 동일 — 창 밖 시장(EG 등)은 옵션에서 뺀다
    ),
    // 언어 옵션 (2026-09-03) — 대시보드와 **같은 함수·같은 optionScope**. 술어도
    // 공통(promptAxisPreds standard)이라 두 화면이 같은 URL 에서 같은 모집단을 낸다.
    // 2026-09-04: 국가(filters.region)로 **좁히지 않는다** — 실제 드롭다운 내용은
    // optionMatrix 를 draft 로 좁혀 만든다.
    listMeasuredStandardLanguages(optionScope, undefined, dateRange),
    // 옵션 의존 매트릭스 (브랜드 × 국가 × 언어) — 사용자 선택으로 좁히지 않은 조합표.
    listMeasuredScopeMatrix(optionScope, dateRange),
    // 수집 시작일 — 기간 축 캘린더 min·프리셋 클램프(QA #19·#20). min/max 1행
    // 쿼리라 옵션 read 와 병렬로 붙여도 비용이 사실상 없다. 실패해도 필터바를
    // 깨뜨리지 않는다 — 값이 없으면 캘린더 제한이 없을 뿐이다(종전 동작).
    scope ? standardCollectionDates(scope).catch(() => null) : Promise.resolve(null),
  ]);
  return (
    <>
      <AnalysisFilterBar
        stage="citations"
        // QA 2차 #2·#5(2026-09-10 고객 요청) — 출처 카테고리·경쟁사를 필터 패널 축으로
        // 되돌린다(칩 제거). 두 축은 패널의 draft→`적용` 흐름을 타므로 체크는 즉시,
        // 서버 왕복은 적용 1회뿐이다. 공유 목록이 아니라 이 화면 전용 목록을 넘긴다 —
        // website/project 인용(CitationsView)은 종전 축 구성 그대로여야 한다.
        onlyGroups={STANDARD_CITATION_V2_ONLY_GROUPS}
        // 경쟁사 옵션만 인용 집계에서 온다 → **프로미스로** 넘겨 그 facet 하나만
        // 서스펜드시킨다(요청단위 dedup — 본문과 같은 프로미스라 DB 왕복은 그대로 1회).
        // 실패해도 필터바를 깨뜨리지 않는다: 옵션이 비면 축이 사라질 뿐이다(단
        // 사용자가 공식(경쟁사)를 직접 제외한 경우는 비활성으로 남는다 — 패널의
        // keepAsDisabledAxis 주석).
        // ⚠️ 선택 상한(2026-09-11 검증 B2, 이번 diff 이전 칩과 동일한 제약 — 회귀 아님):
        // `live.domains` 는 캐시 슬리밍(scope-aggregates.ts::slimCitationsLiveForCache,
        // MIRROR_CACHE_BUDGET_BYTES 초과 시 CITATION_SLIM_LEVELS 로 2000→1500→…→400 캡)에
        // 잘리므로, 실측(전체 스코프)에서 상위 1,500 도메인만 남아 공식(경쟁사) 14,039 중
        // 1,498 은 옵션에 없다. 후속으로 풀려면 옵션 전용의 가벼운 도메인 목록 리더를
        // repository 레이어에 두는 쪽이지, 슬리밍 상한을 올리는 쪽이 아니다(캐시 예산).
        competitorOptions={fetchStandardCitations(filters)
          .then((live) => competitorDomainOptions(live?.domains ?? []))
          .catch(() => [])}
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        languageOptions={languageOptions}
        optionMatrix={optionMatrix}
        collectionStartDay={collection?.firstMeasuredAt?.toISOString() ?? null}
        // sticky 소유자는 위 grid 행 래퍼다(패널은 그 행과 높이가 같아 이동거리 0).
        sticky={false}
      />
      <SectionDoneMarker id="standard-citation:filters" />
    </>
  );
}


async function CitationsOverview({ filters }: { filters: StandardFilters }) {
  const t = await getTranslations("answerAnalysis.citations.v2.overview");
  const [applied, subKpis, live] = await Promise.all([
    fetchStandardAppliedPromptCount(filters),
    fetchStandardSubKpis(filters),
    fetchStandardCitations(filters),
  ]);
  return (
    <>
      <MeasurementOverviewCard
        applied={applied}
        measured={subKpis.measuredPrompts}
        appliedHref="/standard/prompts"
        unmeasuredAction={
          hasAnswerOnlyAxes(filters) ? null : (
            <UnmeasuredPromptsButton
              count={applied != null && subKpis.measuredPrompts != null ? Math.max(0, applied - subKpis.measuredPrompts) : null}
            />
          )
        }
        conditional={hasAnswerOnlyAxes(filters)}
        extraRows={[
          { key: "citations", label: t("totalCitations"), value: live?.summary.total ?? null },
          { key: "domains", label: t("uniqueDomains"), value: live?.summary.uniqueDomains ?? null },
        ]}
      />
      <SectionDoneMarker id="standard-citation:overview" />
    </>
  );
}

// 본문 — 프로미스를 그대로 넘긴다(섹션별 스트리밍, mention/page.tsx 규약).
async function CitationsBody({ filters }: { filters: StandardFilters }) {
  const prev = fetchStandardKpiHeroSubKpisPrev(filters, "citation");
  const citations = fetchStandardCitations(filters);
  return (
    <CitationsStandardView
      data={citations}
      // "데이터 없음"과 "예산 초과"를 화면이 구분하게 하는 표식(E-2 degrade-registry).
      // 요청 스코프 서버 전용이라 클라이언트 뷰가 직접 못 읽고, 판정은 그 집계가 끝난
      // **뒤에만** 유효하므로 같은 프로미스에 이어 붙인다(추가 조회 0).
      dataDegraded={citations.then(() => wasDegraded("standardCitations"))}
      prevSubKpis={prev.then((p) => p?.sub ?? null)}
      prevBasisDate={prev.then((p) => p?.asOf ?? null)}
      typeCategories={fetchStandardCitationTypeCategories(filters)}
      toneSummary={fetchStandardCitationToneSummary(filters)}
      prevCategories={fetchStandardCitationCategoriesPrev(filters)}
    />
  );
}
