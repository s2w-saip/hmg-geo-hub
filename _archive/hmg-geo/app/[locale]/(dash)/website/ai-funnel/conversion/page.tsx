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
import { Ga4EventsDialog } from "@/components/dash/ga4-events-dialog";
import { ConversionView } from "../../../standard/ai-funnel/_components/conversion-view";
import { ConversionUnmappedNotice } from "../../../standard/ai-funnel/_components/conversion-unmapped-notice";
import { ConversionPendingNotice } from "../../../standard/ai-funnel/_components/conversion-pending-notice";
import { VisitsView } from "../../../standard/ai-funnel/_components/visits-view";

// 웹사이트 > AI Agent Funnel > Conversion — 표준 ConversionView 재사용. 전환은
// GA4 축(engine/device/visitorType/geography)만 매핑되므로 brand 통합 축은 적용
// 대상이 아니다(scope 축 미매핑). 분기 로직은 표준과 동일.
export default async function WebsiteAiFunnelConversionPage({
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
  const filters = parseConversionFilters(sp);
  // 측정 기간(7/28/90d) — 표준/프로젝트와 동일하게 ?period를 읽어 GA4 조회 창과
  // ConversionPeriodSelect 활성 상태에 반영한다. (누락 시 90 고정 → 기간 버튼이
  // URL만 바꾸고 데이터·활성표시가 안 바뀌던 버그, 2026-07-29 수정.)
  const days = parseConversionPeriod(sp);
  const geoFilter = splitFilterValues(sp.geography);

  const [catalogRows, geographyOptions] = await Promise.all([
    listCatalogTaxonomy(),
    listMeasuredRegions(session?.user.scope),
  ]);
  const markets = await resolveProperties(
    session?.user.scope,
    geoFilter.length ? { region: geoFilter } : undefined,
  );
  const isCountryLeaf = markets.length === 1;
  const singlePropertyId = isCountryLeaf
    ? markets[0].propertyId
    : await resolveProperty(session?.user.scope, geoFilter.length ? { region: geoFilter } : undefined);
  const isUnmappedCountry = isCountryLeaf && !singlePropertyId;
  const [liveData, rollupData, visitsData] = await Promise.all([
    isCountryLeaf && singlePropertyId
      ? getAiConversionLive(singlePropertyId, days, filters)
      : Promise.resolve(null),
    !isCountryLeaf && markets.length > 0
      ? getAiTrafficConversionRollup(markets, days, filters)
      : Promise.resolve(null),
    isCountryLeaf && singlePropertyId
      ? getAiVisitsLive(singlePropertyId, days, filters)
      : Promise.resolve(null),
  ]);

  const hasFilters =
    (filters.engine?.length ?? 0) +
      (filters.device?.length ?? 0) +
      (filters.visitorType?.length ?? 0) >
    0;
  const showPending = isCountryLeaf && !!singlePropertyId && !liveData;
  // 전환 이벤트 편집 역할 — 열람 전용(website) / vendor 는 조회만(canEdit=false).
  const canEditEvents =
    !!session && ["country", "region", "hq", "admin"].includes(session.user.role);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <PageHeader title={t("title")} description={t("subtitle")} />
        {isCountryLeaf && singlePropertyId ? (
          <Ga4EventsDialog
            propertyId={singlePropertyId}
            title={`${markets[0].brand} · ${markets[0].country}`}
            canEdit={canEditEvents}
          />
        ) : null}
      </div>
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
