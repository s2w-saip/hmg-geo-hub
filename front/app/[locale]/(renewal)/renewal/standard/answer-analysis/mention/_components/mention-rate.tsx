"use client";

import { Suspense, use, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowUpRight, ChevronRight, TrendingUp } from "lucide-react";
import {
  RnBasisChip,
  RnCard,
  RnCardHead,
  RnEmpty,
  RnLineChart,
  rnNiceTicks,
  RnSectionHead,
  RnSegmented,
  RnSkeleton,
  RnSparkline,
  RnTextButton,
  cx,
  rnHighlightState,
} from "@/components/renewal-ui";
import { OWN_KEY, firstPicked, pickKey, type BoardRow, type RnRateTypesVM } from "../_data/screen-types";
import { CONTEXT_COLOR, MentionCardActions, OWN_COLOR, deltaTxt, numTxt, pctTxt, ppTxt, slotLabel, useCompare, useMention } from "./mention-context";
import { BrandName, CardSkeleton, DegradedNote, DeltaChip, InfoTip, Legend, Stat, TwinTable, useDegradedText, useDeltaBasis, useDeltaNote } from "./mention-kit";
import { KpiBasisChip } from "./mention-tabs";

type KpiMetric = "exposure" | "sov";

const DEF_KEY = { exposure: "visibility", sov: "shareOfVoice" } as const;

export function RateBody({ metric }: { metric: KpiMetric }) {
  const t = useTranslations("renewal.mention");
  const short = useMetricShort(metric);
  return (
    <>
      <RateHero metric={metric} />
      <RnSectionHead id="sec-comp" title={t("sec.comp")} chip={<KpiBasisChip />} desc={t("sec.compDesc")} />
      <RnCard aria-label={t("board.title", { metric: short })}>
        <Suspense fallback={<CardSkeleton height={420} />}>
          <Board metric={metric} />
        </Suspense>
      </RnCard>
      <RnSectionHead id="sec-mix" title={t("sec.mix")} chip={<KpiBasisChip />} desc={t("sec.mixDesc")} />
      <div className="grid grid-cols-1 gap-4 @min-[1100px]/rnpage:grid-cols-2">
        <RnCard aria-label={t(metric === "sov" ? "engine.titleSov" : "engine.titleExposure")}>
          <Suspense fallback={<CardSkeleton height={360} />}>
            <Engines metric={metric} />
          </Suspense>
        </RnCard>
        <RnCard aria-label={t(metric === "sov" ? "type.titleSov" : "type.titleExposure")}>
          <Suspense fallback={<CardSkeleton height={360} />}>
            <Types metric={metric} />
          </Suspense>
        </RnCard>
      </div>
    </>
  );
}

/** "노출률" / "점유율" (the original tab copy) */
function useMetricShort(metric: KpiMetric): string {
  return useTranslations("answerAnalysis.mentions.kpi.metricShort")(metric);
}

// ── 히어로: value (snapshot) · Δ · standing | brand trend ─────────────────────

export function RateHero({ metric }: { metric: KpiMetric }) {
  const t = useTranslations("renewal.mention");
  const tName = useTranslations("answerAnalysis.mentions.kpi.metric");
  const tDef = useTranslations("dashboard.kpi");
  return (
    <RnCard aria-label={tName(metric)}>
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 px-6 pt-5.5 pb-5 @min-[640px]/rnpage:grid-cols-[minmax(220px,290px)_minmax(0,1fr)] [.rn-dense_&]:px-4.5 [.rn-dense_&]:py-3.5">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center gap-1.5 text-rn-12 font-bold text-rn-muted">
            {tName(metric)}
            <InfoTip
              label={t("hero.trendNoteLabel")}
              items={[
                [tDef("definitionLabel"), tDef(`definition.${DEF_KEY[metric]}`)],
                [tDef("formulaLabel"), tDef(`formula.${DEF_KEY[metric]}`)],
                [t("hero.basisLabel"), t("hero.basisAll")],
              ]}
            />
          </div>
          <Suspense fallback={<RnSkeleton className="h-[120px] w-full" />}>
            <HeroValue metric={metric} />
          </Suspense>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Suspense fallback={<RnSkeleton className="h-[260px] w-full" />}>
            <HeroTrend metric={metric} />
          </Suspense>
        </div>
      </div>
    </RnCard>
  );
}

