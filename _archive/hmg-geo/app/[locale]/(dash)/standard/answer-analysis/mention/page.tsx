import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import {
  fetchStandardAppliedPromptCount,
  fetchStandardKpiBrandTrend,
  fetchStandardKpiEngineTrend,
  fetchStandardKpiFirstPosition,
  fetchStandardKpiHeroSubKpis,
  fetchStandardKpiHeroSubKpisPrev,
  fetchStandardKpiTypes,
  fetchStandardKpiStanceDist,
  fetchStandardMentions,
  fetchStandardSubKpis,
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
import { PendingCard } from "../_components/mentions-view";
import { MentionsPromptsSection } from "../_components/mentions-prompts-section";
import { AnalysisFilterBar } from "../_components/analysis-filter-bar";
import { UnmeasuredPromptsButton } from "../_components/unmeasured-prompts-dialog";
import {
  MeasurementOverviewCard,
  MeasurementOverviewCardSkeleton,
} from "../_components/measurement-overview-card";
import { KpiTabs } from "../_components/kpi-tabs";
import { MentionKpiTab } from "../_components/kpi/mention-kpi-tab";
import { FavorabilityKpiTab } from "../_components/kpi/favorability-kpi-tab";
import { FirstRankKpiTab } from "../_components/kpi/first-rank-kpi-tab";
import {
  KPI_TAB_PARAM,
  isImplementedKpiTab,
  resolveKpiTab,
  type KpiTab,
} from "../_data/kpi-tab";
import { hasAnswerOnlyAxes } from "../_data/kpi-view";
import {
  AnswerAnalysisBodySkeleton,
  FilterBarSkeleton,
} from "@/components/dash/section-skeleton";
import {
  LastMeasuredPill,
  LastMeasuredPillSkeleton,
} from "@/components/dash/last-measured-pill";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";

// KPI 탭 집계의 앱 예산(엔진 12s + 문장 상한 8s = 실효 최악 20s)이 플랫폼 기본
// 함수 시간제한(플랜별 10~15s)보다 크다. 플랫폼이 먼저 끊으면 예산 초과 시
// 추이만 내리는 degradedTrend 경로가 아예 뜨지 못하고 함수 타임아웃이 된다 —
// dashboard/page.tsx 와 같은 이유로 여유를 확보한다(2026-09-01 검증 지적).
export const maxDuration = 120;

export default async function StandardAnswerAnalysisMentionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("answerAnalysis");

  // The DimensionFilterPanel writes URL params (geography / engine /
  // promptContext); read them here and narrow the live aggregation.
  // D4: scope.brands는 filter.brand 기본값으로 자동 주입.
  const session = await getSession();
  const sp = await searchParams;
  // 2026-09-04 기획 수정 — 답변분석은 '기간 내 누적' 의미론을 쓴다(대시보드·
  // 웹사이트 KPI 의 스냅샷과 구분). 기간을 7일/30일로 바꿔도 숫자가 그대로였던
  // 원인이 스냅샷(기간 내 최신 배치) 선택이었다. cumulative 는 캐시 키에 들어간다.
  const filters = { ...readStandardFilters(sp, session?.user.scope), cumulative: true };
  // 탭도 같은 URL 에서 읽는다 — 서버(read)와 탭 바(write)가 같은 파서를 쓰므로
  // 미지값 폴백 규칙이 갈라지지 않는다.
  const kpiTab = resolveKpiTab(sp[KPI_TAB_PARAM]);

  // 2026-08-27 — 경계를 둘로 쪼갠다. 예전엔 무거운 언급 집계 하나가 필터바까지
  // 붙잡아, 필터를 바꿔 캐시 미스가 나면 **정작 만지려는 필터바가 사라진** 채
  // 화면 전체가 스켈레톤이 됐다. 필터바는 값싼 옵션 read 만 필요하므로 자기
  // 경계에서 먼저 뜨고, 본문은 뒤이어 스트리밍된다.
  //
  // 어느 경계도 re-key 하지 않는다 — 필터 적용 시 이전 결과가 그대로 남아 있다가
  // 좁혀진 롤업으로 스왑된다(스켈레톤 플래시 없음). 특히 필터바 경계는 마운트가
  // 유지되어야 Apply 스피너가 계속 보인다.
  //
  // 2026-08-28 — KPI 탭 본문은 **또 하나의 경계**다. 신규 회차 집계는 8s 가드가
  // 걸린 무거운 read 라, 기존 언급 본문과 한 경계에 묶으면 둘 다 그만큼 늦게 뜬다.
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      {/* 피그마 327:116 부제: "언급 분석 - <설명>" 한 줄. */}
      {/* QA 2차 #3·#10 — 헤더 우측 = 측정 기준일 pill(대시보드 Overview 와 동일),
          측정 개요 카드 = 아래 필터 박스 우측(같은 grid 행). */}
      <PageHeader
        title={t("title")}
        description={t("pageSubtitle", { tab: t("tabs.mentions"), description: t("mentions.description") })}
        // QA 2차 #3(운영 결정: 헤더 pill) — 헤더 우측은 대시보드 Overview 와 **같은**
        // LastMeasured pill 이다. 측정 개요 카드는 아래 필터 행으로 내려갔다(#10).
        actions={
          <Suspense fallback={<LastMeasuredPillSkeleton />}>
            <LastMeasuredPill asOf={fetchStandardMentions(filters).then((d) => d?.asOf ?? null)} />
          </Suspense>
        }
      />
      <FilterTransitionProvider>
        {/* QA 2차 #10(운영 결정) — 필터 박스와 측정 개요 카드는 **한 grid 행**이다.
            `items-stretch` 로 두 열이 행 높이를 공유하고, 각 카드가 h-full 로 그
            높이를 채운다 → 두 박스의 top·bottom 이 항상 같다.
            2026-09-10 핫픽스 — sticky 는 **이 행 래퍼**가 소유한다. 패널에 sticky 를
            두면 포함 블록이 자기와 같은 높이의 grid 행이라 이동거리가 0 이고, 그대로
            스크롤돼 올라가 베타 배너를 덮었다. 래퍼는 페이지 flex 열의 직접 자식이라
            (대시보드 Overview 와 같은 구조) 이동거리가 본문 전체다. bg-background 는
            정지 상태와 동일한 색이지만, 고정됐을 때 두 열 사이 gap 으로 본문이
            비쳐 지나가는 것을 막는다. sticky 는 `lg:` 부터 — 그 아래에서는 두 열이
            세로로 쌓여 행 높이가 뷰포트를 크게 먹는다(GNB·SNB 도 같은 lg 경계다). */}
        <div className="grid items-stretch gap-4 bg-background lg:sticky lg:top-24 lg:z-20 lg:grid-cols-[1fr_auto]">
          <Suspense fallback={<FilterBarSkeleton />}>
            <MentionsFilterBar filters={filters} scope={session?.user.scope} />
          </Suspense>
          <Suspense fallback={<MeasurementOverviewCardSkeleton />}>
            <MentionsOverview filters={filters} />
          </Suspense>
        </div>
        <KpiTabs active={kpiTab} />
        {/* 필터 적용 전이 — 필터바와 본문이 같은 transition pending 을 공유한다.
            어느 경계도 re-key 하지 않으므로(이전 결과 유지) 적용 중 화면은 옛
            필터의 숫자를 그대로 보여준다 → FilterContentDim 으로 본문을 흐리고
            "재조회 중" 필을 띄워야 옛 결과를 새 결과로 오독하지 않는다
            (dashboard/page.tsx 와 동일한 짝). */}
        <FilterContentDim>
          <div className="flex flex-col gap-6">
            <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
              <MentionsKpiBody filters={filters} tab={kpiTab} />
            </Suspense>
            <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
              <MentionsData filters={filters} />
            </Suspense>
          </div>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// 필터바 — 옵션 read 만 소유(카탈로그 택소노미 + 측정 국가). 측정 기준일만
// 본문과 같은 집계에서 오는데, await 하지 않고 프로미스로 넘겨 중첩 경계에서
// 채운다(요청단위 dedup 이라 DB 왕복은 늘지 않는다).
//
// 측정 개요 카드는 QA 2차 #10(2026-09-09, 운영 결정) 이후 **필터 박스 우측**에
// 나란히 산다(page 본문의 grid 한 행). 헤더 우측은 LastMeasuredPill 이 쓴다.
async function MentionsFilterBar({
  filters,
  scope,
}: {
  filters: StandardFilters;
  scope?: AllowedScope;
}) {
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
        stage="mentions"
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        languageOptions={languageOptions}
        optionMatrix={optionMatrix}
        collectionStartDay={collection?.firstMeasuredAt?.toISOString() ?? null}
        // sticky 소유자는 위 grid 행 래퍼다(패널은 그 행과 높이가 같아 이동거리 0).
        sticky={false}
      />
      <SectionDoneMarker id="standard-mention:filters" />
    </>
  );
}

