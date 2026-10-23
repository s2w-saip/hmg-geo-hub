"use client";

// Renewal Overview body — "at a glance" (2026-10-22, replaces the KPI pick that drove the
// cards below: it was never read as a switch). Three cards, no KPI selection:
//   KPI 5종        read-only: value, Δ, spark, standing among the card's competitors, 상세
//   브랜드 비교    brands × 5 KPIs (당사 + every KPI's compared competitors)
//   시장별 현황    권역 › 국가 × 5 KPIs, heat cells + gap to the market's biggest competitor
// Every number is the original /dashboard's:
//   value / pending   overviewCardState (the card rule)
//   Δ                 KPI row: applyTrendDeltas result, or the period-compare chip when a
//                     period is chosen (selectPeriodResult + periodChip, as PeriodDeltaSlot);
//                     brand table: the trend Δ on every row (one basis per table)
//   trend             sparkPoints (last 5 buckets of the card trend), y = sparkYDomain
//   competitors       competitorMinis / competitorCitationShares + competitorDeltas
//   markets           LiveGeo (metricValue, metrics[k].rival, answers)

import { Suspense, use, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import {
  RnCard,
  RnCardHeader,
  RnDeltaChip,
  RnEmpty,
  RnInfoTip,
  RnInfoTipItem,
  RnSkeleton,
  RnSparkline,
  RnTag,
  RnToneChip,
  cx,
  type RnTone,
} from "@/components/renewal-ui";
import {
  NO_DELTA,
  competitorCitationShares,
  competitorDeltas,
  competitorMinis,
  detailHref,
  sparkPoints,
  sparkYDomain,
  type CompetitorMini,
  type OverviewCompetitorSources,
} from "@/app/[locale]/(dash)/dashboard/_components/overview-kpi-cards";
import { overviewCardState } from "@/app/[locale]/(dash)/dashboard/_data/card-state";
import { OVERVIEW_KPI_KEYS, metricValue, type OverviewKpiKey } from "@/app/[locale]/(dash)/dashboard/_data/overview-metrics";
import type { KpiSummary } from "@/app/[locale]/(dash)/dashboard/_data/sample";
import type { LiveGeo, LiveTrend, MarketCompetition } from "@/app/[locale]/(dash)/dashboard/_data/live";
import { selectPeriodResult } from "@/components/dash/period-delta-slot";
import { compareMetricForKpiKey } from "@/components/dash/period-delta-metrics";
import { labelKeyOf, periodCaption, periodChip, periodChipText, type PeriodLabelCtx } from "@/lib/kpi/period-compare-view";
import type { CompareResult } from "@/lib/kpi/period-compare";
import { formatTrendBucketMD, trendBucketDisplays } from "@/lib/as-of-date";
import { countryName } from "@/lib/geo-catalog";
import { rhqLabel } from "@/lib/rhq";
import {
  barWidth,
  brandMatrix,
  gapOf,
  isRank,
  marketColumns,
  marketRival,
  rivalValue,
  sortCountries,
  standing,
  type MarketColumn,
  type MarketSort,
} from "./overview-model";

export interface OverviewDeferredData {
  deltas: Promise<KpiSummary[]>;
  trend: Promise<LiveTrend | null>;
  competitors: Promise<OverviewCompetitorSources | null>;
}

const infoKeyOf = (k: OverviewKpiKey) => (k === "citationShare" ? "citationShareGlobal" : k);
const HEAT = ["bg-rn-heat-0", "bg-rn-heat-1", "bg-rn-heat-2", "bg-rn-heat-3", "bg-rn-heat-4"] as const;

function useFormat() {
  const tUnit = useTranslations("metricUnit");
  const tO = useTranslations("dashboard.overview");
  const value = (k: OverviewKpiKey, v: number | null, empty = tO("cardEmpty")) =>
    v == null ? empty : isRank(k) ? tUnit("position", { n: v.toFixed(1) }) : `${v.toFixed(1)}%`;
  // Δ shows the magnitude; the arrow carries the direction (the card's DeltaBlock rule).
  const delta = (k: OverviewKpiKey, r: number) => (isRank(k) ? tUnit("position", { n: Math.abs(r).toFixed(1) }) : `${Math.abs(r).toFixed(1)}pp`);
  return { value, delta };
}

export function RnOverviewBody({
  kpis,
  deferred,
  periodCompare,
  periodDays,
  periodLabelCtx,
  geo,
  ownLabel,
  qs,
}: {
  kpis: KpiSummary[];
  deferred: OverviewDeferredData;
  periodCompare: readonly CompareResult[] | null;
  periodDays?: number;
  periodLabelCtx: PeriodLabelCtx;
  /** null = this account does not see the GEO section (showsGeoMap). */
  geo: Promise<LiveGeo | null> | null;
  ownLabel: string;
  qs: string;
}) {
  const byKey = useMemo(() => new Map(kpis.map((k) => [k.key, k])), [kpis]);
  return (
    <>
      <KpiRow byKey={byKey} deferred={deferred} periodCompare={periodCompare} periodDays={periodDays} periodLabelCtx={periodLabelCtx} qs={qs} />
      {/* brand comparison before the (long) market table so it is not buried */}
      <Suspense fallback={<CardSkeleton rows={5} />}>
        <BrandMatrix byKey={byKey} deferred={deferred} ownLabel={ownLabel} />
      </Suspense>
      {geo ? (
        <Suspense fallback={<CardSkeleton rows={8} />}>
          <MarketMatrix geo={geo} />
        </Suspense>
      ) : null}
    </>
  );
}

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <RnCard className="p-6">
      <RnSkeleton className="mb-4 h-4 w-40" />
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: rows }, (_, i) => (
          <RnSkeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    </RnCard>
  );
}

