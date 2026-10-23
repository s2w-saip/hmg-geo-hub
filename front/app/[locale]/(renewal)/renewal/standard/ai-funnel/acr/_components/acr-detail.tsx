"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { RnBasisChip, RnButton, RnCard, RnCardHead, RnEmpty, RnInfoTip, RnInfoTipItem, RnSegmented, RnTag, cx, rnHighlightState } from "@/components/renewal-ui";
import { sheetKeyOf } from "./acr-model";
import { AcrCardActions, CONTEXT_COLOR, OWN_COLOR, pctTxt, useAcr } from "./acr-context";

// 엔진·프롬프트 · 차종 · 선택 분포 cards of the renewal ACR page.

const HATCH = "repeating-linear-gradient(135deg, #f1ede8 0 4px, #ddd6ce 4px 6px)";
const BATTLE_VISIBLE = 30; // acr-live-view.tsx BATTLE_VISIBLE
const DIST_VISIBLE = 20;

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
  const { data, view, compare, colorOf, engineLabel, battle, setBattle, lit, hover } = useAcr();
  const t = useTranslations("renewal.acr.battle");
  const [more, setMore] = useState(false);
  const engines = view.engines;
  const keep = (r: (typeof data.battle)[number]) =>
    battle === "notown" ? !r.cells.some((c) => c.winnerIsOurs) : battle === "split" ? new Set(r.cells.map((c) => c.winner)).size > 1 : true;
  const rows = data.battle.filter(keep);
  const shown = more ? rows : rows.slice(0, BATTLE_VISIBLE);
  const total = data.battle.length || 1;
  const cols = { gridTemplateColumns: `minmax(0,1fr) repeat(${engines.length}, minmax(112px, 150px))` };
  const csv = () => ({
    name: "acr-prompt-engine",
    rows: [[t("colPrompt"), ...engines.map(engineLabel)], ...rows.map((r) => [r.promptText ?? r.promptId, ...engines.map((e) => r.cells.find((c) => c.engine === e)?.winner ?? "")])],
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
        chips={<RnBasisChip>{t("chip", { prompts: data.battle.length, engines: engines.length })}</RnBasisChip>}
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
          const cmp = compare.map((b) => ({ key: b, name: b, n: w.byBrand.get(b) ?? 0, color: colorOf(b) }));
          const rest = data.battle.length - w.ownWins - cmp.reduce((s, x) => s + x.n, 0);
          const segs = [{ key: "__own", name: t("ownLabel"), n: w.ownWins, color: OWN_COLOR }, ...cmp, { key: "__rest", name: t("others"), n: rest, color: CONTEXT_COLOR }].filter((s) => s.n > 0);
          const keys = segs.map((s) => s.key);
          return (
            <div key={w.engine} className="grid min-h-7 grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3">
              <span className="text-rn-12 font-bold text-rn-ink-2">{engineLabel(w.engine)}</span>
              <span className="flex h-3.5 gap-0.5">
                {segs.map((s) => {
                  const st = s.key === "__rest" ? "none" : rnHighlightState(lit, [s.key], keys);
                  return (
                    <i
                      key={s.key}
                      data-rn-b={s.key === "__rest" ? undefined : s.key}
                      title={t("segTip", { engine: engineLabel(w.engine), brand: s.name, count: s.n })}
                      onPointerEnter={() => s.key !== "__rest" && hover(s.key)}
                      onPointerLeave={() => hover(null)}
                      className={cx("block h-full min-w-[2px] first:rounded-l last:rounded-r transition-opacity", st === "dim" && "opacity-35")}
                      style={{ width: `${(s.n / total) * 100}%`, background: s.color }}
                    />
                  );
                })}
              </span>
              <span className="text-rn-12 whitespace-nowrap text-rn-muted tabular-nums [&_b]:text-rn-13 [&_b]:text-rn-navy">{t.rich("ownWins", { b: (c) => <b>{c}</b>, wins: w.ownWins, total: data.battle.length })}</span>
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
              className={cx("grid min-h-[46px] items-center gap-3 border-b border-rn-line px-6 text-rn-13 [.rn-dense_&]:min-h-[38px] [.rn-dense_&]:px-4.5", !r.cells.some((c) => c.winnerIsOurs) && "shadow-[inset_3px_0_0_#f0a28f]")}
              style={cols}
            >
              <span role="cell" title={r.promptText ?? r.promptId} className="line-clamp-2 leading-[1.45] text-rn-ink-2">
                {r.promptText ?? r.promptId}
              </span>
              {engines.map((e) => (
                <span role="cell" key={e} className="min-w-0">
                  <WinBadge brand={r.cells.find((c) => c.engine === e)?.winner ?? null} />
                </span>
              ))}
            </div>
          ))
        ) : (
          <RnEmpty className="m-4">{t("empty")}</RnEmpty>
        )}
      </div>
      {rows.length > BATTLE_VISIBLE ? (
        <div className="flex justify-center border-t border-rn-line p-3">
          <RnButton size="sm" onClick={() => setMore((m) => !m)}>
            {more ? t("less") : t("more", { count: rows.length - BATTLE_VISIBLE })}
          </RnButton>
        </div>
      ) : null}
    </RnCard>
  );
}