async function MentionsOverview({ filters }: { filters: StandardFilters }) {
  // 측정 기준일(asOf)은 QA 2차 #3 이후 이 카드가 아니라 페이지 헤더 pill 이 그린다.
  const [applied, subKpis] = await Promise.all([
    fetchStandardAppliedPromptCount(filters),
    fetchStandardSubKpis(filters),
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
        // 답변 축(지역·엔진·기간)이 걸리면 "적용 − 측정"은 미측정이 아니다 —
        // 카드가 뺄셈을 멈추고 문구를 바꾼다(verifier 지적 F2).
        conditional={hasAnswerOnlyAxes(filters)}
      />
      <SectionDoneMarker id="standard-mention:overview" />
    </>
  );
}

// KPI 탭 본문 (노출률 / 점유율). 우호도·우선 노출도는 이번 범위 밖 — 탭은 만들되
// 자리만 잡아 둔다(PendingCard). 지면이 붙을 때 이 분기만 바뀐다.
async function MentionsKpiBody({
  filters,
  tab,
}: {
  filters: StandardFilters;
  tab: KpiTab;
}) {
  const t = await getTranslations("answerAnalysis.mentions.kpi");
  if (!isImplementedKpiTab(tab)) {
    return <PendingCard title={t(`tabs.${tab}`)} label={t("pending")} />;
  }

  // PR ③(2026-09-02) — 우호도·우선 노출도는 지표 성질이 달라 자기 탭 컴포넌트를 갖는다.
  // 스트리밍·dedup 규약은 아래 노출률/점유율과 동일(프로미스를 그대로 넘긴다).
  if (tab === "first-rank") {
    return <FirstRankKpiTab firstPosition={fetchStandardKpiFirstPosition(filters)} />;
  }
  if (tab === "favorability") {
    const data = fetchStandardMentions(filters);
    const prev = fetchStandardKpiHeroSubKpisPrev(filters, "favorability");
    return (
      <FavorabilityKpiTab
        subKpis={fetchStandardKpiHeroSubKpis(filters, "favorability")}
        prevSubKpis={prev.then((p) => p?.sub ?? null)}
        prevBasisDate={prev.then((p) => p?.asOf ?? null)}
        engineTrend={fetchStandardKpiEngineTrend(filters)}
        sentimentTotals={data.then((d) => d?.sentimentTotals ?? null)}
        // 답변 축(0072) — 발생 축과 **다른 집계**다. 기존 감정 집계는 손대지 않았고,
        // 스탠스가 없으면 null 이 흘러 카드가 "수집 대기"로 떨어진다.
        stanceDist={fetchStandardKpiStanceDist(filters)}
        typeKpi={fetchStandardKpiTypes(filters)}
      />
    );
  }
  const metric = tab === "sov" ? "sov" : "exposure";

  // ⚠️ 여기서 await 하지 않는다 — **프로미스를 그대로 넘긴다**(2026-09-02).
  //
  // 종전에는 이 6개를 `Promise.all` 하나로 묶어 await 했다. 경계가 하나뿐이라
  // 가장 느린 집계(엔진 추이 ~10.8s)가 끝날 때까지 **지면 전체가 대기**했고, 그
  // 하나가 예산에 걸리면 스칼라·표까지 같이 비었다. 실측 개별 소요는 스냅샷 ~1s ·
  // 유형 4.2s · 브랜드추이 7.5s · 엔진 10.8s 로 최대 10배 차이가 난다.
  //
  // MentionKpiTab 이 각 prop 을 자기 <Suspense> 경계 안에서 `use()` 로 풀므로,
  // 먼저 끝난 집계부터 개별 스트리밍된다. 여기서 await 하면 그 분리가 무의미해진다.
  //
  // dedup: 이 페처들은 전부 요청단위 dedup(`requestDeduped`)이라, 아래 본문 경계
  // (MentionsData)·필터바 슬롯이 같은 필터로 **같은 페처**를 다시 불러도 DB 왕복은
  // 1회다. 여러 섹션이 같은 프로미스 인스턴스를 나눠 쓰는 것도 같은 취지다.
  // (아래 Sub KPI 두 개만 예외 — 파트가 달라 전량 셀과 별도로 돈다. 이유는 그 주석.)
  //
  // ⚠️ 히어로는 **전량 Sub KPI 를 부르지 않는다**(2026-09-02).
  //
  // 이 탭이 Sub KPI 에서 읽는 값은 `kpiHero` 하나뿐이다 — 노출률은 Q1(answers),
  // 점유율은 Q1+Q2(mentions). 그런데 `fetchStandardSubKpis` 는 탭과 무관하게
  // Q1~Q5 를 전부 돌린다(로컬 warm 실측 17.0s, 콜드 ~30s). 아래 본문 경계
  // (MentionsData)·측정 개요 카드는 감정·프롬프트까지 실제로 읽으므로 전량이
  // 맞지만, 히어로가 그것을 함께 기다릴 이유가 없다.
  //
  // 파트 표(어느 탭이 어느 문장을 읽는지)와 그 근거는
  // `lib/scope/kpi-tab-budget.ts::KPI_TAB_SUB_KPI_PARTS` 가 정본이다.
  const data = fetchStandardMentions(filters);
  const subKpis = fetchStandardKpiHeroSubKpis(filters, metric);
  const prevSubKpis = fetchStandardKpiHeroSubKpisPrev(filters, metric);
  return (
    <MentionKpiTab
      metric={metric}
      subKpis={subKpis}
      prevSubKpis={prevSubKpis.then((p) => p?.sub ?? null)}
      brands={data.then((d) => d?.brands ?? [])}
      // 히어로 추이 + 엔진별 섹션. null = 예산 초과 → 그 지면만 대체 문구.
      engineTrend={fetchStandardKpiEngineTrend(filters)}
      // 경쟁사 스파크라인 — 직전 4회차면 충분하므로 창을 28일로 좁힌다(창이 지배 비용).
      brandTrend={fetchStandardKpiBrandTrend(filters)}
      typeKpi={fetchStandardKpiTypes(filters)}
      // 유형 스택의 `당사 · 경쟁사 · 기타` 3분할 원천. 이미 받아 온 언급 집계에
      // 들어 있으므로 새 쿼리를 만들지 않는다.
      typesByBrand={data.then((d) => d?.typesByBrand ?? null)}
      prevBasisDate={prevSubKpis.then((p) => p?.asOf ?? null)}
    />
  );
}

// 공통 하단 "프롬프트 및 답변"(2026-09-02) — 탭과 무관하게 언급 집계 하나만 기다린다.
// 요약 카드·헤드투헤드·감정/유형 카드는 탭이 담당하므로 표준 표면에서 빠졌다
// (website/project 는 MentionsView 그대로 — 스펙 회귀 기준). 빈 상태 판정은 이
// 경계 안에서만 — 필터바는 위 경계에 남아 데이터가 없어도 필터를 바꿀 수 있다.
async function MentionsData({ filters }: { filters: StandardFilters }) {
  const data = await fetchStandardMentions(filters);
  return (
    <>
      <MentionsPromptsSection data={data} />
      <SectionDoneMarker id="standard-mention:data" />
    </>
  );
}
