"use client";

// Page state of the renewal AI Visibility page: the view tab (?view=, every tab reads the same
// screen model, so a tab is only the URL — no server round trip), the 측정 기간
// row of the filter panel, and the display helpers every card shares (number formats, engine
// labels and colours, site names). Display only: every value comes from the screen model.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { geoCodeLabel } from "@/lib/geo-catalog/geo-code-label";
import { RnSegmented, cx } from "@/components/renewal-ui";
import { useRnFilterRuntime } from "@/app/[locale]/(renewal)/renewal/_components/filter-runtime";
import type { VisChoice, VisRow, VisTab, VisView } from "../_data/screen-types";
import { VIS_TABS, tabQuery } from "../_data/tab";

const PRESETS = [7, 28, 90] as const;
// 엔진 colours in the screen's engine order (by AI 크롤): the validated renewal palette, grey beyond it.
const ENGINE_COLORS = ["#002c5f", "#1baf7a", "#eb6834", "#6250d6"];
export const CONTEXT_GREY = "#c9c3bb";
export const engineColor = (i: number) => ENGINE_COLORS[i] ?? CONTEXT_GREY;

// ── formats ──────────────────────────────────────────────────────────────────

export interface VisFmt {
  n: (v: number | null | undefined) => string;
  k: (v: number) => string;
  pct: (v: number | null | undefined, digits?: number) => string;
  rate: (v: number | null | undefined) => string;
  chg: (v: number | null | undefined) => string;
  pp: (v: number | null | undefined) => string;
  engine: (code: string) => string;
  site: (r: { country: string | null; brand: string | null }) => string;
  section: (sec: string) => string;
  page: (r: VisRow) => string;
}

export function useVisFmt(view: VisView | null): VisFmt {
  const locale = useLocale();
  const t = useTranslations("renewal.visibility");
  const tf = useTranslations("dashboard.filters");
  const multiBrand = view?.multiBrand ?? false;
  return useMemo<VisFmt>(() => {
    const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const flat = t("delta.flat");
    return {
      n: (v) => (v == null ? "—" : nf.format(Math.round(v))),
      k: (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M` : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "")}K` : String(Math.round(v))),
      pct: (v, digits = 1) => (v == null ? "—" : `${v.toFixed(digits)}%`),
      rate: (v) => (v == null ? "—" : v >= 100 ? nf.format(Math.round(v)) : v.toFixed(1)),
      chg: (v) => (v == null ? "—" : Math.abs(v) < 0.05 ? flat : `${v > 0 ? "▲" : "▼"}${Math.abs(v).toFixed(1)}%`),
      pp: (v) => (v == null ? "—" : Math.abs(v) < 0.05 ? flat : `${v > 0 ? "▲" : "▼"}${Math.abs(v).toFixed(1)}pp`),
      engine: (code) => ENGINE_LABEL[code] ?? (code ? code.charAt(0).toUpperCase() + code.slice(1) : code),
      site: (r) => {
        const c = r.country ? geoCodeLabel(r.country, locale, (x) => tf(`value.${x}` as "value.worldwide")) : t("site.unknown");
        return multiBrand && r.brand ? `${c} · ${r.brand}` : c;
      },
      section: (sec) => (sec === "/" ? t("section.root") : sec),
      page: (r) => r.title || r.path || r.url || "—",
    };
  }, [locale, multiBrand, t, tf]);
}

// ── page state: tab ────────────────────────────────────────────────

interface Ctx {
  tab: VisTab;
  setTab: (t: VisTab) => void;
}

const PageCtx = createContext<Ctx>({ tab: "sum", setTab: () => {} });

export function RnVisPageProvider({ initialTab, children }: { initialTab: VisTab; children: ReactNode }) {
  const [tab, setTabState] = useState<VisTab>(initialTab);
  // a server render with another ?view (back nav, a link) wins
  useEffect(() => setTabState(initialTab), [initialTab]);
  const setTab = useCallback((t: VisTab) => {
    setTabState(t);
    window.history.replaceState(null, "", `${window.location.pathname}${tabQuery(new URLSearchParams(window.location.search), t)}`);
    // a tab is another view: it starts from its top (no jump inside a view)
    document.querySelector("[data-rn-split] [data-rn-scroll]")?.scrollTo(0, 0);
  }, []);
  const value = useMemo(() => ({ tab, setTab }), [tab, setTab]);
  return <PageCtx.Provider value={value}>{children}</PageCtx.Provider>;
}

export function useVisPage(): Ctx {
  return useContext(PageCtx);
}