export function HeroValue({ metric }: { metric: KpiMetric }) {
  const { input, ownBrands } = useMention();
  const t = useTranslations("renewal.mention");
  const tTip = useTranslations("answerAnalysis.mentions.kpi.tooltip");
  const dg = useDegradedText();
  const locale = useLocale();
  const value = use(input.rateValue);
  const hero = value[metric];
  const degraded = value.degraded;
  return (
    <>
      <div className="text-rn-56 font-bold tracking-[-0.035em] text-rn-navy tabular-nums" data-rn-hero={metric}>
        {hero.pct != null ? hero.pct.toFixed(1) : "—"}
        <small className="ml-0.5 text-rn-20 font-semibold tracking-normal">%</small>
      </div>
      <Suspense fallback={<RnSkeleton className="h-6 w-40" />}>
        <HeroDelta metric={metric} />
      </Suspense>
      {degraded ? <DegradedNote>{dg.all}</DegradedNote> : null}
      {/* without a ratio the screen sends no parts (null → "—", not "0 / 0") */}
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-rn-line pt-3">
        <Stat label={tTip(metric === "sov" ? "sovNumerator" : "exposureNumerator")} value={numTxt(hero.numerator, locale)} />
        <Stat label={tTip(metric === "sov" ? "sovDenominator" : "exposureDenominator")} value={numTxt(hero.denominator, locale)} />
      </dl>
      <Suspense fallback={<RnSkeleton className="h-9 w-full" />}>
        <HeroStanding metric={metric} />
      </Suspense>
      {ownBrands.length > 1 ? (
        <div className="flex flex-wrap gap-1.5 [.rn-dense_&]:hidden">
          <RnBasisChip>{t("hero.ownSum", { brands: ownBrands.join("+") })}</RnBasisChip>
        </div>
      ) : null}
    </>
  );
}

function useHero(metric: KpiMetric) {
  const { input } = useMention();
  return use(input.rateHero)[metric];
}

function HeroDelta({ metric }: { metric: KpiMetric }) {
  const hero = useHero(metric);
  const basis = useDeltaBasis();
  const note = useDeltaNote();
  const t = useTranslations("renewal.mention.delta");
  const text = basis(hero.delta);
  const foot = note(hero.delta);
  return (
    <div className="flex flex-wrap items-center gap-2 text-rn-12 text-rn-muted">
      <DeltaChip value={hero.delta.value} />
      {text ? <span>{text}</span> : null}
      {foot ? <InfoTip label={t("label")} items={[[t("label"), foot]]} /> : null}
    </div>
  );
}

function HeroStanding({ metric }: { metric: KpiMetric }) {
  const st = useHero(metric).standing;
  const t = useTranslations("renewal.mention.hero");
  if (!st) return null;
  const { rank, gap, other } = st;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-rn-navy-25 px-2.5 py-2 text-rn-12 text-rn-ink-2 [&_b]:text-rn-navy">
      {rank === 1 ? <TrendingUp className="size-3.5 shrink-0" aria-hidden /> : <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />}
      <span>
        {t.rich("standing", { b: (c) => <b>{c}</b>, n: st.n, rank })}
        {other != null && gap != null ? ` · ${rank === 1 ? t("leadFirst", { brand: other, gap: gap.toFixed(1) }) : t("leadBehind", { brand: other, gap: gap.toFixed(1) })}` : ""}
      </span>
    </div>
  );
}

