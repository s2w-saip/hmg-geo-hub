import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { showsGeoMap } from "@/lib/auth/scope-policy";
import type { AllowedScope } from "@/lib/auth/types";
import { formatAsOfDate } from "@/lib/as-of-date";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import {
  listMeasuredRegions,
  listMeasuredScopeMatrix,
  listMeasuredStandardLanguages,
  standardCollectionDates,
} from "@/lib/db/repositories/scope-aggregates";
import {
  fetchLatestAnchorDay,
  fetchPeriodCompare,
  fetchSelectableAnchorDates,
  fetchStandardAggregates,
  fetchStandardCompetitorSources,
  wasDegraded,
} from "@/lib/scope/server";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { OVERVIEW_COMPARE_METRICS } from "@/components/dash/period-delta-metrics";
import { kstToday } from "@/components/dash/selectable-dates";
import { resolveRequestComparePeriodShape } from "@/lib/period/compare-shape";
import { isAnalysisApi, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { fetchPeriodCompareApi } from "@/lib/hgh/adapters/compare";
import { throwForPage } from "@/lib/hgh/errors";
import {
  afterFirstRender,
  isTransientApiFailure,
  loadCompetitorSources,
  loadDashboardAsOf,
  loadEssentialFilterDates,
  orNullOnTransient,
  type DashboardCtx,
} from "@/lib/hgh/adapters/dashboard";
import { markDegraded } from "@/lib/scope/degrade-registry";
import {
  applyTrendDeltas,
  deltaTrendFilters,
  DELTA_TREND_BUCKET,
  getLiveDashboard,
  getLiveGeo,
  getLiveTrend,
  sparklineTrend,
} from "@/app/[locale]/(dash)/dashboard/_data/live";
import { COMPETITOR_LABELS, EXTRAS_LABELS } from "@/app/[locale]/(dash)/dashboard/_components/degrade-notice";
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

// Renewal Overview (2026-10-20) — the redesigned /dashboard, served side by side with
// the original for comparison. Data: the SAME reads as /dashboard/page.tsx (both the
// legacy path and the HGH_SOURCE_G1=api path), issued in the same order; only the
// presentation and the filter panel (instant apply + saved filters) differ.
// Keep the reads below in step with /dashboard/page.tsx.
export const maxDuration = 120;

const G1 = { surface: "global" as const };
const g1Api = () => isAnalysisApi("dashboard", "global");
const GEO_LABELS = ["standardGeoCompetition"] as const;

export default async function RenewalDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  // 기간 의미론 = /dashboard: 필터 없음 = 최신 1회차 스냅샷, 기간 설정 = 그 기간 회차 누적.
  const rawFilters = readStandardFilters(sp, session.user.scope);
  const filters = { ...rawFilters, cumulative: Boolean(rawFilters.dateFrom || rawFilters.dateTo) };
  const asOf = g1Api()
    ? orNullOnTransient(loadDashboardAsOf(filters, { ...G1, scope: session.user.scope })).catch((e: unknown) => throwForPage(e, locale))
    : fetchStandardAggregates(filters).then((d) => d?.asOf ?? null);
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton title={t("overview.title")} />}>
        <RenewalOverview
          filters={filters}
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
                  <span className="w-full text-rn-13 text-rn-muted">{t("subtitle")}</span>
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

// Filter panel options — the same reads as /dashboard's OverviewFiltersSection(Api).
async function filterOptions(scope: AllowedScope, filters: StandardFilters, locale: string): Promise<OverviewFilterProps> {
  if (g1Api()) {
    const ctx: DashboardCtx = { ...G1, scope };
    try {
      const [options, dates] = await Promise.all([
        afterFirstRender(filters, ctx, () =>
          loadPanelOptions({ surface: "global", scope, filters, dateFrom: filters.dateFrom, dateTo: filters.dateTo }),
        ),
        loadEssentialFilterDates(ctx),
      ]);
      return {
        scope,
        catalogRows: options.catalogRows,
        geographyOptions: options.geographyOptions,
        languageOptions: options.languageOptions,
        optionMatrix: options.optionMatrix,
        collectionStartDay: dates?.collectionStartDay ?? null,
        latestAnchorDay: dates?.latestAnchorDay ?? null,
        selectableDates: dates?.selectableDates,
      };
    } catch (e) {
      throwForPage(e, locale);
    }
  }
  const optionScope = narrowScopeBrands(scope, filters.brand);
  const dateRange = { dateFrom: filters.dateFrom, dateTo: filters.dateTo };
  const [catalogRows, geographyOptions, languageOptions, optionMatrix, collection, latestAnchorDay, selectableDates] = await Promise.all([
    listCatalogTaxonomy(),
    listMeasuredRegions(optionScope, undefined, true, dateRange),
    listMeasuredStandardLanguages(optionScope, undefined, dateRange),
    listMeasuredScopeMatrix(scope, dateRange),
    standardCollectionDates(scope).catch(() => null),
    fetchLatestAnchorDay("global", filters),
    fetchSelectableAnchorDates("global", filters, "all"),
  ]);
  return {
    scope,
    catalogRows,
    geographyOptions,
    languageOptions,
    optionMatrix,
    collectionStartDay: collection?.firstMeasuredAt?.toISOString() ?? null,
    latestAnchorDay,
    selectableDates,
  };
}

