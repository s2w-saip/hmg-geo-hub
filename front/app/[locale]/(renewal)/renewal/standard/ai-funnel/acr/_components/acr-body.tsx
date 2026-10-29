"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowUpRight, ChevronDown, FilterX, Hourglass, TrendingUp, X } from "lucide-react";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { geoCodeLabel } from "@/lib/geo-catalog/geo-code-label";
import {
  RnBasisChip,
  RnButton,
  RnCard,
  RnCardHead,
  RnCheckRow,
  RnControlBar,
  RnDeltaChip,
  RnEmpty,
  RnFindingGrid,
  RnHighlightProvider,
  RnInfoTip,
  RnInfoTipItem,
  RnLineChart,
  RnScatterChart,
  RnSectionHead,
  RnSegmented,
  RnSparkline,
  RnTag,
  RnTextButton,
  cx,
  rnHighlightState,
  useRnHighlight,
  useRnHighlightKey,
  useRnToast,
  type RnFinding,
} from "@/components/renewal-ui";
import { useRnFilterReset } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import type { AcrFinding, RnAcrInput, RnAcrView } from "../_data/screen-types";
import { AcrCardActions, AcrProvider, COMPARE_COLORS, OWN_COLOR, deltaTxt, makeColorOf, pctTxt, ppTxt, useAcr, type AcrCtx } from "./acr-context";
import { AcrBattle, AcrDistribution, AcrModels } from "./acr-detail";
import { AcrConversion, AcrDuels } from "./acr-funnel";

export function RnAcrBody({ input }: { input: RnAcrInput }) {
  const t = useTranslations("renewal.acr");
  const tLive = useTranslations("aiFunnelView.acrLive");
  const reset = useRnFilterReset();
  const { view } = input;
  if (!input.measured || !view) {
    return input.filtered ? (
      <StateCard icon={<FilterX className="size-5" aria-hidden />} title={t("states.noResultTitle")} desc={t("states.noResultDesc")}>
        <RnButton onClick={reset}>{t("states.reset")}</RnButton>
      </StateCard>
    ) : (
      <StateCard icon={<Hourglass className="size-5" aria-hidden />} title={tLive("empty.title")} desc={tLive("empty.desc", { count: input.acrPromptCount })} />
    );
  }
  return (
    <RnHighlightProvider>
      <AcrMeasured input={input} view={view} />
    </RnHighlightProvider>
  );
}

function StateCard({ icon, title, desc, children }: { icon: ReactNode; title: string; desc: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col items-center gap-2.5 rounded-rn-card border-[1.5px] border-dashed border-rn-line-2 bg-rn-surface px-6 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-rn-navy/8 text-rn-navy">{icon}</span>
      <h2 className="m-0 text-rn-15 font-bold text-rn-ink">{title}</h2>
      <p className="m-0 max-w-[600px] text-rn-13 text-rn-muted">{desc}</p>
      {children}
    </section>
  );
}

