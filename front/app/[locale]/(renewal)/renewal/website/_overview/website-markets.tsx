"use client";

// Renewal Website Overview — 시장별 현황 (website/geo, one brand picked): the map coloured by one KPI beside one table
// of every market value the screen sends, so nothing is behind a switch —
//   권역 / 국가 · 답변 · 당사 순위 (hmgRank / fieldSize) · the five KPIs (당사 value; under it the value of the market's
//   top-share rival, the one rival website/geo names per market) · 선두 브랜드 (topBrand, only when it is not 당사:
//   showLead, as the original page)
// The original page's 시장별 경쟁 위치 (점유율, rank badge, 선두) and the renewal Overview's KPI switch, in one.
// A column head picks the map's KPI and orders the countries of each market by it (better first); a country
// row narrows the page to it. Order and colours are display only: every value is the screen's.

import { use, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { RnCard, RnCardHeader, RnEmpty, cx } from "@/components/renewal-ui";
import { GeoMapLazy } from "@/app/[locale]/(dash)/dashboard/_components/geo-map-lazy";
import { OVERVIEW_KPI_KEYS, type OverviewKpiKey } from "@/app/[locale]/(dash)/dashboard/_data/overview-metrics";
import type { GeoCountryView, GeoRegionView, GeoView, WebsiteGeoView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { geoCodeLabel } from "@/lib/geo-catalog/geo-code-label";
import { rhqLabel } from "@/lib/rhq";
import { unitOf, useFormat, useShortName, type Failed } from "./website-format";
import type { PickRow } from "./website-breakdowns";

/** Countries of a market in the picked KPI's order, better first (rank: lower first), no value last; null = screen order. */
export function orderCountries(countries: readonly GeoCountryView[], metric: OverviewKpiKey | null): GeoCountryView[] {
  if (!metric) return [...countries];
  const dir = metric === "position" ? 1 : -1;
  return [...countries].sort((a, b) => {
    const x = a.values[metric];
    const y = b.values[metric];
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return dir * (x - y);
  });
}

/**
 * The markets of one brand. Without one brand (the screen answers no markets) an administrator is told to pick
 * one; the other accounts have no brand axis on the website, as on the original page.
 */
export function RnWebsiteMarkets({ geo, isAdmin, onPick }: { geo: Promise<WebsiteGeoView | Failed>; isAdmin: boolean; onPick?: PickRow }) {
  const t = useTranslations("renewal.website.overview");
  const tR = useTranslations("renewal.overview");
  const v = use(geo);
  if (v !== "failed" && !v.show) return null;
  if (v === "failed" || v.degraded)
    return (
      <RnCard aria-label={tR("marketsTitle")}>
        <RnCardHeader title={tR("marketsTitle")} />
        <RnEmpty className="mx-6 mb-5">{t("marketsFailed")}</RnEmpty>
      </RnCard>
    );
  if (v.geo.markets.length === 0 && v.geo.pending.length === 0) {
    return isAdmin ? (
      <RnCard aria-label={tR("marketsTitle")}>
        <RnCardHeader title={tR("marketsTitle")} />
        <RnEmpty className="mx-6 mb-5">{t("marketsPickBrand")}</RnEmpty>
      </RnCard>
    ) : null;
  }
  return <MarketsTable geo={v.geo} onPick={onPick} />;
}

export function MarketsTable({ geo, onPick }: { geo: GeoView; onPick?: PickRow }) {
  const t = useTranslations("renewal.website.overview");
  const tR = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const tK = useTranslations("dashboard.kpi.name");
  const tf = useTranslations("dashboard.filters");
  const short = useShortName();
  const f = useFormat();
  const locale = useLocale();
  // 선두 브랜드 shows when a market's lead is not 당사 (showLead); with one brand picked it usually never is
  const lead = geo.markets.some((m) => m.showLead || m.countries.some((c) => c.showLead));
  // starts on 점유율 in the screen's order, as the original page (its map and list read the brand's SOV)
  const [metric, setMetric] = useState<OverviewKpiKey>("shareOfVoice");
  const [ordered, setOrdered] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const label = (id: string) => (id ? (rhqLabel(id, locale === "en" ? "en" : "ko") ?? id) : tO("geo.unassignedRegion"));
  const markets = useMemo(
    () => geo.markets.map((m) => ({ ...m, countries: orderCountries(m.countries, ordered ? metric : null) })),
    [geo.markets, metric, ordered],
  );
  const regionOf = useMemo(() => new Map(geo.markets.flatMap((m) => m.countries.map((c) => [c.code, m.region] as const))), [geo.markets]);
  const pick = (k: OverviewKpiKey) => {
    setMetric(k);
    setOrdered(true);
  };
  const onMapHover = (code: string | null) => {
    setActive(code);
    const region = code ? regionOf.get(code) : undefined;
    if (region !== undefined) setClosed((cur) => (cur.has(region) ? new Set([...cur].filter((r) => r !== region)) : cur));
  };
  const rankText = (m: GeoRegionView | GeoCountryView) => (m.noMentions ? "—" : t("rankOf", { rank: m.hmgRank, count: m.fieldSize }));
  return (
    <RnCard aria-label={tR("marketsTitle")}>
      <RnCardHeader title={tR("marketsTitle")} hint={t("marketsHint", { brand: geo.ourLabel })} />
      <div className="grid grid-cols-[minmax(0,0.6fr)_minmax(0,1.7fr)] items-start gap-4 px-6 pb-5 @max-[1100px]/rnpage:grid-cols-1">
        <div className="min-w-0" data-rn-market-map={metric}>
          <span className="mb-1 block text-rn-12 font-semibold text-rn-ink-2">{t("mapOf", { kpi: tK(metric), brand: geo.ourLabel })}</span>
          <GeoMapLazy geo={geo} metric={metric} metricLabel={tK(metric)} bare level="country" domain={geo.domains[metric] ?? undefined} activeCountry={active} onCountryHover={onMapHover} />
          {geo.pending.length ? (
            <p className="m-0 mt-2 text-rn-12 text-rn-muted" data-rn-pending="">
              {t("pendingRegions", { regions: geo.pending.map(label).join(" · ") })}
            </p>
          ) : null}
        </div>
        <div className="max-h-[560px] min-w-0 overflow-auto overscroll-contain rounded-[10px] shadow-[inset_0_0_0_1px_var(--color-rn-line)]" data-rn-market-table="">
          <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-0 text-rn-12">
            <colgroup>
              <col className="w-[128px]" />
              <col className="w-[52px]" />
              <col className="w-[70px]" />
              {OVERVIEW_KPI_KEYS.map((k) => (
                <col key={k} />
              ))}
              {lead ? <col className="w-[104px]" /> : null}
            </colgroup>
            <thead className="sticky top-0 z-[1]">
              <tr className="text-left text-rn-muted">
                <th scope="col" className="border-b border-rn-line bg-rn-head py-2 pr-2 pl-3 font-semibold">{t("colMarket")}</th>
                <th scope="col" className="border-b border-rn-line bg-rn-head px-2 py-2 text-right font-semibold">{t("colAnswers")}</th>
                <th scope="col" title={t("rankTitle", { brand: geo.ourLabel })} className="border-b border-rn-line bg-rn-head px-2 py-2 font-semibold">{t("colRank")}</th>
                {OVERVIEW_KPI_KEYS.map((k) => (
                  <th key={k} scope="col" aria-sort={ordered && metric === k ? (k === "position" ? "ascending" : "descending") : undefined} className="border-b border-rn-line bg-rn-head p-0 font-semibold">
                    <button
                      type="button"
                      data-rn-market-col={k}
                      aria-pressed={metric === k}
                      title={t("pickColumn", { kpi: tK(k) })}
                      onClick={() => pick(k)}
                      className={cx("w-full cursor-pointer px-2 py-2 text-left hover:text-rn-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy", metric === k ? "bg-rn-navy-25 text-rn-navy" : "text-rn-ink-2")}
                    >
                      {short(k)}
                      {ordered && metric === k ? " ↓" : ""}
                    </button>
                  </th>
                ))}
                {lead ? <th scope="col" className="border-b border-rn-line bg-rn-head px-2 py-2 font-semibold">{t("colLead")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const open = !closed.has(m.region);
                return (
                  <MarketRows
                    key={m.region}
                    m={m}
                    label={label(m.region)}
                    open={open}
                    onToggle={() => setClosed((cur) => (cur.has(m.region) ? new Set([...cur].filter((r) => r !== m.region)) : new Set([...cur, m.region])))}
                    metric={metric}
                    active={active}
                    onHover={setActive}
                    onPick={onPick}
                    rankText={rankText}
                    country={(code) => geoCodeLabel(code, locale, (c) => tf(`value.${c}` as "value.worldwide"))}
                    lead={lead}
                    fmt={(k, v) => (v == null ? "—" : f.value(unitOf(k), v))}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </RnCard>
  );
}

function MarketRows({
  m,
  label,
  open,
  onToggle,
  metric,
  active,
  onHover,
  onPick,
  rankText,
  country,
  fmt,
  lead,
}: {
  m: GeoRegionView;
  label: string;
  open: boolean;
  onToggle: () => void;
  metric: OverviewKpiKey;
  active: string | null;
  onHover: (code: string | null) => void;
  onPick?: PickRow;
  rankText: (m: GeoRegionView | GeoCountryView) => string;
  country: (code: string) => string;
  fmt: (k: OverviewKpiKey, v: number | null) => string;
  lead: boolean;
}) {
  const t = useTranslations("renewal.website.overview");
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr data-rn-market={m.region || "~unassigned"} className="bg-rn-navy-25">
        <th scope="row" className="h-12 border-b border-rn-line py-1 pr-2 pl-3 text-left">
          <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full min-w-0 cursor-pointer items-center gap-1 font-bold text-rn-ink">
            <Chevron className="size-3.5 shrink-0 text-rn-muted" aria-hidden />
            <span className="truncate">{label}</span>
            <span className="shrink-0 text-rn-11 font-medium text-rn-muted">{t("countryCount", { count: m.countries.length })}</span>
          </button>
        </th>
        <Cells row={m} metric={metric} rankText={rankText} fmt={fmt} lead={lead} strong />
      </tr>
      {open
        ? m.countries.map((c) => (
            <tr
              key={c.code}
              data-rn-country={c.code}
              data-active={active === c.code ? "" : undefined}
              onMouseEnter={() => onHover(c.code)}
              onMouseLeave={() => onHover(null)}
              onClick={onPick ? () => onPick(c.code) : undefined}
              title={onPick ? t("pickCountry", { country: country(c.code) }) : undefined}
              className={cx(onPick && "cursor-pointer", "hover:bg-rn-page data-[active]:bg-rn-page")}
            >
              <th scope="row" className="h-11 border-b border-rn-line py-1 pr-2 pl-8 text-left font-medium text-rn-ink">
                <span className="block truncate">{country(c.code)}</span>
              </th>
              <Cells row={c} metric={metric} rankText={rankText} fmt={fmt} lead={lead} />
            </tr>
          ))
        : null}
    </>
  );
}

function Cells({
  row,
  metric,
  rankText,
  fmt,
  lead,
  strong = false,
}: {
  row: GeoRegionView | GeoCountryView;
  metric: OverviewKpiKey;
  rankText: (m: GeoRegionView | GeoCountryView) => string;
  fmt: (k: OverviewKpiKey, v: number | null) => string;
  lead: boolean;
  strong?: boolean;
}) {
  const f = useFormat();
  return (
    <>
      <td className="border-b border-rn-line px-2 text-right text-rn-muted tabular-nums">{row.answers != null ? f.count(row.answers) : "—"}</td>
      <td className="border-b border-rn-line px-2 font-semibold whitespace-nowrap text-rn-ink-2 tabular-nums">{rankText(row)}</td>
      {OVERVIEW_KPI_KEYS.map((k) => {
        const rival = row.rivals[k];
        return (
          <td key={k} data-rn-kpi-cell={k} className={cx("border-b border-rn-line px-2 py-1 leading-tight", metric === k && "bg-rn-navy-25/60")}>
            <b className={cx("block tabular-nums", strong || metric === k ? "font-bold text-rn-ink" : "font-semibold text-rn-ink-2")}>{fmt(k, row.values[k])}</b>
            {/* the rival's name may be cut, its value never */}
            <span className="flex min-w-0 gap-1 text-rn-11 text-rn-muted" title={rival ? `${rival.name} ${fmt(k, rival.value)}` : undefined}>
              {rival ? (
                <>
                  <span className="min-w-0 truncate">{rival.name}</span>
                  <span className="shrink-0 tabular-nums">{fmt(k, rival.value)}</span>
                </>
              ) : (
                "—"
              )}
            </span>
          </td>
        );
      })}
      {lead ? (
        <td className="border-b border-rn-line px-2 text-rn-11 text-rn-ink-2">
          <span className="block truncate">{row.showLead && row.topBrand ? `${row.topBrand.name} ${row.topBrand.sov.toFixed(1)}%` : "—"}</span>
        </td>
      ) : null}
    </>
  );
}
