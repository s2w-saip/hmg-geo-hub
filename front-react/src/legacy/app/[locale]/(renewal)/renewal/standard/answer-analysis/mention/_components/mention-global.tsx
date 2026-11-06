import { replaceUiHistory } from "~/app/navigation";
"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useSearchParams } from "~/app/navigation";
import { RnCard, cx } from "@/components/renewal-ui";
import { useCompare, useMention } from "./mention-context";
import { CardSkeleton, Legend } from "./mention-kit";
import { ComparePicker } from "./mention-body";
import { Types } from "./mention-rate";
import { GlobalTrendGrid } from "./mention-global-trends";
import { GlobalCompareTrends } from "./mention-global-compare";
import { GlobalBrandBoard } from "./mention-global-board";
import { GlobalEngines, GlobalSentiment, GlobalTypesOwn } from "./mention-global-own";
import { ReadSection } from "~/components/read-section";

// Global Mention (2026-11-05 개편, docs/handoff/global-mention-redesign.md; the user picked the tab version of the mockup):
// a bar that stays on top with the tabs 당사 지표 | 경쟁 비교 — the compare brands and their legend live on the comparison
// tab — and each tab's cards. 당사 지표: the four KPIs' trend cards, engines, sentiment and types; 경쟁 비교: the KPIs per
// round beside the compare brands, the brand standings and the share inside each mention type. Same reads, same
// drawers and CSVs as the KPI tabs it replaces (the legacy values all stay; the inventory is in that doc).

export type GlobalTab = "own" | "cmp";
const TAB_PARAM = "tab";

export function GlobalMentionBody() {
  const t = useTranslations("renewal.mention");
  const { ownSum } = useMention();
  // `?tab=cmp` opens the comparison tab (a copied link keeps it); 당사 지표 is the landing tab
  const sp = useSearchParams();
  const [tab, setTab] = useState<GlobalTab>(resolveGlobalTab(sp.get(TAB_PARAM)));
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === "cmp") url.searchParams.set(TAB_PARAM, "cmp");
    else url.searchParams.delete(TAB_PARAM);
    replaceUiHistory(window.history.state, "", url);
  }, [tab]);
  return (
    <>
      <TabBar tab={tab} onTab={setTab}>
        {tab === "cmp" ? (
          <ReadSection names={["compare"]} label={t("compare.label")} loading={null}><Suspense fallback={null}>
            <span className="border-l border-rn-line pl-4">
              <CompareLegend />
            </span>
            <span className="ml-auto">
              <ComparePicker />
            </span>
          </Suspense></ReadSection>
        ) : ownSum.length > 1 ? (
          <span className="ml-auto text-rn-12 text-rn-muted">{t("hero.ownSum", { brands: ownSum.join("+") })}</span>
        ) : null}
      </TabBar>
      {tab === "own" ? <OwnTab /> : <CompareTab />}
    </>
  );
}

const resolveGlobalTab = (raw: string | null): GlobalTab => (raw === "cmp" ? "cmp" : "own");

/** The bar while the page reads: the same tabs, inert. */
export function GlobalTabsFallback() {
  const sp = useSearchParams();
  return <TabBar tab={resolveGlobalTab(sp.get(TAB_PARAM))} />;
}

