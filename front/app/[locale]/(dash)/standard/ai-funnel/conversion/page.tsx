import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { getSession } from "@/lib/auth/session";
import { listCatalogTaxonomy } from "@/lib/db/repositories/standards";
import { listMeasuredRegions } from "@/lib/db/repositories/scope-aggregates";
import { resolveProperty, resolveProperties } from "@/lib/ga4/property-map";
import {
  getAiConversionLive,
  getAiTrafficConversionRollup,
  getAiVisitsLive,
  parseConversionFilters,
  parseConversionPeriod,
} from "@/lib/ga4/conversion";
import { splitFilterValues } from "@/components/dash/filter-encoding";
import { ConversionView } from "../_components/conversion-view";
import { ConversionUnmappedNotice } from "../_components/conversion-unmapped-notice";
import { ConversionPendingNotice } from "../_components/conversion-pending-notice";
import { VisitsView } from "../_components/visits-view";
import { isAnalysisApi, loadPanelOptions } from "@/lib/hgh/adapters/filters";
import { loadConversionScreen } from "@/lib/hgh/adapters/funnel";
import { throwForPage } from "@/lib/hgh/errors";

// 표준 > AI Agent Funnel > Conversion — Q3=same-page baseline.
//
// Branches by effective scope:
//   country-leaf + mapped property : page-level split (페이지표 + 트렌드)
//   country-leaf + UNMAPPED        : "GA4 미연동 시장" 안내 (sample 노출 X)
//   region / HQ                    : 국가별 KPI 표 + 가중 합산 + 커버리지
//   no scope / no markets          : sample fixture (기존 표준 페이지 데모)
//
// 매핑된 시장이 없을 때 sample fixture가 노출되던 false signal이 country-leaf
// 케이스(이슈 3 — kia-de 등)를 해친다. country-leaf은 명시적 안내로 가른다.
export default async function AiFunnelConversionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiFunnelConversion");

  const session = await getSession();
  const sp = await searchParams;
  // engine/device/visitorType slice the AI cohort; geography narrows which
  // markets the rollup spans (region/HQ). Both are validated server-side.
  const filters = parseConversionFilters(sp);
  const days = parseConversionPeriod(sp);
  const geoFilter = splitFilterValues(sp.geography);

  const { catalogRows, geographyOptions, markets, isCountryLeaf, singlePropertyId, liveData, rollupData, visitsData } =
    isAnalysisApi("funnel", "global")
      ? await loadApi()
      : await loadLegacy();
  const isUnmappedCountry = isCountryLeaf && !singlePropertyId;

  // Backend API source (HGH_SOURCE_G4=api, unit U8): GET /v1/funnel/conversion once (markets,
  // live, rollup and visits from one answer, rules C1..C7) + GET /v1/filters/options for the
  // geography list. catalogRows is not needed: the conversion panel has no catalog axis, so the
  // options call asks for the geography only (geoOnly: the backend skips the catalog statements).
  async function loadApi() {
    try {
      const [screen, options] = await Promise.all([
        loadConversionScreen({ surface: "global", geography: geoFilter, filters, days }),
        loadPanelOptions({ surface: "global", scope: session?.user.scope ?? null, filters: {}, geoOnly: true }),
      ]);
      return { catalogRows: undefined, geographyOptions: options.geographyOptions, ...screen };
    } catch (e) {
      throwForPage(e, locale);
    }
  }

  async function loadLegacy() {
    const [catalogRows, geographyOptions] = await Promise.all([
      listCatalogTaxonomy(),
      listMeasuredRegions(session?.user.scope, undefined, true),
    ]);
    const markets = await resolveProperties(
      session?.user.scope,
      geoFilter.length ? { region: geoFilter } : undefined,
    );
    const isCountryLeaf = markets.length === 1;
    const singlePropertyId = isCountryLeaf
      ? markets[0].propertyId
      : await resolveProperty(session?.user.scope, geoFilter.length ? { region: geoFilter } : undefined);
    const [liveData, rollupData, visitsData] = await Promise.all([
      isCountryLeaf && singlePropertyId
        ? getAiConversionLive(singlePropertyId, days, filters)
        : Promise.resolve(null),
      !isCountryLeaf && markets.length > 0
        ? getAiTrafficConversionRollup(markets, days, filters)
        : Promise.resolve(null),
      // sub-KPI: AI 유입 방문 수 (sessions/회) — country-leaf live only.
      isCountryLeaf && singlePropertyId
        ? getAiVisitsLive(singlePropertyId, days, filters)
        : Promise.resolve(null),
    ]);
    return { catalogRows, geographyOptions, markets, isCountryLeaf, singlePropertyId, liveData, rollupData, visitsData };
  }

  // Mapped country-leaf property that returned no data → "측정 대기" (NOT the
  // demo sample, which would be a false signal on a measured market).
  const hasFilters =
    (filters.engine?.length ?? 0) +
      (filters.device?.length ?? 0) +
      (filters.visitorType?.length ?? 0) >
    0;
  const showPending = isCountryLeaf && !!singlePropertyId && !liveData;

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      {isUnmappedCountry ? (
        <ConversionUnmappedNotice
          brand={markets[0].brand}
          country={markets[0].country}
        />
      ) : (
        <>
          <ConversionView
            scope={session?.user.scope}
            catalogRows={catalogRows}
            geographyOptions={geographyOptions}
            liveData={liveData}
            rollupData={rollupData}
            visitsTrend={visitsData?.trend}
            periodDays={days}
            emptyState={
              showPending ? (
                <ConversionPendingNotice
                  brand={markets[0].brand}
                  country={markets[0].country}
                  hasFilters={hasFilters}
                />
              ) : undefined
            }
          />
          {visitsData ? <VisitsView data={visitsData} /> : null}
        </>
      )}
    </div>
  );
}
