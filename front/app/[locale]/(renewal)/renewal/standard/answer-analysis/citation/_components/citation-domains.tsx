"use client";

import { use, useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Globe, MessageSquareText } from "lucide-react";
import {
  RnBasisChip,
  RnButton,
  RnCardHead,
  RnDrawer,
  RnEmpty,
  RnSearchField,
  RnSelect,
  RnTabs,
  RnTag,
  cx,
} from "@/components/renewal-ui";
import { AnswerModal } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/answer-modal";
import { TableStatus, useDomainDetail, useServerDomainTable } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/citations-view";
import { citationDrilldownEmptyKey, domainDetailUrl, type DomainDetailView, type DomainTableSortKey } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { displayCitationUrl } from "@/lib/url-display";
import { countryName } from "@/lib/geo-catalog";
import type { CitationDomainLive, CitationPromptLive } from "@/lib/scope/result-adapter";
import type { RnCitationVm } from "./citation-input";
import { CONTEXT_COLOR, MOVER_COLORS, OWN_COLOR, CitationCardActions, engineLabel, useCatLabel, useCitation } from "./citation-context";
import { DegradedNote, InfoTip, TwinTable, useDegradedText } from "../../mention/_components/mention-kit";
import { numTxt, pctTxt, slotLabel } from "../../mention/_components/mention-context";

/** Answers a prompt of the domain sheet opens: the reader's cap (gold_reader/drilldown.py `domain`, most citations
 * first). The sheet says so, since the modal shows them without a "more" line. */
const DETAIL_ANSWERS_CAP = 8;

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(Math.round(n)));

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

// ── 주별 도메인 인용 순위 (emphasis bump) ────────────────────────────────────────

export function DomainBumpCard() {
  const { input, live, tables } = useCitation();
  const t = useTranslations("renewal.citation.bump");
  const tA = useTranslations("answerAnalysis");
  const dg = useDegradedText();
  const sections = use(input.sectionDegraded);
  const d = (use(input.rn) as RnCitationVm).bump;
  const tableOn = tables.has("bump");
  const measured = d ? d.measured : 0;
  const csv = () => ({
    name: "citation-weekly-domain-rank",
    rows: [["", ...(d?.x ?? []).flatMap((x) => [`${x} ${t("colRank")}`, `${x} ${t("colCitations")}`])], ...(d?.series ?? []).map((s) => [s.key, ...s.ranks.flatMap((r, i) => [r, s.values[i]])])],
  });
  return (
    <>
      <RnCardHead
        title={t("title")}
        info={<InfoTip label={t("infoLabel")} items={[[t("infoLabel"), t("info")]]} />}
        chips={d ? <RnBasisChip>{t("chip", { n: d.series.length, weeks: measured })}</RnBasisChip> : null}
        actions={<CitationCardActions tableId="bump" section="sec-dom" csv={csv} />}
      />
      <div className="px-6 pb-5 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3.5">
        {!live.trend ? (
          sections?.trend ? <DegradedNote>{dg.all}</DegradedNote> : <RnEmpty>{tA("pending")}</RnEmpty>
        ) : !d || measured < 2 ? (
          <RnEmpty>{t("needTwo")}</RnEmpty>
        ) : tableOn ? (
          <TwinTable head={[t("colDomain"), ...d.x.map(slotLabel)]} rows={d.series.map((s) => [s.key, ...s.ranks.map((r, i) => (r == null ? "—" : t("twin", { rank: r, n: numTxt(s.values[i]) })))])} />
        ) : (
          <BumpChart d={d} />
        )}
      </div>
    </>
  );
}

const ROW = 24;
const LABEL_W = 236;

type BumpView = NonNullable<RnCitationVm["bump"]>;

