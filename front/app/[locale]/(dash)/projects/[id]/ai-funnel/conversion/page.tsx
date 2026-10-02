import { getTranslations, setRequestLocale } from "next-intl/server";
import { DimensionLockChipGroup } from "@/components/dash/dimension-lock-chip";
import { resolveProperty } from "@/lib/ga4/property-map";
import {
  getAiConversionLive,
  getAiVisitsLive,
  parseConversionFilters,
  parseConversionPeriod,
} from "@/lib/ga4/conversion";
import { Ga4EventsDialog } from "@/components/dash/ga4-events-dialog";
import { ConversionView } from "../../../../standard/ai-funnel/_components/conversion-view";
import { ConversionUnmappedNotice } from "../../../../standard/ai-funnel/_components/conversion-unmapped-notice";
import { ConversionPendingNotice } from "../../../../standard/ai-funnel/_components/conversion-pending-notice";
import { VisitsView } from "../../../../standard/ai-funnel/_components/visits-view";
import { loadProjectFunnelContext } from "../_lib/auth-and-locks";
import { isDemoProject } from "@/lib/demo";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { loadConversionScreen } from "@/lib/hgh/adapters/funnel";
import { throwForPage } from "@/lib/hgh/errors";
import {
  DEMO_GA4_PROPERTY_ID,
  demoConversionLive,
  demoVisits,
} from "@/lib/ga4/demo-conversion";

// A project is always a single (brand, country) — country-leaf. So conversion
// here mirrors the standard page's country-leaf branch: resolve the GA4 property
// from the project's brand+country, then either show live GA4 data or the
// "GA4 미연동" notice (never the demo sample fixture — that would be a false
// signal on a real project). engine/device/visitorType filters slice the AI
// cohort; geography is locked to the project's country.
export default async function ProjectAiFunnelConversionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiFunnelConversion");
  const { locks, lockedGroups, brand, country, ga4PropertyId, canEditConversion } =
    await loadProjectFunnelContext(locale, id);

  // GA4 property: the project's own binding wins (lets out-of-catalog projects
  // connect), else fall back to the central market catalog by (brand, country).
  // null → neither set → "GA4 미연동" notice.
  const sp = await searchParams;
  const filters = parseConversionFilters(sp);
  const days = parseConversionPeriod(sp);

  // Demo capture project: no GA4 property → serve synthetic conversion + visits
  // so the page renders the full view instead of the "GA4 미연동" notice.
  const isDemo = isDemoProject(id);
  const { propertyId, liveData, visitsData } = isDemo
    ? { propertyId: DEMO_GA4_PROPERTY_ID, liveData: demoConversionLive(days), visitsData: demoVisits(days) }
    : isAnalysisApi("funnel", "project")
      ? await loadApi()
      : await loadLegacy();

  // Backend API source (HGH_SOURCE_G6=api, unit U8): GET /v1/funnel/conversion?surface=project
  // (BG-28: the project's own property first, else its market's property; one market). The
  // property for the event dialog is coverage.markets[0].property_id; an unmapped market has
  // none (the "GA4 미연동" notice), pending_grant keeps it with no data ("측정 대기").
  // The demo project keeps its synthetic data on both sources.
  async function loadApi() {
    try {
      const screen = await loadConversionScreen({ surface: "project", projectId: id, filters, days });
      const market = screen.markets[0] ?? null;
      return { propertyId: market?.propertyId ?? null, liveData: screen.liveData, visitsData: screen.visitsData };
    } catch (e) {
      throwForPage(e, locale, { permission: "not-found" });
    }
  }

  async function loadLegacy() {
    const propertyId =
      ga4PropertyId ??
      (brand ? await resolveProperty(undefined, { brand: [brand], region: [country] }) : null);
    const [liveData, visitsData] = propertyId
      ? await Promise.all([
          getAiConversionLive(propertyId, days, filters),
          getAiVisitsLive(propertyId, days, filters),
        ])
      : [null, null];
    return { propertyId, liveData, visitsData };
  }
  const hasFilters =
    (filters.engine?.length ?? 0) +
      (filters.device?.length ?? 0) +
      (filters.visitorType?.length ?? 0) >
    0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h2 className="font-head text-lg font-semibold tracking-tight text-foreground">
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          <DimensionLockChipGroup locks={locks} className="mt-1" />
        </div>
        {!isDemo && propertyId ? (
          <Ga4EventsDialog
            propertyId={propertyId}
            projectId={id}
            title={`${brand ?? "HMG"} · ${country}`}
            canEdit={canEditConversion}
          />
        ) : null}
      </div>
      {propertyId ? (
        <>
          <ConversionView
            lockedGroups={lockedGroups}
            liveData={liveData}
            visitsTrend={visitsData?.trend}
            periodDays={days}
            emptyState={
              <ConversionPendingNotice
                brand={brand ?? "HMG"}
                country={country}
                hasFilters={hasFilters}
              />
            }
          />
          {visitsData ? <VisitsView data={visitsData} /> : null}
        </>
      ) : (
        <ConversionUnmappedNotice
          brand={brand ?? "HMG"}
          country={country}
          settingsHref={`/projects/${id}/setting`}
        />
      )}
    </div>
  );
}
