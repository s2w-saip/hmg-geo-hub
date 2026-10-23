"use client";

import { Suspense, use, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { RnBasisChip, RnCard, RnCardHead, RnEmpty, RnLineChart, RnSectionHead, RnSparkline, cx, rnHighlightState } from "@/components/renewal-ui";
import { overlayFirstPositionValues, rankAxisTicks } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view";
import { OWN_KEY, rankBoard, rankHero, rankSeriesOf } from "./mention-model";
import { CONTEXT_COLOR, MentionCardActions, OWN_COLOR, numTxt, posTxt, slotLabel, useCompare, useMention } from "./mention-context";
import { BrandName, CardSkeleton, DegradedNote, DeltaChip, InfoTip, Legend, Stat, TwinTable, useDeltaBasis } from "./mention-kit";
import { KpiBasisChip } from "./mention-tabs";

export function RankBody() {
  const t = useTranslations("renewal.mention");
  return (
    <>
      <RnCard aria-label={t("rank.label")}>
        <Suspense fallback={<CardSkeleton height={320} />}>
          <RankHeroCard />
        </Suspense>
      </RnCard>
      <RnSectionHead id="sec-comp" title={t("sec.rank")} chip={<KpiBasisChip />} desc={t("sec.rankDesc")} />
      <RnCard aria-label={t("rank.tableTitle")}>
        <Suspense fallback={<CardSkeleton height={420} />}>
          <RankTable />
        </Suspense>
      </RnCard>
    </>
  );
}

function useRank() {
  const { input } = useMention();
  const fp = use(input.firstPosition);
  const values = use(input.competitorValues);
  const period = use(input.periodCompare);
  return useMemo(() => {
    const overlaid = overlayFirstPositionValues(fp, values);
    const hero = rankHero(overlaid, period);
    return { fp: overlaid, hero, ...rankBoard(fp, values, hero) };
  }, [fp, values, period]);
}

function RankHeroCard() {
  const { input, ownLabel, lit, hover, tables } = useMention();
  const { compare, colorOf } = useCompare();
  const t = useTranslations("renewal.mention.rank");
  const tH = useTranslations("renewal.mention.hero");
  const tFR = useTranslations("answerAnalysis.mentions.kpi.firstRank");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const tDef = useTranslations("dashboard.kpi");
  const locale = useLocale();
  const degraded = use(input.degraded.firstRank);
  const { fp, hero, rows, ahead } = useRank();
  const basis = useDeltaBasis();
  const series = [
    ...compare.map((b) => ({ key: b, name: b, color: colorOf(b), values: rankSeriesOf(fp, b, hero.axis) })).filter((s) => s.values.some((v) => v != null)),
    { key: OWN_KEY, name: ownLabel, color: OWN_COLOR, values: hero.series, own: true },
  ];
  const observed = Math.max(0, ...series.flatMap((s) => s.values).filter((v): v is number => v != null));
  const hi = Math.max(5, Math.ceil(observed));
  const x = hero.axis.map(slotLabel);
  const tableOn = tables.has("rank-trend");
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 px-6 pt-5.5 pb-5 @min-[640px]/rnpage:grid-cols-[minmax(220px,290px)_minmax(0,1fr)] [.rn-dense_&]:px-4.5 [.rn-dense_&]:py-3.5">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-1.5 text-rn-12 font-bold text-rn-muted">
          {t("label")}
          <InfoTip label={tH("trendNoteLabel")} items={[[tDef("definitionLabel"), tDef("definition.position")], [tDef("formulaLabel"), tDef("formula.position")]]} />
        </div>
        <div className="text-rn-56 font-bold tracking-[-0.035em] text-rn-navy tabular-nums" data-rn-hero="first-rank">
          {hero.avgPosition == null ? (
            tFR("noRank")
          ) : (
            <>
              {t("unitPrefix")}
              {posTxt(hero.avgPosition)}
              <small className="ml-1 text-rn-20 font-semibold tracking-normal">{t("unitSuffix")}</small>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-rn-12 text-rn-muted">
          <DeltaChip value={hero.delta.value} rank />
          <span>{hero.delta.basis?.kind === "period" ? basis(hero.delta) : t("basis")}</span>
        </div>
        {degraded ? <DegradedNote>{tK("degraded")}</DegradedNote> : null}
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-rn-line pt-3">
          <Stat label={t("ranked")} value={t("count", { n: numTxt(hero.rankedAnswers, locale) })} />
          <Stat label={t("ahead")} value={t("count", { n: ahead })} />
        </dl>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="m-0 text-rn-13 font-bold text-rn-ink">{t("trackTitle")}</h3>
          <span className="text-rn-12 text-rn-muted">{t("trackNote")}</span>
        </div>
        <Track rows={rows} />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="m-0 text-rn-13 font-bold text-rn-ink">{t("trendTitle")}</h3>
          <InfoTip label={tH("trendNoteLabel")} items={[[tH("trendNoteLabel"), tFR("chartNote")]]} />
          <span className="ml-auto">
            <MentionCardActions tableId="rank-trend" section="sec-overview" csv={() => ({ name: "mention-first-position-trend", rows: [["", ...hero.axis], ...series.map((s) => [s.name, ...s.values])] })} />
          </span>
        </div>
        <Legend items={[...series].reverse()} />
        {!fp ? (
          <DegradedNote>{tK("degraded")}</DegradedNote>
        ) : !hero.axis.length ? (
          <RnEmpty>{tH("noTrend")}</RnEmpty>
        ) : tableOn ? (
          <TwinTable head={["", ...x]} rows={series.map((s) => [s.name, ...s.values.map((v) => posTxt(v))])} />
        ) : (
          <RnLineChart
            x={x}
            series={series}
            height={190}
            invert
            domain={{ lo: 1, hi, ticks: rankAxisTicks(hi) }}
            yTick={(v) => `${v}`}
            value={(v) => t("unit", { n: v.toFixed(1) })}
            tooltipTitle={(d) => tH("tooltip", { x: d })}
            ariaLabel={t("trendAria")}
            lit={lit}
            onHover={hover}
          />
        )}
      </div>
    </div>
  );
}

/** Brands along the average-position axis (left = named earlier); 당사 and compare brands labelled. */
function Track({ rows }: { rows: ReturnType<typeof rankBoard>["rows"] }) {
  const { ownLabel, lit, hover } = useMention();
  const { compare, colorOf } = useCompare();
  const t = useTranslations("renewal.mention.rank");
  const pts = rows.filter((r) => r.avgPosition != null);
  if (!pts.length) return null;
  const lo = Math.min(...pts.map((r) => r.avgPosition!));
  const hi = Math.max(...pts.map((r) => r.avgPosition!));
  const at = (v: number) => (hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50);
  const keys = pts.map((r) => r.key);
  const emph = pts.filter((r) => r.own || compare.includes(r.key));
  return (
    <div role="img" aria-label={t("trackAria")} className="relative mx-2 h-[76px]">
      <span aria-hidden className="absolute top-[38px] right-0 left-0 h-px bg-rn-line-2" />
      <span aria-hidden className="absolute top-[46px] left-0 -translate-x-1/2 text-rn-11 text-rn-muted tabular-nums">{posTxt(lo)}</span>
      <span aria-hidden className="absolute top-[46px] right-0 translate-x-1/2 text-rn-11 text-rn-muted tabular-nums">{posTxt(hi)}</span>
      {pts
        .filter((r) => !emph.includes(r))
        .map((r) => (
          <span key={r.key} title={`${r.key} ${posTxt(r.avgPosition)}`} className={cx("absolute top-[38px] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity", rnHighlightState(lit, [r.key], keys) === "dim" && "opacity-30")} style={{ left: `${at(r.avgPosition!)}%`, background: CONTEXT_COLOR }} />
        ))}
      {emph.map((r, i) => {
        const name = r.own ? ownLabel : r.key;
        const above = i % 2 === 0;
        return (
          <span key={r.key} data-rn-b={r.key} onPointerEnter={() => hover(r.key)} onPointerLeave={() => hover(null)} className="absolute top-[38px] -translate-x-1/2" style={{ left: `${at(r.avgPosition!)}%` }}>
            <span aria-hidden className="absolute top-0 left-0 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white" style={{ background: colorOf(r.key) }} />
            <span className={cx("absolute left-0 -translate-x-1/2 text-rn-11 font-bold whitespace-nowrap text-rn-ink", above ? "-top-[30px]" : "top-[10px]")}>
              {name} {posTxt(r.avgPosition)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const RANK_COLS = "grid-cols-[26px_minmax(150px,1.3fr)_minmax(60px,1.4fr)_64px_88px_64px_64px] @max-[720px]/rnpage:grid-cols-[26px_minmax(130px,1.3fr)_minmax(40px,1fr)_58px_64px_58px]";

function RankTable() {
  const { ownLabel, lit, hover } = useMention();
  const { compare, covered, colorOf, toggle } = useCompare();
  const t = useTranslations("renewal.mention");
  const tFR = useTranslations("answerAnalysis.mentions.kpi.firstRank");
  const { rows } = useRank();
  const [ladder, setLadder] = useState(true);
  const shown = ladder ? rows : [...rows.filter((r) => r.own), ...rows.filter((r) => !r.own)];
  const max = Math.max(1, ...rows.map((r) => r.avgPosition ?? 0));
  const keys = rows.map((r) => r.key);
  const name = (k: string) => (k === OWN_KEY ? ownLabel : k);
  const csv = () => ({ name: "mention-first-position", rows: [["#", t("board.colBrand"), t("rank.colAvg"), t("rank.colWow"), t("rank.colGap")], ...rows.map((r, i) => [i + 1, name(r.key), r.avgPosition, r.delta, r.gap])] });
  return (
    <>
      <RnCardHead
        title={t("rank.tableTitle")}
        info={<InfoTip label={t("board.infoLabel")} items={[[t("board.infoLabel"), t("rank.tableInfo")], [tFR("formulaTitle"), tFR("formula")]]} />}
        chips={<RnBasisChip>{t("rank.chipTrend")}</RnBasisChip>}
        controls={
          <button type="button" role="switch" aria-checked={ladder} onClick={() => setLadder((v) => !v)} className="inline-flex cursor-pointer items-center gap-2 text-rn-12 font-semibold text-rn-ink-2 focus-visible:outline-2 focus-visible:outline-rn-navy">
            <span aria-hidden className={cx("relative h-[18px] w-8 rounded-full transition-colors", ladder ? "bg-rn-navy" : "bg-rn-line-2")}>
              <i className={cx("absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-[left]", ladder ? "left-4" : "left-0.5")} />
            </span>
            {t("rank.ladder")}
          </button>
        }
        actions={<MentionCardActions section="sec-comp" csv={csv} />}
        sub={t("board.sub")}
      />
      {rows.length <= 1 ? (
        <RnEmpty className="mx-6 mb-5">{tFR("table.empty")}</RnEmpty>
      ) : (
        <>
          <div className={cx("grid h-[34px] items-center gap-2.5 border-y border-rn-line px-6 text-rn-12 font-semibold whitespace-nowrap text-rn-muted [.rn-dense_&]:px-4.5", RANK_COLS)}>
            <span>#</span>
            <span>{t("board.colBrand")}</span>
            <span className="sr-only">{t("rank.colBar")}</span>
            <span className="text-right">{t("rank.colAvg")}</span>
            <span className="@max-[720px]/rnpage:hidden">{t("board.colTrend")}</span>
            <span className="text-right">{t("rank.colWow")}</span>
            <span className="text-right">{t("rank.colGap")}</span>
          </div>
          {shown.map((r) => {
            const on = compare.includes(r.key);
            const color = r.own ? OWN_COLOR : on ? colorOf(r.key) : CONTEXT_COLOR;
            const canCompare = !r.own && covered.includes(r.key);
            const st = rnHighlightState(lit, [r.key], keys);
            const cells = (
              <>
                <span className="text-rn-12 text-rn-muted tabular-nums">{rows.indexOf(r) + 1}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <i aria-hidden className={cx("size-3 shrink-0 rounded-full", !r.own && !on && "shadow-[inset_0_0_0_1.5px_var(--color-rn-line-2)]")} style={r.own || on ? { background: color } : undefined} />
                  <BrandName name={name(r.key)} own={r.own} sibling={r.sibling} />
                </span>
                <span className="h-2 overflow-hidden rounded bg-rn-page">
                  <i className="block h-full rounded" style={{ width: `${r.avgPosition == null ? 0 : Math.max(4, (1 - (r.avgPosition - 1) / max) * 100)}%`, background: color }} />
                </span>
                <span className="text-right text-rn-13 font-bold text-rn-ink tabular-nums">{r.avgPosition == null ? tFR("noRank") : posTxt(r.avgPosition)}</span>
                <span className="@max-[720px]/rnpage:hidden">{r.spark.some((v) => v != null) ? <RnSparkline values={r.spark} invert className="h-[26px]" /> : <span className="text-rn-11 text-rn-muted">{t("board.noTrend")}</span>}</span>
                <span className="justify-self-end">{r.spark.some((v) => v != null) ? <DeltaChip value={r.delta} rank /> : <span className="text-rn-11 text-rn-muted">—</span>}</span>
                <span className={cx("text-right text-rn-12 font-semibold tabular-nums", r.gap == null ? "text-rn-muted" : r.gap > 0 ? "text-rn-up-ink" : "text-rn-danger-ink")}>{r.gap == null ? "—" : `${r.gap > 0 ? "+" : "−"}${Math.abs(r.gap).toFixed(1)}`}</span>
              </>
            );
            const cls = cx(
              "grid min-h-11 w-full items-center gap-2.5 border-b border-rn-line px-6 text-left text-rn-13 [.rn-dense_&]:min-h-[34px] [.rn-dense_&]:px-4.5",
              RANK_COLS,
              r.own && "bg-[linear-gradient(90deg,rgba(0,44,95,.06),rgba(0,44,95,0)_70%)]",
              st === "on" && "bg-rn-navy-25 shadow-[inset_3px_0_0_var(--color-rn-navy)]",
              st === "dim" && "opacity-60",
            );
            return canCompare ? (
              <button key={r.key} type="button" data-rn-b={r.key} aria-pressed={on} onClick={() => toggle(r.key)} onPointerEnter={() => hover(r.key)} onPointerLeave={() => hover(null)} className={cx(cls, "cursor-pointer hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy")}>
                {cells}
              </button>
            ) : (
              <div key={r.key} data-rn-b={r.key} title={r.own ? undefined : t("board.noCompare")} onPointerEnter={() => hover(r.key)} onPointerLeave={() => hover(null)} className={cls}>
                {cells}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
