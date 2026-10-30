"use client";

// Renewal Website Overview — KPI 추이 as small multiples: every series the screen has, each on its own axis (a %
// series never flattens another, 우선 노출도 reads 1 on top), the rounds on one shared column grid, and under them
// the per-round answer count and the rounds a gap took out (website/trend rows: values, answers, gap per family).
// A round without a value breaks the line (no interpolation). Nothing is computed here.
// Design pass (2026-10-30, W6): every multiple is the 당사 series, so all draw in 당사 navy (the chart title names
// the KPI; red stays the colour of a decline); the line's end label carries the short name, so the plot keeps most of
// its column; a rank axis prints its ticks at one decimal count. The answers per round are bars from 0 on one scale
// (the user, 2026-10-30: a round with few answers reads at a glance), each over its count and gap. The bars are
// neutral gray (a count has no better side and is not a 당사 series), and a cell tips the change from the round
// before (the user, 2026-10-31): the difference of the two counts shown, none against a round without a count. A
// mention-gap round has no count (the screen sends 0 there), so it shows "—", never a made-up 0.

import { use } from "react";
import { useLocale, useTranslations } from "next-intl";
import { RnCard, RnCardHeader, RnEmpty, RnLineChart, cx, rnNiceTicks, useRnTruncTip } from "@/components/renewal-ui";
import type { TrendRowView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import type { TrendKpiKey } from "@/app/[locale]/(dash)/dashboard/_data/live-types";
import type { TrendChartView, WebsiteTrendView } from "@/app/[locale]/(dash)/dashboard/_data/screen-types";
import { useFormat, useShortName, type Failed } from "./website-format";

/** The original chart's series, in its order (live-trend-chart.tsx TREND_SERIES). */
export const TREND_KEYS: readonly TrendKpiKey[] = ["visibility", "shareOfVoice", "sentiment", "citationShare", "citationAccuracy", "position"];
const OWN = "var(--color-rn-navy)";

/** The ticks RnLineChart draws for these values (its default domain), so the axis can be labelled as one set; a rank
 * axis starts at 1 (no position above the first). */
export function trendTicks(values: ReadonlyArray<number | null>, rank = false): number[] {
  const nums = values.filter((v): v is number => v != null);
  const lo = nums.length ? Math.min(...nums) : 0;
  const hi = nums.length ? Math.max(...nums) : 1;
  return rnNiceTicks(Math.max(rank ? 1 : 0, lo - (hi - lo) * 0.15), hi, 4);
}

/** Rank axis labels: one decimal, two for every tick when the ticks step by less than 0.1 (0.95 · 1.00 · 1.05). */
export function rankTick(ticks: ReadonlyArray<number>): (v: number) => string {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
  const digits = step < 0.1 - 1e-9 ? 2 : 1;
  return (v) => v.toFixed(digits);
}

const md = (day: string) => `${+day.slice(5, 7)}/${+day.slice(8, 10)}`;

/** A round's answer count, or null where the mention family has a gap (website/trend sends 0 there). */
const answersOf = (r: TrendRowView) => (r.gap.mention ? null : r.answers);

export function RnWebsiteTrend({ trend }: { trend: Promise<WebsiteTrendView | Failed> }) {
  const t = useTranslations("renewal.website.overview");
  const tD = useTranslations("dashboard.trend");
  const v = use(trend);
  return (
    <RnCard aria-label={tD("title")} className="min-w-0">
      <RnCardHeader title={tD("title")} hint={v !== "failed" && v.trend ? t("trendHint", { count: v.trend.rows.length }) : undefined} />
      {v === "failed" ? (
        <RnEmpty className="mx-6 mb-5">{t("trendFailed")}</RnEmpty>
      ) : v.trend ? (
        <TrendMultiples view={v.trend} />
      ) : (
        <RnEmpty className="mx-6 mb-5">{tD("accruing")}</RnEmpty>
      )}
    </RnCard>
  );
}

export function TrendMultiples({ view }: { view: TrendChartView }) {
  const t = useTranslations("renewal.website.overview");
  const tK = useTranslations("dashboard.kpi.name");
  const tUnit = useTranslations("metricUnit");
  const f = useFormat();
  const locale = useLocale();
  const short = useShortName();
  const { bind, tip } = useRnTruncTip();
  const x = view.rows.map((r) => md(r.day));
  const keys = TREND_KEYS.filter((k) => view.availableSeries.includes(k));
  const most = Math.max(1, ...view.rows.map((r) => answersOf(r) ?? 0));
  const tipOf = (i: number, gap: string | null) => {
    const r = view.rows[i];
    const n = answersOf(r);
    const lines = [n == null ? t("answersTipNone", { day: md(r.day) }) : t("answersTip", { day: md(r.day), count: f.count(n) })];
    if (n != null) {
      const prev = i > 0 ? view.rows[i - 1] : null;
      const p = prev ? answersOf(prev) : null;
      const d = p == null ? 0 : n - p;
      lines.push(
        !prev
          ? t("answersTipFirst")
          : p == null
            ? t("answersTipNoPrev", { prev: md(prev.day) })
            : d === 0
              ? t("answersTipSame", { prev: md(prev.day) })
              : t("answersTipDelta", { prev: md(prev.day), delta: `${d > 0 ? "+" : "−"}${Math.abs(d).toLocaleString(locale)}` }),
      );
    }
    if (gap) lines.push(t(`gap.${gap}` as "gap.all"));
    return lines.join("\n");
  };
  return (
    <div className="flex flex-col gap-3 px-6 pb-5">
      <div className="grid grid-cols-3 gap-x-5 gap-y-3 @max-[900px]/rnpage:grid-cols-2" data-rn-multiples="">
        {keys.map((k) => {
          const rank = k === "position";
          const values = view.rows.map((r) => r.values[k] ?? null);
          const name = tK(k);
          const ticks = trendTicks(values, rank);
          return (
            <div key={k} data-rn-multiple={k} className="min-w-0">
              <span className="flex items-center gap-1.5 text-rn-12 font-bold text-rn-ink-2">
                {name}
                {rank ? <span className="font-medium text-rn-muted">{t("rankUp")}</span> : null}
              </span>
              <RnLineChart
                x={x}
                series={[{ key: k, name: short(k), color: OWN, values, own: true }]}
                height={128}
                invert={rank}
                domain={{ lo: ticks[0], hi: ticks[ticks.length - 1], ticks }}
                yTick={rank ? rankTick(ticks) : (v) => `${v}%`}
                value={(v) => (rank ? tUnit("position", { n: v.toFixed(1) }) : `${v.toFixed(1)}%`)}
                tooltipTitle={(d) => t("trendTooltip", { x: d })}
                ariaLabel={t("trendAria", { series: name })}
              />
            </div>
          );
        })}
      </div>
      {/* the rounds: answers behind each point (a bar from 0 over the count, the change from the round before on hover), and the rounds a gap took out (which family) */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-rn-11" data-rn-rounds="" {...bind}>
          <tbody>
            <tr>
              <th scope="row" className="w-[88px] border-y border-rn-line bg-rn-head py-1.5 pr-2 text-left font-semibold text-rn-muted">{t("roundsRow")}</th>
              {view.rows.map((r) => (
                <td key={r.key} className="border-y border-rn-line bg-rn-head px-1 py-1.5 text-center font-semibold text-rn-ink-2 tabular-nums">{md(r.day)}</td>
              ))}
            </tr>
            <tr>
              <th scope="row" className="border-b border-rn-line py-1.5 pr-2 text-left font-semibold text-rn-muted">{t("answersRow")}</th>
              {view.rows.map((r, i) => {
                const gap = r.gap.mention && r.gap.citation ? "all" : r.gap.citation ? "citation" : r.gap.mention ? "mention" : null;
                const n = answersOf(r);
                const label = tipOf(i, gap);
                return (
                  <td
                    key={r.key}
                    data-rn-round={r.day}
                    data-rn-gap={gap ?? undefined}
                    data-rn-tip={label}
                    tabIndex={0}
                    aria-label={label}
                    className={cx(
                      "group/ans border-b border-rn-line px-1 pt-2 pb-1.5 text-center align-bottom tabular-nums hover:bg-rn-head focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy",
                      gap ? "text-rn-danger-ink" : "text-rn-ink-2",
                    )}
                  >
                    <span aria-hidden className="mx-auto flex h-9 w-full max-w-7 items-end">
                      <i data-rn-answers-bar="" className="w-full rounded-t-[2px] bg-rn-sand group-hover/ans:bg-rn-faint" style={{ height: `${(((n ?? 0) / most) * 100).toFixed(1)}%` }} />
                    </span>
                    <span aria-hidden className="mt-1 block">{gap === "all" ? t("gap.all") : n == null ? "—" : f.count(n)}</span>
                    {gap && gap !== "all" ? <span aria-hidden className="block">{t(`gap.${gap}`)}</span> : null}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      {tip}
    </div>
  );
}
