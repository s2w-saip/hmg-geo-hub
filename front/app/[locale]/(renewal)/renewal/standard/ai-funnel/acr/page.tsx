import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { AllowedScope } from "@/lib/auth/types";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import { RnCard, RnPageHeader, RnPill, RnSkeleton, RnTag } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../../../_components/filter-runtime";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
} from "../../../_components/overview-filters";
import { RnAcrBody } from "./_components/acr-body";
import type { RnAcrHeader, RnAcrScreen } from "./_data/screen-types";

// Renewal ACR (2026-10-21) — the redesigned /standard/ai-funnel/acr, served side by side
// with the original. Data: screen acr/renewal (back/bff/screens/acr.py) = the same three reads as
// acr/page.tsx (ACR answer, filter options, round calendar) and the whole view model; the header's
// period pill comes from acr/renewal-header (URL only, no reads).

type Sp = Record<string, string | string[] | undefined>;

export default async function RenewalAcrPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Sp>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.acr");
  const tPage = await getTranslations("aiFunnelAcr");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  // 기간 의미론 = acr/page.tsx: 필터 없음 = 최신 1회차 스냅샷, 기간 설정 = 그 기간 회차 누적.
  let head: RnAcrHeader;
  try {
    head = await screenGet<RnAcrHeader>("acr/renewal-header", sp);
  } catch (e) {
    throwForPage(e, locale);
  }
  const header = (
    <RnPageHeader
      title={
        <>
          {t("title")}
          <RnTag className="ml-2 align-middle text-rn-11">{t("beta")}</RnTag>
        </>
      }
      meta={
        <>
          <span className="text-rn-13 text-rn-muted">{tPage("subtitle")}</span>
          <RnPill>
            <CalendarDays className="size-3 text-rn-muted" aria-hidden />
            {t("cadence")}
            <span aria-hidden className="h-3 w-px bg-rn-line-2" />
            <span className="font-semibold tabular-nums text-rn-ink-2">
              {head.period ? t("periodRange", { from: head.dateFrom ?? "…", to: head.dateTo ?? "…" }) : t("snapshot")}
            </span>
          </RnPill>
        </>
      }
      actions={<RnCopyLinkButton />}
    />
  );
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton header={header} />}>
        <RenewalAcr sp={sp} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} />
      </Suspense>
    </RnFilterRuntime>
  );
}

async function RenewalAcr({
  sp,
  scope,
  userId,
  locale,
  header,
}: {
  sp: Sp;
  scope: AllowedScope;
  userId: string;
  locale: string;
  header: ReactNode;
}) {
  let read: RnAcrScreen;
  try {
    read = await screenGet<RnAcrScreen>("acr/renewal", sp);
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <RnOverviewFilters props={{ ...read.props, scope }} storageKey={`rn:saved-filters:v1:acr:${userId}`}>
      <RnFilterSplit header={header} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>
        <RnOverviewApplied />
        <RnBusyScope className="flex flex-col gap-4">
          <RnAcrBody input={read.body} />
        </RnBusyScope>
      </RnFilterSplit>
    </RnOverviewFilters>
  );
}

function PageSkeleton({ header }: { header: ReactNode }) {
  return (
    <RnFilterSplit header={header} panel={<RnCard className="h-[480px]" />} rail={<RnCard className="h-24" />}>
      <RnCard className="h-12" />
      <RnCard className="flex flex-col gap-3 p-6">
        <RnSkeleton className="h-4 w-40" />
        <RnSkeleton className="h-16 w-full" />
      </RnCard>
      <RnCard className="h-[320px]" />
    </RnFilterSplit>
  );
}