function TabBar({ tab, onTab, children }: { tab: GlobalTab; onTab?: (tab: GlobalTab) => void; children?: ReactNode }) {
  const t = useTranslations("renewal.mention");
  const tabs: Array<{ value: GlobalTab; label: string }> = [
    { value: "own", label: t("g.tabOwn") },
    { value: "cmp", label: t("g.tabCmp") },
  ];
  return (
    <div role="region" aria-label={t("bar.label")} data-rn-gbar="" className="sticky -top-4 z-20 -mx-[var(--rn-edge)] flex h-14 items-center gap-4 bg-rn-surface px-[var(--rn-edge)] shadow-[0_1px_0_var(--color-rn-line)]">
      <div role="tablist" aria-label={t("g.tabsLabel")} className="flex h-full items-stretch gap-1">
        {tabs.map((it) => (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={tab === it.value}
            data-rn-gtab={it.value}
            disabled={!onTab}
            onClick={() => onTab?.(it.value)}
            className={cx(
              "cursor-pointer px-3.5 text-rn-15 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-rn-navy disabled:cursor-default",
              tab === it.value ? "font-semibold text-rn-ink shadow-[inset_0_-2px_0_var(--color-rn-navy)]" : "font-medium text-rn-muted hover:text-rn-ink",
            )}
          >
            {it.label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

function CompareLegend() {
  const { ownLabel } = useMention();
  const { compare, colorOf } = useCompare();
  return <Legend shape="dot" items={[{ key: "__own", name: ownLabel, color: colorOf("__own"), own: true }, ...compare.map((b) => ({ key: b, name: b, color: colorOf(b) }))]} />;
}

function OwnTab() {
  const t = useTranslations("renewal.mention");
  return (
    <div data-rn-gpane="own" className="flex flex-col gap-4">
      <div id="sec-g-trends">
        <ReadSection names={["rateValue", "rateHero", "favorHero", "rank", "presence", "compare"]} label={t("g.tabOwn")} loading={<CardSkeleton height={280} />}><GlobalTrendGrid /></ReadSection>
      </div>
      <div className="grid grid-cols-1 gap-4 @min-[1100px]/rncontent:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <RnCard id="sec-g-engines" aria-label={t("g.enginesTitle")}>
          <ReadSection names={["rateEngines", "engineExtra"]} label={t("g.enginesTitle")} loading={<CardSkeleton height={280} />}><Suspense fallback={<CardSkeleton height={280} />}>
            <GlobalEngines />
          </Suspense></ReadSection>
        </RnCard>
        <RnCard id="sec-g-sent" aria-label={t("g.sentTitle")}>
          <ReadSection names={["favorDist"]} label={t("g.sentTitle")} loading={<CardSkeleton height={280} />}><Suspense fallback={<CardSkeleton height={280} />}>
            <GlobalSentiment />
          </Suspense></ReadSection>
        </RnCard>
      </div>
      <RnCard id="sec-g-types" aria-label={t("g.typesTitle")}>
        <ReadSection names={["rateTypes", "favorMatrix"]} label={t("g.typesTitle")} loading={<CardSkeleton height={340} />}><Suspense fallback={<CardSkeleton height={340} />}>
          <GlobalTypesOwn />
        </Suspense></ReadSection>
      </RnCard>
    </div>
  );
}

function CompareTab() {
  const t = useTranslations("renewal.mention");
  return (
    <div data-rn-gpane="cmp" className="flex flex-col gap-4">
      <RnCard id="sec-g-cmp" aria-label={t("g.cmpTitle")}>
        <ReadSection names={["compare", "rateHero", "rank"]} label={t("g.cmpTitle")} loading={<CardSkeleton height={380} />}><Suspense fallback={<CardSkeleton height={380} />}>
          <GlobalCompareTrends />
        </Suspense></ReadSection>
      </RnCard>
      <RnCard id="sec-g-board" aria-label={t("g.boardTitle")}>
        <ReadSection names={["compare", "ranking", "rateHero", "bump", "rank", "rateValue", "favorHero"]} label={t("g.boardTitle")} loading={<CardSkeleton height={460} />}><Suspense fallback={<CardSkeleton height={460} />}>
          <GlobalBrandBoard />
        </Suspense></ReadSection>
      </RnCard>
      {/* the share inside each mention type beside the compare brands: the original share tab's card as is */}
      <RnCard id="sec-g-typecmp" aria-label={t("type.titleSov")}>
        <ReadSection names={["compare", "rateTypes"]} label={t("type.titleSov")} loading={<CardSkeleton height={360} />}><Suspense fallback={<CardSkeleton height={360} />}>
          <Types metric="sov" />
        </Suspense></ReadSection>
      </RnCard>
    </div>
  );
}
