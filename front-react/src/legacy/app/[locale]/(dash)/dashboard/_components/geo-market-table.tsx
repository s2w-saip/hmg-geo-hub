"use client";

// The renewal Overview's 시장별 현황 table (2026-11-05, D-12, the user's '본 프로젝트에 개발 시작' on the fixed mockup
// the D-12 mockup, removed once built: `git show f9c0fcd:docs/design/ui/market-heatmap-mockup.html`). One row per region › country with all five KPIs, the answers and the
// market's top rival on the picked KPI. The column heads pick the KPI (the map's and the sort's; the legacy KPI chips
// merged into them), the same head again flips the sort. Only the picked column is drawn: its bar starts at zero (a
// rate's own value, a rank 1번째 = full), so a small gap stays small. 권역별 keeps the region tree (regions start
// closed); 국가 전체 lists every country in the sort order. The view lives in the URL (?mkt · mktDir · mktView).
// 브랜드 포함 (step 2): each market's share of answers from branded prompts, so two markets are read with their prompt mix.
// 근거 (step 3): a KPI value is a button that opens the answers behind it (geo-market-evidence.tsx).
// The original /dashboard keeps its own table (geo-overview.tsx).

import { Fragment, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { SquareMinus, SquarePlus } from "lucide-react";
import { cx } from "@/components/renewal-ui";
import type { GeoCountryView, GeoRegionView } from "../_data/screen-types";
import { OVERVIEW_KPI_KEYS, type OverviewKpiKey } from "../_data/overview-metrics";

/** best = the better values first (the rank's lower first), worst = the other way. */
export type MarketSortDir = "best" | "worst";
export type MarketLayout = "region" | "flat";
export interface MarketView {
  metric: OverviewKpiKey;
  dir: MarketSortDir;
  layout: MarketLayout;
}
export const DEFAULT_MARKET_VIEW: MarketView = { metric: "visibility", dir: "best", layout: "region" };

const PARAM = { metric: "mkt", dir: "mktDir", layout: "mktView" } as const;

/** The view a URL asks for; anything unknown falls back to the default. */
export function marketViewOf(search: URLSearchParams): MarketView {
  const metric = search.get(PARAM.metric);
  return {
    metric: (OVERVIEW_KPI_KEYS as readonly string[]).includes(metric ?? "") ? (metric as OverviewKpiKey) : DEFAULT_MARKET_VIEW.metric,
    dir: search.get(PARAM.dir) === "worst" ? "worst" : "best",
    layout: search.get(PARAM.layout) === "flat" ? "flat" : "region",
  };
}

/** The URL query with the view in it (defaults left out), the other parameters kept. */
export function marketViewQuery(search: URLSearchParams, view: MarketView): string {
  const next = new URLSearchParams(search);
  const set = (k: string, v: string, dflt: string) => (v === dflt ? next.delete(k) : next.set(k, v));
  set(PARAM.metric, view.metric, DEFAULT_MARKET_VIEW.metric);
  set(PARAM.dir, view.dir, DEFAULT_MARKET_VIEW.dir);
  set(PARAM.layout, view.layout, DEFAULT_MARKET_VIEW.layout);
  const s = next.toString();
  return s ? `?${s}` : "";
}

/** The next view after a column head is pressed: a new KPI starts best-first, the same KPI flips. */
export function pickColumn(view: MarketView, metric: OverviewKpiKey): MarketView {
  return view.metric === metric ? { ...view, dir: view.dir === "best" ? "worst" : "best" } : { ...view, metric, dir: "best" };
}

/** Rows in the view's order on its KPI; rows without a value go last, ties keep their order. */
export function sortMarketRows<T extends { values: Record<OverviewKpiKey, number | null> }>(rows: readonly T[], view: MarketView): T[] {
  const sign = view.dir === "best" ? 1 : -1;
  const better = (a: number, b: number) => (view.metric === "position" ? a - b : b - a);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      const a = x.r.values[view.metric];
      const b = y.r.values[view.metric];
      if (a == null || b == null) return a == null && b == null ? x.i - y.i : a == null ? 1 : -1;
      return sign * better(a, b) || x.i - y.i;
    })
    .map((x) => x.r);
}

/** The picked column's bar from zero: a rate's own value, a rank 1 ÷ value (1번째 = full). */
export function marketBarPct(metric: OverviewKpiKey, v: number | null): number {
  if (v == null) return 0;
  if (metric === "position") return Math.max(4, Math.min(100, (1 / Math.max(v, 1)) * 100));
  return Math.max(0, Math.min(100, v));
}