const MODEL_COLS = "grid-cols-[26px_minmax(150px,1.1fr)_minmax(76px,.8fr)_minmax(56px,1.2fr)_56px_96px_80px] @max-[700px]/rnpage:grid-cols-[26px_minmax(146px,1fr)_minmax(76px,.8fr)_minmax(40px,1fr)_56px_80px]";

export function AcrModels() {
  const { data, colorOf, isOwn, isSibling, lit, hover } = useAcr();
  const t = useTranslations("renewal.acr.models");
  const tb = useTranslations("renewal.acr.board");
  const tDef = useTranslations("aiFunnelView.acr.def");
  const td = useTranslations("renewal.acr.def");
  const [sort, setSort] = useState<"conversionRate" | "shortlistCount" | "top1Count">("conversionRate");
  const rows = data.modelConversion.map((r, i) => ({ ...r, rank: i + 1 })).sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || a.rank - b.rank);
  const max = Math.max(1, ...data.modelConversion.map((r) => r.conversionRate ?? 0));
  const keys = ["__own", ...data.modelConversion.map((r) => r.brand ?? "")];
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
            const brand = r.brand ?? "—";
            const own = r.isOurs || isOwn(brand);
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
                  {own ? <RnTag>{tb("own")}</RnTag> : isSibling(brand) ? <RnTag className="bg-transparent text-rn-navy-500 shadow-[inset_0_0_0_1px_var(--color-rn-navy-300)]">{tb("sibling")}</RnTag> : null}
                </span>
                <span className="truncate text-rn-ink-2">{r.model}</span>
                <span className="h-2 overflow-hidden rounded bg-rn-page">
                  <i className="block h-full rounded" style={{ width: `${((r.conversionRate ?? 0) / max) * 100}%`, background: own ? OWN_COLOR : colorOf(brand) }} />
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

const DIST_COLS = "grid-cols-[minmax(0,1.4fr)_minmax(140px,1fr)_52px_minmax(116px,152px)] @max-[700px]/rnpage:grid-cols-[minmax(0,1fr)_minmax(110px,1fr)_48px]";

