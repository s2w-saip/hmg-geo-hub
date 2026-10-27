"use client";

// KPI page tabs of the renewal Mention page (2026-10-22). The KPI tiles and the attached-tab
// folder both read as a KPI summary, so nobody took them for a switch; back to the original's
// underline tabs: the tab name leads, the value and Δ ride along in small text. The rail heads
// the content column, right of the filter panel (2026-10-27: header › filter | tabs › content),
// so the filters read as covering every tab. A tab is a link (?kpi= is the source of truth,
// aria-current marks the page); a plain click swaps the body in place — every tab reads the
// same data here — and leaves the scroll position alone (no scroll jumps on the page).
//
// The provider sits above RnFilterSplit (the rail lives in its top slot, the body in the
// content scroller) and holds the page's reads once for both.

import { Suspense, createContext, use, useCallback, useContext, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { RnSkeleton, cx } from "@/components/renewal-ui";
import { kpiTabQuery, type KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import type { RnMentionInput } from "./mention-input";
import { posTxt } from "./mention-context";
import { useDeltaBasis } from "./mention-kit";

export const KPI_TABS: readonly KpiTab[] = ["exposure", "sov", "favorability", "first-rank"];
/** dashboard.kpi.question key of each tab (the tab's tooltip and the 현황과 추이 line). */
export const KPI_QUESTION: Record<KpiTab, string> = { exposure: "coverage", sov: "density", favorability: "favorability", "first-rank": "priority" };
export const KPI_TABS_ID = "rn-kpi-tabs";

interface PageCtx {
  input: RnMentionInput;
  kpi: KpiTab;
  setKpi: (k: KpiTab) => void;
}

const Ctx = createContext<PageCtx | null>(null);

export function RnMentionPageProvider({ input, children }: { input: RnMentionInput; children: ReactNode }) {
  const [kpi, setKpiState] = useState<KpiTab>(input.kpi);
  // a server render with another ?kpi (filter change, back nav) wins
  useEffect(() => setKpiState(input.kpi), [input.kpi]);
  const setKpi = useCallback((k: KpiTab) => {
    setKpiState(k);
    // every tab reads the same data on this page, so the tab is only the URL (no server round trip)
    window.history.replaceState(null, "", `${window.location.pathname}${kpiTabQuery(new URLSearchParams(window.location.search), k)}`);
  }, []);
  return <Ctx.Provider value={{ input, kpi, setKpi }}>{children}</Ctx.Provider>;
}

export function useMentionPage(): PageCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("RnMentionPageProvider missing");
  return c;
}

/** "AI 노출률 기준" — the KPI a tab-driven section shows. */
export function KpiBasisChip() {
  const { kpi } = useMentionPage();
  const t = useTranslations("renewal.mention.tabs");
  const tTab = useTranslations("answerAnalysis.mentions.kpi.tabs");
  return (
    <span data-rn-kchip="" className="inline-flex h-[22px] items-center self-center rounded-full bg-rn-surface px-2.5 text-rn-11 font-bold whitespace-nowrap text-rn-navy shadow-[inset_0_0_0_1px_rgba(0,44,95,0.2)]">
      {t("basis", { kpi: tTab(kpi) })}
    </span>
  );
}

/** Control-bar label: the KPI in view (read-only — the tabs above switch it). */
export function KpiViewLabel() {
  const { kpi } = useMentionPage();
  const t = useTranslations("renewal.mention.tabs");
  const tTab = useTranslations("answerAnalysis.mentions.kpi.tabs");
  return (
    <span data-rn-kview="" className="inline-flex h-7 items-center gap-1.5 rounded-full bg-rn-navy-25 px-3 text-rn-12 whitespace-nowrap text-rn-ink-2">
      {t("viewing")}
      <b className="text-rn-navy">{tTab(kpi)}</b>
    </span>
  );
}

/** The tab rail atop the content column. */
export function RnMentionTabs() {
  const { kpi, setKpi } = useMentionPage();
  const pathname = usePathname();
  const search = useSearchParams();
  const onPick = (k: KpiTab) => (e: MouseEvent<HTMLAnchorElement>) => {
    // modified clicks open the link as usual (new tab / window)
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (k !== kpi) setKpi(k);
  };
  return (
    <TabRail>
      {KPI_TABS.map((k) => (
        <TabLink key={k} k={k} on={k === kpi} href={`${pathname}${kpiTabQuery(new URLSearchParams(search.toString()), k)}`} onClick={onPick(k)}>
          <Suspense fallback={<RnSkeleton className="h-3.5 w-16" />}>
            <TabValue k={k} />
          </Suspense>
        </TabLink>
      ))}
    </TabRail>
  );
}

/** The rail before the filter options arrive (names only). */
export function RnMentionTabsFallback({ kpi }: { kpi: KpiTab }) {
  return (
    <TabRail>
      {KPI_TABS.map((k) => (
        <TabLink key={k} k={k} on={k === kpi}>
          <RnSkeleton className="h-3.5 w-16" />
        </TabLink>
      ))}
    </TabRail>
  );
}

function TabRail({ children }: { children: ReactNode }) {
  const t = useTranslations("renewal.mention.tabs");
  return (
    <nav id={KPI_TABS_ID} aria-label={t("label")} className="flex gap-x-8 overflow-x-auto border-b border-rn-line-2 px-1 [scrollbar-width:none]">
      {children}
    </nav>
  );
}

function TabLink({ k, on, href, onClick, children }: { k: KpiTab; on: boolean; href?: string; onClick?: (e: MouseEvent<HTMLAnchorElement>) => void; children: ReactNode }) {
  const tTab = useTranslations("answerAnalysis.mentions.kpi.tabs");
  const tQ = useTranslations("dashboard.kpi.question");
  return (
    <a
      href={href}
      onClick={onClick}
      data-rn-tab={k}
      aria-current={on ? "page" : undefined}
      title={tQ(KPI_QUESTION[k] as "coverage")}
      className={cx(
        "group/tab -mb-px flex flex-none cursor-pointer flex-col gap-0.5 px-0.5 pt-2 pb-3 transition-shadow focus-visible:rounded focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy",
        on ? "shadow-[inset_0_-3px_0_var(--color-rn-navy)]" : "shadow-[inset_0_-3px_0_transparent] hover:shadow-[inset_0_-3px_0_var(--color-rn-line-2)]",
      )}
    >
      <span className={cx("text-rn-15 leading-[1.4] font-semibold whitespace-nowrap", on ? "text-rn-ink" : "text-rn-muted group-hover/tab:text-rn-ink-2")}>{tTab(k)}</span>
      <span className={cx("flex min-h-[18px] items-baseline gap-1.5 text-rn-12 whitespace-nowrap tabular-nums", on ? "text-rn-ink" : "text-rn-muted")}>{children}</span>
    </a>
  );
}

// The value shows as soon as its own read lands; Δ waits for the trend reads.
function TabValue({ k }: { k: KpiTab }) {
  const { input } = useMentionPage();
  const { value } = use(input.tabValue[k]);
  const t = useTranslations("renewal.mention.rank");
  return (
    <>
      <b className="font-semibold">{value == null ? "—" : k === "first-rank" ? t("unit", { n: posTxt(value) }) : `${value.toFixed(1)}%`}</b>
      <Suspense fallback={null}>
        <TabDelta k={k} />
      </Suspense>
    </>
  );
}

// Δ as text, not a chip (a chip row reads as a KPI summary): arrow = direction, ink = better / worse.
function TabDelta({ k }: { k: KpiTab }) {
  const { input } = useMentionPage();
  const delta = use(input.tabDeltas)[k];
  const t = useTranslations("renewal.mention.delta");
  const tt = useTranslations("renewal.mention.tabs");
  const basis = useDeltaBasis()(delta);
  const d = delta.value;
  const rank = k === "first-rank";
  if (d == null) return <span title={t("none")}>−</span>;
  const r = Math.round(d * 10) / 10;
  const good = rank ? r < 0 : r > 0;
  const dir = r === 0 ? t("flat") : good ? t("up") : t("down");
  return (
    <span data-rn-tab-delta="" title={basis ? tt("deltaTitle", { dir, basis }) : dir} className={cx("font-medium", r === 0 ? "" : good ? "text-rn-up-ink" : "text-rn-danger-ink")}>
      {r === 0 ? t("flat") : `${r > 0 ? "▲" : "▼"}${Math.abs(r).toFixed(1)}${rank ? "" : "pp"}`}
    </span>
  );
}
