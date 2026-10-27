import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import type { AllowedScope } from "@/lib/auth/types";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { CitationsView } from "../../../standard/answer-analysis/_components/citations-view";
import { AnalysisFilterBar } from "../../../standard/answer-analysis/_components/analysis-filter-bar";
import {
  AnswerAnalysisBodySkeleton,
  FilterBarSkeleton,
} from "@/components/dash/section-skeleton";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import type {
  CitationAsOfScreen,
  CitationFilterBarScreen,
  WebsiteCitationScreen,
} from "../../../standard/answer-analysis/_data/citation-view";

// 웹사이트 > 답변 분석 > 인용 — 표준 CitationsView 재사용. 축은 웹사이트 전용:
// geography + language + engine (admin 은 brand 통합 추가). 표준 카탈로그 축은
// 웹사이트 프롬프트에 태깅이 없어 숨김. 데이터는 website 전용 프로젝트 — Overview와 동일 모집단.
// source(출처 카테고리)는 도메인에서 파생되는 축이라 프롬프트 태깅과 무관하게
// 성립 — 세 인용 화면(표준/웹사이트/프로젝트) 공통으로 연다.
//
// Data (BFF): the filter bar reads `citation/filter-bar` (website options, the citation calendar)
// and its date from `citation/as-of`; the body reads `citation/website` (CitationsView props, the
// URL rate cards and their numbers). The website reads the site country axis (?geography= =
// website_sites.country_code) on the server. The domain table pages ("더 보기"), searches, sorts
// and exports through /api/citations/domains* and a row's drilldown loads when it opens.
const WEBSITE_ONLY_GROUPS: DimensionGroup[] = ["geography", "language", "engine", "time", "source"];
type SearchParams = Record<string, string | string[] | undefined>;
type ScreenQuery = Record<string, string | string[] | null | undefined>;

export default async function WebsiteAnswerAnalysisCitationPage({
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
  const extraGroups: DimensionGroup[] =
    session?.user.role === "admin" ? ["brand"] : [];
  const query: ScreenQuery = { ...(await searchParams), "ctx.surface": "website", "ctx.role": session?.user.role ?? null };

  // 2026-08-27 — 필터바 / 본문 두 경계 (사유는 standard/answer-analysis/mention 주석).
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("tabs.citations")} />
      <FilterTransitionProvider>
        <Suspense fallback={<FilterBarSkeleton />}>
          <CitationsFilterBar
            query={query}
            scope={session?.user.scope}
            extraGroups={extraGroups}
            locale={locale}
          />
        </Suspense>
        {/* 필터 적용 전이 — 필터바와 본문이 같은 transition pending 을 공유한다.
            어느 경계도 re-key 하지 않으므로(이전 결과 유지) 적용 중 화면은 옛
            필터의 숫자를 그대로 보여준다 → FilterContentDim 으로 본문을 흐리고
            "재조회 중" 필을 띄워야 옛 결과를 새 결과로 오독하지 않는다
            (dashboard/page.tsx 와 동일한 짝). */}
        <FilterContentDim>
          <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
            <CitationsData query={query} scope={session?.user.scope} extraGroups={extraGroups} locale={locale} />
          </Suspense>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// 필터바 — 옵션(사이트 국가·언어·매트릭스)과 인용 계열 달력. 날짜 pill 은 인용 집계의 기준일(프로미스).
async function CitationsFilterBar({
  query,
  scope,
  extraGroups,
  locale,
}: {
  query: ScreenQuery;
  scope?: AllowedScope;
  extraGroups: DimensionGroup[];
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
        scope={scope}
        catalogRows={bar.options.catalogRows}
        geographyOptions={bar.options.geographyOptions}
        languageOptions={bar.options.languageOptions}
        optionMatrix={bar.options.optionMatrix}
        extraGroups={extraGroups}
        onlyGroups={WEBSITE_ONLY_GROUPS}
        primaryGroups={WEBSITE_ONLY_GROUPS}
        asOf={screenGet<CitationAsOfScreen>("citation/as-of", query).then((m) => m.asOf)}
        selectableDates={bar.dates.selectableDates}
      />
      <SectionDoneMarker id="website-citation:filters" />
    </>
  );
}

async function CitationsData({
  query,
  scope,
  extraGroups,
  locale,
}: {
  query: ScreenQuery;
  scope?: AllowedScope;
  extraGroups: DimensionGroup[];
  locale: string;
}) {
  let s: WebsiteCitationScreen;
  try {
    s = await screenGet<WebsiteCitationScreen>("citation/website", query);
  } catch (e) {
    throwForPage(e, locale);
  }
  // P6 B042: degrade 표식(5xx·시간 초과) — 그 블록은 '데이터 없음'·'준비 중'·숨김 대신 기존 지연 안내를 낸다.
  return (
    <>
      <CitationsView
        data={s.live}
        vm={s.vm}
        scope={scope}
        extraGroups={extraGroups}
        onlyGroups={WEBSITE_ONLY_GROUPS}
        primaryGroups={WEBSITE_ONLY_GROUPS}
        targetHitRate={s.targetHitRate}
        hideFilterPanel
        tableSource={s.tableSource}
        dataDegraded={s.dataDegraded}
        degradedSections={s.degradedSections}
      />
      <SectionDoneMarker id="website-citation:data" />
    </>
  );
}
