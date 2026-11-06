"use client";

import { use, useState } from "react";
import { useTranslations } from "use-intl";
import { TrendingUp } from "lucide-react";
import { RnCardHead, RnEmpty, RnLineChart, RnSegmented, cx } from "@/components/renewal-ui";
import { OWN_KEY } from "../_data/screen-types";
import { AVG_COLOR, AVG_KEY, MentionCardActions, OWN_COLOR, pctTxt, posTxt, slotLabel, useCompare, useMention } from "./mention-context";
import { DegradedNote, DeltaChip, InfoTip, useDegradedText } from "./mention-kit";
import { KPI_KEY } from "./mention-global-trends";

// 경쟁 비교 tab, first card (2026-11-05 Mention 개편): exposure · share · first-rank side by side on one crosshair, as
// values (당사 and the compare brands, the band to the first one) or as 격차 per round (the BFF's gaps: 당사 − rival,
// first-rank rival − 당사, so + = 당사 ahead), each with this round · change · gap under it. Favorability has no rival
// rounds and stays out (the brand table's 우호도 column is this round's).

type CmpMetric = "exposure" | "sov" | "first-rank";
const METRICS: readonly CmpMetric[] = ["exposure", "sov", "first-rank"];
const SYNC = "rn-mention-g-cmp";

interface Panel {
  x: string[];
  own: (number | null)[];
  /** per compare brand (pick order): its values and gaps on x */
  brands: Array<{ key: string; values: (number | null)[]; gaps: (number | null)[]; delta: number | null }>;
  ownDelta: number | null;
  missing: boolean;
  /** 경쟁사 평균 and 당사 − it, on x (exposure · share; the first-rank panel has none) */
  average: (number | null)[] | null;
  averageGaps: (number | null)[] | null;
}

function usePanels(): Record<CmpMetric, Panel> {
  const { input } = useMention();
  const { compare } = useCompare();
  const hero = use(input.rateHero);
  const rank = use(input.rank);
  const rate = (m: "exposure" | "sov"): Panel => {
    const tr = hero[m].trend;
    const rows = hero[m].board.rows;
    return {
      x: tr.x,
      own: tr.own,
      brands: compare
        .filter((b) => tr.competitors.includes(b))
        .map((b) => {
          const i = tr.competitors.indexOf(b);
          return { key: b, values: tr.values[i], gaps: tr.gaps?.[i] ?? [], delta: rows.find((r) => r.key === b)?.delta ?? null };
        }),
      ownDelta: hero[m].delta.value,
      missing: tr.missing,
      average: tr.average,
      averageGaps: tr.averageGaps,
    };
  };
  return {
    exposure: rate("exposure"),
    sov: rate("sov"),
    "first-rank": {
      x: rank.hero.axis,
      own: rank.hero.series,
      brands: compare
        .filter((b) => rank.covered.includes(b) && rank.hasValue[rank.covered.indexOf(b)])
        .map((b) => {
          const i = rank.covered.indexOf(b);
          return { key: b, values: rank.series[i], gaps: rank.gaps?.[i] ?? [], delta: rank.rows.find((r) => r.key === b)?.delta ?? null };
        }),
      ownDelta: rank.hero.delta.value,
      missing: !rank.fp,
      average: null,
      averageGaps: null,
    },
  };
}

const lastOf = (vs: ReadonlyArray<number | null>) => {
  for (let i = vs.length - 1; i >= 0; i--) if (vs[i] != null) return vs[i];
  return null;
};

