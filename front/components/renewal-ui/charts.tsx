"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  usePlotArea,
} from "recharts";

// Recharts wrapped in the renewal look (rn tokens): recessive grid and axes, 2px lines,
// direct end labels (text in ink, the line carries the colour; labels that would touch are
// spread apart), a list tooltip, and linked-highlight fading (`lit`). Numbers and labels
// come in through props (formatters), so the library holds no copy.

const TICK = { fontSize: 11, fill: "var(--color-rn-muted)" } as const;
const TEXT_W = (t: string, px = 12) => [...t].reduce((w, c) => w + (/[ㄱ-힝]/.test(c) ? px : px * 0.58), 0);

/** 0 / 1 / 2 / 2.5 / 5 × 10^n steps covering [lo, hi]. */
export function rnNiceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) {
    lo -= 1;
    hi += 1;
  }
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 0.5; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
  return out;
}

const lastIndex = (vs: ReadonlyArray<number | null>) => {
  for (let i = vs.length - 1; i >= 0; i--) if (vs[i] != null) return i;
  return -1;
};

export interface RnLineSeries {
  key: string;
  name: string;
  color: string;
  values: ReadonlyArray<number | null>;
  /** 당사: thicker, drawn on top, area wash. */
  own?: boolean;
  /** a reference series (e.g. a competitor average): dashed, thinner */
  dashed?: boolean;
}

