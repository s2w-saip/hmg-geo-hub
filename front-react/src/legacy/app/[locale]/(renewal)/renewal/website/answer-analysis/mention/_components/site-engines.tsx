"use client";

import { use } from "react";
import { useTranslations } from "use-intl";
import { RnBasisChip, RnCardHead, RnEmpty, RnSparkline } from "@/components/renewal-ui";
import { MentionCardActions, pctTxt, useMention } from "../../../../standard/answer-analysis/mention/_components/mention-context";
import { DeltaChip, DegradedNote, InfoTip, useDegradedText } from "../../../../standard/answer-analysis/mention/_components/mention-kit";

// AI 엔진별 비교 (2026-11-02): the standard engine cards as a table: 당사's value is what differs between engines here, the
// competitor average (legacy, kept) is a small column near 0 on prompts aimed at our own pages. 측정 회차 says how much
// stands behind a line (DeepSeek has two rounds).

export function RnSiteEngines({ metric }: { metric: "exposure" | "sov" }) {
  const { input, engineLabel } = useMention();
  const t = useTranslations("renewal.website.mention.engines");
  const tE = useTranslations("renewal.mention.engine");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const dg = useDegradedText();
  const { rows, x, trendMissing } = use(input.rateEngines)[metric];
  const rounds = (s: Array<number | null>) => s.filter((v) => v != null).length;
  const csv = () => ({
    name: `mention-${metric}-engines`,
    rows: [[t("colEngine"), tE("own"), t("colDelta"), tE("avgShort"), tE("gapTitle"), ...x], ...rows.map((r) => [engineLabel(r.engine), r.own, r.delta, r.avg, r.gap, ...r.series])],
  });
  return (
    <>
      <RnCardHead
        title={t("title")}
        info={<InfoTip label={tE("infoLabel")} items={[[tE("infoLabel"), tE(metric === "sov" ? "infoSov" : "infoExposure")]]} />}
        chips={<RnBasisChip>{tE("chip")}</RnBasisChip>}
        actions={<MentionCardActions section="sec-mix" csv={csv} />}
      />
      {!rows.length ? (
        <RnEmpty className="mx-6 mb-5">{tK("engine.empty")}</RnEmpty>
      ) : (
        <div className="px-6 pb-3.5 [.rn-dense_&]:px-4.5">
          <table className="w-full border-collapse text-rn-13" data-rn-site-engines="">
            <thead>
              <tr className="border-b border-rn-line text-rn-12 text-rn-muted">
                <th scope="col" className="py-1.5 pr-2 text-left font-semibold">{t("colEngine")}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">{tE("own")}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">{t("colDelta")}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold">{tE("avgShort")}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">{t("colRounds")}</th>
                <th scope="col" className="w-[34%] py-1.5 pl-2 text-left font-semibold">{t("colTrend")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.engine} data-rn-engine={r.engine} className="border-b border-rn-line last:border-0">
                  <th scope="row" className="py-1.5 pr-2 text-left font-semibold text-rn-ink">{engineLabel(r.engine)}</th>
                  <td className="px-2 py-1.5 text-right font-bold text-rn-navy tabular-nums">{pctTxt(r.own)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <span className="inline-flex justify-end">
                      <DeltaChip value={r.delta} />
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right text-rn-12 text-rn-muted tabular-nums" title={tE("avg", { n: r.avgCount })}>{pctTxt(r.avg)}</td>
                  <td className="px-2 py-1.5 text-right text-rn-12 text-rn-ink-2 tabular-nums">{t("rounds", { n: rounds(r.series) })}</td>
                  <td className="py-1.5 pl-2">{r.hasSeries ? <RnSparkline values={r.series} className="h-[24px]" /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {trendMissing ? <DegradedNote>{dg.trend}</DegradedNote> : null}
        </div>
      )}
    </>
  );
}
