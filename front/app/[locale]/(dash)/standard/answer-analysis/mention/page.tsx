import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import type { AllowedScope } from "@/lib/auth/types";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import type { FilterDatesView, PanelFilterOptions } from "@/lib/hgh/filter-types";
import { PendingCard } from "../_components/mentions-view";
import { MentionsPromptsSection } from "../_components/mentions-prompts-section";
import { AnalysisFilterBar } from "../_components/analysis-filter-bar";
import { KpiTabs } from "../_components/kpi-tabs";
import { MentionKpiTab } from "../_components/kpi/mention-kpi-tab";
import { FavorabilityKpiTab } from "../_components/kpi/favorability-kpi-tab";
import { FirstRankKpiTab } from "../_components/kpi/first-rank-kpi-tab";
import { KPI_TAB_PARAM, isImplementedKpiTab, resolveKpiTab, type KpiTab } from "../_data/kpi-tab";
import type {
  FavorDeltaScreen,
  FavorHeroScreen,
  FavorMatrixScreen,
  FavorSentimentScreen,
  FavorTrendScreen,
  FirstRankScreen,
  KpiCompetitorsScreen,
  KpiEnginesScreen,
  KpiHeroDeltaScreen,
  KpiHeroScreen,
  KpiHeroTrendScreen,
  KpiTypesScreen,
  MentionAsOfScreen,
  MentionKpiPeriodScreen,
  PromptsSectionScreen,
} from "../_data/mention-screen";
import { AnswerAnalysisBodySkeleton, FilterBarSkeleton } from "@/components/dash/section-skeleton";
import { LastMeasuredPill, LastMeasuredPillSkeleton } from "@/components/dash/last-measured-pill";
import { FilterTransitionProvider, FilterContentDim } from "@/components/dash/filter-transition";
import { PeriodDeltaLine } from "@/components/dash/period-delta-line";
import { throwForPage } from "@/lib/hgh/errors";

// KPI 탭 집계의 앱 예산(엔진 12s + 문장 상한 8s = 실효 최악 20s)이 플랫폼 기본
// 함수 시간제한(플랜별 10~15s)보다 크다. 플랫폼이 먼저 끊으면 예산 초과 시
// 추이만 내리는 degradedTrend 경로가 아예 뜨지 못하고 함수 타임아웃이 된다 —
// dashboard/page.tsx 와 같은 이유로 여유를 확보한다(2026-09-01 검증 지적).
export const maxDuration = 120;

// Data: the mention screens of the API (back/bff/screens/mention.py). Each Suspense section
// fetches its own finished view model (`screenGet`, one call per section) and renders it; the
// filter bar reads the shared panel option and calendar screens.

type SearchParams = Record<string, string | string[] | undefined>;

export default async function StandardAnswerAnalysisMentionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("answerAnalysis");

  const session = await getSession();
  const sp = await searchParams;
  // 탭도 같은 URL 에서 읽는다 — 서버(read)와 탭 바(write)가 같은 파서를 쓰므로
  // 미지값 폴백 규칙이 갈라지지 않는다.
  const kpiTab = resolveKpiTab(sp[KPI_TAB_PARAM]);

  // 2026-08-27 — 경계를 둘로 쪼갠다. 필터바는 값싼 옵션 read 만 필요하므로 자기
  // 경계에서 먼저 뜨고, 본문은 뒤이어 스트리밍된다. 어느 경계도 re-key 하지 않는다.
  // 2026-08-28 — KPI 탭 본문은 **또 하나의 경계**다.
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      {/* 피그마 327:116 부제: "언급 분석 - <설명>" 한 줄. */}
      {/* QA 2차 #3 — 헤더 우측 = 측정 기준일 pill(대시보드 Overview 와 동일). */}
      <PageHeader
        title={t("title")}
        description={t("pageSubtitle", { tab: t("tabs.mentions"), description: t("mentions.description") })}
        actions={
          <Suspense fallback={<LastMeasuredPillSkeleton />}>
            <LastMeasuredPill asOf={screenGet<MentionAsOfScreen>("mention/as-of", sp).then((d) => d.asOf)} />
          </Suspense>
        }
      />
      <FilterTransitionProvider>
        {/* 필터 박스 행. 2026-09-10 핫픽스 — sticky 는 **이 행 래퍼**가 소유한다. */}
        <div className="grid items-stretch gap-4 bg-background lg:sticky lg:top-24 lg:z-20">
          <Suspense fallback={<FilterBarSkeleton />}>
            <MentionsFilterBar sp={sp} scope={session?.user.scope} locale={locale} />
          </Suspense>
        </div>
        <KpiTabs active={kpiTab} />
        {/* 필터 적용 전이 — 필터바와 본문이 같은 transition pending 을 공유한다. */}
        <FilterContentDim>
          <div className="flex flex-col gap-6">
            <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
              <MentionsKpiBody sp={sp} tab={kpiTab} />
            </Suspense>
            <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
              <MentionsData sp={sp} locale={locale} />
            </Suspense>
          </div>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// 필터바 — 패널 옵션(측정 국가·언어·카탈로그·조합표)과 측정 캘린더(공용 화면).
