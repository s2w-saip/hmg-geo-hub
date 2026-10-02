import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import {
  fetchWebsiteMentions,
  fetchWebsiteSubKpis,
  fetchWebsiteSubKpisPrev,

  fetchSelectableAnchorDates,
} from "@/lib/scope/server";
import { getSession } from "@/lib/auth/session";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";

import {
  listWebsiteCountries,
  listMeasuredLanguages,
  listWebsiteScopeMatrix,
} from "@/lib/db/repositories/website-sites";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import type { AllowedScope } from "@/lib/auth/types";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { MentionsView } from "../../../standard/answer-analysis/_components/mentions-view";
import { AnalysisFilterBar } from "../../../standard/answer-analysis/_components/analysis-filter-bar";
import { buildMentionSubKpis } from "../../../standard/answer-analysis/_data/sub-kpis";
import {
  AnswerAnalysisBodySkeleton,
  FilterBarSkeleton,
} from "@/components/dash/section-skeleton";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";
import { throwForPage } from "@/lib/hgh/errors";
import {
  afterEssentials,
  loadMentionsAsOf,
  loadMentionsLive,
  loadSubKpis,
  loadSubKpisPrev,
  type MentionsContext,
} from "@/lib/hgh/adapters/mentions";
import { isAnalysisApi, loadFilterDates, loadPanelOptions } from "@/lib/hgh/adapters/filters";