function HeroTrend({ metric }: { metric: KpiMetric }) {
  const { ownLabel, lit, hover, tables } = useMention();
  const { compare, colorOf } = useCompare();
  const t = useTranslations("renewal.mention");
  const tTip = useTranslations("answerAnalysis.mentions.kpi.tooltip");
  const dg = useDegradedText();
  const locale = useLocale();
  const s = useHero(metric).trend;
  const name = useMetricShort(metric);
  // 당사's counts per round under its rate (the original's tooltip; its WoW % is not carried — HUB-made)
  const numLabel = tTip(metric === "sov" ? "sovNumerator" : "exposureNumerator");
  const denLabel = tTip(metric === "sov" ? "sovDenominator" : "exposureDenominator");
  const count = (v: number | null) => (v == null ? "—" : tTip("count", { n: numTxt(v, locale) }));
  const note = (i: number) => (s.ownNum[i] == null ? null : [`${numLabel} ${count(s.ownNum[i])}`, `${denLabel} ${count(s.ownDen[i])}`]);
  // the picked brands' lines (looked up); none picked = 당사's line alone (the competitors' average line was a HUB-made
  // baseline, 2026-10-31 ⛔L)
  const brands = compare.filter((b) => s.competitors.includes(b)).map((key) => ({ key, values: s.values[s.competitors.indexOf(key)] }));
  const series = [
    ...brands.map((b) => ({ key: b.key, name: b.key, color: colorOf(b.key), values: b.values })),
    { key: OWN_KEY, name: ownLabel, color: OWN_COLOR, values: s.own, own: true },
  ];
  const x = s.x.map(slotLabel);
  const id = `hero-${metric}`;
  const tableOn = tables.has(id);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="m-0 text-rn-13 font-bold text-rn-ink">{t(metric === "sov" ? "hero.trendTitleSov" : "hero.trendTitleExposure")}</h3>
        <InfoTip label={t("hero.trendNoteLabel")} items={[[t("hero.trendNoteLabel"), t("hero.trendNote", { metric: name })]]} />
        <span className="ml-auto">
          <MentionCardActions
            tableId={id}
            section="sec-overview"
            csv={() => ({ name: `mention-${metric}-trend`, rows: [["", ...s.x], ...series.map((r) => [r.name, ...r.values]), [numLabel, ...s.ownNum], [denLabel, ...s.ownDen]] })}
          />
        </span>
      </div>
      <Legend items={[...series].reverse()} />
      {s.missing ? (
        <DegradedNote>{dg.trend}</DegradedNote>
      ) : !s.x.length ? (
        <RnEmpty>{t("hero.noTrend")}</RnEmpty>
      ) : tableOn ? (
        <TwinTable
          head={["", ...x]}
          rows={[...series.map((r) => [r.name, ...r.values.map((v) => pctTxt(v))]), [numLabel, ...s.ownNum.map((v) => numTxt(v, locale))], [denLabel, ...s.ownDen.map((v) => numTxt(v, locale))]]}
        />
      ) : (
        <RnLineChart
          x={x}
          series={series}
          height={236}
          yTick={(v) => `${v}%`}
          value={(v) => `${v.toFixed(1)}%`}
          tooltipTitle={(d) => t("hero.tooltip", { x: d })}
          tooltipNote={note}
          ariaLabel={t("hero.trendAria", { metric: name })}
          lit={lit}
          onHover={hover}
        />
      )}
    </>
  );
}

// ── 경쟁사 분석 board ────────────────────────────────────────────────────────

const BOARD_COLS =
  "grid-cols-[26px_minmax(150px,1.3fr)_minmax(60px,1.4fr)_58px_88px_74px_70px] @max-[720px]/rnpage:grid-cols-[26px_minmax(130px,1.3fr)_minmax(40px,1fr)_58px_74px_64px]";

