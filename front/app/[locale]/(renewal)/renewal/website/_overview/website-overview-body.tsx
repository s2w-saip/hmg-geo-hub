"use client";

// Renewal Website Overview body (2026-10-30, W1) — the original /website page's information, laid out so the KPI
// card's numbers can be read down to what makes them (Gold values only, nothing judged or added):
//   KPI              핵심 요약 + the website tiles by category              website-kpis.tsx
//   HMG 브랜드별 비교  each brand's tiles (administrators, no brand pick)      website-breakdowns.tsx
//   엔진별 비교       the engine rows behind 엔진 간 일관성                    website-breakdowns.tsx
//   출처별 구성비     top domains + 기타                                      website-sources.tsx
//   KPI 추이         every series on its own axis, answers and gaps per round website-trend.tsx
//   시장별 현황       map + every market value (one brand picked)              website-markets.tsx
// Screens: website/summary(-deferred) · brands · engines · composition · trend · geo (back/bff/screens/overview.py).
// A brand, engine or country row narrows the page to it through the filter panel.

import { Suspense, type ReactNode } from "react";
import { useLocale } from "next-intl";
import { RnCard, RnSkeleton, cx } from "@/components/renewal-ui";
import { DIMENSIONS } from "@/components/dash/dimension-filter-panel";
import type { CompositionView, TilesView, WebsiteGeoView, WebsiteTrendView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { useRnFilterToggle } from "../../_components/overview-filters";
import { RnWebsiteKpis } from "./website-kpis";
import { RnWebsiteBrands, RnWebsiteEngines } from "./website-breakdowns";
import { RnWebsiteSources } from "./website-sources";
import { RnWebsiteTrend } from "./website-trend";
import { RnWebsiteMarkets } from "./website-markets";
import { websiteDetailHref, type Failed, type WebsiteBrandsView, type WebsiteEnginesView } from "./website-format";

export interface WebsiteOverviewReads {
  /** website/summary-deferred: the tiles with Δ and the engine badge (the card-speed tiles when it failed). */
  deferred: Promise<TilesView>;
  brands: Promise<WebsiteBrandsView | Failed>;
  engines: Promise<WebsiteEnginesView>;
  trend: Promise<WebsiteTrendView | Failed>;
  composition: Promise<CompositionView>;
  /** null = this account does not see the GEO section (showsGeoMap). */
  geo: Promise<WebsiteGeoView | Failed> | null;
}

export function CardSkeleton({ rows, className }: { rows: number; className?: string }) {
  return (
    <RnCard className={cx("p-6", className)}>
      <RnSkeleton className="mb-4 h-4 w-40" />
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: rows }, (_, i) => (
          <RnSkeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    </RnCard>
  );
}

export function RnWebsiteOverviewBody({
  tiles,
  reads,
  qs,
  isAdmin,
  findings,
}: {
  tiles: TilesView;
  reads: WebsiteOverviewReads;
  qs: string;
  isAdmin: boolean;
  /** 핵심 요약 (a server section that waits for the breakdowns). */
  findings?: ReactNode;
}) {
  const locale = useLocale();
  const toggle = useRnFilterToggle();
  return (
    <>
      <RnWebsiteKpis tiles={tiles} deferred={reads.deferred} qs={qs} findings={findings} />
      <Suspense fallback={null}>
        <RnWebsiteBrands brands={reads.brands} total={reads.deferred} onPick={(b) => toggle("brand", b)} />
      </Suspense>
      <div className="@container/rnwrow">
        {/* the two cards end on one line (stretched to the taller) */}
        <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-stretch gap-2.5 @max-[1100px]/rnwrow:grid-cols-1">
          <Suspense fallback={<CardSkeleton rows={5} />}>
            {/* only the engines the panel offers (one outside its list would not show as picked there) */}
            <RnWebsiteEngines engines={reads.engines} onPick={(code) => toggle("engine", code)} pickable={(code) => DIMENSIONS.engine.includes(code)} />
          </Suspense>
          <Suspense fallback={<CardSkeleton rows={8} />}>
            <RnWebsiteSources composition={reads.composition} citationHref={websiteDetailHref("citationShare", locale, qs)} />
          </Suspense>
        </div>
      </div>
      <Suspense fallback={<CardSkeleton rows={6} />}>
        <RnWebsiteTrend trend={reads.trend} />
      </Suspense>
      {reads.geo ? (
        <Suspense fallback={<CardSkeleton rows={8} />}>
          <RnWebsiteMarkets geo={reads.geo} isAdmin={isAdmin} onPick={(code) => toggle("geography", code)} />
        </Suspense>
      ) : null}
    </>
  );
}
