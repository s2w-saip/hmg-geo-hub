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
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import {
  fetchLatestAnchorDay,
  fetchPeriodCompare,
  fetchSelectableAnchorDates,
  fetchStandardKpiBrandTrend,
  fetchStandardKpiEngineTrend,
  fetchStandardKpiFirstPosition,
  fetchStandardKpiHeroSubKpis,
  fetchStandardKpiHeroSubKpisPrev,
  fetchStandardKpiTypes,
  fetchStandardMentionCompetitorBrands,
  fetchStandardMentions,
} from "@/lib/scope/server";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { MENTION_COMPARE_METRICS } from "@/components/dash/period-delta-metrics";
import { resolveRequestComparePeriodShape } from "@/lib/period/compare-shape";
import { throwForPage } from "@/lib/hgh/errors";
import {
  afterEssentials,
  degrade,
  loadMentionBrandRows,
  loadMentionsAsOf,
  loadMentionsLive,
  loadSentimentTotals,
  loadTypesByBrand,
  mentionsDegraded,
  type MentionsContext,
} from "@/lib/hgh/adapters/mentions";
import {
  loadBrandTrend,
  loadEngineKpiTrend,
  loadFirstPosition,
  loadKpiHeroSubKpis,
  loadKpiHeroSubKpisPrev,
  loadTypeKpi,
  wasFirstPositionHeroDegraded,
  wasKpiTabDegraded,
} from "@/lib/hgh/adapters/kpi-tab";
import { isAnalysisApi, loadFilterDates, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { fetchPeriodCompareApi } from "@/lib/hgh/adapters/compare";
import { KPI_TAB_PARAM, resolveKpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
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
import type { HeroMetric, RnMentionInput, RnMentionPeriod } from "./_components/mention-input";
import { RnMentionBody } from "./_components/mention-body";
import { RnMentionPageProvider, RnMentionTabs, RnMentionTabsFallback } from "./_components/mention-tabs";

// Renewal Mention (2026-10-21) — the redesigned /standard/answer-analysis/mention, served side
// by side with the original. Data: the SAME reads as mention/page.tsx (legacy path and the
// HGH_SOURCE_G2=api path). The original reads one KPI tab per request; this page shows the four
// KPIs together (product decision 2026-10-21), so it issues the union of the four tabs' reads —
// the same fetchers with the same arguments, each card resolving its own promise.
// Keep the reads below in step with /standard/answer-analysis/mention/page.tsx.

export const maxDuration = 120;

const MENTION_AXES = ["brand", "geography", "language", "engine", "time", "promptContext", "brandPresence", "listType", "depth1", "depth2", "depth3", "depth4"] as const;
const HERO_METRICS: readonly HeroMetric[] = ["exposure", "sov", "favorability"];

export default async function RenewalMentionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.mention");
  const tPage = await getTranslations("answerAnalysis");
  const tOv = await getTranslations("dashboard.overview");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  // 기간 의미론 = mention/page.tsx: cumulative 를 늘 싣고, 실제 누적은 기간이 있을 때만 일어난다.
  const filters = { ...readStandardFilters(sp, session.user.scope), cumulative: true };
  const api: MentionsContext | null = isAnalysisApi("analysis", "global") ? { surface: "global", scope: session.user.scope ?? null } : null;
  const filtered = MENTION_AXES.some((k) => sp[k] != null && sp[k] !== "");
  // brand-scoped accounts carry the HMG umbrella in filters.brand (readStandardFilters) — a prompt tag, not a brand
  const ownBrands = (filters.brand ?? []).filter((b) => b !== UMBRELLA_BRAND);
  const ownLabel = ownBrands.length ? ownBrands.join(", ") : UMBRELLA_BRAND;
  const period = filters.dateFrom || filters.dateTo ? { from: filters.dateFrom ?? null, to: filters.dateTo ?? null } : null;
  const asOf = api ? loadMentionsAsOf(filters, api) : fetchStandardMentions(filters).then((d) => d?.asOf ?? null);

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
          <span className="w-full text-rn-13 text-rn-muted">{tPage("mentions.description")}</span>
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
      actions={<RnCopyLinkButton />}
    />
  );
  const body: RnMentionInput = {
    kpi: resolveKpiTab(sp[KPI_TAB_PARAM]),
    ownLabel,
    period,
    filtered,
    ...(api ? apiReads(filters, api, locale) : legacyReads(filters)),
  };
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton header={<>{header}<RnMentionTabsFallback kpi={body.kpi} /></>} />}>
        <RenewalMention filters={filters} scope={session.user.scope} userId={session.user.id} api={api} locale={locale} header={header} body={body} />
      </Suspense>
    </RnFilterRuntime>
  );
}