/** The card's competitor row, kpi-wise (citation share folds official competitor domains). */
function minisFor(src: OverviewCompetitorSources | null, k: OverviewKpiKey): CompetitorMini[] {
  if (k === "citationShare") return competitorCitationShares(src?.citationDomains ?? null, undefined, src?.citationTotal ?? null);
  const deltas = competitorDeltas(src, k);
  return competitorMinis(src?.brands ?? [], k).map((m) => ({ ...m, delta: deltas.get(m.brand) ?? null }));
}

// ─── KPI 5종 (read-only) ────────────────────────────────────────────────────

function KpiRow({
  byKey,
  deferred,
  periodCompare,
  periodDays,
  periodLabelCtx,
  qs,
}: {
  byKey: Map<string, KpiSummary>;
  deferred: OverviewDeferredData;
  periodCompare: readonly CompareResult[] | null;
  periodDays?: number;
  periodLabelCtx: PeriodLabelCtx;
  qs: string;
}) {
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const tP = useTranslations("periodCompare");
  const tKpi = useTranslations("dashboard.kpi");
  const locale = useLocale();
  // What the Δ compares against (the card's label rule).
  const sample = periodCompare?.[0] ?? null;
  const presetKey = sample ? labelKeyOf({ days: periodDays ?? 0, ...periodLabelCtx }) : null;
  const compareTitle = sample
    ? presetKey
      ? tP(`label.${presetKey}` as "label.weekly")
      : tP("window", { curCycles: sample.cyclesCur, prevCycles: sample.cyclesPrev })
    : tO("compare");
  return (
    <RnCard tone="hero" className="@container/rnkpi" aria-label={t("kpiTitle")}>
      <RnCardHeader
        title={t("kpiTitle")}
        hint={
          <>
            {t("kpiHintDelta", { compare: compareTitle })}
            <Suspense fallback={null}>
              <TrendCount trend={deferred.trend} />
            </Suspense>
          </>
        }
      />
      <div className="grid grid-cols-5 px-2.5 pt-0.5 pb-5 @max-[600px]/rnkpi:grid-cols-3 @max-[600px]/rnkpi:gap-y-3.5">
        {OVERVIEW_KPI_KEYS.map((key, i) => {
          const state = overviewCardState(byKey.get(key));
          const name = tKpi(`name.${key}`);
          return (
            <div
              key={key}
              data-rn-kpi={key}
              className="flex min-w-0 flex-col gap-[7px] border-l border-white/14 px-4 py-1 first:border-l-0 @max-[600px]/rnkpi:nth-[3n+1]:border-l-0"
            >
              <span className="flex items-center gap-1 text-rn-13 font-bold text-white/86">
                <span className="truncate">{name}</span>
                <RnInfoTip label={t("infoLabel", { name })} align={i >= 3 ? "end" : "start"}>
                  <RnInfoTipItem label={t("definition")}>{tKpi(`definition.${infoKeyOf(key)}` as "definition.visibility")}</RnInfoTipItem>
                  <RnInfoTipItem label={t("formula")}>{tKpi(`formula.${infoKeyOf(key)}` as "formula.visibility")}</RnInfoTipItem>
                </RnInfoTip>
              </span>
              <KpiValue k={key} value={state.value} />
              <span className="flex min-h-6">
                <DeltaCell k={key} pending={state.pending} deferred={deferred} periodCompare={periodCompare} periodDays={periodDays} periodLabelCtx={periodLabelCtx} />
              </span>
              <div className="mt-0.5 min-h-[46px]">
                {state.pending ? null : (
                  <Suspense fallback={<RnSkeleton className="h-[30px] w-full" />}>
                    <SparkCell k={key} trend={deferred.trend} />
                  </Suspense>
                )}
              </div>
              <span className="min-h-[18px] text-rn-12 text-white/72">
                {state.pending ? null : (
                  <Suspense fallback={<RnSkeleton className="h-4 w-24" />}>
                    <StandingLine k={key} own={state.value} competitors={deferred.competitors} />
                  </Suspense>
                )}
              </span>
              <Link prefetch={false}
                href={detailHref(key, locale, qs)}
                aria-label={t("detailLabel", { name })}
                className="inline-flex items-center gap-0.5 self-start rounded-[3px] text-rn-12 font-semibold text-rn-sky hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rn-sky"
              >
                {t("detail")}
                <ArrowUpRight className="size-3" aria-hidden />
              </Link>
            </div>
          );
        })}
      </div>
    </RnCard>
  );
}

