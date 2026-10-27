import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { AnswerAnalysisSkeleton } from "@/components/dash/section-skeleton";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import { AcrLiveView } from "../_components/acr-live-view";
import type { AcrScreen } from "../_data/acr-screen";

// 표준 > AI Agent Funnel > ACR — scope 2턴 선택 측정(kind='acr')의 실데이터.
// 기간 의미론(확정 기획 2026-09-16): 필터 없음 = 최신 1회차 스냅샷, 기간 설정 = 그 기간 회차
// 누적 — API 가 from/to 로 가른다. 측정 전에는 대기 상태를 렌더 — 샘플 폴백 없음.
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
  const sp = await searchParams;

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <Suspense fallback={<AnswerAnalysisSkeleton />}>
        <AcrData sp={sp} locale={locale} />
      </Suspense>
    </div>
  );
}

// Screen acr/standard (back/bff/screens/acr.py): the ACR answer, the filter options (catalog rows
// and countries, no period) and the round calendar, read in parallel by the API, with every value
// the view shows already computed.
async function AcrData({ sp, locale }: { sp: Record<string, string | string[] | undefined>; locale: string }) {
  const session = await getSession();
  try {
    const { panel, view } = await screenGet<AcrScreen>("acr/standard", sp);
    return <AcrLiveView vm={view} scope={session?.user.scope} {...panel} />;
  } catch (e) {
    throwForPage(e, locale);
  }
}
