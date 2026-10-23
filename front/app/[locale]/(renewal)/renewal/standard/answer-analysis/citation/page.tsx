import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { AllowedScope } from "@/lib/auth/types";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import {
  listMeasuredRegions,
  listMeasuredScopeMatrix,
  listMeasuredStandardLanguages,
  standardCollectionDates,
} from "@/lib/db/repositories/scope-aggregates";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import {
  fetchLatestAnchorDay,
  fetchPeriodCompare,
  fetchSelectableAnchorDates,
  fetchStandardCitationCategoriesPrev,
  fetchStandardCitationToneSummary,
  fetchStandardCitationTypeCategories,
  fetchStandardCitations,
  fetchStandardOverviewCardDelta,
  wasDegraded,
} from "@/lib/scope/server";
import { wasDegraded as wasDegradedInRequest } from "@/lib/scope/degrade-registry";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { splitFilterValues } from "@/components/dash/filter-encoding";
import { CITATION_COMPARE_METRICS } from "@/components/dash/period-delta-metrics";
import { kstToday } from "@/components/dash/selectable-dates";
import { resolveRequestComparePeriodShape } from "@/lib/period/compare-shape";
import { toPeriodDeltaView, type PeriodDeltaView } from "@/lib/kpi/period-compare-view";
import { throwForPage } from "@/lib/hgh/errors";
import { loadFilterDates, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import {
  afterCitationEssentials,
  citationRouteQuery,
  citationsDegraded,
  isCitationsApi,
  loadCitationDeltas,
  loadCitationPeriodCompare,
  loadCitationSourceParts,
  loadCitationsAsOf,
  loadCitationsView,
  type CitationsContext,
} from "@/lib/hgh/adapters/citations";
import { competitorDomainOptions } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { STANDARD_CITATION_V2_ONLY_GROUPS } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/filter-groups";
import { RnCard, RnPageHeader, RnPill, RnSkeleton, RnTag } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../../../_components/filter-runtime";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
  type OverviewFilterProps,
} from "../../../_components/overview-filters";
import type { RnCitationInput } from "./_components/citation-input";
import { RnCitationBody } from "./_components/citation-body";
import { RnCitationDensityProvider, RnCitationDensityToggle } from "./_components/citation-density";

// Renewal Citation (2026-10-21) — the redesigned /standard/answer-analysis/citation, served side
// by side with the original. Data: the SAME reads as citation/page.tsx on both sources (legacy
// readers and HGH_SOURCE_G2=api adapters, same arguments), handed to the client body as promises.
// Keep the reads below in step with /standard/answer-analysis/citation/page.tsx.

export const maxDuration = 120;

const CITATION_AXES = ["brand", ...STANDARD_CITATION_V2_ONLY_GROUPS] as const;

interface CitationApi {
  ctx: CitationsContext;
  /** ?competitor= picks (the backend applies them to the domain rows, BG-20) */
  competitor: string[];
  /** filter params the client table and drilldown send to /api/citations/domains* */
  tableQuery: string;
}

export default async function RenewalCitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.citation");
  const tPage = await getTranslations("answerAnalysis");
  const tOv = await getTranslations("dashboard.overview");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  // 기간 의미론 = citation/page.tsx: answer analysis reads cumulative within a picked period
  const filters = { ...readStandardFilters(sp, session.user.scope), cumulative: true };
  const api: CitationApi | null = isCitationsApi("global")
    ? {
        ctx: { surface: "global", scope: session.user.scope ?? null },
        competitor: splitFilterValues(sp.competitor),
        tableQuery: citationRouteQuery(sp, { surface: "global" }),
      }
    : null;
  const filtered = CITATION_AXES.some((k) => sp[k] != null && sp[k] !== "");
  const period = filters.dateFrom || filters.dateTo ? { from: filters.dateFrom ?? null, to: filters.dateTo ?? null } : null;
  const asOf = api ? loadCitationsAsOf(filters, api.ctx, api.competitor) : fetchStandardCitations(filters).then((d) => d?.asOf ?? null);

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
          <span className="text-rn-13 text-rn-muted">{tPage("citations.description")}</span>
          <RnPill>
            <CalendarDays className="size-3 text-rn-muted" aria-hidden />
            {tOv("cadence")}
            <span aria-hidden className="h-3 w-px bg-rn-line-2" />
            <span className="font-semibold tabular-nums text-rn-ink-2">
              {period ? (
                t("periodRange", { from: period.from ?? "…", to: period.to ?? "…" })
              ) : (
                <Suspense fallback="…">
                  <AsOfText asOf={asOf} />
                </Suspense>
              )}
            </span>
          </RnPill>
        </>
      }
      actions={
        <>
          <RnCitationDensityToggle />
          <RnCopyLinkButton />
        </>
      }
    />
  );
  const body: RnCitationInput = {
    api: Boolean(api),
    period,
    filtered,
    ...(api ? apiReads(filters, api, locale) : legacyReads(filters)),
  };
  return (
    <RnFilterRuntime>
      <RnCitationDensityProvider>
        <Suspense fallback={<PageSkeleton header={header} />}>
          <RenewalCitation filters={filters} scope={session.user.scope} userId={session.user.id} api={api} locale={locale} header={header} body={body} />
        </Suspense>
      </RnCitationDensityProvider>
    </RnFilterRuntime>
  );
}