/** Spread label centres so neighbours keep `gap` px apart (top to bottom, then pulled back up if they ran past `max`). */
function spread(ys: number[], gap: number, max: number): number[] {
  const order = ys.map((y, i) => [y, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const [y, i] of order) {
    out[i] = Math.max(y, prev + gap);
    prev = out[i];
  }
  const over = prev - max;
  if (over > 0) for (const [, i] of order) out[i] -= over;
  return out;
}

/** The data row's key holding its index on x (the tooltip note's argument). */
const ROW_INDEX = "__rnRow";

/** The chart's tooltip (exported for its render test). */
export function TrendTooltip({
  active,
  payload,
  label,
  series,
  value,
  title,
  note,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown; payload?: Record<string, unknown> }>;
  label?: unknown;
  series: ReadonlyArray<RnLineSeries>;
  value: (v: number) => string;
  title: (x: string) => string;
  note?: (index: number) => ReadonlyArray<string> | null;
}) {
  if (!active || !payload?.length) return null;
  const rows = series
    .map((s) => ({ s, v: payload.find((p) => p.dataKey === s.key)?.value }))
    .filter((r): r is { s: RnLineSeries; v: number } => typeof r.v === "number")
    .sort((a, b) => b.v - a.v);
  const at = payload[0]?.payload?.[ROW_INDEX];
  const lines = note && typeof at === "number" ? note(at) : null;
  return (
    <div className="min-w-[160px] rounded-[10px] bg-rn-ink px-3 py-2.5 text-rn-12 text-white shadow-rn-3">
      <b className="mb-1 block text-rn-11 font-semibold text-rn-sky">{title(String(label))}</b>
      {rows.map(({ s, v }) => (
        <div key={s.key} className="flex items-center gap-2 py-px">
          <i aria-hidden className="inline-block h-0.5 w-2.5 rounded" style={{ background: s.color === "#002c5f" ? "#aacae6" : s.color }} />
          <b className={s.own ? "font-bold" : "font-semibold"}>{value(v)}</b>
          <span className="text-white/80">{s.name}</span>
        </div>
      ))}
      {lines?.length ? (
        <div data-rn-tip-note="" className="mt-1 border-t border-white/15 pt-1 text-rn-11 text-white/80 tabular-nums">
          {lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Trend lines over categories (rounds / days). `null` breaks the line. End labels name
 * each series with its last value; `lit` fades the others (linked highlight).
 */
export function RnLineChart({
  x,
  series,
  height,
  yTick,
  value,
  tooltipTitle,
  ariaLabel,
  lit = [],
  onHover,
  invert = false,
  domain,
  tooltipNote,
}: {
  x: ReadonlyArray<string>;
  series: ReadonlyArray<RnLineSeries>;
  height: number;
  yTick: (v: number) => string;
  value: (v: number) => string;
  tooltipTitle: (x: string) => string;
  ariaLabel: string;
  lit?: ReadonlyArray<string>;
  onHover?: (key: string | null) => void;
  /** rank scales: lower values drawn higher (1 on top), no area wash */
  invert?: boolean;
  /** fixed y domain and ticks (default: nice ticks over the values, floor 0) */
  domain?: { lo: number; hi: number; ticks: number[] };
  /** lines under the tooltip's values for point `index` of x (e.g. that round's counts); none = no note */
  tooltipNote?: (index: number) => ReadonlyArray<string> | null;
}) {
  const nums = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const rawLo = nums.length ? Math.min(...nums) : 0;
  const rawHi = nums.length ? Math.max(...nums) : 1;
  const ticks = domain?.ticks ?? rnNiceTicks(Math.max(0, rawLo - (rawHi - rawLo) * 0.15), rawHi, 4);
  const lo = domain?.lo ?? ticks[0];
  const hi = domain?.hi ?? ticks[ticks.length - 1];
  const data = x.map((label, i) => ({ x: label, [ROW_INDEX]: i, ...Object.fromEntries(series.map((s) => [s.key, s.values[i] ?? null])) }));
  const fading = series.some((s) => lit.includes(s.key));
  const labelText = (s: RnLineSeries) => {
    const i = lastIndex(s.values);
    return i < 0 ? "" : `${s.name.length > 12 ? `${s.name.slice(0, 11)}…` : s.name} ${value(s.values[i]!)}`;
  };
  const right = Math.min(180, Math.max(64, ...series.map((s) => TEXT_W(labelText(s)) + 22)));
  const order = [...series].sort((a, b) => (a.own ? 1 : 0) - (b.own ? 1 : 0));
  return (
    <div role="img" aria-label={ariaLabel} className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right, bottom: 0, left: 0 }} onMouseLeave={() => onHover?.(null)}>
          <CartesianGrid vertical={false} stroke="var(--color-rn-line)" />
          {/* equal steps counted back from the latest round (preserveStartEnd thinned by fit alone: 7/6, 7/13, 7/27, 8/3 …) */}
          <XAxis dataKey="x" tick={TICK} tickLine={false} axisLine={false} interval="equidistantPreserveEnd" minTickGap={28} />
          <YAxis width={44} tick={TICK} tickLine={false} axisLine={false} domain={[lo, hi]} ticks={ticks} tickFormatter={yTick} reversed={invert} />
          <Tooltip
            cursor={{ stroke: "var(--color-rn-faint)", strokeDasharray: "3 3" }}
            content={<TrendTooltip series={series} value={value} title={tooltipTitle} note={tooltipNote} />}
            isAnimationActive={false}
          />
          {series
            .filter((s) => s.own && !invert)
            .map((s) => (
              <Area key={`a-${s.key}`} dataKey={s.key} fill={s.color} fillOpacity={fading && !lit.includes(s.key) ? 0.03 : 0.08} stroke="none" isAnimationActive={false} activeDot={false} tooltipType="none" />
            ))}
          {order.map((s) => {
            const dim = fading && !lit.includes(s.key);
            const li = lastIndex(s.values);
            return (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                strokeWidth={s.own ? 2.5 : s.dashed ? 1.5 : 2}
                strokeDasharray={s.dashed ? "4 3" : undefined}
                strokeOpacity={dim ? 0.16 : 1}
                isAnimationActive={false}
                connectNulls={false}
                dot={(p: { index?: number; cx?: number; cy?: number }) =>
                  p.index === li && p.cx != null && p.cy != null ? (
                    <circle key={`d-${s.key}`} cx={p.cx} cy={p.cy} r={4} fill={s.color} stroke="#fff" strokeWidth={2} opacity={dim ? 0.16 : 1} />
                  ) : (
                    <g key={`d-${s.key}-${p.index}`} />
                  )
                }
                activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }}
                label={<EndLabel series={series} me={s} lo={lo} hi={hi} invert={invert} text={labelText(s)} dim={dim} />}
                onMouseEnter={() => onHover?.(s.key)}
              />
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Direct label at a series' last point; every label solves the same spread so they agree. */
function EndLabel({
  series,
  me,
  lo,
  hi,
  invert = false,
  text,
  dim,
  index,
  x,
  y,
}: {
  series: ReadonlyArray<RnLineSeries>;
  me: RnLineSeries;
  lo: number;
  hi: number;
  invert?: boolean;
  text: string;
  dim: boolean;
  index?: number;
  x?: number | string;
  y?: number | string;
}) {
  const plot = usePlotArea();
  if (index !== lastIndex(me.values) || x == null || y == null || !plot) return null;
  const yOf = (v: number) => {
    const t = (v - lo) / (hi - lo || 1);
    return plot.y + (invert ? t : 1 - t) * plot.height;
  };
  const labelled = series.filter((s) => lastIndex(s.values) >= 0);
  const ys = spread(
    labelled.map((s) => yOf(s.values[lastIndex(s.values)]!)),
    15,
    plot.y + plot.height,
  );
  const ty = ys[labelled.indexOf(me)] ?? Number(y);
  return (
    <text
      x={Number(x) + 9}
      y={ty + 4}
      fontSize={12}
      fontWeight={me.own ? 700 : 600}
      fill={me.own ? "var(--color-rn-navy)" : "var(--color-rn-ink-2)"}
      opacity={dim ? 0.3 : 1}
    >
      {text}
    </text>
  );
}

export interface RnScatterPoint {
  key: string;
  name: string;
  x: number;
  y: number;
  color: string;
  own?: boolean;
  /** 당사 / compare brands: bigger dot, label always shown. */
  emph?: boolean;
  tip: string;
}

/**
 * Two measures of the same brands (x 0–100 %, y 0–max %), with a reference line through
 * the origin of slope `k` and two captions. Labels: emphasised points first, then the
 * tallest; a label goes right, else left, else (unemphasised) is dropped — never on a dot.
 */
export function RnScatterChart({
  points,
  k,
  height,
  ariaLabel,
  xTitle,
  yTitle,
  lineLabel,
  above,
  below,
  pct,
  lit = [],
  onHover,
}: {
  points: ReadonlyArray<RnScatterPoint>;
  k: number;
  height: number;
  ariaLabel: string;
  xTitle: string;
  yTitle: string;
  lineLabel: string;
  above: string;
  below: string;
  pct: (v: number) => string;
  lit?: ReadonlyArray<string>;
  onHover?: (key: string | null) => void;
}) {
  const yTicks = rnNiceTicks(0, Math.max(1, ...points.map((p) => p.y)) * 1.15, 4);
  const top = yTicks[yTicks.length - 1];
  const xEnd = k > 0 ? Math.min(100, top / k) : 100;
  return (
    <div role="img" aria-label={ariaLabel} className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 22, right: 18, bottom: 18, left: 0 }}>
          <CartesianGrid stroke="var(--color-rn-line)" />
          <XAxis type="number" dataKey="x" domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} tick={TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
          <YAxis type="number" dataKey="y" width={44} domain={[0, top]} ticks={yTicks} tick={TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: xEnd, y: k * xEnd },
            ]}
            stroke="var(--color-rn-faint)"
            strokeDasharray="4 4"
            ifOverflow="hidden"
          />
          <Scatter data={points as RnScatterPoint[]} isAnimationActive={false} shape={() => <g />} />
          <ScatterMarks points={points} top={top} k={k} xEnd={xEnd} xTitle={xTitle} yTitle={yTitle} lineLabel={lineLabel} above={above} below={below} pct={pct} lit={lit} onHover={onHover} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function ScatterMarks({
  points,
  top,
  k,
  xEnd,
  xTitle,
  yTitle,
  lineLabel,
  above,
  below,
  lit,
  onHover,
}: {
  points: ReadonlyArray<RnScatterPoint>;
  top: number;
  k: number;
  xEnd: number;
  xTitle: string;
  yTitle: string;
  lineLabel: string;
  above: string;
  below: string;
  pct: (v: number) => string;
  lit: ReadonlyArray<string>;
  onHover?: (key: string | null) => void;
}) {
  const plot = usePlotArea();
  if (!plot) return null;
  const X = (v: number) => plot.x + (v / 100) * plot.width;
  const Y = (v: number) => plot.y + (1 - v / top) * plot.height;
  const fading = points.some((p) => lit.includes(p.key));
  const geo = points.map((p) => ({ p, cx: X(p.x), cy: Y(p.y), r: p.own ? 7 : p.emph ? 6 : 5 }));
  const boxes: Array<[number, number, number, number]> = geo.map((d) => [d.cx - d.r, d.cy - d.r, 2 * d.r, 2 * d.r]);
  const hits = (b: [number, number, number, number], self: number) =>
    boxes.some((o, i) => i !== self && b[0] < o[0] + o[2] && b[0] + b[2] > o[0] && b[1] < o[1] + o[3] && b[1] + b[3] > o[1]);
  const tall = [...points].sort((a, b) => b.y - a.y)[Math.min(3, points.length - 1)]?.y ?? 0;
  const labels = new Map<number, { x: number; anchor: "start" | "end" }>();
  const order = geo.map((d, i) => ({ d, i })).sort((a, b) => Number(!!b.d.p.emph) - Number(!!a.d.p.emph) || b.d.p.y - a.d.p.y);
  for (const { d, i } of order) {
    if (!d.p.emph && d.p.y < tall) continue;
    const w = TEXT_W(d.p.name) + 2;
    const right: [number, number, number, number] = [d.cx + d.r + 4, d.cy - 7, w, 14];
    const left: [number, number, number, number] = [d.cx - d.r - 4 - w, d.cy - 7, w, 14];
    const fits = (b: [number, number, number, number]) => b[0] >= plot.x && b[0] + b[2] <= plot.x + plot.width;
    const pick = [right, left].find((b) => fits(b) && !hits(b, i)) ?? (d.p.emph ? (fits(right) ? right : left) : null);
    if (!pick) continue;
    boxes.push(pick);
    labels.set(i, { x: pick === right ? pick[0] : pick[0] + w, anchor: pick === right ? "start" : "end" });
  }
  const draw = geo.map((d, i) => ({ d, i })).sort((a, b) => Number(!!a.d.p.emph) - Number(!!b.d.p.emph));
  return (
    <g>
      <text x={plot.x} y={plot.y - 8} fontSize={12} fontWeight={600} fill="var(--color-rn-ink-2)">
        {yTitle}
      </text>
      <text x={plot.x + plot.width} y={plot.y + plot.height + 34} textAnchor="end" fontSize={12} fontWeight={600} fill="var(--color-rn-ink-2)">
        {xTitle}
      </text>
      <text x={X(xEnd) - 6} y={Y(k * xEnd) + (xEnd < 100 ? 14 : -8)} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--color-rn-muted)">
        {lineLabel}
      </text>
      <text x={plot.x + 8} y={plot.y + 14} fontSize={11} fontWeight={600} fill="var(--color-rn-muted)">
        {above}
      </text>
      <text x={plot.x + plot.width - 6} y={plot.y + plot.height - 8} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--color-rn-muted)">
        {below}
      </text>
      {draw.map(({ d, i }) => {
        const l = labels.get(i);
        const dim = fading && !lit.includes(d.p.key);
        return (
          <g key={d.p.key} data-rn-mark={d.p.key} opacity={dim ? 0.25 : 1} onMouseEnter={() => onHover?.(d.p.key)} onMouseLeave={() => onHover?.(null)}>
            <circle cx={d.cx} cy={d.cy} r={d.r} fill={d.p.color} stroke="#fff" strokeWidth={2}>
              <title>{d.p.tip}</title>
            </circle>
            {l ? (
              <text x={l.x} y={d.cy + 4} textAnchor={l.anchor} fontSize={12} fontWeight={d.p.emph ? 700 : 500} fill={d.p.emph ? "var(--color-rn-ink)" : "var(--color-rn-ink-2)"}>
                {d.p.name}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}
