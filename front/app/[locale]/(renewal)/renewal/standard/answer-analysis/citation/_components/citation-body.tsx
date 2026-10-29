"use client";

import { Suspense, use, useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight, CircleSlash, FilterX, Hourglass } from "lucide-react";
import {
  RnBasisChip,
  RnButton,
  RnCard,
  RnCardHead,
  RnFindingGrid,
  RnHighlightProvider,
  RnSectionHead,
  RnSegmented,
  RnSkeleton,
  RnSparkline,
  RnTag,
  cx,
  useRnHighlight,
  useRnHighlightKey,
  type RnFinding,
} from "@/components/renewal-ui";
import { PeriodDeltaLine } from "@/components/dash/period-delta-line";
import { useRnFilterReset, useRnFilterToggle } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { useActiveCitationCategories, useActiveCompetitors } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/citation-url-axes";
import type { CitationDomainLive, CitationsLive } from "@/lib/scope/result-adapter";
import { DEALER_CATEGORY, OFFICIAL_HMG_CATEGORY } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import {
  DELTA_AXIS_MIN,
  MATRIX_MIN_N,
  SPARK_MIN_SPAN,
  type RnCitationDelta,
  type RnCitationInput,
  type RnCitationVm,
  type RnMatrixView,
} from "./citation-input";
import { CitationCardActions, CitationProvider, DIV_LEGEND, DIV_LESS, DIV_MORE, divBg, engineLabel, useCatLabel, useCitation, type CitationCtx, type MatrixAxis } from "./citation-context";
import { CardSkeleton, DegradedNote, DeltaChip, InfoTip, StateCard } from "../../mention/_components/mention-kit";
import { numTxt, pctTxt, deltaTxt } from "../../mention/_components/mention-context";
import { DomainBumpCard, DomainDrawer, DomainTableCard } from "./citation-domains";

export function RnCitationBody({ input }: { input: RnCitationInput }) {
  return (
    <Suspense
      fallback={
        <RnCard className="p-6">
          <RnSkeleton className="h-40 w-full" />
        </RnCard>
      }
    >
      <CitationShell input={input} />
    </Suspense>
  );
}

// The citation aggregate decides the page state (the original StatusBlock's rule: null = no data or
// a budget delay, told apart by dataDegraded).
function CitationShell({ input }: { input: RnCitationInput }) {
  const live = use(input.data);
  const degraded = use(input.dataDegraded);
  const t = useTranslations("renewal.citation.states");
  const tA = useTranslations("answerAnalysis");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const reset = useRnFilterReset();
  if (!live) {
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
      <Measured input={input} live={live} />
    </RnHighlightProvider>
  );
}

