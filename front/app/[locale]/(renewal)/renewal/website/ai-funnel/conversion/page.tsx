import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { AllowedScope } from "@/lib/auth/types";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import { RnCard, RnPageHeader, RnPill, RnSkeleton, RnTag } from "@/components/renewal-ui";
import { RnDaysPeriod, type RnDaysChoice } from "../../../_components/days-period";
import { RnBusyScope, RnFilterRuntime } from "../../../_components/filter-runtime";
import { loadSavedFilters } from "../../../_components/saved-filters-server";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
} from "../../../_components/overview-filters";
import { ACCOUNT_PAGES } from "@/app/[locale]/(renewal)/_shell/renewal-pages";
import { RnSampleVeil } from "../../../_components/account-gate";
import { RnConvBody } from "../../../standard/ai-funnel/conversion/_components/conv-body";
import { RnConvSample } from "../../../standard/ai-funnel/conversion/_components/conv-sample";
import type { RnConvScreen } from "../../../standard/ai-funnel/conversion/_data/screen-types";

// Renewal Website AI Conversion (2026-10-30, W5) — the redesigned /website/ai-funnel/conversion. The original is
// the Global screen itself (SourceAnalytics kind=conversion): GA4 rows carry no surface, so this page is the
// renewal Global AI Conversion with the same screens (conversion/renewal-header, conversion/renewal), body and
// filters (period + GA4 axes: the property country, not the website's site countries). Only its saved filters are
// its own list (website-conversion). With no GA4 property at all it shows the Global page's sample under the
// "GA4 account needed" veil (2026-11-02, user).

type Sp = Record<string, string | string[] | undefined>;

export default async function RenewalWebsiteConversionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Sp>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.conversion");
  const tw = await getTranslations("renewal.website.conversion");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  let choice: RnDaysChoice;
  try {
    choice = await screenGet<RnDaysChoice>("conversion/renewal-header", sp);
  } catch (e) {
    throwForPage(e, locale);
  }
  const header = (
    <RnPageHeader
      title={
        <>
          {tw("title")}
          <RnTag className="ml-2 align-middle text-rn-11">{t("beta")}</RnTag>
        </>
      }
      meta={
        <>
          <span className="text-rn-13 text-rn-muted">{t("subtitle")}</span>
          <RnPill>
            <CalendarDays className="size-3 text-rn-muted" aria-hidden />
            {t("cadence")}
            <span aria-hidden className="h-3 w-px bg-rn-line-2" />
            <span className="font-semibold tabular-nums text-rn-ink-2">
              {choice.preset != null || choice.days != null ? t("periodDays", { n: choice.preset ?? choice.days ?? 28 }) : t("range", { from: choice.from ?? "…", to: choice.to ?? "…" })}
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
        <RenewalWebsiteConversion sp={sp} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} />
      </Suspense>
    </RnFilterRuntime>
  );
}

async function RenewalWebsiteConversion({ sp, scope, userId, locale, header }: { sp: Sp; scope: AllowedScope; userId: string; locale: string; header: ReactNode }) {
  const t = await getTranslations("renewal.conversion");
  const saved = loadSavedFilters("website-conversion");
  let read: RnConvScreen;
  try {
    read = await screenGet<RnConvScreen>("conversion/renewal", sp);
  } catch (e) {
    throwForPage(e, locale);
  }
  const { body } = read;
  // no GA4 property connected yet: the page on sample data under the veil, filters included (2026-11-02, user)
  const sample = ACCOUNT_PAGES["/website/ai-funnel/conversion"] != null && body.state === "noprop";
  const panel = (
    <RnOverviewFilterPanel
      basis={<RnDaysPeriod choice={body.choice} period={body.period} />}
      axisHelp={{ engine: t("filters.engineHelp"), device: t("filters.deviceHelp"), visitorType: t("filters.visitorTypeHelp") }}
      hint={t("filters.hint")}
    />
  );
  return (
    <RnOverviewFilters props={{ ...read.props, scope }} savedFilters={{ page: "website-conversion", userId, initial: await saved }}>
      <RnFilterSplit header={header} panel={sample ? <RnSampleVeil className="h-full">{panel}</RnSampleVeil> : panel} rail={<RnOverviewFilterRail />}>
        {sample ? (
          <RnConvSample />
        ) : (
          <>
            <RnOverviewApplied />
            <RnBusyScope className="flex flex-col gap-4">
              <RnConvBody input={body} />
            </RnBusyScope>
          </>
        )}
      </RnFilterSplit>
    </RnOverviewFilters>
  );
}

function PageSkeleton({ header }: { header: ReactNode }) {
  return (
    <RnFilterSplit header={header} panel={<RnCard className="h-[480px]" />} rail={<RnCard className="h-24" />}>
      <RnCard className="flex flex-col gap-3 p-6">
        <RnSkeleton className="h-4 w-40" />
        <RnSkeleton className="h-24 w-full" />
      </RnCard>
      <RnCard className="h-[300px]" />
    </RnFilterSplit>
  );
}