async function AsOfText({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const day = await asOf.catch(() => null);
  return <>{day ? t("lastMeasured", { date: day.slice(0, 10) }) : "—"}</>;
}

type Reads = Omit<RnCitationInput, "api" | "period" | "filtered">;

// Legacy: citation/page.tsx CitationsBody (CitationsStandardView props + the month line).
function legacyReads(filters: StandardFilters): Reads {
  const data = fetchStandardCitations(filters);
  return {
    data,
    // "데이터 없음" vs "예산 초과" — valid only after that read settled, so chained on it
    dataDegraded: data.then(() => wasDegraded("standardCitations")),
    sectionDegraded: Promise.resolve(null),
    officialDelta: fetchStandardOverviewCardDelta(filters, "citationShare"),
    prevCategories: fetchStandardCitationCategoriesPrev(filters),
    typeCategories: fetchStandardCitationTypeCategories(filters),
    toneSummary: fetchStandardCitationToneSummary(filters),
    tableSource: Promise.resolve(null),
    // the "전월 대비" line only for a calendar month (family citation: hidden_scope rounds stay out)
    periodView: (async (): Promise<PeriodDeltaView | null> => {
      const shape = await resolveRequestComparePeriodShape(filters.dateFrom, filters.dateTo);
      if (!shape.months) return null;
      const compare = await fetchPeriodCompare(filters, { surface: "global", family: "citation", kind: shape.kind, metrics: CITATION_COMPARE_METRICS, months: shape.months });
      return monthView(compare, shape, filters);
    })(),
  };
}

// API: citation/page.tsx CitationsBodyApi (same adapters; the D6 essentials go first inside them).
function apiReads(filters: StandardFilters, api: CitationApi, locale: string): Reads {
  const view = loadCitationsView(filters, api.ctx, api.competitor);
  const deltas = loadCitationDeltas(filters, api.ctx, api.competitor);
  const parts = loadCitationSourceParts(filters, api.ctx);
  return {
    data: view.then((v) => v.live),
    dataDegraded: view.then(() => wasDegradedInRequest("standardCitations")),
    sectionDegraded: view.then(() => citationsDegraded("global")),
    officialDelta: deltas.then((d) => d.officialDelta),
    prevCategories: deltas.then((d) => d.prevCategories),
    typeCategories: parts.then((p) => p.typeCategories),
    toneSummary: parts.then((p) => p.toneSummary),
    tableSource: view.then((v) => (v.table ? { query: api.tableQuery, ...v.table } : null)),
    periodView: (async (): Promise<PeriodDeltaView | null> => {
      const shape = await resolveRequestComparePeriodShape(filters.dateFrom, filters.dateTo, { area: "analysis", surface: "global" });
      if (!shape.months) return null;
      try {
        return monthView(await loadCitationPeriodCompare(filters, api.ctx, shape.kind, api.competitor), shape, filters);
      } catch (e) {
        throwForPage(e, locale);
      }
    })(),
  };
}

function monthView(
  compare: Parameters<typeof toPeriodDeltaView>[0] | null,
  shape: Awaited<ReturnType<typeof resolveRequestComparePeriodShape>>,
  filters: StandardFilters,
): PeriodDeltaView | null {
  if (!compare) return null;
  return toPeriodDeltaView(compare, {
    days: shape.days ?? 0,
    kind: shape.kind,
    curLo: shape.weeks?.cur.lo ?? shape.months?.cur.lo ?? filters.dateFrom,
    todayKst: kstToday(),
  });
}

// Filter options: citation/page.tsx CitationsFilterBar (legacy + api), awaited so the panel shows
// first; the 경쟁사 options stay a promise (the heavy citation read) so only that axis waits.
async function filterProps(filters: StandardFilters, scope: AllowedScope, api: CitationApi | null, locale: string): Promise<OverviewFilterProps> {
  if (api) {
    try {
      const [options, dates] = await Promise.all([
        afterCitationEssentials(
          filters,
          api.ctx,
          () => loadPanelOptions({ surface: "global", dateFrom: filters.dateFrom, dateTo: filters.dateTo, scope, filters }),
          api.competitor,
        ),
        loadFilterDates({ surface: "global", family: "citations" }),
      ]);
      return {
        stage: "citation",
        scope,
        catalogRows: options.catalogRows,
        geographyOptions: options.geographyOptions,
        languageOptions: options.languageOptions,
        optionMatrix: options.optionMatrix,
        competitorOptions: loadCitationsView(filters, api.ctx, api.competitor)
          .then((v) => v.competitorOptions)
          .catch(() => []),
        collectionStartDay: dates.collectionStartDay,
        latestAnchorDay: dates.latestAnchorDay,
        selectableDates: dates.selectableDates,
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
    // the citation family calendar: hidden_scope='citations' rounds have nothing to show here
    fetchSelectableAnchorDates("global", filters, "citations"),
  ]);
  return {
    stage: "citation",
    scope,
    catalogRows,
    geographyOptions,
    languageOptions,
    optionMatrix,
    competitorOptions: fetchStandardCitations(filters)
      .then((live) => competitorDomainOptions(live?.domains ?? []))
      .catch(() => []),
    collectionStartDay: collection?.firstMeasuredAt?.toISOString() ?? null,
    latestAnchorDay,
    selectableDates,
  };
}

async function RenewalCitation({
  filters,
  scope,
  userId,
  api,
  locale,
  header,
  body,
}: {
  filters: StandardFilters;
  scope: AllowedScope;
  userId: string;
  api: CitationApi | null;
  locale: string;
  header: ReactNode;
  body: RnCitationInput;
}) {
  const props = await filterProps(filters, scope, api, locale);
  return (
    <RnOverviewFilters props={props} storageKey={`rn:saved-filters:v1:citation:${userId}`}>
      <RnFilterSplit header={header} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>
        <RnOverviewApplied />
        <RnBusyScope className="flex flex-col gap-4">
          <RnCitationBody input={body} />
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
