import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import type { AllowedScope } from "@/lib/auth/types";
import { countStandardAcrPrompts, listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import { listMeasuredAcrLanguages, listMeasuredRegions } from "@/lib/db/repositories/scope-aggregates";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import { fetchSelectableAnchorDates, fetchStandardAcr, fetchStandardAcrOwn } from "@/lib/scope/server";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { readStandardFilters } from "@/components/dash/standard-filters";
import { isAnalysisApi, loadFilterDates, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { loadAcrScreen } from "@/lib/hgh/adapters/funnel";
import { throwForPage } from "@/lib/hgh/errors";
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
import { ownFromCounts, type AcrOwnTotal } from "./_components/acr-model";
import { RnAcrBody } from "./_components/acr-body";

// Renewal ACR (2026-10-21) — the redesigned /standard/ai-funnel/acr, served side by side
// with the original. Data: the SAME reads as acr/page.tsx (legacy path and the
// HGH_SOURCE_G4=api path) plus, on the legacy path only, the 당사 합계 the API already
// carries as `own` (fetchStandardAcrOwn: every own brand, not the first own row).
// Keep the reads below in step with /standard/ai-funnel/acr/page.tsx.

const ACR_AXES = ["brand", "geography", "language", "engine", "time", "brandPresence", "listType", "depth1", "depth2", "depth3"] as const;

export default async function RenewalAcrPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("renewal.acr");
  const tPage = await getTranslations("aiFunnelAcr");
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  // 기간 의미론 = acr/page.tsx: 필터 없음 = 최신 1회차 스냅샷, 기간 설정 = 그 기간 회차 누적.
  // `cumulative` only routes the legacy reader (see acr/page.tsx), the API derives it from from/to.
  const rawFilters = readStandardFilters(sp, session.user.scope);
  const filters = { ...rawFilters, cumulative: Boolean(rawFilters.dateFrom || rawFilters.dateTo) };
  const filtered = ACR_AXES.some((k) => sp[k] != null && sp[k] !== "");
  // brand-scoped accounts carry the HMG umbrella in filters.brand (readStandardFilters) — a prompt tag, not a brand
  const ownBrands = (rawFilters.brand ?? []).filter((b) => b !== UMBRELLA_BRAND);
  const ownLabel = ownBrands.length ? ownBrands.join(", ") : UMBRELLA_BRAND;
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
              {filters.cumulative ? t("periodRange", { from: rawFilters.dateFrom ?? "…", to: rawFilters.dateTo ?? "…" }) : t("snapshot")}
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
        <RenewalAcr rawFilters={rawFilters} filters={filters} scope={session.user.scope} userId={session.user.id} locale={locale} filtered={filtered} ownLabel={ownLabel} header={header} />
      </Suspense>
    </RnFilterRuntime>
  );
}

interface AcrRead {
  props: OverviewFilterProps;
  body: Parameters<typeof RnAcrBody>[0]["input"];
}

// Legacy: acr/page.tsx AcrData's reads in one Promise.all (+ the own total).
async function legacyRead(filters: StandardFilters, scope: AllowedScope, filtered: boolean, ownLabel: string): Promise<AcrRead> {
  const optionScope = narrowScopeBrands(scope, filters.brand);
  const [data, own, acrPromptCount, catalogRows, geographyOptions, languageOptions, selectableDates] = await Promise.all([
    fetchStandardAcr(filters),
    fetchStandardAcrOwn(filters),
    countStandardAcrPrompts(),
    listCatalogTaxonomy(),
    listMeasuredRegions(optionScope, undefined, true),
    listMeasuredAcrLanguages(optionScope, filters.region, { dateFrom: filters.dateFrom, dateTo: filters.dateTo }),
    fetchSelectableAnchorDates("global", filters, "all"),
  ]);
  const ownTotal: AcrOwnTotal | null = data?.measured && own ? ownFromCounts(own, data.totals) : null;
  return {
    props: { stage: "acr", scope, catalogRows, geographyOptions, languageOptions, selectableDates },
    body: { data, own: ownTotal, acrPromptCount, roundBuckets: false, period: Boolean(filters.dateFrom || filters.dateTo), filtered, ownLabel },
  };
}

// API: acr/page.tsx AcrDataApi's three calls (the screen carries `own` and the ACR languages).
async function apiRead(filters: StandardFilters, scope: AllowedScope, filtered: boolean, ownLabel: string, locale: string): Promise<AcrRead> {
  try {
    const [acr, options, dates] = await Promise.all([
      loadAcrScreen(filters, { surface: "global", scope }),
      loadPanelOptions({ surface: "global", scope, filters }),
      loadFilterDates({ surface: "global", family: "all" }),
    ]);
    const own = acr.data.own ? { ...acr.data.own } : null;
    return {
      props: { stage: "acr", scope, catalogRows: options.catalogRows, geographyOptions: options.geographyOptions, languageOptions: acr.languageOptions, selectableDates: dates.selectableDates },
      body: { data: acr.data, own, acrPromptCount: acr.acrPromptCount, roundBuckets: true, period: Boolean(filters.dateFrom || filters.dateTo), filtered, ownLabel },
    };
  } catch (e) {
    throwForPage(e, locale);
  }
}

async function RenewalAcr({
  rawFilters,
  filters,
  scope,
  userId,
  locale,
  filtered,
  ownLabel,
  header,
}: {
  rawFilters: StandardFilters;
  filters: StandardFilters;
  scope: AllowedScope;
  userId: string;
  locale: string;
  filtered: boolean;
  ownLabel: string;
  header: ReactNode;
}) {
  const read = isAnalysisApi("funnel", "global") ? await apiRead(rawFilters, scope, filtered, ownLabel, locale) : await legacyRead(filters, scope, filtered, ownLabel);
  return (
    <RnOverviewFilters props={read.props} storageKey={`rn:saved-filters:v1:acr:${userId}`}>
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
