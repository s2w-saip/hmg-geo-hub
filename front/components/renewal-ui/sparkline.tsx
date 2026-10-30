import { cx } from "./cx";
import { RnSparkTips, type RnSparkTipZone } from "./spark-tips";

// The line's box: points sit PAD in from either side, evenly spaced (RnSparkAxis puts labels on them).
const W = 120;
const PAD = 3;

/** Where point `i` of `n` sits, as a share of the width (the middle when there is one). */
const pointAt = (i: number, n: number) => (n > 1 ? (PAD + (i * (W - 2 * PAD)) / (n - 1)) / W : 0.5);

/**
 * Minimal inline trend line. `null` points break the line (no interpolation — the
 * same rule as the app's trend charts). The last measured point gets a dot.
 * Decorative: callers state the value in text next to it. With `tips` (one text per
 * value, the caller's words: day, value, change) every point also gets a hover /
 * focus zone that shows its text (RnSparkTips); without it the svg is unchanged.
 */
export function RnSparkline({
  values,
  tone = "default",
  invert = false,
  minSpan = 0,
  domain,
  tips,
  className,
}: {
  values: ReadonlyArray<number | null>;
  tone?: "default" | "onDark";
  /** Draw lower values higher (rank: 1 is best). */
  invert?: boolean;
  /** Smallest value range drawn (around the middle) — wobbles below it stay nearly flat. */
  minSpan?: number;
  /** Fixed value range [low, high] (e.g. 0–100 for rates); overrides the auto range and minSpan. */
  domain?: readonly [number, number];
  /** One text per value (null = no zone at that point), shown on hover / focus and as the point's name. */
  tips?: ReadonlyArray<string | null>;
  className?: string;
}) {
  const w = W;
  const h = 36;
  const p = PAD;
  const nums = values.filter((v): v is number => v != null);
  if (nums.length === 0) return <svg aria-hidden className={cx("block h-9 w-full", className)} viewBox={`0 0 ${w} ${h}`} />;
  const lo = domain ? domain[0] : Math.min(...nums);
  const hi = domain ? domain[1] : Math.max(...nums);
  const span = domain ? hi - lo || 1 : Math.max(hi - lo, minSpan) || 1;
  const min = domain ? lo : (lo + hi) / 2 - span / 2;
  const y = (v: number) => {
    const t = (v - min) / span;
    return h - p - (invert ? 1 - t : t) * (h - 2 * p);
  };
  // contiguous runs of measured points
  const runs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push([pointAt(i, values.length) * w, y(v)]);
  });
  if (cur.length) runs.push(cur);
  const lastRun = runs[runs.length - 1];
  const last = lastRun[lastRun.length - 1];
  const line = tone === "onDark" ? "stroke-rn-sky" : "stroke-rn-navy";
  const area = tone === "onDark" ? "fill-rn-sky/18" : "fill-rn-navy/8";
  const dot = tone === "onDark" ? "fill-white" : "fill-rn-navy";
  const svg = (
    <svg aria-hidden className={cx("block", tips ? "h-full w-full" : cx("h-9 w-full", className))} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {runs.map((run, i) => {
        const pts = run.map(([x, yy]) => `${x.toFixed(1)},${yy.toFixed(1)}`).join(" ");
        return (
          <g key={i}>
            {run.length > 1 ? <polygon className={area} points={`${run[0][0].toFixed(1)},${h} ${pts} ${run[run.length - 1][0].toFixed(1)},${h}`} /> : null}
            {run.length > 1 ? <polyline className={cx("fill-none", line)} strokeWidth={2} vectorEffect="non-scaling-stroke" points={pts} /> : null}
          </g>
        );
      })}
      <circle className={dot} cx={last[0]} cy={last[1]} r={3} />
    </svg>
  );
  if (!tips) return svg;
  // a point's zone runs halfway to its neighbours (the box's edges for the first and the last)
  const n = values.length;
  const zones: RnSparkTipZone[] = [];
  values.forEach((v, i) => {
    const tip = tips[i];
    if (tip == null) return;
    const x = pointAt(i, n);
    zones.push({
      i,
      lo: i > 0 ? (pointAt(i - 1, n) + x) / 2 : 0,
      hi: i < n - 1 ? (x + pointAt(i + 1, n)) / 2 : 1,
      x,
      y: v == null ? null : y(v) / h,
      tip,
    });
  });
  return (
    <span className={cx("relative block h-9 w-full", className)}>
      {svg}
      <RnSparkTips zones={zones} tone={tone} />
    </span>
  );
}

/** Labels under an RnSparkline of as many values, each centred on its point. */
export function RnSparkAxis({
  labels,
  tone = "default",
  className,
}: {
  labels: ReadonlyArray<string>;
  tone?: "default" | "onDark";
  className?: string;
}) {
  const n = labels.length;
  return (
    <span
      className={cx(
        "relative block h-4 text-rn-11 whitespace-nowrap tabular-nums",
        tone === "onDark" ? "text-white/72" : "text-rn-muted",
        className,
      )}
    >
      {labels.map((text, i) => (
        <span key={i} className="absolute top-0 -translate-x-1/2" style={{ left: `${pointAt(i, n) * 100}%` }}>
          {text}
        </span>
      ))}
    </span>
  );
}
