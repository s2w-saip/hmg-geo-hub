"use client";

import { Suspense, use, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { RnBasisChip, RnCard, RnCardHead, RnEmpty, RnLineChart, RnSectionHead, RnSegmented, cx } from "@/components/renewal-ui";
import { SENTIMENT_KEYS, type SentimentKey } from "../_data/screen-types";
import { MentionCardActions, numTxt, pctTxt, slotLabel, useMention } from "./mention-context";
import { CardSkeleton, DegradedNote, DeltaChip, InfoTip, Legend, Stat, TwinTable, useDeltaBasis, useDeltaNote } from "./mention-kit";
import { KpiBasisChip } from "./mention-tabs";

// Sentiment colours: positive / neutral / mixed / negative (never the compare-brand hues).
export const SENTIMENT_COLOR: Record<SentimentKey, string> = { positive: "#2f9e6e", neutral: "#b8b0a6", mixed: "#e0a43a", negative: "#d65a43" };

export function FavorBody() {
  const t = useTranslations("renewal.mention");
  const tF = useTranslations("answerAnalysis.mentions.kpi.favorability");
  return (
    <>
      <RnCard aria-label={t("favor.label")}>
        <Suspense fallback={<CardSkeleton height={300} />}>
          <FavorHeroCard />
        </Suspense>
      </RnCard>
      <RnSectionHead id="sec-comp" title={t("sec.favDist")} chip={<KpiBasisChip />} desc={t("sec.favDistDesc")} />
      <RnCard aria-label={tF("dist.title")}>
        <Suspense fallback={<CardSkeleton height={200} />}>
          <Distribution />
        </Suspense>
      </RnCard>
      <RnSectionHead id="sec-mix" title={t("sec.favMix")} chip={<KpiBasisChip />} desc={t("sec.favMixDesc")} />
      <RnCard aria-label={tF("matrix.title")}>
        <Suspense fallback={<CardSkeleton height={280} />}>
          <Matrix />
        </Suspense>
      </RnCard>
    </>
  );
}

function FavorHeroCard() {
  const { input, tables } = useMention();
  const t = useTranslations("renewal.mention");
  const tF = useTranslations("answerAnalysis.mentions.kpi.favorability");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const tDef = useTranslations("dashboard.kpi");
  const locale = useLocale();
  const h = use(input.favorHero);
  const degraded = h.degraded;
  const basis = useDeltaBasis();
  const note = useDeltaNote();
  const foot = note(h.positiveDelta);
  const series = [
    { key: "neg", name: tF("trendNegative"), color: SENTIMENT_COLOR.negative, values: h.points.map((p) => p.negative) },
    { key: "pos", name: tF("trendPositive"), color: SENTIMENT_COLOR.positive, values: h.points.map((p) => p.positive), own: true },
  ];
  const x = h.points.map((p) => slotLabel(p.key));
  const tableOn = tables.has("fav-trend");
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 px-6 pt-5.5 pb-5 @min-[640px]/rnpage:grid-cols-[minmax(240px,320px)_minmax(0,1fr)] [.rn-dense_&]:px-4.5 [.rn-dense_&]:py-3.5">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center gap-1.5 text-rn-12 font-bold text-rn-muted">
          {t("favor.label")}
          <InfoTip label={t("hero.trendNoteLabel")} items={[[tDef("definitionLabel"), tDef("definition.sentiment")], [tDef("formulaLabel"), tDef("formula.sentiment")]]} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="inline-flex items-center gap-1.5 text-rn-12 font-semibold text-rn-ink-2">
              <i aria-hidden className="inline-block h-0.5 w-2.5 rounded" style={{ background: SENTIMENT_COLOR.positive }} />
              {t("favor.positive")}
            </span>
            <span className="text-rn-40 font-bold tracking-[-0.03em] text-rn-navy tabular-nums" data-rn-hero="favorability">
              {pctTxt(h.positivePct)}
            </span>
            <span className="flex flex-wrap items-center gap-1.5 text-rn-11 text-rn-muted">
              <DeltaChip value={h.positiveDelta.value} />
              {basis(h.positiveDelta)}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="inline-flex items-center gap-1.5 text-rn-12 font-semibold text-rn-ink-2">
              <i aria-hidden className="inline-block h-0.5 w-2.5 rounded" style={{ background: SENTIMENT_COLOR.negative }} />
              {t("favor.negative")}
              {h.mixedBasis ? <InfoTip label={t("favor.negativeBasisLabel")} items={[[t("favor.negativeBasisLabel"), tF("negativeBasisNote")]]} /> : null}
            </span>
            <span className="text-rn-40 font-bold tracking-[-0.03em] text-[#b5432f] tabular-nums">{pctTxt(h.negativePct)}</span>
            <span className="flex flex-wrap items-center gap-1.5 text-rn-11 text-rn-muted">
              <DeltaChip value={h.negativeDelta.value} invert />
              {basis(h.negativeDelta)}
            </span>
          </div>
        </div>
        {foot ? <p className="m-0 text-rn-11 text-rn-muted">{foot}</p> : null}
        {degraded ? <DegradedNote>{tK("degraded")}</DegradedNote> : null}
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-rn-line pt-3">
          <Stat label={t("favor.posCount")} value={numTxt(h.positive, locale)} />
          <Stat label={t("favor.total")} value={numTxt(h.total, locale)} />
        </dl>
        <div className="flex flex-wrap gap-1.5 [.rn-dense_&]:hidden">
          <RnBasisChip>{t("favor.chipSignal")}</RnBasisChip>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="m-0 text-rn-13 font-bold text-rn-ink">{t("favor.trendTitle")}</h3>
          <InfoTip label={t("hero.trendNoteLabel")} items={[[t("hero.trendNoteLabel"), tF("trendNote")]]} />
          <span className="ml-auto">
            <MentionCardActions tableId="fav-trend" section="sec-overview" csv={() => ({ name: "mention-favorability-trend", rows: [["", ...h.points.map((p) => p.key)], ...series.map((s) => [s.name, ...s.values])] })} />
          </span>
        </div>
        <Legend items={[...series].reverse()} />
        {h.trendMissing ? (
          <DegradedNote>{tK("degraded")}</DegradedNote>
        ) : !h.points.length ? (
          <RnEmpty>{t("hero.noTrend")}</RnEmpty>
        ) : tableOn ? (
          <TwinTable head={["", ...x]} rows={series.map((s) => [s.name, ...s.values.map((v) => pctTxt(v))])} />
        ) : (
          <RnLineChart x={x} series={series} height={236} yTick={(v) => `${v}%`} value={(v) => `${v.toFixed(1)}%`} tooltipTitle={(d) => t("hero.tooltip", { x: d })} ariaLabel={t("favor.trendAria")} />
        )}
      </div>
    </div>
  );
}

