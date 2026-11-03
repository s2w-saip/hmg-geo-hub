import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import type { AllowedScope } from "@/lib/auth/types";
import { throwForPage } from "@/lib/hgh/errors";
import { screenGet } from "@/lib/screen";
import { RnCard, RnPageHeader, RnPill, RnSkeleton, RnTag } from "@/components/renewal-ui";
import { ACCOUNT_PROJECT_PAGES } from "@/app/[locale]/(renewal)/_shell/renewal-pages";
import { RnDaysPeriod, type RnDaysChoice } from "../../../../_components/days-period";
import { RnBusyScope, RnFilterRuntime } from "../../../../_components/filter-runtime";
import { loadSavedFilters } from "../../../../_components/saved-filters-server";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
} from "../../../../_components/overview-filters";
import { RnSampleVeil } from "../../../../_components/account-gate";
import { RnConvBody } from "../../../../standard/ai-funnel/conversion/_components/conv-body";
import { RnConvSample } from "../../../../standard/ai-funnel/conversion/_components/conv-sample";
import type { RnConvScreen } from "../../../../standard/ai-funnel/conversion/_data/screen-types";
import { projectPageSession, projectQuery } from "../../../_components/project-filters-server";
import { shortId } from "../../../_components/project-model";

// Renewal Project › AI Agent Funnel › AI Conversion (2026-11-03, P5): the renewal AI Conversion body on the project's GA4
// properties — conversion/renewal with ctx.project_id reads only the properties the HUB analytics reader maps to the
// project (analytics_reader.conversion: the project row's site brand and country = the property's). GA4 rows carry no
// surface, so the body, filters (period + GA4 axes) and states are the Global page's. With no property for the project
// (none is registered before the GA4 account is handed over, U4; Gold's project rows carry no brand or country to map)
// it shows the sample under the "GA4 account needed" veil, as the other AI Conversion pages (2026-11-02, user).

type Sp = Record<string, string | string[] | undefined>;
type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "nav.projectDetail" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("aiFunnelConversion")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectConversionPage({ params, searchParams }: { params: Params; searchParams: Promise<Sp> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const session = await projectPageSession(locale);
  const t = await getTranslations("renewal.conversion");
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
          {t("title")}
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
        <ProjectConversion id={id} sp={sp} scope={session.user.scope} userId={session.user.id} locale={locale} header={header} />
      </Suspense>
    </RnFilterRuntime>
  );
}

async function ProjectConversion({ id, sp, scope, userId, locale, header }: { id: string; sp: Sp; scope: AllowedScope; userId: string; locale: string; header: ReactNode }) {
  const t = await getTranslations("renewal.conversion");
  const saved = loadSavedFilters("project-conversion");
  let read: RnConvScreen;
  try {
    read = await screenGet<RnConvScreen>("conversion/renewal", projectQuery(id, sp));
  } catch (e) {
    throwForPage(e, locale);
  }
  const { body } = read;
  // no GA4 property for the project yet: the page on sample data under the veil, filters included
  const sample = ACCOUNT_PROJECT_PAGES["ai-funnel/conversion"] != null && body.state === "noprop";
  const panel = (
    <RnOverviewFilterPanel
      basis={<RnDaysPeriod choice={body.choice} period={body.period} />}
      axisHelp={{ engine: t("filters.engineHelp"), device: t("filters.deviceHelp"), visitorType: t("filters.visitorTypeHelp") }}
      hint={t("filters.hint")}
    />
  );
  return (
    <RnOverviewFilters props={{ ...read.props, scope }} savedFilters={{ page: "project-conversion", userId, initial: await saved }}>
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
