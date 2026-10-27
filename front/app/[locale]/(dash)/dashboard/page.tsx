import { Suspense } from "react";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { formatAsOfDate } from "@/lib/as-of-date";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PendingNotice } from "./_components/degrade-notice";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { showsGeoMap } from "@/lib/auth/scope-policy";
import { OverviewFilters } from "./_components/overview-filters";
import { OverviewKpiCards } from "./_components/overview-kpi-cards";
import { GeoOverview } from "./_components/geo-overview";
import { PageHeader } from "@/components/page-header";
import {
  DashboardGeoSkeleton,
  DashboardSummarySkeleton,
  FilterBarSkeleton,
} from "@/components/dash/section-skeleton";
import {
  FilterTransitionProvider,
  FilterContentDim,
} from "@/components/dash/filter-transition";
import type { AllowedScope } from "@/lib/auth/types";
import { screenGet } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import type {
  AsOfView,
  CardCompetitorsView,
  CardsView,
  CardTrendView,
  FilterBarView,
  OverviewGeoView,
} from "./_data/screen-types";
import {
  DEGRADED_CARD_COMPETITORS,
  DEGRADED_CARD_TREND,
  handled,
  isTransientScreenError,
  onTransient,
} from "./_data/screen-fallbacks";

// 통합 대시보드 Overview (디자인 611:135): 헤더 측정 기준일 pill · 필터바 · 5-KPI 카드 · 국가별 GEO 현황.
//
// Data: the overview screens of the BFF (back/bff/screens/overview.py) — one screen per Suspense
// section, every value computed there; this page only fetches and renders. The section structure,
// skeletons, markers and empty / degraded states are the same as before:
//   header pill        overview/as-of            (transient failure -> "—")
//   filter bar         overview/filters
//   KPI cards          overview/cards            (empty -> t("empty"), degraded -> kpi.degraded)
//     Δ + sparklines   overview/card-trend       (deferred inside the cards; degraded -> trend notice)
//     competitor rows  overview/card-competitors (deferred inside the cards; degraded -> notice)
//   GEO                overview/geo              (showsGeoMap only; degraded -> notice)
// All reads are issued at once; each boundary waits for its own. 401/403/404 go through throwForPage.
// 120s 상한은 콜드 집계를 조기 실패시키는 안전판이다(다른 라우트에 복사하지 말 것).
export const maxDuration = 120;

type SP = Record<string, string | string[] | undefined>;

