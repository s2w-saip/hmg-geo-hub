"use client";

// Renewal Overview body — "at a glance" (2026-10-22). Three cards, no KPI selection:
//   KPI 5종        read-only: value, Δ, spark, standing among the card's competitors, 상세
//   브랜드 비교    brands × 5 KPIs (당사 + every KPI's compared competitors)
//   시장별 현황    기존 GeoJSON 지도, KPI 전환, 국가 선택과 수치 표
// Every number comes from the overview screens (back/bff/screens/overview.py), the same as /dashboard:
//   value / pending / period chip + caption   overview/cards (compareTitle = what Δ compares against)
//   Δ, sparkline, its domain and labels        overview/card-trend
//   standing                                   overview/card-competitors (ctx.view=renewal)
//   brand table (cells, best, bar, Δ marks)    overview/brand-matrix
//   markets                                    overview/geo (GeoOverview)
// This file formats and lays them out.

import { Suspense, use } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ArrowUpRight } from "lucide-react";
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
import { NO_DELTA, detailHref } from "@/app/[locale]/(dash)/dashboard/_components/overview-kpi-cards";
import { OVERVIEW_KPI_KEYS, type OverviewKpiKey } from "@/app/[locale]/(dash)/dashboard/_data/overview-metrics";
import type {
  BrandCellView,
  BrandMatrixView,
  CardCompetitorsView,
  CardTrendView,
  OverviewCardView,
  OverviewGeoView,
  ScreenMessage,
} from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { periodChipText } from "@/lib/period-chip-text";
import { formatTrendBucketMD } from "@/lib/as-of-date";
import { GeoOverview } from "@/app/[locale]/(dash)/dashboard/_components/geo-overview";

export interface OverviewDeferredData {
  trend: Promise<CardTrendView>;
  competitors: Promise<CardCompetitorsView>;
  matrix: Promise<BrandMatrixView | null>;
}

/** The rank KPI reads lower = better (reversed spark, Δ tone). */
const isRank = (k: OverviewKpiKey) => k === "position";

