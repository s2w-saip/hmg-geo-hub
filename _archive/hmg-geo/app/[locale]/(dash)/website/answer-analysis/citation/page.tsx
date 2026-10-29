import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { fetchWebsiteCitations, fetchWebsiteTargetHitRate } from "@/lib/scope/server";
import { getSession } from "@/lib/auth/session";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import {
  listMeasuredLanguages,
  listWebsiteCountries,
  listWebsiteScopeMatrix,
} from "@/lib/db/repositories/website-sites";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import type { AllowedScope } from "@/lib/auth/types";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { DimensionGroup } from "@/components/dash/dimension-filter-panel";
import { readStandardFilters } from "@/components/dash/standard-filters";
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

// 웹사이트 > 답변 분석 > 인용 — 표준 CitationsView 재사용. 축은 웹사이트 전용:
// geography + language + engine (admin 은 brand 통합 추가). 표준 카탈로그 축은
// 웹사이트 프롬프트에 태깅이 없어 숨김. 데이터는 website 전용 프로젝트
// (fetchWebsiteCitations) — Overview와 동일 모집단(2026-07-06 교체).
// source(출처 카테고리)는 도메인에서 파생되는 축이라 프롬프트 태깅과 무관하게
// 성립 — 세 인용 화면(표준/웹사이트/프로젝트) 공통으로 연다.
const WEBSITE_ONLY_GROUPS: DimensionGroup[] = ["geography", "language", "engine", "time", "source"];
export default async function WebsiteAnswerAnalysisCitationPage({
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
  const extraGroups: DimensionGroup[] =
    session?.user.role === "admin" ? ["brand"] : [];
  // 노출 축을 readStandardFilters 에도 전달 — 숨은 축 URL 파라미터 누수 방지.
  const rawFilters = readStandardFilters(await searchParams, session?.user.scope, [
    ...WEBSITE_ONLY_GROUPS,
    ...extraGroups,
  ]);
  // website 의 지역 축은 website_sites.country_code(사이트 국가)다 — 개요 화면
  // (website/page.tsx)이 이미 그렇게 읽는다. readStandardFilters 는 ?geography= 를
  // scope_answers.region(측정 로케일)으로 파싱하므로 여기서 websiteCountry 로 이식한다.
  // 이 이식이 빠져 있어 개요에서 "글로벌"(worldwide) 을 고르고 넘어오면 region IN
  // ('worldwide') 이 되어 0건이 됐다 — worldwide 사이트의 답변 region 은 KR/US 다.
  // 2026-09-04 기획 수정 — 답변분석은 '기간 내 누적' 의미론을 쓴다(대시보드·
  // 웹사이트 KPI 의 스냅샷과 구분). 기간을 7일/30일로 바꿔도 숫자가 그대로였던
  // 원인이 스냅샷(기간 내 최신 배치) 선택이었다. cumulative 는 캐시 키에 들어간다.
  const filters = { ...rawFilters, websiteCountry: rawFilters.region, region: undefined, cumulative: true };

  // 2026-08-27 — 필터바 / 본문 두 경계 (사유는 standard/answer-analysis/mention 주석).
  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("tabs.citations")} />
      <FilterTransitionProvider>
        <Suspense fallback={<FilterBarSkeleton />}>
          <CitationsFilterBar
            filters={filters}
            scope={session?.user.scope}
            extraGroups={extraGroups}
          />
        </Suspense>
        {/* 필터 적용 전이 — 필터바와 본문이 같은 transition pending 을 공유한다.
            어느 경계도 re-key 하지 않으므로(이전 결과 유지) 적용 중 화면은 옛
            필터의 숫자를 그대로 보여준다 → FilterContentDim 으로 본문을 흐리고
            "재조회 중" 필을 띄워야 옛 결과를 새 결과로 오독하지 않는다
            (dashboard/page.tsx 와 동일한 짝). */}
        <FilterContentDim>
          <Suspense fallback={<AnswerAnalysisBodySkeleton />}>
            <CitationsData filters={filters} extraGroups={extraGroups} />
          </Suspense>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

// 필터바 — 옵션 소스도 데이터 읽기와 동일하게 브랜드 선택 반영 (mention 페이지와 동일).
// 지역 옵션은 listWebsiteCountries(사이트 국가) — 읽기가 websiteCountry 축으로
// 좁히므로 옵션·읽기가 같은 소스를 본다(값/선택지 드리프트 방지).
async function CitationsFilterBar({
  filters,
  scope,
  extraGroups,
}: {
  filters: StandardFilters;
  scope?: AllowedScope;
  extraGroups: DimensionGroup[];
}) {
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
        stage="citations"
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        languageOptions={languageOptions}
        optionMatrix={optionMatrix}
        extraGroups={extraGroups}
        onlyGroups={WEBSITE_ONLY_GROUPS}
        primaryGroups={WEBSITE_ONLY_GROUPS}
        asOf={fetchWebsiteCitations(filters).then((d) => d?.asOf ?? null)}
      />
      <SectionDoneMarker id="website-citation:filters" />
    </>
  );
}

async function CitationsData({
  filters,
  extraGroups,
}: {
  filters: StandardFilters;
  extraGroups: DimensionGroup[];
}) {
  const session = await getSession();
  // 타겟 URL 인용률(프롬프트 단위)은 출처 카테고리 축과 결합할 수 없다 — 분류가
  // 인용 행 단위 JS 파생이라 SQL 프롬프트 판정에 못 싣는다. 같은 이유로 promptSplit
  // 도 이 축이 켜지면 계산을 건너뛴다(scope-aggregates::wantSplit). 카드는 남기고
  // 값만 "—" 로 두어(rate null) 필터 때문에 비었다는 것이 툴팁에서 읽히게 한다.
  const targetHitApplicable = !filters.sourceCategory?.length;
  const [data, targetHitRate] = await Promise.all([
    fetchWebsiteCitations(filters),
    targetHitApplicable
      ? fetchWebsiteTargetHitRate(filters)
      : Promise.resolve({ hitPrompts: 0, measuredPrompts: 0, rate: null }),
  ]);
  return (
    <>
      <CitationsView
        data={data}
        scope={session?.user.scope}
        extraGroups={extraGroups}
        onlyGroups={WEBSITE_ONLY_GROUPS}
        primaryGroups={WEBSITE_ONLY_GROUPS}
        targetHitRate={targetHitRate}
        hideFilterPanel
      />
      <SectionDoneMarker id="website-citation:data" />
    </>
  );
}
