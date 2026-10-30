"use client";

import { Suspense, use, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { RnBasisChip, RnCard, RnCardHead, RnSkeleton, RnToneChip, cx, type RnTone } from "@/components/renewal-ui";
import type { KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import type { MentionViewScreen, SummaryDelta } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/mention-screen";
import { InfoTip, useDegradedText } from "../../../../standard/answer-analysis/mention/_components/mention-kit";
import { KPI_QUESTION, useMentionPage } from "../../../../standard/answer-analysis/mention/_components/mention-tabs";
import { RnMissingPrompts } from "./missing-prompts";

// KPI 세부 지표 (2026-10-30): every count the legacy website Mention showed — its six summary cards and the
// sentiment card's signal counts (mentions-view.tsx) — kept on the renewal page and set under the KPI tab each one
// explains, so a KPI reads with its base: 노출률 with the prompts measured and the prompts without 당사, 점유율
// with all mentions, the brands in the field and the multi-mention answers, 우호도 with the signal counts, 우선
// 노출도 with the Top 3 share. A group title opens its KPI; the 미언급 count opens its prompt list. Values, Δ and the
// Δ basis come from mention/view-cards (back/bff/screens/mention_surfaces.py), the legacy page's reads.
// Design pass (2026-10-30, W6): the head says only what 이번 회차 요약 above does not — the Δ basis with its date,
// and the cards' own date when it is not the page's — and each count is one row (label · value · Δ), so a group
// with one count leaves little empty under it.

/** mention/view-cards */
export interface RnSiteCardsVM extends Pick<MentionViewScreen, "subKpis" | "prevBasisDate" | "degraded" | "deltas"> {
  asOf: string | null;
  summary: { total: number; uniqueBrands: number; totalPrompts: number | null; totalAnswers?: number } | null;
}

type CardKey = "total" | "uniqueBrands" | "totalPrompts" | "missingPrompts" | "multiMention" | "top3Rate" | "positiveKeywords" | "negativeKeywords";

/** Each KPI tab with the legacy counts it rests on (tab order). */
export const KPI_GROUPS: ReadonlyArray<{ kpi: KpiTab; cards: readonly CardKey[] }> = [
  { kpi: "exposure", cards: ["totalPrompts", "missingPrompts"] },
  { kpi: "sov", cards: ["total", "uniqueBrands", "multiMention"] },
  { kpi: "favorability", cards: ["positiveKeywords", "negativeKeywords"] },
  { kpi: "first-rank", cards: ["top3Rate"] },
];

export function RnSiteCards({ cards, period, pageAsOf }: { cards: Promise<RnSiteCardsVM>; period: boolean; pageAsOf: Promise<string | null> | null }) {
  const t = useTranslations("renewal.website.mention.cards");
  return (
    <RnCard id="sec-site-cards" aria-label={t("title")}>
      <Suspense
        fallback={
          <div className="grid grid-cols-2 gap-2 px-6 py-4 @min-[960px]/rnpage:grid-cols-4 [.rn-dense_&]:px-4.5">
            {KPI_GROUPS.map((g) => (
              <RnSkeleton key={g.kpi} className="h-[132px] w-full" />
            ))}
          </div>
        }
      >
        <Cards cards={cards} period={period} pageAsOf={pageAsOf} />
      </Suspense>
    </RnCard>
  );
}

interface Item {
  value: string;
  delta?: SummaryDelta | null;
  detail?: string;
}

function Cards({ cards, period, pageAsOf }: { cards: Promise<RnSiteCardsVM>; period: boolean; pageAsOf: Promise<string | null> | null }) {
  const t = useTranslations("renewal.website.mention.cards");
  const tS = useTranslations("answerAnalysis.mentions.summary");
  const tTab = useTranslations("answerAnalysis.mentions.kpi.tabs");
  const tQ = useTranslations("dashboard.kpi.question");
  const dg = useDegradedText();
  const locale = useLocale();
  const { input, kpi, view, setKpi } = useMentionPage();
  const [missingOpen, setMissingOpen] = useState(false);
  const vm = use(cards);
  const asOf = pageAsOf ? use(pageAsOf) : null;
  if (!vm.summary) return null;
  const { summary, subKpis: sub, deltas } = vm;
  const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString(locale));
  // null = the read failed for now (B035) or no Sub KPI: "—", never a made-up 0 (the degraded line says why)
  const items: Record<CardKey, Item> = {
    total: { value: n(summary.total), delta: deltas?.total },
    uniqueBrands: { value: n(summary.uniqueBrands) },
    totalPrompts: { value: n(summary.totalPrompts), delta: deltas?.totalPrompts },
    missingPrompts: { value: n(sub?.missingPrompts), delta: deltas?.missingPrompts },
    multiMention: { value: n(sub?.multiMentionAnswers), delta: deltas?.multiMention },
    top3Rate: {
      value: sub?.top3Rate != null ? `${sub.top3Rate.toFixed(1)}%` : "—",
      delta: deltas?.top3Rate,
      detail: sub?.top3Count != null && sub.top3Base != null ? tS("ratioAnswers", { num: n(sub.top3Count), den: n(sub.top3Base) }) : undefined,
    },
    positiveKeywords: { value: n(sub?.positiveKeywords) },
    negativeKeywords: { value: n(sub?.negativeKeywords) },
  };
  const missing = sub?.missingPrompts ?? 0;
  const basis = vm.prevBasisDate ? t(period ? "chipDeltaPeriod" : "chipDelta", { date: vm.prevBasisDate }) : null;
  // 이번 회차 요약 already says the page's date (or the period): the cards repeat it only when theirs differs
  const ownDate = !period && vm.asOf && vm.asOf !== asOf ? vm.asOf : null;
  return (
    <>
      <RnCardHead
        title={t("title")}
        info={<InfoTip label={t("title")} items={[[t("title"), t("desc")]]} />}
        chips={
          ownDate || basis ? (
            <>
              {ownDate ? <RnBasisChip>{t("chipAsOf", { date: ownDate })}</RnBasisChip> : null}
              {basis ? <RnBasisChip>{basis}</RnBasisChip> : null}
            </>
          ) : undefined
        }
      />
      <div className="grid grid-cols-2 gap-2 px-6 pb-3 @min-[960px]/rnpage:grid-cols-4 [.rn-dense_&]:px-4.5">
        {KPI_GROUPS.map((g) => {
          const on = view === "kpi" && kpi === g.kpi;
          return (
            <section
              key={g.kpi}
              data-rn-kgroup={g.kpi}
              aria-current={on ? "true" : undefined}
              className={cx("flex min-w-0 flex-col rounded-lg bg-rn-page", on && "shadow-[inset_0_0_0_1.5px_var(--color-rn-navy)]")}
            >
              <button
                type="button"
                onClick={() => setKpi(g.kpi)}
                aria-label={t("openKpi", { kpi: tTab(g.kpi) })}
                className="group/kg flex cursor-pointer flex-col items-start gap-0.5 rounded-t-lg border-b border-rn-line px-3.5 pt-2.5 pb-2 text-left hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy"
              >
                <span className={cx("inline-flex items-center gap-0.5 text-rn-13 font-bold", on ? "text-rn-navy" : "text-rn-ink")}>
                  {tTab(g.kpi)}
                  <ChevronRight aria-hidden className="size-3.5 opacity-60 group-hover/kg:opacity-100" />
                </span>
                <span className="text-rn-11 text-rn-muted">{tQ(KPI_QUESTION[g.kpi] as "coverage")}</span>
              </button>
              <dl className="m-0 flex flex-col gap-1 px-3.5 py-2">
                {g.cards.map((k) => (
                  <Card
                    key={k}
                    k={k}
                    item={items[k]}
                    period={period}
                    onOpen={k === "missingPrompts" && missing > 0 ? () => setMissingOpen(true) : undefined}
                    openLabel={k === "missingPrompts" ? t("openMissing", { count: n(missing) }) : undefined}
                  />
                ))}
              </dl>
            </section>
          );
        })}
      </div>
      {vm.degraded.subKpis ? <p className="m-0 px-6 pb-4 text-rn-11 text-rn-muted [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3">{dg.all}</p> : null}
      {missing > 0 ? <RnMissingPrompts open={missingOpen} onClose={() => setMissingOpen(false)} ownLabel={input.ownLabel} /> : null}
    </>
  );
}

/** Label and definition of a count: the summary cards' own, the sentiment card's signal counts. */
function useCardText(k: CardKey): { label: string; definition: string; formula: string } {
  const tS = useTranslations("answerAnalysis.mentions.summary");
  const tDef = useTranslations("answerAnalysis.mentions.def");
  const tSub = useTranslations("answerAnalysis.mentions.breakdown.sub");
  if (k === "positiveKeywords" || k === "negativeKeywords") {
    return { label: tSub(k), definition: tSub(`def.${k}.definition`), formula: tSub(`def.${k}.formula`) };
  }
  return { label: tS(k), definition: tDef(`${k}.definition`), formula: tDef(`${k}.formula`) };
}

/** One count as a row: label (wraps, never cut) · value · Δ, the ratio line under it. */
function Card({ k, item, period, onOpen, openLabel }: { k: CardKey; item: Item; period: boolean; onOpen?: () => void; openLabel?: string }) {
  const tKpi = useTranslations("dashboard.kpi");
  const text = useCardText(k);
  const value = <b className="text-rn-16 font-bold text-rn-ink tabular-nums">{item.value}</b>;
  return (
    <div data-rn-site-card={k} className="flex min-w-0 flex-col">
      <div className="flex min-h-7 items-center gap-2">
        <dt className="flex min-w-0 flex-1 items-center gap-1 text-rn-12 break-keep text-rn-muted">
          <span>{text.label}</span>
          <InfoTip
            label={text.label}
            items={[
              [tKpi("definitionLabel"), text.definition],
              [tKpi("formulaLabel"), text.formula],
            ]}
          />
        </dt>
        <dd className="m-0 flex shrink-0 items-center gap-1.5">
          {onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              aria-label={openLabel}
              className="inline-flex cursor-pointer items-baseline gap-0.5 rounded underline decoration-rn-line-2 underline-offset-4 hover:decoration-rn-navy focus-visible:outline-2 focus-visible:outline-rn-navy"
            >
              {value}
              <ChevronRight aria-hidden className="size-3.5 self-center text-rn-muted" />
            </button>
          ) : (
            value
          )}
          {item.delta ? <DeltaChip delta={item.delta} period={period} /> : null}
        </dd>
      </div>
      {item.detail ? <span className="text-right text-rn-11 text-rn-muted tabular-nums">{item.detail}</span> : null}
    </div>
  );
}

/** The legacy card Δ: arrow = direction, tone = the screen's good / bad / neutral (a prompt count has no better side).
 * In a period the Δ is the growth inside it (the legacy basis: the window's first round), so it carries no tone. */
function DeltaChip({ delta, period }: { delta: SummaryDelta; period: boolean }) {
  const t = useTranslations("renewal.mention.delta");
  const locale = useLocale();
  const d = delta.diff;
  const neutral = period || delta.tone === "neutral";
  const tone: RnTone = d === 0 || neutral ? "flat" : delta.tone === "good" ? "up" : "down";
  const text = delta.unit === "pp" ? `${Math.abs(d).toFixed(1)}pp` : Math.abs(d).toLocaleString(locale);
  return (
    <RnToneChip tone={tone} icon={d > 0 ? "up" : d < 0 ? "down" : "flat"} title={d === 0 ? t("flat") : neutral ? undefined : delta.tone === "good" ? t("up") : t("down")}>
      {d === 0 ? t("flat") : text}
    </RnToneChip>
  );
}
