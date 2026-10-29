"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  RnBasisChip,
  RnButton,
  RnCard,
  RnCardHead,
  RnEmpty,
  RnIconButton,
  RnInfoTip,
  RnInfoTipItem,
  RnSearchField,
  RnSegmented,
  RnSkeleton,
  RnTag,
  RnTextButton,
  cx,
  rnHighlightState,
} from "@/components/renewal-ui";
import type { AcrDistRow, AcrDistSheet, AcrDistSort, AcrDistState, AcrDistTab, AcrModelSort } from "../_data/screen-types";
import { fetchAcrSheet } from "../_data/sheet-client";
import { AcrCardActions, CONTEXT_COLOR, OWN_COLOR, pctTxt, useAcr } from "./acr-context";

// 엔진·프롬프트 · 차종 · 선택 분포 cards of the renewal ACR page. Rows, orders, views, scales
// and the distribution sheets come computed in the view model (screen acr/renewal; the sheets
// other than the first from acr/renewal-sheet when their tab opens).

const HATCH = "repeating-linear-gradient(135deg, #f1ede8 0 4px, #ddd6ce 4px 6px)";

function WinBadge({ brand }: { brand: string | null }) {
  const { colorOf, isOwn, lit, hover, view } = useAcr();
  const t = useTranslations("renewal.acr.battle");
  if (!brand) return <span className="text-rn-12 text-rn-muted">{t("noWinner")}</span>;
  const st = rnHighlightState(lit, [brand], ["__own", ...view.brands.map((b) => b.brand)]);
  return (
    <span
      data-rn-b={brand}
      onPointerEnter={() => hover(brand)}
      onPointerLeave={() => hover(null)}
      className={cx(
        "inline-flex h-6 max-w-full items-center gap-1.5 truncate rounded-md px-2 text-rn-12 font-semibold transition-opacity",
        isOwn(brand) ? "bg-rn-navy/8 text-rn-navy" : "bg-rn-page text-rn-ink-2",
        st === "on" && "shadow-[inset_0_0_0_1.5px_var(--color-rn-ink)]",
        st === "dim" && "opacity-40",
      )}
    >
      <i aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: colorOf(brand) }} />
      {brand}
    </span>
  );
}

