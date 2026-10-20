"use client";

// Renewal Overview body — KPI scoreboard (5 rows) driving the market tiles, the brand
// comparison and the 권역 › 국가 table. Every number is the original /dashboard's:
//   value / pending   overviewCardState (the card rule)
//   Δ                 applyTrendDeltas result, or the period-compare chip when a period
//                     is chosen (selectPeriodResult + periodChip, same as PeriodDeltaSlot)
//   trend             sparkPoints (last 5 buckets of the card trend)
//   competitors       competitorMinis / competitorCitationShares + competitorDeltas
//   markets           LiveGeo (metricValue, metrics[k].rival, answers)
// Only the layout differs; the per-country Δ column is left out (no data source).

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
import { countryName } from "@/lib/geo-catalog";
import { rhqLabel } from "@/lib/rhq";

export interface OverviewDeferredData {
  deltas: Promise<KpiSummary[]>;
  trend: Promise<LiveTrend | null>;
  competitors: Promise<OverviewCompetitorSources | null>;
}

const isRank = (k: OverviewKpiKey) => k === "position";
const infoKeyOf = (k: OverviewKpiKey) => (k === "citationShare" ? "citationShareGlobal" : k);
const BINS = ["bg-rn-navy-25", "bg-rn-navy-50", "bg-rn-sky", "bg-rn-navy-500", "bg-rn-navy"] as const;

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
  const [focus, setFocus] = useState<OverviewKpiKey>("visibility");
  const [hi, setHi] = useState<string | null>(null);
  const byKey = useMemo(() => new Map(kpis.map((k) => [k.key, k])), [kpis]);
  const brands = (
    <Suspense fallback={<CardSkeleton rows={5} />}>
      <BrandCompare focus={focus} kpi={byKey.get(focus)} deferred={deferred} periodCompare={periodCompare} ownLabel={ownLabel} />
    </Suspense>
  );
  return (
    <>
      <KpiBoard byKey={byKey} focus={focus} onFocus={setFocus} deferred={deferred} periodCompare={periodCompare} periodDays={periodDays} periodLabelCtx={periodLabelCtx} qs={qs} />
      {geo ? (
        <>
          <div className="grid grid-cols-1 gap-4 @min-[1100px]/rncontent:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Suspense fallback={<CardSkeleton rows={6} />}>
              <MarketTiles geo={geo} focus={focus} hi={hi} onHi={setHi} />
            </Suspense>
            {brands}
          </div>
          <Suspense fallback={<CardSkeleton rows={8} />}>
            <MarketTable geo={geo} focus={focus} hi={hi} onHi={setHi} />
          </Suspense>
        </>
      ) : (
        brands
      )}
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

// ─── KPI scoreboard ─────────────────────────────────────────────────────────

const BOARD_COLS = "grid-cols-[minmax(150px,1.3fr)_100px_96px_minmax(88px,1fr)_minmax(120px,1fr)_32px] @max-[700px]/rnboard:grid-cols-[minmax(150px,1.3fr)_100px_96px_minmax(88px,1fr)_32px]";

function KpiBoard({
  byKey,
  focus,
  onFocus,
  deferred,
  periodCompare,
  periodDays,
  periodLabelCtx,
  qs,
}: {
  byKey: Map<string, KpiSummary>;
  focus: OverviewKpiKey;
  onFocus: (k: OverviewKpiKey) => void;
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
  // Column title = what the Δ compares against (the card's label rule).
  const sample = periodCompare?.[0] ?? null;
  const presetKey = sample ? labelKeyOf({ days: periodDays ?? 0, ...periodLabelCtx }) : null;
  const compareTitle = sample
    ? presetKey
      ? tP(`label.${presetKey}` as "label.weekly")
      : tP("window", { curCycles: sample.cyclesCur, prevCycles: sample.cyclesPrev })
    : tO("compare");
  const move = (dir: 1 | -1) => {
    const i = OVERVIEW_KPI_KEYS.indexOf(focus);
    const next = OVERVIEW_KPI_KEYS[(i + dir + OVERVIEW_KPI_KEYS.length) % OVERVIEW_KPI_KEYS.length];
    onFocus(next);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-rn-kpi="${next}"]`)?.focus());
  };
  return (
    <RnCard className="@container/rnboard" aria-label={t("boardTitle")}>
      <RnCardHeader title={t("boardTitle")} hint={t("boardHint")} />
      <div className={cx("grid h-[34px] items-center gap-3 border-y border-rn-line pr-4 pl-6 text-rn-12 font-semibold text-rn-muted", BOARD_COLS)}>
        <span>{t("colKpi")}</span>
        <span>{t("colValue")}</span>
        <span>{compareTitle}</span>
        <span>{t("colTrend")}</span>
        <span className="@max-[700px]/rnboard:hidden">{t("colTopRival")}</span>
        <span />
      </div>
      <div role="radiogroup" aria-label={t("kpiPicker")}>
        {OVERVIEW_KPI_KEYS.map((key, i) => {
          const state = overviewCardState(byKey.get(key));
          const on = key === focus;
          const name = tKpi(`name.${key}`);
          return (
            <div
              key={key}
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-rn-kpi={key}
              onClick={() => onFocus(key)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                  e.preventDefault();
                  move(1);
                } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  move(-1);
                } else if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onFocus(key);
                }
              }}
              className={cx(
                "relative grid min-h-[72px] cursor-pointer items-center gap-3 pr-4 pl-6 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-sky",
                BOARD_COLS,
                i < OVERVIEW_KPI_KEYS.length - 1 && "border-b border-rn-line",
                i === OVERVIEW_KPI_KEYS.length - 1 && "rounded-b-rn-card",
                on ? "bg-rn-navy text-white before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-rn-sky" : "text-rn-ink hover:bg-rn-navy-25",
              )}
            >
              <div className="flex min-w-0 flex-col gap-0.5 py-3">
                <b className="inline-flex items-center gap-1.5 text-rn-15 font-bold">
                  {name}
                  <RnInfoTip label={t("infoLabel", { name })}>
                    <RnInfoTipItem label={t("definition")}>{tKpi(`definition.${infoKeyOf(key)}` as "definition.visibility")}</RnInfoTipItem>
                    <RnInfoTipItem label={t("formula")}>{tKpi(`formula.${infoKeyOf(key)}` as "formula.visibility")}</RnInfoTipItem>
                  </RnInfoTip>
                </b>
                <small className={cx("text-rn-12", on ? "text-white/75" : "text-rn-muted")}>{tKpi(`question.${QUESTION_KEY[key]}` as "question.coverage")}</small>
              </div>
              <KpiValue k={key} value={state.value} />
              <div>
                <DeltaCell k={key} pending={state.pending} deferred={deferred} periodCompare={periodCompare} periodDays={periodDays} periodLabelCtx={periodLabelCtx} onDark={on} />
              </div>
              <div>
                {state.pending ? null : (
                  <Suspense fallback={<RnSkeleton className="h-9 w-full" />}>
                    <SparkCell k={key} trend={deferred.trend} onDark={on} />
                  </Suspense>
                )}
              </div>
              <div className={cx("text-rn-12 leading-snug @max-[700px]/rnboard:hidden", on ? "text-white/75" : "text-rn-muted")}>
                {state.pending ? null : (
                  <Suspense fallback={<RnSkeleton className="h-4 w-24" />}>
                    <TopRivalCell k={key} competitors={deferred.competitors} onDark={on} />
                  </Suspense>
                )}
              </div>
              <Link
                href={detailHref(key, locale, qs)}
                aria-label={t("detailLabel", { name })}
                title={tO("openDetail")}
                onClick={(e) => e.stopPropagation()}
                className={cx("grid size-8 place-items-center rounded-rn-control focus-visible:outline-2 focus-visible:outline-current", on ? "text-white hover:bg-white/14" : "text-rn-muted hover:bg-rn-inset hover:text-rn-ink")}
              >
                <ArrowUpRight className="size-[18px]" aria-hidden />
              </Link>
            </div>
          );
        })}
      </div>
    </RnCard>
  );
}

const QUESTION_KEY: Record<OverviewKpiKey, string> = {
  visibility: "coverage",
  shareOfVoice: "density",
  sentiment: "favorability",
  position: "priority",
  citationShare: "citationVolume",
};

function KpiValue({ k, value }: { k: OverviewKpiKey; value: number | null }) {
  const tO = useTranslations("dashboard.overview");
  const tUnit = useTranslations("metricUnit");
  if (value == null) return <span className="text-rn-13 font-semibold opacity-75">{tO("cardEmpty")}</span>;
  if (isRank(k)) {
    // "{n}번째" — the number big, the unit word small (same string as the card).
    const full = tUnit("position", { n: value.toFixed(1) });
    const n = value.toFixed(1);
    const at = full.indexOf(n);
    return (
      <span className="text-rn-32 leading-none font-bold tracking-[-0.02em] tabular-nums" data-rn-value={k}>
        {at >= 0 ? (
          <>
            {full.slice(0, at)}
            {n}
            <small className="ml-px text-rn-15 font-semibold">{full.slice(at + n.length)}</small>
          </>
        ) : (
          full
        )}
      </span>
    );
  }
  return (
    <span className="text-rn-32 leading-none font-bold tracking-[-0.02em] tabular-nums" data-rn-value={k}>
      {value.toFixed(1)}
      <small className="ml-px text-rn-15 font-semibold">%</small>
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
  onDark,
}: {
  k: OverviewKpiKey;
  pending: boolean;
  deferred: OverviewDeferredData;
  periodCompare: readonly CompareResult[] | null;
  periodDays?: number;
  periodLabelCtx: PeriodLabelCtx;
  onDark: boolean;
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
      <RnToneChip tone={tone} onDark={onDark} title={caption.key === "window" ? undefined : tP(caption.key, caption.params)}>
        {periodChipText(chip)}
      </RnToneChip>
    );
  }
  return (
    <Suspense fallback={<RnSkeleton className="h-6 w-16" />}>
      <TrendDelta k={k} deltas={deferred.deltas} onDark={onDark} labels={{ up: t("deltaUp"), down: t("deltaDown"), flat: t("deltaFlat") }} />
    </Suspense>
  );
}

function TrendDelta({ k, deltas, onDark, labels }: { k: OverviewKpiKey; deltas: Promise<KpiSummary[]>; onDark: boolean; labels: { up: string; down: string; flat: string } }) {
  const applied = use(deltas);
  const f = useFormat();
  const d = overviewCardState(applied.find((x) => x.key === k)).delta;
  return <RnDeltaChip delta={d} lowerIsBetter={isRank(k)} format={(r) => f.delta(k, r)} emptyText={NO_DELTA} labels={labels} onDark={onDark} />;
}

function SparkCell({ k, trend, onDark }: { k: OverviewKpiKey; trend: Promise<LiveTrend | null>; onDark: boolean }) {
  const points = sparkPoints(use(trend), k);
  if (!points.some((p) => p.value != null)) return null;
  return <RnSparkline values={points.map((p) => p.value)} invert={isRank(k)} tone={onDark ? "onDark" : "default"} />;
}

/** The card's competitor row, kpi-wise (citation share folds official competitor domains). */
function minisFor(src: OverviewCompetitorSources | null, k: OverviewKpiKey): CompetitorMini[] {
  if (k === "citationShare") return competitorCitationShares(src?.citationDomains ?? null, undefined, src?.citationTotal ?? null);
  const deltas = competitorDeltas(src, k);
  return competitorMinis(src?.brands ?? [], k).map((m) => ({ ...m, delta: deltas.get(m.brand) ?? null }));
}

function TopRivalCell({ k, competitors, onDark }: { k: OverviewKpiKey; competitors: Promise<OverviewCompetitorSources | null>; onDark: boolean }) {
  const tO = useTranslations("dashboard.overview");
  const f = useFormat();
  const top = minisFor(use(competitors), k)[0];
  if (!top) return <span>{tO("noCompetitorData")}</span>;
  return (
    <span>
      <b className={cx("font-semibold", onDark ? "text-white" : "text-rn-ink-2")}>{top.brand}</b> {f.value(k, top.value, "—")}
    </span>
  );
}

// ─── brand comparison (own value + the card's 4 competitors) ───────────────

function BrandCompare({
  focus,
  kpi,
  deferred,
  periodCompare,
  ownLabel,
}: {
  focus: OverviewKpiKey;
  kpi: KpiSummary | undefined;
  deferred: OverviewDeferredData;
  periodCompare: readonly CompareResult[] | null;
  ownLabel: string;
}) {
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi.name");
  const f = useFormat();
  const src = use(deferred.competitors);
  const applied = use(deferred.deltas);
  const state = overviewCardState(kpi);
  // A chosen period wins (a suppressed result stays suppressed — the card rule).
  const periodResult = selectPeriodResult(periodCompare, compareMetricForKpiKey(focus));
  const ownDelta = periodResult ? periodResult.delta : overviewCardState(applied.find((x) => x.key === focus)).delta;
  const rows = [
    { brand: ownLabel, value: state.value, delta: ownDelta, own: true },
    ...minisFor(src, focus).map((m) => ({ brand: m.brand, value: m.value, delta: m.delta ?? null, own: false })),
  ];
  rows.sort((a, b) => {
    if (a.value == null && b.value == null) return 0;
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return isRank(focus) ? a.value - b.value : b.value - a.value;
  });
  const rank = rows.findIndex((r) => r.own) + 1;
  const width = (v: number | null) => (v == null ? 0 : isRank(focus) ? Math.max(4, Math.min(100, ((30 - v) / 29) * 100)) : Math.max(0, Math.min(100, v)));
  const labels = { up: t("deltaUp"), down: t("deltaDown"), flat: t("deltaFlat") };
  return (
    <RnCard aria-label={t("brandsTitle")}>
      <RnCardHeader
        title={t("brandsTitle")}
        hint={`${isRank(focus) ? `${t("rankHint")} · ` : ""}${t("brandsHint")}`}
        actions={state.value != null && rows.length > 1 ? <span className="text-rn-12 text-rn-muted">{t("ourRank", { rank, count: rows.length })}</span> : null}
      />
      {state.pending ? (
        <RnEmpty className="mx-6 mb-5">{tO("cardEmpty")}</RnEmpty>
      ) : (
        <div className="flex flex-col gap-2 px-6 pb-5" data-rn-brands={focus} aria-label={tKpi(focus)}>
          {rows.map((r) => (
            <div key={`${r.own ? "own:" : ""}${r.brand}`} className="grid grid-cols-[minmax(0,120px)_minmax(40px,1fr)_72px_84px] items-center gap-2.5 text-rn-13">
              <span className="flex min-w-0 items-center gap-1.5 font-semibold text-rn-ink">
                <span className="truncate">{r.brand}</span>
                {r.own ? <RnTag>{t("ownTag")}</RnTag> : null}
              </span>
              <span className="h-2.5 overflow-hidden rounded-[3px] bg-rn-page">
                <i className={cx("block h-full rounded-[3px]", r.own ? "bg-rn-navy" : "bg-rn-faint")} style={{ width: `${width(r.value)}%` }} />
              </span>
              <span className="text-right font-bold tabular-nums text-rn-ink">{f.value(focus, r.value, "—")}</span>
              <span className="text-right">
                <RnDeltaChip delta={r.delta} lowerIsBetter={isRank(focus)} format={(x) => f.delta(focus, x)} emptyText={NO_DELTA} labels={labels} />
              </span>
            </div>
          ))}
          {rows.length === 1 ? <RnEmpty className="mt-1">{tO("noCompetitorData")}</RnEmpty> : null}
        </div>
      )}
    </RnCard>
  );
}

// ─── markets (LiveGeo) ──────────────────────────────────────────────────────

function useGeoView(geo: LiveGeo | null, focus: OverviewKpiKey) {
  return useMemo(() => {
    const markets = geo?.markets ?? [];
    const sortv = (a: MarketCompetition, b: MarketCompetition) => {
      const av = metricValue(a, focus);
      const bv = metricValue(b, focus);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return isRank(focus) ? av - bv : bv - av;
    };
    const regions = markets.map((m) => ({ ...m, countries: [...m.countries].sort(sortv) }));
    const values = regions.flatMap((m) => m.countries.map((c) => metricValue(c, focus))).filter((v): v is number => v != null).sort((a, b) => a - b);
    // 5 quantile bins over this view's countries; rank: lower (= ahead) is darker.
    const bin = (v: number | null): number | null => {
      if (v == null || values.length === 0) return null;
      const b = Math.min(4, Math.floor((values.indexOf(v) / values.length) * 5));
      return isRank(focus) ? 4 - b : b;
    };
    return { regions, bin };
  }, [geo, focus]);
}

const rivalOf = (m: MarketCompetition, k: OverviewKpiKey) =>
  m.metrics?.[k]?.rival ?? (k === "shareOfVoice" && m.topRival ? { name: m.topRival.name, value: m.topRival.sov } : null);

function MarketTiles({ geo: geoP, focus, hi, onHi }: { geo: Promise<LiveGeo | null>; focus: OverviewKpiKey; hi: string | null; onHi: (c: string | null) => void }) {
  const geo = use(geoP);
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi.name");
  const locale = useLocale();
  const f = useFormat();
  const { regions, bin } = useGeoView(geo, focus);
  const kpi = tKpi(focus);
  return (
    <RnCard aria-label={t("marketsTitle", { kpi })}>
      <RnCardHeader
        title={t("marketsTitle", { kpi })}
        actions={
          regions.length ? (
            <span className="inline-flex items-center gap-1.5 text-rn-12 text-rn-muted" title={isRank(focus) ? tO("geo.mapCaptionRank", { label: kpi }) : tO("geo.mapCaption", { label: kpi })}>
              {isRank(focus) ? t("legendRankBack") : t("legendLow")}
              {BINS.map((c) => (
                <i key={c} className={cx("inline-block h-2.5 w-5 rounded-[2px]", c)} />
              ))}
              {isRank(focus) ? t("legendRankFront") : t("legendHigh")}
            </span>
          ) : null
        }
      />
      {regions.length === 0 ? (
        <RnEmpty className="mx-6 mb-5">{tO("geo.brandRequired")}</RnEmpty>
      ) : (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3.5 px-6 pt-1 pb-5">
          {regions.map((m) => (
            <div key={m.region} className="max-w-full">
              <h4 className="m-0 mb-1.5 flex items-baseline gap-2 text-rn-12 font-bold text-rn-ink-2">
                {rhqLabel(m.region, locale === "en" ? "en" : "ko") ?? m.region}
                <span className="font-medium text-rn-muted">{t("countryCount", { count: m.countries.length })}</span>
              </h4>
              <div className="flex flex-wrap gap-1">
                {m.countries.map((c) => {
                  const v = metricValue(c, focus);
                  const b = bin(v);
                  const rival = rivalOf(c, focus);
                  return (
                    <button
                      key={c.code}
                      type="button"
                      data-rn-tile={c.code}
                      aria-pressed={hi === c.code}
                      aria-label={`${countryName(c.code, locale)} ${f.value(focus, v, "—")}`}
                      title={[
                        countryName(c.code, locale),
                        `${kpi} ${f.value(focus, v, "—")}`,
                        `${tO("geo.colRival")} ${rival ? `${rival.name} ${f.value(focus, rival.value, "—")}` : tO("geo.noRival")}`,
                        c.answers != null ? `${t("colAnswers")} ${c.answers.toLocaleString(locale)}` : null,
                      ]
                        .filter(Boolean)
                        .join("\n")}
                      onClick={() => onHi(hi === c.code ? null : c.code)}
                      className={cx(
                        "relative flex h-[50px] w-16 cursor-pointer flex-col items-center justify-center gap-px rounded-md tabular-nums shadow-[inset_0_0_0_1px_rgba(10,9,8,0.06)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rn-navy",
                        b == null ? "bg-rn-page text-rn-muted" : BINS[b],
                        b != null && b >= 3 ? "text-white" : "text-rn-ink",
                        hi === c.code && "z-[1] shadow-[0_0_0_2px_var(--color-rn-surface),0_0_0_4px_var(--color-rn-ink)]",
                      )}
                    >
                      <span className="font-mono text-rn-11 font-bold tracking-[0.04em]">{c.code}</span>
                      <span className="text-rn-12 font-semibold">{f.value(focus, v, "—")}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </RnCard>
  );
}

function MarketTable({ geo: geoP, focus, hi, onHi }: { geo: Promise<LiveGeo | null>; focus: OverviewKpiKey; hi: string | null; onHi: (c: string | null) => void }) {
  const geo = use(geoP);
  const t = useTranslations("renewal.overview");
  const tO = useTranslations("dashboard.overview");
  const tKpi = useTranslations("dashboard.kpi.name");
  const locale = useLocale();
  const f = useFormat();
  const { regions } = useGeoView(geo, focus);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (regions.length === 0) return null;
  const kpi = tKpi(focus);
  const barPct = (v: number | null) => (v == null ? 0 : isRank(focus) ? Math.max(4, Math.min(100, ((30 - v) / 29) * 100)) : Math.max(0, Math.min(100, v)));
  const valueCell = (v: number | null, strong: boolean) => (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2.5">
      <b className={cx("text-right tabular-nums", strong ? "font-bold" : "font-semibold")}>{f.value(focus, v, "—")}</b>
      <span className="h-2 overflow-hidden rounded-[3px] bg-rn-page">
        <i className={cx("block h-full rounded-[3px]", strong ? "bg-rn-navy-500" : "bg-rn-navy")} style={{ width: `${barPct(v)}%` }} />
      </span>
    </div>
  );
  const rivalCell = (m: MarketCompetition) => {
    const r = rivalOf(m, focus);
    return r ? (
      <span className="text-rn-12 text-rn-muted">
        <b className="font-semibold text-rn-ink-2">{r.name}</b> {f.value(focus, r.value, "—")}
      </span>
    ) : (
      <span className="text-rn-12 text-rn-muted">{tO("geo.noRival")}</span>
    );
  };
  return (
    <RnCard aria-label={t("tableTitleRegion", { kpi })}>
      <RnCardHeader title={t("tableTitleRegion", { kpi })} hint={t("tableHint")} />
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13" data-rn-geo-table="">
          <colgroup>
            <col />
            <col className="w-[30%]" />
            <col className="w-[190px]" />
            <col className="w-[88px]" />
          </colgroup>
          <thead>
            <tr className="text-left text-rn-12 font-semibold text-rn-muted">
              <th scope="col" className="h-[38px] border-y border-rn-line pr-3 pl-6 font-semibold">{tO("geo.colRegion")}</th>
              <th scope="col" className="h-[38px] border-y border-rn-line px-3 font-semibold">{kpi}</th>
              <th scope="col" className="h-[38px] border-y border-rn-line px-3 font-semibold" title={t("rivalBasis")}>{tO("geo.colRival")}</th>
              <th scope="col" className="h-[38px] border-y border-rn-line pr-6 pl-3 text-right font-semibold">{t("colAnswers")}</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((m) => {
              const open = !closed.has(m.region);
              const label = rhqLabel(m.region, locale === "en" ? "en" : "ko") ?? m.region;
              return (
                <RegionRows key={m.region}>
                  <tr className="bg-rn-page font-bold">
                    <td className="border-b border-rn-line py-2.5 pr-3 pl-6">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={open ? t("collapseRegion", { region: label }) : t("expandRegion", { region: label })}
                        onClick={() =>
                          setClosed((cur) => {
                            const n = new Set(cur);
                            if (n.has(m.region)) n.delete(m.region);
                            else n.add(m.region);
                            return n;
                          })
                        }
                        className="inline-flex cursor-pointer items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:outline-rn-navy"
                      >
                        <ChevronRight aria-hidden className={cx("size-3.5 text-rn-muted transition-transform", open && "rotate-90")} />
                        {label}
                        <span className="font-medium text-rn-muted">{t("countryCount", { count: m.countries.length })}</span>
                      </button>
                    </td>
                    <td className="border-b border-rn-line px-3 py-2.5">{valueCell(metricValue(m, focus), true)}</td>
                    <td className="border-b border-rn-line px-3 py-2.5">{rivalCell(m)}</td>
                    <td className="border-b border-rn-line py-2.5 pr-6 pl-3 text-right font-semibold text-rn-muted tabular-nums">{m.answers != null ? m.answers.toLocaleString(locale) : "—"}</td>
                  </tr>
                  {open
                    ? m.countries.map((c) => (
                        <tr
                          key={c.code}
                          data-rn-row={c.code}
                          aria-selected={hi === c.code}
                          onClick={() => onHi(hi === c.code ? null : c.code)}
                          className={cx("cursor-pointer hover:bg-rn-navy-25", hi === c.code && "bg-rn-navy-25 shadow-[inset_0_1px_0_var(--color-rn-navy-300),inset_0_-1px_0_var(--color-rn-navy-300)]")}
                        >
                          <td className="border-b border-rn-line py-2.5 pr-3 pl-12">
                            <span className="mr-1.5 rounded bg-rn-inset px-1.5 py-px font-mono text-rn-11 font-semibold tracking-[0.04em] text-rn-ink-2">{c.code}</span>
                            {countryName(c.code, locale)}
                          </td>
                          <td className="border-b border-rn-line px-3 py-2.5">{valueCell(metricValue(c, focus), false)}</td>
                          <td className="border-b border-rn-line px-3 py-2.5">{rivalCell(c)}</td>
                          <td className="border-b border-rn-line py-2.5 pr-6 pl-3 text-right text-rn-muted tabular-nums">{c.answers != null ? c.answers.toLocaleString(locale) : "—"}</td>
                        </tr>
                      ))
                    : null}
                </RegionRows>
              );
            })}
          </tbody>
        </table>
      </div>
    </RnCard>
  );
}

function RegionRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
