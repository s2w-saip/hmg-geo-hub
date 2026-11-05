"use client";

import { use, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CheckCheck, Cpu, FileText, MessageSquare, PieChart, Smile, Tag, Trophy } from "lucide-react";
import { RnCardHead, RnEmpty, RnSegmented, RnSparkline, RnTextButton, cx } from "@/components/renewal-ui";
import type { MentionTypeKey } from "@/lib/db/repositories/scope-aggregates";
import { SENTIMENT_KEYS, type SentimentKey } from "../_data/screen-types";
import { MentionCardActions, numTxt, pctTxt, posTxt, slotLabel, useMention } from "./mention-context";
import { DegradedNote, DeltaChip, InfoTip, useDegradedText } from "./mention-kit";
import { SENTIMENT_COLOR } from "./mention-favor";
import { KPI_KEY } from "./mention-global-trends";

// 당사 지표 tab (2026-11-05 Mention 개편): AI 엔진별 (the four KPIs per engine: the engine cards' exposure · share and the
// BFF's per-engine favorability · first-rank), 감정 분포 (a ring with the four signals; a signal opens its prompts) and
// 멘션 유형별 노출 · 감정 (the original's type exposure card and type sentiment matrix in one table).

type EngineCell = { value: number | null; delta: number | null; series: (number | null)[]; x: string[] };

