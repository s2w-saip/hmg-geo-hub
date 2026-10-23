"use client";

import { Suspense, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, CircleSlash, FilterX, Hourglass, X } from "lucide-react";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import {
  RnBasisChip,
  RnButton,
  RnCard,
  RnCardHead,
  RnCheckRow,
  RnControlBar,
  RnFindingGrid,
  RnHighlightProvider,
  RnSectionHead,
  RnSegmented,
  RnSkeleton,
  RnTextButton,
  cx,
  useRnHighlight,
  useRnHighlightKey,
  type RnFinding,
} from "@/components/renewal-ui";
import { useRnFilterReset } from "@/app/[locale]/(dash)/renewal/_components/overview-filters";
import { overlayFirstPositionValues } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view";
import type { MentionsBrandLive } from "@/lib/scope/result-adapter";
import {
  OWN_KEY,
  board,
  bumpData,
  engineRows,
  favorHero,
  findings,
  rankHero,
  rateHero,
  typeCompareRows,
} from "./mention-model";
import { COMPARE_COLORS, MentionProvider, type DrawerTarget, deltaTxt, pctTxt, posTxt, useCompare, useMention, type ComparePick, type MentionCtx } from "./mention-context";
import { CardSkeleton, InfoTip, StateCard } from "./mention-kit";
import { RateBody } from "./mention-rate";
import { FavorBody } from "./mention-favor";
import { RankBody } from "./mention-rank";
import { BrandDetail, BrandDrawer } from "./mention-brands";
import { KPI_QUESTION, KpiBasisChip, KpiViewLabel, useMentionPage } from "./mention-tabs";

/** The page body; the reads and the KPI tab come from RnMentionPageProvider (mention-tabs). */
export function RnMentionBody() {
  return (
    <Suspense
      fallback={
        <RnCard className="p-6">
          <RnSkeleton className="h-40 w-full" />
        </RnCard>
      }
    >
      <MentionShell />
    </Suspense>
  );
}

// The body aggregate decides the page state (원본 MentionsData 와 같은 판정).
function MentionShell() {
  const { input } = useMentionPage();
  const data = use(input.mentions);
  const degraded = use(input.degraded.data);
  const t = useTranslations("renewal.mention.states");
  const tA = useTranslations("answerAnalysis");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const reset = useRnFilterReset();
  if (!data || data.brands.length === 0) {
    if (degraded) return <StateCard icon={<CircleSlash className="size-5" aria-hidden />} title={tK("degraded")} />;
    return input.filtered ? (
      <StateCard icon={<FilterX className="size-5" aria-hidden />} title={t("noResultTitle")} desc={t("noResultDesc")}>
        <RnButton onClick={reset}>{t("reset")}</RnButton>
      </StateCard>
    ) : (
      <StateCard icon={<Hourglass className="size-5" aria-hidden />} title={tA("empty")} />
    );
  }
  return (
    <RnHighlightProvider>
      <Measured brands={data.brands} />
    </RnHighlightProvider>
  );
}

