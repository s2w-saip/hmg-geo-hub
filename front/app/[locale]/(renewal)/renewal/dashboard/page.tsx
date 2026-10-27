import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { showsGeoMap } from "@/lib/auth/scope-policy";
import type { AllowedScope } from "@/lib/auth/types";
import { formatAsOfDate } from "@/lib/as-of-date";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import type {
  AsOfView,
  BrandMatrixView,
  CardCompetitorsView,
  CardsView,
  CardTrendView,
  FilterBarView,
  OverviewGeoView,
} from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import {
  DEGRADED_CARD_COMPETITORS,
  DEGRADED_CARD_TREND,
  handled,
  isTransientScreenError,
  onTransient,
} from "@/app/[locale]/(dash)/dashboard/_data/screen-fallbacks";
import { RnCard, RnEmpty, RnNote, RnPageHeader, RnPill, RnSkeleton } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../_components/filter-runtime";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
  type OverviewFilterProps,
} from "../_components/overview-filters";
import { RnOverviewBody } from "./_components/overview-body";

// Renewal Overview (2026-10-20) — the redesigned /dashboard, served side by side with the original.
// Data: the SAME overview screens as /dashboard/page.tsx (back/bff/screens/overview.py), plus the
// renewal-only parts (ctx.view=renewal competitor standing, overview/brand-matrix); only the
// presentation and the filter panel (instant apply + saved filters) differ.
export const maxDuration = 120;

type SP = Record<string, string | string[] | undefined>;

export default async function RenewalDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SP>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  const asOf = screenGet<AsOfView>("overview/as-of", { ...sp, "ctx.surface": "global" })
    .then((v) => v.asOf)
    .catch((e: unknown) => (isTransientScreenError(e) ? null : throwForPage(e, locale)));
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton title={t("overview.title")} />}>
        <RenewalOverview
          sp={sp}
          scope={session.user.scope}
          userId={session.user.id}
          showGeo={showsGeoMap(session.user)}
          locale={locale}
          qs={qsFrom(sp)}
          header={
            <RnPageHeader
              title={t("overview.title")}
              meta={
                <>
                  <span className="text-rn-13 text-rn-muted">{t("subtitle")}</span>
                  <RnPill>
                    <CalendarDays className="size-3 text-rn-muted" aria-hidden />
                    {t("overview.cadence")}
                    <span aria-hidden className="h-3 w-px bg-rn-line-2" />
                    <Suspense fallback={<RnSkeleton className="h-3 w-24" />}>
                      <LastMeasured asOf={asOf} />
                    </Suspense>
                  </RnPill>
                </>
              }
              actions={<RnCopyLinkButton />}
            />
          }
        />
      </Suspense>
    </RnFilterRuntime>
  );
}

