"use client";

// The white cards of the renewal AI Conversion page under the summary: daily trend (chart or table), AI engines,
// markets (GA4 properties), landing pages, conversion events. Display only: every value comes from the screen model.

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { RnBasisChip, RnButton, RnCard, RnCardHead, RnDeltaChip, RnLineChart, RnSegmented, cx, rnNiceTicks } from "@/components/renewal-ui";
import type { ConvView } from "../_data/screen-types";
import { DefTip, NoteTip, StatusTag, range, useConvFmt } from "./conv-body";

// the validated renewal palette in rank order, grey beyond it; AI = navy, 일반 (the benchmark) = grey
const ENGINE_COLORS = ["#002c5f", "#1baf7a", "#eb6834", "#6250d6"];
export const GREY = "#c9c3bb";
export const AI_COLOR = "#002c5f";
export const GEN_COLOR = "#939393";
export const engineColor = (i: number) => ENGINE_COLORS[i] ?? GREY;
const PAGE_ROWS = 10;
const EVENT_ROWS = 8;

const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8)}`;

/** Counts and rates start at 0: an axis zoomed around the values would blow up a small day-to-day move. */
function fromZero(values: ReadonlyArray<number | null>) {
  const hi = Math.max(0, ...values.filter((v): v is number => v != null));
  const ticks = rnNiceTicks(0, hi > 0 ? hi : 1, 4);
  return { lo: 0, hi: ticks[ticks.length - 1], ticks };
}

export function useDeltaLabels() {
  const t = useTranslations("renewal.conversion.delta");
  return { up: t("up"), down: t("down"), flat: t("flat") };
}

export function Bar({ w, color = AI_COLOR }: { w: number | null; color?: string }) {
  return (
    <span className="block h-2 overflow-hidden rounded bg-rn-page">
      <i className="block h-full rounded" style={{ width: `${Math.max(0, Math.min(100, w ?? 0))}%`, background: color }} />
    </span>
  );
}

export function Head({ grid, cols }: { grid: string; cols: [ReactNode, string?][] }) {
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

export function MoreButton({ more, n, onClick }: { more: boolean; n: number; onClick: () => void }) {
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

/** The card's one-line reading of its own numbers (shown in dense mode too, unlike RnCardHead's sub). */
export function Takeaway({ children }: { children: ReactNode }) {
  return <p className="m-0 mb-2 rounded-lg bg-rn-navy-25 px-3 py-1.5 text-rn-12 leading-[1.5] font-semibold break-keep text-rn-ink-2">{children}</p>;
}

/** Legend swatches (identity is never colour alone: every swatch carries its name). */
export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-rn-11 text-rn-muted">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          {it.dashed ? (
            <i aria-hidden className="inline-block h-0 w-3.5 border-t-2 border-dashed" style={{ borderColor: it.color }} />
          ) : (
            <i aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: it.color }} />
          )}
          {it.label}
        </span>
      ))}
    </span>
  );
}

function Delta({ show, d, format }: { show: boolean; d: number | null; format: (r: number) => string }) {
  const labels = useDeltaLabels();
  return <span className="flex justify-end">{show ? <RnDeltaChip delta={d} format={format} emptyText="−" labels={labels} /> : <span className="text-rn-muted">−</span>}</span>;
}

// ══ 일별 추이 ══

type TrendMode = "chart" | "table";

export function ConvTrendCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion");
  const fmt = useConvFmt(view);
  const [mode, setMode] = useState<TrendMode>("chart");
  const x = view.days.map(md);
  const title = (d: string) => view.days[x.indexOf(d)] ?? d;
  const tr = view.trend;
  const rated = tr.rate.some((v) => v != null) || tr.genRate.some((v) => v != null);
  const shared = tr.share.some((v) => v != null);
  const h3 = "m-0 mb-1 text-rn-12 font-bold text-rn-muted";
  const none = "m-0 grid min-h-[150px] place-items-center rounded-[10px] bg-rn-page p-3.5 text-center text-rn-12 break-keep text-rn-muted";
  return (
    <RnCard aria-label={t("trend.title")}>
      <RnCardHead
        title={t("trend.title")}
        info={<NoteTip title={t("howToRead")}>{t("trend.info")}</NoteTip>}
        chips={<RnBasisChip>{range(t, view.days[0], view.days[view.days.length - 1])}</RnBasisChip>}
        controls={
          <RnSegmented<TrendMode>
            value={mode}
            onChange={setMode}
            label={t("trend.viewLabel")}
            items={[
              { value: "chart", label: t("trend.chart") },
              { value: "table", label: t("trend.table") },
            ]}
          />
        }
      />
      {mode === "chart" ? (
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 px-6 pb-5 @min-[980px]/rnpage:grid-cols-2 [.rn-dense_&]:px-4.5">
          <div>
            <h3 className={h3}>{t("trend.sessions")}</h3>
            <RnLineChart x={x} series={[{ key: "sessions", name: t("trend.sessions"), color: AI_COLOR, values: tr.sessions, own: true }]} height={150}
              yTick={fmt.n} value={(v) => t("unit.sessionsN", { n: fmt.n(v) })} tooltipTitle={title} ariaLabel={t("trend.sessions")} domain={fromZero(tr.sessions)} />
          </div>
          <div>
            <h3 className={h3}>{t("trend.conv")}</h3>
            <RnLineChart x={x} series={[{ key: "conv", name: t("trend.conv"), color: "#eb6834", values: tr.conv, own: true }]} height={150}
              yTick={fmt.n} value={(v) => t("unit.convN", { n: fmt.n(v) })} tooltipTitle={title} ariaLabel={t("trend.conv")} domain={fromZero(tr.conv)} />
          </div>
          <div>
            <h3 className={cx(h3, "flex flex-wrap items-center gap-x-3")}>
              {t("trend.rate")}
              {rated ? <Legend items={[{ label: t("trend.rateAi"), color: AI_COLOR }, { label: t("trend.rateGen"), color: GEN_COLOR, dashed: true }]} /> : null}
            </h3>
            {rated ? (
              <RnLineChart
                x={x}
                series={[
                  { key: "rate", name: t("trend.rateAi"), color: AI_COLOR, values: tr.rate, own: true },
                  { key: "genRate", name: t("trend.rateGen"), color: GEN_COLOR, values: tr.genRate, dashed: true },
                ]}
                height={150}
                yTick={(v) => `${v.toFixed(0)}%`}
                value={(v) => fmt.pct(v)}
                tooltipTitle={title}
                ariaLabel={t("trend.rate")}
                domain={fromZero([...tr.rate, ...tr.genRate])}
              />
            ) : (
              <p className={none}>{t("trend.rateNone")}</p>
            )}
          </div>
          <div>
            <h3 className={h3}>{t("trend.share")}</h3>
            {shared ? (
              <RnLineChart x={x} series={[{ key: "share", name: t("trend.share"), color: "#6250d6", values: tr.share, own: true }]} height={150}
                yTick={(v) => `${v.toFixed(1)}%`} value={(v) => fmt.pct(v, 2)} tooltipTitle={title} ariaLabel={t("trend.share")} domain={fromZero(tr.share)} />
            ) : (
              <p className={none}>{t("trend.shareNone")}</p>
            )}
          </div>
        </div>
      ) : (
        <TrendTable view={view} />
      )}
    </RnCard>
  );
}

/** Every daily value of the charts and the general / site columns, as numbers (the original screen's 일별 추이 table). */
function TrendTable({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.trend.cols");
  const fmt = useConvFmt(view);
  const tr = view.trend;
  const cols: [string, (i: number) => string, boolean?][] = [
    [t("aiSessions"), (i) => fmt.n(tr.sessions[i]), true],
    [t("aiUsers"), (i) => fmt.n(tr.users[i])],
    [t("aiConv"), (i) => fmt.n(tr.conv[i]), true],
    [t("aiRate"), (i) => fmt.pct(tr.rate[i]), true],
    [t("genSessions"), (i) => fmt.n(tr.genSessions[i])],
    [t("genUsers"), (i) => fmt.n(tr.genUsers[i])],
    [t("genConv"), (i) => fmt.n(tr.genConv[i])],
    [t("genRate"), (i) => fmt.pct(tr.genRate[i])],
    [t("site"), (i) => fmt.n(tr.site[i])],
    [t("share"), (i) => fmt.pct(tr.share[i], 2)],
  ];
  return (
    <div className="mx-6 mb-5 max-h-[420px] overflow-auto rounded-[10px] border border-rn-line [.rn-dense_&]:mx-4.5">
      <table data-rn-trend-table="" className="w-full border-collapse text-rn-12 tabular-nums">
        <thead className="sticky top-0 bg-rn-head text-rn-11 font-semibold text-rn-muted">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-semibold">{t("date")}</th>
            {cols.map(([label]) => (
              <th key={label} scope="col" className="px-3 py-2 text-right font-semibold whitespace-nowrap">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.days.map((d, i) => (
            <tr key={d} className="border-t border-rn-line">
              <th scope="row" className="px-3 py-1.5 text-left font-medium whitespace-nowrap text-rn-ink-2">{d}</th>
              {cols.map(([label, cell, strong]) => (
                <td key={label} className={cx("px-3 py-1.5 text-right", strong ? "font-semibold text-rn-ink" : "text-rn-ink-2")}>
                  {cell(i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ══ AI 엔진별 ══

export function ConvEngineCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.engine");
  const fmt = useConvFmt(view);
  const max = Math.max(1, ...view.engines.map((e) => e.sessions ?? 0));
  const grid = "grid grid-cols-[minmax(92px,1fr)_minmax(90px,1.3fr)_44px_44px_52px_60px_64px] items-center gap-2.5";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{t("chip", { n: view.engines.length })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {view.engines.length ? (
          <>
            <Head grid={grid} cols={[[t("cols.engine")], [t("cols.sessions")], [t("cols.share"), "r"], [t("cols.conv"), "r"], [t("cols.per100"), "r"], [t("cols.pps"), "r"], [t("cols.d"), "r"]]} />
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
                <span className="text-right tabular-nums">{fmt.two(e.pps)}</span>
                <Delta show={view.prevOk} d={e.d} format={(r) => `${Math.abs(r).toFixed(1)}%`} />
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

// ══ 시장(GA4 속성)별 ══

export function ConvPropCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.props");
  const fmt = useConvFmt(view);
  const max = Math.max(1, ...view.props.map((p) => p.sessions ?? 0));
  const grid = "grid grid-cols-[minmax(112px,1.3fr)_minmax(84px,1.1fr)_52px_56px_56px_56px_68px] items-center gap-2";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<NoteTip title={t("title")}>{t("info")}</NoteTip>} chips={<RnBasisChip>{t("chip", { active: view.coverage.active, total: view.coverage.total })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        <Head grid={grid} cols={[[t("cols.prop")], [t("cols.sessions")], [t("cols.users"), "r"], [t("cols.rate"), "r"], [t("cols.genRate"), "r"], [<DefTipLabel key="lift" label={t("cols.lift")} />, "r"], [t("cols.status"), "r"]]} />
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
            <span className="text-right font-semibold tabular-nums">{fmt.pct(p.rate)}</span>
            <span className="text-right text-rn-ink-2 tabular-nums">{fmt.pct(p.genRate)}</span>
            <span className="text-right font-semibold tabular-nums">{p.lift == null ? "—" : t("pp", { n: fmt.gap(p.lift) })}</span>
            <span className="flex justify-end">
              <StatusTag status={p.status} />
            </span>
          </div>
        ))}
      </div>
    </RnCard>
  );
}

function DefTipLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center justify-end gap-0.5">
      {label}
      <DefTip k="lift" align="end" />
    </span>
  );
}

// ══ AI 유입 입구 페이지 ══

export function ConvPageCard({ view }: { view: ConvView }) {
  const t = useTranslations("renewal.conversion.pages");
  const fmt = useConvFmt(view);
  const [more, setMore] = useState(false);
  const rows = more ? view.pages : view.pages.slice(0, PAGE_ROWS);
  const max = Math.max(1, ...view.pages.map((p) => p.sessions ?? 0));
  const top = view.pages[0];
  const grid = "grid grid-cols-[24px_minmax(180px,2.4fr)_minmax(100px,1.1fr)_44px_44px_64px_68px_64px_64px_80px_60px] items-center gap-2";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead title={t("title")} info={<DefTip k="landing" />} chips={<RnBasisChip>{t("chip", { n: view.pages.length })}</RnBasisChip>} />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {view.pages.length ? (
          <>
            {top && top.aiOfPage != null ? (
              <Takeaway>
                {top.aiKe100 != null && top.genKe100 != null
                  ? t("take", { page: top.path, share: fmt.pct(top.aiOfPage), ai: fmt.one(top.aiKe100), gen: fmt.one(top.genKe100) })
                  : t("takeShare", { page: top.path, share: fmt.pct(top.aiOfPage) })}
              </Takeaway>
            ) : null}
            <div className={cx(grid, "text-rn-11 font-semibold text-rn-muted")}>
              <span className="col-span-7" />
              <span className="col-span-2 flex items-center justify-center gap-0.5 border-b border-rn-line-2 pb-0.5 whitespace-nowrap">
                {t("cols.keGroup")}
                <DefTip k="ke100" align="end" />
              </span>
              <span className="col-span-2" />
            </div>
            <Head grid={grid} cols={[["#"], [t("cols.page")], [t("cols.sessions")], [t("cols.share"), "r"], [t("cols.cum"), "r"], [t("cols.aiOfPage"), "r"], [t("cols.genSessions"), "r"], [t("cols.aiKe100"), "r"], [t("cols.genKe100"), "r"], [t("cols.views"), "r"], [t("cols.d"), "r"]]} />
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
                <span className="text-right tabular-nums">{fmt.pct(p.aiOfPage)}</span>
                <span className="text-right text-rn-ink-2 tabular-nums">{fmt.n(p.genSessions)}</span>
                <span className="text-right font-semibold tabular-nums">{fmt.one(p.aiKe100)}</span>
                <span className="text-right text-rn-ink-2 tabular-nums">{fmt.one(p.genKe100)}</span>
                <span className="text-right tabular-nums">{fmt.n(p.views)}</span>
                <Delta show={view.prevOk} d={p.d} format={(r) => fmt.n(Math.abs(r))} />
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
  const grid = "grid grid-cols-[minmax(140px,1.5fr)_72px_minmax(100px,1.4fr)_76px_48px_56px] items-center gap-2";
  return (
    <RnCard aria-label={t("title")}>
      <RnCardHead
        title={t("title")}
        info={<NoteTip title={t("title")}>{t("info")}</NoteTip>}
        chips={<RnBasisChip>{t("chip", { n: tracked, sum: fmt.n(view.tracked) })}</RnBasisChip>}
        controls={<Legend items={[{ label: t("ai"), color: AI_COLOR }, { label: t("gen"), color: GEN_COLOR }]} />}
      />
      <div className="flex flex-col px-6 pb-4.5 [.rn-dense_&]:px-4.5">
        {view.events.length ? (
          <>
            <Head grid={grid} cols={[[t("cols.event")], [t("cols.kind")], [""], [t("cols.count"), "r"], [t("cols.aiShare"), "r"], [t("cols.share"), "r"]]} />
            {rows.map((e) => {
              const w = e.count == null ? 0 : (e.count / (e.tracked ? top.tracked : top.other)) * 100;
              const split = e.aiCount != null && e.genCount != null && e.count ? (e.aiCount / e.count) * 100 : null;
              return (
                <div key={e.event} data-rn-event={e.event} className={cx(grid, "min-h-9 border-b border-rn-line text-rn-13 last:border-b-0")}>
                  <code className="truncate font-mono text-rn-12 text-rn-ink-2">{e.event}</code>
                  <span>
                    {e.tracked ? <span className="inline-flex h-5 items-center rounded bg-rn-navy-50 px-1.5 text-rn-11 font-bold text-rn-navy">{t("tracked")}</span> : null}
                  </span>
                  <span className="block h-2 overflow-hidden rounded bg-rn-page" title={t("splitTip", { ai: fmt.n(e.aiCount), gen: fmt.n(e.genCount) })}>
                    <span className="flex h-full gap-px" style={{ width: `${Math.max(0, Math.min(100, w))}%` }}>
                      {split == null ? (
                        <i className="block h-full w-full rounded" style={{ background: GREY }} />
                      ) : (
                        <>
                          {split > 0 ? <i className="block h-full rounded-l" style={{ width: `${split}%`, background: AI_COLOR }} /> : null}
                          {split < 100 ? <i className="block h-full flex-1 rounded-r" style={{ background: GEN_COLOR }} /> : null}
                        </>
                      )}
                    </span>
                  </span>
                  <b className="text-right font-bold tabular-nums">{fmt.n(e.count)}</b>
                  <span className="text-right tabular-nums">{fmt.pct(e.aiShare, 0)}</span>
                  <span className="text-right text-rn-12 text-rn-muted tabular-nums">{fmt.pct(e.share, 0)}</span>
                </div>
              );
            })}
            <MoreButton more={more} n={more ? 1 : view.events.length - EVENT_ROWS} onClick={() => setMore((m) => !m)} />
          </>
        ) : (
          <p className="m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted">{t("none")}</p>
        )}
      </div>
    </RnCard>
  );
}