async function RenewalOverview({
  filters,
  scope,
  userId,
  showGeo,
  locale,
  qs,
  header,
}: {
  filters: StandardFilters;
  scope: AllowedScope;
  userId: string;
  showGeo: boolean;
  locale: string;
  qs: string;
  header: ReactNode;
}) {
  const props = await filterOptions(scope, filters, locale);
  return (
    <RnOverviewFilters props={props} storageKey={`rn:saved-filters:v1:overview:${userId}`}>
      <RnFilterSplit header={header} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>
        <RnOverviewApplied />
        <RnBusyScope className="flex flex-col gap-4">
          <Suspense fallback={<BodySkeleton />}>
            <OverviewSection filters={filters} locale={locale} qs={qs} showGeo={showGeo} />
          </Suspense>
        </RnBusyScope>
      </RnFilterSplit>
    </RnOverviewFilters>
  );
}

// The KPI reads of /dashboard's KpiCardsSection + GeoSection, issued together.
async function OverviewSection({ filters, locale, qs, showGeo }: { filters: StandardFilters; locale: string; qs: string; showGeo: boolean }) {
  const t = await getTranslations("dashboard");
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  const api = g1Api();
  const livePromise = getLiveDashboard(filters);
  const deltaTrend = handled(getLiveTrend(api ? filters : deltaTrendFilters(filters), DELTA_TREND_BUCKET));
  const weeklyTrend = api ? deltaTrend : handled(getLiveTrend(filters, "week"));
  const session = api ? await getSession() : null;
  const ctx: DashboardCtx = { ...G1, scope: session?.user.scope ?? null };
  const competitors = handled(
    api
      ? afterFirstRender(filters, ctx, () => loadCompetitorSources(filters, ctx, { onFailure: (label, e) => onTransient(label, e) }))
      : fetchStandardCompetitorSources(filters),
  );
  const geo = showGeo ? handled(api ? getLiveGeo(filters).catch((e: unknown) => throwForPage(e, locale)) : getLiveGeo(filters)) : null;
  const shape = await resolveRequestComparePeriodShape(filters.dateFrom, filters.dateTo, { area: "dashboard", surface: "global" });
  const periodCompare = api
    ? await afterFirstRender(filters, ctx, () =>
        orNullOnTransient(fetchPeriodCompareApi(filters, { ...ctx, kind: shape.kind, metrics: OVERVIEW_COMPARE_METRICS })),
      ).catch((e: unknown) => throwForPage(e, locale))
    : await fetchPeriodCompare(filters, {
        surface: "global",
        family: "mention",
        kind: shape.kind,
        metrics: OVERVIEW_COMPARE_METRICS,
        ...(shape.months ? { months: shape.months } : {}),
        ...(shape.weeks ? { weeks: shape.weeks } : {}),
      });
  const live = api ? await livePromise.catch((e: unknown) => throwForPage(e, locale)) : await livePromise;
  if (!live) {
    return (
      <RnCard className="p-6">
        <RnEmpty>{wasDegraded("standardAggregates") ? tKpi("degraded") : t("empty")}</RnEmpty>
      </RnCard>
    );
  }
  const deltas = handled(deltaTrend.then((d) => applyTrendDeltas(live.kpis, d)));
  const trend = handled(weeklyTrend.then(sparklineTrend));
  // brand-scoped accounts carry the HMG umbrella in filters.brand (readStandardFilters);
  // it is a prompt tag, not a brand, so it stays out of the own-row label
  const ownBrands = (filters.brand ?? []).filter((b) => b !== UMBRELLA_BRAND);
  const ownLabel = ownBrands.length ? ownBrands.join(", ") : UMBRELLA_BRAND;
  return (
    <>
      <RnOverviewBody
        kpis={live.kpis}
        deferred={{ deltas, trend, competitors }}
        periodCompare={periodCompare}
        periodDays={shape.days ?? undefined}
        periodLabelCtx={{ kind: shape.kind, curLo: shape.weeks?.cur.lo ?? shape.months?.cur.lo ?? filters.dateFrom, todayKst: kstToday() }}
        geo={geo}
        ownLabel={ownLabel}
        qs={qs}
      />
      <Suspense fallback={null}>
        <DegradeNote wait={Promise.all([deltas, trend])} labels={EXTRAS_LABELS} title={t("trend.title")} />
      </Suspense>
      <Suspense fallback={null}>
        <DegradeNote wait={competitors} labels={COMPETITOR_LABELS} title={t("summary.label")} />
      </Suspense>
      {geo ? (
        <Suspense fallback={null}>
          <DegradeNote wait={geo} labels={GEO_LABELS} title={t("overview.geo.title")} />
        </Suspense>
      ) : null}
    </>
  );
}

// Budget-exceeded reads arrive as null / empty — say so instead of looking like "no data"
// (same request-scope marker as /dashboard's DegradeNotice).
async function DegradeNote({ wait, labels, title }: { wait: Promise<unknown>; labels: readonly string[]; title: string }) {
  await wait.catch(() => null);
  if (!labels.some((l) => wasDegraded(l))) return null;
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  return (
    <RnNote>
      <b className="font-semibold">{title}</b>
      <span>{tKpi("degraded")}</span>
    </RnNote>
  );
}

function onTransient(label: string, e: unknown): void {
  if (!isTransientApiFailure(e)) throw e;
  markDegraded(label);
}

// Attach a rejection handler before anyone awaits (an early failure must not crash the process).
function handled<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

function qsFrom(sp: Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, one);
  }
  return params.toString();
}

function PageSkeleton({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-5">
      <RnPageHeader title={title} />
      <div className="grid items-start gap-5 grid-cols-[52px_minmax(0,1fr)] min-[1360px]:grid-cols-[296px_minmax(0,1fr)]">
        <RnCard className="hidden h-[480px] min-[1360px]:block" />
        <RnCard className="h-24 min-[1360px]:hidden" />
        <div className="flex min-w-0 flex-col gap-4">
          <BodySkeleton />
        </div>
      </div>
    </div>
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
