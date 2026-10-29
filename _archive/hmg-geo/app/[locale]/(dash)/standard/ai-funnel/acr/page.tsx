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
import { fetchStandardAcr } from "@/lib/scope/server";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { AnswerAnalysisSkeleton } from "@/components/dash/section-skeleton";
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
  const filters = readStandardFilters(await searchParams, session?.user.scope);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <Suspense fallback={<AnswerAnalysisSkeleton />}>
        <AcrData filters={filters} />
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
      listMeasuredAcrLanguages(optionScope, filters.region),
    ]);
  return (
    <AcrLiveView
      data={data}
      acrPromptCount={acrPromptCount}
      scope={session?.user.scope}
      catalogRows={catalogRows}
      geographyOptions={geographyOptions}
      languageOptions={languageOptions}
    />
  );
}
