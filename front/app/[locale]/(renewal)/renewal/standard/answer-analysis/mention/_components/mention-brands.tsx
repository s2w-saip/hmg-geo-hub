"use client";

import { Suspense, use, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight, Search, X } from "lucide-react";
import { RnBasisChip, RnCard, RnCardHead, RnDrawer, RnEmpty, RnSegmented, RnTabs, RnTag, RnTextButton, cx, rnHighlightState } from "@/components/renewal-ui";
import type { CitationDomainLive, CitationPromptLive, MentionsPromptLive } from "@/lib/scope/result-adapter";
import { useOrderedTable } from "@/hooks/use-ordered-table";
import type { DrillPromptRow } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/drilldown-screen-types";
import { drilldownParams, projectIdFromPath, startListLoad, type ListState } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/mentions-drilldown";
import { readSignalReply, type SignalPromptsState } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/signal-prompts-dialog";
import { AnswerModal } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/answer-modal";
import { domainDetailUrl } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/citation-domain-table";
import { useDomainDetail } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/citations-view";
import { DETAIL_ANSWERS_CAP, PromptList as DomainPromptList, UrlList as DomainUrlList } from "../../citation/_components/citation-domains";
import { useCatLabel } from "../../citation/_components/citation-context";
import {
  MENTION_TYPE_KEYS,
  NON_AUTO_GROUP,
  OWN_KEY,
  SENTIMENT_KEYS,
  TREEMAP_FOLD,
  type RankingRow,
  type RankingSortKey,
  type RankingValues,
  type RnBumpVM,
  type RnDrawerBrand,
  type TreemapBrand,
} from "../_data/screen-types";
import { squarify } from "./treemap-layout";
import { CONTEXT_COLOR, MentionCardActions, deltaTxt, numTxt, pctTxt, posTxt, slotLabel, useCompare, useMention, type DrawerSignal, type DrawerTarget } from "./mention-context";
import { BrandName, CardSkeleton, DegradedNote, DeltaChip, InfoTip, TwinTable, useDegradedText } from "./mention-kit";
import { SENTIMENT_COLOR } from "./mention-favor";