const infoKeyOf = (k: OverviewKpiKey) => (k === "citationShare" ? "citationShareGlobal" : k);

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
  cards,
  compareTitle,
  deferred,
  geo,
  qs,
}: {
  cards: OverviewCardView[];
  /** What Δ compares against when a period compare answered (null = the trend wording). */
  compareTitle: ScreenMessage | null;
  deferred: OverviewDeferredData;
  /** null = this account does not see the GEO section (showsGeoMap). */
  geo: Promise<OverviewGeoView> | null;
  qs: string;
}) {
  return (
    <>
      <KpiRow cards={cards} compareTitle={compareTitle} deferred={deferred} qs={qs} />
      {/* brand comparison before the (long) market table so it is not buried */}
      <Suspense fallback={<CardSkeleton rows={5} />}>
        <BrandMatrix matrix={deferred.matrix} />
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

// ─── KPI 5종 (read-only) ────────────────────────────────────────────────────

function KpiRow({
  cards,
  compareTitle,
  deferred,
  qs,
}: {
  cards: OverviewCardView[];
  compareTitle: ScreenMessage | null;
  deferred: OverviewDeferredData;
  qs: string;
}) {
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const tP = useTranslations("periodCompare");
  const tKpi = useTranslations("dashboard.kpi");
  const locale = useLocale();
  const byKey = new Map(cards.map((c) => [c.key, c]));
  return (
    <RnCard tone="hero" className="@container/rnkpi" aria-label={t("kpiTitle")}>
      <RnCardHeader
        title={t("kpiTitle")}
        hint={
          <>
            {t("kpiHintDelta", { compare: compareTitle ? tP(compareTitle.key as "label.weekly", compareTitle.params) : tO("compare") })}
            <Suspense fallback={null}>
              <TrendCount trend={deferred.trend} />
            </Suspense>
          </>
        }
      />
      <div className="grid grid-cols-5 px-2.5 pt-0.5 pb-5 @max-[600px]/rnkpi:grid-cols-3 @max-[600px]/rnkpi:gap-y-3.5">
        {OVERVIEW_KPI_KEYS.map((key, i) => {
          const card = byKey.get(key);
          const pending = card?.pending ?? true;
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
              <KpiValue k={key} value={card?.value ?? null} />
              <span className="flex min-h-6">
                <DeltaCell k={key} card={card} pending={pending} trend={deferred.trend} />
              </span>
              <div className="mt-0.5 min-h-[46px]">
                {pending ? null : (
                  <Suspense fallback={<RnSkeleton className="h-[30px] w-full" />}>
                    <SparkCell k={key} trend={deferred.trend} />
                  </Suspense>
                )}
              </div>
              <span className="min-h-[18px] text-rn-12 text-white/72">
                {pending ? null : (
                  <Suspense fallback={<RnSkeleton className="h-4 w-24" />}>
                    <StandingLine k={key} competitors={deferred.competitors} />
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

function TrendCount({ trend }: { trend: Promise<CardTrendView> }) {
  const t = useTranslations("renewal.overview");
  const n = use(trend).count;
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
  card,
  pending,
  trend,
}: {
  k: OverviewKpiKey;
  card: OverviewCardView | undefined;
  pending: boolean;
  trend: Promise<CardTrendView>;
}) {
  const t = useTranslations("renewal.overview");
  const tP = useTranslations("periodCompare");
  if (pending) return null;
  const period = card?.period;
  if (period) {
    const tone: RnTone = period.chip.suppressed ? "none" : period.chip.direction;
    return (
      <RnToneChip tone={tone} onDark title={period.caption.key === "window" ? undefined : tP(period.caption.key, period.caption.params)}>
        {periodChipText(period.chip)}
      </RnToneChip>
    );
  }
  return (
    <Suspense fallback={<RnSkeleton className="h-6 w-16" />}>
      <TrendDelta k={k} trend={trend} labels={{ up: t("deltaUp"), down: t("deltaDown"), flat: t("deltaFlat") }} />
    </Suspense>
  );
}

function TrendDelta({ k, trend, labels }: { k: OverviewKpiKey; trend: Promise<CardTrendView>; labels: { up: string; down: string; flat: string } }) {
  const d = use(trend).cards[k].delta;
  const f = useFormat();
  return <RnDeltaChip delta={d} lowerIsBetter={isRank(k)} format={(r) => f.delta(k, r)} emptyText={NO_DELTA} labels={labels} onDark />;
}

// The spark draws on the card's y domain, with the first and last shown rounds under it.
function SparkCell({ k, trend }: { k: OverviewKpiKey; trend: Promise<CardTrendView> }) {
  const spark = use(trend).cards[k].spark;
  if (!spark.hasValue) return null;
  const points = spark.points;
  const md = (i: number) => {
    const d = points[i].display;
    return d ? formatTrendBucketMD(d) : "";
  };
  return (
    <>
      <RnSparkline values={points.map((p) => p.value)} tone="onDark" invert={isRank(k)} domain={spark.domain} className="h-[30px]" />
      {points.length > 1 ? (
        <span className="flex justify-between text-rn-11 text-white/72 tabular-nums">
          <span>{md(0)}</span>
          <span>{md(points.length - 1)}</span>
        </span>
      ) : null}
    </>
  );
}

function StandingLine({ k, competitors }: { k: OverviewKpiKey; competitors: Promise<CardCompetitorsView> }) {
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const st = use(competitors).standing?.[k] ?? null;
  if (!st) return <>{tO("noCompetitorData")}</>;
  return <>{t.rich("standing", { b: (c) => <b className="font-semibold text-white">{c}</b>, rank: st.rank, count: st.count })}</>;
}

// ─── 브랜드 비교 (brands × KPIs) ────────────────────────────────────────────

function BrandMatrix({ matrix }: { matrix: Promise<BrandMatrixView | null> }) {
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi.name");
  const f = useFormat();
  const m = use(matrix);
  if (!m) return null;
  const { rows, cols } = m;
  const deltaText = (k: OverviewKpiKey, mark: BrandCellView["deltaMark"]) => {
    if (mark == null) return null;
    if (mark.tone === "flat") return <span className="text-rn-11 font-semibold text-rn-muted">{t("deltaFlat")}</span>;
    const good = mark.tone === "good";
    return (
      <span className={cx("text-rn-11 font-semibold tabular-nums", good ? "text-rn-up-ink" : "text-rn-danger-ink")} title={t("deltaTitle", { dir: good ? t("deltaUp") : t("deltaDown"), compare: tO("compare") })}>
        {mark.r > 0 ? "▲" : "▼"}
        {f.delta(k, mark.r)}
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
                        <b className={cx("tabular-nums text-rn-ink", cell.best ? "font-extrabold" : "font-semibold")}>{f.value(c.key, cell.value, "—")}</b>
                        <span className={cx("h-[5px] max-w-[148px] overflow-hidden rounded-[2px]", r.own ? "bg-rn-surface" : "bg-rn-page")}>
                          <i className={cx("block h-full rounded-[2px]", r.own ? "bg-rn-navy" : "bg-rn-faint")} style={{ width: `${cell.bar.toFixed(1)}%` }} />
                        </span>
                        {deltaText(c.key, cell.deltaMark)}
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

function MarketMatrix({ geo: geoP }: { geo: Promise<OverviewGeoView> }) {
  const geo = use(geoP).geo;
  const t = useTranslations("renewal.overview");
  if (!geo) return null;
  return <GeoOverview geo={geo} title={t("marketsTitle")} />;
}
