"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { RnBasisChip, RnButton, RnCard, RnCardHead, RnEmpty, RnInfoTip, RnInfoTipItem, RnSegmented, RnTag, cx, rnHighlightState } from "@/components/renewal-ui";
import type { AcrConversionRow, AcrConversionSort, AcrDistState, AcrDuelPart } from "../_data/screen-types";
import { AcrCardActions, OWN_COLOR, pctTxt, useAcr } from "./acr-context";

// 후보 → 선택 전환 · 결선 맞대결 cards of the renewal ACR page (2026-10-29). Counts, shares,
// orders and the sheet a row opens come computed in the view model (screen acr/renewal).

const STATES: AcrDistState[] = ["pick", "listed", "absent"];
/** 당사 state colours: picked navy, a candidate never picked red (the conversion loss), not a candidate grey */
const STATE_COLOR: Record<AcrDistState, string> = { pick: OWN_COLOR, listed: "color-mix(in srgb, var(--color-rn-down) 72%, #ffffff)", absent: "#ddd6ce" };
const STATE_KEY = { pick: "statePick", listed: "stateListed", absent: "stateAbsent" } as const;

const countTxt = (n: number, share: number | null) => `${n.toLocaleString()} (${pctTxt(share)})`;

function StateBar({ counts, n, className }: { counts: Record<AcrDistState, number>; n: number; className?: string }) {
  return (
    <span className={cx("flex h-2.5 overflow-hidden rounded bg-rn-page", className)}>
      {STATES.map((st) => (counts[st] > 0 ? <i key={st} aria-hidden className="block h-full min-w-[2px]" style={{ width: `${(counts[st] / (n || 1)) * 100}%`, background: STATE_COLOR[st] }} /> : null))}
    </span>
  );
}

function EnginePicker({ engines, value, onChange }: { engines: string[]; value: string; onChange: (v: string) => void }) {
  const { engineLabel } = useAcr();
  const t = useTranslations("renewal.acr.conv");
  return <RnSegmented label={t("engineLabel")} value={value} onChange={onChange} items={engines.map((e) => ({ value: e, label: e === "all" ? t("engineAll") : engineLabel(e) }))} />;
}

const CONV_COLS = "grid-cols-[minmax(120px,1fr)_56px_minmax(160px,1.6fr)_112px_124px_104px] @max-[760px]/rnpage:grid-cols-[minmax(110px,1fr)_48px_minmax(120px,1.4fr)_112px]";

