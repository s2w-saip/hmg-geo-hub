"use client";

import { Suspense, use } from "react";
import { useTranslations } from "use-intl";
import { RnCard, RnSectionHead, RnSkeleton } from "@/components/renewal-ui";
import type { ComparePartsScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/mention-screen";
import { BrandRanking } from "../../../../standard/answer-analysis/mention/_components/mention-brands";
import { ComparePicker, PerAnswerLine, SummarySkeleton } from "../../../../standard/answer-analysis/mention/_components/mention-body";
import { MentionProvider, useMention, type MentionCtx } from "../../../../standard/answer-analysis/mention/_components/mention-context";
import { Distribution, FavorHeroCard, Matrix } from "../../../../standard/answer-analysis/mention/_components/mention-favor";
import { CardSkeleton } from "../../../../standard/answer-analysis/mention/_components/mention-kit";
import { RankHeroCard } from "../../../../standard/answer-analysis/mention/_components/mention-rank";
import { HeroTrend, RateHero, Types } from "../../../../standard/answer-analysis/mention/_components/mention-rate";
import { KPI_QUESTION, KpiBasisChip, useMentionPage } from "../../../../standard/answer-analysis/mention/_components/mention-tabs";
import { RnSiteCards, type RnSiteCardsVM } from "./site-cards";
import { RnSiteCompare } from "./site-compare";
import { RnSiteEngines } from "./site-engines";
import { RnSiteMarkets, type RnMarketsVM } from "./site-markets";
import { RnSiteSummary } from "./site-summary";
import { RnWeeklyMentions, type RnWeeklyVM } from "./weekly-mentions";

// The renewal Website Mention (2026-11-02, docs/handoff/website-mention-redesign.md). Its prompts aim at our own pages, so
// 당사 leads every total and rival charts say little there; the page asks instead whether the AI names us, where we drop
// out and who appears in our place. The KPI cells pick what the sections under them show (`?kpi=`); 브랜드 상세 is the
// view of its own at their end (`?view=brands`), so nothing under the cells stays still when they switch.

export interface RnWebsiteMentionReads {
  cards: Promise<RnSiteCardsVM>;
  markets: Promise<RnMarketsVM>;
  weekly: Promise<RnWeeklyVM>;
  compare: Promise<ComparePartsScreen>;
}

export function RnWebsiteMentionBody({ reads, period, pageAsOf, admin }: { reads: RnWebsiteMentionReads; period: boolean; pageAsOf: Promise<string | null> | null; admin: boolean }) {
  const { view } = useMentionPage();
  return (
    <>
      <Suspense fallback={<SummarySkeleton />}>
        <RnSiteSummary markets={reads.markets} />
      </Suspense>
      <Suspense fallback={null}>
        <PerAnswerLine />
      </Suspense>
      <RnSiteCards cards={reads.cards} period={period} pageAsOf={pageAsOf} />
      {view === "brands" ? <BrandsView reads={reads} admin={admin} /> : <KpiView markets={reads.markets} />}
    </>
  );
}

/** The hero and its line read 당사 alone: rivals sit near 0 on this surface, the compare lines live under 브랜드 상세. */
function useOwnOnly(): MentionCtx {
  const ctx = useMention();
  return { ...ctx, pick: { auto: false, brands: [] } };
}

function KpiView({ markets }: { markets: Promise<RnMarketsVM> }) {
  const t = useTranslations("renewal.mention");
  const tw = useTranslations("renewal.website.mention.markets");
  const tQ = useTranslations("dashboard.kpi.question");
  const tF = useTranslations("answerAnalysis.mentions.kpi.favorability");
  const to = useTranslations("renewal.website.mention.ownTrend");
  const { kpi } = useMentionPage();
  const ownOnly = useOwnOnly();
  const rate = kpi === "exposure" || kpi === "sov";
  return (
    <>
      <RnSectionHead id="sec-overview" title={t("sec.overview")} chip={<KpiBasisChip />} desc={tQ(KPI_QUESTION[kpi] as "coverage")} />
      <MentionProvider value={ownOnly}>
        {rate ? (
          <RateHero metric={kpi} trendTitle={to(kpi)} />
        ) : (
          <RnCard aria-label={t(kpi === "favorability" ? "favor.label" : "rank.label")}>
            <Suspense fallback={<CardSkeleton height={300} />}>{kpi === "favorability" ? <FavorHeroCard /> : <RankHeroCard plain />}</Suspense>
          </RnCard>
        )}
      </MentionProvider>
      <RnSectionHead id="sec-markets" title={tw("title")} chip={<KpiBasisChip />} desc={tw("desc")} />
      <RnCard aria-label={tw("title")}>
        <Suspense fallback={<CardSkeleton height={380} />}>
          <Markets markets={markets} />
        </Suspense>
      </RnCard>
      {rate ? (
        <>
          <RnSectionHead id="sec-mix" title={t("sec.mix")} chip={<KpiBasisChip />} desc={t("sec.mixDesc")} />
          <div className="grid grid-cols-1 gap-4 @min-[1100px]/rnpage:grid-cols-2">
            <RnCard>
              <Suspense fallback={<CardSkeleton height={240} />}>
                <RnSiteEngines metric={kpi} />
              </Suspense>
            </RnCard>
            <RnCard aria-label={t(kpi === "sov" ? "type.titleSov" : "type.titleExposure")}>
              <Suspense fallback={<CardSkeleton height={240} />}>
                <Types metric={kpi} initialView="own" picker={<ComparePicker />} />
              </Suspense>
            </RnCard>
          </div>
        </>
      ) : kpi === "favorability" ? (
        <>
          <RnSectionHead id="sec-comp" title={t("sec.favDist")} chip={<KpiBasisChip />} desc={t("sec.favDistDesc")} />
          <RnCard aria-label={tF("dist.title")}>
            <Suspense fallback={<CardSkeleton height={200} />}>
              <Distribution />
            </Suspense>
          </RnCard>
          <RnSectionHead id="sec-mix" title={t("sec.favMix")} chip={<KpiBasisChip />} desc={t("sec.favMixDesc")} />
          <RnCard aria-label={tF("matrix.title")}>
            <Suspense fallback={<CardSkeleton height={280} />}>
              <Matrix />
            </Suspense>
          </RnCard>
        </>
      ) : null}
    </>
  );
}

function Markets({ markets }: { markets: Promise<RnMarketsVM> }) {
  return <RnSiteMarkets vm={use(markets)} />;
}

function BrandsView({ reads, admin }: { reads: RnWebsiteMentionReads; admin: boolean }) {
  const t = useTranslations("renewal.mention");
  const tc = useTranslations("renewal.website.mention.compare");
  const { kpi } = useMentionPage();
  return (
    <>
      <RnSectionHead id="sec-brands" title={t("sec.brands")} desc={t("sec.brandsDesc")} />
      <RnCard aria-label={tc("title")}>
        <RnSiteCompare initial={reads.compare} admin={admin} />
      </RnCard>
      <RnCard aria-label={tc("trendTitle")}>
        <div className="flex flex-col gap-2 px-4.5 py-3.5">
          <Suspense fallback={<RnSkeleton className="h-[260px] w-full" />}>
            <HeroTrend metric={kpi === "sov" ? "sov" : "exposure"} />
          </Suspense>
        </div>
      </RnCard>
      <RnCard aria-label={t("brands.title")}>
        <Suspense fallback={<CardSkeleton height={420} />}>
          <BrandRanking tableOnly />
        </Suspense>
      </RnCard>
      <RnWeeklyMentions weekly={reads.weekly} />
    </>
  );
}