export function Board({ metric }: { metric: KpiMetric }) {
  const { input, ownLabel, lit, hover } = useMention();
  const { compare, covered, colorOf, toggle } = useCompare();
  const t = useTranslations("renewal.mention");
  const b = useHero(metric).board;
  const [all, setAll] = useState(false);
  const short = useMetricShort(metric);
  // "more" toggle: the first rows (당사 + the top five) plus the picked compare brands
  const shown = all ? b.rows : b.rows.filter((r) => r.top || compare.includes(r.key));
  const hidden = b.rows.length - shown.length;
  const max = b.barMax;
  const keys = b.rows.map((r) => r.key);
  const csv = () => ({
    name: `mention-${metric}-competitors`,
    rows: [["#", t("board.colBrand"), short, t("board.colDelta"), t("board.colGap")], ...b.rows.map((r, i) => [i + 1, r.own ? ownLabel : r.key, r.pct, r.delta, r.gap])],
  });
  const name = (r: BoardRow) => (r.own ? ownLabel : r.key);
  return (
    <>
      <RnCardHead
        title={t("board.title", { metric: short })}
        info={<InfoTip label={t("board.infoLabel")} items={[[t("board.infoLabel"), t(metric === "sov" ? "board.infoSov" : "board.infoExposure")]]} />}
        chips={
          <>
            <RnBasisChip>{t(input.period ? "board.chipPeriod" : "board.chipSnapshot")}</RnBasisChip>
            {b.measuredCycles ? <RnBasisChip>{t("board.chipTrend", { n: b.measuredCycles })}</RnBasisChip> : null}
          </>
        }
        actions={<MentionCardActions section="sec-comp" csv={csv} />}
        sub={t("board.sub")}
      />
      {b.rows.length <= 1 ? (
        <RnEmpty className="mx-6 mb-5">{t("board.empty")}</RnEmpty>
      ) : (
        <>
          <div className={cx("grid h-[34px] items-center gap-2.5 border-y border-rn-line px-6 text-rn-12 font-semibold whitespace-nowrap text-rn-muted [.rn-dense_&]:px-4.5", BOARD_COLS)}>
            <span>#</span>
            <span>{t("board.colBrand")}</span>
            <span>{short}</span>
            <span />
            <span className="@max-[720px]/rnpage:hidden">{t("board.colTrend")}</span>
            <span className="text-right">{t("board.colDelta")}</span>
            <span className="text-right">{t("board.colGap")}</span>
          </div>
          <div>
            {shown.map((r) => {
              const on = compare.includes(r.key);
              const color = r.own ? OWN_COLOR : on ? colorOf(r.key) : CONTEXT_COLOR;
              const canCompare = !r.own && covered.includes(r.key);
              const st = rnHighlightState(lit, [r.key], keys);
              const tip = `${name(r)}\n${short} ${pctTxt(r.pct)} · ${t("board.colDelta")} ${deltaTxt(r.delta)}${r.gap == null ? "" : `\n${t("board.colGap")} ${ppTxt(r.gap)}`}${!r.own && !canCompare ? `\n${t("board.noCompare")}` : ""}`;
              const cells = (
                <>
                  <span className="text-rn-12 text-rn-muted tabular-nums">{r.pos}</span>
                  <span className="flex min-w-0 items-center gap-2">
                    <i aria-hidden className={cx("size-3 shrink-0 rounded-full", !r.own && !on && "shadow-[inset_0_0_0_1.5px_var(--color-rn-line-2)]")} style={r.own || on ? { background: color } : undefined} />
                    <BrandName name={name(r)} own={r.own} sibling={r.sibling} />
                  </span>
                  <span className="h-2 overflow-hidden rounded bg-rn-page">
                    <i className="block h-full rounded" style={{ width: `${((r.pct ?? 0) / max) * 100}%`, background: color }} />
                  </span>
                  <span className="text-right text-rn-13 font-bold text-rn-ink tabular-nums">{pctTxt(r.pct)}</span>
                  <span className="@max-[720px]/rnpage:hidden">
                    {r.hasSpark ? <RnSparkline values={r.spark} className="h-[26px]" /> : <span className="text-rn-11 text-rn-muted" title={t("board.noTrendTip")}>{t("board.noTrend")}</span>}
                  </span>
                  <span className="justify-self-end">{r.covered ? <DeltaChip value={r.delta} neutral={!r.own} /> : <span className="text-rn-11 text-rn-muted">—</span>}</span>
                  <span className={cx("text-right text-rn-12 font-semibold tabular-nums", r.gap == null ? "text-rn-muted" : r.gap < 0 ? "text-rn-up-ink" : "text-rn-danger-ink")}>{r.gap == null ? "—" : ppTxt(r.gap)}</span>
                </>
              );
              const cls = cx(
                "grid min-h-11 w-full items-center gap-2.5 border-b border-rn-line px-6 text-left text-rn-13 [.rn-dense_&]:min-h-[34px] [.rn-dense_&]:px-4.5",
                BOARD_COLS,
                r.own && "bg-[linear-gradient(90deg,rgba(0,44,95,.06),rgba(0,44,95,0)_70%)]",
                st === "on" && "bg-rn-navy-25 shadow-[inset_3px_0_0_var(--color-rn-navy)]",
                st === "dim" && "opacity-60",
              );
              return canCompare ? (
                <button key={r.key} type="button" data-rn-b={r.key} aria-pressed={on} title={tip} onClick={() => toggle(r.key)} onPointerEnter={() => hover(r.key)} onPointerLeave={() => hover(null)} className={cx(cls, "cursor-pointer hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy")}>
                  {cells}
                </button>
              ) : (
                <div key={r.key} data-rn-b={r.key} title={tip} onPointerEnter={() => hover(r.key)} onPointerLeave={() => hover(null)} className={cls}>
                  {cells}
                </div>
              );
            })}
          </div>
          {hidden > 0 || all ? (
            <div className="flex flex-wrap gap-2 px-6 py-3 [.rn-dense_&]:px-4.5 [.rn-dense_&]:py-2">
              <RnTextButton onClick={() => setAll((v) => !v)}>{all ? t("board.less") : t("board.more", { n: hidden })}</RnTextButton>
            </div>
          ) : (
            <div className="h-3" />
          )}
        </>
      )}
    </>
  );
}

