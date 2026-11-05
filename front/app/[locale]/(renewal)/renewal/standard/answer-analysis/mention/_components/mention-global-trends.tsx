"use client";

import { Suspense, use, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowUpRight, Eye, PieChart, Search, Smile, Tag, Trophy } from "lucide-react";
import { RnCard, RnEmpty, RnLineChart, RnSkeleton, RnTextButton, cx } from "@/components/renewal-ui";
import { useRnFilterToggle } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import type { KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import { OWN_KEY, type PresenceKey, type PresenceValues, type RnDelta } from "../_data/screen-types";
import { MentionCardActions, OWN_COLOR, numTxt, pctTxt, posTxt, slotLabel, useCompare, useMention } from "./mention-context";
import { CardSkeleton, DegradedNote, DeltaChip, InfoTip, TwinTable, useDegradedText, useDeltaBasis, useDeltaNote } from "./mention-kit";
import { KPI_QUESTION } from "./mention-tabs";

// 당사 지표 tab of the Global Mention (2026-11-05 개편, docs/handoff/global-mention-redesign.md): the four KPIs as trend
// cards — exposure · share large, favorability · first-rank compact — each with its value, Δ and basis, its counts, where
// 당사 stands, 당사's line (one chart crosshair for all four: syncId), the brand-presence split and a table twin.

const SYNC = "rn-mention-g-trend";
const ICON: Record<KpiTab, ReactNode> = { exposure: <Eye />, sov: <PieChart />, favorability: <Smile />, "first-rank": <Trophy /> };
/** a KPI tab → its dashboard.kpi key (name · definition · formula) */
export const KPI_KEY = { exposure: "visibility", sov: "shareOfVoice", favorability: "sentiment", "first-rank": "position" } as const;

export function GlobalTrendGrid() {
  return (
    <div data-rn-gtrends="" className="grid grid-cols-1 gap-4 @min-[900px]/rncontent:grid-cols-2">
      {(["exposure", "sov", "favorability", "first-rank"] as const).map((k) => (
        <TrendCard key={k} kpi={k} />
      ))}
    </div>
  );
}

function TrendCard({ kpi }: { kpi: KpiTab }) {
  const t = useTranslations("renewal.mention");
  const tName = useTranslations("dashboard.kpi.name");
  const tDef = useTranslations("dashboard.kpi");
  const tQ = useTranslations("dashboard.kpi.question");
  const tF = useTranslations("answerAnalysis.mentions.kpi.favorability");
  const tFR = useTranslations("answerAnalysis.mentions.kpi.firstRank");
  const large = kpi === "exposure" || kpi === "sov";
  // the original tab's question (its title and section line), the hero's definition · formula · basis and the trend's note
  const def: ReadonlyArray<[ReactNode, ReactNode]> = [
    [t("g.questionLabel"), tQ(KPI_QUESTION[kpi] as "coverage")],
    [tDef("definitionLabel"), tDef(`definition.${KPI_KEY[kpi]}`)],
    [tDef("formulaLabel"), kpi === "first-rank" ? t("rank.formula") : tDef(`formula.${KPI_KEY[kpi]}`)],
    [t("hero.basisLabel"), t("hero.basisAll")],
    ...(kpi === "favorability" ? [[t("hero.trendNoteLabel"), tF("trendNote")] as [string, string]] : kpi === "first-rank" ? [[t("hero.trendNoteLabel"), tFR("chartNote")] as [string, string]] : []),
  ];
  return (
    <RnCard aria-label={tName(KPI_KEY[kpi])} data-rn-gcard={kpi} className="flex flex-col">
      <div className="flex min-h-[58px] flex-wrap items-center gap-2.5 pr-4 pl-5">
        <span aria-hidden className="grid size-[34px] place-items-center rounded-[10px] bg-rn-track text-rn-ink-2 [&_svg]:size-[18px]">
          {ICON[kpi]}
        </span>
        <h2 className="m-0 text-rn-15 font-semibold tracking-[-0.015em] text-rn-ink">{tName(KPI_KEY[kpi])}</h2>
        <InfoTip label={t("hero.trendNoteLabel")} items={def} />
        <Suspense fallback={null}>
          <Standing kpi={kpi} />
        </Suspense>
        {kpi === "favorability" ? <span className="text-rn-12 text-rn-muted">{t("favor.chipSignal")}</span> : null}
        <span className="ml-auto">
          <Suspense fallback={null}>
            <TrendActions kpi={kpi} />
          </Suspense>
        </span>
      </div>
      <div className="flex flex-1 flex-col px-[22px] pb-4">
        <Suspense fallback={<RnSkeleton className="h-10 w-64" />}>
          <ValueRow kpi={kpi} />
        </Suspense>
        <Suspense fallback={<CardSkeleton height={large ? 176 : 100} className="px-0" />}>
          <TrendBody kpi={kpi} height={large ? 176 : 100} />
        </Suspense>
        <Suspense fallback={null}>
          <PresenceSplit kpi={kpi} compact={!large} />
        </Suspense>
      </div>
    </RnCard>
  );
}

// ── value · Δ · counts ─────────────────────────────────────────────────────────

function BigValue({ value, unit }: { value: string; unit: string }) {
  return (
    <b data-rn-gvalue="" className="text-[34px] leading-[1.15] font-[550] tracking-[-0.035em] text-rn-ink tabular-nums [[data-rn-gcard=favorability]_&]:text-[28px] [[data-rn-gcard=first-rank]_&]:text-[28px]">
      {value}
      <small className="ml-0.5 text-rn-15 font-medium tracking-normal text-rn-muted">{unit}</small>
    </b>
  );
}

function DeltaWithBasis({ delta, rank = false }: { delta: RnDelta; rank?: boolean }) {
  const basis = useDeltaBasis();
  const note = useDeltaNote();
  const t = useTranslations("renewal.mention.delta");
  const text = basis(delta);
  const foot = note(delta, rank);
  return (
    <>
      <DeltaChip value={delta.value} rank={rank} />
      {text ? <span className="text-rn-13 text-rn-muted">{text}</span> : null}
      {foot ? <InfoTip label={t("label")} items={[[t("label"), foot]]} /> : null}
    </>
  );
}

function ValueRow({ kpi }: { kpi: KpiTab }) {
  const { input } = useMention();
  const t = useTranslations("renewal.mention");
  const tTip = useTranslations("answerAnalysis.mentions.kpi.tooltip");
  const tF = useTranslations("answerAnalysis.mentions.kpi.favorability");
  const dg = useDegradedText();
  const locale = useLocale();
  // a read that failed or was suppressed says so under the value (the original heroes' note)
  const row = (value: ReactNode, right: ReactNode, degraded: boolean) => (
    <>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {value}
        {right}
      </div>
      {degraded ? <DegradedNote>{dg.all}</DegradedNote> : null}
    </>
  );
  if (kpi === "exposure" || kpi === "sov") {
    const rv = use(input.rateValue);
    const v = rv[kpi];
    const hero = use(input.rateHero)[kpi];
    return row(
      <>
        <BigValue value={v.pct != null ? v.pct.toFixed(1) : "—"} unit="%" />
        <DeltaWithBasis delta={hero.delta} />
      </>,
      <span className="ml-auto text-rn-12 text-rn-muted tabular-nums">
        {tTip(kpi === "sov" ? "sovNumerator" : "exposureNumerator")} {numTxt(v.numerator, locale)} · {tTip(kpi === "sov" ? "sovDenominator" : "exposureDenominator")}{" "}
        {numTxt(v.denominator, locale)}
      </span>,
      rv.degraded,
    );
  }
  if (kpi === "favorability") {
    const f = use(input.favorHero);
    return row(
      <>
        <BigValue value={f.positivePct != null ? f.positivePct.toFixed(1) : "—"} unit="%" />
        <DeltaWithBasis delta={f.positiveDelta} />
      </>,
      <span className="ml-auto inline-flex items-center gap-1.5 text-rn-12 text-rn-muted tabular-nums">
        {t("favor.negative")} <b className="font-semibold text-rn-ink-2">{pctTxt(f.negativePct)}</b>
        <DeltaChip value={f.negativeDelta.value} invert />
        {f.mixedBasis ? <InfoTip label={t("favor.negativeBasisLabel")} align="end" items={[[t("favor.negativeBasisLabel"), tF("negativeBasisNote")]]} /> : null}
      </span>,
      f.degraded,
    );
  }
  const r = use(input.rank);
  return row(
    <>
      <BigValue value={r.hero.avgPosition != null ? posTxt(r.hero.avgPosition) : "—"} unit={t("g.rankUnit")} />
      <DeltaWithBasis delta={r.hero.delta} rank />
    </>,
    <span className="ml-auto text-rn-12 text-rn-muted">{t("g.rankHint")}</span>,
    r.degraded,
  );
}

/** Where 당사 stands among the brands by this KPI: the board's / rank table's / drawer brands' place (BFF values). */
function Standing({ kpi }: { kpi: KpiTab }) {
  const { input, favStanding } = useMention();
  const t = useTranslations("renewal.mention.g");
  let text: string | null = null;
  let tip: string | null = null;
  if (kpi === "exposure" || kpi === "sov") {
    const st = use(input.rateHero)[kpi].standing;
    if (st) {
      text = t("standing", { n: st.n, rank: st.rank });
      tip = t("standingTipBoard", { n: st.n });
    }
  } else if (kpi === "first-rank") {
    const st = use(input.rank).standing;
    if (st) {
      text = t("standing", { n: st.total, rank: st.rank });
      tip = t("standingTipRank", { n: st.total, top: st.topPct });
    }
  } else if (favStanding) {
    text = t("standing", { n: favStanding.n, rank: favStanding.rank });
    tip = t("standingTipFav", { n: favStanding.n });
  }
  if (!text) return null;
  return (
    <span data-rn-standing={kpi} title={tip ?? undefined} className="inline-flex h-6 cursor-help items-center rounded-[7px] bg-rn-track px-2 text-rn-12 font-medium whitespace-nowrap text-rn-muted [&_b]:font-semibold [&_b]:text-rn-ink">
      {text}
    </span>
  );
}

// ── trend: 당사's line on the shared crosshair, or its table twin ─────────────────

interface TrendData {
  x: string[];
  values: (number | null)[];
  note: (i: number) => string[] | null;
  /** table twin rows under the series row */
  extra: Array<[string, (number | null)[]]>;
  fmt: (v: number | null) => string;
  invert: boolean;
  missing: boolean;
  csvName: string;
}

function useTrendData(kpi: KpiTab): TrendData {
  const { input } = useMention();
  const t = useTranslations("renewal.mention");
  const tTip = useTranslations("answerAnalysis.mentions.kpi.tooltip");
  const locale = useLocale();
  const count = (v: number | null) => (v == null ? "—" : tTip("count", { n: numTxt(v, locale) }));
  if (kpi === "exposure" || kpi === "sov") {
    const s = use(input.rateHero)[kpi].trend;
    const numL = tTip(kpi === "sov" ? "sovNumerator" : "exposureNumerator");
    const denL = tTip(kpi === "sov" ? "sovDenominator" : "exposureDenominator");
    return {
      x: s.x,
      values: s.own,
      note: (i) => (s.ownNum[i] == null ? null : [`${numL} ${count(s.ownNum[i])}`, `${denL} ${count(s.ownDen[i])}`]),
      extra: [
        [numL, s.ownNum],
        [denL, s.ownDen],
      ],
      fmt: pctTxt,
      invert: false,
      missing: s.missing,
      csvName: `mention-${kpi}-trend`,
    };
  }
  if (kpi === "favorability") {
    const f = use(input.favorHero);
    const pts = f.points;
    // the positive share draws; the negative share is the card head's value, the tooltip line and the table row
    return {
      x: pts.map((p) => p.key),
      values: pts.map((p) => p.positive),
      note: (i) => {
        const p = pts[i];
        if (!p || p.positive == null) return null;
        return [`${t("favor.negative")} ${pctTxt(p.negative)}`, `${t("favor.posCount")} ${count(p.positiveCount)}`, `${t("favor.total")} ${count(p.total)}`];
      },
      extra: [
        [t("favor.negative"), pts.map((p) => p.negative)],
        [t("favor.posCount"), pts.map((p) => p.positiveCount)],
        [t("favor.total"), pts.map((p) => p.total)],
      ],
      fmt: pctTxt,
      invert: false,
      missing: f.trendMissing,
      csvName: "mention-favorability-trend",
    };
  }
  const r = use(input.rank);
  return {
    x: r.hero.axis,
    values: r.hero.series,
    note: (i) => (r.hero.rankedSeries[i] == null ? null : [`${t("rank.ranked")} ${t("rank.count", { n: numTxt(r.hero.rankedSeries[i], locale) })}`]),
    extra: [[t("rank.ranked"), r.hero.rankedSeries]],
    fmt: (v) => (v == null ? "—" : t("rank.unit", { n: posTxt(v) })),
    invert: true,
    missing: !r.fp,
    csvName: "mention-first-position-trend",
  };
}

function TrendActions({ kpi }: { kpi: KpiTab }) {
  const { ownLabel } = useMention();
  const d = useTrendData(kpi);
  return (
    <MentionCardActions
      tableId={`g-trend-${kpi}`}
      section={`sec-g-${kpi}`}
      csv={() => ({ name: d.csvName, rows: [["", ...d.x], [ownLabel, ...d.values], ...d.extra.map(([k, v]) => [k, ...v])] })}
    />
  );
}

function TrendBody({ kpi, height }: { kpi: KpiTab; height: number }) {
  const { ownLabel, tables } = useMention();
  const t = useTranslations("renewal.mention");
  const tName = useTranslations("dashboard.kpi.name");
  const dg = useDegradedText();
  const locale = useLocale();
  const d = useTrendData(kpi);
  const x = d.x.map(slotLabel);
  if (d.missing) return <DegradedNote>{dg.trend}</DegradedNote>;
  if (!d.x.length) return <RnEmpty className="mt-2.5">{t("hero.noTrend")}</RnEmpty>;
  if (tables.has(`g-trend-${kpi}`)) {
    return (
      <div className="mt-2.5" style={{ minHeight: height }}>
        <TwinTable head={["", ...x]} rows={[[ownLabel, ...d.values.map(d.fmt)], ...d.extra.map(([k, v]) => [k, ...v.map((n) => (kpi === "favorability" && k === t("favor.negative") ? pctTxt(n) : numTxt(n, locale)))])]} />
      </div>
    );
  }
  return (
    <div className="mt-2.5">
      <RnLineChart
        x={x}
        series={[{ key: OWN_KEY, name: ownLabel, color: OWN_COLOR, values: d.values, own: true }]}
        height={height}
        yTick={(v) => (d.invert ? String(+v.toFixed(1)) : `${+v.toFixed(1)}%`)}
        value={(v) => d.fmt(v)}
        tooltipTitle={(day) => t("hero.tooltip", { x: day })}
        tooltipNote={d.note}
        ariaLabel={t("hero.trendAria", { metric: tName(KPI_KEY[kpi]) })}
        invert={d.invert}
        syncId={SYNC}
        endLabels={false}
        curve="monotone"
      />
    </div>
  );
}

// ── 브랜드 미포함 · 포함 질문 (the filter '브랜드 포함 여부') ──────────────────────────

function PresenceSplit({ kpi, compact }: { kpi: KpiTab; compact: boolean }) {
  const { input, ownLabel } = useMention();
  const { compare } = useCompare();
  const t = useTranslations("renewal.mention.g");
  const locale = useLocale();
  const toggle = useRnFilterToggle();
  if (!input.presence) return null;
  const vm = use(input.presence);
  if (vm.applied) return null;
  const metric = kpi === "first-rank" ? "firstRank" : kpi;
  const fmt = (v: number | null | undefined) => (v == null ? "—" : kpi === "first-rank" ? t("rankShort", { n: v.toFixed(1) }) : `${v.toFixed(1)}%`);
  const of = (p: PresenceKey) => vm.presences[p] ?? null;
  const ub = of("unbranded");
  const br = of("branded");
  // the first picked brand with a value under the unbranded read (favorability has no rival values)
  const ref = metric === "favorability" ? null : compare.find((b) => ub?.brands[b]?.[metric as "exposure"] != null) ?? null;
  const tip = t("presenceTip", { unbranded: numTxt(ub?.own.answers ?? null, locale), branded: numTxt(br?.own.answers ?? null, locale) });
  const onlyUnbranded = () => toggle("brandPresence", "unbranded");
  const own = (p: PresenceValues) => fmt(p.own[metric as keyof PresenceValues["own"]] as number | null);
  if (compact) {
    return (
      <div data-rn-presence={kpi} className="mt-2.5 flex items-center gap-2 overflow-hidden border-t border-rn-line pt-2.5 text-rn-12 whitespace-nowrap text-rn-muted tabular-nums">
        <span title={tip} className="inline-flex cursor-help items-center gap-1.5">
          {t("unbranded")} <b className="font-semibold text-rn-ink">{ownLabel} {ub ? own(ub) : "—"}</b>
          {ref && ub ? <span>· {ref} {fmt(ub.brands[ref]?.[metric as "exposure"])}</span> : null}
        </span>
        <span aria-hidden className="mx-1 h-3 w-px bg-rn-line" />
        <span title={tip} className="cursor-help">
          {t("branded")} <b className="font-semibold text-rn-ink">{ownLabel} {br ? own(br) : "—"}</b>
        </span>
        <RnTextButton className="ml-auto" onClick={onlyUnbranded}>
          {t("onlyUnbranded")} →
        </RnTextButton>
      </div>
    );
  }
  const tile = (icon: ReactNode, label: string, body: ReactNode) => (
    <div title={tip} className="flex min-w-0 cursor-help items-center gap-2.5 rounded-xl px-3 py-1.5 shadow-[inset_0_0_0_1px_var(--color-rn-line)]">
      <span aria-hidden className="grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-rn-track text-rn-muted [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0">
        <small className="block text-rn-12 leading-[1.3] text-rn-muted">{label}</small>
        <span className="block truncate text-rn-12 text-rn-muted tabular-nums">{body}</span>
      </span>
    </div>
  );
  return (
    <div data-rn-presence={kpi} className="mt-2.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
      {tile(
        <Search />,
        t("unbranded"),
        <>
          <b className="font-semibold text-rn-ink">{ownLabel} {ub ? own(ub) : "—"}</b>
          {ref && ub ? ` · ${ref} ${fmt(ub.brands[ref]?.[metric as "exposure"])}` : ""}
        </>,
      )}
      {tile(<Tag />, t("branded"), <b className="font-semibold text-rn-ink">{ownLabel} {br ? own(br) : "—"}</b>)}
      <button
        type="button"
        onClick={onlyUnbranded}
        className={cx("inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 text-rn-12 font-semibold text-rn-navy shadow-[inset_0_0_0_1px_var(--color-rn-line)] hover:bg-rn-page focus-visible:outline-2 focus-visible:outline-rn-navy")}
      >
        {t("onlyUnbranded")}
        <ArrowUpRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
