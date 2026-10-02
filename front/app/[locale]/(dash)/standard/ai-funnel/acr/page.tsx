import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import {
  listCatalogTaxonomy,
  countStandardAcrPrompts,
} from "@/lib/db/repositories/standards";
import {
  listMeasuredAcrLanguages,
  listMeasuredRegions,
} from "@/lib/db/repositories/scope-aggregates";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import { fetchSelectableAnchorDates, fetchStandardAcr } from "@/lib/scope/server";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { AnswerAnalysisSkeleton } from "@/components/dash/section-skeleton";
import { isAnalysisApi, loadFilterDates, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { loadAcrScreen } from "@/lib/hgh/adapters/funnel";
import { throwForPage } from "@/lib/hgh/errors";
import { AcrLiveView } from "../_components/acr-live-view";

// 표준 > AI Agent Funnel > ACR — scope 2턴 선택 측정(kind='acr')의 실데이터.
// 미러(scope_acr_rollups) SQL 집계를 Suspense 스트리밍으로 로딩 (답변분석
// mention 페이지와 동일 패턴). 측정 전에는 대기 상태를 렌더 — 샘플 폴백 없음.
export default async function AiFunnelAcrPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiFunnelAcr");

  const session = await getSession();
  // 기간 의미론 — 확정 기획(제품 책임자 2026-09-16): 필터 없음 = 최신 1회차 스냅샷,
  // 기간 설정 = 그 기간 회차 전부 누적. 산식 판정 정본은 `cumulativeMode`
  // (lib/db/repositories/scope-aggregates.ts:1087) 하나다.
  //
  // ⚠️ 여기서 `true` 를 상시로 넘기지 않고 **기간 유무로 가르는** 이유는 산식이
  // 아니라 **리더 라우팅** 때문이다 — `lib/summary/read/gate.ts:140` 이
  // `mode === "snapshot" && cumulative === true` 를 미지원 축으로 보고 사실표
  // 리더를 포기하고 미러로 폴백한다. 상시 `true` 면 기간을 안 건 기본 화면까지
  // 매번 미러로 떨어져, 산식은 그대로인데 서빙 경로만 느려진다.
  // #225 가 `website/page.tsx:111` 에 세운 형태와 같다.
  const rawFilters = readStandardFilters(await searchParams, session?.user.scope);
  const filters = {
    ...rawFilters,
    cumulative: Boolean(rawFilters.dateFrom || rawFilters.dateTo),
  };

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <Suspense fallback={<AnswerAnalysisSkeleton />}>
        {isAnalysisApi("funnel", "global") ? (
          <AcrDataApi filters={rawFilters} locale={locale} />
        ) : (
          <AcrData filters={filters} />
        )}
      </Suspense>
    </div>
  );
}

async function AcrData({ filters }: { filters: StandardFilters }) {
  const session = await getSession();
  // 브랜드 선택을 반영한 유효 스코프로 옵션을 좁힌다 (dashboard/page.tsx와 동일).
  const optionScope = session
    ? narrowScopeBrands(session.user.scope, filters.brand)
    : undefined;
  const [data, acrPromptCount, catalogRows, geographyOptions, languageOptions] =
    await Promise.all([
      fetchStandardAcr(filters),
      countStandardAcrPrompts(),
      listCatalogTaxonomy(),
      listMeasuredRegions(
        optionScope,
        undefined,
        true, // 표준(글로벌): 루트 카탈로그로 옵션 제한 — 데이터와 동일 국가 집합
      ),
      // 언어 옵션 (2026-09-03) — 이 화면의 모집단(scope_acr_rollups)에서 낸다.
      // 표준 답변 옵션을 쓰면 ACR 롤업이 없는 언어가 죽은 옵션으로 뜬다(28 vs 21).
      // 적용된 국가(filters.region)까지 넘겨 대시보드와 같은 캐스케이드를 만든다.
      // 기간(dateRange)까지 넘긴다 — 옵션 창과 데이터 창이 같은 회차를 보게 한다
      // (검증 P3: 종전에는 인자가 없어 축 on 에서 항상 최신 회차 하나였다).
      listMeasuredAcrLanguages(optionScope, filters.region, {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      }),
    ]);
  return (
    <AcrLiveView
      data={data}
      acrPromptCount={acrPromptCount}
      scope={session?.user.scope}
      catalogRows={catalogRows}
      geographyOptions={geographyOptions}
      languageOptions={languageOptions}
      // 앵커 축(스펙 §5.1) — 글로벌(standard) 표면. ACR 리더가 run 축 앵커를 쓰므로
      // 달력도 같은 회차 격자여야 한다. 계열은 이 지면의 카드와 같은 'all'.
      selectableDates={await fetchSelectableAnchorDates("global", filters, "all")}
    />
  );
}

// Backend API source (HGH_SOURCE_G4=api, unit U8, lib/hgh/adapters/funnel.ts). Three calls in
// parallel (D6): /v1/funnel/acr (data, catalog ACR count, ACR population languages BG-33),
// /v1/filters/options (catalog rows and countries, no period: the legacy geography list had
// none either) and /v1/filters/dates?family=all (the ACR surface calendar). The period mode
// (snapshot or cumulative) follows from/to on the backend, so `cumulative` is not sent.
async function AcrDataApi({ filters, locale }: { filters: StandardFilters; locale: string }) {
  const session = await getSession();
  const scope = session?.user.scope ?? null;
  try {
    const [acr, options, dates] = await Promise.all([
      loadAcrScreen(filters, { surface: "global", scope }),
      loadPanelOptions({ surface: "global", scope, filters }),
      loadFilterDates({ surface: "global", family: "all" }),
    ]);
    return (
      <AcrLiveView
        data={acr.data}
        acrPromptCount={acr.acrPromptCount}
        scope={session?.user.scope}
        catalogRows={options.catalogRows}
        geographyOptions={options.geographyOptions}
        languageOptions={acr.languageOptions}
        selectableDates={dates.selectableDates}
      />
    );
  } catch (e) {
    throwForPage(e, locale);
  }
}