export function GlobalEngines() {
  const { input, engineLabel } = useMention();
  const t = useTranslations("renewal.mention");
  const tName = useTranslations("dashboard.kpi.name");
  const dg = useDegradedText();
  const rate = use(input.rateEngines);
  const extra = input.engineExtra ? use(input.engineExtra) : null;
  const engines = rate.exposure.rows.map((r) => r.engine);
  const of = (m: "exposure" | "sov", e: string): EngineCell => {
    const r = rate[m].rows.find((x) => x.engine === e);
    return { value: r?.own ?? null, delta: r?.delta ?? null, series: r?.series ?? [], x: rate[m].x };
  };
  const ex = (e: string) => extra?.engines.find((x) => x.engine === e) ?? null;
  const cells: Record<"exposure" | "sov" | "favorability" | "first-rank", (e: string) => EngineCell> = {
    exposure: (e) => of("exposure", e),
    sov: (e) => of("sov", e),
    favorability: (e) => {
      const f = ex(e)?.favorability;
      return { value: f?.pct ?? null, delta: f?.delta.value ?? null, series: f?.series ?? [], x: f?.x ?? [] };
    },
    "first-rank": (e) => {
      const r = ex(e)?.firstRank;
      return { value: r?.avg ?? null, delta: r?.delta.value ?? null, series: r?.series ?? [], x: r?.x ?? [] };
    },
  };
  const metrics = ["exposure", "sov", "favorability", "first-rank"] as const;
  // the engines share one scale per KPI (the original engine card's rule)
  const domainOf = (m: (typeof metrics)[number]): readonly [number, number] | undefined => {
    const all = engines.flatMap((e) => cells[m](e).series).filter((v): v is number => v != null);
    return all.length ? [Math.min(...all), Math.max(...all)] : undefined;
  };
  const csv = () => ({
    name: "mention-engines",
    rows: [
      ["AI", ...metrics.flatMap((m) => [tName(KPI_KEY[m]), `${tName(KPI_KEY[m])} ${t("type.colDelta")}`])],
      ...engines.map((e) => [engineLabel(e), ...metrics.flatMap((m) => [cells[m](e).value, cells[m](e).delta])]),
      // each KPI's rounds: the slots over the engines' series (the original engine CSV: AI, 당사, ...x)
      ...metrics.flatMap((m) =>
        engines.flatMap((e, i) => {
          const c = cells[m](e);
          const head = i === 0 || c.x.join() !== cells[m](engines[i - 1]).x.join() ? [[tName(KPI_KEY[m]), ...c.x]] : [];
          return [...head, [`${engineLabel(e)} · ${tName(KPI_KEY[m])}`, ...c.series]];
        }),
      ),
    ],
  });
  return (
    <>
      <RnCardHead
        icon={<Cpu />}
        title={t("g.enginesTitle")}
        info={<InfoTip label={t("g.enginesTitle")} items={[[t("g.enginesTitle"), t("g.enginesInfo")]]} />}
        chips={<span className="text-rn-12 text-rn-muted">{t("engine.own")}</span>}
        actions={<MentionCardActions section="sec-g-engines" csv={csv} />}
      />
      {rate.exposure.trendMissing ? <DegradedNote>{dg.trend}</DegradedNote> : null}
      {extra?.degraded ? <DegradedNote>{dg.all}</DegradedNote> : null}
      {!engines.length ? (
        <RnEmpty className="mx-5 mb-5">{t("hero.noTrend")}</RnEmpty>
      ) : (
        <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13">
          <thead>
            <tr className="text-left text-rn-12 text-rn-muted">
              <th className="h-10 w-[128px] border-y border-rn-line bg-rn-page pl-5 font-medium">{t("g.colEngine")}</th>
              {metrics.map((m) => (
                <th key={m} className="h-10 border-y border-rn-line bg-rn-page px-3.5 font-medium">
                  {tName(KPI_KEY[m])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {engines.map((e) => (
              <tr key={e} data-rn-engine={e}>
                <td className="border-b border-rn-line py-4 pl-5 align-top font-semibold text-rn-ink last:border-0">
                  <span className="inline-flex items-center gap-2.5">
                    <span aria-hidden className="grid size-7 place-items-center rounded-full bg-rn-track text-rn-12 font-semibold text-rn-muted">
                      {engineLabel(e).slice(0, 1)}
                    </span>
                    {engineLabel(e)}
                  </span>
                </td>
                {metrics.map((m) => {
                  const c = cells[m](e);
                  const rank = m === "first-rank";
                  return (
                    <td key={m} className="border-b border-rn-line px-3.5 py-3.5 align-top">
                      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <b className="text-[22px] leading-none font-[550] tracking-[-0.025em] whitespace-nowrap text-rn-ink tabular-nums">
                          {rank ? posTxt(c.value) : c.value == null ? "—" : c.value.toFixed(1)}
                          <small className="ml-0.5 text-rn-12 font-medium tracking-normal text-rn-muted">{rank ? t("g.rankUnit") : "%"}</small>
                        </b>
                        <DeltaChip value={c.delta} rank={rank} />
                      </span>
                      {c.series.some((v) => v != null) ? (
                        <span className="mt-2 block w-[120px]">
                          <RnSparkline
                            values={c.series}
                            invert={rank}
                            domain={domainOf(m)}
                            tips={c.series.map((v, i) => (v == null ? null : `${slotLabel(c.x[i] ?? "")} · ${rank ? t("rank.unit", { n: posTxt(v) }) : pctTxt(v)}`))}
                            className="h-6"
                          />
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── 감정 분포 ───────────────────────────────────────────────────────────────────

export function GlobalSentiment() {
  const { input, openDrawer } = useMention();
  const t = useTranslations("renewal.mention");
  const tS = useTranslations("answerAnalysis.mentions.breakdown");
  const locale = useLocale();
  const d = use(input.favorDist);
  const pos = d.segments.find((s) => s.key === "positive");
  const r = 62;
  const C = 2 * Math.PI * r;
  let off = 0;
  const label = (k: SentimentKey) => tS(k);
  return (
    <>
      <RnCardHead
        icon={<Smile />}
        title={t("g.sentTitle")}
        info={<InfoTip label={t("favor.distInfoLabel")} items={[[t("favor.distInfoLabel"), t("g.sentInfo")]]} />}
        chips={<span className="text-rn-12 text-rn-muted">{t("favor.distChip", { n: numTxt(d.total, locale) })}</span>}
        actions={<MentionCardActions section="sec-g-sent" csv={() => ({ name: "mention-sentiment", rows: [["", "%", "n"], ...d.segments.map((s) => [label(s.key), s.pct, s.count])] })} />}
      />
      {!d.total ? (
        <RnEmpty className="mx-5 mb-5">{t("hero.noTrend")}</RnEmpty>
      ) : (
        <div className="grid grid-cols-[156px_minmax(0,1fr)] items-center gap-8 px-6 pt-1 pb-5">
          <div className="relative size-[156px]">
            <svg viewBox="0 0 168 168" role="img" aria-label={t("favor.distAria")} className="size-full -rotate-90">
              {d.segments.map((s) => {
                const len = Math.max(0, ((s.pct ?? 0) / 100) * C - 3);
                const el = <circle key={s.key} cx={84} cy={84} r={r} fill="none" stroke={SENTIMENT_COLOR[s.key]} strokeWidth={13} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} />;
                off += ((s.pct ?? 0) / 100) * C;
                return el;
              })}
            </svg>
            <span className="absolute inset-0 grid place-content-center text-center">
              <b className="text-[28px] leading-tight font-[550] tracking-[-0.03em] text-rn-ink tabular-nums">{pctTxt(pos?.pct ?? null)}</b>
              <small className="text-rn-12 text-rn-muted">{t("favor.positive")}</small>
            </span>
          </div>
          <div className="flex flex-col">
            {SENTIMENT_KEYS.map((k) => {
              const s = d.segments.find((x) => x.key === k);
              const n = s?.count ?? 0;
              return (
                <button
                  key={k}
                  type="button"
                  data-rn-sent={k}
                  disabled={n === 0}
                  title={n ? t("favor.distGo") : undefined}
                  onClick={() => openDrawer({ kind: "signal", signal: k })}
                  className="grid h-10 cursor-pointer grid-cols-[3px_minmax(0,1fr)_auto_56px] items-center gap-3 rounded-md text-left text-rn-13 text-rn-ink-2 hover:bg-rn-page focus-visible:outline-2 focus-visible:outline-rn-navy disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <i aria-hidden className="h-[18px] w-[3px] rounded-full" style={{ background: SENTIMENT_COLOR[k] }} />
                  <span>{label(k)}</span>
                  <small className="text-rn-12 text-rn-muted tabular-nums">{t("type.signals", { n: numTxt(n, locale) })}</small>
                  <b className="text-right font-semibold text-rn-ink tabular-nums">{pctTxt(s?.pct ?? null)}</b>
                </button>
              );
            })}
            <RnTextButton className="mt-2 self-start" onClick={() => openDrawer({ kind: "signal", signal: "positive" })}>
              {t("g.sentGo")} ›
            </RnTextButton>
          </div>
        </div>
      )}
    </>
  );
}

// ── 멘션 유형별 노출 · 감정 ───────────────────────────────────────────────────────

const TYPE_ICON: Record<MentionTypeKey, ReactNode> = {
  final_choice: <Trophy />,
  recommendation: <CheckCheck />,
  comparison: <PieChart />,
  definition: <FileText />,
  mention: <MessageSquare />,
};

export function GlobalTypesOwn() {
  const { input, openDrawer } = useMention();
  const t = useTranslations("renewal.mention");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const tS = useTranslations("answerAnalysis.mentions.breakdown");
  const dg = useDegradedText();
  const locale = useLocale();
  const types = use(input.rateTypes);
  const matrix = use(input.favorMatrix);
  const [unit, setUnit] = useState<"pct" | "count">("pct");
  const own = types.own.exposure;
  const sentOf = (k: MentionTypeKey | "all") => matrix.rows.find((r) => r.type === k) ?? null;
  // the original matrix's segment tooltip: each sentiment's share and count in that type
  const sentTip = (r: ReturnType<typeof sentOf>) =>
    r ? SENTIMENT_KEYS.map((k) => `${tS(k)} ${pctTxt(r.segments.find((x) => x.key === k)?.pct ?? null)} · ${t("type.signals", { n: numTxt(r[k], locale) })}`).join("\n") : undefined;
  const csv = () => ({
    name: "mention-types",
    rows: [
      [t("type.colType"), t("type.colOwnExposure"), t("type.colSignals"), t("type.colDelta"), ...own.x, ...SENTIMENT_KEYS.map((k) => tS(k)), `${tS("positive")} %`],
      ...own.rows.map((r) => {
        const s = sentOf(r.type);
        return [tType(r.type), r.pct, r.signals, r.delta, ...r.spark, ...SENTIMENT_KEYS.map((k) => s?.[k] ?? null), s?.positivePct ?? null];
      }),
      [t("favor.matrixAll"), null, null, null, ...own.x.map(() => null), ...SENTIMENT_KEYS.map((k) => sentOf("all")?.[k] ?? null), sentOf("all")?.positivePct ?? null],
      [t("g.roundAnswers"), null, null, null, ...own.answers],
    ],
  });
  const posBar = (r: ReturnType<typeof sentOf>) => (
    <span className="grid grid-cols-[minmax(60px,1fr)_52px] items-center gap-3" title={sentTip(r)}>
      <span className="h-1.5 overflow-hidden rounded-full bg-rn-track">
        <i className="block h-full rounded-full bg-rn-navy-300" style={{ width: `${r?.positivePct ?? 0}%` }} />
      </span>
      <b className="text-right font-semibold text-rn-ink tabular-nums">{unit === "count" ? numTxt(r?.positive ?? null, locale) : pctTxt(r?.positivePct ?? null)}</b>
    </span>
  );
  return (
    <>
      <RnCardHead
        icon={<Tag />}
        title={t("g.typesTitle")}
        info={<InfoTip label={t("type.infoLabel")} items={[[t("type.infoLabel"), t("type.info")], [t("favor.matrixNoteTitle"), t("favor.matrixNote")]]} />}
        chips={<span className="text-rn-12 text-rn-muted">{t("type.chip")}</span>}
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
        actions={<MentionCardActions section="sec-g-types" csv={csv} />}
      />
      {types.degraded ? <DegradedNote>{dg.all}</DegradedNote> : null}
      {!own.rows.length ? (
        <RnEmpty className="mx-5 mb-5">{t("hero.noTrend")}</RnEmpty>
      ) : (
        <table className="w-full table-fixed border-separate border-spacing-0 text-rn-13">
          <thead>
            <tr className="text-left text-rn-12 text-rn-muted">
              <th className="h-10 w-[190px] border-y border-rn-line bg-rn-page pl-5 font-medium">{t("type.colType")}</th>
              <th className="h-10 w-[36%] border-y border-rn-line bg-rn-page px-4 font-medium">{t("g.colTypeExposure")}</th>
              <th className="h-10 w-[110px] border-y border-rn-line bg-rn-page px-4 font-medium">{t("type.colTrend")}</th>
              <th className="h-10 w-[26%] border-y border-rn-line bg-rn-page px-4 font-medium">{unit === "count" ? t("g.colPosCount") : t("g.colPosPct")}</th>
              <th className="h-10 border-y border-rn-line bg-rn-page pr-5 text-right font-medium">{t("type.colSignals")}</th>
            </tr>
          </thead>
          <tbody>
            {own.rows.map((r) => {
              const s = sentOf(r.type);
              return (
                <tr key={r.type} data-rn-type={r.type} className="group/tr">
                  <td className="border-b border-rn-line py-0 pl-5">
                    <button type="button" disabled={r.signals === 0} onClick={() => openDrawer({ kind: "signal", signal: r.type })} className="inline-flex h-[54px] cursor-pointer items-center gap-2.5 font-semibold text-rn-ink hover:text-rn-navy focus-visible:outline-2 focus-visible:outline-rn-navy disabled:cursor-default disabled:hover:text-rn-ink">
                      <span aria-hidden className="grid size-[30px] place-items-center rounded-[9px] bg-rn-track text-rn-muted [&_svg]:size-3.5">
                        {TYPE_ICON[r.type]}
                      </span>
                      {tType(r.type)}
                    </button>
                  </td>
                  <td className="border-b border-rn-line px-4">
                    <span className="grid grid-cols-[minmax(80px,1fr)_60px_76px] items-center gap-3">
                      <span className="h-1.5 overflow-hidden rounded-full bg-rn-track">
                        <i className="block h-full rounded-full bg-rn-navy" style={{ width: `${unit === "count" ? (own.maxCount ? (r.signals / own.maxCount) * 100 : 0) : own.maxPct ? ((r.pct ?? 0) / own.maxPct) * 100 : 0}%` }} />
                      </span>
                      <b className="text-right font-semibold text-rn-ink tabular-nums">{unit === "count" ? t("type.signals", { n: numTxt(r.signals, locale) }) : pctTxt(r.pct)}</b>
                      {unit === "pct" ? <DeltaChip value={r.delta} /> : <span />}
                    </span>
                  </td>
                  <td className="border-b border-rn-line px-4">
                    {r.hasSpark ? (
                      <span className="block w-[84px]">
                        <RnSparkline
                          values={r.spark}
                          tips={r.spark.map((v, i) => (v == null ? null : `${t("type.sparkTip", { day: slotLabel(own.x[i] ?? ""), pct: pctTxt(v) })}\n${t("type.sparkTipCounts", { type: tType(r.type), n: numTxt(r.counts[i] ?? null, locale), den: numTxt(own.answers[i] ?? null, locale) })}`))}
                          className="h-6"
                        />
                      </span>
                    ) : (
                      <span className="text-rn-11 text-rn-muted">—</span>
                    )}
                  </td>
                  <td className={cx("border-b border-rn-line px-4")}>{posBar(s)}</td>
                  <td className="border-b border-rn-line pr-5 text-right text-rn-ink-2 tabular-nums">{numTxt(r.signals, locale)}</td>
                </tr>
              );
            })}
            <tr>
              <td className="h-[50px] rounded-bl-rn-card bg-rn-page pl-5 font-semibold text-rn-muted">{t("favor.matrixAll")}</td>
              <td className="bg-rn-page" />
              <td className="bg-rn-page" />
              <td className="bg-rn-page px-4">{posBar(sentOf("all"))}</td>
              <td className="rounded-br-rn-card bg-rn-page pr-5 text-right text-rn-muted tabular-nums">{numTxt(sentOf("all")?.total ?? null, locale)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </>
  );
}
