"use client";

import { cx } from "./cx";
import { useRnTruncTip } from "./trunc-tip";

/** One point of an RnSparkline with a tip: its zone [lo, hi] and the point (x, y), all shares of the box. */
export interface RnSparkTipZone {
  i: number;
  lo: number;
  hi: number;
  x: number;
  /** null = no value at this point (no marker). */
  y: number | null;
  tip: string;
}

const pct = (v: number) => `${(v * 100).toFixed(3).replace(/\.?0+$/, "")}%`;

/**
 * The hover / focus zones over an RnSparkline (renewal audit 3-1): one per point, side by side across the line, each
 * carrying the point's text for the shared tooltip (useRnTruncTip) and as its accessible name; hovering or focusing
 * a zone rings its point. Above a card-wide link (z-[1], as the cards' ⓘ), so the line shows its values there.
 */
export function RnSparkTips({ zones, tone }: { zones: ReadonlyArray<RnSparkTipZone>; tone: "default" | "onDark" }) {
  const { bind, tip } = useRnTruncTip();
  const ring = tone === "onDark" ? "border-white bg-rn-navy" : "border-rn-navy bg-rn-surface";
  return (
    <span className="absolute inset-0 z-[1]" {...bind}>
      {zones.map((z) => (
        <span
          key={z.i}
          data-rn-spark-point={z.i}
          data-rn-tip={z.tip}
          role="img"
          aria-label={z.tip}
          tabIndex={0}
          className="group/spt absolute inset-y-0 rounded-[3px] outline-none focus-visible:outline-2 focus-visible:outline-rn-sky"
          style={{ left: pct(z.lo), width: pct(z.hi - z.lo) }}
        >
          {z.y == null ? null : (
            <i
              aria-hidden
              className={cx(
                "pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 opacity-0 transition-opacity group-hover/spt:opacity-100 group-focus-visible/spt:opacity-100",
                ring,
              )}
              style={{ left: pct((z.x - z.lo) / (z.hi - z.lo)), top: pct(z.y) }}
            />
          )}
        </span>
      ))}
      {tip}
    </span>
  );
}
