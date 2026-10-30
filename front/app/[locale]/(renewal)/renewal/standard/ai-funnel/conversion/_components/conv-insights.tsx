"use client";

// The BI cards of the renewal AI Conversion page (2026-10-30): the AI channel among GA4's channel groups, the
// conversion change split into 유입 규모 and 세션당 전환 (an exact identity, with the engines' share of the session
// change), the device · new/returning mix of AI vs general, and the raw period-user windows (the original screen's
// 기간 사용자 측정값). Display only: every value, rank and part comes from the screen model.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { RnBasisChip, RnButton, RnCard, RnCardHead, RnDeltaChip, RnSegmented, cx } from "@/components/renewal-ui";
import type { ConvDecomp, ConvSegment, ConvView, ConvWindow } from "../_data/screen-types";
import { DefTip, NoteTip, useConvFmt, type ConvFmt } from "./conv-body";
import { AI_COLOR, Bar, GEN_COLOR, GREY, Head, Legend, MoreButton, Takeaway, useDeltaLabels } from "./conv-cards";

// diverging pair for a change's parts (+ cool, − warm) and the two period totals
const UP = "#1a4d8e";
const DOWN = "#eb6834";
const PREV = "#6b89b3";
const RAW_ROWS = 30;

// ══ 채널별 유입 · 주요 이벤트 ══

export function ConvChannelCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.channels");
  const fmt = useConvFmt(view);
  const labels = useDeltaLabels();
  const { rows, site, aiRank } = view.channels;
  const ai = rows.find((r) => r.ai);
  const maxS = Math.max(1, ...rows.map((r) => r.sessions ?? 0));
  const maxK = Math.max(site.per100 ?? 0, ...rows.map((r) => r.per100 ?? 0)) || 1;
  const grid = "grid grid-cols-[minmax(108px,1.1fr)_minmax(84px,1fr)_48px_minmax(140px,1.3fr)_60px_64px] items-center gap-2";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{t("chip", { n: rows.length })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {rows.length ? (
          <>
            {ai && aiRank && aiRank.sessions != null ? (
              <Takeaway>
                {aiRank.per100 != null
                  ? t("take", { n: aiRank.n, rank: aiRank.sessions, share: fmt.pct(ai.share, 2), per100Rank: aiRank.per100, per100: fmt.one(ai.per100), site: fmt.one(site.per100) })
                  : t("takeNoKe", { n: aiRank.n, rank: aiRank.sessions, share: fmt.pct(ai.share, 2) })}
              </Takeaway>
            ) : (
              <Takeaway>{t("noAi")}</Takeaway>
            )}
            <Head grid={grid} cols={[[t("cols.channel")], [t("cols.sessions")], [t("cols.share"), "r"], [<KeHead key="ke" label={t("cols.per100")} />], [t("cols.pps"), "r"], [t("cols.d"), "r"]]} />
            {rows.map((r) => (
              <div key={r.channel} data-rn-channel={r.channel} className={cx(grid, "min-h-9 border-b border-rn-line text-rn-13 last:border-b-0", r.ai && "-mx-2 rounded-md bg-rn-navy-25 px-2")}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <b className={cx("truncate", r.ai ? "font-bold text-rn-navy" : "font-semibold")}>{r.channel}</b>
                  {r.ai ? <span className="inline-flex h-4.5 items-center rounded bg-rn-navy px-1 text-rn-11 font-bold text-white">AI</span> : null}
                </span>
                <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                  <Bar w={r.sessions == null ? null : (r.sessions / maxS) * 100} color={r.ai ? AI_COLOR : GEN_COLOR} />
                  <b className="text-right font-bold tabular-nums">{fmt.n(r.sessions)}</b>
                </span>
                <span className="text-right text-rn-12 text-rn-muted tabular-nums">{fmt.pct(r.share, r.share != null && r.share < 10 ? 2 : 1)}</span>
                <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                  <MarkedBar w={r.per100 == null ? null : (r.per100 / maxK) * 100} mark={site.per100 == null ? null : (site.per100 / maxK) * 100} color={r.ai ? AI_COLOR : GEN_COLOR} />
                  <span className={cx("text-right tabular-nums", r.ai ? "font-bold" : "font-semibold")}>{fmt.one(r.per100)}</span>
                </span>
                <span className="text-right tabular-nums">{fmt.two(r.pps)}</span>
                <span className="flex justify-end">
                  {view.prevOk ? <RnDeltaChip delta={r.d} format={(x) => `${Math.abs(x).toFixed(1)}%`} emptyText="−" labels={labels} /> : <span className="text-rn-muted">−</span>}
                </span>
              </div>
            ))}
            <div data-rn-channel-site="" className={cx(grid, "min-h-9 border-t-2 border-rn-line-2 text-rn-13 text-rn-ink-2")}>
              <b className="font-semibold">{t("site")}</b>
              <span className="text-right font-semibold tabular-nums">{fmt.n(site.sessions)}</span>
              <span />
              <span className="flex items-center justify-end gap-1.5 text-right font-semibold tabular-nums">
                <i aria-hidden className="inline-block h-3 w-0.5 bg-rn-ink-2" />
                {fmt.one(site.per100)}
              </span>
              <span className="text-right tabular-nums">{fmt.two(site.pps)}</span>
              <span />
            </div>
          </>
        ) : (
          <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t(view.channels.reason === "engine" ? "noneEngine" : "none")}</p>
        )}
        <p className="m-0 mt-2 text-rn-11 break-keep text-rn-muted">{t("note")}</p>
      </div>
    </RnCard>
  );
}