/** aria-sort of the picked head: the data's order (the rank's best-first is ascending numbers). */
export function marketAriaSort(view: MarketView): "ascending" | "descending" {
  const ascending = view.metric === "position" ? view.dir === "best" : view.dir === "worst";
  return ascending ? "ascending" : "descending";
}

export function GeoMarketTable({
  markets,
  view,
  onView,
  open,
  onToggle,
  label,
  countryLabel,
  activeCountry,
  onCountryHover,
  onEvidence,
}: {
  markets: GeoRegionView[];
  view: MarketView;
  onView: (v: MarketView) => void;
  open: Set<string>;
  onToggle: (region: string) => void;
  label: (region: string) => string;
  countryLabel: (code: string) => string;
  activeCountry: string | null;
  onCountryHover: (code: string | null) => void;
  /** a KPI value pressed: the row (a region row or a country row), the KPI and the pressed number (focus returns to it) */
  onEvidence?: (row: GeoRegionView | GeoCountryView, kpi: OverviewKpiKey, opener: HTMLElement) => void;
}) {
  const t = useTranslations("renewal.overview.markets");
  const tKpi = useTranslations("dashboard.kpi.name");
  const tShort = useTranslations("renewal.overview.short");
  const tUnit = useTranslations("metricUnit");
  const tGeo = useTranslations("dashboard.overview.geo");
  const fmt = (k: OverviewKpiKey, v: number | null) => (v == null ? "—" : k === "position" ? tUnit("position", { n: v.toFixed(1) }) : `${v.toFixed(1)}%`);
  const flat = view.layout === "flat";
  // the 브랜드 포함 column when the screen sent it (not under a 브랜드 포함 여부 pick)
  const mix = markets.some((m) => m.brandedShare !== undefined);
  const rows = flat ? sortMarketRows(markets.flatMap((m) => m.countries.map((c) => ({ ...c, region: m.region }))), view) : null;

  const cells = (u: GeoRegionView | GeoCountryView, region: boolean) => {
    const rival = u.rivals[view.metric];
    return (
      <>
        <td className="border-b border-rn-line px-2 text-right text-rn-muted tabular-nums">{u.answers != null ? u.answers.toLocaleString("ko-KR") : "—"}</td>
        {mix ? <td data-rn-mkt-mix="" className="border-b border-rn-line px-2 text-right text-rn-muted tabular-nums">{u.brandedShare != null ? `${u.brandedShare.toFixed(1)}%` : "—"}</td> : null}
        {OVERVIEW_KPI_KEYS.map((k) => {
          const v = u.values[k];
          const picked = k === view.metric;
          // the number opens its 근거 (the number stays as it is: a dotted underline and the pointer on hover)
          const value =
            onEvidence && v != null ? (
              <button
                type="button"
                data-rn-mkt-evidence={k}
                title={t("cellTip", { name: tKpi(k) })}
                aria-label={`${tKpi(k)} ${fmt(k, v)} — ${t("cellTip", { name: tKpi(k) })}`}
                onClick={(e) => onEvidence(u, k, e.currentTarget)}
                className="cursor-pointer rounded-[3px] decoration-dotted underline-offset-[3px] hover:underline focus-visible:outline-2 focus-visible:outline-rn-navy"
              >
                {fmt(k, v)}
              </button>
            ) : (
              fmt(k, v)
            );
          return (
            <td key={k} data-rn-mkt-cell={k} className={cx("border-b border-rn-line px-2 text-right tabular-nums", picked ? "font-bold text-rn-ink" : region ? "font-semibold text-rn-ink-2" : "text-rn-ink-2")}>
              {picked ? (
                <span className="inline-flex items-center justify-end gap-1.5">
                  {value}
                  <span className="inline-block h-[5px] w-11 shrink-0 overflow-hidden rounded-[2px] bg-rn-page">
                    <i className="block h-full rounded-[2px] bg-rn-navy" style={{ width: `${marketBarPct(k, v).toFixed(1)}%` }} />
                  </span>
                </span>
              ) : (
                value
              )}
            </td>
          );
        })}
        <td className="truncate border-b border-rn-line px-2 pr-3 text-right text-rn-muted" title={rival ? `${rival.name} ${fmt(view.metric, rival.value)}` : undefined}>
          {rival ? (
            <>
              <b className="mr-1 font-semibold text-rn-ink-2">{rival.name}</b>
              <span className="tabular-nums">{fmt(view.metric, rival.value)}</span>
            </>
          ) : (
            tGeo("noRival")
          )}
        </td>
      </>
    );
  };

  const countryRow = (c: GeoCountryView, name: ReactNode) => (
    <tr
      key={c.code}
      tabIndex={0}
      data-geo-country={c.code}
      data-highlighted={activeCountry === c.code ? "true" : undefined}
      onMouseEnter={() => onCountryHover(c.code)}
      onMouseLeave={() => onCountryHover(null)}
      onFocus={() => onCountryHover(c.code)}
      onBlur={() => onCountryHover(null)}
      className={cx("h-[34px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy", activeCountry === c.code && "bg-rn-navy-25")}
    >
      <th scope="row" className={cx("truncate border-b border-rn-line pr-2 text-left font-normal text-rn-ink-2", flat ? "pl-3" : "pl-8")}>
        {name}
      </th>
      {cells(c, false)}
    </tr>
  );

  return (
    <table className="w-full table-fixed border-separate border-spacing-0 text-rn-12" data-geo-table="" data-rn-market-table={view.layout}>
      <colgroup>
        <col className={flat ? "w-[118px]" : "w-[126px]"} />
        <col className="w-[50px]" />
        {mix ? <col className="w-[64px]" /> : null}
        {OVERVIEW_KPI_KEYS.map((k) => (
          <col key={k} className={k === view.metric ? "w-[98px]" : "w-[58px]"} />
        ))}
        <col className="w-[112px]" />
      </colgroup>
      <thead className="sticky top-0 z-10">
        <tr className="text-rn-11 text-rn-ink-2">
          <th scope="col" className="h-[30px] border-b border-rn-line bg-rn-head pl-3 text-left font-semibold">{flat ? t("colCountry") : t("colRegion")}</th>
          <th scope="col" className="border-b border-rn-line bg-rn-head px-2 text-right font-semibold">{t("colAnswers")}</th>
          {mix ? (
            <th scope="col" title={t("colMixTip")} className="border-b border-rn-line bg-rn-head px-2 text-right font-semibold whitespace-nowrap">
              {t("colMix")}
            </th>
          ) : null}
          {OVERVIEW_KPI_KEYS.map((k) => {
            const picked = k === view.metric;
            return (
              <th
                key={k}
                scope="col"
                aria-sort={picked ? marketAriaSort(view) : "none"}
                className={cx("border-b border-rn-line bg-rn-head px-2 text-right font-semibold", picked && "text-rn-navy shadow-[inset_0_-2px_0_var(--color-rn-navy)]")}
              >
                <button
                  type="button"
                  data-rn-mkt-head={k}
                  title={t("headTip", { name: tKpi(k) })}
                  onClick={() => onView(pickColumn(view, k))}
                  className="cursor-pointer rounded-[3px] whitespace-nowrap hover:text-rn-navy hover:underline hover:underline-offset-[3px] focus-visible:outline-2 focus-visible:outline-rn-navy"
                >
                  {tShort(k)}
                  {picked ? <span aria-hidden className="ml-0.5 text-[9px]">{view.dir === "best" ? "▼" : "▲"}</span> : null}
                </button>
              </th>
            );
          })}
          <th scope="col" className="border-b border-rn-line bg-rn-head px-2 pr-3 text-right font-semibold">{tGeo("colRival")}</th>
        </tr>
      </thead>
      <tbody>
        {flat
          ? rows!.map((c) => countryRow(c, <>{countryLabel(c.code)}<span className="ml-1.5 text-rn-11 text-rn-muted">{label(c.region)}</span></>))
          : markets.map((m) => {
              const isOpen = open.has(m.region);
              return (
                <Fragment key={m.region}>
                  <tr className="h-[34px] bg-rn-navy-25" data-geo-region={m.region}>
                    <th scope="row" className="border-b border-rn-line pl-3 text-left font-bold text-rn-ink">
                      <button type="button" onClick={() => onToggle(m.region)} aria-expanded={isOpen} className="inline-flex items-center gap-1.5">
                        {isOpen ? <SquareMinus className="h-3 w-3" aria-hidden /> : <SquarePlus className="h-3 w-3" aria-hidden />}
                        {label(m.region)}
                        <span className="text-rn-11 font-medium text-rn-muted">{t("countries", { n: m.countries.length })}</span>
                      </button>
                    </th>
                    {cells(m, true)}
                  </tr>
                  {isOpen ? sortMarketRows(m.countries, view).map((c) => countryRow(c, countryLabel(c.code))) : null}
                </Fragment>
              );
            })}
      </tbody>
    </table>
  );
}