function BumpChart({ d }: { d: BumpView }) {
  const { lit, hover, live, openDomain } = useCitation();
  const t = useTranslations("renewal.citation.bump");
  const [ref, width] = useWidth<HTMLDivElement>();
  const movers = new Map(d.movers.map((m, i) => [m.key, i]));
  const colorOf = (key: string, own: boolean) => (own ? OWN_COLOR : movers.has(key) ? MOVER_COLORS[movers.get(key)!] : CONTEXT_COLOR);
  const n = d.series.length;
  const top = 14;
  const h = n * ROW + top + 30;
  const left = 30;
  const plotW = Math.max(120, width - left - LABEL_W);
  const xs = d.x.map((_, i) => left + (d.x.length > 1 ? (i / (d.x.length - 1)) * plotW : plotW / 2));
  const y = (rank: number) => top + (rank - 0.5) * ROW;
  const keys = d.series.map((s) => s.key);
  const fading = lit != null && keys.includes(lit);
  const emph = (s: { key: string; own: boolean }) => s.own || movers.has(s.key);
  // draw order (context first, then movers, own last) from the screen
  const order = d.drawOrder.map((i) => d.series[i]);
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
  const open = (s: BumpView["series"][number]) => {
    const row = s.domainIndex >= 0 ? live.domains[s.domainIndex] : undefined;
    if (row) openDomain(row);
  };
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-rn-12 text-rn-ink-2" data-rn-bumplg="">
        {d.series.some((s) => s.own) ? (
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: OWN_COLOR }} />
            {t("legendOwn")}
          </span>
        ) : null}
        {d.movers.map((m, i) => (
          <span key={m.key} data-rn-b={m.key} onPointerEnter={() => hover(m.key)} onPointerLeave={() => hover(null)} className={cx("inline-flex items-center gap-1.5", lit === m.key && "font-bold text-rn-ink")}>
            <i aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: MOVER_COLORS[i] }} />
            {m.key}
            <b className={m.move > 0 ? "text-rn-up-ink" : "text-rn-danger-ink"}>
              {m.move > 0 ? "▲" : "▼"}
              {Math.abs(m.move)}
            </b>
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-rn-muted">
          <i aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ background: CONTEXT_COLOR }} />
          {t("legendRest")}
        </span>
      </div>
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
                {i === 0 || i === xs.length - 1 || xs.length <= 8 || i % 2 === 0 ? (
                  <text x={x} y={top + n * ROW + 16} textAnchor="middle" fontSize={11} fill="var(--color-rn-muted)">
                    {slotLabel(d.x[i])}
                  </text>
                ) : null}
              </g>
            ))}
            {order.map((s) => {
              const color = colorOf(s.key, s.own);
              const on = emph(s);
              const dim = fading && lit !== s.key;
              return (
                <g key={s.key} data-rn-b={s.key} data-rn-series={s.own ? "own" : on ? "mover" : "ctx"} opacity={dim ? 0.15 : 1} onPointerEnter={() => hover(s.key)} onClick={() => open(s)} className="cursor-pointer">
                  <path d={path(s.ranks)} fill="none" stroke={color} strokeWidth={s.own ? 3 : on ? 2.4 : 1.5} strokeLinecap="round" />
                  {s.ranks.map((r, i) =>
                    r == null ? null : (
                      <circle key={i} cx={xs[i]} cy={y(r)} r={4} fill={color} stroke="#fff" strokeWidth={1.5}>
                        <title>{t("tip", { domain: s.key, x: slotLabel(d.x[i]), rank: r, n: numTxt(s.values[i]) })}</title>
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
              const on = emph(s);
              const dim = fading && lit !== s.key;
              const x0 = left + plotW + 18;
              return (
                <g key={`l-${s.key}`} data-rn-b={s.key} opacity={dim ? 0.3 : 1} onPointerEnter={() => hover(s.key)} onClick={() => open(s)} className="cursor-pointer">
                  <text x={x0} y={y(r1) + 4} fontSize={11} fill="var(--color-rn-muted)">
                    {r1}
                  </text>
                  <text x={x0 + 20} y={y(r1) + 4} fontSize={12} fontWeight={on ? 700 : 500} fill={s.own ? "var(--color-rn-navy)" : on ? "var(--color-rn-ink)" : "var(--color-rn-ink-2)"}>
                    {s.key.length > 18 ? `${s.key.slice(0, 17)}…` : s.key}
                    {s.key.length > 18 ? <title>{s.key}</title> : null}
                  </text>
                  <text x={x0 + 184} y={y(r1) + 4} fontSize={11} textAnchor="end" fill="var(--color-rn-ink-2)" className="tabular-nums">
                    {s.values[d.last] == null ? "—" : fmtK(s.values[d.last]!)}
                  </text>
                  {move ? (
                    <text x={x0 + 192} y={y(r1) + 4} fontSize={11} fontWeight={700} fill={move > 0 ? "var(--color-rn-up-ink)" : "var(--color-rn-danger-ink)"}>
                      {move > 0 ? "▲" : "▼"}
                      {Math.abs(move)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : (
          <div style={{ height: h }} />
        )}
      </div>
    </div>
  );
}

// ── 도메인 인용 순위 (상위 100): one table ─────────────────────────────────────

const LIMIT = 100;
const FIRST = 20;
type SortKey = DomainTableSortKey;

export function DomainTableCard() {
  const { input, lit, hover, openDomain } = useCitation();
  const t = useTranslations("renewal.citation.table");
  const tC = useTranslations("answerAnalysis.citations.table");
  const cat = useCatLabel();
  const source = use(input.tableSource);
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q);
  const [sortKey, setSortKey] = useState<SortKey>("citations");
  const [asc, setAsc] = useState(false);
  const [category, setCategory] = useState("");
  const [all, setAll] = useState(false);
  // the first rows after the competitor pick (# = the rank after the pick) and their category
  // views come with the screen; search and sort run on the server over every source (BG-21)
  const model = (use(input.rn) as RnCitationVm).table;
  const table = useServerDomainTable({ source, initial: model.rows, initialViews: model.views, q: deferred, sortKey, asc, pageSize: LIMIT });
  const base = (table.active ? table.rows : model.rows).slice(0, LIMIT);
  // the category select: the server's row list and bar scales per category (first 100 rows)
  const view = (table.active ? table.views : model.views)?.[category];
  const rows = view ? view.idx.map((i) => base[i]) : category ? [] : base;
  // a search runs over every source: its count is the server's, not the first page's (2026-10-29 metric review R4)
  const matched = q.trim() && !category && table.active && table.total != null ? table.total : rows.length;
  const shown = all ? rows : rows.slice(0, FIRST);
  const maxCit = view?.maxCit ?? 1;
  const maxCov = view?.maxCov ?? 1;
  const cats = model.categories;
  const clickHeader = (k: SortKey) => {
    if (sortKey === k) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(k === "domain");
    }
  };
  const csv = () => ({
    name: "citation-domains",
    rows: [[tC("col.rank"), tC("col.domain"), tC("col.category"), tC("col.citations"), tC("col.share"), tC("col.prompts"), tC("col.coverage")], ...rows.map((r) => [r.no, r.domain, r.category ? cat(r.category) : "", r.citations, r.share.toFixed(1), r.prompts, r.coverageRate.toFixed(1)])],
  });
  const th = (k: SortKey | null, label: string, right: boolean, info?: { def: string; formula: string }) => (
    <th scope="col" className={cx("px-2.5 py-2 text-rn-12 font-semibold whitespace-nowrap text-rn-muted", right ? "text-right" : "text-left")} aria-sort={k && sortKey === k ? (asc ? "ascending" : "descending") : undefined}>
      <span className={cx("inline-flex items-center gap-1", right && "justify-end")}>
        {k ? (
          <button type="button" data-rn-sort={k} onClick={() => clickHeader(k)} className="inline-flex cursor-pointer items-center gap-1 hover:text-rn-ink">
            {label}
            {sortKey === k ? asc ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden /> : <ArrowUpDown className="size-3 opacity-40" aria-hidden />}
          </button>
        ) : (
          label
        )}
        {info ? <InfoTip label={label} align={right ? "end" : undefined} items={[[t("defLabel"), info.def], [t("formulaLabel"), info.formula]]} /> : null}
      </span>
    </th>
  );
  return (
    <>
      <RnCardHead
        title={t("title")}
        info={<InfoTip label={t("infoLabel")} items={[[t("infoLabel"), t("info")]]} />}
        chips={<RnBasisChip>{t("chip", { n: LIMIT })}</RnBasisChip>}
        actions={<CitationCardActions section="sec-dom" csv={csv} />}
      />
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-6 pb-3 [.rn-dense_&]:px-4.5">
        <RnSearchField className="w-[240px]" value={q} onChange={setQ} placeholder={t("search")} label={t("search")} />
        <label className="inline-flex items-center gap-2 text-rn-12 font-semibold text-rn-ink-2">
          {t("category")}
          <RnSelect label={t("categoryLabel")} value={category} onChange={(e) => setCategory(e.target.value)} options={[{ value: "", label: t("categoryAll") }, ...cats.map((c) => ({ value: c, label: cat(c) }))]} data-rn-catsel="" />
        </label>
        {q.trim() || category ? <span className="text-rn-12 text-rn-muted">{matched > rows.length ? t("matchesTop", { n: matched, shown: rows.length }) : t("matches", { n: matched })}</span> : null}
      </div>
      <div className="overflow-x-auto" onPointerLeave={() => hover(null)}>
        <table className="w-full min-w-[720px] border-collapse text-rn-13" data-rn-dtable="">
          <colgroup>
            <col className="w-12" />
            <col />
            <col className="w-[120px]" />
            <col className="w-[15%]" />
            <col className="w-[64px]" />
            <col className="w-[72px]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead className="border-y border-rn-line bg-rn-page">
            <tr>
              {th(null, tC("col.rank"), false)}
              {th("domain", tC("col.domain"), false)}
              {th(null, tC("col.category"), false)}
              {th("citations", tC("col.citations"), true, { def: tC("colDefinition.citations"), formula: tC("colFormula.citations") })}
              {th("share", tC("col.share"), true, { def: tC("colDefinition.share"), formula: tC("colFormula.share") })}
              {th("prompts", tC("col.prompts"), true)}
              {th("coverageRate", tC("col.coverage"), true, { def: tC("colDefinition.coverage"), formula: tC("colFormula.coverage") })}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-7 text-center text-rn-13 text-rn-muted">
                  <TableStatus table={table} empty={tC("empty")} />
                </td>
              </tr>
            ) : (
              shown.map((r) => (
                <tr
                  key={r.domain}
                  data-rn-b={r.domain}
                  data-rn-domain={r.domain}
                  tabIndex={0}
                  onPointerEnter={() => hover(r.domain)}
                  onClick={() => openDomain(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openDomain(r);
                    }
                  }}
                  className={cx(
                    "cursor-pointer border-b border-rn-line hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy",
                    r.isOurs && "shadow-[inset_3px_0_0_var(--color-rn-navy)]",
                    lit === r.domain && "bg-rn-navy-25",
                  )}
                >
                  <td className="px-2.5 py-2.5 text-right text-rn-muted tabular-nums">{r.no}</td>
                  <td className="px-2.5 py-2.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <b className={cx("truncate font-semibold", r.isOurs ? "text-rn-navy" : "text-rn-ink")}>{r.domain}</b>
                      {r.isOurs ? <RnTag className="shrink-0">HMG</RnTag> : null}
                    </span>
                  </td>
                  <td className="truncate px-2.5 py-2.5 text-rn-12 text-rn-ink-2">{r.category ? cat(r.category) : "—"}</td>
                  <td className="px-2.5 py-2.5">
                    <span className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-2">
                      <b className="text-right font-semibold text-rn-ink tabular-nums">{numTxt(r.citations)}</b>
                      <span className="h-2 rounded-full bg-rn-inset">
                        <i className="block h-full rounded-full" style={{ width: `${(100 * r.citations) / maxCit}%`, background: r.isOurs ? "var(--color-rn-navy)" : "var(--color-rn-navy-300)" }} />
                      </span>
                    </span>
                  </td>
                  <td className="px-2.5 py-2.5 text-right text-rn-ink-2 tabular-nums">{pctTxt(r.share)}</td>
                  <td className="px-2.5 py-2.5 text-right text-rn-ink-2 tabular-nums">{numTxt(r.prompts)}</td>
                  <td className="px-2.5 py-2.5">
                    <span className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-2">
                      <b className="text-right font-semibold text-rn-ink tabular-nums">{pctTxt(r.coverageRate)}</b>
                      <span className="h-2 rounded-full bg-rn-inset">
                        <i className="block h-full rounded-full" style={{ width: `${(100 * r.coverageRate) / maxCov}%`, background: r.isOurs ? "var(--color-rn-navy)" : "var(--color-rn-navy-300)" }} />
                      </span>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {rows.length > FIRST ? (
        <div className="flex justify-center py-3.5">
          <RnButton onClick={() => setAll((v) => !v)} data-rn-dall="">
            {all ? t("showFirst", { n: FIRST }) : t("showAll", { n: rows.length })}
          </RnButton>
        </div>
      ) : (
        <div className="h-3" />
      )}
    </>
  );
}

// ── 도메인 상세 (drawer) → the original answer modal ──────────────────────────

export function DomainDrawer({ row, onClose }: { row: CitationDomainLive | null; onClose: () => void }) {
  const [answer, setAnswer] = useState<CitationPromptLive | null>(null);
  // the sheet comes back one task after the modal closes, so the Escape that closed the modal
  // does not reach the sheet as well (same as the renewal Mention drawer)
  const [sheetHidden, setSheetHidden] = useState(false);
  useEffect(() => {
    setAnswer(null);
    setSheetHidden(false);
  }, [row]);
  const openAnswer = useCallback((p: CitationPromptLive) => {
    setSheetHidden(true);
    setAnswer(p);
  }, []);
  const closeAnswer = useCallback((o: boolean) => {
    if (o) return;
    setAnswer(null);
    setTimeout(() => setSheetHidden(false), 0);
  }, []);
  return (
    <>
      {row ? <DomainSheet row={row} hidden={sheetHidden} onClose={onClose} onAnswer={openAnswer} /> : null}
      <AnswerModal brand={row?.domain ?? ""} variant="citation" promptText={answer?.promptText ?? ""} answers={answer?.answers ?? []} open={answer !== null} onOpenChange={closeAnswer} />
    </>
  );
}

function DomainSheet({ row, hidden, onClose, onAnswer }: { row: CitationDomainLive; hidden: boolean; onClose: () => void; onAnswer: (p: CitationPromptLive) => void }) {
  const { input } = useCitation();
  const t = useTranslations("renewal.citation.drawer");
  const tC = useTranslations("answerAnalysis.citations");
  const cat = useCatLabel();
  const locale = useLocale();
  const source = use(input.tableSource);
  const [tab, setTab] = useState<"urls" | "prompts">("urls");
  useEffect(() => setTab("urls"), [row]);
  // api rows load their drilldown once when opened (3.5 #6); legacy rows carry it inline
  const lazy = Boolean(row.skey && source);
  const detail = useDomainDetail(lazy ? domainDetailUrl(source!.query, row.skey!) : null, !hidden);
  const loaded = detail?.status === "ready" ? detail : null;
  const urls = lazy ? (loaded?.urls ?? []) : row.urls;
  const prompts = lazy ? (loaded?.promptList ?? []) : row.promptList;
  const pending = lazy && detail?.status !== "ready" ? (detail?.status === "error" ? tC("drilldown.loadFailed") : tC("drilldown.loading")) : null;
  return (
    <RnDrawer
      open={!hidden}
      onClose={onClose}
      closeLabel={t("close")}
      title={
        <span className="inline-flex items-center gap-2">
          {row.domain}
          {row.isOurs ? <RnTag>HMG</RnTag> : null}
        </span>
      }
      subtitle={row.category ? cat(row.category) : undefined}
    >
      <dl className="m-0 grid grid-cols-4 gap-3 rounded-xl bg-rn-page px-4 py-3">
        {[
          [tC("table.col.citations"), numTxt(row.citations, locale)],
          [tC("table.col.share"), pctTxt(row.share)],
          [tC("table.col.prompts"), numTxt(row.prompts, locale)],
          [tC("table.col.coverage"), pctTxt(row.coverageRate)],
        ].map(([l, v]) => (
          <div key={l}>
            <dt className="text-rn-11 text-rn-muted">{l}</dt>
            <dd className="m-0 text-rn-15 font-bold text-rn-ink tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <RnTabs
        className="mt-5"
        label={t("tabs")}
        value={tab}
        onChange={setTab}
        items={[
          // the domain's URLs and prompts (the lists below hold the first 100 and 12 of them)
          { value: "urls", label: t("urls"), count: pending ? undefined : numTxt(loaded?.urlTotal ?? urls.length, locale) },
          { value: "prompts", label: t("prompts"), count: pending ? undefined : numTxt(loaded?.promptTotal ?? prompts.length, locale) },
        ]}
      />
      <div className="mt-3" data-rn-dpanel={tab}>
        {pending ? (
          <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{pending}</p>
        ) : tab === "urls" ? (
          <UrlList row={row} urls={urls} total={loaded?.urlTotal} />
        ) : (
          <PromptList row={row} prompts={prompts} total={loaded?.promptTotal} answersCap={lazy ? DETAIL_ANSWERS_CAP : null} onAnswer={onAnswer} />
        )}
      </div>
    </RnDrawer>
  );
}

function UrlList({ row, urls, total }: { row: CitationDomainLive; urls: CitationDomainLive["urls"]; total?: number }) {
  const tC = useTranslations("answerAnalysis.citations");
  const locale = useLocale();
  if (!urls.length) return <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{tC(citationDrilldownEmptyKey(row, "urls"))}</p>;
  return (
    <div className="flex flex-col gap-2">
      {urls.map((u) => (
        <div key={u.url} className="flex flex-col gap-1 rounded-lg border border-rn-line px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <span className="line-clamp-2 min-w-0 text-rn-13 font-semibold text-rn-ink">{u.title || displayCitationUrl(u.url)}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {u.country ? (
                <span className="inline-flex items-center gap-1 rounded bg-rn-navy-25 px-1.5 py-0.5 text-rn-11 font-semibold text-rn-navy" title={tC("siteCountry")}>
                  <Globe className="size-2.5" aria-hidden />
                  {countryName(u.country, locale)}
                </span>
              ) : null}
              <span className="rounded bg-rn-page px-1.5 py-0.5 text-rn-11 text-rn-muted">{engineLabel(u.aiProvider)}</span>
            </span>
          </div>
          <a href={u.url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-1 text-rn-12 break-all text-rn-navy hover:underline">
            <span className="min-w-0">{displayCitationUrl(u.url)}</span>
            <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden />
          </a>
          <span className="text-rn-11 text-rn-muted">
            {u.promptText ? `“${u.promptText}” · ` : ""}
            {numTxt(u.count, locale)} {tC("drilldown.cites")}
          </span>
        </div>
      ))}
      <CutNote shown={urls.length} total={total} />
    </div>
  );
}

function PromptList({
  row,
  prompts,
  total,
  answersCap,
  onAnswer,
}: {
  row: CitationDomainLive;
  prompts: DomainDetailView["promptList"];
  total?: number;
  answersCap: number | null;
  onAnswer: (p: CitationPromptLive) => void;
}) {
  const tC = useTranslations("answerAnalysis.citations");
  const tMd = useTranslations("answerAnalysis.mentions.drilldown");
  const t = useTranslations("renewal.citation.drawer");
  const locale = useLocale();
  if (!prompts.length) return <p className="m-0 rounded-lg bg-rn-page px-4 py-6 text-center text-rn-12 text-rn-muted">{tC(citationDrilldownEmptyKey(row, "prompts"))}</p>;
  // the server's order (citations desc) and each prompt's share of the source's citations
  const list = prompts;
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-rn-11 text-rn-muted">
        {tC("v2.drilldownTabs.promptsCaption")}
        {answersCap != null ? ` ${t("answersCap", { n: answersCap })}` : ""}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_56px_60px] gap-2 border-b border-rn-line pb-1.5 text-rn-11 font-semibold text-rn-muted">
        <span>{tMd("col.prompt")}</span>
        <span className="text-right">{tC("table.col.citations")}</span>
        <span className="text-right">{tC("table.col.share")}</span>
      </div>
      {list.map((p) => {
        const has = (p.answers?.length ?? 0) > 0;
        return (
          <button
            key={p.id}
            type="button"
            data-rn-prompt={p.id}
            disabled={!has}
            title={has ? undefined : t("noAnswer")}
            onClick={() => onAnswer(p)}
            className="grid cursor-pointer grid-cols-[minmax(0,1fr)_56px_60px] items-start gap-2 rounded-md border-b border-rn-line py-2 text-left text-rn-12 hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:outline-rn-navy disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="inline-flex items-start gap-1.5 text-rn-13 text-rn-ink">
                {has ? <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-rn-navy" aria-hidden /> : null}
                {p.promptText}
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
            <span className="text-right font-semibold text-rn-ink tabular-nums">{numTxt(p.citations, locale)}</span>
            <span className="text-right text-rn-ink-2 tabular-nums">{p.share != null ? pctTxt(p.share) : "—"}</span>
          </button>
        );
      })}
      <CutNote shown={prompts.length} total={total} />
    </div>
  );
}

/** "25,283개 중 100개 표시" under a list the reader cut (the shared TruncatedNote's copy, numbers grouped like the
 * sheet's other counts); nothing when the list is whole. */
function CutNote({ shown, total }: { shown: number; total?: number }) {
  const t = useTranslations("answerAnalysis.mentions.kpi.overview.unmeasuredDialog");
  const locale = useLocale();
  if (total === undefined || total <= shown) return null;
  return <p className="m-0 text-rn-11 text-rn-muted">{t("truncated", { shown: numTxt(shown, locale), total: numTxt(total, locale) })}</p>;
}
