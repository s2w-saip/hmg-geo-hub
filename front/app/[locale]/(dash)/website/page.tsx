import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionCard } from "@/components/section-card";
import { getSession } from "@/lib/auth/session";
import { showsGeoMap } from "@/lib/auth/scope-policy";
import { AsOfChip, AsOfChipSkeleton } from "@/components/dash/as-of-chip";
import { WebsiteFilters } from "@/components/dash/website-filters";
import { SummaryTilesDeferredDeltas } from "../dashboard/_components/summary-tiles-deferred-deltas";
import { GeoSnapshot } from "../dashboard/_components/geo-snapshot";
import { GeoMapLazy } from "../dashboard/_components/geo-map-lazy";
import { PendingNotice } from "../dashboard/_components/degrade-notice";
import { PageHeader } from "@/components/page-header";
import {
  DashboardCompositionSkeleton,
  DashboardGeoSkeleton,
  DashboardSummarySkeleton,
  DashboardTrendSkeleton,
  FilterBarSkeleton,
} from "@/components/dash/section-skeleton";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";
import { LiveTrendChartView } from "../dashboard/_components/live-trend-chart";
import { CompositionPanel } from "../dashboard/_components/composition-panel";
import { screenGet, screenSearch, type ScreenQuery } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import type { AllowedScope } from "@/lib/auth/types";
import type {
  AsOfView,
  CompositionView,
  FilterBarView,
  TilesView,
  WebsiteGeoView,
  WebsiteSummaryView,
  WebsiteTrendView,
} from "../dashboard/_data/screen-types";
import { handled, isTransientScreenError } from "../dashboard/_data/screen-fallbacks";

// 웹사이트 Overview — 권역별 공식 사이트 인용 현황. 표준 대시보드와 같은 카드·추이·구성·GEO 구성을
// WebsiteFilters(geography 1차 축 + admin 전용 brand 축)로 구동한다.
//
// Data: the website screens of the BFF (back/bff/screens/overview.py), one per Suspense section;
// every value is computed there:
//   filter bar + as-of chip   overview/filters, overview/as-of (ctx.surface=website)
//   tiles                     website/summary (card speed) -> website/summary-deferred (Δ + engine badge)
//   KPI trend                 website/trend      (fewer than two points -> "accruing")
//   source composition        website/composition (degraded -> notice)
//   GEO                       website/geo        (showsGeoMap only; no single active brand -> empty)
// ctx.admin tells the screens whether the brand axis is visible (admins only), as the filter bar does.

type SP = Record<string, string | string[] | undefined>;