export default async function DashboardPage({
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

  const showGeo = showsGeoMap(session.user);
  const sp = await searchParams;
  const asOf = screenGet<AsOfView>("overview/as-of", { ...sp, "ctx.surface": "global" })
    .then((v) => v.asOf)
    .catch((e: unknown) => (isTransientScreenError(e) ? null : throwForPage(e, locale)));

  // The header renders at once; every section streams behind its own Suspense boundary. On a
  // filter apply the boundaries are NOT re-keyed, so the previous result stays on screen (dimmed
  // by FilterContentDim) while the narrowed sections reload.
  return (
    <div className="flex animate-fade-in flex-col gap-7">
      <PageHeader
        title={t("overview.title")}
        description={t("subtitle")}
        className="border-b-0 pb-0"
        // 피그마 611:135 헤더 우측 pill: "주 1회 측정 · 측정 회차 … 기준" (카드와 같은 집계의 as_of).
        actions={
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
            <span>{t("overview.cadence")}</span>
            <span aria-hidden className="h-3 w-px bg-border" />
            <Suspense fallback={<span className="inline-block h-3 w-24 animate-pulse rounded bg-muted" />}>
              <LastMeasured asOf={asOf} />
            </Suspense>
          </div>
        }
      />
      <FilterTransitionProvider>
        <Suspense fallback={<FilterBarSkeleton />}>
          <OverviewFiltersSection scope={session.user.scope} sp={sp} locale={locale} />
        </Suspense>
        <FilterContentDim>
          <div className="flex flex-col gap-7">
            <Suspense fallback={<DashboardSummarySkeleton />}>
              <KpiCardsSection sp={sp} locale={locale} qs={qsFrom(sp)} />
            </Suspense>
            {showGeo ? (
              <Suspense fallback={<DashboardGeoSkeleton />}>
                <GeoSection sp={sp} locale={locale} />
              </Suspense>
            ) : null}
          </div>
        </FilterContentDim>
      </FilterTransitionProvider>
    </div>
  );
}

async function OverviewFiltersSection({ scope, sp, locale }: { scope: AllowedScope; sp: SP; locale: string }) {
  let v: FilterBarView;
  try {
    v = await screenGet<FilterBarView>("overview/filters", { ...sp, "ctx.surface": "global" });
  } catch (e) {
    throwForPage(e, locale);
  }
  return (
    <>
      <OverviewFilters
        scope={scope}
        catalogRows={v.catalogRows}
        geographyOptions={v.geographyOptions}
        languageOptions={v.languageOptions}
        optionMatrix={v.optionMatrix}
        collectionStartDay={v.collectionStartDay}
        latestAnchorDay={v.latestAnchorDay}
        selectableDates={v.selectableDates}
        onlyGroups={v.onlyGroups}
      />
      <SectionDoneMarker id="dashboard:filters" />
    </>
  );
}

// 측정 기준일 — 카드와 같은 집계의 as_of(회차 앵커). 이 컴포넌트만 서스펜드하고 헤더는 이미 떠 있다.
async function LastMeasured({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const date = await asOf;
  return (
    <>
      <span className="tabular-nums">{date ? t("lastMeasured", { date: formatAsOfDate(date) }) : "—"}</span>
      <SectionDoneMarker id="dashboard:last-measured" />
    </>
  );
}

// ① 5-KPI 카드 — 카드 본체(값·측정 대기·기간 비교)만 이 경계에서 기다린다. Δ·스파크라인과 경쟁사 행은
// 카드 안에서 각자 <Suspense> 로 채워진다(OverviewKpiCards). 세 read 는 여기서 한꺼번에 발행한다.
async function KpiCardsSection({ sp, locale, qs }: { sp: SP; locale: string; qs: string }) {
  const t = await getTranslations("dashboard");
  const tKpi = await getTranslations("answerAnalysis.mentions.kpi");
  const trend = handled(onTransient(screenGet<CardTrendView>("overview/card-trend", sp), DEGRADED_CARD_TREND));
  const competitors = handled(
    onTransient(screenGet<CardCompetitorsView>("overview/card-competitors", sp), DEGRADED_CARD_COMPETITORS),
  );
  let view: CardsView;
  try {
    view = await screenGet<CardsView>("overview/cards", sp);
  } catch (e) {
    if (!isTransientScreenError(e)) throwForPage(e, locale);
    view = { state: "degraded" };
  }
  return (
    <>
      {view.state === "ok" ? (
        <section aria-label={t("summary.label")}>
          <OverviewKpiCards cards={view.cards} locale={locale} qs={qs} deferred={{ trend, competitors }} />
        </section>
      ) : (
        // 카드가 비는 이유 둘 — "이 필터에 데이터가 없다"(empty) 와 "읽기가 일시 실패했다"(degraded).
        <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-card px-4 py-16 text-sm text-muted-foreground">
          {view.state === "degraded" ? tKpi("degraded") : t("empty")}
        </div>
      )}
      <SectionDoneMarker id="dashboard:kpi-cards" />
      {view.state === "ok" ? (
        <>
          {/* 마커 + degrade 고지: 카드 안의 지연 슬롯과 같은 프로미스를 기다린다. */}
          <Suspense fallback={null}>
            <DeferredNotice wait={trend.then((v) => v.degraded)} title={t("trend.title")} marker="dashboard:kpi-extras" />
          </Suspense>
          <Suspense fallback={null}>
            <DeferredNotice
              wait={competitors.then((v) => v.degraded.length > 0)}
              title={t("summary.label")}
              marker="dashboard:kpi-competitors"
            />
          </Suspense>
        </>
      ) : null}
    </>
  );
}

// 프로미스가 풀리면 (degrade 면 지연 고지와) 마커를 낸다. 실패는 그 프로미스를 소비하는 카드 슬롯이 든다.
async function DeferredNotice({ wait, title, marker }: { wait: Promise<boolean>; title: string; marker: string }) {
  const degraded = await wait.catch(() => false);
  return (
    <>
      {degraded ? <PendingNotice title={title} /> : null}
      <SectionDoneMarker id={marker} />
    </>
  );
}

// ④ GEO — 시장 지도와 권역/국가 표(showsGeoMap 인 역할만). 카드가 비면(측정 없음) 섹션이 사라지고,
// GEO 읽기가 일시 실패하면 그 자리에 지연 고지를 낸다.
async function GeoSection({ sp, locale }: { sp: SP; locale: string }) {
  let v: OverviewGeoView;
  try {
    v = await screenGet<OverviewGeoView>("overview/geo", { ...sp, "ctx.locale": locale });
  } catch (e) {
    if (!isTransientScreenError(e)) throwForPage(e, locale);
    v = { geo: null, degraded: true };
  }
  if (!v.geo) {
    const tOverview = await getTranslations("dashboard.overview");
    return (
      <>
        {v.degraded ? <PendingNotice title={tOverview("geo.title")} /> : null}
        <SectionDoneMarker id="dashboard:geo" />
      </>
    );
  }
  return (
    <>
      <GeoOverview geo={v.geo} />
      <SectionDoneMarker id="dashboard:geo" />
    </>
  );
}

// 현재 필터 파라미터를 카드 상세 링크에 실어 나른다(탭 파라미터 등은 없다).
function qsFrom(sp: SP): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) params.append(k, one);
  }
  return params.toString();
}