export function AcrDistribution() {
  const { data, compare, colorOf, isOwn, countryLabel, engineLabel, sheet, setSheet, lit, hover } = useAcr();
  const t = useTranslations("renewal.acr.dist");
  const tb = useTranslations("renewal.acr.battle");
  const [zero, setZero] = useState(false);
  const [sort, setSort] = useState<"text" | "own">("text");
  const [more, setMore] = useState(false);
  if (!data.territory.length) return null;
  const cur = data.territory.find((s) => sheetKeyOf(s) === sheet) ?? data.territory[0];
  const ownN = (r: (typeof cur.rows)[number]) => r.entries.filter((e) => isOwn(e.brand)).reduce((s, e) => s + e.choice, 0);
  let rows = cur.rows.filter((r) => !zero || ownN(r) === 0);
  rows = sort === "own" ? [...rows].sort((a, b) => ownN(a) / (a.validAcr || 1) - ownN(b) / (b.validAcr || 1) || (a.promptText ?? "").localeCompare(b.promptText ?? "")) : [...rows].sort((a, b) => (a.promptText ?? "").localeCompare(b.promptText ?? ""));
  const shown = more ? rows : rows.slice(0, DIST_VISIBLE);
  const sheetName = (s: (typeof data.territory)[number]) => `${countryLabel(s.region)} · ${engineLabel(s.engine)}`;
  const present = new Set(cur.rows.flatMap((r) => r.entries.map((e) => e.brand)));
  const keys = ["__own", ...present];
  const csv = () => ({
    name: `acr-picks-${sheetKeyOf(cur).replace("|", "-")}`,
    rows: [[t("colPrompt"), t("colOwn"), "valid", ...[...present]], ...rows.map((r) => [r.promptText ?? r.promptId, ownN(r), r.validAcr, ...[...present].map((b) => r.entries.find((e) => e.brand === b)?.choice ?? 0)])],
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
        chips={<RnBasisChip>{t("chip", { n: data.territory.length })}</RnBasisChip>}
        actions={<AcrCardActions section="sec-dist" csv={csv} />}
      />
      <div role="tablist" aria-label={t("sheets")} className="flex flex-wrap gap-1.5 px-6 pb-3 [.rn-dense_&]:px-4.5">
        {data.territory.map((s) => {
          const on = s === cur;
          return (
            <button
              key={sheetKeyOf(s)}
              type="button"
              role="tab"
              aria-selected={on}
              data-rn-sheet={sheetKeyOf(s)}
              onClick={() => {
                setSheet(sheetKeyOf(s));
                setMore(false);
              }}
              className={cx(
                "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-rn-12 font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rn-navy",
                on ? "bg-rn-navy text-white" : "text-rn-ink-2 shadow-[inset_0_0_0_1px_var(--color-rn-line-2)] hover:bg-rn-page",
              )}
            >
              {sheetName(s)}
              <span className={cx("font-medium tabular-nums", on ? "text-white/80" : "text-rn-muted")}>{s.rows.length}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-6 pb-3 [.rn-dense_&]:px-4.5">
        <button
          type="button"
          role="switch"
          aria-checked={zero}
          onClick={() => {
            setZero((z) => !z);
            setMore(false);
          }}
          className="inline-flex cursor-pointer items-center gap-2 text-rn-12 font-semibold text-rn-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rn-navy"
        >
          <i aria-hidden className={cx("relative h-[18px] w-[30px] rounded-full transition-colors", zero ? "bg-rn-navy" : "bg-rn-line-2")}>
            <i className={cx("absolute top-0.5 left-0.5 size-3.5 rounded-full bg-white shadow-rn-1 transition-transform", zero && "translate-x-3")} />
          </i>
          {t("zero")}
        </button>
        <RnSegmented
          label={t("sortLabel")}
          value={sort}
          onChange={setSort}
          items={[
            { value: "text", label: t("sortText") },
            { value: "own", label: t("sortOwn") },
          ]}
        />
        <span className="ml-auto flex flex-wrap gap-x-3 gap-y-1 text-rn-12 text-rn-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className="size-2.5 rounded-[2px]" style={{ background: OWN_COLOR }} />
            {tb("ownLabel")}
          </span>
          {compare
            .filter((b) => present.has(b))
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
      <div role="table" aria-label={t("gridAria", { sheet: sheetName(cur) })}>
        <div role="row" className={cx("grid h-[34px] items-center gap-3 border-y border-rn-line px-6 text-rn-12 font-semibold text-rn-muted [.rn-dense_&]:px-4.5", DIST_COLS)}>
          <span role="columnheader">{t("colPrompt")}</span>
          <span role="columnheader">{t("colDist")}</span>
          <span role="columnheader" className="text-right">
            {t("colOwn")}
          </span>
          <span role="columnheader" className="@max-[700px]/rnpage:hidden">
            {t("colTop")}
          </span>
        </div>
        {shown.length ? (
          shown.map((r, i) => {
            const o = ownN(r);
            const picked = r.entries.reduce((s, e) => s + e.choice, 0);
            const top = r.entries[0];
            return (
              <div role="row" key={`${r.promptId}-${i}`} className={cx("grid min-h-[38px] items-center gap-3 border-b border-rn-line px-6 py-1 text-rn-13 [.rn-dense_&]:min-h-8 [.rn-dense_&]:px-4.5", DIST_COLS)}>
                <span role="cell" title={r.promptText ?? r.promptId} className="line-clamp-2 leading-[1.4] text-rn-ink-2">
                  {r.promptText ?? r.promptId}
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
                        style={{ width: `${(e.choice / (r.validAcr || 1)) * 100}%`, background: colorOf(e.brand) }}
                      />
                    );
                  })}
                  {r.validAcr > picked ? <i title={t("noneTip", { n: r.validAcr - picked, total: r.validAcr })} className="block h-full flex-1 rounded-[2px]" style={{ background: HATCH }} /> : null}
                </span>
                <span role="cell" className={cx("text-right text-rn-12 tabular-nums", o === 0 ? "font-bold text-rn-danger-ink" : "text-rn-ink-2")}>
                  {o}/{r.validAcr}
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
      {rows.length > DIST_VISIBLE ? (
        <div className="flex justify-center border-t border-rn-line p-3">
          <RnButton size="sm" onClick={() => setMore((m) => !m)}>
            {more ? t("less") : t("more", { count: rows.length })}
          </RnButton>
        </div>
      ) : null}
    </RnCard>
  );
}