// ── AI 엔진별 ────────────────────────────────────────────────────────────────

function Engines({ metric }: { metric: KpiMetric }) {
  const { input, engineLabel, ownLabel } = useMention();
  const t = useTranslations("renewal.mention");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const dg = useDegradedText();
  const { rows, x, trendMissing } = use(input.rateEngines)[metric];
  const short = useMetricShort(metric);
  const title = t(metric === "sov" ? "engine.titleSov" : "engine.titleExposure");
  // one y scale for the side-by-side engine charts (each chart scaled to its own values made a 2 pp move on one look
  // like a 10 pp move on the other); the line chart's own rule, over every engine's values
  const nums = rows.flatMap((r) => r.series).filter((v): v is number => v != null);
  const lo = nums.length ? Math.min(...nums) : 0;
  const hi = nums.length ? Math.max(...nums) : 1;
  const ticks = rnNiceTicks(Math.max(0, lo - (hi - lo) * 0.15), hi, 4);
  const domain = { lo: ticks[0], hi: ticks[ticks.length - 1], ticks };
  const csv = () => ({
    name: `mention-${metric}-engines`,
    rows: [["AI", t("engine.own"), t("engine.avgShort"), t("engine.gapTitle"), ...x], ...rows.map((r) => [engineLabel(r.engine), r.own, r.avg, r.gap, ...r.series])],
  });
  return (
    <>
      <RnCardHead
        title={title}
        info={<InfoTip label={t("engine.infoLabel")} items={[[t("engine.infoLabel"), t(metric === "sov" ? "engine.infoSov" : "engine.infoExposure")]]} />}
        chips={<RnBasisChip>{t("engine.chip")}</RnBasisChip>}
        actions={<MentionCardActions section="sec-mix" csv={csv} />}
      />
      {!rows.length ? (
        <RnEmpty className="mx-6 mb-5">{tK("engine.empty")}</RnEmpty>
      ) : (
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 px-6 pb-5 @min-[560px]/rnpage:grid-cols-2 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3.5">
          {rows.map((r) => (
            <div key={r.engine} data-rn-engine={r.engine} className="flex min-w-0 flex-col gap-1.5 border-t border-rn-line pt-3">
              <h4 className="m-0 flex items-center gap-2 text-rn-13 font-bold text-rn-ink">
                {engineLabel(r.engine)}
                <span title={t("engine.gapTitle")} className={cx("rounded-full px-1.5 text-rn-11 font-bold tabular-nums", r.gap == null ? "bg-rn-page text-rn-muted" : r.gap >= 0 ? "bg-rn-up/12 text-rn-up-ink" : "bg-rn-down/12 text-rn-danger-ink")}>
                  {ppTxt(r.gap)}
                </span>
              </h4>
              <div className="flex items-end gap-3">
                <div>
                  <div className="text-rn-24 font-bold text-rn-navy tabular-nums">{pctTxt(r.own)}</div>
                  <div className="flex items-center gap-1.5 text-rn-11 text-rn-muted">
                    {t("engine.own")} <DeltaChip value={r.delta} />
                  </div>
                </div>
                <span className="pb-4 text-rn-11 text-rn-muted">vs</span>
                <div>
                  <div className="text-rn-20 font-bold text-rn-ink-2 tabular-nums">{pctTxt(r.avg)}</div>
                  <div className="text-rn-11 text-rn-muted">{t("engine.avg", { n: r.avgCount })}</div>
                </div>
              </div>
              {trendMissing ? (
                <DegradedNote>{dg.trend}</DegradedNote>
              ) : r.hasSeries ? (
                <RnLineChart
                  x={x.map(slotLabel)}
                  series={[{ key: OWN_KEY, name: ownLabel, color: OWN_COLOR, values: r.series, own: true }]}
                  height={110}
                  domain={domain}
                  yTick={(v) => `${v}%`}
                  value={(v) => `${v.toFixed(1)}%`}
                  tooltipTitle={(d) => t("hero.tooltip", { x: d })}
                  ariaLabel={t("engine.trendAria", { engine: engineLabel(r.engine), metric: short })}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── 멘션 유형 ────────────────────────────────────────────────────────────────

/** `initialView` opens another view first (render tests). */
export function Types({ metric, initialView = "cmp" }: { metric: KpiMetric; initialView?: "cmp" | "own" }) {
  const { input, ownLabel, tables, openDrawer } = useMention();
  const { compare, colorOf } = useCompare();
  const t = useTranslations("renewal.mention.type");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const tB = useTranslations("answerAnalysis.mentions.breakdown");
  const dg = useDegradedText();
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const locale = useLocale();
  const vm = use(input.rateTypes);
  const degraded = vm.degraded;
  const [view, setView] = useState<"cmp" | "own">(initialView);
  const [unit, setUnit] = useState<"pct" | "count">("pct");
  const { rows: cmpRows, top } = useMemo(() => typeRowsOf(vm.cmp, compare), [vm.cmp, compare]);
  const own = vm.own[metric];
  const ownRows = own.rows;
  const id = `type-${metric}`;
  const tableOn = tables.has(id);
  const isCmp = view === "cmp";
  // the exposure lines' rounds: each point names its type answers and the round's answers (the original type chart's bar)
  const sparkTips = (r: (typeof ownRows)[number]) =>
    r.spark.map((v, i) =>
      v == null
        ? null
        : `${t("sparkTip", { day: slotLabel(own.x[i]), pct: pctTxt(v) })}\n${t("sparkTipCounts", { type: tType(r.type), n: numTxt(r.counts[i], locale), den: numTxt(own.answers[i], locale) })}`,
    );
  const csv = () =>
    isCmp
      ? { name: `mention-type-compare`, rows: [[t("colType"), ownLabel, ...compare, t("colGap"), t("colRef")], ...cmpRows.map((r) => [tType(r.type), r.own, ...r.dots.map((d) => d.value), r.gap, r.ref.brand ?? ""])] }
      : {
          name: `mention-type-own-${metric}`,
          rows: [
            [t("colType"), t(metric === "sov" ? "colOwnSov" : "colOwnExposure"), t("colSignals"), t("colDelta"), ...own.x],
            ...ownRows.map((r) => [tType(r.type), r.pct, r.signals, r.delta, ...r.spark]),
            ...(own.x.length ? [[t("colRoundAnswers"), "", "", "", ...own.answers]] : []),
          ],
        };
  const empty = isCmp ? !cmpRows.length : !ownRows.length;
  return (
    <>
      <RnCardHead
        title={t(metric === "sov" ? "titleSov" : "titleExposure")}
        info={<InfoTip label={t("infoLabel")} items={[[t("infoLabel"), t("info")]]} />}
        chips={<RnBasisChip>{t("chip")}</RnBasisChip>}
        controls={
          <>
            <RnSegmented
              label={t("viewLabel")}
              value={view}
              onChange={setView}
              items={[
                { value: "cmp", label: t("viewCompare") },
                { value: "own", label: t(metric === "sov" ? "viewOwnSov" : "viewOwnExposure") },
              ]}
            />
            {!isCmp ? (
              <RnSegmented
                label={t("unitLabel")}
                value={unit}
                onChange={setUnit}
                items={[
                  { value: "pct", label: t("unitPct") },
                  { value: "count", label: t("unitCount") },
                ]}
              />
            ) : null}
          </>
        }
        actions={<MentionCardActions tableId={isCmp ? id : undefined} section="sec-mix" csv={csv} />}
        sub={t("sub")}
      />
      {empty ? (
        <RnEmpty className="mx-6 mb-5">{degraded ? dg.all : tK("type.empty")}</RnEmpty>
      ) : isCmp ? (
        <div className="flex flex-col gap-2 px-6 pb-5 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3.5">
          <Legend
            shape="dot"
            items={[
              { key: OWN_KEY, name: ownLabel, color: OWN_COLOR, own: true },
              ...compare.map((b) => ({ key: b, name: b, color: colorOf(b) })),
            ]}
          />
          {tableOn ? (
            <TwinTable
              head={[t("colType"), ownLabel, ...compare, t("colGap")]}
              rows={cmpRows.map((r) => [tType(r.type), pctTxt(r.own), ...r.dots.map((d) => pctTxt(d.value)), r.gap == null || !r.ref.brand ? "—" : `${ppTxt(r.gap)} ${t("vs", { brand: r.ref.brand })}`])}
            />
          ) : (
            <TypeDots rows={cmpRows} top={top} />
          )}
          <p className="m-0 text-rn-11 text-rn-muted">{compare.length ? t("footCompare") : `${t("footCompare")} · ${t("noCompare")}`}</p>
        </div>
      ) : (
        <div className="flex flex-col px-6 pb-5 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3.5">
          <div className="grid grid-cols-[84px_minmax(60px,1fr)_64px_70px_80px] items-center gap-2.5 border-b border-rn-line pb-1.5 text-rn-12 font-semibold text-rn-muted">
            <span>{t("colType")}</span>
            <span>{unit === "count" ? t("colSignals") : t(metric === "sov" ? "colOwnSov" : "colOwnExposure")}</span>
            <span className="text-right">{t("colValue")}</span>
            <span className="text-right">{unit === "count" || metric === "sov" ? "" : t("colDelta")}</span>
            <span>{metric === "sov" ? "" : t("colTrend")}</span>
          </div>
          {ownRows.map((r) => {
            const v = unit === "count" ? r.signals : r.pct;
            const max = unit === "count" ? own.maxCount : own.maxPct;
            return (
              <div key={r.type} className="grid min-h-10 grid-cols-[84px_minmax(60px,1fr)_64px_70px_80px] items-center gap-2.5 border-b border-rn-line text-rn-13 last:border-0">
                {/* the type, its bar and value open the prompts where 당사 carries that type signal (renewal audit 7-3,
                    the original type breakdown's drilldown: the signal route with the type) */}
                <button
                  type="button"
                  data-rn-type={r.type}
                  disabled={!r.signals}
                  onClick={() => openDrawer({ kind: "signal", signal: r.type })}
                  className="col-span-3 grid min-h-10 cursor-pointer grid-cols-subgrid items-center rounded-md text-left hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:outline-rn-navy disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="inline-flex items-center gap-0.5 font-semibold text-rn-ink">
                    {tType(r.type)}
                    {r.signals ? <ChevronRight aria-hidden className="size-3.5 text-rn-navy" /> : null}
                  </span>
                  <span className="h-2 overflow-hidden rounded bg-rn-page">
                    <i className="block h-full rounded" style={{ width: `${((v ?? 0) / max) * 100}%`, background: OWN_COLOR }} />
                  </span>
                  <span className="text-right font-bold text-rn-ink tabular-nums">{unit === "count" ? t("signals", { n: numTxt(r.signals, locale) }) : pctTxt(r.pct)}</span>
                </button>
                <span className="justify-self-end">{unit === "pct" && metric === "exposure" ? <DeltaChip value={r.delta} /> : null}</span>
                <span>{metric === "exposure" && r.hasSpark ? <RnSparkline values={r.spark} tips={sparkTips(r)} className="h-[24px]" /> : null}</span>
              </div>
            );
          })}
          <p className="m-0 pt-2 text-rn-11 text-rn-muted">
            {t(metric === "sov" ? "footSov" : "footExposure")} · {tB("drilldownHint")}
          </p>
        </div>
      )}
    </>
  );
}

interface TypeCompareRow {
  type: RnRateTypesVM["cmp"]["rows"][number]["type"];
  own: number | null;
  dots: Array<{ brand: string; value: number | null }>;
  ref: { brand: string | null; value: number | null };
  gap: number | null;
  lo: number | null;
  hi: number | null;
}

/** The compare view of the picked brands: dots and the reference (the leading picked brand) looked up in the payload. */
function typeRowsOf(cmp: RnRateTypesVM["cmp"], compare: readonly string[]): { rows: TypeCompareRow[]; top: number } {
  if (!cmp.rows.length) return { rows: [], top: 10 };
  const opt = cmp.options[pickKey(compare, cmp.covered)];
  const cell = (brand: string, t: number) => cmp.dots[cmp.covered.indexOf(brand)]?.[t] ?? null;
  const rows = cmp.rows.map((r, t) => {
    const ref = firstPicked(compare, opt?.refs[t] ?? []);
    const at = (ref != null ? cell(ref, t) : null) ?? { value: null, gap: null, lo: null, hi: null };
    return {
      type: r.type,
      own: r.own,
      dots: compare.map((brand) => ({ brand, value: cell(brand, t)?.value ?? null })),
      ref: { brand: ref, value: at.value },
      gap: at.gap,
      lo: at.lo,
      hi: at.hi,
    };
  });
  return { rows, top: opt?.top ?? 10 };
}

function TypeDots({ rows, top }: { rows: TypeCompareRow[]; top: number }) {
  const { ownLabel, lit, hover } = useMention();
  const { colorOf } = useCompare();
  const t = useTranslations("renewal.mention.type");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const ticks = [0, top / 4, top / 2, (3 * top) / 4, top];
  const at = (v: number) => `${((v / top) * 100).toFixed(2)}%`;
  const fading = lit.length > 0;
  return (
    <div role="img" aria-label={t("aria")} className="flex flex-col">
      <div aria-hidden className="grid grid-cols-[84px_minmax(0,1fr)_92px] gap-2.5 pb-1 text-rn-11 text-rn-muted">
        <span />
        <span className="relative h-4">
          {ticks.map((v) => (
            <i key={v} className="absolute -translate-x-1/2 not-italic tabular-nums" style={{ left: at(v) }}>
              {v}%
            </i>
          ))}
        </span>
        <span />
      </div>
      {rows.map((r) => {
        const { lo, hi } = r;
        const good = (r.gap ?? 0) >= 0;
        const tip = (who: string, v: number | null) => t("dotTip", { type: tType(r.type), who, value: pctTxt(v) });
        return (
          <div
            key={r.type}
            role="group"
            aria-label={r.ref.brand ? t("rowAria", { type: tType(r.type), own: pctTxt(r.own), ref: r.ref.brand, refValue: pctTxt(r.ref.value) }) : t("rowAriaOwn", { type: tType(r.type), own: pctTxt(r.own) })}
            className="grid min-h-11 grid-cols-[84px_minmax(0,1fr)_92px] items-center gap-2.5 border-b border-rn-line last:border-0"
          >
            <span className="text-rn-13 font-semibold text-rn-ink">{tType(r.type)}</span>
            <span className="relative h-6">
              {ticks.map((v) => (
                <b key={v} aria-hidden className="absolute top-0 h-full w-px bg-rn-line" style={{ left: at(v) }} />
              ))}
              {lo != null && hi != null ? <span aria-hidden className={cx("absolute top-1/2 h-1.5 -translate-y-1/2 rounded", good ? "bg-rn-up/25" : "bg-rn-down/25")} style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} /> : null}
              {r.dots.map((d) =>
                d.value == null ? null : (
                  <span
                    key={d.brand}
                    data-rn-b={d.brand}
                    title={tip(d.brand, d.value)}
                    onPointerEnter={() => hover(d.brand)}
                    onPointerLeave={() => hover(null)}
                    className={cx("absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white transition-opacity", fading && !lit.includes(d.brand) && "opacity-30")}
                    style={{ left: at(d.value), background: colorOf(d.brand) }}
                  />
                ),
              )}
              {r.own != null ? (
                <span
                  data-rn-b={OWN_KEY}
                  title={tip(`${ownLabel}`, r.own)}
                  onPointerEnter={() => hover(OWN_KEY)}
                  onPointerLeave={() => hover(null)}
                  className={cx("absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white transition-opacity", fading && !lit.includes(OWN_KEY) && "opacity-30")}
                  style={{ left: at(r.own), background: OWN_COLOR }}
                />
              ) : null}
            </span>
            <span className={cx("text-right text-rn-12 font-bold tabular-nums", r.gap == null ? "text-rn-muted" : good ? "text-rn-up-ink" : "text-rn-danger-ink")}>
              {ppTxt(r.gap)}
              {r.ref.brand ? <small className="block truncate text-rn-11 font-medium text-rn-muted">{t("vs", { brand: r.ref.brand })}</small> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