async function AsOfText({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const day = await asOf.catch(() => null);
  return <>{day ? t("lastMeasured", { date: day.slice(0, 10) }) : "—"}</>;
}

type Reads = Omit<RnMentionInput, "kpi" | "ownLabel" | "period" | "filtered">;

// 기간 비교 Δ — mention/page.tsx MentionsKpiBody 와 같은 모양·같은 인자(언급 계열 전 지표, 한 번).
async function periodCompareOf(
  filters: StandardFilters,
  run: (shape: Awaited<ReturnType<typeof resolveRequestComparePeriodShape>>) => Promise<RnMentionPeriod["compare"]>,
): Promise<RnMentionPeriod> {
  const shape = await resolveRequestComparePeriodShape(filters.dateFrom, filters.dateTo, { area: "analysis", surface: "global" });
  return { compare: await run(shape), days: shape.days ?? undefined, kind: shape.kind };
}

// Legacy: the readers of mention/page.tsx (exposure · sov · favorability · first-rank tabs + MentionsData).
function legacyReads(filters: StandardFilters): Reads {
  const data = fetchStandardMentions(filters);
  const sub = Object.fromEntries(HERO_METRICS.map((m) => [m, fetchStandardKpiHeroSubKpis(filters, m)])) as Reads["sub"];
  const prev = Object.fromEntries(HERO_METRICS.map((m) => [m, fetchStandardKpiHeroSubKpisPrev(filters, m)])) as Reads["prev"];
  const no = Promise.resolve(false);
  return {
    mentions: data,
    brands: data.then((d) => d?.brands ?? []),
    competitorValues: fetchStandardMentionCompetitorBrands(filters),
    sub,
    prev,
    // 추이 주 격자 축 — 원본 탭들과 같은 weekAxis(아래 주별 차트와 같은 축).
    engineTrend: fetchStandardKpiEngineTrend(filters, { weekAxis: "S2.mentionTrend" }),
    brandTrend: fetchStandardKpiBrandTrend(filters, { weekAxis: "S2.mentionTrend" }),
    typeKpi: fetchStandardKpiTypes(filters),
    typesByBrand: data.then((d) => d?.typesByBrand ?? null),
    sentimentTotals: data.then((d) => d?.sentimentTotals ?? null),
    firstPosition: fetchStandardKpiFirstPosition(filters),
    periodCompare: periodCompareOf(
      filters,
      (shape) =>
        fetchPeriodCompare(filters, {
          surface: "global",
          family: "mention",
          kind: shape.kind,
          metrics: MENTION_COMPARE_METRICS,
          ...(shape.months ? { months: shape.months } : {}),
          ...(shape.weeks ? { weeks: shape.weeks } : {}),
        }),
    ),
    degraded: { data: no, hero: no, types: no, firstRank: no },
  };
}

// API: the adapters of mention/page.tsx (same calls; the D6 essentials go first inside them).
function apiReads(filters: StandardFilters, api: MentionsContext, locale: string): Reads {
  const mentions = loadMentionsLive(filters, api).catch((e) => throwForPage(e, locale));
  const sub = Object.fromEntries(HERO_METRICS.map((m) => [m, loadKpiHeroSubKpis(filters, api, m)])) as Reads["sub"];
  const prev = Object.fromEntries(HERO_METRICS.map((m) => [m, loadKpiHeroSubKpisPrev(filters, api, m)])) as Reads["prev"];
  const typeKpi = loadTypeKpi(filters, api);
  const firstPosition = loadFirstPosition(filters, api);
  return {
    mentions,
    brands: loadMentionBrandRows(filters, api),
    competitorValues: Promise.resolve(null),
    sub,
    prev,
    engineTrend: loadEngineKpiTrend(filters, api),
    brandTrend: loadBrandTrend(filters, api),
    typeKpi,
    typesByBrand: loadTypesByBrand(filters, api),
    sentimentTotals: loadSentimentTotals(filters, api),
    firstPosition,
    periodCompare: periodCompareOf(
      filters,
      (shape) =>
        degrade(
          "standardPeriodCompare",
          () => afterEssentials(filters, api, () => fetchPeriodCompareApi(filters, { ...api, kind: shape.kind, metrics: MENTION_COMPARE_METRICS })),
          null,
        ),
    ),
    // B034: the marks are valid only after their read settled — chain them on the same promises.
    degraded: {
      data: mentions.then(() => mentionsDegraded(api).data),
      hero: sub.exposure.then(() => wasKpiTabDegraded("hero")),
      types: typeKpi.then(() => wasKpiTabDegraded("types")),
      firstRank: firstPosition.then(() => wasFirstPositionHeroDegraded()),
    },
  };
}

// Filter options: mention/page.tsx MentionsFilterBar (legacy + api), awaited here so the panel
// shows first; the body streams after it.
async function filterProps(filters: StandardFilters, scope: AllowedScope, api: MentionsContext | null, locale: string): Promise<OverviewFilterProps> {
  if (api) {
    try {
      const [options, dates] = await Promise.all([
        afterEssentials(filters, api, () => loadPanelOptions({ surface: "global", dateFrom: filters.dateFrom, dateTo: filters.dateTo, scope, filters })),
        loadFilterDates({ surface: "global", family: "mentions" }),
      ]);
      return {
        stage: "mention",
        scope,
        catalogRows: options.catalogRows,
        geographyOptions: options.geographyOptions,
        languageOptions: options.languageOptions,
        optionMatrix: options.optionMatrix,
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
    fetchSelectableAnchorDates("global", filters, "mentions"),
  ]);
  return {
    stage: "mention",
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

async function RenewalMention({
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
  api: MentionsContext | null;
  locale: string;
  header: ReactNode;
  body: RnMentionInput;
}) {
  const props = await filterProps(filters, scope, api, locale);
  return (
    <RnOverviewFilters props={props} storageKey={`rn:saved-filters:v1:mention:${userId}`}>
      {/* the KPI tabs sit under the title, above filter | content (2026-10-22); one provider feeds both */}
      <RnMentionPageProvider input={body}>
        <RnFilterSplit
          header={
            <>
              {header}
              <RnMentionTabs />
            </>
          }
          panel={<RnOverviewFilterPanel />}
          rail={<RnOverviewFilterRail />}
        >
          <RnOverviewApplied />
          <RnBusyScope className="flex flex-col gap-4">
            <RnMentionBody />
          </RnBusyScope>
        </RnFilterSplit>
      </RnMentionPageProvider>
    </RnOverviewFilters>
  );
}

function PageSkeleton({ header }: { header: ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      {header}
      <div className="grid items-start gap-5 grid-cols-[52px_minmax(0,1fr)] min-[1360px]:grid-cols-[296px_minmax(0,1fr)]">
        <RnCard className="hidden h-[480px] min-[1360px]:block" />
        <RnCard className="h-24 min-[1360px]:hidden" />
        <div className="flex min-w-0 flex-col gap-4">
          <RnCard className="h-12" />
          <RnCard className="flex flex-col gap-3 p-6">
            <RnSkeleton className="h-4 w-40" />
            <RnSkeleton className="h-16 w-full" />
          </RnCard>
          <RnCard className="h-[320px]" />
        </div>
      </div>
    </div>
  );
}
