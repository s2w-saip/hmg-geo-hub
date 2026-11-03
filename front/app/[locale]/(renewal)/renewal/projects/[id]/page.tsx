import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import type { AllowedScope } from "@/lib/auth/types";
import { formatAsOfDate } from "@/lib/as-of-date";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import type { CompositionView, TilesView, WebsiteSummaryView, WebsiteTrendView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { handled, isTransientScreenError, onTransient } from "@/app/[locale]/(dash)/dashboard/_data/screen-fallbacks";
import { RnCard, RnEmpty, RnPageHeader, RnPill, RnSkeleton } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../../_components/filter-runtime";
import { loadSavedFilters } from "../../_components/saved-filters-server";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
} from "../../_components/overview-filters";
import type { WebsiteEnginesView } from "../../website/_overview/website-format";
import { RnProjectDashboardBody, type ProjectStatusView } from "../_components/project-dashboard";
import { projectFilterProps, projectPageSession, projectQuery } from "../_components/project-filters-server";
import { shortId } from "../_components/project-model";

// Renewal Project › Dashboard (2026-11-03, P2): the project tab's first page. The original project Dashboard's KPIs,
// trend and source composition on Gold surface 3 (back/bff/screens/project_dashboard.py projects/dash-*), the website
// Overview's sections laid out for the project, under the project filter panel (기간 · 측정 국가 · AI 엔진 · custom
// tags). Project reads are live only: the round Δ, no period compare, no service week.
export const maxDuration = 120;

type SP = Record<string, string | string[] | undefined>;
type Params = Promise<{ locale: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, id } = await params;
  const [t, tApp] = await Promise.all([getTranslations({ locale, namespace: "nav.projectDetail" }), getTranslations({ locale, namespace: "app" })]);
  return { title: `${t("dashboard")} · ${shortId(id)} · ${tApp("name")}` };
}

export default async function RenewalProjectDashboardPage({ params, searchParams }: { params: Params; searchParams: Promise<SP> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const session = await projectPageSession(locale);
  const [t, tNav] = await Promise.all([getTranslations("renewal.projects.dashboard"), getTranslations("nav.projectDetail")]);
  const sp = await searchParams;
  const q = projectQuery(id, sp);
  const asOf = screenGet<{ asOf: string | null }>("projects/as-of", q)
    .then((v) => v.asOf)
    .catch((e: unknown) => (isTransientScreenError(e) ? null : throwForPage(e, locale)));
  // the body's reads leave with the panel's (the renewal Overview's rule)
  const reads = bodyReads(q, locale);
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton title={tNav("dashboard")} />}>
        <ProjectDashboard
          id={id}
          sp={sp}
          scope={session.user.scope}
          userId={session.user.id}
          reads={reads}
          locale={locale}
          qs={qsFrom(sp)}
          header={
            <RnPageHeader
              title={tNav("dashboard")}
              meta={
                <>
                  <span className="text-rn-13 text-rn-muted">{t("description")}</span>
                  <RnPill>
                    <CalendarDays className="size-3 text-rn-muted" aria-hidden />
                    <Suspense fallback={<RnSkeleton className="h-3 w-24" />}>
                      <AsOf asOf={asOf} />
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

async function AsOf({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const date = await asOf;
  return <span className="font-semibold tabular-nums text-rn-ink-2">{date ? t("lastMeasured", { date: formatAsOfDate(date) }) : "—"}</span>;
}

async function ProjectDashboard({
  id,
  sp,
  scope,
  userId,
  reads,
  locale,
  qs,
  header,
}: {
  id: string;
  sp: SP;
  scope: AllowedScope;
  userId: string;
  reads: BodyReads;
  locale: string;
  qs: string;
  header: ReactNode;
}) {
  const [props, saved] = await Promise.all([projectFilterProps(id, sp, scope, locale), loadSavedFilters("project-dashboard")]);
  return (
    <RnOverviewFilters props={props} savedFilters={{ page: "project-dashboard", userId, initial: saved }}>
      <RnFilterSplit header={header} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>
        <RnOverviewApplied />
        <RnBusyScope className="flex flex-col gap-2.5">
          <Suspense fallback={<BodySkeleton />}>
            <Body id={id} reads={reads} locale={locale} qs={qs} />
          </Suspense>
        </RnBusyScope>
      </RnFilterSplit>
    </RnOverviewFilters>
  );
}

// Every promise has its rejection handler attached at once: the page may fail (filters) before a section awaits. A
// transient failure of a section's screen leaves that section's notice; anything else goes to the page error path.
function bodyReads(q: ScreenQuery, locale: string) {
  const raise = (e: unknown): never => throwForPage(e, locale);
  return {
    summary: handled(screenGet<WebsiteSummaryView>("projects/dash-summary", q)),
    deferredView: handled(screenGet<WebsiteSummaryView>("projects/dash-summary-deferred", q)),
    engines: handled(onTransient<WebsiteEnginesView>(screenGet<WebsiteEnginesView>("projects/dash-engines", q), DEGRADED_ENGINES).catch(raise)),
    trend: handled(onTransient<WebsiteTrendView | "failed">(screenGet<WebsiteTrendView>("projects/dash-trend", q), "failed").catch(raise)),
    composition: handled(
      onTransient<CompositionView>(screenGet<CompositionView>("projects/dash-composition", q), { topics: [], sources: [], degraded: true }).catch(raise),
    ),
    status: handled(onTransient<ProjectStatusView | "failed">(screenGet<ProjectStatusView>("projects/dash-status", q), "failed").catch(raise)),
  };
}
type BodyReads = ReturnType<typeof bodyReads>;

const DEGRADED_ENGINES: WebsiteEnginesView = { engines: [], consistency: {}, extremes: {}, widest: null, degraded: true };

async function Body({ id, reads, locale, qs }: { id: string; reads: BodyReads; locale: string; qs: string }) {
  const t = await getTranslations("dashboard");
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  let view: WebsiteSummaryView;
  try {
    view = await reads.summary;
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
  const tiles = view.tiles;
  // Δ and the engine badge: a transient failure keeps the tiles without them; a 4xx goes to the page error path.
  const deferred: Promise<TilesView> = handled(
    reads.deferredView.then(
      (d) => (d.state === "ok" ? d.tiles : tiles),
      (e: unknown) => (isTransientScreenError(e) ? tiles : throwForPage(e, locale)),
    ),
  );
  return (
    <RnProjectDashboardBody
      id={id}
      tiles={tiles}
      reads={{ deferred, engines: reads.engines, trend: reads.trend, composition: reads.composition, status: reads.status }}
      qs={qs}
    />
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