function AcrMeasured({ input, view }: { input: RnAcrInput; view: RnAcrView }) {
  const t = useTranslations("renewal.acr");
  const tf = useTranslations("dashboard.filters");
  const locale = useLocale();
  const [pick, setPick] = useState<{ auto: boolean; brands: string[] }>({ auto: true, brands: [] });
  const [tables, setTables] = useState<ReadonlySet<string>>(new Set());
  const [battle, setBattle] = useState<AcrCtx["battle"]>("all");
  const [sheet, setSheet] = useState<string | null>(null);
  const [distState, setDistState] = useState<AcrCtx["distState"]>("all");
  const toast = useRnToast();
  const key = useRnHighlightKey();
  const { hover } = useRnHighlight();
  const compare = useMemo(() => (pick.auto ? view.defaultCompare : pick.brands.filter((b) => view.rivals.includes(b))), [pick, view.defaultCompare, view.rivals]);
  const isOwn = useCallback((b: string) => view.ownBrands.includes(b), [view.ownBrands]);
  const lit = useMemo(() => (!key ? [] : key === "__own" ? ["__own", ...view.ownBrands] : view.ownBrands.includes(key) ? [key, "__own"] : [key]), [key, view.ownBrands]);
  const toggleCompare = useCallback(
    (b: string) => {
      const cur = compare;
      if (cur.includes(b)) setPick({ auto: false, brands: cur.filter((x) => x !== b) });
      else if (cur.length >= COMPARE_COLORS.length) toast(t("compare.max", { max: COMPARE_COLORS.length }));
      else setPick({ auto: false, brands: [...cur, b] });
    },
    [compare, t, toast],
  );
  const ctx: AcrCtx = {
    view,
    totals: input.totals,
    ownLabel: input.ownLabel,
    compare,
    colorOf: makeColorOf(compare, isOwn),
    isOwn,
    lit,
    hover,
    toggleCompare,
    tables,
    toggleTable: (id) =>
      setTables((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    engineLabel: (e) => ENGINE_LABEL[e] ?? e,
    countryLabel: (c) => (c ? geoCodeLabel(c, locale, (v) => tf(`value.${v}` as "value.worldwide")) : "—"),
    battle,
    setBattle,
    sheet,
    setSheet,
    distState,
    setDistState,
  };
  const T = input.totals;
  return (
    <AcrProvider value={ctx}>
      <div className="@container/rnpage flex flex-col gap-2.5">
        <RnControlBar label={t("bar.label")}>
          <ComparePicker pick={pick} setPick={setPick} />
        </RnControlBar>
        <AcrFindings period={input.period} />
        <RnSectionHead id="sec-overview" title={t("sec.overview")} desc={t("sec.overviewDesc")} />
        <AcrHero period={input.period} roundBuckets={input.roundBuckets} />
        <RnSectionHead id="sec-comp" title={t("sec.comp")} desc={t("sec.compDesc")} />
        <AcrBoard />
        <AcrMap />
        <AcrConversion />
        <AcrDuels />
        <RnSectionHead id="sec-prompt" title={t("sec.prompt")} desc={t("sec.promptDesc")} />
        <AcrBattle />
        <RnSectionHead id="sec-model" title={t("sec.model")} desc={t("sec.modelDesc")} />
        <AcrModels />
        <RnSectionHead id="sec-dist" title={t("sec.dist")} desc={t("sec.distDesc")} />
        <AcrDistribution />
        <p className="m-0 px-1 text-rn-11 text-rn-muted">
          {t(input.period ? "foot.period" : "foot.snapshot", { prompts: T.prompts, cells: T.promptRuns.toLocaleString(locale), iterations: T.iterations.toLocaleString(locale) })}
        </p>
      </div>
    </AcrProvider>
  );
}

// ── compare brands (control bar) ──────────────────────────────────────────────

function ComparePicker({ pick, setPick }: { pick: { auto: boolean; brands: string[] }; setPick: (p: { auto: boolean; brands: string[] }) => void }) {
  const { view, compare, toggleCompare } = useAcr();
  const t = useTranslations("renewal.acr.compare");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-rn-12 font-semibold text-rn-muted">{t("label")}</span>
      {compare.map((b, i) => (
        <span key={b} data-rn-cchip={b} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-rn-surface pr-1 pl-2.5 text-rn-12 font-bold text-rn-ink-2 shadow-[inset_0_0_0_1px_var(--color-rn-line-2)]">
          <i aria-hidden className="size-2 rounded-full" style={{ background: COMPARE_COLORS[i] }} />
          {b}
          {pick.auto ? <span className="font-medium text-rn-muted">· {t("auto")}</span> : null}
          <button type="button" aria-label={t("remove", { brand: b })} onClick={() => setPick({ auto: false, brands: compare.filter((x) => x !== b) })} className="grid size-5 cursor-pointer place-items-center rounded-full text-rn-muted hover:bg-rn-inset hover:text-rn-ink">
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-2.5 text-rn-12 font-bold text-rn-navy shadow-[inset_0_0_0_1px_var(--color-rn-navy-300)] hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:outline-rn-navy"
      >
        <ChevronDown className="size-3" aria-hidden />
        {compare.length ? t("change") : t("add")}
      </button>
      {open ? (
        <div role="dialog" aria-label={t("dialog")} className="absolute top-[calc(100%+6px)] right-0 z-40 w-[260px] rounded-xl bg-rn-surface p-2 shadow-[var(--shadow-rn-3),0_0_0_1px_var(--color-rn-line)]">
          <p className="m-0 px-2 pt-1 pb-1.5 text-rn-11 text-rn-muted">{t("hint", { max: COMPARE_COLORS.length })}</p>
          {view.rivals.length ? (
            <div role="group" aria-label={t("label")}>
              {view.rivals.map((b) => (
                <RnCheckRow key={b} checked={compare.includes(b)} label={b} onToggle={() => toggleCompare(b)} />
              ))}
            </div>
          ) : (
            <p className="m-0 px-2 py-2 text-rn-12 text-rn-muted">{t("empty")}</p>
          )}
          <div className="flex justify-between px-1 pt-1.5">
            <RnTextButton onClick={() => setPick({ auto: true, brands: [] })}>{t("reset")}</RnTextButton>
            <RnTextButton onClick={() => setOpen(false)}>{t("close")}</RnTextButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── 이번 회차 요약 ─────────────────────────────────────────────────────────────

function AcrFindings({ period }: { period: boolean }) {
  const { view, totals, ownLabel, engineLabel, countryLabel } = useAcr();
  const t = useTranslations("renewal.acr");
  const o = view.own;
  // read-only findings (no jump to the card)
  const items: RnFinding[] = view.findings.map((f, i) => findingCopy(f, i, t, { engineLabel, countryLabel }));
  return (
    <RnCard id="sec-summary" aria-label={t(period ? "summary.titlePeriod" : "summary.title")} tone="hero" className="pb-[18px] [.rn-dense_&]:pb-3">
      <RnCardHead
        title={t(period ? "summary.titlePeriod" : "summary.title")}
        info={
          <RnInfoTip label={t("summary.howLabel")}>
            <RnInfoTipItem label={t("summary.howLabel")}>{t("summary.how")}</RnInfoTipItem>
          </RnInfoTip>
        }
        chips={<RnBasisChip>{t(period ? "summary.chipPeriod" : "summary.chipSnapshot")}</RnBasisChip>}
      />
      <p className="m-0 px-6 pb-3.5 text-rn-16 leading-[1.6] break-keep text-white/88 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-2.5 [&_b]:font-bold [&_b]:text-white">
        {t.rich("summary.headline", {
          b: (c) => <b>{c}</b>,
          own: ownLabel,
          rank: view.rank ?? "—",
          share: pctTxt(o?.choiceShare),
          delta: view.ownDelta != null ? ` (${deltaTxt(view.ownDelta)})` : "",
          coverage: pctTxt(o?.coverage),
          count: (o?.choiceCount ?? 0).toLocaleString(),
          prompts: totals.prompts,
          engines: view.engines.length,
        })}
      </p>
      {items.length ? <RnFindingGrid items={items} /> : null}
    </RnCard>
  );
}

type Tr = ReturnType<typeof useTranslations<"renewal.acr">>;
function findingCopy(
  f: AcrFinding,
  i: number,
  t: Tr,
  h: { engineLabel: (e: string) => string; countryLabel: (c: string | null) => string },
): RnFinding {
  const p = f.params;
  const num = (v: string | number) => (typeof v === "number" ? v.toFixed(1) : v);
  let title = "";
  let detail = "";
  switch (f.kind) {
    case "standing":
      title = t(p.first ? "find.standing.titleFirst" : "find.standing.titleBehind", { rival: String(p.rival), gap: num(p.gap) });
      detail = p.move !== "" ? t(p.widened ? "find.standing.detailWidened" : "find.standing.detailNarrowed", { move: num(p.move) }) : t("find.standing.detail", { own: num(p.own), rival: String(p.rival), rivalShare: num(p.rivalShare) });
      break;
    case "leak":
      title = t("find.leak.title", { own: String(p.own), rival: String(p.rival), gap: num(p.gap) });
      detail = t("find.leak.detail", { ownCov: num(p.ownCov), rivalCov: num(p.rivalCov), ownTop1: num(p.ownTop1), rivalTop1: num(p.rivalTop1) });
      break;
    case "engine":
      title = t("find.engine.title", { engine: h.engineLabel(String(p.engine)), wins: p.wins, total: p.total, other: h.engineLabel(String(p.other)), diff: p.diff });
      detail = t("find.engine.detail");
      break;
    case "sweep":
      title = t("find.sweep.title", { rival: String(p.rival), count: p.count });
      detail = t("find.sweep.detail");
      break;
    case "model":
      title = t("find.model.title", { model: String(p.model), rate: num(p.rate) });
      detail = t("find.model.detail", { worst: String(p.worst), worstRate: num(p.worstRate) });
      break;
    case "mover":
      title = t("find.mover.title", { brand: String(p.brand), delta: deltaTxt(Number(p.d)) });
      detail = t("find.mover.detail");
      break;
    case "dist":
      title = t("find.dist.title", { sheet: `${h.countryLabel(String(p.region) || null)} · ${h.engineLabel(String(p.engine))}`, zero: p.zero });
      detail = t("find.dist.detail", { rows: p.rows });
      break;
  }
  return {
    key: `${f.kind}-${i}`,
    tone: f.tone,
    tag: t(`find.${f.kind}.tag` as "find.leak.tag"),
    title,
    detail,
  };
}

// ── 개요: Top1 ACR (당사 합계) + trend ────────────────────────────────────────

const DELTA_LABELS = (t: Tr) => ({ up: t("delta.up"), down: t("delta.down"), flat: t("delta.flat") });

function AcrHero({ period, roundBuckets }: { period: boolean; roundBuckets: boolean }) {
  const { view, totals, ownLabel, compare, colorOf, lit, hover, tables } = useAcr();
  const t = useTranslations("renewal.acr");
  const tDef = useTranslations("aiFunnelView.acr.def");
  const locale = useLocale();
  const o = view.own;
  const lead = view.leader;
  const gap = view.gap;
  const series = [
    ...compare.map((b) => {
      const row = view.brands.find((x) => x.brand === b);
      return { key: b, name: b, color: colorOf(b), values: row?.trend ?? [] };
    }),
    ...(view.ownTrend ? [{ key: "__own", name: ownLabel, color: OWN_COLOR, values: view.ownTrend, own: true }] : []),
  ].filter((s) => s.values.length);
  const x = view.dates.map((d) => (roundBuckets ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : d.slice(5)));
  const basis = period ? t("hero.basisPeriod") : roundBuckets ? t("hero.basisRound") : t("hero.basisDay");
  const tableOn = tables.has("acr-trend");
  return (
    <RnCard aria-label={t("hero.label")}>
      <div className="grid grid-cols-1 gap-x-8 gap-y-4 px-6 pt-5.5 pb-5 @min-[640px]/rnpage:grid-cols-[minmax(210px,280px)_minmax(0,1fr)] [.rn-dense_&]:px-4.5 [.rn-dense_&]:py-3.5">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center gap-1.5 text-rn-12 font-bold text-rn-muted">
            {t("hero.label")}
            <RnInfoTip label={t("def.infoAria")}>
              <RnInfoTipItem label={t("def.definition")}>{tDef("top1.definition")}</RnInfoTipItem>
              <RnInfoTipItem label={t("def.formula")}>{tDef("top1.formula")}</RnInfoTipItem>
            </RnInfoTip>
          </div>
          <div className="text-rn-56 font-bold tracking-[-0.035em] text-rn-navy tabular-nums">
            {o?.choiceShare != null ? o.choiceShare.toFixed(1) : "—"}
            <small className="ml-0.5 text-rn-20 font-semibold tracking-normal">%</small>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-rn-12 text-rn-muted">
            {view.showDelta ? <RnDeltaChip delta={view.ownDelta} format={(r) => `${Math.abs(r).toFixed(1)}pp`} emptyText={t("delta.none")} labels={DELTA_LABELS(t)} /> : null}
            <span>{basis}</span>
          </div>
          {lead && view.rank != null ? (
            <div className="flex items-center gap-2 rounded-lg bg-rn-navy-25 px-2.5 py-2 text-rn-12 text-rn-ink-2 [&_b]:text-rn-navy">
              {view.rank === 1 ? <TrendingUp className="size-3.5" aria-hidden /> : <ArrowUpRight className="size-3.5" aria-hidden />}
              <span>
                {t.rich("hero.standing", { b: (c) => <b>{c}</b>, n: view.standingN ?? "—", rank: view.rank })}
                {gap != null ? ` · ${view.rank === 1 ? t("hero.leadFirst", { brand: lead.brand, gap: gap.toFixed(1) }) : t("hero.leadBehind", { brand: lead.brand, gap: gap.toFixed(1) })}` : ""}
              </span>
            </div>
          ) : null}
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-rn-line pt-3">
            <Stat label={<>{t("hero.coverage")} <CoverageTip /></>} value={pctTxt(o?.coverage)} />
            <Stat label={t("hero.choices")} value={t("hero.times", { n: (o?.choiceCount ?? 0).toLocaleString(locale) })} />
            <Stat label={t("hero.cells")} value={t("hero.count", { n: totals.promptRuns.toLocaleString(locale) })} />
            <Stat label={t("hero.iterations")} value={t("hero.times", { n: totals.iterations.toLocaleString(locale) })} />
          </dl>
          {view.ownBrands.length > 1 ? (
            <div className="flex flex-wrap gap-1.5 [.rn-dense_&]:hidden">
              <span className="inline-flex h-[22px] items-center rounded-full bg-rn-page px-2 text-rn-11 font-semibold text-rn-muted">{t("hero.ownSum", { brands: view.ownBrands.join("+") })}</span>
            </div>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h3 className="m-0 text-rn-13 font-bold text-rn-ink">{t("hero.trendTitle")}</h3>
            <RnInfoTip label={t("hero.trendNoteLabel")}>
              <RnInfoTipItem label={t("hero.trendNoteLabel")}>{period ? t("hero.trendNotePeriod") : roundBuckets ? t("hero.trendNoteRound") : t("hero.trendNoteDay")}</RnInfoTipItem>
            </RnInfoTip>
            <span className="ml-auto">
              <AcrCardActions
                tableId="acr-trend"
                section="sec-overview"
                csv={() => ({ name: "acr-top1-trend", rows: [[t("hero.trendTitle"), ...view.dates], ...series.map((s) => [s.name, ...s.values])] })}
              />
            </span>
          </div>
          <Legend items={[...series].reverse().map((s) => ({ key: s.key, name: s.name, color: s.color, own: "own" in s && !!s.own }))} />
          {!series.length ? (
            <RnEmpty>{t("hero.noTrend")}</RnEmpty>
          ) : tableOn ? (
            <TwinTable head={["", ...x]} rows={series.map((s) => [s.name, ...s.values.map((v) => pctTxt(v))])} />
          ) : (
            <RnLineChart
              x={x}
              series={series}
              height={236}
              yTick={(v) => `${v}%`}
              value={(v) => `${v.toFixed(1)}%`}
              tooltipTitle={(d) => (roundBuckets ? t("hero.tooltipRound", { x: d }) : d)}
              ariaLabel={t("hero.trendAria")}
              lit={lit}
              onHover={hover}
            />
          )}
        </div>
      </div>
    </RnCard>
  );
}

function Stat({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-rn-12 text-rn-muted">{label}</dt>
      <dd className="m-0 mt-0.5 text-rn-15 font-bold text-rn-ink tabular-nums">{value}</dd>
    </div>
  );
}

function CoverageTip({ align }: { align?: "start" | "end" }) {
  const t = useTranslations("renewal.acr.def");
  return (
    <RnInfoTip label={t("infoAria")} align={align}>
      <RnInfoTipItem label={t("definition")}>{t("coverage")}</RnInfoTipItem>
      <RnInfoTipItem label={t("formula")}>{t("coverageFormula")}</RnInfoTipItem>
    </RnInfoTip>
  );
}

function Legend({ items }: { items: ReadonlyArray<{ key: string; name: string; color: string; own?: boolean }> }) {
  const { lit, hover } = useAcr();
  const t = useTranslations("renewal.acr.hero");
  const keys = items.map((i) => i.key);
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-rn-12 text-rn-ink-2">
      {items.map((s) => {
        const st = rnHighlightState(lit, [s.key], keys);
        return (
          <span key={s.key} data-rn-b={s.key} onPointerEnter={() => hover(s.key)} onPointerLeave={() => hover(null)} className={cx("inline-flex items-center gap-1.5 transition-opacity", st === "dim" && "opacity-45", st === "on" && "font-bold text-rn-ink")}>
            <i aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
            {s.name}
            {s.own ? <RnTag>{t("own")}</RnTag> : null}
          </span>
        );
      })}
    </div>
  );
}

export function TwinTable({ head, rows }: { head: ReadonlyArray<ReactNode>; rows: ReadonlyArray<ReadonlyArray<ReactNode>> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-rn-12">
        <thead>
          <tr className="border-b border-rn-line text-rn-muted">
            {head.map((h, i) => (
              <th key={i} className={cx("px-2 py-1.5 font-semibold whitespace-nowrap", i === 0 ? "text-left" : "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-rn-line last:border-0">
              {r.map((c, j) => (
                <td key={j} className={cx("px-2 py-1.5 tabular-nums", j === 0 ? "text-left font-semibold text-rn-ink" : "text-right text-rn-ink-2")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 경쟁 구도: 브랜드별 ACR (Top1 ranking + 후보군 on its own bar) ──────────────

const BOARD_COLS =
  "grid-cols-[26px_minmax(150px,1.2fr)_minmax(48px,1.2fr)_54px_72px_70px_minmax(40px,.8fr)_52px] @max-[680px]/rnpage:grid-cols-[26px_minmax(140px,1.2fr)_minmax(36px,1fr)_54px_70px_minmax(32px,.8fr)_52px]";

function AcrBoard() {
  const { view, ownLabel, compare, colorOf, lit, hover, toggleCompare, tables } = useAcr();
  const t = useTranslations("renewal.acr");
  const tDef = useTranslations("aiFunnelView.acr.def");
  const [sort, setSort] = useState<"choiceShare" | "coverage" | "d">("choiceShare");
  const rows = view.boardOrders[sort].map((i) => view.brands[i]);
  const o = view.own;
  const multiOwn = view.multiOwn;
  const tableOn = tables.has("acr-board");
  const csv = () => ({
    name: "acr-brands",
    rows: [
      [t("board.colBrand"), t("board.colTop1"), t("board.colCoverage"), t("board.colDelta"), t("board.colChoices"), t("board.colMentions")],
      ...(multiOwn && o ? [[`${ownLabel} (${t("board.ownTotal")})`, o.choiceShare, o.coverage, view.ownDelta, o.choiceCount, null]] : []),
      ...rows.map((r) => [r.brand, r.choiceShare, r.coverage, r.d, r.choiceCount, r.appearanceCount]),
    ],
  });
  const keys = ["__own", ...view.brands.map((b) => b.brand)];
  const row = (r: { key: string; name: string; rank: number | null; top1: number | null; bar: number; cov: number | null; trend: Array<number | null> | null; d: number | null; own: boolean; sibling: boolean; canCompare: boolean; total: boolean; tip: string }) => {
    const on = compare.includes(r.key);
    const color = r.own ? OWN_COLOR : on ? colorOf(r.key) : "#c9c3bb";
    const canCompare = r.canCompare;
    const st = rnHighlightState(lit, [r.key], keys);
    const cells = (
      <>
        <span className="text-rn-12 text-rn-muted tabular-nums">{r.rank ?? ""}</span>
        <span className="flex min-w-0 items-center gap-2">
          <i aria-hidden className={cx("size-3 shrink-0 rounded-full", !r.own && !on && "shadow-[inset_0_0_0_1.5px_var(--color-rn-line-2)]")} style={r.own || on ? { background: color } : undefined} />
          <b className={cx("truncate font-semibold", r.own ? "text-rn-navy" : "text-rn-ink")}>{r.name}</b>
          {r.total ? <RnTag>{t("board.ownTotal")}</RnTag> : r.own ? <RnTag>{t("board.own")}</RnTag> : r.sibling ? <RnTag className="bg-transparent text-rn-navy-500 shadow-[inset_0_0_0_1px_var(--color-rn-navy-300)]">{t("board.sibling")}</RnTag> : null}
        </span>
        <span className="h-2 overflow-hidden rounded bg-rn-page">
          <i className="block h-full rounded" style={{ width: `${r.bar}%`, background: color }} />
        </span>
        <span className="text-right text-rn-13 font-bold text-rn-ink tabular-nums">{pctTxt(r.top1)}</span>
        <span className="@max-[680px]/rnpage:hidden">{r.trend ? <RnSparkline values={r.trend} className="h-[26px]" /> : <span className="text-rn-11 text-rn-muted">{t("board.noTrend")}</span>}</span>
        <span className="justify-self-end">
          {r.trend && view.showDelta ? (
            <RnDeltaChip delta={r.d} format={(v) => `${Math.abs(v).toFixed(1)}pp`} emptyText={t("delta.none")} labels={DELTA_LABELS(t)} />
          ) : (
            <span className="text-rn-11 text-rn-muted" title={r.trend ? undefined : t("board.noTrendTip")}>
              —
            </span>
          )}
        </span>
        <span className="h-2 overflow-hidden rounded bg-rn-page">
          <i className="block h-full rounded" style={{ width: `${r.cov ?? 0}%`, background: `color-mix(in srgb, ${color} 55%, #ffffff)` }} />
        </span>
        <span className="text-right text-rn-12 text-rn-ink-2 tabular-nums">{pctTxt(r.cov)}</span>
      </>
    );
    const cls = cx(
      "grid min-h-11 w-full items-center gap-2.5 border-b border-rn-line px-6 text-left text-rn-13 [.rn-dense_&]:min-h-[34px] [.rn-dense_&]:px-4.5",
      BOARD_COLS,
      r.own && (r.total || !multiOwn) && "bg-[linear-gradient(90deg,rgba(0,44,95,.06),rgba(0,44,95,0)_70%)]",
      st === "on" && "bg-rn-navy-25 shadow-[inset_3px_0_0_var(--color-rn-navy)]",
    );
    return canCompare ? (
      <button key={r.key} type="button" data-rn-b={r.key} data-rn-top1={r.top1 ?? ""} data-rn-cov={r.cov ?? ""} aria-pressed={on} title={r.tip} onClick={() => toggleCompare(r.key)} onPointerEnter={() => hover(r.key)} onPointerLeave={() => hover(null)} className={cx(cls, "cursor-pointer hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy")}>
        {cells}
      </button>
    ) : (
      <div key={r.key} data-rn-b={r.key} data-rn-top1={r.top1 ?? ""} data-rn-cov={r.cov ?? ""} title={r.tip + (r.own ? "" : `\n${t("board.noCompare")}`)} onPointerEnter={() => hover(r.key)} onPointerLeave={() => hover(null)} className={cls}>
        {cells}
      </div>
    );
  };
  return (
    <RnCard aria-label={t("board.title")}>
      <RnCardHead
        title={t("board.title")}
        info={
          <RnInfoTip label={t("board.infoLabel")}>
            <RnInfoTipItem label={t("board.infoLabel")}>{t("board.info")}</RnInfoTipItem>
          </RnInfoTip>
        }
        chips={<RnBasisChip>{t("board.chip")}</RnBasisChip>}
        controls={
          <RnSegmented
            label={t("board.sortLabel")}
            value={sort}
            onChange={setSort}
            items={[
              { value: "choiceShare", label: t("board.sortTop1") },
              { value: "coverage", label: t("board.sortCoverage") },
              { value: "d", label: t("board.sortDelta") },
            ]}
          />
        }
        actions={<AcrCardActions tableId="acr-board" section="sec-comp" csv={csv} />}
        sub={t("board.sub")}
      />
      {tableOn ? (
        <div className="px-6 pb-4">
          <TwinTable head={csv().rows[0]} rows={csv().rows.slice(1).map((r) => r.map((c, i) => (i === 0 ? c : typeof c === "number" ? (i === 3 ? deltaTxt(c) : i >= 4 ? c.toLocaleString() : pctTxt(c)) : c == null ? "—" : c)))} />
        </div>
      ) : (
        <>
          <div className={cx("grid h-[34px] items-center gap-2.5 border-y border-rn-line px-6 text-rn-12 font-semibold whitespace-nowrap text-rn-muted [.rn-dense_&]:px-4.5", BOARD_COLS)}>
            <span>#</span>
            <span>{t("board.colBrand")}</span>
            <span className="inline-flex items-center gap-1">
              {t("board.colTop1")}
              <RnInfoTip label={t("def.infoAria")}>
                <RnInfoTipItem label={t("def.definition")}>{tDef("top1.definition")}</RnInfoTipItem>
                <RnInfoTipItem label={t("def.formula")}>{tDef("top1.formula")}</RnInfoTipItem>
              </RnInfoTip>
            </span>
            <span />
            <span className="@max-[680px]/rnpage:hidden">{t("board.colTrend")}</span>
            <span className="text-right">{t("board.colDelta")}</span>
            <span className="inline-flex items-center gap-1">
              {t("board.colCoverage")}
              <CoverageTip align="end" />
            </span>
            <span />
          </div>
          <div>
            {multiOwn && o
              ? row({ key: "__own", name: ownLabel, rank: null, top1: o.choiceShare, bar: view.ownTop1Bar ?? 0, cov: o.coverage, trend: view.ownTrend, d: view.ownDelta, own: true, sibling: false, canCompare: false, total: true, tip: `${ownLabel} — ${t("board.ownTip", { top1: pctTxt(o.choiceShare), coverage: pctTxt(o.coverage), choices: o.choiceCount.toLocaleString() })}` })
              : null}
            {rows.map((r) =>
              row({
                key: r.brand,
                name: r.brand,
                rank: r.rank,
                top1: r.choiceShare,
                bar: r.top1Bar,
                cov: r.coverage,
                trend: r.trend,
                d: r.d,
                own: r.own,
                sibling: r.sibling,
                canCompare: r.canCompare,
                total: false,
                tip: `${r.brand} — ${t("board.rowTip", { top1: pctTxt(r.choiceShare), coverage: pctTxt(r.coverage), choices: r.choiceCount.toLocaleString(), mentions: r.appearanceCount.toLocaleString() })}`,
              }),
            )}
          </div>
        </>
      )}
    </RnCard>
  );
}

// ── 후보 → 최종 선택 (map with the brand average line) ─────────────────────────

function AcrMap() {
  const { view, compare, colorOf, lit, hover, tables } = useAcr();
  const t = useTranslations("renewal.acr");
  const points = view.brands.map((b) => ({
    key: b.brand,
    name: b.brand,
    x: b.mapX,
    y: b.mapY,
    color: colorOf(b.brand),
    own: b.own,
    emph: b.own || compare.includes(b.brand),
    tip: t("map.tip", { brand: b.brand, x: pctTxt(b.coverage), y: pctTxt(b.choiceShare), dev: ppTxt(b.dev) }),
    dev: b.dev,
    devCsv: b.devCsv,
  }));
  const tableOn = tables.has("acr-map");
  const csv = () => ({ name: "acr-shortlist-pick", rows: [[t("board.colBrand"), t("board.colCoverage"), t("board.colTop1"), t("map.colDev")], ...points.map((p) => [p.name, p.x, p.y, p.devCsv])] });
  return (
    <RnCard aria-label={t("map.title")}>
      <RnCardHead
        title={t("map.title")}
        info={
          <RnInfoTip label={t("map.infoLabel")}>
            <RnInfoTipItem label={t("map.infoLabel")}>{t("map.info")}</RnInfoTipItem>
          </RnInfoTip>
        }
        chips={<RnBasisChip>{t("map.chip", { n: points.length })}</RnBasisChip>}
        actions={<AcrCardActions tableId="acr-map" section="sec-comp" csv={csv} />}
      />
      <div className="px-6 pb-5 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3.5">
        {tableOn ? (
          <TwinTable head={csv().rows[0]} rows={points.map((p) => [p.name, pctTxt(p.x), pctTxt(p.y), ppTxt(p.dev)])} />
        ) : (
          <RnScatterChart
            points={points}
            k={view.k}
            height={320}
            ariaLabel={t("map.aria")}
            xTitle={t("map.x")}
            yTitle={t("map.y")}
            lineLabel={t("map.line")}
            above={t("map.above")}
            below={t("map.below")}
            pct={(v) => `${v.toFixed(1)}%`}
            lit={lit}
            onHover={hover}
          />
        )}
      </div>
    </RnCard>
  );
}