function TrendCount({ trend }: { trend: Promise<LiveTrend | null> }) {
  const t = useTranslations("renewal.overview");
  const n = sparkPoints(use(trend), "visibility").length;
  return n > 1 ? <> · {t("kpiHintTrend", { count: n })}</> : null;
}

function KpiValue({ k, value }: { k: OverviewKpiKey; value: number | null }) {
  const tO = useTranslations("dashboard.overview");
  const tUnit = useTranslations("metricUnit");
  // on the navy KPI card (S급): the value 34px white, the unit small
  const big = "text-rn-34 font-bold tracking-[-0.03em] whitespace-nowrap text-white tabular-nums";
  if (value == null) return <span className="text-rn-15 leading-[2.2] font-semibold text-white/72">{tO("cardEmpty")}</span>;
  if (isRank(k)) {
    // "{n}번째" — the number big, the unit word small (same string as the card).
    const full = tUnit("position", { n: value.toFixed(1) });
    const n = value.toFixed(1);
    const at = full.indexOf(n);
    return (
      <span className={big} data-rn-value={k}>
        {at >= 0 ? (
          <>
            {full.slice(0, at)}
            {n}
            <small className="ml-px text-[14px] font-semibold text-white/80">{full.slice(at + n.length)}</small>
          </>
        ) : (
          full
        )}
      </span>
    );
  }
  return (
    <span className={big} data-rn-value={k}>
      {value.toFixed(1)}
      <small className="ml-px text-[14px] font-semibold text-white/80">%</small>
    </span>
  );
}

