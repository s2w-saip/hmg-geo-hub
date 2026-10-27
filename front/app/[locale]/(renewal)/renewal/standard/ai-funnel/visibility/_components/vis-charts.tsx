"use client";

// Charts of the renewal AI Visibility page, in the renewal look (components/renewal-ui/charts.tsx:
// recessive grid, rn tokens, the dark list tooltip). Geometry only — every value and label comes in
// through props.

import type { ReactNode } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { rnNiceTicks } from "@/components/renewal-ui";

const TICK = { fontSize: 11, fill: "var(--color-rn-muted)" } as const;

export interface VisSeries {
  key: string;
  name: string;
  color: string;
  values: ReadonlyArray<number>;
}

function TipBox({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-[160px] rounded-[10px] bg-rn-ink px-3 py-2.5 text-rn-12 text-white shadow-rn-3">
      <b className="mb-1 block text-rn-11 font-semibold text-rn-sky">{title}</b>
      {children}
    </div>
  );
}

function TipRow({ color, value, name, bold }: { color: string; value: string; name: string; bold?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-px">
      <i aria-hidden className="inline-block size-2 rounded-sm" style={{ background: color === "#002c5f" ? "#aacae6" : color }} />
      <b className={bold ? "font-bold" : "font-semibold"}>{value}</b>
      <span className="text-white/80">{name}</span>
    </div>
  );
}

