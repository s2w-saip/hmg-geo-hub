"use client";

// The white cards of the renewal AI Conversion page under the summary: daily trend, AI engines, GA4 properties,
// landing pages, conversion events. Display only: every value comes from the screen model.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { RnBasisChip, RnButton, RnCard, RnCardHead, RnDeltaChip, RnLineChart, cx, rnNiceTicks } from "@/components/renewal-ui";
import type { ConvView } from "../_data/screen-types";
import { DefTip, NoteTip, StatusTag, range, useConvFmt } from "./conv-body";

// the validated renewal palette in rank order, grey beyond it
const ENGINE_COLORS = ["#002c5f", "#1baf7a", "#eb6834", "#6250d6"];
const GREY = "#c9c3bb";
const engineColor = (i: number) => ENGINE_COLORS[i] ?? GREY;
const PAGE_ROWS = 10;
const EVENT_ROWS = 8;

const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8)}`;

/** Counts and rates start at 0: an axis zoomed around the values would blow up a small day-to-day move. */
function fromZero(values: ReadonlyArray<number | null>) {
  const hi = Math.max(0, ...values.filter((v): v is number => v != null));
  const ticks = rnNiceTicks(0, hi > 0 ? hi : 1, 4);
  return { lo: 0, hi: ticks[ticks.length - 1], ticks };
}

function useDeltaLabels() {
  const t = useTranslations("renewal.conversion.delta");
  return { up: t("up"), down: t("down"), flat: t("flat") };
}

function Bar({ w, color = "#002c5f" }: { w: number | null; color?: string }) {
  return (
    <span className="block h-2 overflow-hidden rounded bg-rn-page">
      <i className="block h-full rounded" style={{ width: `${Math.max(0, Math.min(100, w ?? 0))}%`, background: color }} />
    </span>
  );
}

function Head({ grid, cols }: { grid: string; cols: [string, string?][] }) {
  return (
    <div className={cx(grid, "min-h-[30px] border-b border-rn-line text-rn-11 font-semibold text-rn-muted")}>
      {cols.map(([label, align], i) => (
        <span key={i} className={align === "r" ? "text-right" : undefined}>
          {label}
        </span>
      ))}
    </div>
  );
}

function MoreButton({ more, n, onClick }: { more: boolean; n: number; onClick: () => void }) {
  const t = useTranslations("renewal.conversion");
  if (n <= 0) return null;
  return (
    <div className="flex justify-center pt-2.5">
      <RnButton onClick={onClick} aria-expanded={more}>
        {more ? t("less") : t("more", { n })}
      </RnButton>
    </div>
  );
}

// ══ 일별 추이 ══

export function ConvTrendCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion");
  const fmt = useConvFmt(view);
  const x = view.days.map(md);
  const title = (d: string) => view.days[x.indexOf(d)] ?? d;
  const rated = view.trend.rate.some((v) => v != null);
  return (
    <RnCard aria-label={t("trend.title")}>
      <RnCardHead title={t("trend.title")} info={<NoteTip title={t("howToRead")}>{t("trend.info")}</NoteTip>} chips={<RnBasisChip>{range(t, view.days[0], view.days[view.days.length - 1])}</RnBasisChip>} />
      <div className="grid grid-cols-1 gap-x-6 px-6 pb-5 @min-[980px]/rnpage:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] [.rn-dense_&]:px-4.5">
        <div>
          <h3 className="m-0 mb-1 text-rn-12 font-bold text-rn-muted">{t("trend.sessions")}</h3>
          <RnLineChart x={x} series={[{ key: "sessions", name: t("trend.sessions"), color: "#002c5f", values: view.trend.sessions, own: true }]} height={236}
            yTick={fmt.n} value={(v) => t("unit.sessionsN", { n: fmt.n(v) })} tooltipTitle={title} ariaLabel={t("trend.sessions")} domain={fromZero(view.trend.sessions)} />
        </div>
        <div className="flex flex-col">
          <h3 className="m-0 mb-1 text-rn-12 font-bold text-rn-muted">{t("trend.conv")}</h3>
          <RnLineChart x={x} series={[{ key: "conv", name: t("trend.conv"), color: "#eb6834", values: view.trend.conv, own: true }]} height={104}
            yTick={fmt.n} value={(v) => t("unit.convN", { n: fmt.n(v) })} tooltipTitle={title} ariaLabel={t("trend.conv")} domain={fromZero(view.trend.conv)} />
          <h3 className="m-0 mt-2.5 mb-1 text-rn-12 font-bold text-rn-muted">{t("trend.rate")}</h3>
          {rated ? (
            <RnLineChart x={x} series={[{ key: "rate", name: t("trend.rateName"), color: "#6250d6", values: view.trend.rate }]} height={104}
              yTick={(v) => `${v.toFixed(0)}%`} value={(v) => fmt.pct(v)} tooltipTitle={title} ariaLabel={t("trend.rate")} domain={fromZero(view.trend.rate)} />
          ) : (
            <p className="m-0 grid min-h-[104px] place-items-center rounded-[10px] bg-rn-page p-3.5 text-center text-rn-12 break-keep text-rn-muted">{t("trend.rateNone")}</p>
          )}
        </div>
      </div>
    </RnCard>
  );
}

// ══ AI 엔진별 ══

export function ConvEngineCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.engine");
  const fmt = useConvFmt(view);
  const labels = useDeltaLabels();
  const max = Math.max(1, ...view.engines.map((e) => e.sessions ?? 0));
  const grid = "grid grid-cols-[minmax(96px,1fr)_minmax(90px,1.3fr)_48px_44px_52px_64px] items-center gap-2.5";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{t("chip", { n: view.engines.length })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {view.engines.length ? (
          <>
            <Head grid={grid} cols={[[t("cols.engine")], [t("cols.sessions")], [t("cols.share"), "r"], [t("cols.conv"), "r"], [t("cols.per100"), "r"], [t("cols.d"), "r"]]} />
            {view.engines.map((e, i) => (
              <div key={e.engine} data-rn-engine={e.engine} className={cx(grid, "min-h-9 border-b border-rn-line text-rn-13 last:border-b-0")}>
                <span className="flex min-w-0 items-center gap-2">
                  <i aria-hidden className="inline-block size-2.5 flex-none rounded-sm" style={{ background: engineColor(i) }} />
                  <b className="truncate font-semibold">{fmt.engine(e.engine)}</b>
                </span>
                <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                  <Bar w={e.sessions == null ? null : (e.sessions / max) * 100} color={engineColor(i)} />
                  <b className="text-right font-bold tabular-nums">{fmt.n(e.sessions)}</b>
                </span>
                <span className="text-right text-rn-12 text-rn-muted tabular-nums">{fmt.pct(e.share, 0)}</span>
                <span className="text-right tabular-nums">{fmt.n(e.conv)}</span>
                <span className="text-right font-semibold tabular-nums">{fmt.one(e.per100)}</span>
                <span className="flex justify-end">{view.prevOk ? <RnDeltaChip delta={e.d} format={(r) => `${Math.abs(r).toFixed(1)}%`} emptyText="−" labels={labels} /> : <span className="text-rn-muted">−</span>}</span>
              </div>
            ))}
          </>
        ) : (
          <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("none")}</p>
        )}
        <p className="m-0 mt-2 flex items-center gap-1 text-rn-11 break-keep text-rn-muted">
          <DefTip k="per100" />
          {view.engineRest != null ? t("rest", { n: fmt.n(view.engineRest) }) : t("per100Note")}
        </p>
      </div>
    </RnCard>
  );
}

// ══ GA4 속성 · 국가 ══

export function ConvPropCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.props");
  const fmt = useConvFmt(view);
  const max = Math.max(1, ...view.props.map((p) => p.sessions ?? 0));
  const grid = "grid grid-cols-[minmax(120px,1.3fr)_minmax(90px,1.2fr)_64px_72px] items-center gap-2.5";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{t("chip", { active: view.coverage.active, total: view.coverage.total })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        <Head grid={grid} cols={[[t("cols.prop")], [t("cols.sessions")], [t("cols.users"), "r"], [t("cols.status"), "r"]]} />
        {view.props.map((p) => (
          <div key={p.id} data-rn-prop={p.id} className={cx(grid, "min-h-11 border-b border-rn-line py-1 text-rn-13 last:border-b-0", p.status !== "active" && "text-rn-muted")}>
            <span className="flex min-w-0 flex-col">
              <b className="truncate font-semibold">{fmt.place(p)}</b>
              <small className="truncate text-rn-11 text-rn-muted">{t("idBasis", { id: p.id, basis: t(`basis.b${p.basis}`) })}</small>
            </span>
            <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <Bar w={p.sessions == null ? null : (p.sessions / max) * 100} />
              <span className="text-right tabular-nums">
                <b className="font-bold">{fmt.n(p.sessions)}</b>
                {p.share != null ? <small className="ml-1 text-rn-11 text-rn-muted">{fmt.pct(p.share, 0)}</small> : null}
              </span>
            </span>
            <span className="text-right tabular-nums">{fmt.n(p.users)}</span>
            <span className="flex justify-end">
              <StatusTag status={p.status} />
            </span>
          </div>
        ))}
      </div>
    </RnCard>
  );
}

// ══ AI 유입 입구 페이지 ══

export function ConvPageCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.pages");
  const fmt = useConvFmt(view);
  const labels = useDeltaLabels();
  const [more, setMore] = useState(false);
  const rows = more ? view.pages : view.pages.slice(0, PAGE_ROWS);
  const max = Math.max(1, ...view.pages.map((p) => p.sessions ?? 0));
  const grid = "grid grid-cols-[28px_minmax(200px,2.4fr)_minmax(110px,1.2fr)_52px_52px_84px_64px] items-center gap-2.5";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<DefTip k="landing" />} chips={<RnBasisChip>{t("chip", { n: view.pages.length })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {view.pages.length ? (
          <>
            <Head grid={grid} cols={[["#"], [t("cols.page")], [t("cols.sessions")], [t("cols.share"), "r"], [t("cols.cum"), "r"], [t("cols.views"), "r"], [t("cols.d"), "r"]]} />
            {rows.map((p, i) => (
              <div key={p.id} data-rn-page={p.id} className={cx(grid, "min-h-9 border-b border-rn-line text-rn-13 last:border-b-0")}>
                <span className="text-rn-12 text-rn-muted tabular-nums">{i + 1}</span>
                {/^https?:\/\//.test(p.url) ? (
                  <a href={p.url} target="_blank" rel="noreferrer" title={p.url} className="truncate text-rn-ink hover:text-rn-navy hover:underline">
                    {p.path}
                  </a>
                ) : (
                  <span title={p.url} className="truncate">
                    {p.path}
                  </span>
                )}
                <span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                  <Bar w={p.sessions == null ? null : (p.sessions / max) * 100} />
                  <b className="text-right font-bold tabular-nums">{fmt.n(p.sessions)}</b>
                </span>
                <span className="text-right text-rn-12 text-rn-muted tabular-nums">{fmt.pct(p.share, 0)}</span>
                <span className="text-right text-rn-12 text-rn-muted tabular-nums">{fmt.pct(p.cum, 0)}</span>
                <span className="text-right tabular-nums">{fmt.n(p.views)}</span>
                <span className="flex justify-end">
                  {view.prevOk ? <RnDeltaChip delta={p.d} format={(r) => fmt.n(Math.abs(r))} emptyText="−" labels={labels} /> : <span className="text-rn-muted">−</span>}
                </span>
              </div>
            ))}
            <MoreButton more={more} n={more ? 1 : view.pages.length - PAGE_ROWS} onClick={() => setMore((m) => !m)} />
          </>
        ) : (
          <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("none")}</p>
        )}
      </div>
    </RnCard>
  );
}

// ══ 전환 이벤트 ══

export function ConvEventCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.events");
  const fmt = useConvFmt(view);
  const [more, setMore] = useState(false);
  const rows = more ? view.events : view.events.slice(0, EVENT_ROWS);
  const tracked = view.events.filter((e) => e.tracked).length;
  // bars against the largest count of the row's own kind: page views would dwarf the conversion events
  const max = (k: boolean) => Math.max(1, ...view.events.filter((e) => e.tracked === k).map((e) => e.count ?? 0));
  const top = { tracked: max(true), other: max(false) };
  const grid = "grid grid-cols-[minmax(160px,1.6fr)_88px_minmax(110px,1.4fr)_96px_64px] items-center gap-2.5";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{t("chip", { n: tracked, sum: fmt.n(view.tracked) })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {view.events.length ? (
          <>
            <Head grid={grid} cols={[[t("cols.event")], [t("cols.kind")], [""], [t("cols.count"), "r"], [t("cols.share"), "r"]]} />
            {rows.map((e) => (
              <div key={e.event} data-rn-event={e.event} className={cx(grid, "min-h-9 border-b border-rn-line text-rn-13 last:border-b-0")}>
                <code className="truncate font-mono text-rn-12 text-rn-ink-2">{e.event}</code>
                <span>
                  {e.tracked ? <span className="inline-flex h-5 items-center rounded bg-rn-navy-50 px-1.5 text-rn-11 font-bold text-rn-navy">{t("tracked")}</span> : null}
                </span>
                <Bar w={e.count == null ? null : (e.count / (e.tracked ? top.tracked : top.other)) * 100} color={e.tracked ? "#002c5f" : GREY} />
                <b className="text-right font-bold tabular-nums">{fmt.n(e.count)}</b>
                <span className="text-right text-rn-12 text-rn-muted tabular-nums">{fmt.pct(e.share, 0)}</span>
              </div>
            ))}
            <MoreButton more={more} n={more ? 1 : view.events.length - EVENT_ROWS} onClick={() => setMore((m) => !m)} />
          </>
        ) : (
          <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("none")}</p>
        )}
      </div>
    </RnCard>
  );
}
