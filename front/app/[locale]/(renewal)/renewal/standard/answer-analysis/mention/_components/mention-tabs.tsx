"use client";

// The view rail of the renewal Mention page. Underline tabs (2026-10-22: KPI tiles and an
// attached-tab folder read as a KPI summary, so nobody took them for a switch): the tab name
// leads, the value and Δ ride along in small text.
//
// 2026-10-29 (the user's pick): the rail frames only what it switches. The four KPI tabs switch
// the analysis sections; 브랜드 상세 (mention counts and shares, no KPI) is a view of its own at
// the rail's end, behind a divider. The rail sits under 이번 회차 요약 (every KPI at once, so above
// the rail) and sticks under the page controls once scrolled to, so everything under it is the
// view it names. It used to head the content column and frame the whole page, which made the
// summary and 브랜드 상세 read as if they changed with the tab.
//
// A tab is a link (`?kpi=` the KPI tab, `?view=brands` 브랜드 상세; aria-current marks the view);
// a plain click swaps the body in place (every view reads the same data here). A switch with the
// rail stuck brings the new view's top under the rail, else the scroll stays.
//
// The provider sits above RnFilterSplit and holds the page's reads once for the rail and the body.

import { Suspense, createContext, use, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { RnSkeleton, cx } from "@/components/renewal-ui";
import { kpiTabQuery, type KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import { MENTION_VIEW_PARAM, type MentionView, type RnMentionInput } from "./mention-input";
import { posTxt } from "./mention-context";
import { useDeltaBasis } from "./mention-kit";

export const KPI_TABS: readonly KpiTab[] = ["exposure", "sov", "favorability", "first-rank"];
/** dashboard.kpi.question key of each tab (the tab's tooltip and the 현황과 추이 line). */
export const KPI_QUESTION: Record<KpiTab, string> = { exposure: "coverage", sov: "density", favorability: "favorability", "first-rank": "priority" };
export const KPI_TABS_ID = "rn-kpi-tabs";

interface PageCtx {
  input: RnMentionInput;
  kpi: KpiTab;
  view: MentionView;
  /** the KPI tab's view */
  setKpi: (k: KpiTab) => void;
  /** 브랜드 상세 (the KPI tab stays for the way back) */
  showBrands: () => void;
}

const Ctx = createContext<PageCtx | null>(null);

/** The rail link's query: the URL's params with the view's own swapped in. */
function viewQuery(current: URLSearchParams, view: MentionView, kpi: KpiTab): string {
  const next = new URLSearchParams(current.toString());
  if (view === "brands") {
    next.set(MENTION_VIEW_PARAM, "brands");
    const s = next.toString();
    return s ? `?${s}` : "";
  }
  next.delete(MENTION_VIEW_PARAM);
  return kpiTabQuery(next, kpi);
}

export function RnMentionPageProvider({ input, children }: { input: RnMentionInput; children: ReactNode }) {
  const [kpi, setKpiState] = useState<KpiTab>(input.kpi);
  const [view, setViewState] = useState<MentionView>(input.view);
  // a server render with another ?kpi / ?view (filter change, back nav) wins
  useEffect(() => setKpiState(input.kpi), [input.kpi]);
  useEffect(() => setViewState(input.view), [input.view]);
  // every view reads the same data on this page, so the view is only the URL (no server round trip)
  const go = useCallback((v: MentionView, k: KpiTab) => {
    window.history.replaceState(null, "", `${window.location.pathname}${viewQuery(new URLSearchParams(window.location.search), v, k)}`);
  }, []);
  const setKpi = useCallback(
    (k: KpiTab) => {
      setKpiState(k);
      setViewState("kpi");
      go("kpi", k);
    },
    [go],
  );
  const showBrands = useCallback(() => {
    setViewState("brands");
    go("brands", kpi);
  }, [go, kpi]);
  return <Ctx.Provider value={{ input, kpi, view, setKpi, showBrands }}>{children}</Ctx.Provider>;
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

const plainClick = (e: MouseEvent<HTMLAnchorElement>) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** The view rail under 이번 회차 요약: the four KPI tabs, then 브랜드 상세. */
export function RnMentionTabs() {
  const { kpi, view, setKpi, showBrands } = useMentionPage();
  const t = useTranslations("renewal.mention.tabs");
  const pathname = usePathname();
  const search = useSearchParams();
  const rail = useRail();
  const href = (v: MentionView, k: KpiTab) => `${pathname}${viewQuery(new URLSearchParams(search.toString()), v, k)}`;
  // modified clicks open the link as usual (new tab / window)
  const onKpi = (k: KpiTab) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    if (view === "kpi" && k === kpi) return;
    rail.keepTop();
    setKpi(k);
  };
  const onBrands = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    if (view === "brands") return;
    rail.keepTop();
    showBrands();
  };
  return (
    <TabRail rail={rail}>
      {KPI_TABS.map((k) => (
        <TabLink key={k} id={k} title={k} on={view === "kpi" && k === kpi} href={href("kpi", k)} onClick={onKpi(k)}>
          <Suspense fallback={<RnSkeleton className="h-3.5 w-16" />}>
            <TabValue k={k} />
          </Suspense>
        </TabLink>
      ))}
      <TabDivider />
      <TabLink id="brands" name={t("brands")} on={view === "brands"} href={href("brands", kpi)} onClick={onBrands}>
        {t("brandsHint")}
      </TabLink>
    </TabRail>
  );
}

/** The rail before the body's reads land (names only). */
export function RnMentionTabsFallback({ kpi, view }: { kpi: KpiTab; view: MentionView }) {
  const t = useTranslations("renewal.mention.tabs");
  return (
    <TabRail>
      {KPI_TABS.map((k) => (
        <TabLink key={k} id={k} title={k} on={view === "kpi" && k === kpi}>
          <RnSkeleton className="h-3.5 w-16" />
        </TabLink>
      ))}
      <TabDivider />
      <TabLink id="brands" name={t("brands")} on={view === "brands"}>
        {t("brandsHint")}
      </TabLink>
    </TabRail>
  );
}

interface Rail {
  nav: RefObject<HTMLElement | null>;
  mark: RefObject<HTMLDivElement | null>;
  /** where the rail sticks: right under the page controls (RnControlBar) */
  top: number;
  /** before a switch: a stuck rail takes the scroll back to where the new view starts */
  keepTop: () => void;
}

/** The rail sticks under the control bar, whose height follows its wrapping; `mark` holds the rail's own place. */
function useRail(): Rail {
  const nav = useRef<HTMLElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const bar = nav.current?.closest("[data-rn-scroll]")?.querySelector<HTMLElement>("[data-rn-cbar]");
    if (!bar) return;
    // the bar sticks at -top-1 (over the scroller's pt-1): its bottom edge is 4px short of its height
    const fit = () => setTop(bar.offsetHeight - 4);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);
  const keepTop = useCallback(() => {
    const el = nav.current;
    const scroller = el?.closest<HTMLElement>("[data-rn-scroll]");
    if (!el || !mark.current || !scroller) return;
    // how far the stuck rail sits below its own place (the rail's negative top margin takes back the column gap
    // after the mark, so in place it starts where the mark ends)
    const past = el.getBoundingClientRect().top - mark.current.getBoundingClientRect().bottom;
    if (past > 0) scroller.scrollTop -= past;
  }, []);
  return { nav, mark, top, keepTop };
}

