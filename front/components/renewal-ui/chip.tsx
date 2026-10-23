import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "./cx";

export function RnCountBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-rn-navy px-1.5 text-rn-11 font-bold text-white tabular-nums", className)}>
      {children}
    </span>
  );
}

/** Small label next to a name (e.g. own-brand marker, "new"). */
export function RnTag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("rounded px-1.5 text-rn-11 font-bold text-rn-navy bg-rn-navy/8", className)}>{children}</span>;
}

/** Applied-condition token with a remove button. */
export function RnToken({
  label,
  value,
  onRemove,
  removeLabel,
}: {
  label: ReactNode;
  value: ReactNode;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="inline-flex min-h-7 items-center gap-1.5 rounded-lg bg-rn-navy/8 pr-1.5 pl-2.5 text-rn-12 font-bold text-rn-navy">
      <span className="font-medium">{label}</span>
      {value}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="grid size-[18px] cursor-pointer place-items-center rounded hover:bg-rn-navy/12 focus-visible:outline-2 focus-visible:outline-rn-navy"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}

/** Rounded meta pill (e.g. "주 1회 측정 · 측정 회차 … 기준"). */
export function RnPill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-[26px] items-center gap-1.5 rounded-full border border-rn-line-2 bg-rn-surface px-2.5 text-rn-12 text-rn-ink-2", className)}>
      {children}
    </span>
  );
}