export function BrandDetail() {
  const t = useTranslations("renewal.mention");
  return (
    <>
      <RnCard aria-label={t("bump.title")}>
        <Suspense fallback={<CardSkeleton height={340} />}>
          <BumpCard />
        </Suspense>
      </RnCard>
      <RnCard aria-label={t("brands.title")}>
        <Suspense fallback={<CardSkeleton height={460} />}>
          <BrandRanking />
        </Suspense>
      </RnCard>
    </>
  );
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ── 주별 언급 순위 · 점유율 (bump) ─────────────────────────────────────────────

function BumpCard() {
  const { input, ownLabel, tables } = useMention();
  const t = useTranslations("renewal.mention");
  const dg = useDegradedText();
  const vm = use(input.bump);
  const d = vm.data;
  const name = (k: string) => (k === OWN_KEY ? ownLabel : k);
  const tableOn = tables.has("bump");
  const measured = vm.measured;
  const csv = () => ({
    name: "mention-weekly-rank",
    rows: [["", ...(d?.x ?? []).flatMap((x) => [`${x} ${t("bump.colRank")}`, `${x} ${t("bump.colShare")}`, `${x} ${t("bump.colMentions")}`])], ...(d?.series ?? []).map((s) => [name(s.key), ...s.ranks.flatMap((r, i) => [r, s.shares[i], s.mentions[i]])])],
  });
  return (
    <>
      <RnCardHead
        title={t("bump.title")}
        info={<InfoTip label={t("bump.infoLabel")} items={[[t("bump.infoLabel"), t("bump.info")]]} />}
        chips={d ? <RnBasisChip>{t("bump.chip", { n: d.x.length })}</RnBasisChip> : null}
        actions={<MentionCardActions tableId="bump" section="sec-brands" csv={csv} />}
      />
      <div className="px-6 pb-5 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3.5">
        {!vm.trend ? (
          <DegradedNote>{dg.trend}</DegradedNote>
        ) : !d || measured < 2 ? (
          <RnEmpty>{t("bump.needTwo")}</RnEmpty>
        ) : tableOn ? (
          <TwinTable
            head={["", ...d.x.map(slotLabel)]}
            rows={d.series.map((s) => [name(s.key), ...s.ranks.map((r, i) => (r == null ? "—" : `${r} · ${pctTxt(s.shares[i])} · ${numTxt(s.mentions[i])}`))])}
          />
        ) : (
          <BumpChart d={d} maxShare={vm.maxShare} />
        )}
      </div>
    </>
  );
}

const ROW = 26;
const LABEL_W = 210;

function BumpChart({ d, maxShare }: { d: NonNullable<RnBumpVM["data"]>; maxShare: number }) {
  const { ownLabel, lit, hover } = useMention();
  const { compare, colorOf } = useCompare();
  const t = useTranslations("renewal.mention.bump");
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = d.series.length;
  const top = 18;
  const h = n * ROW + top + 34;
  const left = 30;
  const plotW = Math.max(120, width - left - LABEL_W);
  const xs = d.x.map((_, i) => left + (d.x.length > 1 ? (i / (d.x.length - 1)) * plotW : plotW / 2));
  const y = (rank: number) => top + (rank - 0.5) * ROW;
  const colGap = d.x.length > 1 ? plotW / (d.x.length - 1) : plotW;
  const rMax = Math.max(4, Math.min(ROW / 2 - 1.5, colGap / 2 - 1.5, 11));
  const radius = (share: number | null) => (share == null ? 0 : Math.max(2.5, rMax * Math.sqrt(share / maxShare)));
  const name = (k: string) => (k === OWN_KEY ? ownLabel : k);
  const keys = d.series.map((s) => s.key);
  const fading = lit.some((k) => keys.includes(k));
  const emph = (k: string) => k === OWN_KEY || compare.includes(k);
  const order = [...d.series].sort((a, b) => Number(emph(a.key)) - Number(emph(b.key)) || Number(a.key === OWN_KEY) - Number(b.key === OWN_KEY));
  const path = (ranks: (number | null)[]) => {
    let p = "";
    let prev: [number, number] | null = null;
    ranks.forEach((r, i) => {
      if (r == null) {
        prev = null;
        return;
      }
      const pt: [number, number] = [xs[i], y(r)];
      if (!prev) p += `M${pt[0].toFixed(1)},${pt[1].toFixed(1)}`;
      else {
        const mx = (prev[0] + pt[0]) / 2;
        p += `C${mx.toFixed(1)},${prev[1].toFixed(1)} ${mx.toFixed(1)},${pt[1].toFixed(1)} ${pt[0].toFixed(1)},${pt[1].toFixed(1)}`;
      }
      prev = pt;
    });
    return p;
  };
  const legend = [5, 10, 15].filter((v) => v <= maxShare * 1.2);
  return (
    <div ref={ref} className="w-full">
      {width > 0 ? (
        <svg width={width} height={h} role="img" aria-label={t("aria")} className="block overflow-visible" onPointerLeave={() => hover(null)}>
          {d.series.map((_, i) => (
            <text key={i} x={left - 12} y={y(i + 1) + 4} textAnchor="end" fontSize={11} fill="var(--color-rn-muted)">
              {i + 1}
            </text>
          ))}
          {xs.map((x, i) => (
            <g key={i}>
              <line x1={x} x2={x} y1={top - 4} y2={top + n * ROW} stroke="var(--color-rn-line)" />
              {/* every other round counted back from the latest, as the line charts */}
              {xs.length <= 8 || (xs.length - 1 - i) % 2 === 0 ? (
                <text x={x} y={top + n * ROW + 16} textAnchor="middle" fontSize={11} fill="var(--color-rn-muted)">
                  {slotLabel(d.x[i])}
                </text>
              ) : null}
            </g>
          ))}
          {order.map((s) => {
            const on = emph(s.key);
            const color = on ? colorOf(s.key) : CONTEXT_COLOR;
            const dim = fading && !lit.includes(s.key);
            return (
              <g key={s.key} data-rn-b={s.key} opacity={dim ? 0.15 : 1} onPointerEnter={() => hover(s.key)} className="cursor-default">
                <path d={path(s.ranks)} fill="none" stroke={color} strokeWidth={s.key === OWN_KEY ? 3 : on ? 2.2 : 1.6} strokeLinecap="round" />
                {s.ranks.map((r, i) =>
                  r == null ? null : (
                    <circle key={i} cx={xs[i]} cy={y(r)} r={radius(s.shares[i])} fill={color} stroke="#fff" strokeWidth={1.5}>
                      <title>{t("tip", { brand: name(s.key), x: slotLabel(d.x[i]), rank: r, share: pctTxt(s.shares[i]), mentions: numTxt(s.mentions[i]) })}</title>
                    </circle>
                  ),
                )}
              </g>
            );
          })}
          {d.series.map((s) => {
            const r1 = s.ranks[d.last];
            if (r1 == null) return null;
            const move = s.move;
            const on = emph(s.key);
            const dim = fading && !lit.includes(s.key);
            const x0 = left + plotW + 18;
            return (
              <g key={`l-${s.key}`} data-rn-b={s.key} opacity={dim ? 0.3 : 1} onPointerEnter={() => hover(s.key)}>
                <text x={x0} y={y(r1) + 4} fontSize={11} fill="var(--color-rn-muted)">
                  {r1}
                </text>
                <text x={x0 + 18} y={y(r1) + 4} fontSize={12} fontWeight={on ? 700 : 500} fill={s.key === OWN_KEY ? "var(--color-rn-navy)" : "var(--color-rn-ink-2)"}>
                  {name(s.key).length > 11 ? `${name(s.key).slice(0, 10)}…` : name(s.key)}
                </text>
                <text x={x0 + 128} y={y(r1) + 4} fontSize={11} textAnchor="end" fill="var(--color-rn-ink-2)" className="tabular-nums">
                  {pctTxt(s.shares[d.last])}
                </text>
                {move ? (
                  <text
                    x={x0 + 136}
                    y={y(r1) + 4}
                    fontSize={11}
                    fontWeight={700}
                    fill={s.key !== OWN_KEY ? "var(--color-rn-muted)" : move > 0 ? "var(--color-rn-up-ink)" : "var(--color-rn-danger-ink)"}
                  >
                    {move > 0 ? "▲" : "▼"}
                    {Math.abs(move)}
                  </text>
                ) : null}
              </g>
            );
          })}
          <g transform={`translate(${left},${top + n * ROW + 26})`}>
            <text x={0} y={4} fontSize={11} fill="var(--color-rn-muted)">
              {t("size")}
            </text>
            {legend.map((v, i) => (
              <g key={v} transform={`translate(${130 + i * 46},0)`}>
                <circle cx={0} cy={0} r={radius(v)} fill="none" stroke="var(--color-rn-faint)" />
                <text x={rMax + 4} y={4} fontSize={11} fill="var(--color-rn-muted)">
                  {v}%
                </text>
              </g>
            ))}
          </g>
        </svg>
      ) : (
        <div style={{ height: h }} />
      )}
    </div>
  );
}

// ── 브랜드 언급 순위: [트리맵 | 순위표] ───────────────────────────────────────

type SortKey = RankingSortKey;
const ASC_KEYS: SortKey[] = ["brand", "rank", "avgPosition"];

/** A ranking row with the values of the multi toggle state. */
type RankRow = RankingRow & { v: RankingValues };

/** `initialView` · `initialQuery`: render-test seams (the card opens on the treemap, the search box empty). */
export function BrandRanking({ initialView = "map", initialQuery = "" }: { initialView?: "map" | "table"; initialQuery?: string } = {}) {
  const { input, openDrawer } = useMention();
  const t = useTranslations("renewal.mention");
  const tT = useTranslations("answerAnalysis.mentions.table");
  const tTm = useTranslations("renewal.mention.treemap");
  const vm = use(input.ranking);
  const [view, setView] = useState<"map" | "table">(initialView);
  const [multi, setMulti] = useState(false);
  const [group, setGroup] = useState<string | null>(null);
  const mode = multi ? "on" : "off";
  // the API sends both value sets (multi toggle off / on) of every body brand
  const rows = useMemo<RankRow[]>(() => vm.rows.map((r) => ({ ...r, v: r[mode] })), [vm.rows, mode]);
  // a parent with several brands reads "{name} 그룹" (HMG stays HMG); a single brand is just its name
  const groupName = (g: string, several = false) =>
    g === NON_AUTO_GROUP ? tTm("nonAuto") : g === TREEMAP_FOLD ? tTm("fold") : several && g !== "HMG" ? tTm("groupName", { name: g }) : g;
  return (
    <>
      <RnCardHead
        title={t("brands.title")}
        info={<InfoTip label={t("board.infoLabel")} items={[[t("brands.colDelta"), t(input.period ? "brands.deltaInfoPeriod" : "brands.deltaInfo")]]} />}
        controls={
          <>
            <RnSegmented
              label={t("brands.viewLabel")}
              value={view}
              onChange={setView}
              items={[
                { value: "map", label: t("brands.viewMap") },
                { value: "table", label: t("brands.viewTable") },
              ]}
            />
            <button type="button" role="switch" aria-checked={multi} title={tT("multiHint")} onClick={() => setMulti((v) => !v)} className="inline-flex cursor-pointer items-center gap-2 text-rn-12 font-semibold text-rn-ink-2 focus-visible:outline-2 focus-visible:outline-rn-navy">
              <span aria-hidden className={cx("relative h-[18px] w-8 rounded-full transition-colors", multi ? "bg-rn-navy" : "bg-rn-line-2")}>
                <i className={cx("absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-[left]", multi ? "left-4" : "left-0.5")} />
              </span>
              {tT("multiToggle")}
            </button>
          </>
        }
        actions={
          <MentionCardActions
            section="sec-brands"
            csv={() => ({
              name: "brand-mentions",
              rows: [
                ["#", tT("col.brand"), tT("col.mentions"), tT("col.share"), t("brands.colDelta"), tT("col.position"), tT("col.prompts"), tT("col.rate")],
                ...rows.map((r) => [r.rank, r.brand, r.v.mentions, r.v.share, r.v.delta, r.avgPosition, r.v.prompts, r.v.mentionRate]),
              ],
            })}
          />
        }
      />
      {!rows.length ? (
        <RnEmpty className="mx-6 mb-5">{tT("empty")}</RnEmpty>
      ) : view === "map" ? (
        <Treemap
          groups={vm.treemap[mode]}
          multi={multi}
          groupName={groupName}
          onBrand={(b) => openDrawer({ kind: "brand", brand: b })}
          onGroupTable={(g) => {
            setGroup(g);
            setView("table");
          }}
        />
      ) : (
        <RankTable rows={rows} orders={vm.orders[mode]} multi={multi} multiUnavailable={vm.multiUnavailable} count={vm.count} group={group} groupName={groupName} onClearGroup={() => setGroup(null)} total={vm.total} initialQuery={initialQuery} />
      )}
    </>
  );
}

// Diverging steps for the share change (pp): green up, red down, sand within ±0.2pp; hatch = no trend.
const DIV_STEPS = [0.2, 0.5, 1.0];
const DIV_POS = ["#d3ecdc", "#8fcca6", "#4fa577"];
const DIV_NEG = ["#f8d6ce", "#f0a28f", "#dc6a52"];
const DIV_ZERO = "#e7e1da";
const DIV_NA = "repeating-linear-gradient(135deg, #f1ede8 0 6px, #e4ded7 6px 8px)";
const divColor = (d: number | null): string => {
  if (d == null) return DIV_ZERO;
  const r = Math.round(d * 10) / 10;
  const a = Math.abs(r);
  if (a < DIV_STEPS[0]) return DIV_ZERO;
  const i = a >= DIV_STEPS[2] ? 2 : a >= DIV_STEPS[1] ? 1 : 0;
  return r > 0 ? DIV_POS[i] : DIV_NEG[i];
};
const relLum = (hex: string) => {
  const c = (hex.match(/\w\w/g) ?? ["0", "0", "0"]).map((x) => {
    const v = parseInt(x, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const inkOn = (hex: string) => (1.05 / (relLum(hex) + 0.05) >= 4.5 ? "#ffffff" : "#0a0908");
// label width at a bold size, measured with the page font (labels are drawn only when they fit)
let measureCtx: CanvasRenderingContext2D | null = null;
const textW = (text: string, px: number): number => {
  if (typeof document === "undefined") return text.length * px * 0.62;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * px * 0.62;
  measureCtx.font = `700 ${px}px ${getComputedStyle(document.body).fontFamily}`;
  return measureCtx.measureText(text).width;
};

function Treemap({
  groups,
  multi,
  groupName,
  onBrand,
  onGroupTable,
}: {
  groups: import("../_data/screen-types").TreemapGroup[];
  multi: boolean;
  groupName: (g: string, several?: boolean) => string;
  onBrand: (brand: string) => void;
  onGroupTable: (group: string) => void;
}) {
  const { lit, hover, input } = useMention();
  const t = useTranslations("renewal.mention.treemap");
  const legend = t(input.period ? "legendPeriod" : "legend");
  const locale = useLocale();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [drill, setDrill] = useState<string | null>(null);
  const height = 380;
  const current = drill ? groups.find((g) => g.key === drill) ?? null : null;
  useEffect(() => {
    if (!drill) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrill(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drill]);
  const fmtD = (d: number | null) => (d == null ? t("na") : deltaTxt(d));
  const steps = t("steps").split(",");
  const covered = (b: TreemapBrand) => b.delta != null;
  const fill = (d: number | null, hasTrend: boolean) => (multi ? DIV_ZERO : hasTrend ? divColor(d) : null);
  const tile = (key: string, rect: { x: number; y: number; w: number; h: number }, body: { title: string; short?: string; share: number; delta: number | null; hasTrend: boolean; own: boolean; dashed?: boolean; drillN?: number; members?: TreemapBrand[]; tip: string; onClick: () => void }) => {
    const bg = fill(body.delta, body.hasTrend);
    const ink = bg ? inkOn(bg) : "#0a0908";
    const big = rect.w > 70 && rect.h > 44;
    const size = big ? 13 : 11;
    const avail = rect.w - 14;
    // every label is shown whole or not at all (the tooltip names every tile)
    const fitRow = rect.h >= 22 ? [body.title, body.short].find((s): s is string => Boolean(s) && textW(s!, size) <= avail) : undefined;
    const vText = !fitRow && rect.w >= 18 && rect.h > rect.w ? [body.title, body.short].find((s): s is string => Boolean(s) && textW(s!, 11) <= rect.h - 12) : undefined;
    const label = fitRow ? { mode: "row" as const, text: fitRow } : vText ? { mode: "vertical" as const, text: vText } : { mode: "none" as const, text: "" };
    const statLine = `${pctTxt(body.share)}${!multi && body.hasTrend ? `  ${fmtD(body.delta)}` : ""}`;
    const lit1 = lit.includes(key);
    return (
      <button
        key={key}
        type="button"
        data-rn-tile={key}
        data-rn-b={key}
        title={body.tip}
        onClick={body.onClick}
        onPointerEnter={() => hover(key)}
        onPointerLeave={() => hover(null)}
        className={cx(
          "absolute flex cursor-pointer flex-col items-start overflow-hidden rounded-[3px] p-1.5 text-left focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-rn-navy",
          body.drillN ? "cursor-zoom-in" : "",
          body.own && "shadow-[inset_0_0_0_2.5px_var(--color-rn-navy)]",
          body.dashed && "outline-1 -outline-offset-4 outline-rn-navy-300 outline-dashed",
          lit1 && "z-[1] shadow-[inset_0_0_0_2.5px_var(--color-rn-ink)]",
        )}
        style={{ left: rect.x + 1, top: rect.y + 1, width: Math.max(0, rect.w - 2), height: Math.max(0, rect.h - 2), background: bg ?? DIV_NA, color: ink }}
      >
        {body.members && body.members.length > 1 && rect.w > 40 && rect.h > 40 ? (
          <span aria-hidden className="pointer-events-none absolute inset-0">
            {squarify(body.members, 0, 0, rect.w - 2, rect.h - 2).map((m, i) => (i === 0 ? null : <i key={m.brand} className="absolute border-t border-l border-current opacity-15" style={{ left: m.x, top: m.y, width: m.w, height: m.h }} />))}
          </span>
        ) : null}
        {label.mode === "vertical" ? (
          <span className="relative text-rn-11 font-bold whitespace-nowrap [writing-mode:vertical-rl]">{label.text}</span>
        ) : label.mode === "row" ? (
          <>
            <span className={cx("relative font-bold whitespace-nowrap", big ? "text-rn-13" : "text-rn-11")}>{label.text}</span>
            {big && textW(statLine, 12) <= rect.w - 14 ? (
              <span className="relative text-rn-12 font-semibold whitespace-nowrap tabular-nums">{statLine}</span>
            ) : null}
            {body.drillN && rect.w > 96 && rect.h > 64 ? (
              <span className="relative mt-auto inline-flex items-center rounded-full bg-black/10 px-1.5 text-rn-11 font-semibold">
                {t("drill", { n: body.drillN })}
                <ChevronRight className="size-3" aria-hidden />
              </span>
            ) : null}
          </>
        ) : null}
      </button>
    );
  };
  const area = width > 0 ? { w: width, h: height } : null;
  return (
    <div className="flex flex-col gap-2.5 px-6 pb-5 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3.5">
      <div className="flex min-h-7 flex-wrap items-center gap-2 text-rn-12">
        {current ? (
          <>
            <RnTextButton onClick={() => setDrill(null)}>{t("all")}</RnTextButton>
            <ChevronRight className="size-3 text-rn-muted" aria-hidden />
            <b className="text-rn-ink">{groupName(current.key, true)}</b>
            <span className="ml-auto">
              <RnTextButton onClick={() => onGroupTable(current.key)}>{t("toTable")}</RnTextButton>
            </span>
          </>
        ) : (
          // the treemap holds the top 100 body brands (the table holds them all: the card title names no count)
          <span className="text-rn-muted">
            {t("all")} · {t("scope", { n: groups.reduce((n, g) => n + g.members.length, 0) })}
          </span>
        )}
      </div>
      <div ref={ref} role="group" aria-label={t("aria")} className="relative w-full" style={{ height }}>
        {area
          ? current
            ? squarify(current.members, 0, 0, area.w, area.h).map((m) =>
                tile(m.brand, m, {
                  title: m.brand,
                  share: m.share,
                  delta: m.delta,
                  hasTrend: covered(m),
                  own: m.own,
                  dashed: m.sibling,
                  tip: t("brandTip", { brand: m.brand, share: pctTxt(m.share), delta: fmtD(m.delta), mentions: numTxt(m.value, locale) }),
                  onClick: () => onBrand(m.brand),
                }),
              )
            : squarify(groups, 0, 0, area.w, area.h).map((g) =>
                tile(g.key === TREEMAP_FOLD || g.key === NON_AUTO_GROUP ? g.key : g.members.length === 1 ? g.members[0].brand : g.key, g, {
                  title: g.members.length === 1 && g.key !== TREEMAP_FOLD ? g.members[0].brand : groupName(g.key, g.members.length > 1),
                  short: g.members.length > 1 && g.key !== TREEMAP_FOLD && g.key !== NON_AUTO_GROUP ? g.key : undefined,
                  share: g.share,
                  delta: g.delta,
                  hasTrend: g.delta != null,
                  own: g.own,
                  drillN: g.members.length > 1 ? g.members.length : undefined,
                  members: g.members,
                  tip: `${t("groupTip", { group: groupName(g.key, g.members.length > 1), share: pctTxt(g.share), delta: fmtD(g.delta), n: g.members.length })}${g.partial ? `\n${t("partial")}` : ""}`,
                  onClick: () => (g.members.length > 1 ? setDrill(g.key) : onBrand(g.members[0].brand)),
                }),
              )
          : null}
      </div>
      {!multi ? (
        <div aria-label={legend} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-rn-11 text-rn-muted">
          <span className="font-semibold">{legend}</span>
          {[DIV_NEG[2], DIV_NEG[1], DIV_NEG[0], DIV_ZERO, DIV_POS[0], DIV_POS[1], DIV_POS[2]].map((c, i) => (
            <span key={c} className="inline-flex items-center gap-1">
              <i aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: c }} />
              {steps[i]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <i aria-hidden className="inline-block size-2.5 rounded-[2px]" style={{ background: DIV_NA }} />
            {t("na")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function RankTable({
  rows,
  orders,
  multi,
  multiUnavailable,
  count,
  group,
  groupName,
  onClearGroup,
  total,
  initialQuery = "",
}: {
  rows: RankRow[];
  orders: import("../_data/screen-types").RnRankingVM["orders"]["off"];
  multi: boolean;
  multiUnavailable: boolean;
  count: number;
  group: string | null;
  groupName: (g: string, several?: boolean) => string;
  onClearGroup: () => void;
  total?: number;
  initialQuery?: string;
}) {
  const { openDrawer, lit, hover, input } = useMention();
  const t = useTranslations("renewal.mention");
  const tT = useTranslations("answerAnalysis.mentions.table");
  const tF = useTranslations("answerAnalysis.filters");
  const tD = useTranslations("dashboard.filters");
  const tTr = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  const locale = useLocale();
  const [q, setQ] = useState(initialQuery);
  const dq = useDeferredValue(q);
  // sort orders come from the API (useOrderedTable keeps the column / direction); the search box
  // and the treemap group stay UI filters over the ordered rows, then the first `limit` of them show
  const { sorted: ordered, sortKey, asc, toggleSort } = useOrderedTable(rows, orders, { defaultKey: "rank", defaultAsc: true, ascByDefault: ASC_KEYS });
  // "더 보기" grows the list by RANK_TABLE_STEP; a new search or group starts again from the first step
  const listKey = `${dq.trim().toLowerCase()}\u0000${group ?? ""}`;
  const [more, setMore] = useState({ key: listKey, limit: RANK_TABLE_STEP });
  const limit = more.key === listKey ? more.limit : RANK_TABLE_STEP;
  const { rows: sorted, matched } = rankTableRows(ordered, dq, group, limit);
  // the cut note counts the list being cut: every brand (the backend's count if it cut the list), or the matches
  const listTotal = !dq.trim() && !group && total !== undefined && total > count ? total : matched;
  const tB = (k: string) => t(`brands.${k}`);
  const def = (definition: string, formula?: string): ReadonlyArray<[string, string]> => (formula ? [[tB("defLabel"), definition], [tB("formulaLabel"), formula]] : [[tB("defLabel"), definition]]);
  const info: Partial<Record<SortKey, ReadonlyArray<[string, string]>>> = {
    rank: def(tT("colDefinition.rank")),
    mentions: def(multi ? tT("colDefinition.multiMentions") : tT("colDefinition.mentions")),
    share: multi ? def(tB("multiShareDef"), tB("multiShareFormula")) : def(tT("colDefinition.share"), tT("colFormula.share")),
    delta: def(multi ? tB("multiNoDelta") : tB(input.period ? "deltaInfoPeriod" : "deltaInfo")),
    avgPosition: def(tT("colDefinition.position")),
    prompts: def(multi ? tB("multiPromptsDef") : tT("colDefinition.prompts")),
    mentionRate: multi ? def(tT("colDefinition.multiRate"), tB("multiRateFormula")) : def(tT("colDefinition.rate"), tT("colFormula.rate")),
  };
  const head = (k: SortKey, label: string, right = true) => (
    <span className={cx("inline-flex min-w-0 items-center gap-1", right && "justify-end")}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        aria-sort={sortKey === k ? (asc ? "ascending" : "descending") : undefined}
        className={cx("inline-flex cursor-pointer items-center gap-0.5 font-semibold whitespace-nowrap hover:text-rn-ink", right && "justify-end", sortKey === k ? "text-rn-ink" : "text-rn-muted")}
      >
        {label}
        {sortKey === k ? <span aria-hidden>{asc ? "↑" : "↓"}</span> : null}
      </button>
      {info[k] ? <InfoTip label={label} align={right ? "end" : undefined} items={info[k]} /> : null}
    </span>
  );
  const keys = sorted.map((r) => r.brand);
  const COLS = "grid-cols-[34px_minmax(150px,1.6fr)_80px_68px_76px_64px_70px_64px]";
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 pb-2.5 [.rn-dense_&]:px-4.5">
        <label className="inline-flex h-8 w-[220px] items-center gap-1.5 rounded-lg bg-rn-page px-2.5 text-rn-12 text-rn-muted focus-within:outline-2 focus-within:outline-rn-navy">
          <Search className="size-3.5" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label={tF("brandSearch")} placeholder={tF("brandSearchPlaceholder")} className="min-w-0 flex-1 bg-transparent text-rn-ink outline-none" />
        </label>
        {dq.trim() ? <span className="text-rn-12 text-rn-muted">{tD("searchResultCount", { matched, total: rows.length })}</span> : null}
        {group ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-full bg-rn-navy-25 pr-1 pl-2.5 text-rn-12 font-semibold text-rn-navy">
            {t("brands.groupOnly", { group: groupName(group, true) })}
            <button type="button" aria-label={t("brands.clearGroup")} onClick={onClearGroup} className="grid size-5 cursor-pointer place-items-center rounded-full hover:bg-rn-navy/10">
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ) : null}
        {multi && multiUnavailable ? <span className="text-rn-11 text-rn-muted">{tT("multiUnavailable")}</span> : null}
      </div>
      {/* no overflow box around the head: its ⓘ tooltips open below it over the rows; the rows keep a height that
          holds the tallest tooltip, so a short search result at the page's end neither clips nor grows the page */}
      <div>
        <div className="min-w-[700px]">
          <div className={cx("grid h-[34px] items-center gap-2.5 border-y border-rn-line px-6 text-rn-12 [.rn-dense_&]:px-4.5", COLS)}>
            {head("rank", "#", false)}
            {head("brand", tT("col.brand"), false)}
            {head("mentions", multi ? tT("col.multiMentions") : tT("col.mentions"))}
            {head("share", tT("col.share"))}
            {head("delta", t("brands.colDelta"))}
            {head("avgPosition", tT("col.position"))}
            {head("prompts", tT("col.prompts"))}
            {head("mentionRate", multi ? tT("col.multiRate") : tT("col.rate"))}
          </div>
          <div className="max-h-[520px] min-h-[168px] overflow-y-auto">
            {!sorted.length ? (
              <RnEmpty className="m-6">{tT("empty")}</RnEmpty>
            ) : (
              sorted.map((r) => {
                const st = rnHighlightState(lit, [r.brand, ...(r.own ? [OWN_KEY] : [])], keys);
                return (
                  <button
                    key={r.brand}
                    type="button"
                    data-rn-b={r.brand}
                    data-rn-row={r.rank}
                    title={t("brands.rowTip")}
                    onClick={() => openDrawer({ kind: "brand", brand: r.brand, row: r.drawer })}
                    onPointerEnter={() => hover(r.brand)}
                    onPointerLeave={() => hover(null)}
                    className={cx(
                      "grid min-h-10 w-full cursor-pointer items-center gap-2.5 border-b border-rn-line px-6 text-left text-rn-13 hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy [.rn-dense_&]:min-h-8 [.rn-dense_&]:px-4.5",
                      COLS,
                      r.own && "bg-[linear-gradient(90deg,rgba(0,44,95,.06),rgba(0,44,95,0)_70%)]",
                      st === "on" && "bg-rn-navy-25 shadow-[inset_3px_0_0_var(--color-rn-navy)]",
                    )}
                  >
                    <span className="text-rn-12 text-rn-muted tabular-nums">{r.rank}</span>
                    <span className="flex min-w-0 items-center gap-2">
                      <BrandName name={r.brand} own={r.own} sibling={r.sibling} />
                      <span className="truncate text-rn-11 text-rn-muted">{r.grouped ? groupName(r.group, true) : ""}</span>
                    </span>
                    <span className="text-right font-semibold text-rn-ink tabular-nums">{numTxt(r.v.mentions, locale)}</span>
                    <span className="text-right text-rn-ink-2 tabular-nums">{pctTxt(r.v.share)}</span>
                    <span className="justify-self-end">{multi ? <span className="text-rn-11 text-rn-muted" title={t("brands.multiNoDelta")}>—</span> : r.v.covered ? <DeltaChip value={r.v.delta} /> : <span className="text-rn-11 text-rn-muted" title={t(input.period ? "board.noPrevPeriodTip" : "board.noTrendTip")}>{t(input.period ? "board.noPrevPeriod" : "board.noTrend")}</span>}</span>
                    <span className="text-right text-rn-ink-2 tabular-nums">{posTxt(r.avgPosition)}</span>
                    <span className="text-right text-rn-ink-2 tabular-nums">{numTxt(r.v.prompts, locale)}</span>
                    <span className="text-right text-rn-ink-2 tabular-nums">{pctTxt(r.v.mentionRate)}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
      {sorted.length < listTotal || matched > sorted.length ? (
        <div className="flex flex-wrap items-center gap-3 px-6 pt-2 [.rn-dense_&]:px-4.5">
          {sorted.length < listTotal ? <p className="m-0 text-rn-11 text-rn-muted">{tTr("truncated", { shown: sorted.length, total: listTotal })}</p> : null}
          {matched > sorted.length ? (
            <RnTextButton data-rn-more="" onClick={() => setMore({ key: listKey, limit: limit + RANK_TABLE_STEP })}>
              {t("brands.more", { n: Math.min(RANK_TABLE_STEP, matched - sorted.length) })}
            </RnTextButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Rows the ranking table shows first and adds with "더 보기" (the original Global table's limit). */
export const RANK_TABLE_STEP = 100;

/** The ranking table's rows (renewal audit 6-1): the ordered rows the search (every brand) and the treemap group
 *  keep, the first `limit` of them; `matched` = how many they keep. */
export function rankTableRows<R extends { brand: string; group: string }>(ordered: R[], query: string, group: string | null, limit: number): { rows: R[]; matched: number } {
  const q = query.trim().toLowerCase();
  const kept = ordered.filter((r) => (!q || r.brand.toLowerCase().includes(q)) && (!group || group === TREEMAP_FOLD || r.group === group));
  return { rows: kept.slice(0, limit), matched: kept.length };
}

// ── drawer: brand (prompts · citation sources) / signal: a sentiment or a mention type (prompts) → the original answer modal ──

type DrawerAnswer = { prompt: Pick<MentionsPromptLive, "promptText" | "answers">; brand: string; variant: "mention" | "citation" };

export function BrandDrawer({ target, onClose }: { target: DrawerTarget | null; onClose: () => void }) {
  const { ownLabel } = useMention();
  const tB = useTranslations("answerAnalysis.mentions.breakdown");
  const [answer, setAnswer] = useState<DrawerAnswer | null>(null);
  // the sheet comes back one task after the modal closes, so the Escape that closed the modal
  // does not reach the sheet as well
  const [sheetHidden, setSheetHidden] = useState(false);
  useEffect(() => {
    setAnswer(null);
    setSheetHidden(false);
  }, [target]);
  const openAnswer = useCallback((prompt: DrawerAnswer["prompt"], brand: string, variant: DrawerAnswer["variant"] = "mention") => {
    setSheetHidden(true);
    setAnswer({ prompt, brand, variant });
  }, []);
  const closeAnswer = useCallback((o: boolean) => {
    if (o) return;
    setAnswer(null);
    setTimeout(() => setSheetHidden(false), 0);
  }, []);
  return (
    <>
      {target ? (
        target.kind === "brand" ? (
          <BrandSheet
            brand={target.brand}
            fallback={target.row}
            hidden={sheetHidden}
            onClose={onClose}
            onAnswer={(p) => openAnswer(p, target.brand)}
            onCitationAnswer={(p) => openAnswer(p, target.brand, "citation")}
          />
        ) : (
          <SignalSheet
            signal={target.signal}
            label={isMentionType(target.signal) ? tB(`type.${target.signal}`) : tB(target.signal)}
            hidden={sheetHidden}
            onClose={onClose}
            onAnswer={(p) => openAnswer(p, ownLabel)}
          />
        )
      ) : null}
      {/* The original answer modal (highlights, sentiment underline, sources). The sheet steps aside
          while it is open and comes back with its state when it closes. */}
      <AnswerModal brand={answer?.brand ?? ""} variant={answer?.variant} promptText={answer?.prompt.promptText ?? ""} answers={answer?.prompt.answers ?? []} open={answer !== null} onOpenChange={closeAnswer} />
    </>
  );
}

/** A Website page (renewal/website/…, 2026-10-30): the drawer reads the website surface, as the answer view does (answer-modal.tsx). */
export function isWebsitePath(pathname: string | null | undefined): boolean {
  return (pathname ?? "").includes("/website/");
}

/** The signal drawer's route query: the page's filters, the signal, and the project id or the website surface (signal-prompts-dialog.tsx). */
export function signalPromptsQuery(spStr: string, signal: string, pathname: string | null | undefined): string {
  const params = new URLSearchParams(spStr);
  params.set("signal", signal);
  const projectId = projectIdFromPath(pathname);
  if (projectId) params.set("projectId", projectId);
  else if (isWebsitePath(pathname)) params.set("surface", "website");
  return params.toString();
}

/** A brand row's two drawer reads, on one query: the page's filters, the brand and the surface or project. The 당사 row
 * asks for 당사 on both (own=1): the citation sources sent its label only, and HMG is no Gold brand (renewal audit 7-2). */
export function brandDrillPaths(spStr: string, opts: Parameters<typeof drilldownParams>[1]): { query: string; prompts: string; citations: string } {
  const query = drilldownParams(spStr, opts).toString();
  return { query, prompts: `/api/scope/brand-mention-prompts?${query}`, citations: `/api/scope/brand-citations?${query}` };
}

function useListLoad<T>(path: string | null, key: "prompts" | "domains"): ListState<T> {
  const [state, setState] = useState<ListState<T>>({ status: "loading" });
  useEffect(() => {
    if (!path) return;
    return startListLoad<T>(path, key, setState);
  }, [path, key]);
  return state;
}

/** `fallback`: the row a ranking row past the shell's drawer rows passes (renewal audit 6-1). */
function BrandSheet({
  brand,
  fallback,
  hidden,
  onClose,
  onAnswer,
  onCitationAnswer,
}: {
  brand: string;
  fallback?: RnDrawerBrand;
  hidden: boolean;
  onClose: () => void;
  onAnswer: (p: MentionsPromptLive) => void;
  onCitationAnswer: (p: CitationPromptLive) => void;
}) {
  const { drawer } = useMention();
  const t = useTranslations("renewal.mention");
  const tT = useTranslations("answerAnalysis.mentions.table");
  const tDd = useTranslations("answerAnalysis.mentions.drilldown");
  const tB = useTranslations("answerAnalysis.mentions.breakdown");
  const tType = useTranslations("answerAnalysis.mentions.breakdown.type");
  const locale = useLocale();
  const sp = useSearchParams();
  const pathname = usePathname();
  const projectId = projectIdFromPath(pathname);
  const isWebsite = isWebsitePath(pathname);
  const [tab, setTab] = useState<"prompts" | "citations">("prompts");
  const row = drawer.find((b) => b.brand === brand) ?? fallback;
  const own = row?.own ?? null;
  const spStr = sp.toString();
  const paths = useMemo(() => brandDrillPaths(spStr, { brand, own, isWebsite, projectId }), [spStr, brand, own?.code, own === null, isWebsite, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const promptsPath = paths.prompts;
  const citationsPath = tab === "citations" ? paths.citations : null;
  const prompts = useListLoad<DrillPromptRow>(promptsPath, "prompts");
  const citations = useListLoad<CitationDomainLive>(citationsPath, "domains");
  const types = row?.types ?? null;
  const sent = row?.sentiment ?? null;
  const sentPct = row?.sentimentPct ?? null;
  const rank = row?.rank ?? 0;
  return (
    <RnDrawer
      open={!hidden}
      onClose={onClose}
      closeLabel={t("drawer.close")}
      title={
        <span className="inline-flex items-center gap-2">
          {brand}
          {row?.isTracked ? <RnTag>{t("board.own")}</RnTag> : row?.sibling ? <RnTag>{t("board.sibling")}</RnTag> : null}
        </span>
      }
      subtitle={rank > 0 ? t("drawer.rankLine", { rank }) : undefined}
    >
      {row ? (
        <dl className="m-0 grid grid-cols-4 gap-3 rounded-xl bg-rn-page px-4 py-3">
          {[
            [tT("col.mentions"), numTxt(row.mentions, locale)],
            [tT("col.share"), pctTxt(row.share)],
            [tT("col.position"), posTxt(row.avgPosition)],
            [tT("col.rate"), pctTxt(row.mentionRate)],
          ].map(([l, v]) => (
            <div key={l}>
              <dt className="text-rn-11 text-rn-muted">{l}</dt>
              <dd className="m-0 text-rn-15 font-bold text-rn-ink tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {sent && sentPct ? (
        <div className="mt-4 flex flex-col gap-1.5">
          <h3 className="m-0 text-rn-12 font-bold text-rn-ink-2">{tB("sentimentTitle")}</h3>
          <span className="flex h-2.5 gap-0.5 overflow-hidden rounded">
            {SENTIMENT_KEYS.map((k) => (sent[k] ? <i key={k} className="block h-full" style={{ width: `${sentPct[k]}%`, background: SENTIMENT_COLOR[k] }} /> : null))}
          </span>
          <span className="flex flex-wrap gap-x-3 text-rn-11 text-rn-muted">
            {SENTIMENT_KEYS.map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <i aria-hidden className="size-2 rounded-[2px]" style={{ background: SENTIMENT_COLOR[k] }} />
                {tB(k)} {sentPct[k].toFixed(0)}%
              </span>
            ))}
          </span>
        </div>
      ) : null}
      {types ? (
        <div className="mt-4 flex flex-col gap-1.5">
          <h3 className="m-0 text-rn-12 font-bold text-rn-ink-2">{tB("typesTitle")}</h3>
          <span className="flex flex-wrap gap-1.5">
            {MENTION_TYPE_KEYS.map((k) => (
              <span key={k} className="inline-flex h-6 items-center gap-1.5 rounded-full bg-rn-page px-2.5 text-rn-12 text-rn-ink-2">
                {tType(k)}
                <b className="tabular-nums">{numTxt(types[k], locale)}</b>
              </span>
            ))}
          </span>
        </div>
      ) : null}
      <RnTabs
        className="mt-5"
        label={t("brands.title")}
        value={tab}
        onChange={setTab}
        items={[
          { value: "prompts", label: tDd("tabs.prompts"), count: prompts.status === "ready" ? prompts.list.length : undefined },
          { value: "citations", label: tDd("tabs.citations"), count: citations.status === "ready" && tab === "citations" ? citations.list.length : undefined },
        ]}
      />
      <div className="mt-3">{tab === "prompts" ? <PromptList state={prompts} onAnswer={onAnswer} /> : <CitationList state={citations} detailQuery={paths.query} onAnswer={onCitationAnswer} />}</div>
    </RnDrawer>
  );
}

function ListStatus({ state, loading, error, empty }: { state: ListState<unknown>; loading: string; error: string; empty: string }) {
  if (state.status === "loading") return <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{loading}</p>;
  if (state.status === "error") return <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{error}</p>;
  if (!state.list.length) return <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{empty}</p>;
  return null;
}

export function PromptList({ state, onAnswer }: { state: ListState<DrillPromptRow>; onAnswer: (p: MentionsPromptLive) => void }) {
  const { engineLabel } = useMention();
  const t = useTranslations("renewal.mention.brands");
  const tDd = useTranslations("answerAnalysis.mentions.drilldown");
  const tM = useTranslations("answerAnalysis.mentions.answerModal");
  const tTr = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  const status = <ListStatus state={state} loading={tDd("promptsLoading")} error={tDd("promptsError")} empty={tDd("noPrompts")} />;
  if (state.status !== "ready" || !state.list.length) return status;
  // mentions desc, best rank and the TOP 3 flag come from the route (screen mention/drill-brand-prompts)
  const order = state.orders?.mentions?.desc;
  const list = order ? order.map((i) => state.list[i]) : state.list;
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-rn-11 text-rn-muted">{tM("tableHint")}</p>
      <div className="grid grid-cols-[minmax(0,1fr)_52px_56px_60px] gap-2 border-b border-rn-line pb-1.5 text-rn-11 font-semibold text-rn-muted">
        <span>{tDd("col.prompt")}</span>
        {(
          [
            ["rank", [[t("defLabel"), tDd("colDefinition.rank")]]],
            ["mentions", [[t("defLabel"), tDd("colDefinition.mentions")]]],
            ["share", [[t("defLabel"), tDd("colDefinition.share")], [t("formulaLabel"), tDd("colFormula.share")]]],
          ] satisfies [string, [string, string][]][]
        ).map(([k, items]) => (
          <span key={k} className="inline-flex items-center justify-end gap-1">
            {tDd(`col.${k}`)}
            <InfoTip label={tDd(`col.${k}`)} align="end" items={items} />
          </span>
        ))}
      </div>
      {list.map((p) => {
        const best = p.bestRank ?? null;
        return (
          <button key={p.id} type="button" data-rn-prompt={p.id} onClick={() => onAnswer(p)} className="grid cursor-pointer grid-cols-[minmax(0,1fr)_52px_56px_60px] items-start gap-2 rounded-md border-b border-rn-line py-2 text-left text-rn-12 hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:outline-rn-navy">
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-rn-13 text-rn-ink">
                {p.promptText}
                {p.topRank ? <RnTag className="ml-1.5 align-middle whitespace-nowrap">{tDd("top3Badge")}</RnTag> : null}
              </span>
              <span className="flex flex-wrap gap-1 text-rn-11 text-rn-muted">
                {p.funnelStage ? <span>{p.funnelStage}</span> : null}
                {p.providers.map((e) => (
                  <span key={e} className="rounded bg-rn-page px-1">
                    {engineLabel(e)}
                  </span>
                ))}
              </span>
            </span>
            <span className="text-right text-rn-ink-2 tabular-nums">{best ?? "—"}</span>
            <span className="text-right font-semibold text-rn-ink tabular-nums">{p.mentions}</span>
            <span className="text-right text-rn-ink-2 tabular-nums">{pctTxt(p.share)}</span>
          </button>
        );
      })}
      {state.total !== undefined && state.total > state.list.length ? <p className="m-0 text-rn-11 text-rn-muted">{tTr("truncated", { shown: state.list.length, total: state.total })}</p> : null}
    </div>
  );
}

const CITE_COLS = "grid-cols-[minmax(0,1fr)_56px_52px_56px_60px]";

/** The brand row's citation sources (renewal audit 7-1, the original drawer's domain table): the sources the answers that
 * mention the brand cite, with their share, prompts, coverage and the 당사 mark; a row opens its cited URLs and prompts
 * (the `&skey=` detail, read when the row opens) as the Citation page's domain sheet shows them. */
export function CitationList({ state, detailQuery, onAnswer }: { state: ListState<CitationDomainLive>; detailQuery: string; onAnswer: (p: CitationPromptLive) => void }) {
  const t = useTranslations("renewal.mention.brands");
  const tDd = useTranslations("answerAnalysis.mentions.drilldown");
  const tC = useTranslations("answerAnalysis.citations");
  const tTr = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  const locale = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setOpen(null), [detailQuery]);
  const status = <ListStatus state={state} loading={tDd("citationsLoading")} error={tDd("citationsError")} empty={tDd("noCitations")} />;
  if (state.status !== "ready" || !state.list.length) return status;
  const head: [string, [string, string][] | null][] = [
    ["citations", null],
    ["share", [[t("defLabel"), t("citeShareDef")], [t("formulaLabel"), t("citeShareFormula")]]],
    ["prompts", null],
    ["coverage", [[t("defLabel"), t("citeCoverageDef")], [t("formulaLabel"), t("citeCoverageFormula")]]],
  ];
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-rn-11 text-rn-muted">{t("citeHint")}</p>
      <div className={cx("grid gap-2 border-b border-rn-line pb-1.5 text-rn-11 font-semibold text-rn-muted", CITE_COLS)}>
        <span>{tC("table.col.domain")}</span>
        {head.map(([k, items]) => (
          <span key={k} className="inline-flex items-center justify-end gap-1">
            {tC(`table.col.${k}`)}
            {items ? <InfoTip label={tC(`table.col.${k}`)} align="end" items={items} /> : null}
          </span>
        ))}
      </div>
      <div className="flex flex-col">
        {state.list.map((d) => {
          const key = d.skey ?? d.domain;
          return <CitationRow key={key} row={d} open={open === key} onToggle={() => setOpen((cur) => (cur === key ? null : key))} detailQuery={detailQuery} onAnswer={onAnswer} />;
        })}
      </div>
      {state.total !== undefined && state.total > state.list.length ? <p className="m-0 text-rn-11 text-rn-muted">{tTr("truncated", { shown: numTxt(state.list.length, locale), total: numTxt(state.total, locale) })}</p> : null}
    </div>
  );
}

/** One source row; `open` reads its detail (the route's `&skey=` branch) once, kept while the sheet lives. */
export function CitationRow({ row, open, onToggle, detailQuery, onAnswer }: { row: CitationDomainLive; open: boolean; onToggle: () => void; detailQuery: string; onAnswer: (p: CitationPromptLive) => void }) {
  const t = useTranslations("renewal.mention.brands");
  const tOv = useTranslations("renewal.overview");
  const cat = useCatLabel();
  const locale = useLocale();
  const isWebsite = isWebsitePath(usePathname());
  const detail = useDomainDetail(row.skey ? domainDetailUrl(detailQuery, row.skey) : null, open);
  const panel = `rn-cite-${row.skey ?? row.domain}`;
  return (
    <div className="border-b border-rn-line last:border-0" data-rn-cite={row.domain}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        aria-label={t("citeOpen", { domain: row.domain })}
        onClick={onToggle}
        className={cx("grid w-full cursor-pointer items-start gap-2 rounded-md py-2 text-left text-rn-12 hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:outline-rn-navy", CITE_COLS)}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-rn-13 font-semibold text-rn-ink">
            <ChevronRight aria-hidden className={cx("size-3.5 shrink-0 text-rn-muted transition-transform", open && "rotate-90")} />
            <span className="truncate">{row.domain}</span>
            {row.isOurs ? <RnTag className="shrink-0">{isWebsite ? tOv("ownTag") : "HMG"}</RnTag> : null}
          </span>
          <span className="pl-5 text-rn-11 text-rn-muted">{row.category ? cat(row.category) : "—"}</span>
        </span>
        <span className="text-right font-semibold text-rn-ink tabular-nums">{numTxt(row.citations, locale)}</span>
        <span className="text-right text-rn-ink-2 tabular-nums">{pctTxt(row.share)}</span>
        <span className="text-right text-rn-ink-2 tabular-nums">{numTxt(row.prompts, locale)}</span>
        <span className="text-right text-rn-ink-2 tabular-nums">{pctTxt(row.coverageRate)}</span>
      </button>
      {open ? (
        <div id={panel} className="mb-2 flex flex-col gap-2.5 rounded-lg bg-rn-page px-3 py-3">
          <CitationDetail row={row} detail={detail} onAnswer={onAnswer} />
        </div>
      ) : null}
    </div>
  );
}

/** An opened source row: its cited URLs or its citing prompts (a prompt opens the answers), as the Citation page's
 * domain sheet lists them, behind the original row's loading and failure lines (citation-domain-table DomainRow). */
export function CitationDetail({
  row,
  detail,
  onAnswer,
  initialView = "urls",
}: {
  row: CitationDomainLive;
  detail: ReturnType<typeof useDomainDetail>;
  onAnswer: (p: CitationPromptLive) => void;
  initialView?: "urls" | "prompts";
}) {
  const tCd = useTranslations("renewal.citation.drawer");
  const tDd = useTranslations("answerAnalysis.mentions.drilldown");
  const locale = useLocale();
  const [view, setView] = useState<"urls" | "prompts">(initialView);
  if (detail?.status !== "ready") return <p className="m-0 py-3 text-center text-rn-12 text-rn-muted">{detail?.status === "error" ? tDd("citationsError") : tDd("citationsLoading")}</p>;
  return (
    <>
      <RnSegmented
        label={tCd("tabs")}
        value={view}
        onChange={setView}
        items={[
          { value: "urls", label: `${tCd("urls")} ${numTxt(detail.urlTotal ?? detail.urls.length, locale)}` },
          { value: "prompts", label: `${tCd("prompts")} ${numTxt(detail.promptTotal ?? detail.promptList.length, locale)}` },
        ]}
      />
      {view === "urls" ? (
        <DomainUrlList row={row} urls={detail.urls} total={detail.urlTotal} />
      ) : (
        <DomainPromptList row={row} prompts={detail.promptList} total={detail.promptTotal} answersCap={DETAIL_ANSWERS_CAP} onAnswer={onAnswer} share={false} />
      )}
    </>
  );
}

/** A sentiment or mention type (renewal audit 7-3: the type rows of the own view open their prompts, as the original
 * type breakdown did) of the signal drawer. */
export function isMentionType(signal: DrawerSignal): signal is (typeof MENTION_TYPE_KEYS)[number] {
  return (MENTION_TYPE_KEYS as readonly string[]).includes(signal);
}

function SignalSheet({ signal, label, hidden, onClose, onAnswer }: { signal: DrawerSignal; label: string; hidden: boolean; onClose: () => void; onAnswer: (p: MentionsPromptLive) => void }) {
  const t = useTranslations("renewal.mention");
  const tS = useTranslations("answerAnalysis.mentions.signalDrilldown");
  const sp = useSearchParams();
  const pathname = usePathname();
  const [state, setState] = useState<SignalPromptsState>({ status: "loading" });
  const query = signalPromptsQuery(sp.toString(), signal, pathname);
  useEffect(() => {
    setState({ status: "loading" });
    const ctrl = new AbortController();
    fetch(`/api/scope/signal-prompts?${query}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { prompts?: MentionsPromptLive[]; total?: unknown }) => setState(readSignalReply(d)))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setState({ status: "error" });
      });
    return () => ctrl.abort();
  }, [query]);
  const tTr = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  return (
    <RnDrawer open={!hidden} onClose={onClose} closeLabel={t("drawer.close")} title={tS("title", { signal: label })} subtitle={tS("hint")}>
      {state.status === "loading" ? (
        <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{tS("loading")}</p>
      ) : state.status === "error" ? (
        <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{tS("error")}</p>
      ) : !state.list.length ? (
        <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{tS("empty")}</p>
      ) : (
        <div className="flex flex-col">
          {state.list.map((p) => (
            <button key={p.id} type="button" data-rn-prompt={p.id} onClick={() => onAnswer(p)} className="flex cursor-pointer flex-col gap-1 rounded-md border-b border-rn-line px-1 py-2.5 text-left hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:outline-rn-navy">
              <span className="text-rn-13 text-rn-ink">{p.promptText}</span>
              <span className="flex flex-wrap gap-2 text-rn-11 text-rn-muted">
                <span>{tS("signalCount", { count: p.mentions })}</span>
                <span>{tS("engines", { count: p.providers.length })}</span>
                {p.funnelStage ? <span>{p.funnelStage}</span> : null}
              </span>
            </button>
          ))}
          {state.total !== undefined && state.total > state.list.length ? <p className="m-0 pt-2 text-rn-11 text-rn-muted">{tTr("truncated", { shown: state.list.length, total: state.total })}</p> : null}
        </div>
      )}
    </RnDrawer>
  );
}