function KeHead({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
      {label}
      <DefTip k="ke100" />
    </span>
  );
}

/** A bar with the site total's level marked on the same scale. */
function MarkedBar({ w, mark, color }: { w: number | null; mark: number | null; color: string }) {
  return (
    <span className="relative block h-2 rounded bg-rn-page">
      <i className="block h-full rounded" style={{ width: `${Math.max(0, Math.min(100, w ?? 0))}%`, background: color }} />
      {mark != null ? <i aria-hidden className="absolute -top-1 -bottom-1 w-0.5 bg-rn-ink-2" style={{ left: `calc(${Math.min(100, mark)}% - 1px)` }} /> : null}
    </span>
  );
}

// ══ 전환 변화 분해 ══

export function ConvChangeCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.change");
  const fmt = useConvFmt(view);
  const dc = view.decomp;
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("howTitle")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{t("chip", { days: view.days.length })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {dc ? (
          <>
            <Takeaway>{t("take", { d: fmt.signed(dc.d), volume: fmt.gap(dc.volume), rate: fmt.gap(dc.rate) })}</Takeaway>
            <Waterfall dc={dc} fmt={fmt} />
            <p className="m-0 mt-1 text-center text-rn-12 text-rn-muted tabular-nums">
              {t("basis", { s0: fmt.n(dc.prevSessions), s1: fmt.n(dc.sessions), p0: fmt.one(dc.prevPer100), p1: fmt.one(dc.per100) })}
            </p>
            <EngineShares dc={dc} fmt={fmt} />
          </>
        ) : (
          <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 break-keep text-rn-muted">{view.prevOk ? t("noTotals") : t("noPrev")}</p>
        )}
      </div>
    </RnCard>
  );
}

function Waterfall({ dc, fmt }: { dc: ConvDecomp; fmt: ConvFmt }) {
  const t = useTranslations("renewal.conversion.change.steps");
  const mid = dc.prevConv + dc.volume;
  const top = Math.max(1, dc.prevConv, dc.conv, mid);
  const steps = [
    { key: "prev", lo: 0, hi: dc.prevConv, value: fmt.n(dc.prevConv), color: PREV },
    { key: "volume", lo: Math.min(dc.prevConv, mid), hi: Math.max(dc.prevConv, mid), value: fmt.gap(dc.volume), color: dc.volume >= 0 ? UP : DOWN },
    { key: "rate", lo: Math.min(mid, dc.conv), hi: Math.max(mid, dc.conv), value: fmt.gap(dc.rate), color: dc.rate >= 0 ? UP : DOWN },
    { key: "cur", lo: 0, hi: dc.conv, value: fmt.n(dc.conv), color: AI_COLOR },
  ] as const;
  return (
    <div role="img" aria-label={t("aria", { prev: fmt.n(dc.prevConv), volume: fmt.gap(dc.volume), rate: fmt.gap(dc.rate), cur: fmt.n(dc.conv) })} className="grid grid-cols-4 gap-3 pt-5">
      {steps.map((s) => (
        <div key={s.key} data-rn-step={s.key} className="flex flex-col items-center gap-1.5">
          <div className="relative h-[120px] w-full border-b border-rn-line-2">
            <b className="absolute inset-x-0 text-center text-rn-12 font-bold text-rn-ink tabular-nums" style={{ bottom: `calc(${(s.hi / top) * 100}% + 3px)` }}>
              {s.value}
            </b>
            <i className="absolute inset-x-[22%] rounded-t" style={{ bottom: `${(s.lo / top) * 100}%`, height: `max(2px, ${((s.hi - s.lo) / top) * 100}%)`, background: s.color }} />
          </div>
          <span className="text-center text-rn-11 leading-tight font-semibold text-rn-muted">{t(s.key)}</span>
        </div>
      ))}
    </div>
  );
}