function Distribution() {
  const { input, openDrawer } = useMention();
  const t = useTranslations("renewal.mention");
  const tF = useTranslations("answerAnalysis.mentions.kpi.favorability");
  const tS = useTranslations("answerAnalysis.mentions.breakdown");
  const locale = useLocale();
  const { segments: segs, total } = use(input.favorDist);
  const csv = () => ({ name: "mention-sentiment", rows: [["", "%", "n"], ...segs.map((s) => [tS(s.key), s.pct, s.count])] });
  return (
    <>
      <RnCardHead
        title={tF("dist.title")}
        info={<InfoTip label={t("favor.distInfoLabel")} items={[[t("favor.distInfoLabel"), tF("dist.hint")]]} />}
        chips={<RnBasisChip>{t("favor.distChip", { n: numTxt(total, locale) })}</RnBasisChip>}
        actions={<MentionCardActions section="sec-comp" csv={csv} />}
        sub={tF("dist.clickHint")}
      />
      {!total ? (
        <RnEmpty className="mx-6 mb-5">{tF("dist.empty")}</RnEmpty>
      ) : (
        <div className="flex flex-col gap-3 px-6 pb-5 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3.5">
          <div role="img" aria-label={t("favor.distAria")} className="flex h-4 gap-0.5 overflow-hidden rounded">
            {segs.map((s) => (s.pct ? <i key={s.key} title={`${tS(s.key)} ${pctTxt(s.pct)}`} className="block h-full" style={{ width: `${s.pct}%`, background: SENTIMENT_COLOR[s.key] }} /> : null))}
          </div>
          <div className="grid grid-cols-2 gap-2 @min-[720px]/rnpage:grid-cols-4">
            {segs.map((s) => (
              <button
                key={s.key}
                type="button"
                data-rn-signal={s.key}
                disabled={!s.count}
                onClick={() => openDrawer({ kind: "signal", signal: s.key })}
                className="flex cursor-pointer flex-col gap-0.5 rounded-[10px] bg-rn-page px-3.5 py-2.5 text-left hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:outline-rn-navy disabled:cursor-default disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-1.5 text-rn-12 font-semibold text-rn-ink-2">
                  <i aria-hidden className="size-2.5 rounded-[3px]" style={{ background: SENTIMENT_COLOR[s.key] }} />
                  {tS(s.key)}
                </span>
                <span className="text-rn-20 font-bold text-rn-ink tabular-nums">{pctTxt(s.pct)}</span>
                <span className="text-rn-11 text-rn-muted">{tF("dist.signals", { n: numTxt(s.count, locale) })}</span>
                <span className="mt-0.5 inline-flex items-center text-rn-12 font-semibold text-rn-navy">
                  {t("favor.distGo")}
                  <ChevronRight className="size-3" aria-hidden />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Matrix() {
  const { input } = useMention();
  const t = useTranslations("renewal.mention");
  const tF = useTranslations("answerAnalysis.mentions.kpi.favorability");
  const tS = useTranslations("answerAnalysis.mentions.breakdown");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const locale = useLocale();
  const { rows } = use(input.favorMatrix);
  const [unit, setUnit] = useState<"pct" | "count">("pct");
  const name = (type: string) => (type === "all" ? t("favor.matrixAll") : tType(type as "mention"));
  const csv = () => ({ name: "mention-sentiment-by-type", rows: [["", ...SENTIMENT_KEYS.map((k) => tS(k)), tF("matrix.positiveCol")], ...rows.map((r) => [name(r.type), ...r.segments.map((s) => s.count), r.positivePct])] });
  return (
    <>
      <RnCardHead
        title={tF("matrix.title")}
        info={<InfoTip label={t("favor.matrixNoteTitle")} items={[[t("favor.matrixNoteTitle"), t("favor.matrixNote")]]} />}
        controls={
          <RnSegmented
            label={t("type.unitLabel")}
            value={unit}
            onChange={setUnit}
            items={[
              { value: "pct", label: t("type.unitPct") },
              { value: "count", label: t("type.unitCount") },
            ]}
          />
        }
        actions={<MentionCardActions section="sec-mix" csv={csv} />}
        sub={tF("matrix.hint")}
      />
      {!rows.length ? (
        <RnEmpty className="mx-6 mb-5">{tF("matrix.empty")}</RnEmpty>
      ) : (
        <div className="flex flex-col gap-1 px-6 pb-5 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3.5">
          <Legend shape="square" items={SENTIMENT_KEYS.map((k) => ({ key: `s-${k}`, name: tS(k), color: SENTIMENT_COLOR[k] }))} />
          <div role="img" aria-label={t("favor.matrixAria")} className="mt-1.5 flex flex-col">
            {rows.map((r) => (
              <div key={r.type} className={cx("grid min-h-10 grid-cols-[84px_minmax(0,1fr)_72px] items-center gap-3 border-b border-rn-line last:border-0", r.type === "all" && "font-bold")}>
                <span className="text-rn-13 text-rn-ink">{name(r.type)}</span>
                <span className="flex h-3 gap-0.5 overflow-hidden rounded">
                  {r.segments.map((s) => (s.pct ? <i key={s.key} title={`${name(r.type)} · ${tS(s.key)} ${pctTxt(s.pct)} · ${tF("matrix.count", { n: numTxt(s.count, locale) })}`} className="block h-full" style={{ width: `${s.pct}%`, background: SENTIMENT_COLOR[s.key] }} /> : null))}
                </span>
                <span className="text-right text-rn-13 font-bold text-rn-ink tabular-nums">{unit === "count" ? tF("matrix.count", { n: numTxt(r.positive, locale) }) : pctTxt(r.positivePct)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