async function LastMeasured({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const date = await asOf;
  return <span className="font-semibold tabular-nums text-rn-ink-2">{date ? t("lastMeasured", { date: formatAsOfDate(date) }) : "—"}</span>;
}

// Filter panel options — the same screen as /dashboard's filter bar.
async function filterOptions(scope: AllowedScope, sp: SP, locale: string): Promise<OverviewFilterProps> {
  let v: FilterBarView;
  try {
    v = await screenGet<FilterBarView>("overview/filters", { ...sp, "ctx.surface": "global" });
  } catch (e) {
    throwForPage(e, locale);
  }
  return {
    scope,
    catalogRows: v.catalogRows,
    geographyOptions: v.geographyOptions,
    languageOptions: v.languageOptions,
    optionMatrix: v.optionMatrix,
    collectionStartDay: v.collectionStartDay,
    latestAnchorDay: v.latestAnchorDay,
    selectableDates: v.selectableDates,
  };
}

async function RenewalOverview({
  sp,
  scope,
  userId,
  showGeo,
  locale,
  qs,
  header,
}: {
  sp: SP;
  scope: AllowedScope;
  userId: string;
  showGeo: boolean;
  locale: string;
  qs: string;
  header: ReactNode;
}) {
  const props = await filterOptions(scope, sp, locale);
  return (
    <RnOverviewFilters props={props} storageKey={`rn:saved-filters:v1:overview:${userId}`}>
      <RnFilterSplit header={header} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>
        <RnOverviewApplied />
        <RnBusyScope className="flex flex-col gap-4">
          <Suspense fallback={<BodySkeleton />}>
            <OverviewSection sp={sp} locale={locale} qs={qs} showGeo={showGeo} />
          </Suspense>
        </RnBusyScope>
      </RnFilterSplit>
    </RnOverviewFilters>
  );
}

// The reads of /dashboard's KpiCardsSection + GeoSection (+ the renewal parts), issued together.
async function OverviewSection({ sp, locale, qs, showGeo }: { sp: SP; locale: string; qs: string; showGeo: boolean }) {
  const t = await getTranslations("dashboard");
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  const q: ScreenQuery = sp;
  const trend = handled(onTransient(screenGet<CardTrendView>("overview/card-trend", q), DEGRADED_CARD_TREND));
  const competitors = handled(
    onTransient(screenGet<CardCompetitorsView>("overview/card-competitors", { ...q, "ctx.view": "renewal" }), DEGRADED_CARD_COMPETITORS),
  );
  const matrix = handled(onTransient(screenGet<BrandMatrixView | null>("overview/brand-matrix", q), null));
  const geo = showGeo
    ? handled(
        screenGet<OverviewGeoView>("overview/geo", { ...q, "ctx.locale": locale }).catch((e: unknown) =>
          isTransientScreenError(e) ? { geo: null, degraded: true } : throwForPage(e, locale),
        ),
      )
    : null;
  let view: CardsView;
  try {
    view = await screenGet<CardsView>("overview/cards", q);
  } catch (e) {
    if (!isTransientScreenError(e)) throwForPage(e, locale);
    view = { state: "degraded" };
  }
  if (view.state !== "ok") {
    return (
      <RnCard className="p-6">
        <RnEmpty>{view.state === "degraded" ? tKpi("degraded") : t("empty")}</RnEmpty>
      </RnCard>
    );
  }
  return (
    <>
      <RnOverviewBody
        cards={view.cards}
        compareTitle={view.compareTitle}
        deferred={{ trend, competitors, matrix }}
        geo={geo}
        qs={qs}
      />
      <Suspense fallback={null}>
        <DegradeNote wait={trend.then((v) => v.degraded)} title={t("trend.title")} />
      </Suspense>
      <Suspense fallback={null}>
        <DegradeNote wait={competitors.then((v) => v.degraded.length > 0)} title={t("summary.label")} />
      </Suspense>
      {geo ? (
        <Suspense fallback={null}>
          <DegradeNote wait={geo.then((v) => v.degraded)} title={t("overview.geo.title")} />
        </Suspense>
      ) : null}
    </>
  );
}

// A section that degraded says so instead of looking like "no data" (the payload / a transient
// failure of its screen decides).
async function DegradeNote({ wait, title }: { wait: Promise<boolean>; title: string }) {
  if (!(await wait.catch(() => false))) return null;
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  return (
    <RnNote>
      <b className="font-semibold">{title}</b>
      <span>{tKpi("degraded")}</span>
    </RnNote>
  );
}

function qsFrom(sp: SP): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, one);
  }
  return params.toString();
}

function PageSkeleton({ title }: { title: string }) {
  return (
    <RnFilterSplit header={<RnPageHeader title={title} />} panel={<RnCard className="h-[480px]" />} rail={<RnCard className="h-24" />}>
      <BodySkeleton />
    </RnFilterSplit>
  );
}

function BodySkeleton() {
  return (
    <RnCard className="p-6">
      <RnSkeleton className="mb-4 h-4 w-32" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, i) => (
          <RnSkeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </RnCard>
  );
}