export default async function WebsiteDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SP>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  // 헤더 문구는 웹사이트 전용(오피셜 사이트 인용 현황); 본문 섹션 라벨은 표준 dashboard 네임스페이스.
  const tw = await getTranslations("website.dashboard");

  // 세션 없음 = 만료. 웹사이트는 soft nav 로만 진입해 레이아웃 가드가 안 돌 수 있어 여기서 로그인으로 보낸다.
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const showGeo = showsGeoMap(session.user);
  const isAdmin = session.user.role === "admin";
  const sp = await searchParams;
  const q: ScreenQuery = { ...sp, "ctx.admin": String(isAdmin) };

  return (
    <div className="flex animate-fade-in flex-col gap-7">
      <PageHeader title={tw("title")} description={tw("subtitle")} />
      <FilterTransitionProvider>
        <Suspense fallback={<FilterBarSkeleton />}>
          <WebsiteFiltersSection scope={session.user.scope} isAdmin={isAdmin} q={q} locale={locale} />
        </Suspense>
        <FilterContentDim>
          <WebsiteDashboardSections showGeo={showGeo} q={q} locale={locale} />
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

async function WebsiteFiltersSection({
  scope,
  isAdmin,
  q,
  locale,
}: {
  scope: AllowedScope;
  isAdmin: boolean;
  q: ScreenQuery;
  locale: string;
}) {
  const query = { ...q, "ctx.surface": "website" };
  let v: FilterBarView;
  try {
    v = await screenGet<FilterBarView>("overview/filters", query);
  } catch (e) {
    throwForPage(e, locale);
  }
  const asOf = screenGet<AsOfView>("overview/as-of", query)
    .then((r) => r.asOf)
    .catch((e: unknown) => (isTransientScreenError(e) ? null : throwForPage(e, locale)));
  return (
    <>
      <WebsiteFilters
        scope={scope}
        catalogRows={v.catalogRows}
        geographyOptions={v.geographyOptions}
        languageOptions={v.languageOptions}
        optionMatrix={v.optionMatrix}
        isAdmin={isAdmin}
        latestAnchorDay={v.latestAnchorDay}
        selectableDates={v.selectableDates}
        asOfSlot={
          <Suspense fallback={<AsOfChipSkeleton />}>
            <AsOfSlot asOf={asOf} />
          </Suspense>
        }
      />
      <SectionDoneMarker id="website:filters" />
    </>
  );
}

// 프로미스를 여기서만 await 한다 — 이 컴포넌트만 서스펜드하고 필터바는 이미 떠 있다.
async function AsOfSlot({ asOf }: { asOf: Promise<string | null> }) {
  const date = await asOf;
  return (
    <>
      {date ? <AsOfChip date={date} /> : null}
      <SectionDoneMarker id="website:as-of" />
    </>
  );
}

function WebsiteDashboardSections({ showGeo, q, locale }: { showGeo: boolean; q: ScreenQuery; locale: string }) {
  // await 하지 않는다 — 각 섹션이 자기 것만 await 해서 따로 서스펜드한다.
  const summary = handled(screenGet<WebsiteSummaryView>("website/summary", q));
  const deferred = handled(screenGet<WebsiteSummaryView>("website/summary-deferred", q));
  const trend = handled(screenGet<WebsiteTrendView>("website/trend", q));
  const composition = handled(screenGet<CompositionView>("website/composition", q));
  // GEO 는 showGeo 일 때만 읽는다(권한상 안 보이는 계정에서 돌리고 버리지 않는다).
  const geo = showGeo ? handled(screenGet<WebsiteGeoView>("website/geo", { ...q, "ctx.locale": locale })) : null;
  // 필터 적용/초기화 때 섹션별로 갈리게 경계에 필터 키를 준다 — 카드는 먼저, 추이는 천천히
  // (filter-transition.tsx 의 "key 를 떼서 이전 결과를 딤 상태로 유지" 관례를 이 화면은 의도적으로 뒤집는다).
  const key = screenSearch(q);
  return (
    <div className="flex flex-col gap-7">
      <Suspense key={`summary:${key}`} fallback={<DashboardSummarySkeleton />}>
        <WebsiteSummarySection summary={summary} deferred={deferred} locale={locale} />
      </Suspense>
      <Suspense key={`trend:${key}`} fallback={<DashboardTrendSkeleton />}>
        <WebsiteTrendSection trend={trend} />
      </Suspense>
      <Suspense key={`composition:${key}`} fallback={<DashboardCompositionSkeleton />}>
        <WebsiteCompositionSection composition={composition} />
      </Suspense>
      {geo ? (
        <Suspense key={`geo:${key}`} fallback={<DashboardGeoSkeleton />}>
          <WebsiteGeoSection geo={geo} locale={locale} />
        </Suspense>
      ) : null}
    </div>
  );
}

// ① KPI 카드 — 값은 즉시(website/summary), 늦게 오는 둘(Δ 칩·엔진 일관성 배지)은 타일 안쪽 경계에서
// 채운다(website/summary-deferred). 마커: `website:summary` = 타일 도착, `website:summary-deltas` = 배지·Δ 도착.
async function WebsiteSummarySection({
  summary,
  deferred,
  locale,
}: {
  summary: Promise<WebsiteSummaryView>;
  deferred: Promise<WebsiteSummaryView>;
  locale: string;
}) {
  const t = await getTranslations("dashboard");
  // degrade 문구는 글로벌 대시보드와 같은 키(`answerAnalysis.mentions.kpi.degraded`).
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  let view: WebsiteSummaryView;
  try {
    view = await summary;
  } catch (e) {
    if (!isTransientScreenError(e)) throwForPage(e, locale);
    view = { state: "degraded" };
  }
  if (view.state !== "ok") {
    return (
      <>
        {/* 카드가 비는 이유 둘 — "이 필터에 데이터가 없다"(empty) 와 "읽기가 일시 실패했다"(degraded). */}
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-4 py-16 text-sm text-muted-foreground">
          {view.state === "degraded" ? tKpi("degraded") : t("empty")}
        </div>
        <SectionDoneMarker id="website:summary" />
      </>
    );
  }
  const tiles = view.tiles;
  // Δ·배지 읽기가 실패하면 카드는 그대로(배지·Δ 없이) 둔다.
  const withDeltas: Promise<TilesView> = deferred
    .then((d) => (d.state === "ok" ? d.tiles : tiles))
    .catch(() => tiles);
  return (
    <section aria-label={t("summary.label")}>
      <SummaryTilesDeferredDeltas tiles={tiles} deferred={withDeltas} />
      <SectionDoneMarker id="website:summary" />
      {/* 지면이 없는 마커 전용 경계 — 자기 Suspense 가 있어야 이 await 가 섹션 전체를 붙잡지 않는다. */}
      <Suspense fallback={null}>
        <DeferredArrival wait={withDeltas}>
          <SectionDoneMarker id="website:summary-deltas" />
        </DeferredArrival>
      </Suspense>
      {/* Δ·배지 읽기의 권한·필터 오류(4xx)는 지연이 아니라 오류라 페이지 오류 경로로 올린다. 그리는 것은 없다. */}
      <Suspense fallback={null}>
        <RaiseOnRejection read={deferred} locale={locale} />
      </Suspense>
    </section>
  );
}

/** `read` 가 일시 실패가 아닌 이유로 거부되면 페이지 오류 경로(throwForPage)로 올린다. 아무것도 그리지 않는다. */
async function RaiseOnRejection({ read, locale }: { read: Promise<unknown>; locale: string }) {
  await read.catch((e: unknown) => (isTransientScreenError(e) ? null : throwForPage(e, locale)));
  return null;
}

/** 프로미스가 풀리면 마커를 낸다(대시보드 page.tsx 의 같은 계약). */
async function DeferredArrival({
  wait,
  children,
}: {
  wait: Promise<unknown>;
  children: React.ReactNode;
}) {
  await wait.catch(() => {});
  return <>{children}</>;
}

async function WebsiteTrendSection({ trend }: { trend: Promise<WebsiteTrendView> }) {
  const t = await getTranslations("dashboard");
  const data = await trend;
  return (
    <SectionCard title={t("trend.title")} description={t("trend.description")}>
      {data.trend ? (
        <LiveTrendChartView view={data.trend} />
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          {t("trend.accruing")}
        </div>
      )}
      <SectionDoneMarker id="website:trend" />
    </SectionCard>
  );
}

async function WebsiteCompositionSection({ composition }: { composition: Promise<CompositionView> }) {
  const t = await getTranslations("dashboard");
  const tw = await getTranslations("website.dashboard");
  let c: CompositionView;
  try {
    c = await composition;
  } catch (e) {
    if (!isTransientScreenError(e)) throw e;
    c = { topics: [], sources: [], degraded: true };
  }
  if (c.sources.length === 0) {
    // 출처 읽기가 일시 실패했으면 섹션이 조용히 사라지지 않게 그 자리에 지연 고지를 낸다(데이터 없음이면 마커만).
    return (
      <>
        {c.degraded ? <PendingNotice title={t("composition.title")} /> : null}
        <SectionDoneMarker id="website:composition" />
      </>
    );
  }
  return (
    <SectionCard title={t("composition.title")} description={tw("compositionDescription")}>
      <CompositionPanel topics={c.topics} sources={c.sources} showTopics={false} />
      <SectionDoneMarker id="website:composition" />
    </SectionCard>
  );
}

// ④ GEO — 카드에 데이터가 있을 때만. 읽기가 일시 실패하면 빈 지도·표 대신 지연 고지.
async function WebsiteGeoSection({ geo, locale }: { geo: Promise<WebsiteGeoView>; locale: string }) {
  let v: WebsiteGeoView | "failed";
  try {
    v = await geo;
  } catch (e) {
    if (!isTransientScreenError(e)) throwForPage(e, locale);
    v = "failed";
  }
  if (v !== "failed" && !v.show) return <SectionDoneMarker id="website:geo" />;
  if (v === "failed" || v.degraded) {
    const tGeo = await getTranslations("dashboard.geo");
    return (
      <>
        <PendingNotice title={tGeo("title")} />
        <SectionDoneMarker id="website:geo" />
      </>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <GeoMapLazy geo={v.geo} />
      <GeoSnapshot geo={v.geo} />
      <SectionDoneMarker id="website:geo" />
    </div>
  );
}