function EngineShares({ dc, fmt }: { dc: ConvDecomp; fmt: ConvFmt }) {
  const t = useTranslations("renewal.conversion.change");
  const parts = [...dc.engines.map((e) => ({ key: e.engine, label: fmt.engine(e.engine), d: e.d })), ...(dc.rest ? [{ key: "_rest", label: t("rest"), d: dc.rest }] : [])];
  if (!parts.length) return null;
  const max = Math.max(1, ...parts.map((p) => Math.abs(p.d)));
  return (
    <div className="mt-3 flex flex-col border-t border-rn-line pt-2.5">
      <h3 className="m-0 mb-1.5 text-rn-12 font-bold text-rn-muted">{t("sessionsTitle", { d: fmt.signed(dc.dSessions) })}</h3>
      {parts.map((p) => (
        <div key={p.key} data-rn-share={p.key} className="grid min-h-7 grid-cols-[minmax(84px,1fr)_minmax(0,2.4fr)_56px] items-center gap-2 text-rn-12">
          <span className="truncate font-semibold text-rn-ink-2">{p.label}</span>
          <span className="grid grid-cols-2">
            <span className="flex justify-end border-r border-rn-line-2">
              {p.d < 0 ? <i className="block h-2 rounded-l" style={{ width: `${(Math.abs(p.d) / max) * 100}%`, background: DOWN }} /> : null}
            </span>
            <span className="flex">{p.d > 0 ? <i className="block h-2 rounded-r" style={{ width: `${(p.d / max) * 100}%`, background: UP }} /> : null}</span>
          </span>
          <b className="text-right font-bold tabular-nums">{fmt.signed(p.d)}</b>
        </div>
      ))}
    </div>
  );
}

// ══ 기기 · 신규/재방문 ══

type SegKind = "device" | "visitorType";
// colour follows the value (never its rank), the renewal palette in this order; anything else grey
const SEG_COLORS: Record<string, string> = { desktop: "#002c5f", mobile: "#1baf7a", tablet: "#eb6834", "smart tv": "#6250d6", new: "#002c5f", returning: "#1baf7a" };
const SEG_KEYS: Record<string, "desktop" | "mobile" | "tablet" | "smartTv" | "new" | "returning" | "notSet"> = {
  desktop: "desktop", mobile: "mobile", tablet: "tablet", "smart tv": "smartTv", new: "new", returning: "returning", "(not set)": "notSet",
};
const DARK = new Set(["#002c5f", "#6250d6"]);

export function ConvSegmentCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.segments");
  const fmt = useConvFmt(view);
  const [kind, setKind] = useState<SegKind>("device");
  const rows = view.segments[kind];
  const name = (v: string) => (SEG_KEYS[v] ? t(`values.${SEG_KEYS[v]}`) : v);
  const color = (v: string) => SEG_COLORS[v] ?? GREY;
  const top = rows.find((r) => r.aiShare != null && r.genShare != null);
  const grid = "grid grid-cols-[minmax(80px,1fr)_56px_56px_60px_60px_60px] items-center gap-2";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead
        title={t("title")}
        info={<NoteTip title={t("title")}>{t("info")}</NoteTip>}
        controls={
          <RnSegmented<SegKind>
            value={kind}
            onChange={setKind}
            label={t("tabsLabel")}
            items={[
              { value: "device", label: t("tabs.device") },
              { value: "visitorType", label: t("tabs.visitorType") },
            ]}
          />
        }
      />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {rows.length ? (
          <>
            {top ? <Takeaway>{t("take", { value: name(top.value), ai: fmt.pct(top.aiShare, 0), gen: fmt.pct(top.genShare, 0) })}</Takeaway> : null}
            <div className="flex flex-col gap-1.5 py-1">
              <MixBar label={t("cohorts.ai")} rows={rows} pick={(r) => r.aiShare} name={name} color={color} fmt={fmt} />
              <MixBar label={t("cohorts.gen")} rows={rows} pick={(r) => r.genShare} name={name} color={color} fmt={fmt} />
              <span className="pl-[80px]">
                <Legend items={rows.map((r) => ({ label: name(r.value), color: color(r.value) }))} />
              </span>
            </div>
            <Head grid={grid} cols={[[t("cols.value")], [t("cols.aiShare"), "r"], [t("cols.genShare"), "r"], [t("cols.gap"), "r"], [t("cols.aiPer100"), "r"], [t("cols.genPer100"), "r"]]} />
            {rows.map((r) => (
              <div key={r.value} data-rn-segment={r.value} className={cx(grid, "min-h-8 border-b border-rn-line text-rn-13 last:border-b-0")}>
                <span className="flex min-w-0 items-center gap-2">
                  <i aria-hidden className="inline-block size-2.5 flex-none rounded-sm" style={{ background: color(r.value) }} />
                  <b className="truncate font-semibold">{name(r.value)}</b>
                </span>
                <span className="text-right font-semibold tabular-nums">{fmt.pct(r.aiShare, 0)}</span>
                <span className="text-right text-rn-ink-2 tabular-nums">{fmt.pct(r.genShare, 0)}</span>
                <span className="text-right tabular-nums">{r.mixGap == null ? "—" : t("pp", { n: fmt.gap(r.mixGap) })}</span>
                <span className="text-right font-semibold tabular-nums">{fmt.one(r.aiPer100)}</span>
                <span className="text-right text-rn-ink-2 tabular-nums">{fmt.one(r.genPer100)}</span>
              </div>
            ))}
          </>
        ) : (
          <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("none")}</p>
        )}
        <p className="m-0 mt-2 text-rn-11 break-keep text-rn-muted">{t("note")}</p>
      </div>
    </RnCard>
  );
}