function TabRail({ rail, children }: { rail?: Rail; children: ReactNode }) {
  const t = useTranslations("renewal.mention.tabs");
  return (
    <>
      <div ref={rail?.mark} aria-hidden />
      <nav
        ref={rail?.nav}
        id={KPI_TABS_ID}
        aria-label={t("label")}
        style={{ top: rail?.top ?? 0 }}
        className="sticky z-10 -mt-4 flex gap-x-8 overflow-x-auto border-b border-rn-line-2 bg-rn-page px-1 pt-1 [scrollbar-width:none] [.rn-dense_&]:-mt-2.5"
      >
        {children}
      </nav>
    </>
  );
}

function TabDivider() {
  return <span aria-hidden className="my-3 w-px flex-none bg-rn-line-2" />;
}

function TabLink({
  id,
  title,
  name,
  on,
  href,
  onClick,
  children,
}: {
  id: string;
  /** a KPI tab: its name and question tooltip come from the KPI */
  title?: KpiTab;
  name?: string;
  on: boolean;
  href?: string;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  const tTab = useTranslations("answerAnalysis.mentions.kpi.tabs");
  const tQ = useTranslations("dashboard.kpi.question");
  return (
    <a
      href={href}
      onClick={onClick}
      data-rn-tab={id}
      aria-current={on ? "page" : undefined}
      title={title ? tQ(KPI_QUESTION[title] as "coverage") : undefined}
      className={cx(
        "group/tab -mb-px flex flex-none cursor-pointer flex-col gap-0.5 px-0.5 pt-2 pb-3 transition-shadow focus-visible:rounded focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy",
        on ? "shadow-[inset_0_-3px_0_var(--color-rn-navy)]" : "shadow-[inset_0_-3px_0_transparent] hover:shadow-[inset_0_-3px_0_var(--color-rn-line-2)]",
      )}
    >
      <span className={cx("text-rn-15 leading-[1.4] font-semibold whitespace-nowrap", on ? "text-rn-ink" : "text-rn-muted group-hover/tab:text-rn-ink-2")}>{title ? tTab(title) : name}</span>
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