// 웹사이트 > 답변 분석 > 언급 — 표준 MentionsView 재사용. 차이점은 필터 구성:
// admin 에게만 brand(브랜드 통합) 축을 추가 노출(extraGroups). 데이터는 website
// 전용 프로젝트(fetchWebsiteMentions) — Overview와 동일 모집단(2026-07-06,
// 표준 루트 공유였을 때의 숫자 불일치 발견 후 교체).
//
// Data source (unit U6, D8): HGH_SOURCE_G3 = api -> lib/hgh/adapters/{mentions,filters}.ts
// (surface=website: the backend reads the site country axis itself, so the region ->
// websiteCountry remap below only feeds the legacy readers; toCommonQuery takes websiteCountry
// on the website surface). legacy (default) -> the readers below, unchanged.
export default async function WebsiteAnswerAnalysisMentionPage({
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
  // 웹사이트 축 = geography + language + engine (admin 은 brand 통합 추가).
  // 표준 카탈로그 축(depth/listType/brandPresence)은 웹사이트 프롬프트에 태깅이
  // 없어 무의미하므로 숨긴다 — 노출 축 목록을 readStandardFilters 에도 전달해
  // 숨은 축의 URL 파라미터가 데이터만 조용히 좁히는 누수를 막는다.
  const extraGroups: DimensionGroup[] =
    session?.user.role === "admin" ? ["brand"] : [];
  const rawFilters = readStandardFilters(await searchParams, session?.user.scope, [
    ...WEBSITE_ONLY_GROUPS,
    ...extraGroups,
  ], "website");
  // 지역 축 = 사이트 국가(website_sites.country_code). 개요 화면과 동일한 이식 —
  // 자세한 사유는 citation/page.tsx 주석 참조(측정 로케일 region 과 다른 축이다).
  // 2026-09-04 기획 수정 — 답변분석은 '기간 내 누적' 의미론을 쓴다(대시보드·
  // 웹사이트 KPI 의 스냅샷과 구분). 기간을 7일/30일로 바꿔도 숫자가 그대로였던
  // 원인이 스냅샷(기간 내 최신 배치) 선택이었다. cumulative 는 캐시 키에 들어간다.
  const filters = { ...rawFilters, websiteCountry: rawFilters.region, region: undefined, cumulative: true };
  const api: MentionsContext | null = isAnalysisApi("analysis", "website")
    ? { surface: "website", scope: session?.user.scope ?? null }
    : null;

  // 2026-08-27 — 필터바 / 본문 두 경계 (사유는 standard/answer-analysis/mention 주석).
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("tabs.mentions")} />
      <FilterTransitionProvider>
        <Suspense fallback={<FilterBarSkeleton />}>
          <MentionsFilterBar
            filters={filters}
            scope={session?.user.scope}
            extraGroups={extraGroups}
            api={api}
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
            <MentionsData filters={filters} extraGroups={extraGroups} api={api} locale={locale} />
          </Suspense>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

const WEBSITE_ONLY_GROUPS: DimensionGroup[] = ["geography", "language", "engine", "time"];

// 필터바 — 옵션 소스도 데이터 읽기(withWebsite)와 동일하게 브랜드 선택을 반영한다.
// 지역 옵션은 listWebsiteCountries(사이트 국가) — 데이터 읽기가 websiteCountry
// 축으로 좁히므로 옵션·읽기가 같은 소스를 본다(값/선택지 드리프트 방지).
async function MentionsFilterBar({
  filters,
  scope,
  extraGroups,
  api,
  locale,
}: {
  filters: StandardFilters;
  scope?: AllowedScope;
  extraGroups: DimensionGroup[];
  api: MentionsContext | null;
  locale: string;
}) {
  if (api) {
    // F-1 (website: catalog null -> catalogRows undefined; the axes are hidden anyway) + F-2.
    let options: Awaited<ReturnType<typeof loadPanelOptions>>;
    let dates: Awaited<ReturnType<typeof loadFilterDates>>;
    try {
      [options, dates] = await Promise.all([
        afterEssentials(filters, api, () =>
          loadPanelOptions({
            surface: "website",
            dateFrom: filters.dateFrom,
            dateTo: filters.dateTo,
            scope: scope ?? null,
            filters,
          }),
        ),
        loadFilterDates({ surface: "website", family: "mentions" }),
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
          extraGroups={extraGroups}
          onlyGroups={WEBSITE_ONLY_GROUPS}
          primaryGroups={WEBSITE_ONLY_GROUPS}
          asOf={loadMentionsAsOf(filters, api)}
          selectableDates={dates.selectableDates}
        />
        <SectionDoneMarker id="website-mention:filters" />
      </>
    );
  }
  const optionScope = scope ? narrowScopeBrands(scope, filters.brand) : undefined;
  const [catalogRows, geographyOptions, languageOptions, optionMatrix] = await Promise.all([
    listCatalogTaxonomy(),
    listWebsiteCountries(optionScope),
    listMeasuredLanguages(optionScope),
    // 옵션 의존 매트릭스 — 국가 draft 가 언어를 **즉시** 좁히도록(적용 대기 없음).
    listWebsiteScopeMatrix(optionScope),
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
        extraGroups={extraGroups}
        onlyGroups={WEBSITE_ONLY_GROUPS}
        primaryGroups={WEBSITE_ONLY_GROUPS}
        asOf={fetchWebsiteMentions(filters).then((d) => d?.asOf ?? null)}
        // 앵커 축(스펙 §5.1) — 웹사이트 표면의 언급 지면이라 계열은 'mentions'.
        selectableDates={await fetchSelectableAnchorDates("website", filters, "mentions")}
      />
      <SectionDoneMarker id="website-mention:filters" />
    </>
  );
}

async function MentionsData({
  filters,
  extraGroups,
  api,
  locale,
}: {
  filters: StandardFilters;
  extraGroups: DimensionGroup[];
  api: MentionsContext | null;
  locale: string;
}) {
  const session = await getSession();
  let loaded: [
    Awaited<ReturnType<typeof fetchWebsiteMentions>>,
    Awaited<ReturnType<typeof fetchWebsiteSubKpis>>,
    Awaited<ReturnType<typeof fetchWebsiteSubKpisPrev>>,
  ];
  if (api) {
    try {
      loaded = await Promise.all([loadMentionsLive(filters, api), loadSubKpis(filters, api), loadSubKpisPrev(filters, api)]);
    } catch (e) {
      throwForPage(e, locale);
    }
  } else {
    loaded = await Promise.all([
      fetchWebsiteMentions(filters),
      // Sub KPI: website 프로젝트 집합 기준(동일 모집단).
      fetchWebsiteSubKpis(filters),
      fetchWebsiteSubKpisPrev(filters),
    ]);
  }
  const [data, subKpis, prevSubKpis] = loaded;
  return (
    <div className="flex flex-col gap-6">
      <MentionsView
        data={data}
        subKpis={buildMentionSubKpis(subKpis)}
        prevSubKpis={prevSubKpis ? buildMentionSubKpis(prevSubKpis.sub) : null}
        prevBasisDate={prevSubKpis?.asOf ?? null}
        scope={session?.user.scope}
        extraGroups={extraGroups}
        onlyGroups={WEBSITE_ONLY_GROUPS}
        primaryGroups={WEBSITE_ONLY_GROUPS}
        isWebsite
        lazyPrompts
        hideFilterPanel
      />
      <SectionDoneMarker id="website-mention:data" />
    </div>
  );
}