function DeltaCell({
  k,
  pending,
  deferred,
  periodCompare,
  periodDays,
  periodLabelCtx,
}: {
  k: OverviewKpiKey;
  pending: boolean;
  deferred: OverviewDeferredData;
  periodCompare: readonly CompareResult[] | null;
  periodDays?: number;
  periodLabelCtx: PeriodLabelCtx;
}) {
  const t = useTranslations("renewal.overview");
  const tP = useTranslations("periodCompare");
  if (pending) return null;
  const result = selectPeriodResult(periodCompare, compareMetricForKpiKey(k));
  if (result) {
    const chip = periodChip(result);
    const caption = periodCaption(result, { days: periodDays ?? 0, ...periodLabelCtx });
    const tone: RnTone = chip.suppressed ? "none" : chip.direction;
    return (
      <RnToneChip tone={tone} onDark title={caption.key === "window" ? undefined : tP(caption.key, caption.params)}>
        {periodChipText(chip)}
      </RnToneChip>
    );
  }
  return (
    <Suspense fallback={<RnSkeleton className="h-6 w-16" />}>
      <TrendDelta k={k} deltas={deferred.deltas} labels={{ up: t("deltaUp"), down: t("deltaDown"), flat: t("deltaFlat") }} />
    </Suspense>
  );
}

function TrendDelta({ k, deltas, labels }: { k: OverviewKpiKey; deltas: Promise<KpiSummary[]>; labels: { up: string; down: string; flat: string } }) {
  const applied = use(deltas);
  const f = useFormat();
  const d = overviewCardState(applied.find((x) => x.key === k)).delta;
  return <RnDeltaChip delta={d} lowerIsBetter={isRank(k)} format={(r) => f.delta(k, r)} emptyText={NO_DELTA} labels={labels} onDark />;
}

// The spark draws on the original card's y domain (rates 0–100, rank [1, max(5, ⌈max⌉)]),
// with the first and last shown rounds under it.
function SparkCell({ k, trend }: { k: OverviewKpiKey; trend: Promise<LiveTrend | null> }) {
  const points = sparkPoints(use(trend), k);
  if (!points.some((p) => p.value != null)) return null;
  const labels = trendBucketDisplays(points);
  const md = (key: string) => {
    const d = labels.get(key);
    return d ? formatTrendBucketMD(d) : "";
  };
  return (
    <>
      <RnSparkline values={points.map((p) => p.value)} tone="onDark" invert={isRank(k)} domain={sparkYDomain(points, isRank(k))} className="h-[30px]" />
      {points.length > 1 ? (
        <span className="flex justify-between text-rn-11 text-white/72 tabular-nums">
          <span>{md(points[0].bucketStart)}</span>
          <span>{md(points[points.length - 1].bucketStart)}</span>
        </span>
      ) : null}
    </>
  );
}

function StandingLine({ k, own, competitors }: { k: OverviewKpiKey; own: number | null; competitors: Promise<OverviewCompetitorSources | null> }) {
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const st = standing(k, own, minisFor(use(competitors), k));
  if (!st) return <>{tO("noCompetitorData")}</>;
  return <>{t.rich("standing", { b: (c) => <b className="font-semibold text-white">{c}</b>, rank: st.rank, count: st.count })}</>;
}

// ─── 브랜드 비교 (brands × KPIs) ────────────────────────────────────────────

