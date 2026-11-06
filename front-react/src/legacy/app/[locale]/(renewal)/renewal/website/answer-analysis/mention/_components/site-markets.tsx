"use client";

import { useCallback, useMemo, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { RnCardHead, RnEmpty, RnSegmented, cx } from "@/components/renewal-ui";
import { geoCodeLabel } from "@/lib/geo-catalog/geo-code-label";
import type { KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import { useServiceWeekReadState } from "@/components/service-week/provider";
import { useRnFilterToggle } from "../../../../_components/overview-filters";
import { MentionCardActions, pctTxt, posTxt, useMention } from "../../../../standard/answer-analysis/mention/_components/mention-context";
import { DeltaChip, InfoTip } from "../../../../standard/answer-analysis/mention/_components/mention-kit";
import { useMentionPage } from "../../../../standard/answer-analysis/mention/_components/mention-tabs";
import { RnMissingPrompts } from "./missing-prompts";
import { SUPPORT } from "@/lib/support-contact";

// 시장별 지표 (2026-11-02, docs/handoff/website-mention-redesign.md): where the page's KPI stands market by market, this
// window beside the one before, a column per brand, the 미언급 prompts and who appears instead. Values from
// mention/rn-markets (back/bff/screens/mention_renewal.py), Gold's /v1/geo as on the Overview's market table.
// The first order is the prompts where another brand was named: a fall in mentioned answers mostly lists answers whose
// analysis came back empty (upstream D8), and the values stay as Gold has them.

export type MarketKpis = Record<KpiTab, number | null>;

/** A brand column's cell. */
export type MarketCell = (MarketKpis & { delta: number | null }) | null;

export interface RnMarketRow {
  country: string;
  answers: number;
  values: MarketKpis;
  deltas: MarketKpis;
  mentioned: number | null;
  mentionedDelta: number | null;
  rival: { brand: string; exposure: number | null } | null;
  brands: Record<string, MarketCell>;
  missing: number;
  missingWithBrands: number;
  noBrandAnswers: number;
}

/** mention/rn-markets */
export interface RnMarketsVM {
  /** the brand columns: the account's brands the page's filter leaves, none under two */
  brands: string[];
  rows: RnMarketRow[];
  /** markets of the account with no answer in the window (0 with a country picked) */
  unmeasured: number;
  degraded: boolean;
}

export type MarketOrder = "rivals" | "drop" | "low" | "answers";
const ORDERS: readonly MarketOrder[] = ["rivals", "drop", "low", "answers"];

/** The rows in an order, ties by answers, then code. "low" = the KPI's weak end (a position's is its largest). */
export function orderMarkets(rows: readonly RnMarketRow[], order: MarketOrder, kpi: KpiTab): RnMarketRow[] {
  const low = (r: RnMarketRow) => {
    const v = r.values[kpi];
    return v == null ? Number.POSITIVE_INFINITY : kpi === "first-rank" ? -v : v;
  };
  const key: Record<MarketOrder, (r: RnMarketRow) => number> = {
    rivals: (r) => -r.missingWithBrands,
    drop: (r) => r.mentionedDelta ?? Number.POSITIVE_INFINITY,
    low,
    answers: (r) => -r.answers,
  };
  return [...rows].sort((a, b) => key[order](a) - key[order](b) || b.answers - a.answers || a.country.localeCompare(b.country));
}

/** A country's name as the filter panel says it (virtual hub codes: 유럽 허브(EU), 월드와이드(글로벌), …). */
export function useMarketName(): (code: string) => string {
  const tf = useTranslations("dashboard.filters");
  const locale = useLocale();
  return useCallback((code: string) => geoCodeLabel(code, locale, (c) => tf(`value.${c}` as "value.worldwide")), [locale, tf]);
}

export function RnSiteMarkets({ vm }: { vm: RnMarketsVM }) {
  const t = useTranslations("renewal.website.mention.markets");
  const tTab = useTranslations("answerAnalysis.mentions.kpi.tabs");
  const dg = useTranslations("renewal.mention.degraded");
  const locale = useLocale();
  const name = useMarketName();
  const toggle = useRnFilterToggle();
  const { ownLabel } = useMention();
  const { kpi } = useMentionPage();
  const [order, setOrder] = useState<MarketOrder>("rivals");
  // a market's sheet reads its list on the page's answer: the page read again (the service week moved) closes it (review r3-4)
  const [missing, setMissing] = useServiceWeekReadState<string | null>(null);
  const rows = useMemo(() => orderMarkets(vm.rows, order, kpi), [vm.rows, order, kpi]);
  const n = (v: number) => v.toLocaleString(locale);
  const kpiTxt = (v: number | null) => (kpi === "first-rank" ? posTxt(v) : pctTxt(v));
  const csv = () => ({
    name: `mention-markets-${kpi}`,
    rows: [
      [t("country"), tTab(kpi), t("delta"), ...vm.brands, t("missing"), t("withBrands"), t("noBrand"), t("answers"), t("rival")],
      ...rows.map((r) => [r.country, r.values[kpi], r.deltas[kpi], ...vm.brands.map((b) => r.brands[b]?.[kpi] ?? null), r.missing, r.missingWithBrands, r.noBrandAnswers, r.answers, r.rival?.brand ?? ""]),
    ],
  });
  const head = (
    <RnCardHead
      title={t("card", { kpi: tTab(kpi) })}
      info={<InfoTip label={t("title")} items={[[t("title"), t("desc")], [t("noBrand"), t("noteNoBrand")]]} />}
      controls={rows.length > 1 ? <RnSegmented label={t("orderLabel")} value={order} onChange={setOrder} items={ORDERS.map((o) => ({ value: o, label: t(`order${o[0].toUpperCase()}${o.slice(1)}` as "orderRivals") }))} /> : undefined}
      actions={rows.length ? <MentionCardActions section="sec-markets" csv={csv} /> : undefined}
    />
  );
  if (!rows.length) {
    return (
      <>
        {head}
        <RnEmpty className="mx-6 mb-5">{vm.degraded ? dg("all", SUPPORT) : t("empty")}</RnEmpty>
      </>
    );
  }
  const th = "sticky top-0 z-10 bg-rn-surface px-2 py-1.5 font-semibold whitespace-nowrap";
  return (
    <>
      {head}
      <div className="max-h-[372px] overflow-auto px-6 [.rn-dense_&]:px-4.5">
        <table className="w-full border-separate border-spacing-0 text-rn-12" data-rn-markets="">
          <thead>
            <tr className="text-rn-muted">
              <th scope="col" className={cx(th, "text-left")}>{t("country")}</th>
              <th scope="col" className={cx(th, "text-right")}>{tTab(kpi)}</th>
              <th scope="col" className={cx(th, "text-right")}>{t("delta")}</th>
              {vm.brands.map((b) => (
                <th key={b} scope="col" className={cx(th, "text-right")}>{b}</th>
              ))}
              <th scope="col" className={cx(th, "text-right")}>{t("missing")}</th>
              <th scope="col" className={cx(th, "text-right")}>{t("withBrands")}</th>
              <th scope="col" className={cx(th, "text-right")}>{t("noBrand")}</th>
              <th scope="col" className={cx(th, "text-right")}>{t("answers")}</th>
              <th scope="col" className={cx(th, "text-left")}>{t("rival")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const label = name(r.country);
              return (
                <tr key={r.country} data-rn-market={r.country} className="hover:bg-rn-navy-25/60">
                  <th scope="row" className="border-t border-rn-line px-2 py-1 text-left font-normal">
                    <button type="button" title={t("countryTip", { country: label })} onClick={() => toggle("geography", r.country)} className="cursor-pointer rounded text-left font-semibold text-rn-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-rn-navy">
                      {label}
                    </button>
                  </th>
                  <td className="border-t border-rn-line px-2 py-1 text-right font-bold text-rn-ink tabular-nums">{kpiTxt(r.values[kpi])}</td>
                  <td className="border-t border-rn-line px-2 py-1 text-right">
                    <span className="inline-flex justify-end">
                      <DeltaChip value={r.deltas[kpi]} rank={kpi === "first-rank"} />
                    </span>
                  </td>
                  {vm.brands.map((b) => {
                    const v = r.brands[b]?.[kpi];
                    return (
                      <td key={b} className={cx("border-t border-rn-line px-2 py-1 text-right tabular-nums", v == null ? "text-rn-faint" : "text-rn-ink")}>
                        {v == null ? "·" : kpiTxt(v)}
                      </td>
                    );
                  })}
                  <td className="border-t border-rn-line px-2 py-1 text-right tabular-nums">
                    {r.missing > 0 ? (
                      <button type="button" aria-label={t("openMissing", { country: label, count: n(r.missing) })} onClick={() => setMissing(r.country)} className="cursor-pointer rounded font-semibold text-rn-ink underline decoration-rn-line-2 underline-offset-4 hover:decoration-rn-navy focus-visible:outline-2 focus-visible:outline-rn-navy">
                        {n(r.missing)}
                      </button>
                    ) : (
                      <span className="text-rn-faint">0</span>
                    )}
                  </td>
                  <td className={cx("border-t border-rn-line px-2 py-1 text-right tabular-nums", r.missingWithBrands ? "font-semibold text-rn-ink" : "text-rn-faint")}>{n(r.missingWithBrands)}</td>
                  <td className="border-t border-rn-line px-2 py-1 text-right text-rn-ink-2 tabular-nums">{n(r.noBrandAnswers)}</td>
                  <td className="border-t border-rn-line px-2 py-1 text-right text-rn-ink-2 tabular-nums">{n(r.answers)}</td>
                  <td className="max-w-[150px] truncate border-t border-rn-line px-2 py-1 text-left text-rn-ink-2" title={r.rival?.brand}>
                    {r.rival ? `${r.rival.brand} ${pctTxt(r.rival.exposure)}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="m-0 px-6 pt-2 pb-3 text-rn-11 text-rn-muted [.rn-dense_&]:px-4.5">
        {vm.brands.length ? `${t("noteBrand")} ` : ""}
        {vm.unmeasured ? t("noteUnmeasured", { n: vm.unmeasured }) : ""}
      </p>
      {missing ? <RnMissingPrompts open onClose={() => setMissing(null)} ownLabel={ownLabel} country={missing} /> : null}
    </>
  );
}
