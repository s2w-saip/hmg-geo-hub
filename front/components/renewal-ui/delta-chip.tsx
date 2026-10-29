import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { cx } from "./cx";

/** up = better, down = worse, flat = unchanged, none = not measurable. */
export type RnTone = "up" | "down" | "flat" | "none";

/**
 * Change chip. Direction colour lives on the icon and the tint only — the number
 * stays ink so it keeps AA contrast on every tint.
 */
export function RnToneChip({
  tone,
  icon,
  title,
  onDark = false,
  className,
  children,
}: {
  tone: RnTone;
  /** Arrow direction (value went up / down). Defaults to the tone. */
  icon?: "up" | "down" | "flat" | null;
  title?: string;
  onDark?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const dir = icon === undefined ? (tone === "up" ? "up" : tone === "down" ? "down" : tone === "flat" ? "flat" : null) : icon;
  const Icon = dir === "up" ? ArrowUp : dir === "down" ? ArrowDown : dir === "flat" ? Minus : null;
  const tint = onDark ? "bg-rn-surface" : tone === "up" ? "bg-rn-up/12" : tone === "down" ? "bg-rn-down/10" : "bg-rn-inset";
  return (
    <span
      title={title}
      data-tone={tone}
      className={cx(
        "inline-flex h-6 items-center gap-1 rounded-md px-2 text-rn-12 font-bold whitespace-nowrap tabular-nums",
        tone === "none" ? "text-rn-muted" : "text-rn-ink-2",
        tint,
        className,
      )}
    >
      {Icon ? (
        <Icon aria-hidden strokeWidth={2.5} className={cx("size-3", tone === "up" ? "text-rn-up" : tone === "down" ? "text-rn-down" : "text-rn-muted")} />
      ) : null}
      {children}
    </span>
  );
}

/** Signed change → chip. `lowerIsBetter` flips the colour meaning (rank); `neutral` keeps the arrow and drops the
 * better/worse colour (a rival's move is not good or bad in itself). */
export function RnDeltaChip({
  delta,
  lowerIsBetter = false,
  format,
  emptyText,
  labels,
  onDark = false,
  neutral = false,
  className,
}: {
  delta: number | null;
  lowerIsBetter?: boolean;
  neutral?: boolean;
  /** Formats the rounded signed value, e.g. (0.4) => "0.4pp". */
  format: (rounded: number) => string;
  emptyText: string;
  /** Hover titles: improvement / decline / unchanged. */
  labels: { up: string; down: string; flat: string };
  onDark?: boolean;
  className?: string;
}) {
  if (delta == null) {
    return (
      <RnToneChip tone="none" onDark={onDark} className={className}>
        {emptyText}
      </RnToneChip>
    );
  }
  const r = Math.round(delta * 10) / 10;
  const flat = r === 0;
  const good = lowerIsBetter ? r < 0 : r > 0;
  const tone: RnTone = flat || neutral ? "flat" : good ? "up" : "down";
  const title = flat ? labels.flat : neutral ? undefined : good ? labels.up : labels.down;
  return (
    <RnToneChip tone={tone} icon={flat ? "flat" : r > 0 ? "up" : "down"} title={title} onDark={onDark} className={className}>
      {format(r)}
    </RnToneChip>
  );
}