function MixBar({ label, rows, pick, name, color, fmt }: {
  label: string;
  rows: ConvSegment[];
  pick: (r: ConvSegment) => number | null;
  name: (v: string) => string;
  color: (v: string) => string;
  fmt: ConvFmt;
}) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
      <span className="text-rn-12 font-semibold text-rn-ink-2">{label}</span>
      <span className="flex h-5 gap-0.5 overflow-hidden rounded">
        {rows.map((r) => {
          const w = pick(r);
          if (!w) return null;
          return (
            <span key={r.value} title={`${name(r.value)} ${fmt.pct(w)}`} className="grid min-w-0 place-items-center overflow-hidden text-rn-11 font-bold text-white" style={{ width: `${w}%`, background: color(r.value) }}>
              {w >= 10 && DARK.has(color(r.value)) ? fmt.pct(w, 0) : ""}
            </span>
          );
        })}
      </span>
    </div>
  );
}

// ══ 측정 원자료 · 기간 사용자 ══

export function ConvRawCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.raw");
  const fmt = useConvFmt(view);
  const [open, setOpen] = useState(false);
  const lengths = useMemo(() => [...new Set(view.windows.map((w) => w.days))].sort((a, b) => b - a), [view.windows]);
  const [len, setLen] = useState<string>(String(lengths[0] ?? ""));
  const [more, setMore] = useState(false);
  const all = view.windows.filter((w) => String(w.days) === len);
  const rows = more ? all : all.slice(0, RAW_ROWS);
  const grid = "grid grid-cols-[88px_52px_minmax(110px,1.2fr)_72px_minmax(120px,1.6fr)_72px_76px] items-center gap-2";
  const cohort = (c: string) => (c === "ai" || c === "general" || c === "total" ? t(`cohort.${c}`) : c);
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead
        title={t("title")}
        info={<NoteTip title={t("title")}>{t("info")}</NoteTip>}
        chips={<RnBasisChip>{t("chip", { n: view.windows.length })}</RnBasisChip>}
        controls={
          <RnButton onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? t("close") : t("open")}
          </RnButton>
        }
      />
      {open ? (
        <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
          {lengths.length ? (
            <>
              <div className="mb-2">
                <RnSegmented
                  value={len}
                  onChange={(v) => {
                    setLen(v);
                    setMore(false);
                  }}
                  label={t("lengthLabel")}
                  items={lengths.map((d) => ({ value: String(d), label: t("daysN", { n: d }) }))}
                />
              </div>
              <Head grid={grid} cols={[[t("cols.end")], [t("cols.days"), "r"], [t("cols.place")], [t("cols.cohort")], [t("cols.page")], [t("cols.users"), "r"], [t("cols.filter"), "r"]]} />
              {rows.map((w: ConvWindow, i) => (
                <div key={`${w.end}|${w.id}|${w.cohort}|${w.page}|${i}`} data-rn-window="" className={cx(grid, "min-h-8 border-b border-rn-line text-rn-12 last:border-b-0")}>
                  <span className="tabular-nums">{w.end}</span>
                  <span className="text-right tabular-nums">{t("daysN", { n: w.days })}</span>
                  <span className="truncate" title={w.id ?? ""}>{fmt.place(w)}</span>
                  <span>{cohort(w.cohort)}</span>
                  <span className="truncate text-rn-ink-2" title={w.page ?? ""}>{w.page ?? t("pageAll")}</span>
                  <b className="text-right font-bold tabular-nums">{fmt.n(w.users)}</b>
                  <span className="text-right text-rn-muted">{w.all ? t("all") : t("masked")}</span>
                </div>
              ))}
              <MoreButton more={more} n={more ? 1 : all.length - RAW_ROWS} onClick={() => setMore((m) => !m)} />
            </>
          ) : (
            <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("none")}</p>
          )}
        </div>
      ) : null}
    </RnCard>
  );
}

