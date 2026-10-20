"use client";

import type { ReactNode } from "react";
import { cx } from "./cx";

/** Segmented tabs (ARIA tablist). Arrow keys move between tabs. */
export function RnTabs<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: ReadonlyArray<{ value: T; label: ReactNode; count?: ReactNode }>;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cx("inline-flex rounded-[9px] bg-rn-inset p-[3px]", className)}>
      {items.map((it, i) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            data-rn-tab={it.value}
            onClick={() => onChange(it.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const next = items[(i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
              onChange(next.value);
              requestAnimationFrame(() => (e.currentTarget.parentElement?.querySelector(`[data-rn-tab="${next.value}"]`) as HTMLElement | null)?.focus());
            }}
            className={cx(
              "inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[7px] px-3.5 text-rn-13 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rn-navy",
              on ? "bg-rn-surface font-bold text-rn-ink shadow-rn-1" : "font-medium text-rn-muted hover:text-rn-ink",
            )}
          >
            {it.label}
            {it.count != null ? <span className={cx("text-rn-12 tabular-nums", on ? "text-rn-muted" : "text-rn-muted")}>{it.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