/** Stacked areas over days (absolute values). */
export function VisStackChart({
  x,
  series,
  height,
  yTick,
  value,
  title,
  totalLabel,
  ariaLabel,
}: {
  x: ReadonlyArray<string>;
  series: ReadonlyArray<VisSeries>;
  height: number;
  yTick: (v: number) => string;
  value: (v: number) => string;
  title: (i: number) => string;
  totalLabel: string;
  ariaLabel: string;
}) {
  const data = x.map((label, i) => ({ i, x: label, ...Object.fromEntries(series.map((s) => [s.key, s.values[i] ?? 0])) }));
  const top = Math.max(1, ...x.map((_, i) => series.reduce((s, r) => s + (r.values[i] ?? 0), 0)));
  const ticks = rnNiceTicks(0, top, 4);
  return (
    <div role="img" aria-label={ariaLabel} className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-rn-line)" />
          <XAxis dataKey="x" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28} />
          <YAxis width={44} tick={TICK} tickLine={false} axisLine={false} domain={[0, ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={yTick} />
          <Tooltip
            cursor={{ stroke: "var(--color-rn-faint)", strokeDasharray: "3 3" }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const i = (payload[0].payload as { i: number }).i;
              const rows = series.map((s) => ({ s, v: s.values[i] ?? 0 })).sort((a, b) => b.v - a.v);
              return (
                <TipBox title={title(i)}>
                  {rows.map(({ s, v }) => (
                    <TipRow key={s.key} color={s.color} value={value(v)} name={s.name} />
                  ))}
                  <div className="mt-1 border-t border-white/15 pt-1">
                    <TipRow color="transparent" value={value(rows.reduce((a, r) => a + r.v, 0))} name={totalLabel} bold />
                  </div>
                </TipBox>
              );
            }}
          />
          {series.map((s) => (
            <Area key={s.key} dataKey={s.key} name={s.name} stackId="a" stroke="none" fill={s.color} fillOpacity={0.9} isAnimationActive={false} activeDot={false} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 100 % stacked columns (shares per block). */
export function VisShareColumns({
  x,
  series,
  height,
  title,
  ariaLabel,
}: {
  x: ReadonlyArray<string>;
  series: ReadonlyArray<VisSeries>;
  height: number;
  title: (i: number) => string;
  ariaLabel: string;
}) {
  const data = x.map((label, i) => ({ i, x: label, ...Object.fromEntries(series.map((s) => [s.key, s.values[i] ?? 0])) }));
  return (
    <div role="img" aria-label={ariaLabel} className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="38%">
          <CartesianGrid vertical={false} stroke="var(--color-rn-line)" />
          <XAxis dataKey="x" tick={TICK} tickLine={false} axisLine={false} />
          <YAxis width={40} tick={TICK} tickLine={false} axisLine={false} domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v: number) => `${v}%`} />
          <Tooltip
            cursor={{ fill: "var(--color-rn-navy-25)" }}
            isAnimationActive={false}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const i = (payload[0].payload as { i: number }).i;
              return (
                <TipBox title={title(i)}>
                  {[...series]
                    .sort((a, b) => (b.values[i] ?? 0) - (a.values[i] ?? 0))
                    .map((s) => (
                      <TipRow key={s.key} color={s.color} value={`${(s.values[i] ?? 0).toFixed(1)}%`} name={s.name} />
                    ))}
                </TipBox>
              );
            }}
          />
          {series.map((s, j) => (
            <Bar key={s.key} dataKey={s.key} name={s.name} stackId="a" fill={s.color} isAnimationActive={false} radius={j === series.length - 1 ? [4, 4, 0, 0] : 0} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface VisDot {
  key: string;
  seo: number;
  ai: number;
  color: string;
  big: boolean;
  tip: ReactNode;
}

const lg = (v: number) => Math.log10(v + 1);

/**
 * Pages on log axes (검색 노출 × AI 크롤, 0 on the first line) with the baseline y = rate·x and
 * its half, straight lines in log space drawn where they are inside the plot.
 */
export function VisLogScatter({
  dots,
  rate,
  height,
  tick,
  xTitle,
  yTitle,
  lineLabel,
  halfLabel,
  ariaLabel,
}: {
  dots: ReadonlyArray<VisDot>;
  rate: number;
  height: number;
  tick: (v: number) => string;
  xTitle: string;
  yTitle: string;
  lineLabel: string;
  halfLabel: string;
  ariaLabel: string;
}) {
  const xMax = Math.max(2, Math.ceil(lg(Math.max(1, ...dots.map((d) => d.seo)))));
  const yMax = Math.max(2, Math.ceil(lg(Math.max(1, ...dots.map((d) => d.ai)))));
  const ticksX = Array.from({ length: xMax + 1 }, (_, e) => e);
  const ticksY = Array.from({ length: yMax + 1 }, (_, e) => e);
  const line = (k: number) => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i <= 60; i++) {
      const xv = 10 ** ((i / 60) * xMax) - 1;
      const yv = k * rate * xv;
      if (yv >= 1 && lg(yv) <= yMax) out.push({ x: lg(xv), y: lg(yv) });
    }
    return out;
  };
  const data = [...dots].sort((a, b) => Number(a.big) - Number(b.big)).map((d) => ({ x: lg(d.seo), y: lg(d.ai), d }));
  const full = line(1);
  const half = line(0.5);
  const label = (pts: { x: number; y: number }[], text: string, below: boolean) =>
    pts.length ? <ReferenceDot x={pts[0].x} y={pts[0].y} r={0} label={{ value: text, position: below ? "bottom" : "top", fontSize: 11, fill: "var(--color-rn-muted)", fontWeight: 600 }} /> : null;
  return (
    <div role="img" aria-label={ariaLabel} className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 22, right: 16, bottom: 16, left: 0 }}>
          <CartesianGrid stroke="var(--color-rn-line)" />
          <XAxis type="number" dataKey="x" domain={[0, xMax]} ticks={ticksX} tickFormatter={(e: number) => (e ? tick(10 ** e) : "0")} tick={TICK} tickLine={false} axisLine={false}
            label={{ value: xTitle, position: "insideBottomRight", offset: -8, fontSize: 12, fill: "var(--color-rn-ink-2)", fontWeight: 600 }} />
          <YAxis type="number" dataKey="y" width={48} domain={[0, yMax]} ticks={ticksY} tickFormatter={(e: number) => (e ? tick(10 ** e) : "0")} tick={TICK} tickLine={false} axisLine={false}
            label={{ value: yTitle, position: "top", offset: 10, fontSize: 12, fill: "var(--color-rn-ink-2)", fontWeight: 600, dx: 24 }} />
          <Tooltip
            cursor={false}
            isAnimationActive={false}
            content={({ active, payload }) => {
              const d = (payload?.[0]?.payload as { d?: VisDot } | undefined)?.d;
              return active && d ? <div className="max-w-[300px] rounded-[10px] bg-rn-ink px-3 py-2.5 text-rn-12 text-white shadow-rn-3">{d.tip}</div> : null;
            }}
          />
          <Scatter data={full} line={{ stroke: "var(--color-rn-ink-2)", strokeWidth: 1.5 }} shape={() => <g />} isAnimationActive={false} legendType="none" tooltipType="none" />
          <Scatter data={half} line={{ stroke: "var(--color-rn-faint)", strokeWidth: 1.5, strokeDasharray: "4 4" }} shape={() => <g />} isAnimationActive={false} legendType="none" tooltipType="none" />
          <Scatter
            data={data}
            isAnimationActive={false}
            shape={(p: { cx?: number; cy?: number; payload?: { d: VisDot } }) =>
              p.cx == null || p.cy == null || !p.payload ? <g /> : (
                <circle cx={p.cx} cy={p.cy} r={p.payload.d.big ? 5 : 3.5} fill={p.payload.d.color} fillOpacity={0.85} stroke="#fff" strokeWidth={p.payload.d.big ? 1.5 : 1} />
              )
            }
          />
          {label(full, lineLabel, false)}
          {label(half, halfLabel, true)}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Lorenz curve of a share (x = pages from the fewest, y = cumulative share) with the equality line;
 * `mark` (the top 10 % share) is a dot and a guide at x = 0.9 — its number sits beside the chart.
 */
export function VisLorenz({
  points,
  mark,
  height,
  equalLabel,
  xTitle,
  ariaLabel,
}: {
  points: ReadonlyArray<[number, number]>;
  mark: number | null;
  height: number;
  equalLabel: string;
  xTitle: string;
  ariaLabel: string;
}) {
  const data = points.map(([x, y]) => ({ x, y }));
  const pctTick = (v: number) => `${Math.round(v * 100)}%`;
  const y9 = mark == null ? null : 1 - mark / 100;
  return (
    <div role="img" aria-label={ariaLabel} className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 12, bottom: 12, left: 0 }}>
          <CartesianGrid stroke="var(--color-rn-line)" />
          <XAxis type="number" dataKey="x" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={pctTick} tick={TICK} tickLine={false} axisLine={false}
            label={{ value: xTitle, position: "insideBottomRight", offset: -8, fontSize: 11, fill: "var(--color-rn-muted)" }} />
          <YAxis type="number" width={40} domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={pctTick} tick={TICK} tickLine={false} axisLine={false} />
          <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="var(--color-rn-faint)" strokeDasharray="4 4" />
          <ReferenceDot x={0.3} y={0.3} r={0} label={{ value: equalLabel, position: "left", offset: 8, fontSize: 11, fill: "var(--color-rn-muted)", fontWeight: 600 }} />
          <Area dataKey="y" type="linear" stroke="none" fill="#002c5f" fillOpacity={0.08} isAnimationActive={false} activeDot={false} tooltipType="none" />
          <Line dataKey="y" type="linear" stroke="#002c5f" strokeWidth={2} dot={false} isAnimationActive={false} activeDot={false} />
          {y9 != null ? (
            <>
              <ReferenceLine segment={[{ x: 0, y: y9 }, { x: 0.9, y: y9 }]} stroke="#002c5f" strokeDasharray="2 3" />
              <ReferenceDot x={0.9} y={y9} r={4} fill="#002c5f" stroke="#fff" strokeWidth={2} />
            </>
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
