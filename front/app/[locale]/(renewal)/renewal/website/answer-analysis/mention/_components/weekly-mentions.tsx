"use client";

import { Suspense, use } from "react";
import { useLocale, useTranslations } from "next-intl";
import { RnBasisChip, RnCard, RnCardHead, RnSkeleton, RnTag, RnToneChip, cx } from "@/components/renewal-ui";
import { MentionCardActions } from "../../../../standard/answer-analysis/mention/_components/mention-context";
import { InfoTip } from "../../../../standard/answer-analysis/mention/_components/mention-kit";

// 주별 브랜드 언급 수 (2026-10-30): the legacy website Mention's weekly chart (당사 + the top 10 by share, mention
// counts per week) kept on the renewal page's 브랜드 상세, as a table of every week's count and the change from the week
// before (2026-11-02: the rivals' lines moved with the round's answers, correlation 0.83-0.94, so a line said how much
// was measured, not how a brand moved). Values from mention/view-weekly (back/bff/screens/mention_surfaces.py), the
// legacy chart's read.

/** mention/view-weekly */
export interface RnWeeklyVM {
  weeks: string[];
  gaps: boolean[];
  rows: Array<{ brand: string; own: boolean; values: Array<number | null>; latest: number | null; delta: number | null }>;
  degraded: boolean;
}

const SECTION = "sec-site-weekly";

/** "2026-07-06" → "7/6" (the week's Monday). */
export const weekLabel = (iso: string) => {
  const [, m, d] = iso.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : iso;
};

export function RnWeeklyMentions({ weekly }: { weekly: Promise<RnWeeklyVM> }) {
  const t = useTranslations("renewal.website.mention.weekly");
  return (
    <RnCard id={SECTION} aria-label={t("title")}>
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 px-6 py-5">
            <RnSkeleton className="h-4 w-40" />
            <RnSkeleton className="h-48 w-full" />
          </div>
        }
      >
        <Weekly weekly={weekly} />
      </Suspense>
    </RnCard>
  );
}

function Weekly({ weekly }: { weekly: Promise<RnWeeklyVM> }) {
  const t = useTranslations("renewal.website.mention.weekly");
  const tTrend = useTranslations("answerAnalysis.mentions.trend");
  const tA = useTranslations("answerAnalysis");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const tOwn = useTranslations("renewal.mention.board");
  const locale = useLocale();
  const vm = use(weekly);
  const n = (v: number | null) => (v == null ? "—" : v.toLocaleString(locale));
  const head = (
    <RnCardHead
      title={t("title")}
      info={<InfoTip label={t("title")} items={[[t("title"), t("desc")], [tTrend("title"), tTrend("hint")]]} />}
      chips={vm.weeks.length ? <RnBasisChip>{t("chip", { from: weekLabel(vm.weeks[0]), to: weekLabel(vm.weeks[vm.weeks.length - 1]), n: vm.weeks.length })}</RnBasisChip> : null}
      actions={
        vm.rows.length ? (
          <MentionCardActions
            section={SECTION}
            csv={() => ({
              name: "weekly-brand-mentions",
              rows: [[t("brand"), ...vm.weeks], ...vm.rows.map((r) => [r.brand, ...r.values.map((v) => (v == null ? "" : v))])],
            })}
          />
        ) : null
      }
    />
  );
  if (!vm.rows.length) {
    return (
      <>
        {head}
        <p className="m-0 px-6 pb-5 text-rn-12 text-rn-muted">{vm.degraded ? tK("degradedTrend") : tA("pending")}</p>
      </>
    );
  }
  return (
    <>
      {head}
      <div className="overflow-x-auto px-6 pb-3 [.rn-dense_&]:px-4.5">
        <table className="w-full border-collapse text-rn-12" data-rn-weekly="table">
          <thead>
            <tr className="border-b border-rn-line text-rn-muted">
              <th className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">{t("brand")}</th>
              {vm.weeks.map((w, i) => (
                <th key={w} className={cx("px-2 py-1.5 text-right font-semibold whitespace-nowrap", vm.gaps[i] && "text-rn-muted/60")}>
                  {t("weekOf", { d: weekLabel(w) })}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">{t("delta")}</th>
            </tr>
          </thead>
          <tbody>
            {vm.rows.map((r) => (
              <tr key={r.brand} data-rn-weekly-row={r.brand} className="border-b border-rn-line last:border-0">
                <td className="px-2 py-1.5 text-left whitespace-nowrap">
                  <span className="flex items-center gap-1.5">
                    <b className={cx("font-semibold", r.own ? "text-rn-navy" : "text-rn-ink")}>{r.brand}</b>
                    {r.own ? <RnTag>{tOwn("own")}</RnTag> : null}
                  </span>
                </td>
                {r.values.map((v, i) => (
                  <td key={vm.weeks[i]} className="px-2 py-1.5 text-right text-rn-ink-2 tabular-nums">
                    {n(v)}
                  </td>
                ))}
                <td className="px-2 py-1 text-right">
                  <WeekDelta delta={r.delta} own={r.own} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {vm.gaps.some(Boolean) ? <p className="m-0 px-6 pb-4 text-rn-11 text-rn-muted [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3">{t("gapNote")}</p> : null}
    </>
  );
}

/** 당사's move is better / worse; a rival's keeps the arrow without the colour (as the boards do). */
function WeekDelta({ delta, own }: { delta: number | null; own: boolean }) {
  const t = useTranslations("renewal.mention.delta");
  const locale = useLocale();
  if (delta == null) return <span className="text-rn-11 text-rn-muted">{t("none")}</span>;
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return (
    <RnToneChip tone={delta === 0 || !own ? "flat" : delta > 0 ? "up" : "down"} icon={dir}>
      {delta === 0 ? t("flat") : Math.abs(delta).toLocaleString(locale)}
    </RnToneChip>
  );
}
