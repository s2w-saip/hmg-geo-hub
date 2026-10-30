import { Suspense, type ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CalendarDays } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { showsGeoMap } from "@/lib/auth/scope-policy";
import type { AllowedScope } from "@/lib/auth/types";
import { formatAsOfDate } from "@/lib/as-of-date";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import { throwForPage } from "@/lib/hgh/errors";
import type {
  AsOfView,
  CompositionView,
  FilterBarView,
  TilesView,
  WebsiteGeoView,
  WebsiteSummaryView,
  WebsiteTrendView,
} from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { handled, isTransientScreenError, onTransient } from "@/app/[locale]/(dash)/dashboard/_data/screen-fallbacks";
import { RnCard, RnEmpty, RnPageHeader, RnPill, RnSkeleton } from "@/components/renewal-ui";
import { RnBusyScope, RnFilterRuntime } from "../_components/filter-runtime";
import { loadSavedFilters } from "../_components/saved-filters-server";
import {
  RnCopyLinkButton,
  RnFilterSplit,
  RnOverviewApplied,
  RnOverviewFilterPanel,
  RnOverviewFilterRail,
  RnOverviewFilters,
  type OverviewFilterProps,
} from "../_components/overview-filters";
import { RnWebsiteOverviewBody } from "./_overview/website-overview-body";
import { websiteFindings } from "./_overview/website-findings";
import { WebsiteFindingList } from "./_overview/website-findings-view";
import type { WebsiteBrandsView, WebsiteEnginesView } from "./_overview/website-format";
import { engineLabel } from "./_overview/engine-label";

// Renewal Website Overview (2026-10-30, W1) — the redesigned /website, served side by side with the original.
// Data: the SAME screens as /website/page.tsx (back/bff/screens/overview.py), ctx.surface=website on the
// filter panel and the header pill, ctx.admin on every screen (the brand axis is an administrator's only), plus
// two breakdowns of the same Gold values: website/brands (each brand's tiles) and website/engines (the engine
// rows behind 엔진 간 일관성). 핵심 요약 restates values of the sections (website-findings.ts).
export const maxDuration = 120;

type SP = Record<string, string | string[] | undefined>;

