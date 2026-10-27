"use client";

// 페이지 진단 tab: the work list (rows below half of the baseline by 부족분), the 검색 노출 × AI 크롤
// scatter with the baseline, the changes against the previous period, and every page in one table
// (the original's quadrant as a filter; column orders come precomputed from the screen).

import { useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpRight, Search } from "lucide-react";
import { RnBasisChip, RnButton, RnCard, RnCardHead, RnSegmented, cx } from "@/components/renewal-ui";
import type { VisBand, VisOrderKey, VisQuad, VisRow, VisView } from "../_data/screen-types";
import { CONTEXT_GREY, engineColor, useVisFmt } from "./vis-context";
import { VisLogScatter } from "./vis-charts";
import { DefTip, NoteTip, range } from "./vis-body";

export const BAND_COLORS: Record<VisBand, string> = { none: "#c4482f", low: "#eb6834", mid: "#9db5d3", high: "#002c5f" };
const BANDS: VisBand[] = ["none", "low", "mid", "high"];
const QUAD_COLORS: Record<VisQuad, string> = { seo_only: "#eb6834", crawl_only: "#6250d6", both: "#002c5f", neither: CONTEXT_GREY };
const QUADS: VisQuad[] = ["seo_only", "crawl_only", "both", "neither"];
const WORK_ROWS = 15;
const TABLE_ROWS = 20;

function Prio({ p }: { p: number | null }) {
  return (
    <span className={cx("grid size-[22px] place-items-center rounded-full text-rn-11 font-bold", p === 1 ? "bg-rn-navy-50 text-rn-navy" : p === 2 ? "bg-rn-inset text-rn-ink-2" : "bg-rn-page text-rn-muted")}>
      {p ?? "–"}
    </span>
  );
}

function Ago({ r, stale }: { r: VisRow; stale: number }) {
  const t = useTranslations("renewal.visibility.ago");
  if (r.ai == null) return <span className="text-rn-12 text-rn-muted">—</span>;
  if (r.ago == null) return <span className="text-rn-12 font-bold whitespace-nowrap text-[#c4482f]">{t("never")}</span>;
  return <span className={cx("text-rn-12 whitespace-nowrap", r.ago >= stale ? "font-bold text-[#b4501f]" : "text-rn-ink-2")}>{r.ago === 0 ? t("today") : t("days", { n: r.ago })}</span>;
}

function EngineDots({ r, view }: { r: VisRow; view: VisView }) {
  const fmt = useVisFmt(view);
  const t = useTranslations("renewal.visibility.engine");
  return (
    <span className="inline-flex gap-1">
      {view.engines.map((e, i) => {
        const on = r.eng[i] > 0;
        return (
          <i key={e.engine} title={`${fmt.engine(e.engine)} ${on ? t("hits", { n: fmt.n(r.eng[i]) }) : t("notRead")}`}
            className={cx("inline-block size-[9px] rounded-full", on ? "" : "shadow-[inset_0_0_0_1.5px_var(--color-rn-line-2)]")} style={on ? { background: engineColor(i) } : undefined} />
        );
      })}
    </span>
  );
}

function PageCell({ r, view, link }: { r: VisRow; view: VisView; link?: boolean }) {
  const fmt = useVisFmt(view);
  return (
    <span className="flex min-w-0 flex-col gap-px">
      <b className="truncate font-semibold" title={r.title ?? undefined}>{fmt.page(r)}</b>
      {link && r.url ? (
        <a href={r.url} target="_blank" rel="noreferrer" title={r.url} className="group/u inline-flex min-w-0 items-center gap-0.5 text-rn-11 text-rn-muted hover:text-rn-navy hover:underline">
          <span className="truncate">{r.path}</span>
          <ArrowUpRight className="size-3 shrink-0 opacity-0 group-hover/u:opacity-100" aria-hidden />
        </a>
      ) : (
        <span className="truncate text-rn-11 text-rn-muted">{fmt.site(r)} · {r.path}</span>
      )}
    </span>
  );
}

const HEAD = "min-h-[34px] border-y border-rn-line text-rn-12 font-semibold whitespace-nowrap text-rn-muted";
const ROW = "border-b border-rn-line text-rn-13 hover:bg-rn-navy-25";

function WorkCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.work");
  const fmt = useVisFmt(view);
  const [all, setAll] = useState(false);
  const ids = all ? view.work.all : view.work.p12;
  const rows = ids.slice(0, WORK_ROWS).map((i) => view.rows[i]);
  const max = Math.max(1, ...rows.map((r) => r.exp ?? 0));
  const grid = "grid grid-cols-[22px_30px_minmax(150px,2fr)_84px_minmax(130px,1.7fr)_56px_52px_74px_62px] items-center gap-2.5 px-6 [.rn-dense_&]:px-4.5 @max-[900px]/rnpage:grid-cols-[22px_30px_minmax(140px,2fr)_78px_minmax(120px,1.6fr)_52px_70px] @max-[900px]/rnpage:[&>*:nth-child(7)]:hidden @max-[900px]/rnpage:[&>*:nth-child(9)]:hidden";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead
        title={t("title")}
        info={<DefTip k="exp" />}
        chips={<RnBasisChip>{t("chip", { rate: fmt.rate(view.expectedRate) })}</RnBasisChip>}
        controls={
          <button type="button" role="switch" aria-checked={all} onClick={() => setAll(!all)} className="inline-flex cursor-pointer items-center gap-2 text-rn-12 font-semibold text-rn-ink-2">
            <i aria-hidden className={cx("relative h-[18px] w-[30px] rounded-full transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-3.5 after:rounded-full after:bg-white after:shadow-rn-1 after:transition-transform", all ? "bg-rn-navy after:translate-x-3" : "bg-rn-line-2")} />
            {t("includeP3")}
          </button>
        }
        sub={t("sub")}
      />
      <div role="row" className={cx(grid, HEAD)}>
        <span>#</span>
        <span>{t("cols.prio")}</span>
        <span>{t("cols.page")}</span>
        <span className="justify-self-end">{t("cols.seo")}</span>
        <span>{t("cols.ai")}</span>
        <span className="justify-self-end">{t("cols.ach")}</span>
        <span>{t("cols.read")}</span>
        <span>{t("cols.ago")}</span>
        <span>{t("cols.engines")}</span>
      </div>
      <div role="list">
        {rows.length ? (
          rows.map((r, i) => (
            <div key={r.id} role="listitem" className={cx(grid, ROW, "min-h-12 [.rn-dense_&]:min-h-[38px]")}>
              <span className="text-rn-12 text-rn-muted tabular-nums">{i + 1}</span>
              <Prio p={r.prio} />
              <PageCell r={r} view={view} />
              <span className="justify-self-end tabular-nums">{fmt.n(r.seo)}</span>
              <span className="grid min-w-0 grid-cols-[minmax(40px,1fr)_auto] items-center gap-2" title={t("tip", { ai: fmt.n(r.ai), exp: fmt.n(r.exp), short: fmt.n(r.short) })}>
                <span className="relative h-2.5 rounded-sm bg-rn-page">
                  <i className="absolute inset-y-0 left-0 rounded-sm bg-rn-navy" style={{ width: `${((r.ai ?? 0) / max) * 100}%` }} />
                  <i className="absolute -inset-y-[3px] w-0.5 -translate-x-1/2 rounded-sm bg-rn-ink" style={{ left: `${((r.exp ?? 0) / max) * 100}%` }} />
                </span>
                <span className="text-rn-12 whitespace-nowrap text-rn-ink-2 tabular-nums">{t("actualOf", { ai: fmt.n(r.ai), exp: fmt.n(r.exp) })}</span>
              </span>
              <span className={cx("justify-self-end font-bold tabular-nums", r.band === "none" ? "text-[#c4482f]" : "text-[#b4501f]")}>{r.ach == null ? "—" : fmt.pct(r.ach * 100, 0)}</span>
              <span className="tabular-nums">{fmt.pct(r.read == null ? null : r.read * 100, 0)}</span>
              <Ago r={r} stale={view.staleDays} />
              <EngineDots r={r} view={view} />
            </div>
          ))
        ) : (
          <p className="m-4 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("empty")}</p>
        )}
      </div>
      {ids.length > WORK_ROWS ? <p className="m-0 border-t border-rn-line px-6 py-2.5 text-rn-11 text-rn-muted">{t("more", { n: ids.length })}</p> : null}
    </RnCard>
  );
}

function GapCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.gap");
  const tb = useTranslations("renewal.visibility.bands");
  const fmt = useVisFmt(view);
  const dots = useMemo(
    () =>
      view.rows
        .filter((r) => r.band != null)
        .map((r) => ({
          key: String(r.id),
          seo: r.seo ?? 0,
          ai: r.ai ?? 0,
          color: BAND_COLORS[r.band as VisBand],
          big: r.prio === 1,
          tip: (
            <>
              <b className="block">{fmt.page(r)} · {fmt.site(r)}</b>
              <span className="block text-white/70">{r.path}</span>
              <span className="block">{t("tip", { seo: fmt.n(r.seo), ai: fmt.n(r.ai), exp: fmt.n(r.exp) })}</span>
              <span className="block text-white/80">{tb(r.band as VisBand)} · {t("prio", { p: r.prio ?? "–" })}</span>
            </>
          ),
        })),
    [fmt, t, tb, view.rows],
  );
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<DefTip k="exp" />} chips={<RnBasisChip>{t("chip", { n: fmt.n(view.totals.complete) })}</RnBasisChip>} sub={t("sub")} />
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 px-6 pb-5 @min-[980px]/rnpage:grid-cols-[minmax(0,1fr)_260px] [.rn-dense_&]:px-4.5">
        <VisLogScatter dots={dots} rate={(view.expectedRate ?? 0) / 1e4} height={360} tick={fmt.k} xTitle={t("x")} yTitle={t("y")} lineLabel={t("line")} halfLabel={t("half")} ariaLabel={t("title")} />
        <div className="grid grid-cols-2 gap-2 @min-[980px]/rnpage:flex @min-[980px]/rnpage:flex-col">
          {BANDS.map((b) => {
            const x = view.bands.find((y) => y.band === b);
            return (
              <div key={b} className="flex flex-col gap-1 rounded-[10px] bg-rn-page py-3 pr-3.5 pl-4" style={{ boxShadow: `inset 3px 0 0 ${BAND_COLORS[b]}` }}>
                <div className="flex items-center gap-2 text-rn-13">
                  <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: BAND_COLORS[b] }} />
                  <b className="font-bold">{tb(b)}</b>
                  <span className="ml-auto text-rn-20 font-bold tracking-[-0.02em] tabular-nums">
                    {x?.n ?? 0}
                    <small className="ml-px text-rn-12 font-semibold text-rn-muted">{t("unit")}</small>
                  </span>
                </div>
                <div className="text-rn-11 leading-[1.5] text-rn-muted tabular-nums [.rn-dense_&]:hidden">
                  {t.rich("bandStats", { p1: x?.p1 ?? 0, seo: fmt.pct(x?.seoShare ?? null, 0), ai: fmt.pct(x?.aiShare ?? null, 0), b: (c) => <b className="font-bold text-rn-ink-2">{c}</b> })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </RnCard>
  );
}

function ChangeCard({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.change");
  const fmt = useVisFmt(view);
  const c = view.changes;
  if (!c) {
    return (
      <RnCard aria-label={t("title")}>
        <RnCardHead title={t("title")} />
        <p className="mx-6 mt-0 mb-5 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("noPrev", { days: view.totals.days })}</p>
      </RnCard>
    );
  }
  const col = (key: "lost" | "fresh" | "up" | "down", ids: number[], value: (r: VisRow) => string, bad: boolean) => (
    <div key={key} className="flex min-w-0 flex-col gap-1.5 border-l border-rn-line px-3 first:border-l-0">
      <h3 className="m-0 mb-0.5 flex items-baseline gap-1.5 text-rn-13 font-bold">
        {t(key)}
        <span className={cx("ml-auto text-rn-20 tracking-[-0.02em] tabular-nums", bad ? "text-[#c4482f]" : "text-rn-up")}>{key === "up" || key === "down" ? Math.min(ids.length, 5) : ids.length}</span>
      </h3>
      {ids.length ? (
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {ids.slice(0, 5).map((i) => {
            const r = view.rows[i];
            return (
              <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-rn-12">
                <span className="flex min-w-0 flex-col">
                  <b className="truncate font-semibold" title={r.title ?? undefined}>{fmt.page(r)}</b>
                  <span className="truncate text-rn-11 text-rn-muted">{fmt.site(r)} · {t("prio", { p: r.prio ?? "–" })}</span>
                </span>
                <span className="font-bold text-rn-ink-2 tabular-nums">{value(r)}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="m-0 rounded-lg bg-rn-page px-2.5 py-2 text-rn-12 text-rn-muted">{t("none")}</p>
      )}
      {(key === "lost" || key === "fresh") && ids.length > 5 ? <p className="m-0 text-rn-11 text-rn-muted">{t("more", { n: ids.length - 5 })}</p> : null}
    </div>
  );
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info", { days: view.totals.days })}</NoteTip>} />
      <div className="grid grid-cols-2 gap-y-3.5 px-3 pb-4 @min-[980px]/rnpage:grid-cols-4">
        {col("lost", c.lost, (r) => `${fmt.n(r.prevAi)} → 0`, true)}
        {col("fresh", c.fresh, (r) => `0 → ${fmt.n(r.ai)}`, false)}
        {col("up", c.up, (r) => `+${fmt.n(r.d)}`, false)}
        {col("down", c.down, (r) => `−${fmt.n(r.d == null ? null : -r.d)}`, true)}
      </div>
    </RnCard>
  );
}

function SortHead({ k, label, sort, onSort, right, info, className }: { k: VisOrderKey; label: string; sort: { k: VisOrderKey; dir: "asc" | "desc" }; onSort: (k: VisOrderKey) => void; right?: boolean; info?: ReactNode; className?: string }) {
  const on = sort.k === k;
  return (
    <span role="columnheader" aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} className={cx("inline-flex items-center gap-0.5", right && "justify-self-end", className)}>
      <button type="button" onClick={() => onSort(k)}
        className="inline-flex cursor-pointer items-center gap-1 hover:text-rn-ink focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rn-navy">
        {label}
        <span aria-hidden className={cx("text-rn-11", on ? "text-rn-navy" : "opacity-0")}>{on && sort.dir === "asc" ? "↑" : "↓"}</span>
      </button>
      {info}
    </span>
  );
}

function PageTable({ view }: { view: VisView }) {
  const t = useTranslations("renewal.visibility.table");
  const tv = useTranslations("renewal.visibility");
  const tq = useTranslations("renewal.visibility.quads");
  const fmt = useVisFmt(view);
  const [quad, setQuad] = useState<"all" | VisQuad>("all");
  const [p1, setP1] = useState(false);
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [sort, setSort] = useState<{ k: VisOrderKey; dir: "asc" | "desc" }>({ k: "short", dir: "desc" });
  const multi = view.sites.length > 1;
  const needle = q.trim().toLowerCase();
  const rows = view.orders[sort.k][sort.dir]
    .map((i) => view.rows[i])
    .filter((r) => (quad === "all" || r.q === quad) && (!p1 || r.prio === 1) && (!needle || (r.title ?? "").toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle)));
  const shown = more ? rows : rows.slice(0, TABLE_ROWS);
  const onSort = (k: VisOrderKey) => setSort((s) => (s.k === k ? { k, dir: s.dir === "asc" ? "desc" : "asc" } : { k, dir: k === "prio" ? "asc" : "desc" }));
  const grid = cx(
    "grid items-center gap-2.5 px-6 [.rn-dense_&]:px-4.5",
    multi ? "grid-cols-[30px_minmax(170px,2fr)_minmax(80px,.9fr)_84px_72px_72px_60px_58px_82px_108px]" : "grid-cols-[30px_minmax(190px,2.4fr)_84px_72px_72px_60px_58px_82px_108px]",
    "@max-[980px]/rnpage:grid-cols-[30px_minmax(150px,2fr)_80px_66px_66px_74px_104px] @max-[980px]/rnpage:[&>[data-x]]:hidden",
  );
  const quadItems = [{ value: "all" as const, label: <>{t("all")} <span className="opacity-70">{view.rows.length}</span></> },
    ...QUADS.map((x) => ({ value: x, label: <>{tq(x)} <span className="opacity-70">{view.quads.find((y) => y.q === x)?.n ?? 0}</span></> }))];
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{range(tv, view.days[0], view.days[view.days.length - 1])}</RnBasisChip>} />
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-6 pb-3 [.rn-dense_&]:px-4.5">
        <RnSegmented label={t("quadLabel")} value={quad} onChange={(v) => { setQuad(v); setMore(false); }} items={quadItems} />
        <button type="button" role="switch" aria-checked={p1} onClick={() => { setP1(!p1); setMore(false); }} className="inline-flex cursor-pointer items-center gap-2 text-rn-12 font-semibold text-rn-ink-2">
          <i aria-hidden className={cx("relative h-[18px] w-[30px] rounded-full transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-3.5 after:rounded-full after:bg-white after:shadow-rn-1 after:transition-transform", p1 ? "bg-rn-navy after:translate-x-3" : "bg-rn-line-2")} />
          {t("p1Only")}
        </button>
        <span className="ml-auto flex items-center gap-3">
          <label className="relative block w-60">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-rn-muted" aria-hidden />
            <input value={q} onChange={(e) => { setQ(e.target.value); setMore(false); }} placeholder={t("search")} aria-label={t("search")}
              className="h-[34px] w-full rounded-lg border border-rn-line-2 bg-rn-surface pr-2.5 pl-8 text-rn-13 text-rn-ink placeholder:text-rn-muted focus:border-rn-navy focus:outline-none" />
          </label>
          <span className="text-rn-12 text-rn-muted tabular-nums">{t("count", { n: fmt.n(rows.length) })}</span>
        </span>
      </div>
      <div role="row" className={cx(grid, HEAD)}>
        <SortHead k="prio" label={t("cols.prio")} sort={sort} onSort={onSort} />
        <span>{t("cols.page")}</span>
        {multi ? <span data-x="">{t("cols.site")}</span> : null}
        <SortHead k="seo" label={t("cols.seo")} sort={sort} onSort={onSort} right info={<DefTip k="seo" />} />
        <SortHead k="ai" label={t("cols.ai")} sort={sort} onSort={onSort} right info={<DefTip k="ai" />} />
        <SortHead k="short" label={t("cols.short")} sort={sort} onSort={onSort} right info={<DefTip k="exp" />} />
        <span data-x="" className="justify-self-end"><SortHead k="int" label={t("cols.int")} sort={sort} onSort={onSort} info={<DefTip k="int" align="end" />} /></span>
        <span data-x="" className="justify-self-end"><SortHead k="read" label={t("cols.read")} sort={sort} onSort={onSort} /></span>
        <SortHead k="ago" label={t("cols.ago")} sort={sort} onSort={onSort} right info={<DefTip k="stale" align="end" />} />
        <span>{t("cols.quad")}</span>
      </div>
      <div role="table" aria-label={t("title")}>
        {shown.length ? (
          shown.map((r) => (
            <div key={r.id} role="row" className={cx(grid, ROW, "min-h-12 [.rn-dense_&]:min-h-[38px]")}>
              <span role="cell"><Prio p={r.prio} /></span>
              <span role="cell" className="min-w-0"><PageCell r={r} view={view} link /></span>
              {multi ? <span role="cell" data-x="" className="truncate text-rn-12 text-rn-ink-2">{fmt.site(r)}</span> : null}
              <span role="cell" className="justify-self-end tabular-nums">{fmt.n(r.seo)}</span>
              <span role="cell" className={cx("justify-self-end tabular-nums", r.ai === 0 && "font-bold text-[#c4482f]")}>{fmt.n(r.ai)}</span>
              <span role="cell" className={cx("justify-self-end tabular-nums", (r.band === "none" || r.band === "low") && (r.short ?? 0) > 0 && "font-bold text-[#b4501f]")}>{r.short ? fmt.n(r.short) : "—"}</span>
              <span role="cell" data-x="" className="justify-self-end tabular-nums">{fmt.rate(r.int)}</span>
              <span role="cell" data-x="" className="justify-self-end tabular-nums">{fmt.pct(r.read == null ? null : r.read * 100, 0)}</span>
              <span role="cell" className="justify-self-end"><Ago r={r} stale={view.staleDays} /></span>
              <span role="cell">
                {r.q ? (
                  <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-rn-page px-2 text-rn-12 font-semibold whitespace-nowrap text-rn-ink-2">
                    <i aria-hidden className="inline-block size-2 rounded-sm" style={{ background: QUAD_COLORS[r.q] }} />
                    {tq(r.q)}
                  </span>
                ) : (
                  <span className="text-rn-12 text-rn-muted">—</span>
                )}
              </span>
            </div>
          ))
        ) : (
          <p className="m-4 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("empty")}</p>
        )}
      </div>
      {rows.length > TABLE_ROWS ? (
        <div className="flex justify-center border-t border-rn-line p-3">
          <RnButton size="sm" onClick={() => setMore(!more)}>{more ? t("less", { n: TABLE_ROWS }) : t("moreAll", { n: fmt.n(rows.length) })}</RnButton>
        </div>
      ) : null}
    </RnCard>
  );
}

export function VisPageTab({ view }: { view: VisView }) {
  return (
    <>
      <WorkCard view={view} />
      <GapCard view={view} />
      <ChangeCard view={view} />
      <PageTable view={view} />
    </>
  );
}
