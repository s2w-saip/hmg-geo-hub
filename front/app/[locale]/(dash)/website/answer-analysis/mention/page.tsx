import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import type { AllowedScope } from "@/lib/auth/types";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { screenGet } from "@/lib/screen";
import type { FilterDatesView, PanelFilterOptions } from "@/lib/hgh/filter-types";
import { MentionsView } from "../../../standard/answer-analysis/_components/mentions-view";
import { AnalysisFilterBar } from "../../../standard/answer-analysis/_components/analysis-filter-bar";
import type { MentionAsOfScreen, MentionViewScreen } from "../../../standard/answer-analysis/_data/mention-screen";
import { AnswerAnalysisBodySkeleton, FilterBarSkeleton } from "@/components/dash/section-skeleton";
import { FilterTransitionProvider, FilterContentDim } from "@/components/dash/filter-transition";
import { throwForPage } from "@/lib/hgh/errors";

// Data: the mention screens of the API (back/bff/screens/mention_surfaces.py `mention/view`,
// `mention/as-of` with ctx.surface=website) and the shared filter option / calendar screens. The
// page reads the website filters (geography, language, engine, time; + brand for an admin).

type SearchParams = Record<string, string | string[] | undefined>;

export default async function WebsiteAnswerAnalysisMentionPage({
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
  // 2026-07-08 — 웹사이트 브랜드 통합 필터. admin 만 brand 축 노출.
  const admin = session?.user.role === "admin";
  const extraGroups: DimensionGroup[] = admin ? ["brand"] : [];
  const sp = await searchParams;

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("tabs.mentions")} />
      <FilterTransitionProvider>
        <Suspense fallback={<FilterBarSkeleton />}>
          <MentionsFilterBar sp={sp} admin={admin} scope={session?.user.scope} extraGroups={extraGroups} locale={locale} />
        </Suspense>
        {/* 필터 적용 전이 — 필터바와 본문이 같은 transition pending 을 공유한다. */}
        <FilterContentDim>
          <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
            <MentionsData sp={sp} admin={admin} scope={session?.user.scope} extraGroups={extraGroups} locale={locale} />
          </Suspense>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// 웹사이트 분석의 축 구성 — 국가(사이트 국가)·언어·엔진·기간.
const WEBSITE_ONLY_GROUPS: DimensionGroup[] = ["geography", "language", "engine", "time"];

/** The page's URL params the website filters read (the panel narrows by the brand only for an admin). */
function websiteParams(sp: SearchParams, admin: boolean): SearchParams {
  const keys = [...WEBSITE_ONLY_GROUPS, ...(admin ? ["brand"] : [])];
  return Object.fromEntries(Object.entries(sp).filter(([k]) => keys.includes(k)));
}

async function MentionsFilterBar({
  sp,
  admin,
  scope,
  extraGroups,
  locale,
}: {
  sp: SearchParams;
  admin: boolean;
  scope?: AllowedScope;
  extraGroups: DimensionGroup[];
  locale: string;
}) {
  let options: PanelFilterOptions;
  let dates: FilterDatesView;
  try {
    [options, dates] = await Promise.all([
      screenGet<PanelFilterOptions>("shared/panel-options", { ...websiteParams(sp, admin), surface: "website" }),
      screenGet<FilterDatesView>("shared/filter-dates", { surface: "website", family: "mentions" }),
    ]);
  } catch (e) {
    throwForPage(e, locale);
  }
  const ctx = { "ctx.surface": "website", ...(admin ? { "ctx.admin": "true" } : {}) };
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
        asOf={screenGet<MentionAsOfScreen>("mention/as-of", { ...sp, ...ctx }).then((d) => d.asOf)}
        selectableDates={dates.selectableDates ?? undefined}
      />
      <SectionDoneMarker id="website-mention:filters" />
    </>
  );
}

// 본문 — 언급 집계와 Sub KPI 를 기다린 뒤 MentionsView 한 장(필터바는 위 경계).
async function MentionsData({
  sp,
  admin,
  scope,
  extraGroups,
  locale,
}: {
  sp: SearchParams;
  admin: boolean;
  scope?: AllowedScope;
  extraGroups: DimensionGroup[];
  locale: string;
}) {
  let vm: MentionViewScreen;
  try {
    vm = await screenGet<MentionViewScreen>("mention/view", { ...sp, "ctx.surface": "website", ...(admin ? { "ctx.admin": "true" } : {}) });
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <div className="flex flex-col gap-6">
      <MentionsView
        vm={vm}
        compareSource={{ surface: "website", admin }}
        scope={scope}
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