export function AcrBattle() {
  const { view, compare, colorOf, engineLabel, battle, setBattle, lit, hover } = useAcr();
  const t = useTranslations("renewal.acr.battle");
  const [more, setMore] = useState(false);
  const engines = view.engines;
  const grid = view.battle;
  const rows = grid.views[battle].map((i) => grid.rows[i]);
  const shown = more ? rows : rows.slice(0, grid.visible);
  const total = grid.total;
  const cols = { gridTemplateColumns: `minmax(0,1fr) repeat(${engines.length}, minmax(112px, 150px))` };
  const csv = () => ({
    name: "acr-prompt-engine",
    rows: [[t("colPrompt"), ...engines.map(engineLabel)], ...rows.map((r) => [r.label, ...r.winners.map((w) => w ?? "")])],
  });
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead
        title={t("title")}
        info={
          <RnInfoTip label={t("infoLabel")}>
            <RnInfoTipItem label={t("infoLabel")}>{t("info")}</RnInfoTipItem>
          </RnInfoTip>
        }
        chips={<RnBasisChip>{t("chip", { prompts: grid.count, engines: engines.length })}</RnBasisChip>}
        controls={
          <RnSegmented
            label={t("viewLabel")}
            value={battle}
            onChange={(v) => {
              setBattle(v);
              setMore(false);
            }}
            items={[
              { value: "all", label: t("all") },
              { value: "notown", label: t("notOwn") },
              { value: "split", label: t("split") },
            ]}
          />
        }
        actions={<AcrCardActions section="sec-prompt" csv={csv} />}
      />
      <div className="flex flex-col gap-1 px-6 pb-3 [.rn-dense_&]:px-4.5">
        {view.engineWins.map((w) => {
          // the compare brands are UI state: their counts are looked up, the rest is what they leave
          const cmp = compare.map((b) => ({ key: b, name: b, n: w.byBrand.find((x) => x.brand === b)?.count ?? 0, color: colorOf(b) }));
          const rest = w.restBase - cmp.reduce((s, x) => s + x.n, 0);
          // no pick (no winner, or no cell on this engine) is not another brand: its own hatched part (2026-10-29 metric review R5)
          const segs = [
            { key: "__own", name: t("ownLabel"), n: w.ownWins, color: OWN_COLOR },
            ...cmp,
            { key: "__rest", name: t("others"), n: rest, color: CONTEXT_COLOR },
            { key: "__none", name: t("noWinner"), n: w.noneWins, color: HATCH },
          ].filter((s) => s.n > 0);
          const keys = segs.map((s) => s.key);
          return (
            <div key={w.engine} className="grid min-h-7 grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3">
              <span className="text-rn-12 font-bold text-rn-ink-2">{engineLabel(w.engine)}</span>
              <span className="flex h-3.5 gap-0.5">
                {segs.map((s) => {
                  const st = s.key === "__rest" || s.key === "__none" ? "none" : rnHighlightState(lit, [s.key], keys);
                  return (
                    <i
                      key={s.key}
                      data-rn-b={s.key === "__rest" || s.key === "__none" ? undefined : s.key}
                      title={t("segTip", { engine: engineLabel(w.engine), brand: s.name, count: s.n })}
                      onPointerEnter={() => s.key !== "__rest" && s.key !== "__none" && hover(s.key)}
                      onPointerLeave={() => hover(null)}
                      className={cx("block h-full min-w-[2px] first:rounded-l last:rounded-r transition-opacity", st === "dim" && "opacity-35")}
                      style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
                    />
                  );
                })}
              </span>
              <span className="text-rn-12 whitespace-nowrap text-rn-muted tabular-nums [&_b]:text-rn-13 [&_b]:text-rn-navy">{t.rich("ownWins", { b: (c) => <b>{c}</b>, wins: w.ownWins, total: grid.count })}</span>
            </div>
          );
        })}
        <div className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-rn-12 text-rn-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="size-2.5 rounded-[2px]" style={{ background: OWN_COLOR }} />
            {t("ownLabel")}
          </span>
          {compare.map((b) => (
            <span key={b} className="inline-flex items-center gap-1.5">
              <i aria-hidden className="size-2.5 rounded-[2px]" style={{ background: colorOf(b) }} />
              {b}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="size-2.5 rounded-[2px]" style={{ background: CONTEXT_COLOR }} />
            {t("others")}
          </span>
        </div>
      </div>
      <div role="table" aria-label={t("gridAria")}>
        <div role="row" className="grid h-[34px] items-center gap-3 border-y border-rn-line px-6 text-rn-12 font-semibold text-rn-muted [.rn-dense_&]:px-4.5" style={cols}>
          <span role="columnheader">{t("colPrompt")}</span>
          {engines.map((e) => (
            <span role="columnheader" key={e}>
              {engineLabel(e)}
            </span>
          ))}
        </div>
        {shown.length ? (
          shown.map((r) => (
            <div
              role="row"
              key={r.promptId}
              className={cx("grid min-h-[46px] items-center gap-3 border-b border-rn-line px-6 text-rn-13 [.rn-dense_&]:min-h-[38px] [.rn-dense_&]:px-4.5", r.notOwn && "shadow-[inset_3px_0_0_#f0a28f]")}
              style={cols}
            >
              <span role="cell" title={r.label} className="line-clamp-2 leading-[1.45] text-rn-ink-2">
                {r.label}
              </span>
              {engines.map((e, ei) => (
                <span role="cell" key={e} className="min-w-0">
                  <WinBadge brand={r.winners[ei]} />
                </span>
              ))}
            </div>
          ))
        ) : (
          <RnEmpty className="m-4">{t("empty")}</RnEmpty>
        )}
      </div>
      {grid.hidden[battle] > 0 ? (
        <div className="flex justify-center border-t border-rn-line p-3">
          <RnButton size="sm" onClick={() => setMore((m) => !m)}>
            {more ? t("less") : t("more", { count: grid.hidden[battle] })}
          </RnButton>
        </div>
      ) : null}
    </RnCard>
  );
}

const MODEL_COLS = "grid-cols-[26px_minmax(150px,1.1fr)_minmax(76px,.8fr)_minmax(56px,1.2fr)_56px_96px_80px] @max-[700px]/rnpage:grid-cols-[26px_minmax(146px,1fr)_minmax(76px,.8fr)_minmax(40px,1fr)_56px_80px]";

export function AcrModels() {
  const { view, colorOf, lit, hover } = useAcr();
  const t = useTranslations("renewal.acr.models");
  const tb = useTranslations("renewal.acr.board");
  const tDef = useTranslations("aiFunnelView.acr.def");
  const td = useTranslations("renewal.acr.def");
  const [sort, setSort] = useState<AcrModelSort>("conversionRate");
  const rows = view.models.orders[sort].map((i) => view.models.rows[i]);
  const keys = ["__own", ...view.models.rows.map((r) => r.brand ?? "")];
  const csv = () => ({ name: "acr-models", rows: [[t("colBrand"), t("colModel"), t("colRate"), t("colShortlist"), t("colTop1")], ...rows.map((r) => [r.brand ?? "", r.model, r.conversionRate, r.shortlistCount, r.top1Count])] });
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead
        title={t("title")}
        info={
          <RnInfoTip label={t("infoLabel")}>
            <RnInfoTipItem label={t("infoLabel")}>{t("info")}</RnInfoTipItem>
          </RnInfoTip>
        }
        chips={<RnBasisChip>{t("chip")}</RnBasisChip>}
        controls={
          <RnSegmented
            label={t("sortLabel")}
            value={sort}
            onChange={setSort}
            items={[
              { value: "conversionRate", label: t("colRate") },
              { value: "shortlistCount", label: t("colShortlist") },
              { value: "top1Count", label: t("colTop1") },
            ]}
          />
        }
        actions={<AcrCardActions section="sec-model" csv={csv} />}
      />
      <div className={cx("grid h-[34px] items-center gap-2.5 border-y border-rn-line px-6 text-rn-12 font-semibold whitespace-nowrap text-rn-muted [.rn-dense_&]:px-4.5", MODEL_COLS)}>
        <span>#</span>
        <span>{t("colBrand")}</span>
        <span>{t("colModel")}</span>
        <span className="inline-flex items-center gap-1">
          {t("colRate")}
          <RnInfoTip label={td("infoAria")}>
            <RnInfoTipItem label={td("definition")}>{tDef("conversion.definition")}</RnInfoTipItem>
            <RnInfoTipItem label={td("formula")}>{tDef("conversion.formula")}</RnInfoTipItem>
          </RnInfoTip>
        </span>
        <span />
        <span className="text-right @max-[700px]/rnpage:hidden">{t("colShortlist")}</span>
        <span className="text-right">{t("colTop1")}</span>
      </div>
      {rows.length ? (
        <div role="list">
          {rows.map((r) => {
            const brand = r.brandLabel;
            const own = r.own;
            const st = rnHighlightState(lit, [brand], keys);
            return (
              <div
                role="listitem"
                key={`${brand}-${r.model}`}
                data-rn-b={brand}
                title={t("rowTip", { brand, model: r.model, rate: pctTxt(r.conversionRate), shortlist: r.shortlistCount.toLocaleString(), top1: r.top1Count.toLocaleString() })}
                onPointerEnter={() => hover(brand)}
                onPointerLeave={() => hover(null)}
                className={cx(
                  "grid min-h-10 items-center gap-2.5 border-b border-rn-line px-6 text-rn-13 [.rn-dense_&]:min-h-[34px] [.rn-dense_&]:px-4.5",
                  MODEL_COLS,
                  own && "bg-[linear-gradient(90deg,rgba(0,44,95,.06),rgba(0,44,95,0)_70%)]",
                  st === "on" && "bg-rn-navy-25 shadow-[inset_3px_0_0_var(--color-rn-navy)]",
                )}
              >
                <span className="text-rn-12 text-rn-muted tabular-nums">{r.rank}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <i aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: colorOf(brand) }} />
                  <b className={cx("truncate font-semibold", own ? "text-rn-navy" : "text-rn-ink")}>{brand}</b>
                  {own ? <RnTag>{tb("own")}</RnTag> : r.sibling ? <RnTag className="bg-transparent text-rn-navy-500 shadow-[inset_0_0_0_1px_var(--color-rn-navy-300)]">{tb("sibling")}</RnTag> : null}
                </span>
                <span className="truncate text-rn-ink-2">{r.model}</span>
                <span className="h-2 overflow-hidden rounded bg-rn-page">
                  <i className="block h-full rounded" style={{ width: `${r.bar}%`, background: own ? OWN_COLOR : colorOf(brand) }} />
                </span>
                <span className="text-right font-bold text-rn-ink tabular-nums">{pctTxt(r.conversionRate)}</span>
                <span className="text-right text-rn-12 text-rn-ink-2 tabular-nums @max-[700px]/rnpage:hidden">{r.shortlistCount.toLocaleString()}</span>
                <span className="text-right text-rn-12 text-rn-ink-2 tabular-nums">{r.top1Count.toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <RnEmpty className="m-4">{t("empty")}</RnEmpty>
      )}
    </RnCard>
  );
}

const DIST_COLS = "grid-cols-[minmax(0,1.4fr)_minmax(140px,1fr)_132px_minmax(116px,152px)] @max-[700px]/rnpage:grid-cols-[minmax(0,1fr)_minmax(110px,1fr)_120px]";

/** 당사 state badge tones: picked navy, a candidate never picked red (the conversion loss), not a candidate grey */
const STATE_TONE: Record<AcrDistState, string> = {
  pick: "bg-rn-navy/8 text-rn-navy",
  listed: "bg-rn-down/10 text-rn-danger-ink",
  absent: "bg-rn-inset text-rn-muted",
};
const STATE_KEY = { pick: "statePick", listed: "stateListed", absent: "stateAbsent" } as const;
const STATE_TIP = { pick: "tipPick", listed: "tipListed", absent: "tipAbsent" } as const;

type SheetRead = { sheet: AcrDistSheet | null } | { failed: true };

/** a tab the pointer rests on this long is read ahead (passing over the tab rows reads nothing) */
const HOVER_INTENT_MS = 150;

/** The 분포 sheet of a tab: the first comes with the page, the others are read when their tab opens, takes the
 * focus (`load`) or holds the pointer (`point` / `unpoint`), once per page URL — the URL holds the filters the
 * view was built from. */
function useAcrSheet(first: AcrDistSheet | null, key: string | null) {
  const search = useSearchParams().toString();
  const [reads, setReads] = useState<Record<string, SheetRead>>({});
  const asked = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(
    (k: string) => {
      const id = `${search}\n${k}`;
      if (k === first?.key || asked.current.has(id)) return;
      asked.current.add(id);
      fetchAcrSheet(search, k).then(
        (sheet) => setReads((m) => ({ ...m, [id]: { sheet } })),
        () => {
          asked.current.delete(id);
          setReads((m) => ({ ...m, [id]: { failed: true } }));
        },
      );
    },
    [search, first],
  );
  useEffect(() => {
    if (key) load(key);
  }, [load, key]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const read: SheetRead | undefined = key === null ? undefined : key === first?.key ? { sheet: first } : reads[`${search}\n${key}`];
  const point = (k: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load(k), HOVER_INTENT_MS);
  };
  const unpoint = () => clearTimeout(timer.current);
  const retry = () => {
    if (key === null) return;
    setReads(({ [`${search}\n${key}`]: _failed, ...m }) => m);
    load(key);
  };
  return { read, load, point, unpoint, retry };
}

/** The sheets are country × engine: an engine toggle (the current country's rows on each engine) and a country list
 * for the engine (most rows first, searchable, ‹ › steps through it) instead of a chip per sheet. */
function SheetPicker({
  tab,
  onPick,
  point,
  unpoint,
  load,
}: {
  tab: AcrDistTab;
  onPick: (key: string) => void;
  point: (key: string) => void;
  unpoint: () => void;
  load: (key: string) => void;
}) {
  const { view, countryLabel, engineLabel } = useAcr();
  const t = useTranslations("renewal.acr.dist");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLInputElement>("[role=dialog] input")?.focus();
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const sheets = view.sheets;
  const engines = [...view.engines, ...sheets.map((s) => s.engine)].filter((e, i, all) => all.indexOf(e) === i && sheets.some((s) => s.engine === e));
  const onEngine = (e: string) => sheets.find((s) => s.engine === e && s.region === tab.region);
  const countries = sheets.filter((s) => s.engine === tab.engine);
  const at = countries.indexOf(tab);
  const prev = countries[at - 1];
  const next = countries[at + 1];
  const needle = q.trim().toLocaleLowerCase();
  const listed = needle ? countries.filter((s) => countryLabel(s.region).toLocaleLowerCase().includes(needle) || (s.region ?? "").toLowerCase().includes(needle)) : countries;
  const pick = (s: AcrDistTab) => {
    onPick(s.key);
    setOpen(false);
    setQ("");
  };
  return (
    <div role="group" aria-label={t("sheets")} className="flex flex-wrap items-center gap-x-5 gap-y-2 px-6 pb-3 [.rn-dense_&]:px-4.5">
      <span className="inline-flex items-center gap-2">
        <span className="text-rn-12 font-semibold text-rn-muted">{t("engine")}</span>
        <RnSegmented
          label={t("engine")}
          value={tab.engine}
          // the same country on the other engine, else that engine's largest sheet
          onChange={(e) => onPick((onEngine(e) ?? sheets.find((s) => s.engine === e) ?? tab).key)}
          items={engines.map((e) => {
            const peer = onEngine(e);
            return {
              value: e,
              label: (
                <span className="inline-flex items-center gap-1.5" onPointerEnter={() => peer && point(peer.key)} onPointerLeave={unpoint}>
                  {engineLabel(e)}
                  <span className="font-medium text-rn-muted tabular-nums">{peer?.count ?? "–"}</span>
                </span>
              ),
            };
          })}
        />
      </span>
      <div ref={box} className="relative inline-flex items-center gap-2">
        <span className="text-rn-12 font-semibold text-rn-muted">{t("country")}</span>
        <button
          ref={button}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("countryPick", { country: countryLabel(tab.region), n: tab.count })}
          data-rn-sheet-picker=""
          onClick={() => setOpen((o) => !o)}
          className={cx(
            "inline-flex h-[30px] min-w-[200px] cursor-pointer items-center gap-2 rounded-md border bg-rn-surface pr-2 pl-2.5 text-rn-12 font-semibold text-rn-ink outline-none focus-visible:border-rn-navy focus-visible:ring-3 focus-visible:ring-rn-navy/12",
            open ? "border-rn-navy" : "border-rn-line-2 hover:border-rn-faint",
          )}
        >
          {countryLabel(tab.region)}
          <span className="ml-auto font-medium text-rn-muted tabular-nums">{tab.count}</span>
          <ChevronDown aria-hidden className={cx("size-3.5 text-rn-muted transition-transform", open && "rotate-180")} />
        </button>
        <span className="inline-flex">
          <RnIconButton label={t("prev")} disabled={!prev} onClick={() => prev && pick(prev)} onPointerEnter={() => prev && point(prev.key)} onPointerLeave={unpoint}>
            <ChevronLeft className="size-4" aria-hidden />
          </RnIconButton>
          <RnIconButton label={t("next")} disabled={!next} onClick={() => next && pick(next)} onPointerEnter={() => next && point(next.key)} onPointerLeave={unpoint}>
            <ChevronRight className="size-4" aria-hidden />
          </RnIconButton>
        </span>
        <span className="text-rn-12 text-rn-muted tabular-nums">{t("position", { at: at + 1, n: countries.length })}</span>
        {open ? (
          <div role="dialog" aria-label={t("country")} className="absolute top-[calc(100%+6px)] left-0 z-40 w-[300px] rounded-xl bg-rn-surface p-2 shadow-[var(--shadow-rn-3),0_0_0_1px_var(--color-rn-line)]">
            <RnSearchField value={q} onChange={setQ} placeholder={t("countrySearch")} label={t("countrySearch")} />
            <p className="m-0 flex justify-between px-2.5 pt-2 pb-1 text-rn-11 text-rn-muted">
              <span>{t("countryHint", { engine: engineLabel(tab.engine) })}</span>
              <span>{t("countryRows")}</span>
            </p>
            <div role="listbox" aria-label={t("country")} className="max-h-[320px] overflow-y-auto">
              {listed.map((s) => {
                const on = s === tab;
                return (
                  <button
                    key={s.key}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-rn-sheet={s.key}
                    onPointerEnter={() => point(s.key)}
                    onPointerLeave={unpoint}
                    onFocus={() => load(s.key)}
                    onClick={() => pick(s)}
                    className={cx(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-rn-13 hover:bg-rn-page focus-visible:bg-rn-page focus-visible:outline-none",
                      on ? "font-semibold text-rn-navy" : "text-rn-ink-2",
                    )}
                  >
                    <Check aria-hidden className={cx("size-3.5 shrink-0", on ? "text-rn-navy" : "invisible")} />
                    {countryLabel(s.region)}
                    <span className="ml-auto text-rn-12 font-medium text-rn-muted tabular-nums">{s.count}</span>
                  </button>
                );
              })}
              {!listed.length ? <p className="m-0 px-2.5 py-2 text-rn-12 text-rn-muted">{t("countryNone")}</p> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AcrDistribution() {
  const { view, compare, colorOf, isOwn, countryLabel, engineLabel, sheet, setSheet, lit, hover } = useAcr();
  const t = useTranslations("renewal.acr.dist");
  const tb = useTranslations("renewal.acr.battle");
  const [state, setState] = useState<AcrDistState | "all">("all");
  const [sort, setSort] = useState<AcrDistSort>("gap");
  const [more, setMore] = useState(false);
  const sheets = view.sheets;
  const tab = sheets.find((s) => s.key === sheet) ?? sheets[0];
  const { read, load, point, unpoint, retry } = useAcrSheet(view.sheet, tab?.key ?? null);
  if (!tab) return null;
  const cur = read && "sheet" in read ? read.sheet : null;
  const rows = cur ? cur.orders[sort][state].map((i) => cur.rows[i]) : [];
  const stateLabel = (r: AcrDistRow) => t(STATE_KEY[r.state]);
  const shown = more ? rows : rows.slice(0, view.distVisible);
  const sheetName = (s: AcrDistTab) => `${countryLabel(s.region)} · ${engineLabel(s.engine)}`;
  const present = cur?.present ?? [];
  const keys = ["__own", ...present];
  const csv = cur
    ? () => ({
        name: `acr-picks-${cur.key.replace("|", "-")}`,
        rows: [[t("colPrompt"), t("colState"), t("colOwn"), "valid", ...present], ...rows.map((r) => [r.label, stateLabel(r), r.ownN, r.validAcr, ...r.pivot])],
      })
    : null;
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead
        title={t("title")}
        info={
          <RnInfoTip label={t("infoLabel")}>
            <RnInfoTipItem label={t("infoLabel")}>{t("info")}</RnInfoTipItem>
          </RnInfoTip>
        }
        chips={<RnBasisChip>{t("chip", { n: sheets.length })}</RnBasisChip>}
        actions={<AcrCardActions section="sec-dist" csv={csv} />}
      />
      <SheetPicker
        tab={tab}
        onPick={(key) => {
          setSheet(key);
          setMore(false);
        }}
        point={point}
        unpoint={unpoint}
        load={load}
      />
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-6 pb-3 [.rn-dense_&]:px-4.5">
        <span className="inline-flex items-center gap-2">
          <span className="text-rn-12 font-semibold text-rn-muted">{t("stateLabel")}</span>
          <RnSegmented
            label={t("stateLabel")}
            value={state}
            onChange={(v) => {
              setState(v);
              setMore(false);
            }}
            items={(["all", "pick", "listed", "absent"] as const).map((v) => ({
              value: v,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {t(v === "all" ? "stateAll" : STATE_KEY[v])}
                  <span className="font-medium text-rn-muted tabular-nums">{cur ? cur.counts[v] : "–"}</span>
                </span>
              ),
            }))}
          />
        </span>
        <RnSegmented
          label={t("sortLabel")}
          value={sort}
          onChange={(v) => {
            setSort(v);
            setMore(false);
          }}
          items={[
            { value: "gap", label: t("sortGap") },
            { value: "own", label: t("sortOwn") },
            { value: "text", label: t("sortText") },
          ]}
        />
        <span className="ml-auto flex flex-wrap gap-x-3 gap-y-1 text-rn-12 text-rn-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="size-2.5 rounded-[2px]" style={{ background: OWN_COLOR }} />
            {tb("ownLabel")}
          </span>
          {compare
            .filter((b) => present.includes(b))
            .map((b) => (
              <span key={b} className="inline-flex items-center gap-1.5">
                <i aria-hidden className="size-2.5 rounded-[2px]" style={{ background: colorOf(b) }} />
                {b}
              </span>
            ))}
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="size-2.5 rounded-[2px]" style={{ background: CONTEXT_COLOR }} />
            {tb("others")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="size-2.5 rounded-[2px]" style={{ background: HATCH }} />
            {tb("noWinner")}
          </span>
        </span>
      </div>
      <div role="table" aria-label={t("gridAria", { sheet: sheetName(tab) })} aria-busy={read === undefined}>
        <div role="row" className={cx("grid h-[34px] items-center gap-3 border-y border-rn-line px-6 text-rn-12 font-semibold text-rn-muted [.rn-dense_&]:px-4.5", DIST_COLS)}>
          <span role="columnheader">{t("colPrompt")}</span>
          <span role="columnheader">{t("colDist")}</span>
          <span role="columnheader">{t("colOwn")}</span>
          <span role="columnheader" className="@max-[700px]/rnpage:hidden">
            {t("colTop")}
          </span>
        </div>
        {read === undefined ? (
          <div role="row" aria-label={t("loading")} className="flex flex-col gap-2.5 px-6 py-3 [.rn-dense_&]:px-4.5">
            {Array.from({ length: Math.min(tab.count, 6) }, (_, i) => (
              <RnSkeleton key={i} className="h-[26px] w-full" />
            ))}
          </div>
        ) : "failed" in read ? (
          <RnEmpty className="m-4">
            {t("failed")}{" "}
            <RnTextButton onClick={retry}>{t("retry")}</RnTextButton>
          </RnEmpty>
        ) : shown.length ? (
          shown.map((r, i) => {
            const top = r.top;
            return (
              <div role="row" key={`${r.promptId}-${i}`} className={cx("grid min-h-[38px] items-center gap-3 border-b border-rn-line px-6 py-1 text-rn-13 [.rn-dense_&]:min-h-8 [.rn-dense_&]:px-4.5", DIST_COLS)}>
                <span role="cell" title={r.label} className="line-clamp-2 leading-[1.4] text-rn-ink-2">
                  {r.label}
                </span>
                <span role="cell" className="flex h-4 gap-0.5">
                  {r.entries.map((e) => {
                    const st = rnHighlightState(lit, [e.brand], keys);
                    return (
                      <i
                        key={e.brand}
                        data-rn-b={e.brand}
                        title={t("segTip", { brand: e.brand, n: e.choice, total: r.validAcr })}
                        onPointerEnter={() => hover(e.brand)}
                        onPointerLeave={() => hover(null)}
                        className={cx("block h-full min-w-[3px] rounded-[2px] transition-opacity", st === "dim" && "opacity-30", st === "on" && "shadow-[inset_0_0_0_1.5px_var(--color-rn-ink)]")}
                        style={{ width: `${e.width}%`, background: colorOf(e.brand) }}
                      />
                    );
                  })}
                  {r.hatch ? <i title={t("noneTip", { n: r.none, total: r.validAcr })} className="block h-full flex-1 rounded-[2px]" style={{ background: HATCH }} /> : null}
                </span>
                <span role="cell" className="min-w-0">
                  <span
                    data-rn-state={r.state}
                    title={t(STATE_TIP[r.state], { n: r.ownN, total: r.validAcr, candidates: r.candidates, cells: r.cells })}
                    className={cx("inline-flex h-6 max-w-full items-center gap-1.5 rounded-md px-2 text-rn-12 font-semibold whitespace-nowrap", STATE_TONE[r.state])}
                  >
                    {stateLabel(r)}
                    <span className="font-medium tabular-nums opacity-80">
                      {r.ownN}/{r.validAcr}
                    </span>
                  </span>
                </span>
                <span role="cell" className="min-w-0 @max-[700px]/rnpage:hidden">
                  {top ? (
                    <span className={cx("inline-flex h-6 max-w-full items-center gap-1.5 truncate rounded-md px-2 text-rn-12 font-semibold", isOwn(top.brand) ? "bg-rn-navy/8 text-rn-navy" : "bg-rn-page text-rn-ink-2")}>
                      <i aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: colorOf(top.brand) }} />
                      {top.brand} {top.choice}
                    </span>
                  ) : (
                    <span className="text-rn-12 text-rn-muted">—</span>
                  )}
                </span>
              </div>
            );
          })
        ) : (
          <RnEmpty className="m-4">{t("empty")}</RnEmpty>
        )}
      </div>
      {rows.length > view.distVisible ? (
        <div className="flex justify-center border-t border-rn-line p-3">
          <RnButton size="sm" onClick={() => setMore((m) => !m)}>
            {more ? t("less") : t("more", { count: rows.length })}
          </RnButton>
        </div>
      ) : null}
    </RnCard>
  );
}