export default async function RenewalWebsitePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SP>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [tw, t, tr] = await Promise.all([getTranslations("website.dashboard"), getTranslations("dashboard"), getTranslations("renewal.website.overview")]);
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const sp = await searchParams;
  const isAdmin = session.user.role === "admin";
  const q: ScreenQuery = { ...sp, "ctx.admin": String(isAdmin) };
  const asOf = screenGet<AsOfView>("overview/as-of", { ...q, "ctx.surface": "website" })
    .then((v) => v.asOf)
    .catch((e: unknown) => (isTransientScreenError(e) ? null : throwForPage(e, locale)));
  // The body's reads leave now, with the filter panel's (the renewal Overview's rule: issued after them, every
  // section waited for that read).
  const reads = bodyReads(q, locale, showsGeoMap(session.user));
  return (
    <RnFilterRuntime>
      <Suspense fallback={<PageSkeleton title={tr("title")} />}>
        <RenewalWebsiteOverview
          sp={sp}
          scope={session.user.scope}
          userId={session.user.id}
          isAdmin={isAdmin}
          reads={reads}
          locale={locale}
          qs={qsFrom(sp)}
          header={
            <RnPageHeader
              title={tr("title")}
              meta={
                <>
                  <span className="text-rn-13 text-rn-muted">{tw("subtitle")}</span>
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

// Filter panel options — the same screen as /website's filter bar; the panel shows the website axes.
async function filterOptions(scope: AllowedScope, q: ScreenQuery, locale: string): Promise<OverviewFilterProps> {
  let v: FilterBarView;
  try {
    v = await screenGet<FilterBarView>("overview/filters", { ...q, "ctx.surface": "website" });
  } catch (e) {
    throwForPage(e, locale);
  }
  return {
    stage: "overview",
    surface: "website",
    scope,
    geographyOptions: v.geographyOptions,
    languageOptions: v.languageOptions,
    optionMatrix: v.optionMatrix,
    collectionStartDay: v.collectionStartDay,
    latestAnchorDay: v.latestAnchorDay,
    selectableDates: v.selectableDates,
  };
}

async function RenewalWebsiteOverview({
  sp,
  scope,
  userId,
  isAdmin,
  reads,
  locale,
  qs,
  header,
}: {
  sp: SP;
  scope: AllowedScope;
  userId: string;
  isAdmin: boolean;
  reads: BodyReads;
  locale: string;
  qs: string;
  header: ReactNode;
}) {
  const q: ScreenQuery = { ...sp, "ctx.admin": String(isAdmin) };
  const [props, saved] = await Promise.all([filterOptions(scope, q, locale), loadSavedFilters("website-overview")]);
  return (
    <RnOverviewFilters props={props} savedFilters={{ page: "website-overview", userId, initial: saved }}>
      <RnFilterSplit header={header} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>
        <RnOverviewApplied />
        <RnBusyScope className="flex flex-col gap-2.5">
          <Suspense fallback={<BodySkeleton />}>
            <OverviewSection reads={reads} locale={locale} qs={qs} isAdmin={isAdmin} />
          </Suspense>
        </RnBusyScope>
      </RnFilterSplit>
    </RnOverviewFilters>
  );
}

// The reads of /website's sections, issued together. Every promise has its rejection handler attached at once:
// the page may fail (filters) before a section awaits. A transient failure of a section's screen leaves that
// section's notice; anything else goes to the page error path (the original page's rules).
function bodyReads(q: ScreenQuery, locale: string, showGeo: boolean) {
  const summary = handled(screenGet<WebsiteSummaryView>("website/summary", q));
  const deferredView = handled(screenGet<WebsiteSummaryView>("website/summary-deferred", q));
  const raise = (e: unknown): never => throwForPage(e, locale);
  return {
    summary,
    deferredView,
    brands: handled(onTransient<WebsiteBrandsView | "failed">(screenGet<WebsiteBrandsView>("website/brands", q), "failed").catch(raise)),
    engines: handled(onTransient<WebsiteEnginesView>(screenGet<WebsiteEnginesView>("website/engines", q), DEGRADED_ENGINES).catch(raise)),
    trend: handled(onTransient<WebsiteTrendView | "failed">(screenGet<WebsiteTrendView>("website/trend", q), "failed").catch(raise)),
    composition: handled(
      onTransient<CompositionView>(screenGet<CompositionView>("website/composition", q), { topics: [], sources: [], degraded: true }).catch(raise),
    ),
    geo: showGeo
      ? handled(onTransient<WebsiteGeoView | "failed">(screenGet<WebsiteGeoView>("website/geo", { ...q, "ctx.locale": locale }), "failed").catch(raise))
      : null,
  };
}
type BodyReads = ReturnType<typeof bodyReads>;

const DEGRADED_ENGINES: WebsiteEnginesView = { engines: [], consistency: {}, extremes: {}, widest: null, degraded: true };

// 핵심 요약 — waits for the tiles' Δ and the breakdowns; a part that failed only drops its line.
async function Findings({ deferred, reads, locale }: { deferred: Promise<TilesView>; reads: BodyReads; locale: string }) {
  const [t, tUnit, tS, tW] = await Promise.all([
    getTranslations("renewal.website.overview"),
    getTranslations("metricUnit"),
    getTranslations("renewal.overview.short"),
    getTranslations("renewal.website.overview.short"),
  ]);
  const settle = <T,>(p: Promise<T>) => p.catch(() => null);
  const [tiles, engines, brands, composition] = await Promise.all([settle(deferred), settle(reads.engines), settle(reads.brands), settle(reads.composition)]);
  if (!tiles) return null;
  const items = websiteFindings({ tiles, engines, brands, composition }, (k, p) => t(k as "kpiTitle", p), {
    value: (unit, v) => (unit === "rank" ? tUnit("position", { n: v.toFixed(1) }) : `${v.toFixed(1)}%`),
    delta: (unit, d) => (unit === "rank" ? tUnit("position", { n: Math.abs(d).toFixed(1) }) : `${Math.abs(d).toFixed(1)}pp`),
    count: (n) => n.toLocaleString(locale),
    short: (k) => (tS.has(k) ? tS(k as "visibility") : tW(k as "ownedUrlRate")),
    engine: engineLabel,
  });
  return items.length ? (
    <div className="@container/rnpage">
      <WebsiteFindingList items={items} />
    </div>
  ) : null;
}

function FindingsSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-2.5 px-6">
      {Array.from({ length: 4 }, (_, i) => (
        <RnSkeleton key={i} className="h-[84px] rounded-[10px] bg-white/14" />
      ))}
    </div>
  );
}

async function OverviewSection({ reads, locale, qs, isAdmin }: { reads: BodyReads; locale: string; qs: string; isAdmin: boolean }) {
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
  const deferred: Promise<TilesView> = reads.deferredView.then(
    (d) => (d.state === "ok" ? d.tiles : tiles),
    (e: unknown) => (isTransientScreenError(e) ? tiles : throwForPage(e, locale)),
  );
  const tilesWithDeltas = handled(deferred);
  return (
    <RnWebsiteOverviewBody
      tiles={tiles}
      reads={{ deferred: tilesWithDeltas, brands: reads.brands, engines: reads.engines, trend: reads.trend, composition: reads.composition, geo: reads.geo }}
      qs={qs}
      isAdmin={isAdmin}
      findings={
        <Suspense fallback={<FindingsSkeleton />}>
          <Findings deferred={tilesWithDeltas} reads={reads} locale={locale} />
        </Suspense>
      }
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