function Measured({ brands }: { brands: MentionsBrandLive[] }) {
  const t = useTranslations("renewal.mention");
  const tQ = useTranslations("dashboard.kpi.question");
  const { input, kpi, setKpi } = useMentionPage();
  const [pick, setPick] = useState<ComparePick>({ auto: true, brands: [] });
  const [dense, setDense] = useState(false);
  const [tables, setTables] = useState<ReadonlySet<string>>(new Set());
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const key = useRnHighlightKey();
  const { hover, flash } = useRnHighlight();
  const ownBrands = useMemo(() => brands.filter((b) => b.isTracked).map((b) => b.brand), [brands]);
  const lit = useMemo(() => (!key ? [] : key === OWN_KEY ? [OWN_KEY, ...ownBrands] : ownBrands.includes(key) ? [key, OWN_KEY] : [key]), [key, ownBrands]);
  const ctx: MentionCtx = {
    input,
    kpi,
    setKpi,
    ownLabel: input.ownLabel,
    brands,
    ownBrands,
    pick,
    setPick,
    lit,
    hover,
    flash,
    tables,
    toggleTable: (id) =>
      setTables((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    engineLabel: (e) => ENGINE_LABEL[e] ?? e,
    openDrawer: setDrawer,
  };
  const closeDrawer = useCallback(() => setDrawer(null), []);
  return (
    <MentionProvider value={ctx}>
      <div className={cx("@container/rnpage flex flex-col gap-4", dense && "rn-dense gap-2.5")}>
        <RnControlBar label={t("bar.label")}>
          <KpiViewLabel />
          <Suspense fallback={<span className="text-rn-12 font-semibold text-rn-muted">{t("compare.label")}</span>}>
            <ComparePicker />
          </Suspense>
          <RnSegmented
            label={t("density.label")}
            value={dense ? "dense" : "normal"}
            onChange={(v) => setDense(v === "dense")}
            items={[
              { value: "normal", label: t("density.normal") },
              { value: "dense", label: t("density.dense") },
            ]}
          />
        </RnControlBar>
        <Suspense fallback={<SummarySkeleton />}>
          <Summary />
        </Suspense>
        {/* the KPI tab drives this section and the next two (경쟁 구도 · 엔진·유형 or their favour / rank twins) */}
        <RnSectionHead id="sec-overview" title={t("sec.overview")} chip={<KpiBasisChip />} desc={tQ(KPI_QUESTION[kpi] as "coverage")} />
        {kpi === "favorability" ? <FavorBody /> : kpi === "first-rank" ? <RankBody /> : <RateBody metric={kpi} />}
        <RnSectionHead id="sec-brands" title={t("sec.brands")} desc={t("sec.brandsDesc")} />
        <BrandDetail />
        <BrandDrawer target={drawer} onClose={closeDrawer} />
      </div>
    </MentionProvider>
  );
}

// ── compare brands (control bar) ──────────────────────────────────────────────

function ComparePicker() {
  const { pick, setPick } = useMention();
  const { compare, covered, toggle } = useCompare();
  const t = useTranslations("renewal.mention.compare");
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
          {covered.length ? (
            <div role="group" aria-label={t("label")} className="max-h-[300px] overflow-y-auto">
              {covered.map((b) => (
                <RnCheckRow key={b} checked={compare.includes(b)} label={b} onToggle={() => toggle(b)} />
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

function SummarySkeleton() {
  return (
    <RnCard id="sec-summary" className="min-h-[214px]">
      <CardSkeleton height={200} />
    </RnCard>
  );
}

function Summary() {
  const { input, brands, ownLabel, engineLabel } = useMention();
  const { compare } = useCompare();
  const t = useTranslations("renewal.mention");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const period = use(input.periodCompare);
  const [subE, subS, subF, prevE, prevS, prevF] = [use(input.sub.exposure), use(input.sub.sov), use(input.sub.favorability), use(input.prev.exposure), use(input.prev.sov), use(input.prev.favorability)];
  const engine = use(input.engineTrend);
  const trend = use(input.brandTrend);
  const values = use(input.competitorValues);
  const typesByBrand = use(input.typesByBrand);
  const fp = use(input.firstPosition);
  const model = useMemo(() => {
    const heroE = rateHero("exposure", subE, prevE, engine, period);
    const heroS = rateHero("sov", subS, prevS, engine, period);
    const ex = board({ metric: "exposure", brands, trend, values, hero: heroE });
    const sov = board({ metric: "sov", brands, trend, values, hero: heroS });
    const favor = favorHero(subF, prevF, engine, period);
    const rank = rankHero(overlayFirstPositionValues(fp, values), period);
    const list = findings({
      exposure: ex,
      sov,
      types: typeCompareRows({ typesByBrand, brands, compare }),
      engines: engineRows(engine, "exposure").rows,
      bump: bumpData(trend),
      favor,
    });
    return { heroE, heroS, ex, sov, favor, rank, list };
  }, [subE, subS, subF, prevE, prevS, prevF, engine, trend, values, typesByBrand, fp, brands, compare, period]);
  const isPeriod = Boolean(input.period);
  const asOf = model.heroE.points.filter((p) => p.pct != null).at(-1)?.key ?? null;
  // one flat message (nesting rich texts repeats their element keys)
  const rankTxt = (rank: number | null) => (rank ? t("summary.rank", { rank }) : "");
  const rateTxt = (pct: number | null, d: number | null) => `${pctTxt(pct)}${d != null ? ` (${deltaTxt(d)})` : ""}`;
  const items: RnFinding[] = model.list.map((f, i) => {
    const p = f.params;
    const n1 = (v: string | number) => (typeof v === "number" ? v.toFixed(1) : v);
    let title = "";
    let detail = "";
    switch (f.kind) {
      case "standingLead":
      case "standingTrail":
        title = t(`find.${f.kind}.title`, { rank: p.rank, rival: String(p.rival), gap: n1(p.gap) });
        detail = p.move != null ? t(p.widened === "true" ? "find.standingWidened" : "find.standingNarrowed", { move: n1(p.move) }) : t("find.standingDetail", { own: pctTxt(Number(p.own)) });
        break;
      case "typeTrail":
      case "typeLead":
        title = t(`find.${f.kind}.title`, { type: tType(String(p.type) as "mention"), ref: p.ref ? String(p.ref) : t("find.competitorAvg"), gap: f.kind === "typeLead" ? `+${n1(p.gap)}pp` : n1(p.gap) });
        detail = f.kind === "typeTrail" && p.strong === "true" ? t("find.typeStrong") : t("find.typeDetail", { own: pctTxt(Number(p.own)) });
        break;
      case "mover":
        title = t("find.mover.title", { brand: String(p.brand), delta: deltaTxt(Number(p.delta)) });
        detail = t("find.moverDetail", { own: p.own === "" ? "—" : deltaTxt(Number(p.own)) });
        break;
      case "engine":
        title = t("find.engine.title", { engine: engineLabel(String(p.engine)), gap: `${Number(p.gap) >= 0 ? "+" : "−"}${Math.abs(Number(p.gap)).toFixed(1)}pp` });
        detail = p.next ? t("find.engineDetail", { next: engineLabel(String(p.next)), nextGap: `${Number(p.nextGap) >= 0 ? "+" : "−"}${Math.abs(Number(p.nextGap)).toFixed(1)}pp` }) : t("find.engineDetailOne");
        break;
      case "climb":
        title = t("find.climb.title", { brand: String(p.brand), from: p.from, to: p.to });
        detail = t("find.climbDetail", { weeks: p.weeks });
        break;
      case "negative":
        title = t("find.negative.title", { pct: pctTxt(Number(p.pct)), delta: deltaTxt(Number(p.delta)) });
        detail = t("find.negativeDetail");
        break;
    }
    return { key: `${f.kind}-${i}`, tone: f.tone, tag: t(`find.${f.kind}.tag` as "find.mover.tag"), title, detail };
  });
  const title = t(isPeriod ? "summary.titlePeriod" : "summary.title");
  return (
    <RnCard id="sec-summary" aria-label={title} className="pb-4 [.rn-dense_&]:pb-3">
      <RnCardHead
        title={title}
        info={<InfoTip label={t("summary.howLabel")} items={[[t("summary.howLabel"), t("summary.how")]]} />}
        chips={<RnBasisChip>{isPeriod ? t("summary.chipPeriod") : t("summary.chipSnapshot", { date: asOf ?? "—" })}</RnBasisChip>}
      />
      <p className="m-0 px-6 pb-3.5 text-rn-15 leading-[1.6] break-keep text-rn-ink-2 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-2.5 [&_b]:font-bold [&_b]:text-rn-ink">
        {t.rich("summary.headline", {
          b: (c) => <b>{c}</b>,
          own: ownLabel,
          expRank: rankTxt(model.ex.ownRank),
          exp: rateTxt(model.heroE.pct, model.heroE.delta.value),
          sovRank: rankTxt(model.sov.ownRank),
          sov: rateTxt(model.heroS.pct, model.heroS.delta.value),
          fav: pctTxt(model.favor.positivePct),
          pos: model.rank.avgPosition == null ? "—" : t("rank.unit", { n: posTxt(model.rank.avgPosition) }),
        })}
      </p>
      {items.length ? <RnFindingGrid items={items} /> : <p className="m-0 px-6 text-rn-12 text-rn-muted">{t("summary.empty")}</p>}
    </RnCard>
  );
}