function Measured({ input, live }: { input: RnCitationInput; live: CitationsLive }) {
  const t = useTranslations("renewal.citation");
  const competitors = useActiveCompetitors();
  const competitorKey = competitors.join("~");
  const picked = useMemo(() => new Set(competitors), [competitorKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = useActiveCitationCategories();
  const [tables, setTables] = useState<ReadonlySet<string>>(new Set());
  const [axis, setAxis] = useState<MatrixAxis>("engine");
  const [drawer, setDrawer] = useState<CitationDomainLive | null>(null);
  const lit = useRnHighlightKey();
  const { hover, flash } = useRnHighlight();
  const ctx: CitationCtx = {
    input,
    live,
    picked,
    active,
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
    axis,
    setAxis,
    openDomain: setDrawer,
  };
  const closeDrawer = useCallback(() => setDrawer(null), []);
  return (
    <CitationProvider value={ctx}>
      <div className="@container/rnpage flex flex-col gap-2.5">
        <Suspense fallback={<SummarySkeleton />}>
          <Summary />
        </Suspense>
        <RnSectionHead id="sec-overview" title={t("sec.overview")} desc={t("sec.overviewDesc")} />
        <Overview />
        <RnSectionHead id="sec-comp" title={t("sec.comp")} desc={t("sec.compDesc")} />
        <RnCard aria-label={t("comp.title")}>
          <Suspense fallback={<CardSkeleton height={420} />}>
            <CompositionCard />
          </Suspense>
        </RnCard>
        <RnSectionHead id="sec-mix" title={t("sec.mix")} desc={t("sec.mixDesc")} />
        <RnCard aria-label={t("matrix.title")}>
          <MatrixCard />
        </RnCard>
        <RnCard aria-label={t("tone.title")}>
          <Suspense fallback={<CardSkeleton height={200} />}>
            <ToneCard />
          </Suspense>
        </RnCard>
        <RnSectionHead id="sec-dom" title={t("sec.dom")} desc={t("sec.domDesc")} />
        <RnCard aria-label={t("bump.title")}>
          <Suspense fallback={<CardSkeleton height={360} />}>
            <DomainBumpCard />
          </Suspense>
        </RnCard>
        <RnCard aria-label={t("table.title")}>
          <Suspense fallback={<CardSkeleton height={480} />}>
            <DomainTableCard />
          </Suspense>
        </RnCard>
        <DomainDrawer row={drawer} onClose={closeDrawer} />
      </div>
    </CitationProvider>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────

/** Sub page link carrying the page's filters (the original's useSubpageHref). */
export function useSubpageHref(): (sub: "prompts" | "tone-urls", extra: Record<string, string>) => string {
  const pathname = usePathname();
  const sp = useSearchParams();
  return (sub, extra) => {
    const params = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    const qs = params.toString();
    return `${pathname}/${sub}${qs ? `?${qs}` : ""}`;
  };
}

/** Basis line of a Δ: "직전 회차(10/12) 대비" / "Overview 카드와 같은 Δ". */
function useDeltaBasis(): (d: RnCitationDelta) => string | null {
  const t = useTranslations("renewal.citation.delta");
  return (d) =>
    d.basis == null
      ? null
      : d.basis === "period" && d.from && d.date
        ? t("basisPeriod", { from: d.from.slice(0, 10), to: d.date.slice(0, 10) })
        : d.date
          ? t("basisPrev", { date: d.date.slice(0, 10) })
          : t("basisPrevNoDate");
}

/** The renewal model the screen computed (rows, lens, matrices, findings, bump, table) + the Δ round and the degrade flags. */
function useModel(): { rn: RnCitationVm; rows: RnCitationVm["rows"]; lens: RnCitationVm["lens"]; prev: Awaited<RnCitationInput["prevCategories"]>; sections: Awaited<RnCitationInput["sectionDegraded"]> } {
  const { input } = useCitation();
  const rn = use(input.rn) as RnCitationVm;
  const prev = use(input.prevCategories);
  const sections = use(input.sectionDegraded);
  return { rn, rows: rn.rows, lens: rn.lens, prev, sections };
}

// ── 이번 회차 요약 ─────────────────────────────────────────────────────────────

function SummarySkeleton() {
  return (
    <RnCard id="sec-summary" tone="hero" className="min-h-[214px]">
      <CardSkeleton height={200} />
    </RnCard>
  );
}

function Summary() {
  const { input, live } = useCitation();
  const t = useTranslations("renewal.citation");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const cat = useCatLabel();
  const { rn, lens: l } = useModel();
  const list = rn.findings;
  const isPeriod = Boolean(input.period);
  const colName = (axis: "engine" | "type" | undefined, key: string) => (axis === "type" ? tType(key as "mention") : engineLabel(key));
  // read-only findings (no jump to the card)
  const n1 = (v: string | number) => (typeof v === "number" ? v.toFixed(1) : v);
  const items: RnFinding[] = list.map((f, i) => {
    const p = f.params;
    let title = "";
    let detail = "";
    switch (f.kind) {
      case "standingLead":
        title = t("find.standingLead.title", { rival: cat(String(p.rival)), gap: n1(p.gap) });
        detail = p.delta === "" ? t(isPeriod ? "find.noDeltaPeriod" : "find.noDelta") : t(isPeriod ? "find.deltaDetailPeriod" : "find.deltaDetail", { delta: deltaTxt(Number(p.delta)) });
        break;
      case "standingTrail":
        title = t("find.standingTrail.title", { rank: p.rank, share: pctTxt(Number(p.share)), leader: cat(String(p.leader)), leaderShare: pctTxt(Number(p.leaderShare)) });
        detail = p.delta === "" ? t(isPeriod ? "find.noDeltaPeriod" : "find.noDelta") : t(isPeriod ? "find.deltaDetailPeriod" : "find.deltaDetail", { delta: deltaTxt(Number(p.delta)) });
        break;
      case "mover":
        title = t("find.mover.title", { category: cat(String(p.category)), delta: deltaTxt(Number(p.delta)) });
        detail = t(isPeriod ? "find.moverDetailPeriod" : "find.moverDetail", { share: pctTxt(Number(p.share)) });
        break;
      case "engineGap":
        title = t("find.engineGap.title", { low: engineLabel(String(p.low)), share: pctTxt(Number(p.lowShare)), high: engineLabel(String(p.high)), gap: n1(p.gap) });
        detail = t("find.engineGapDetail");
        break;
      case "typeGap":
        title = Number(p.gap) < 0 ? t("find.typeGap.titleLow", { share: pctTxt(Number(p.rec)), gap: n1(Math.abs(Number(p.gap))) }) : t("find.typeGap.titleHigh", { share: pctTxt(Number(p.rec)) });
        detail = t("find.typeGapDetail");
        break;
      case "opportunity":
        title = t("find.opportunity.title", { n: numTxt(Number(p.n)), share: Number(p.share).toFixed(0) });
        detail = t("find.opportunityDetail");
        break;
      case "skew":
        title = t("find.skew.title", { col: colName(f.axis, String(p.col)), category: cat(String(p.category)), gap: deltaTxt(Number(p.gap)) });
        detail = t("find.skewDetail", { share: pctTxt(Number(p.share)), base: pctTxt(Number(p.base)) });
        break;
      case "climb":
        title = t("find.climb.title", { domain: String(p.domain), from: p.from, to: p.to });
        detail = t("find.climbDetail", { weeks: p.weeks, n: p.n });
        break;
    }
    const tag = f.kind === "engineGap" || (f.kind === "skew" && f.axis === "engine") ? t("find.tagEngine") : f.kind === "typeGap" || f.kind === "skew" ? t("find.tagType") : t(`find.${f.kind}.tag`);
    return { key: `${f.kind}-${i}`, tone: f.tone, tag, title, detail };
  });
  const rank = rn.hmgRank;
  const split = l.split;
  const title = t(isPeriod ? "summary.titlePeriod" : "summary.title");
  return (
    <RnCard id="sec-summary" aria-label={title} tone="hero" className="pb-[18px] [.rn-dense_&]:pb-3">
      <RnCardHead
        title={title}
        info={<InfoTip label={t("summary.howLabel")} items={[[t("summary.howLabel"), t("summary.how")]]} />}
        chips={<RnBasisChip>{isPeriod ? t("summary.chipPeriod") : t("summary.chipSnapshot", { date: live.asOf?.slice(0, 10) ?? "—" })}</RnBasisChip>}
      />
      <p className="m-0 px-6 pb-3.5 text-rn-16 leading-[1.6] break-keep text-white/88 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-2.5 [&_b]:font-bold [&_b]:text-white">
        {l.hmg.value == null
          ? t("summary.headlineNoHmg", { dealer: pctTxt(l.dealer.value), total: numTxt(live.summary.total), domains: numTxt(live.summary.uniqueDomains) })
          : t.rich("summary.headline", {
              b: (c) => <b>{c}</b>,
              hmg: pctTxt(l.hmg.value),
              delta: l.hmg.delta.value == null ? "" : ` (${deltaTxt(l.hmg.delta.value)})`,
              rank: rank > 0 ? t("summary.rank", { rank }) : "",
              dealer: pctTxt(l.dealer.value),
              prompts: split.kind === "ok" ? t("summary.prompts", { owned: numTxt(split.owned), uncited: numTxt(split.uncited) }) : "",
            })}
      </p>
      {items.length ? <RnFindingGrid items={items} /> : <p className="m-0 px-6 text-rn-12 text-white/72">{t("summary.empty")}</p>}
    </RnCard>
  );
}

// ── 개요: four tiles + totals + the month line ───────────────────────────────

function Overview() {
  const { input, live } = useCitation();
  const t = useTranslations("renewal.citation");
  const isPeriod = Boolean(input.period);
  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 @min-[520px]/rnpage:grid-cols-2 @min-[960px]/rnpage:grid-cols-4" role="group" aria-label={t("lens.label")}>
        <Suspense fallback={<TileSkeleton />}>
          <ShareTile kind="hmg" />
        </Suspense>
        <Suspense fallback={<TileSkeleton />}>
          <ShareTile kind="dealer" />
        </Suspense>
        <Suspense fallback={<TileSkeleton />}>
          <PromptTile kind="owned" />
        </Suspense>
        <Suspense fallback={<TileSkeleton />}>
          <PromptTile kind="uncited" />
        </Suspense>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" data-rn-cmeta="">
        <RnBasisChip>{t("lens.total", { n: numTxt(live.summary.total) })}</RnBasisChip>
        <RnBasisChip>{t("lens.domains", { n: numTxt(live.summary.uniqueDomains) })}</RnBasisChip>
        <RnBasisChip>{isPeriod ? t("lens.basisPeriod") : t("lens.basisSnapshot", { date: live.asOf?.slice(0, 10) ?? "—" })}</RnBasisChip>
      </div>
      <Suspense fallback={null}>
        <MonthLine />
      </Suspense>
    </>
  );
}

function MonthLine() {
  const { input } = useCitation();
  const view = use(input.periodView);
  return view ? <PeriodDeltaLine view={view} className="mt-0" /> : null;
}

const TILE = "flex min-h-[132px] min-w-0 flex-col gap-1 rounded-rn-card bg-rn-surface px-4.5 pt-3.5 pb-3 text-left shadow-[var(--shadow-rn-1),0_0_0_1px_var(--color-rn-line)] [.rn-dense_&]:min-h-[108px] [.rn-dense_&]:py-2.5";

function TileSkeleton() {
  return (
    <div className={TILE}>
      <RnSkeleton className="h-4 w-32" />
      <RnSkeleton className="mt-auto h-7 w-24" />
      <RnSkeleton className="h-4 w-16" />
    </div>
  );
}

function ShareTile({ kind }: { kind: "hmg" | "dealer" }) {
  const { hover, lit } = useCitation();
  const t = useTranslations("renewal.citation.lens");
  const basis = useDeltaBasis();
  const { lens: l } = useModel();
  const tile = l[kind];
  const key = kind === "hmg" ? OFFICIAL_HMG_CATEGORY : DEALER_CATEGORY;
  const b = basis(tile.delta);
  return (
    <div className={cx(TILE, lit === key && "shadow-[var(--shadow-rn-1),inset_0_-3px_0_var(--color-rn-navy),0_0_0_1px_var(--color-rn-line)]")} data-rn-b={key} data-rn-tile={kind} onPointerEnter={() => hover(key)} onPointerLeave={() => hover(null)}>
      <span className="flex items-center gap-1 text-rn-13 font-bold text-rn-ink">
        {t(`${kind}.name`)}
        <InfoTip label={t(`${kind}.name`)} items={[[t("defLabel"), t(`${kind}.def`)], [t("formulaLabel"), t(`${kind}.formula`)]]} />
      </span>
      <span className="text-rn-11 break-keep text-rn-muted [.rn-dense_&]:hidden">{t(`${kind}.question`)}</span>
      <span className="mt-auto flex items-end gap-2.5">
        <span className="text-rn-28 font-bold tracking-[-0.02em] whitespace-nowrap text-rn-ink tabular-nums">
          {tile.value == null ? (
            "—"
          ) : (
            <>
              {tile.value.toFixed(1)}
              <small className="ml-0.5 text-rn-15 font-semibold">%</small>
            </>
          )}
        </span>
        {tile.sparkOn ? <RnSparkline values={tile.spark} className="mb-1 h-7 w-[72px]" /> : null}
      </span>
      {tile.value == null ? (
        <span className="text-rn-12 text-rn-muted">{t(`${kind}.excluded`)}</span>
      ) : (
        <span className="flex flex-wrap items-center gap-1.5">
          <DeltaChip value={tile.delta.value} />
          {b ? <span className="text-rn-11 text-rn-muted">{b}</span> : null}
        </span>
      )}
    </div>
  );
}

function PromptTile({ kind }: { kind: "owned" | "uncited" }) {
  const t = useTranslations("renewal.citation.lens");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const href = useSubpageHref();
  const { lens: l } = useModel();
  const s = l.split;
  const head = (
    <>
      <span className="flex items-center gap-1 text-rn-13 font-bold text-rn-ink">
        {t(`${kind}.name`)}
        {s.kind === "ok" ? <ChevronRight className="ml-auto size-3.5 text-rn-navy" aria-hidden /> : null}
      </span>
      <span className="text-rn-11 break-keep text-rn-muted [.rn-dense_&]:hidden">{t(`${kind}.question`)}</span>
    </>
  );
  if (s.kind !== "ok") {
    const reason = s.kind === "degraded" ? tK("degraded") : t(`split.${s.kind}`);
    return (
      <div className={cx(TILE, "bg-rn-page shadow-[0_0_0_1px_var(--color-rn-line)]")} data-rn-tile={kind} aria-disabled="true">
        {head}
        <span className="mt-auto text-rn-28 font-bold text-rn-ink">—</span>
        <span className="text-rn-12 text-rn-muted">{reason}</span>
      </div>
    );
  }
  const n = kind === "owned" ? s.owned : s.uncited;
  const pct = kind === "owned" ? s.ownedPct : s.uncitedPct;
  return (
    <Link prefetch={false} href={href("prompts", { tab: kind })} data-rn-tile={kind} className={cx(TILE, "no-underline transition-shadow hover:shadow-[var(--shadow-rn-1),0_0_0_1px_var(--color-rn-line-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rn-navy")}>
      {head}
      <span className="mt-auto flex items-baseline gap-2">
        <span className="text-rn-28 font-bold tracking-[-0.02em] text-rn-ink tabular-nums">
          {numTxt(n)}
          <small className="ml-0.5 text-rn-15 font-semibold">{t("unit")}</small>
        </span>
        <span className="text-rn-13 font-bold text-rn-muted tabular-nums">{pct != null ? `${pct}%` : "—"}</span>
      </span>
      <span className="text-rn-12 font-semibold text-rn-navy">{t("open")}</span>
    </Link>
  );
}

// ── 출처 구성: one ranked list ────────────────────────────────────────────────

// grid: name | share bar | share · citations | Δ bar (0 at the centre) | Δ value | weekly trend
const ROW_GRID =
  "grid-cols-[minmax(108px,150px)_minmax(64px,1fr)_76px_minmax(88px,132px)_64px_92px] @max-[640px]/rnpage:grid-cols-[minmax(96px,130px)_minmax(48px,1fr)_68px_minmax(64px,96px)_60px]";

function CompositionCard() {
  const { input, picked, active, lit, hover } = useCitation();
  const t = useTranslations("renewal.citation.comp");
  const tComp = useTranslations("answerAnalysis.citations.v2.competitor");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const cat = useCatLabel();
  const toggle = useRnFilterToggle();
  const { rn, rows, prev, sections } = useModel();
  const isPeriod = Boolean(input.period);
  const { trendOn, maxPct: max, cap } = rn;
  const keys = rows.map((r) => r.name);
  const csv = () => ({
    name: "citation-categories",
    rows: [[t("col.category"), t("col.citations"), t("col.pct"), t(prev?.period ? "col.prevPeriod" : "col.prev"), t("col.delta")], ...rows.map((r) => [cat(r.name), r.value, r.pct ?? "", r.prevPct ?? "", r.delta ?? ""])],
  });
  return (
    <>
      <RnCardHead
        title={t("title")}
        info={<InfoTip label={t("infoLabel")} items={[[t("infoLabel"), t("info", { cap: DELTA_AXIS_MIN, span: SPARK_MIN_SPAN })]]} />}
        chips={
          <>
            <RnBasisChip>{isPeriod ? t("chipPeriod") : t("chipSnapshot")}</RnBasisChip>
            {prev ? <RnBasisChip>{prev.period ? t("chipDeltaPeriod", { from: prev.period.from, to: prev.period.to }) : t("chipDelta", { date: prev.asOf.slice(0, 10) })}</RnBasisChip> : null}
          </>
        }
        actions={<CitationCardActions section="sec-comp" csv={csv} />}
        sub={t("sub")}
      />
      {rows.length === 0 ? (
        <p className="m-0 px-6 pb-5 text-rn-12 text-rn-muted">{t("empty")}</p>
      ) : (
        <div role="group" aria-label={t("title")} className="flex flex-col pb-3" onPointerLeave={() => hover(null)}>
          <div aria-hidden className={cx("grid min-h-7 items-end gap-2.5 px-6 pb-1 text-rn-11 font-semibold text-rn-muted [.rn-dense_&]:px-4.5", ROW_GRID)}>
            <span>{t("col.category")}</span>
            <span>{t("col.share")}</span>
            <span className="text-right">{t("col.pctCount")}</span>
            <span className="flex flex-col gap-0.5">
              <span className="text-center">{t(prev?.period ? "col.deltaAxisPeriod" : "col.deltaAxis")}</span>
              <span className="flex justify-between font-medium tabular-nums" data-rn-daxis="">
                <span>−{cap}</span>
                <span>0</span>
                <span>+{cap}</span>
              </span>
            </span>
            <span />
            {trendOn ? <span className="text-right @max-[640px]/rnpage:hidden">{t("col.trend")}</span> : null}
          </div>
          {rows.map((r) => (
            <CategoryLine key={r.name} r={r} max={max} cap={cap} trendOn={trendOn} pressed={active.includes(r.name)} lit={lit} keys={keys} onToggle={() => toggle("source", r.name)} />
          ))}
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-6 pt-2.5 text-rn-12 text-rn-ink-2 [.rn-dense_&]:px-4.5" data-rn-dlg="">
            <span className="inline-flex items-center gap-1.5">
              <i aria-hidden className="h-2.5 w-3 rounded-[2px]" style={{ background: DELTA_UP }} />
              {t("up")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i aria-hidden className="h-2.5 w-3 rounded-[2px]" style={{ background: DELTA_DOWN }} />
              {t("down")}
            </span>
            <span className="text-rn-muted">{t("axisNote", { cap: DELTA_AXIS_MIN, span: SPARK_MIN_SPAN })}</span>
          </div>
          {!trendOn && sections?.categoryTrend ? (
            <div className="px-6 pt-2">
              <DegradedNote>{tK("degraded")}</DegradedNote>
            </div>
          ) : null}
        </div>
      )}
      {picked.size > 0 ? <p className="m-0 border-t border-rn-line px-6 py-2.5 text-rn-12 text-rn-navy">{tComp("scopeNote")}</p> : null}
    </>
  );
}

// direction only (more / less of all citations) — the matrix's pair, not good / bad
const DELTA_UP = `rgb(${DIV_MORE.join(",")})`;
const DELTA_DOWN = `rgb(${DIV_LESS.join(",")})`;

function CategoryLine({ r, max, cap, trendOn, pressed, lit, keys, onToggle }: { r: RnCitationVm["rows"][number]; max: number; cap: number; trendOn: boolean; pressed: boolean; lit: string | null; keys: string[]; onToggle: () => void }) {
  const { hover, input } = useCitation();
  const t = useTranslations("renewal.citation.comp");
  const cat = useCatLabel();
  const own = r.name === OFFICIAL_HMG_CATEGORY;
  const on = lit === r.name;
  const dim = lit != null && keys.includes(lit) && !on;
  const top = r.top.map((x) => `${x.domain} ${x.pct.toFixed(0)}%`).join(" · ");
  const d = r.deltaHidden ? null : r.delta;
  const moved = r.moved;
  const half = d != null && moved ? Math.min(50, (Math.abs(d) / cap) * 50) : 0;
  const tip = [
    `${cat(r.name)} · ${t("tipCitations", { n: numTxt(r.value) })} · ${pctTxt(r.pct)}`,
    d == null ? null : t(input.period ? "tipDeltaPeriod" : "tipDelta", { delta: deltaTxt(d), prev: pctTxt(r.prevPct) }),
    t("tipTop", { list: top || "—" }),
    t("tipToggle"),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <button
      type="button"
      data-rn-b={r.name}
      data-rn-src={r.name}
      aria-pressed={pressed}
      onPointerEnter={() => hover(r.name)}
      onClick={onToggle}
      title={tip}
      className={cx(
        "grid min-h-[38px] cursor-pointer items-center gap-2.5 px-6 text-left text-rn-13 transition-[background-color,opacity] hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy [.rn-dense_&]:min-h-8 [.rn-dense_&]:px-4.5",
        ROW_GRID,
        (pressed || on) && "bg-rn-navy-25 shadow-[inset_3px_0_0_var(--color-rn-navy)]",
        dim && "opacity-55",
      )}
    >
      <span className={cx("truncate", own ? "font-bold text-rn-navy" : "text-rn-ink-2")}>{cat(r.name)}</span>
      <span className="relative h-2 rounded-full bg-rn-inset">
        <i className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${((r.pct ?? 0) / max) * 100}%`, background: own ? "var(--color-rn-navy)" : "var(--color-rn-navy-300)" }} />
      </span>
      <span className="flex flex-col items-end leading-tight tabular-nums">
        <b className={cx("font-bold", own ? "text-rn-navy" : "text-rn-ink")}>{pctTxt(r.pct)}</b>
        <small className="text-rn-11 text-rn-muted">{numTxt(r.value)}</small>
      </span>
      <span className="relative h-3" aria-hidden data-rn-dbar={!moved ? "flat" : d! > 0 ? "up" : "down"}>
        <i className="absolute inset-y-0 left-1/2 w-px bg-rn-line-2" />
        {moved ? <i className="absolute top-0.5 bottom-0.5 rounded-[2px]" style={{ left: d! > 0 ? "50%" : `${50 - half}%`, width: `${half}%`, background: d! > 0 ? DELTA_UP : DELTA_DOWN }} /> : null}
      </span>
      <span className={cx("text-right text-rn-12 whitespace-nowrap tabular-nums", own ? "font-bold text-rn-ink" : "text-rn-ink-2")} data-rn-dc="">
        {d == null ? "—" : deltaTxt(d)}
      </span>
      {trendOn ? (
        <span className="flex justify-end @max-[640px]/rnpage:hidden">
          {r.trend?.some((v) => v != null) ? (
            <RnSparkline values={r.trend} minSpan={SPARK_MIN_SPAN} className={cx("h-6 w-[88px] [&_polygon]:fill-transparent", !own && "[&_circle]:fill-rn-faint [&_polyline]:stroke-rn-faint")} />
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

// ── 맥락: source preference matrix + tone ─────────────────────────────────────

function MatrixCard() {
  const { axis, setAxis } = useCitation();
  const t = useTranslations("renewal.citation.matrix");
  return (
    <>
      <RnCardHead
        title={t("title")}
        info={<InfoTip label={t("infoLabel")} items={[[t("infoLabel"), t(axis === "engine" ? "infoEngine" : "infoType", { min: MATRIX_MIN_N })]]} />}
        chips={<RnBasisChip>{t("chip")}</RnBasisChip>}
        controls={
          <RnSegmented
            label={t("axisLabel")}
            value={axis}
            onChange={setAxis}
            items={[
              { value: "engine", label: t("axisEngine") },
              { value: "type", label: t("axisType") },
            ]}
          />
        }
        actions={
          <Suspense fallback={null}>
            <MatrixActions />
          </Suspense>
        }
        sub={t(axis === "engine" ? "subEngine" : "subType")}
      />
      <Suspense fallback={<CardSkeleton height={360} />}>
        <MatrixBody />
      </Suspense>
    </>
  );
}

function useMatrix(): { m: RnMatrixView | null; status: "ok" | "pending" | "degraded" } {
  const { axis } = useCitation();
  const { rn } = useModel();
  return axis === "engine" ? rn.engineMatrix : rn.typeMatrix;
}

function useColName(): (key: string) => string {
  const { axis } = useCitation();
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  return (key) => (axis === "type" ? tType(key as "mention") : engineLabel(key));
}

function MatrixActions() {
  const t = useTranslations("renewal.citation.matrix");
  const cat = useCatLabel();
  const col = useColName();
  const { m } = useMatrix();
  const csv = () => ({
    name: "citation-source-matrix",
    rows: m
      ? [[t("colCategory"), t("colAll"), ...m.cols.flatMap((c) => [col(c.key), `${col(c.key)} ${t("csvGap")}`])], ...m.rows.map((k) => [cat(k), m.base[k].toFixed(1), ...m.cols.flatMap((c) => [c.shares[k].toFixed(1), m.gaps[c.key][k].toFixed(1)])])]
      : [],
  });
  return <CitationCardActions section="sec-mix" csv={csv} />;
}

function MatrixBody() {
  const { lit, hover } = useCitation();
  const t = useTranslations("renewal.citation.matrix");
  const tA = useTranslations("answerAnalysis");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const cat = useCatLabel();
  const col = useColName();
  const { m, status } = useMatrix();
  if (status === "degraded") return <div className="px-6 pb-5"><DegradedNote>{tK("degraded")}</DegradedNote></div>;
  if (!m) return <p className="m-0 px-6 pb-5 text-rn-12 text-rn-muted">{tA("pending")}</p>;
  // one 출처 picked: every column is 100% of it — the original draws absolute counts then
  const counts = m.oneSource;
  const live = new Set(m.live);
  return (
    <>
      <div className="overflow-x-auto px-6 [.rn-dense_&]:px-4.5" onPointerLeave={() => hover(null)}>
        <table className="w-full border-separate border-spacing-0.5 text-rn-13" data-rn-matrix="">
          <thead>
            <tr>
              <th scope="col" className="px-2.5 pt-1 pb-1.5 text-left align-bottom text-rn-12 font-bold text-rn-ink-2">{t("colCategory")}</th>
              <th scope="col" className="px-2.5 pt-1 pb-1.5 text-right align-bottom text-rn-12 font-bold text-rn-ink-2">
                {t("colAll")}
                <small className="block text-rn-11 font-medium text-rn-muted tabular-nums">{t("n", { n: numTxt(m.total) })}</small>
              </th>
              {m.cols.map((c) => (
                <th key={c.key} scope="col" data-rn-col={c.key} className={cx("px-2.5 pt-1 pb-1.5 text-right align-bottom text-rn-12 font-bold", c.thin ? "text-rn-muted" : "text-rn-ink-2")}>
                  {col(c.key)}
                  <small className="block text-rn-11 font-medium text-rn-muted tabular-nums">{t("n", { n: numTxt(c.n) })}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((k) => {
              const own = k === OFFICIAL_HMG_CATEGORY;
              const on = lit === k;
              return (
                <tr key={k} data-rn-b={k} onPointerEnter={() => hover(k)}>
                  <th scope="row" className={cx("h-[34px] px-2.5 text-left font-medium whitespace-nowrap", own ? "font-bold text-rn-navy" : "text-rn-ink-2", (own || on) && "shadow-[inset_3px_0_0_var(--color-rn-navy)]", on && "text-rn-navy")}>
                    {cat(k)}
                  </th>
                  <td className="h-[34px] px-2.5 text-right font-semibold whitespace-nowrap text-rn-ink-2 tabular-nums shadow-[inset_-2px_0_0_var(--color-rn-line)]">{counts ? numTxt(m.baseCounts[k]) : pctTxt(m.base[k])}</td>
                  {m.cols.map((c) => {
                    const gap = m.gaps[c.key][k];
                    const paint = !counts && live.has(c.key);
                    return (
                      <td
                        key={c.key}
                        data-rn-cell={`${c.key}|${k}`}
                        title={`${col(c.key)} · ${cat(k)}\n${t("tipShare", { share: pctTxt(c.shares[k]), base: pctTxt(m.base[k]), gap: deltaTxt(gap) })}${c.thin ? `\n${t("tipThin", { n: numTxt(c.n), min: MATRIX_MIN_N })}` : ""}`}
                        className={cx("h-[34px] rounded px-2.5 text-right whitespace-nowrap tabular-nums", c.thin ? "text-rn-muted" : "text-rn-ink", own && "font-bold", on && "outline-2 -outline-offset-2 outline-rn-navy")}
                        style={paint ? { background: divBg(gap, m.cap) } : undefined}
                      >
                        {counts ? numTxt(c.counts[k]) : pctTxt(c.shares[k])}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {m.cols.length < 2 ? <p className="m-0 px-6 pt-2.5 text-rn-12 text-rn-muted">{t("single")}</p> : null}
      {counts ? (
        <p className="m-0 px-6 pt-2.5 pb-4 text-rn-12 text-rn-muted">{t("oneSource")}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-6 pt-2.5 pb-4 text-rn-12 text-rn-ink-2 [.rn-dense_&]:px-4.5" data-rn-hmlg="">
          <span>{t("less")}</span>
          <span aria-hidden className="h-2.5 w-[120px] rounded-[3px]" style={{ background: DIV_LEGEND }} />
          <span>{t("more")}</span>
          <span className="text-rn-muted">
            {t("cap", { cap: m.cap })}
            {m.anyThin ? ` · ${t("thin", { min: MATRIX_MIN_N })}` : ""}
          </span>
        </div>
      )}
    </>
  );
}

function ToneCard() {
  const { input } = useCitation();
  const t = useTranslations("renewal.citation.tone");
  const tK = useTranslations("answerAnalysis.mentions.kpi");
  const href = useSubpageHref();
  const sum = use(input.toneSummary);
  const tile = (tone: "positive" | "negative", color: string): ReactNode => {
    const s = sum![tone];
    return (
      <div key={tone} className="flex flex-col gap-1 px-6 py-1 [.rn-dense_&]:px-4.5" data-rn-tone={tone}>
        <span className="inline-flex items-center gap-1.5 text-rn-13 font-bold text-rn-ink">
          <i aria-hidden className="size-2.5 rounded-full" style={{ background: color }} />
          {t(`${tone}.name`)}
        </span>
        <span className="text-rn-28 font-bold tracking-[-0.02em] text-rn-ink tabular-nums">
          {numTxt(s.urls)}
          <small className="ml-1 text-rn-15 font-semibold">{t("urlUnit")}</small>
        </span>
        <span className="text-rn-12 text-rn-muted">{t("sub", { citations: numTxt(s.citations), answers: numTxt(s.answers) })}</span>
        {s.urls > 0 ? (
          <Link prefetch={false} href={href("tone-urls", { tone })} className="mt-1 inline-flex items-center gap-0.5 text-rn-12 font-semibold text-rn-navy no-underline hover:underline">
            {t("open")}
            <ChevronRight className="size-3" aria-hidden />
          </Link>
        ) : (
          <span className="mt-1 text-rn-12 text-rn-muted">{t("none")}</span>
        )}
      </div>
    );
  };
  return (
    <>
      <RnCardHead
        title={t("title")}
        info={<InfoTip label={t("infoLabel")} items={[[t("infoLabel"), t("info")]]} />}
        chips={<RnBasisChip>{input.api ? t("chipApi") : t("chipLegacy")}</RnBasisChip>}
        sub={t("subtitle")}
      />
      {sum == null ? (
        <div className="px-6 pb-5">
          <DegradedNote>{tK("degraded")}</DegradedNote>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-y-4 pb-5 @min-[560px]/rnpage:grid-cols-2 @min-[560px]/rnpage:divide-x @min-[560px]/rnpage:divide-rn-line">
          {tile("positive", "#2a78d6")}
          {tile("negative", "#e34948")}
        </div>
      )}
    </>
  );
}

export function OwnTag({ own }: { own: boolean }) {
  return own ? <RnTag className="shrink-0">HMG</RnTag> : null;
}