export function AcrConversion() {
  const { view, countryLabel, setSheet, setDistState } = useAcr();
  const t = useTranslations("renewal.acr.conv");
  const td = useTranslations("renewal.acr.dist");
  const c = view.conversion;
  const [engine, setEngine] = useState("all");
  const [sort, setSort] = useState<AcrConversionSort>("listed");
  const [more, setMore] = useState(false);
  const v = c.views[engine] ?? c.views.all;
  const rows = v.orders[sort].map((i) => v.rows[i]);
  const shown = more ? rows : rows.slice(0, c.visible);
  const open = (r: AcrConversionRow) => {
    if (!r.sheet) return;
    setSheet(r.sheet);
    setDistState("listed");
    document.getElementById("sec-dist")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const csv = () => ({
    name: `acr-conversion-${engine}`,
    rows: [
      [t("colCountry"), t("colN"), ...STATES.flatMap((st) => [td(STATE_KEY[st]), `${td(STATE_KEY[st])} %`])],
      ...rows.map((r) => [countryLabel(r.region), r.n, ...STATES.flatMap((st) => [r.counts[st], r.shares[st]])]),
    ],
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
        chips={<RnBasisChip>{t("chip")}</RnBasisChip>}
        controls={
          <>
            <EnginePicker
              engines={c.engines}
              value={engine}
              onChange={(e) => {
                setEngine(e);
                setMore(false);
              }}
            />
            <RnSegmented
              label={t("sortLabel")}
              value={sort}
              onChange={(s) => {
                setSort(s);
                setMore(false);
              }}
              items={[
                { value: "listed", label: t("sortListed") },
                { value: "share", label: t("sortShare") },
              ]}
            />
          </>
        }
        actions={<AcrCardActions section="sec-comp" csv={csv} />}
        sub={t("sub")}
      />
      <div className="flex flex-col gap-2 px-6 pb-4 [.rn-dense_&]:px-4.5 [.rn-dense_&]:pb-3">
        <StateBar counts={v.counts} n={v.n} className="h-3.5" />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-rn-12 text-rn-ink-2">
          <span className="font-semibold text-rn-muted">{t("total", { n: v.n.toLocaleString() })}</span>
          {STATES.map((st) => (
            <span key={st} className="inline-flex items-center gap-1.5">
              <i aria-hidden className="size-2.5 rounded-[2px]" style={{ background: STATE_COLOR[st] }} />
              {td(STATE_KEY[st])}
              <b className={cx("tabular-nums", st === "listed" ? "text-rn-danger-ink" : "text-rn-ink")}>{countTxt(v.counts[st], v.shares[st])}</b>
            </span>
          ))}
        </div>
      </div>
      <div>
        <div className={cx("grid h-[34px] items-center gap-3 border-y border-rn-line px-6 text-rn-12 font-semibold text-rn-muted [.rn-dense_&]:px-4.5", CONV_COLS)}>
          <span>{t("colCountry")}</span>
          <span className="text-right">{t("colN")}</span>
          <span>{t("colBar")}</span>
          {STATES.map((st) => (
            <span key={st} className={cx("text-right", st !== "listed" && "@max-[760px]/rnpage:hidden")}>
              {td(STATE_KEY[st])}
            </span>
          ))}
        </div>
        {shown.length ? (
          shown.map((r) => {
            const name = countryLabel(r.region);
            return (
              <button
                type="button"
                key={r.region ?? "—"}
                disabled={!r.sheet}
                aria-label={t("open", { country: name })}
                title={t("rowTip", { country: name, n: r.n.toLocaleString(), pick: countTxt(r.counts.pick, r.shares.pick), listed: countTxt(r.counts.listed, r.shares.listed), absent: countTxt(r.counts.absent, r.shares.absent) })}
                onClick={() => open(r)}
                className={cx(
                  "grid min-h-10 w-full cursor-pointer items-center gap-3 border-b border-rn-line px-6 text-left text-rn-13 hover:bg-rn-navy-25 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy disabled:cursor-default [.rn-dense_&]:min-h-[34px] [.rn-dense_&]:px-4.5",
                  CONV_COLS,
                )}
              >
                <b className="truncate font-semibold text-rn-ink">{name}</b>
                <span className="text-right text-rn-12 text-rn-ink-2 tabular-nums">{r.n.toLocaleString()}</span>
                <StateBar counts={r.counts} n={r.n} />
                {STATES.map((st) => (
                  <span key={st} className={cx("text-right tabular-nums", st === "listed" ? "font-bold text-rn-ink" : "text-rn-12 text-rn-ink-2 @max-[760px]/rnpage:hidden")}>
                    {countTxt(r.counts[st], r.shares[st])}
                  </span>
                ))}
              </button>
            );
          })
        ) : (
          <RnEmpty className="m-4">{t("empty")}</RnEmpty>
        )}
      </div>
      {rows.length > c.visible ? (
        <div className="flex justify-center border-t border-rn-line p-3">
          <RnButton size="sm" onClick={() => setMore((m) => !m)}>
            {more ? t("less") : t("more", { count: rows.length - c.visible })}
          </RnButton>
        </div>
      ) : null}
    </RnCard>
  );
}

const DUEL_COLS = "grid-cols-[minmax(130px,1fr)_84px_64px_minmax(200px,2fr)_64px_64px]";

export function AcrDuels() {
  const { view, totals, colorOf, lit, hover } = useAcr();
  const t = useTranslations("renewal.acr.duel");
  const tb = useTranslations("renewal.acr.board");
  const d = view.duels;
  const [engine, setEngine] = useState("all");
  if (!d) return null;
  const rows = d.views[engine] ?? d.views.all;
  const keys = rows.map((r) => r.brand);
  const sample = t("sample", { valid: totals.iterations.toLocaleString(), iterations: d.sample.iterations.toLocaleString(), cells: d.sample.cells.toLocaleString() });
  const part = (r: (typeof rows)[number], p: AcrDuelPart) => countTxt(r.counts[p], r.shares[p]);
  const csv = () => ({
    name: `acr-head-to-head-${engine}`,
    rows: [
      [t("colRival"), t("colN"), t("colOwn"), `${t("colOwn")} %`, t("colRivalWin"), `${t("colRivalWin")} %`, t("colRest"), `${t("colRest")} %`],
      ...rows.map((r) => [r.brand, r.n, r.counts.own, r.shares.own, r.counts.rival, r.shares.rival, r.counts.rest, r.shares.rest]),
    ],
  });
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead
        title={t("title")}
        info={
          <RnInfoTip label={t("infoLabel")}>
            <RnInfoTipItem label={t("infoLabel")}>{t("info")}</RnInfoTipItem>
            <RnInfoTipItem label={t("sampleLabel")}>{sample}</RnInfoTipItem>
          </RnInfoTip>
        }
        chips={<RnBasisChip>{t("chip")}</RnBasisChip>}
        controls={<EnginePicker engines={d.engines} value={engine} onChange={setEngine} />}
        actions={<AcrCardActions section="sec-comp" csv={csv} />}
        sub={t("sub")}
      />
      <div role="table" aria-label={t("title")}>
        <div role="row" className={cx("grid h-[34px] items-center gap-3 border-y border-rn-line px-6 text-rn-12 font-semibold text-rn-muted [.rn-dense_&]:px-4.5", DUEL_COLS)}>
          <span role="columnheader">{t("colRival")}</span>
          <span role="columnheader" className="text-right">
            {t("colN")}
          </span>
          <span role="columnheader" className="text-right">
            {t("colOwn")}
          </span>
          <span role="columnheader" aria-hidden />
          <span role="columnheader">{t("colRivalWin")}</span>
          <span role="columnheader" className="text-right">
            {t("colRest")}
          </span>
        </div>
        {rows.length ? (
          rows.map((r) => {
            const st = rnHighlightState(lit, [r.brand], keys);
            const rival = colorOf(r.brand);
            return (
              <div
                role="row"
                key={r.brand}
                data-rn-b={r.brand}
                title={t("rowTip", { rival: r.brand, n: r.n.toLocaleString(), own: part(r, "own"), rivalWins: part(r, "rival"), rest: part(r, "rest") })}
                onPointerEnter={() => hover(r.brand)}
                onPointerLeave={() => hover(null)}
                className={cx("grid min-h-10 items-center gap-3 border-b border-rn-line px-6 text-rn-13 [.rn-dense_&]:min-h-[34px] [.rn-dense_&]:px-4.5", DUEL_COLS, st === "on" && "bg-rn-navy-25 shadow-[inset_3px_0_0_var(--color-rn-navy)]")}
              >
                <span role="cell" className="flex min-w-0 items-center gap-2">
                  <b className="truncate font-semibold text-rn-ink">{r.brand}</b>
                  {r.sibling ? <RnTag className="bg-transparent text-rn-navy-500 shadow-[inset_0_0_0_1px_var(--color-rn-navy-300)]">{tb("sibling")}</RnTag> : null}
                </span>
                <span role="cell" className="text-right text-rn-12 text-rn-ink-2 tabular-nums">
                  {t("times", { n: r.n.toLocaleString() })}
                </span>
                <span role="cell" className={cx("text-right tabular-nums", r.lead === "own" ? "font-bold text-rn-navy" : "text-rn-ink-2")}>
                  {pctTxt(r.shares.own)}
                </span>
                <span role="cell" className="grid grid-cols-2 items-center">
                  <span className="flex h-2.5 justify-end border-r border-rn-ink-2/40 pr-px">
                    <i aria-hidden className="block h-full rounded-l" style={{ width: `${r.bars.own}%`, background: OWN_COLOR }} />
                  </span>
                  <span className="flex h-2.5 pl-px">
                    <i aria-hidden className="block h-full rounded-r" style={{ width: `${r.bars.rival}%`, background: rival }} />
                  </span>
                </span>
                <span role="cell" className={cx("tabular-nums", r.lead === "rival" ? "font-bold text-rn-danger-ink" : "text-rn-ink-2")}>
                  {pctTxt(r.shares.rival)}
                </span>
                <span role="cell" className="text-right text-rn-12 text-rn-muted tabular-nums">
                  {pctTxt(r.shares.rest)}
                </span>
              </div>
            );
          })
        ) : (
          <RnEmpty className="m-4">{t("empty")}</RnEmpty>
        )}
      </div>
      <p className="m-0 border-t border-rn-line px-6 py-3 text-rn-12 break-keep text-rn-muted [.rn-dense_&]:px-4.5">{sample}</p>
    </RnCard>
  );
}