/** The tab rail atop the content column (the filter panel stands beside every tab). */
export function RnVisTabs({ view }: { view: VisView | null }) {
  const { tab, setTab } = useVisPage();
  const t = useTranslations("renewal.visibility.tabs");
  const pathname = usePathname();
  const search = useSearchParams();
  const fmt = useVisFmt(view);
  const value: Record<VisTab, ReactNode> = view
    ? {
        sum: t.rich("sumValue", { v: fmt.pct(view.totals.cov1, 0), b: (c) => <b className="font-semibold">{c}</b> }),
        page: t.rich("pageValue", { n: view.work.p12.length, b: (c) => <b className="font-semibold">{c}</b> }),
        engine: t.rich("engineValue", { n: view.engines.filter((e) => e.hits > 0).length, b: (c) => <b className="font-semibold">{c}</b> }),
        site: t.rich("siteValue", { sites: view.totals.sites, sections: view.sections.length, b: (c) => <b className="font-semibold">{c}</b> }),
      }
    : { sum: null, page: null, engine: null, site: null };
  const onPick = (k: VisTab) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (k !== tab) setTab(k);
  };
  return (
    <nav aria-label={t("label")} className="flex gap-x-8 overflow-x-auto border-b border-rn-line-2 px-1 [scrollbar-width:none]">
      {VIS_TABS.map((k) => {
        const on = k === tab;
        return (
          <a
            key={k}
            href={`${pathname}${tabQuery(new URLSearchParams(search.toString()), k)}`}
            onClick={onPick(k)}
            data-rn-tab={k}
            aria-current={on ? "page" : undefined}
            className={cx(
              "group/tab -mb-px flex flex-none cursor-pointer flex-col gap-0.5 px-0.5 pt-2 pb-3 transition-shadow focus-visible:rounded focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy",
              on ? "shadow-[inset_0_-3px_0_var(--color-rn-navy)]" : "shadow-[inset_0_-3px_0_transparent] hover:shadow-[inset_0_-3px_0_var(--color-rn-line-2)]",
            )}
          >
            <span className={cx("text-rn-15 leading-[1.4] font-semibold whitespace-nowrap", on ? "text-rn-ink" : "text-rn-muted group-hover/tab:text-rn-ink-2")}>{t(k)}</span>
            <span className={cx("flex min-h-[18px] items-baseline gap-1 text-rn-12 whitespace-nowrap tabular-nums", on ? "text-rn-ink" : "text-rn-muted")}>{value[k]}</span>
          </a>
        );
      })}
    </nav>
  );
}

// ── 측정 기간 (panel basis row): days, not rounds — the reader's days · from · to ──────

export function RnVisPeriod({ choice, period }: { choice: VisChoice; period: { from: string | null; to: string | null; days: number | null } }) {
  const t = useTranslations("renewal.visibility.period");
  const sp = useSearchParams();
  const { commit } = useRnFilterRuntime();
  const custom = choice.preset == null;
  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(sp.toString());
    for (const k of ["days", "from", "to"]) q.delete(k);
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    commit(q.toString(), { immediate: true });
  };
  const pick = (v: string) => {
    if (v === "custom") go({ from: period.from, to: period.to });
    else go({ days: v === "28" ? null : v });
  };
  return (
    <section aria-label={t("label")} className="flex flex-col gap-2 border-b border-rn-line px-4.5 pt-3 pb-3.5">
      <div className="flex items-center gap-1.5 text-rn-13 font-bold text-rn-ink">
        <CalendarDays className="size-3.5 text-rn-muted" aria-hidden />
        {t("label")}
        {custom && choice.days == null && period.days ? <span className="ml-auto text-rn-12 font-semibold text-rn-muted">{t("days", { n: period.days })}</span> : null}
      </div>
      <RnSegmented
        label={t("label")}
        className="flex [&>button]:flex-1"
        value={custom ? "custom" : String(choice.preset)}
        onChange={pick}
        items={[...PRESETS.map((d) => ({ value: String(d), label: t("days", { n: d }) })), { value: "custom", label: t("custom") }]}
      />
      {custom ? (
        <div className="grid grid-cols-2 gap-2">
          {(["from", "to"] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1 text-rn-11 font-semibold text-rn-muted">
              {t(k)}
              <input
                type="date"
                defaultValue={(k === "from" ? choice.from ?? period.from : choice.to ?? period.to) ?? ""}
                onChange={(e) => {
                  if (!e.target.value) return;
                  go({ from: k === "from" ? e.target.value : choice.from ?? period.from, to: k === "to" ? e.target.value : choice.to ?? period.to });
                }}
                className="h-8 min-w-0 rounded-lg border border-rn-line-2 bg-rn-surface px-2 text-rn-12 text-rn-ink focus:border-rn-navy focus:outline-none"
              />
            </label>
          ))}
        </div>
      ) : null}
      <p className="m-0 text-rn-11 break-keep text-rn-muted">{period.to ? t("help", { to: period.to }) : t("helpNoData")}</p>
    </section>
  );
}