function BrandMatrix({ byKey, deferred, ownLabel }: { byKey: Map<string, KpiSummary>; deferred: OverviewDeferredData; ownLabel: string }) {
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi.name");
  const f = useFormat();
  const src = use(deferred.competitors);
  const applied = use(deferred.deltas);
  const { rows, cols } = useMemo(() => {
    const values = {} as Record<OverviewKpiKey, number | null>;
    const deltas = {} as Record<OverviewKpiKey, number | null>;
    const rivals = {} as Record<OverviewKpiKey, CompetitorMini[]>;
    for (const k of OVERVIEW_KPI_KEYS) {
      values[k] = overviewCardState(byKey.get(k)).value;
      deltas[k] = overviewCardState(applied.find((x) => x.key === k)).delta;
      rivals[k] = minisFor(src, k);
    }
    return brandMatrix({ label: ownLabel, values, deltas }, rivals);
  }, [byKey, applied, src, ownLabel]);
  const deltaText = (k: OverviewKpiKey, d: number | null) => {
    if (d == null) return null;
    const r = Math.round(d * 10) / 10;
    if (r === 0) return <span className="text-rn-11 font-semibold text-rn-muted">{t("deltaFlat")}</span>;
    const good = isRank(k) ? r < 0 : r > 0;
    return (
      <span className={cx("text-rn-11 font-semibold tabular-nums", good ? "text-rn-up-ink" : "text-rn-danger-ink")} title={t("deltaTitle", { dir: good ? t("deltaUp") : t("deltaDown"), compare: tO("compare") })}>
        {r > 0 ? "▲" : "▼"}
        {f.delta(k, r)}
      </span>
    );
  };
  return (
    <RnCard aria-label={t("brandsTitle")}>
      <RnCardHeader title={t("brandsTitle")} hint={t("brandsHint", { compare: tO("compare") })} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-rn-13" data-rn-brand-matrix="">
          <colgroup>
            <col className="w-[168px]" />
            {OVERVIEW_KPI_KEYS.map((k) => (
              <col key={k} />
            ))}
          </colgroup>
          <thead>
            <tr className="text-left text-rn-12 text-rn-muted">
              <th scope="col" className="border-y border-rn-line bg-rn-head py-2 pr-3 pl-6 align-bottom font-semibold">{t("colBrand")}</th>
              {cols.map((c) => (
                <th key={c.key} scope="col" title={tKpi(c.key)} className="border-y border-rn-line bg-rn-head px-3 py-2 align-bottom font-semibold">
                  <span className="flex flex-col gap-px text-rn-ink-2">
                    {t(`short.${c.key}`)}
                    {c.standing ? <small className="text-rn-11 font-medium text-rn-muted">{t("colStanding", { rank: c.standing.rank, count: c.standing.count })}</small> : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.own ? "own:" : ""}${r.name}`} data-rn-brand-row={r.own ? "own" : r.name} className={r.own ? "bg-rn-navy-25" : undefined}>
                <td className="border-b border-rn-line pt-2.5 pr-3 pb-2 pl-6 align-top">
                  <span className="flex min-w-0 items-center gap-1.5 font-semibold text-rn-ink">
                    <span className="truncate">{r.name}</span>
                    {r.own ? <RnTag>{t("ownTag")}</RnTag> : null}
                  </span>
                </td>
                {cols.map((c) => {
                  const cell = r.cells[c.key];
                  if (!cell)
                    return (
                      <td key={c.key} className="border-b border-rn-line px-3 py-2 align-top text-rn-muted" title={t("notCompared", { kpi: tKpi(c.key) })}>
                        —
                      </td>
                    );
                  return (
                    <td key={c.key} className="border-b border-rn-line px-3 py-2 align-top">
                      <div className="flex flex-col gap-[3px]">
                        <b className={cx("tabular-nums text-rn-ink", cell.value != null && cell.value === c.best ? "font-extrabold" : "font-semibold")}>{f.value(c.key, cell.value, "—")}</b>
                        <span className={cx("h-[5px] max-w-[148px] overflow-hidden rounded-[2px]", r.own ? "bg-rn-surface" : "bg-rn-page")}>
                          <i className={cx("block h-full rounded-[2px]", r.own ? "bg-rn-navy" : "bg-rn-faint")} style={{ width: `${barWidth(c.key, cell.value, c.max).toFixed(1)}%` }} />
                        </span>
                        {deltaText(c.key, cell.delta)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 1 ? <RnEmpty className="mx-6 mt-3">{tO("noCompetitorData")}</RnEmpty> : null}
      <p className="m-0 px-6 pt-2.5 pb-4 text-rn-11 leading-[1.55] break-keep text-rn-muted">{t("brandsFoot")}</p>
    </RnCard>
  );
}

// ─── 시장별 현황 (권역 › 국가 × KPIs) ───────────────────────────────────────

function MarketMatrix({ geo: geoP }: { geo: Promise<LiveGeo | null> }) {
  const geo = use(geoP);
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi.name");
  const locale = useLocale();
  const f = useFormat();
  const [sort, setSort] = useState<MarketSort>({ key: "shareOfVoice", worst: false });
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const regions = useMemo(() => geo?.markets ?? [], [geo]);
  const cols = useMemo(() => marketColumns(regions), [regions]);
  const head = (
    <RnCardHeader
      title={t("marketsTitle")}
      actions={
        regions.length ? (
          <span className="inline-flex items-center gap-1.5 text-rn-12 text-rn-muted" title={t("heatLegendTitle")}>
            {t("heatLegend")}
            {HEAT.map((c) => (
              <i key={c} className={cx("inline-block h-2.5 w-5 rounded-[2px] shadow-[inset_0_0_0_1px_rgba(10,9,8,0.06)]", c)} />
            ))}
            {t("heatLegendFront")}
          </span>
        ) : null
      }
    />
  );
  if (regions.length === 0) {
    return (
      <RnCard aria-label={t("marketsTitle")}>
        {head}
        <RnEmpty className="mx-6 mb-5">{tO("geo.brandRequired")}</RnEmpty>
      </RnCard>
    );
  }
  const gapText = (k: OverviewKpiKey, g: number | null) => {
    if (g == null) return null;
    const a = Math.abs(g).toFixed(1);
    return `${a === "0.0" ? "±" : g > 0 ? "+" : "−"}${a}${isRank(k) ? "" : "pp"}`;
  };
  const sub = (m: MarketCompetition) => {
    const rival = marketRival(m);
    return (
      <span className="mt-px block text-rn-11 leading-[1.4] font-medium text-rn-muted">
        {m.answers != null ? <span className="whitespace-nowrap">{t("answersMeta", { count: m.answers.toLocaleString(locale) })}</span> : null}
        {m.answers != null && rival ? " · " : null}
        {rival ? <span className="whitespace-nowrap">{t("vsRival", { name: rival })}</span> : null}
      </span>
    );
  };
  const toggleRegion = (id: string) =>
    setClosed((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <RnCard aria-label={t("marketsTitle")}>
      {head}
      <p className="m-0 px-6 pb-3 text-rn-12 leading-[1.55] break-keep text-rn-muted">{t.rich("marketsKey", { b: (c) => <b className="font-semibold text-rn-ink-2">{c}</b> })}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-0 text-rn-13" data-rn-geo-table="">
          <colgroup>
            <col className="w-[176px]" />
            {OVERVIEW_KPI_KEYS.map((k) => (
              <col key={k} />
            ))}
          </colgroup>
          <thead>
            <tr className="text-left text-rn-12 text-rn-muted">
              <th scope="col" className="h-[38px] border-y border-rn-line bg-rn-head pr-3 pl-6 font-semibold">{tO("geo.colRegion")}</th>
              {OVERVIEW_KPI_KEYS.map((k) => (
                <SortHead key={k} k={k} sort={sort} onSort={setSort} label={t(`short.${k}`)} kpi={tKpi(k)} />
              ))}
            </tr>
          </thead>
          <tbody>
            {regions.map((m) => {
              const open = !closed.has(m.region);
              const label = rhqLabel(m.region, locale === "en" ? "en" : "ko") ?? m.region;
              return (
                <RegionRows key={m.region}>
                  <tr className="bg-rn-page" data-rn-region={m.region}>
                    <td className="border-b border-rn-line py-2 pr-3 pl-6 align-top">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={open ? t("collapseRegion", { region: label }) : t("expandRegion", { region: label })}
                        onClick={() => toggleRegion(m.region)}
                        className="inline-flex cursor-pointer items-center gap-1.5 text-left font-bold text-rn-ink focus-visible:outline-2 focus-visible:outline-rn-navy"
                      >
                        <ChevronRight aria-hidden className={cx("size-3.5 text-rn-muted transition-transform", open && "rotate-90")} />
                        {label}
                        <span className="font-medium text-rn-muted">{t("countryCount", { count: m.countries.length })}</span>
                      </button>
                      <span className="block pl-5">{sub(m)}</span>
                    </td>
                    {OVERVIEW_KPI_KEYS.map((k) => {
                      const v = metricValue(m, k);
                      return (
                        <td key={k} className="border-b border-rn-line px-2 py-1.5 align-top">
                          <b className="block text-rn-13 leading-[1.3] font-bold tabular-nums text-rn-ink">{f.value(k, v, "—")}</b>
                          <small className="block text-rn-11 leading-[1.3] text-rn-ink-2 tabular-nums">{gapText(k, gapOf(k, v, rivalValue(m, k)))}</small>
                        </td>
                      );
                    })}
                  </tr>
                  {open
                    ? sortCountries(m.countries, sort).map((c) => (
                        <tr key={c.code} data-rn-row={c.code} className="group/cty">
                          <td className="border-b border-rn-line py-1.5 pr-3 pl-10 align-top group-hover/cty:bg-rn-navy-25">
                            <span className="flex items-center overflow-hidden whitespace-nowrap">
                              <span className="mr-1.5 rounded bg-rn-inset px-1.5 py-px font-mono text-rn-11 font-semibold tracking-[0.04em] text-rn-ink-2">{c.code}</span>
                              <span className="truncate">{countryName(c.code, locale)}</span>
                            </span>
                            {sub(c)}
                          </td>
                          {OVERVIEW_KPI_KEYS.map((k) => (
                            <HeatCell key={k} k={k} m={c} name={countryName(c.code, locale)} col={cols[k]} gap={gapText(k, gapOf(k, metricValue(c, k), rivalValue(c, k)))} />
                          ))}
                        </tr>
                      ))
                    : null}
                </RegionRows>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="h-4" />
    </RnCard>
  );
}

function SortHead({ k, sort, onSort, label, kpi }: { k: OverviewKpiKey; sort: MarketSort; onSort: (s: MarketSort) => void; label: string; kpi: string }) {
  const t = useTranslations("renewal.overview");
  const on = sort.key === k;
  const dir = on ? t(sort.worst ? "sortWorst" : "sortBest") : null;
  // best first = descending values for rates, ascending for rank
  const ariaSort = on ? (isRank(k) !== sort.worst ? "ascending" : "descending") : "none";
  return (
    <th scope="col" aria-sort={ariaSort} className="h-[38px] border-y border-rn-line bg-rn-head px-1.5 font-semibold">
      <button
        type="button"
        data-rn-sort={k}
        title={dir ? t("sortTitleOn", { kpi, dir }) : t("sortTitle", { kpi })}
        onClick={() => onSort(on ? { key: k, worst: !sort.worst } : { key: k, worst: false })}
        className={cx(
          "inline-flex h-7 max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 font-semibold hover:bg-rn-page hover:text-rn-ink-2 focus-visible:outline-2 focus-visible:outline-rn-navy",
          on ? "text-rn-ink" : "text-rn-muted",
        )}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className={cx("text-rn-11", on ? "text-rn-navy" : "text-rn-muted")}>
          {on ? (sort.worst ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function HeatCell({ k, m, name, col, gap }: { k: OverviewKpiKey; m: MarketCompetition & { code: string }; name: string; col: MarketColumn; gap: string | null }) {
  const t = useTranslations("renewal.overview");
  const tKpi = useTranslations("dashboard.kpi.name");
  const f = useFormat();
  const v = metricValue(m, k);
  const bin = col.bin(v);
  const nth = col.nth(m.code);
  const rival = marketRival(m);
  const rv = rivalValue(m, k);
  const tip = [
    `${name} · ${tKpi(k)} ${f.value(k, v, "—")}`,
    nth != null ? t("cellPlace", { count: col.count, rank: nth }) : null,
    rv == null || !rival ? t("cellNoRival") : t("cellRival", { name: rival, value: f.value(k, rv, "—"), gap: gap ?? "—" }),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <td
      title={tip}
      data-rn-heat={bin ?? ""}
      className={cx("border-b-2 border-l-2 border-rn-line px-2 py-1.5 align-top text-rn-ink", bin == null ? "bg-rn-surface text-rn-muted" : HEAT[bin])}
    >
      <b className="block text-rn-13 leading-[1.3] font-semibold tabular-nums">{f.value(k, v, "—")}</b>
      {gap ? <small className="block text-rn-11 leading-[1.3] text-rn-ink-2 tabular-nums">{gap}</small> : null}
    </td>
  );
}

function RegionRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
