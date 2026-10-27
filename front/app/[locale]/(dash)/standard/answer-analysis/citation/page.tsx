import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import type { AllowedScope } from "@/lib/auth/types";
import { AnalysisFilterBar } from "../_components/analysis-filter-bar";
import { STANDARD_CITATION_V2_ONLY_GROUPS } from "../_components/filter-groups";
import { CitationsStandardView } from "../_components/citations-standard-view";
import { AnswerAnalysisBodySkeleton, FilterBarSkeleton } from "@/components/dash/section-skeleton";
import {
  LastMeasuredPill,
  LastMeasuredPillSkeleton,
} from "@/components/dash/last-measured-pill";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";
import { PeriodDeltaLine } from "@/components/dash/period-delta-line";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type {
  CitationAsOfScreen,
  CitationFilterBarScreen,
  StandardCitationScreen,
} from "../_data/citation-view";

// 인용 집계 + 부속 집계(유형별 구성·우호도 요약)가 플랫폼 기본 함수 시간제한을 넘길 수
// 있다 — mention/page.tsx 와 같은 이유로 여유를 확보한다.
export const maxDuration = 120;

// 표준 > 답변 분석 > 인용 — 개편 화면(PR ④, 디자인 571:380). website/project 인용
// 페이지는 종전 CitationsView 를 그대로 쓴다.
//
// Data (BFF): every section reads a finished view model from the screen API
// (back/bff/screens/citation.py) with the page's URL params: the header pill and the filter bar's
// competitor options from `citation/as-of` (the citation read), the filter panel from
// `citation/filter-bar` (options, calendar), the body from `citation/standard` (CitationsStandardView
// props, their numbers and the month comparison line). The domain table searches and sorts through
// /api/citations/domains and a row's drilldown loads from /api/citations/domains/<skey> (3.5 #6).
type SearchParams = Record<string, string | string[] | undefined>;

export default async function StandardAnswerAnalysisCitationPage({
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
  const query = { ...(await searchParams), "ctx.surface": "global" };
  // 헤더 pill 과 필터바의 경쟁사 옵션이 같은 인용 집계를 읽는다(요청 안에서 한 번).
  const meta = screenGet<CitationAsOfScreen>("citation/as-of", query);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      {/* QA 2차 #3 — 헤더 우측 = 측정 기준일 pill(대시보드 Overview 와 동일). */}
      <PageHeader
        title={t("title")}
        description={t("pageSubtitle", { tab: t("tabs.citations"), description: t("citations.description") })}
        actions={
          <Suspense fallback={<LastMeasuredPillSkeleton />}>
            <LastMeasuredPill asOf={meta.then((m) => m.asOf)} />
          </Suspense>
        }
      />
      <FilterTransitionProvider>
        {/* 필터 박스 행. 2026-09-28 측정 개요 카드 제거(제품 결정)로 이 행은 필터
            박스 한 열이다 — 종전 QA 2차 #10 의 우측 열(개요 카드)이 없어졌다.
            2026-09-10 핫픽스 — sticky 는 **이 행 래퍼**가 소유한다. 패널에 sticky 를
            두면 포함 블록이 자기와 같은 높이의 grid 행이라 이동거리가 0 이고, 그대로
            스크롤돼 올라가 베타 배너를 덮었다. 래퍼는 페이지 flex 열의 직접 자식이라
            (대시보드 Overview 와 같은 구조) 이동거리가 본문 전체다. bg-background 는
            고정됐을 때 패널 뒤로 본문이 비쳐 지나가는 것을 막는다. sticky 는 `lg:`
            부터다(GNB·SNB 도 같은 lg 경계다). */}
        <div className="grid items-stretch gap-4 bg-background lg:sticky lg:top-24 lg:z-20">
          <Suspense fallback={<FilterBarSkeleton />}>
            <CitationsFilterBar query={query} meta={meta} scope={session?.user.scope} locale={locale} />
          </Suspense>
        </div>
        {/* 필터 적용 전이 — 필터바와 본문이 같은 transition pending 을 공유한다.
            어느 경계도 re-key 하지 않으므로(이전 결과 유지) 적용 중 화면은 옛
            필터의 숫자를 그대로 보여준다 → FilterContentDim 으로 본문을 흐리고
            "재조회 중" 필을 띄워야 옛 결과를 새 결과로 오독하지 않는다
            (dashboard/page.tsx 와 동일한 짝). */}
        <FilterContentDim>
          <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
            <CitationsBody query={query} locale={locale} />
          </Suspense>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// 필터바 — 옵션·달력(citation/filter-bar). 경쟁사 옵션만 인용 집계에서 온다 → **프로미스로** 넘겨
// 그 facet 하나만 서스펜드시킨다. 실패해도 필터바를 깨뜨리지 않는다: 옵션이 비면 축이 사라질 뿐이다.
async function CitationsFilterBar({
  query,
  meta,
  scope,
  locale,
}: {
  query: SearchParams;
  meta: Promise<CitationAsOfScreen>;
  scope?: AllowedScope;
  locale: string;
}) {
  let bar: CitationFilterBarScreen;
  try {
    bar = await screenGet<CitationFilterBarScreen>("citation/filter-bar", query);
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <>
      <AnalysisFilterBar
        stage="citations"
        onlyGroups={STANDARD_CITATION_V2_ONLY_GROUPS}
        competitorOptions={meta.then((m) => m.competitorOptions).catch(() => [])}
        scope={scope}
        catalogRows={bar.options.catalogRows}
        geographyOptions={bar.options.geographyOptions}
        languageOptions={bar.options.languageOptions}
        optionMatrix={bar.options.optionMatrix}
        collectionStartDay={bar.dates.collectionStartDay}
        latestAnchorDay={bar.dates.latestAnchorDay}
        selectableDates={bar.dates.selectableDates}
        sticky={false}
      />
      <SectionDoneMarker id="standard-citation:filters" />
    </>
  );
}

// 본문 — citation/standard 하나(CitationsStandardView 의 데이터·숫자 + 달력 월 "전월 대비" 줄).
async function CitationsBody({ query, locale }: { query: SearchParams; locale: string }) {
  let s: StandardCitationScreen;
  try {
    s = await screenGet<StandardCitationScreen>("citation/standard", query);
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <>
      <CitationsStandardView
        data={s.live}
        vm={s.vm}
        dataDegraded={s.dataDegraded}
        // P6 B041: 보조 블록(추이·구성 추이·프롬프트 분할)의 일시 실패 — '준비 중'·숨김 대신 기존 지연 안내.
        sectionDegraded={s.sectionDegraded}
        typeChart={s.typeChart}
        toneSummary={s.toneSummary}
        tableSource={s.tableSource}
      />
      {s.periodView ? <PeriodDeltaLine view={s.periodView} /> : null}
    </>
  );
}