async function MentionsFilterBar({
  sp,
  scope,
  locale,
}: {
  sp: SearchParams;
  scope?: AllowedScope;
  locale: string;
}) {
  let options: PanelFilterOptions;
  let dates: FilterDatesView;
  try {
    [options, dates] = await Promise.all([
      screenGet<PanelFilterOptions>("shared/panel-options", { ...sp, surface: "global" }),
      screenGet<FilterDatesView>("shared/filter-dates", { surface: "global", family: "mentions" }),
    ]);
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <>
      <AnalysisFilterBar
        stage="mentions"
        scope={scope}
        catalogRows={options.catalogRows}
        geographyOptions={options.geographyOptions}
        languageOptions={options.languageOptions}
        optionMatrix={options.optionMatrix}
        collectionStartDay={dates.collectionStartDay}
        latestAnchorDay={dates.latestAnchorDay}
        selectableDates={dates.selectableDates ?? undefined}
        sticky={false}
      />
      <SectionDoneMarker id="standard-mention:filters" />
    </>
  );
}

// KPI 탭 본문 — 기간 비교(네 탭 공용, 한 번)를 해소한 뒤 탭별 섹션 화면을 프로미스로 넘긴다.
async function MentionsKpiBody({ sp, tab }: { sp: SearchParams; tab: KpiTab }) {
  const t = await getTranslations("answerAnalysis.mentions.kpi");
  if (!isImplementedKpiTab(tab)) {
    return <PendingCard title={t(`tabs.${tab}`)} label={t("pending")} />;
  }

  const frame = await screenGet<MentionKpiPeriodScreen>("mention/kpi-period", sp);
  const { periodSlots: periodCompare, periodDays } = frame;
  // 달력 월일 때만 줄을 그린다 — 창 비교는 카드·히어로의 칩이 이미 말하고 있다.
  const monthLine = frame.monthLine ? <PeriodDeltaLine view={frame.monthLine} /> : null;
  const section = <T,>(name: string, extra: ScreenQuery = {}): Promise<T> => screenGet<T>(name, { ...sp, ...extra });

  if (tab === "first-rank") {
    return (
      <>
        <FirstRankKpiTab
          firstRank={section<FirstRankScreen>("mention/first-rank")}
          periodCompare={periodCompare}
          periodDays={periodDays}
        />
        {monthLine}
      </>
    );
  }
  if (tab === "favorability") {
    return (
      <>
        <FavorabilityKpiTab
          hero={section<FavorHeroScreen>("mention/favor-hero")}
          delta={section<FavorDeltaScreen>("mention/favor-delta")}
          trend={section<FavorTrendScreen>("mention/favor-trend")}
          sentiment={section<FavorSentimentScreen>("mention/favor-sentiment")}
          stance={null}
          matrix={section<FavorMatrixScreen>("mention/favor-matrix")}
          periodCompare={periodCompare}
          periodDays={periodDays}
        />
        {monthLine}
      </>
    );
  }
  const metric = tab === "sov" ? "sov" : "exposure";
  const ctx = { "ctx.metric": metric };
  // ⚠️ 여기서 await 하지 않는다 — **프로미스를 그대로 넘긴다**(2026-09-02). 각 섹션이 자기
  // <Suspense> 경계 안에서 풀어 준비되는 대로 개별 스트리밍된다.
  return (
    <>
      <MentionKpiTab
        metric={metric}
        hero={section<KpiHeroScreen>("mention/kpi-hero", ctx)}
        heroDelta={section<KpiHeroDeltaScreen>("mention/kpi-hero-delta", ctx)}
        competitors={section<KpiCompetitorsScreen>("mention/kpi-competitors", ctx)}
        heroTrend={section<KpiHeroTrendScreen>("mention/kpi-hero-trend", ctx)}
        engines={section<KpiEnginesScreen>("mention/kpi-engines", ctx)}
        types={section<KpiTypesScreen>("mention/kpi-types", ctx)}
        periodCompare={periodCompare}
        periodDays={periodDays}
      />
      {monthLine}
    </>
  );
}

// 공통 하단 "프롬프트 및 답변"(2026-09-02) — 탭과 무관하게 언급 집계 하나만 기다린다.
async function MentionsData({ sp, locale }: { sp: SearchParams; locale: string }) {
  let vm: PromptsSectionScreen;
  try {
    vm = await screenGet<PromptsSectionScreen>("mention/prompts-section", sp);
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <>
      {/* B034: null 이 일시 실패(globalMentions 표식)면 "데이터 없음" 대신 기존 degraded 문구. */}
      {vm.data ? (
        <MentionsPromptsSection data={vm.data} table={vm.table} trendSeries={vm.trendSeries} degraded={vm.degraded} />
      ) : (
        <MentionsPromptsSection data={null} degraded={vm.degraded} />
      )}
      <SectionDoneMarker id="standard-mention:data" />
    </>
  );
}