export function GlobalCompareTrends() {
  const { ownLabel } = useMention();
  const { compare, colorOf } = useCompare();
  const t = useTranslations("renewal.mention");
  const tName = useTranslations("dashboard.kpi.name");
  const dg = useDegradedText();
  const [mode, setMode] = useState<"value" | "gap">("value");
  const panels = usePanels();
  const avgName = t("hero.average");
  const fmt = (m: CmpMetric, v: number | null) => (v == null ? "—" : m === "first-rank" ? t("rank.unit", { n: posTxt(v) }) : pctTxt(v));
  const gapTxt = (m: CmpMetric, v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}${m === "first-rank" ? "" : "pp"}`);
  const csv = () => ({
    name: "mention-compare-trends",
    rows: METRICS.flatMap((m) => {
      const p = panels[m];
      return [
        [tName(KPI_KEY[m]), ...p.x],
        [ownLabel, ...p.own],
        ...p.brands.map((b) => [b.key, ...b.values]),
        ...p.brands.map((b) => [`${t("g.gap")} ${b.key}`, ...b.gaps]),
        ...(p.average ? [[avgName, ...p.average], [`${t("g.gap")} ${avgName}`, ...(p.averageGaps ?? [])]] : []),
      ];
    }),
  });
  return (
    <>
      <RnCardHead
        icon={<TrendingUp />}
        title={t("g.cmpTitle")}
        info={<InfoTip label={t("g.cmpTitle")} items={[[t("g.cmpTitle"), t("g.cmpInfo")]]} />}
        chips={<span className="text-rn-12 text-rn-muted">{t("g.cmpNote")}</span>}
        controls={
          <RnSegmented
            label={t("g.cmpMode")}
            value={mode}
            onChange={setMode}
            items={[
              { value: "value", label: t("g.modeValue") },
              { value: "gap", label: t("g.modeGap") },
            ]}
          />
        }
        actions={<MentionCardActions section="sec-g-cmp" csv={csv} />}
      />
      {!compare.length && !panels.exposure.average ? (
        <RnEmpty className="mx-5 mb-5">{t("g.cmpEmpty")}</RnEmpty>
      ) : (
        <div className="grid grid-cols-1 pb-4 @min-[1100px]/rncontent:grid-cols-3">
          {METRICS.map((m, idx) => {
            const p = panels[m];
            const invert = m === "first-rank";
            const avgValues = mode === "gap" ? p.averageGaps : p.average;
            const avgLine = avgValues ? [{ key: AVG_KEY, name: avgName, color: AVG_COLOR, values: avgValues, dashed: true }] : [];
            const series =
              mode === "gap"
                ? [...avgLine, ...p.brands.map((b) => ({ key: b.key, name: b.key, color: colorOf(b.key), values: b.gaps }))]
                : [...avgLine, ...p.brands.map((b) => ({ key: b.key, name: b.key, color: colorOf(b.key), values: b.values })), { key: OWN_KEY, name: ownLabel, color: OWN_COLOR, values: p.own, own: true }];
            return (
              <div key={m} data-rn-gcmp={m} className={cx("min-w-0 px-5", idx > 0 && "@min-[1100px]/rncontent:border-l @min-[1100px]/rncontent:border-rn-line")}>
                <div className="mb-1.5 flex items-baseline gap-2">
                  <b className="text-rn-13 font-semibold text-rn-ink">{tName(KPI_KEY[m])}</b>
                  <span className="text-rn-12 text-rn-muted">{mode === "gap" ? t(m === "first-rank" ? "g.gapRank" : "g.gapRate") : m === "first-rank" ? t("g.rankHint") : t("g.valueHint")}</span>
                </div>
                {p.missing ? (
                  <DegradedNote>{dg.trend}</DegradedNote>
                ) : (
                  <RnLineChart
                    x={p.x.map(slotLabel)}
                    series={series}
                    height={190}
                    yTick={(v) => {
                      const n = +v.toFixed(1);
                      return mode === "gap" ? `${n > 0 ? "+" : ""}${n}${invert ? "" : "pp"}` : invert ? String(n) : `${n}%`;
                    }}
                    value={(v) => (mode === "gap" ? gapTxt(m, v) : fmt(m, v))}
                    tooltipTitle={(day) => t("hero.tooltip", { x: day })}
                    ariaLabel={t("g.cmpAria", { metric: tName(KPI_KEY[m]) })}
                    invert={invert && mode === "value"}
                    zeroLine={mode === "gap"}
                    band={mode === "value" && p.brands[0] ? { a: OWN_KEY, b: p.brands[0].key, color: OWN_COLOR } : undefined}
                    syncId={SYNC}
                    endLabels={false}
                    curve="monotone"
                  />
                )}
                <table className="mt-2.5 w-full border-collapse text-rn-12 tabular-nums">
                  <thead>
                    <tr className="border-b border-rn-line text-rn-11 text-rn-muted">
                      <th className="py-1 text-left font-medium">{t("g.colBrand")}</th>
                      <th className="py-1 text-right font-medium">{t("g.colNow")}</th>
                      <th className="py-1 text-right font-medium">{t("g.colDelta")}</th>
                      <th className="py-1 text-right font-medium">{t("g.gap")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-rn-line">
                      <td className="py-1.5">
                        <span className="inline-flex items-center gap-2 font-semibold text-rn-navy">
                          <i aria-hidden className="size-2 rounded-full" style={{ background: OWN_COLOR }} />
                          {ownLabel}
                        </span>
                      </td>
                      <td className="py-1.5 text-right text-rn-ink-2">{fmt(m, lastOf(p.own))}</td>
                      <td className="py-1.5 text-right">
                        <DeltaChip value={p.ownDelta} rank={invert} />
                      </td>
                      <td className="py-1.5 text-right text-rn-muted">{t("g.base")}</td>
                    </tr>
                    {p.brands.map((b) => {
                      const g = lastOf(b.gaps);
                      return (
                        <tr key={b.key} className="border-b border-rn-line last:border-0">
                          <td className="py-1.5">
                            <span className="inline-flex items-center gap-2 font-semibold text-rn-ink">
                              <i aria-hidden className="size-2 rounded-full" style={{ background: colorOf(b.key) }} />
                              {b.key}
                            </span>
                          </td>
                          <td className="py-1.5 text-right text-rn-ink-2">{fmt(m, lastOf(b.values))}</td>
                          <td className="py-1.5 text-right">
                            <DeltaChip value={b.delta} rank={invert} neutral />
                          </td>
                          <td className={cx("py-1.5 text-right font-semibold", g == null ? "text-rn-muted" : g >= 0 ? "text-rn-up-ink" : "text-rn-danger-ink")}>{gapTxt(m, g)}</td>
                        </tr>
                      );
                    })}
                    {p.average ? (
                      <tr data-rn-gcmp-avg className="border-b border-rn-line last:border-0">
                        <td className="py-1.5">
                          <span className="inline-flex items-center gap-2 font-semibold text-rn-ink-2">
                            <i aria-hidden className="w-2 border-t-2 border-dashed" style={{ borderColor: AVG_COLOR }} />
                            {avgName}
                          </span>
                        </td>
                        <td className="py-1.5 text-right text-rn-ink-2">{fmt(m, lastOf(p.average))}</td>
                        <td className="py-1.5 text-right text-rn-muted">—</td>
                        <td className="py-1.5 text-right font-semibold text-rn-muted">{gapTxt(m, lastOf(p.averageGaps ?? []))}</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
