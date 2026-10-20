"use client";

import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cx } from "./cx";

export type RnCheckState = "on" | "off" | "partial";

/** The visual box only (aria-hidden) — the row carries the role and state. */
export function RnCheckMark({ state, radio = false }: { state: RnCheckState; radio?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "grid size-4 shrink-0 place-items-center border-[1.5px] text-white",
        radio ? "rounded-full" : "rounded-[4px]",
        state === "on" ? "border-rn-navy bg-rn-navy" : state === "partial" ? "border-rn-navy bg-rn-surface" : "border-rn-faint bg-rn-surface",
      )}
    >
      {state === "on" && !radio ? <Check className="size-3" strokeWidth={3} /> : null}
      {state === "on" && radio ? <span className="size-1.5 rounded-full bg-white" /> : null}
      {state === "partial" ? <span className="h-0.5 w-2 rounded-[1px] bg-rn-navy" /> : null}
    </span>
  );
}

/**
 * One selectable option row (checkbox or radio semantics). Enter / Space toggle.
 * `focusKey` lets a re-rendering parent put focus back on the same row.
 */
export function RnCheckRow({
  checked,
  onToggle,
  label,
  meta,
  disabled = false,
  radio = false,
  focusKey,
  title,
}: {
  checked: boolean;
  onToggle: () => void;
  label: ReactNode;
  meta?: ReactNode;
  disabled?: boolean;
  radio?: boolean;
  focusKey?: string;
  title?: string;
}) {
  return (
    <div
      role={radio ? "radio" : "checkbox"}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-fk={focusKey}
      title={title}
      onClick={() => {
        if (!disabled) onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (!disabled) onToggle();
      }}
      className={cx(
        "grid min-h-8 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 text-rn-13 outline-none focus-visible:outline-2 focus-visible:outline-rn-navy",
        disabled ? "cursor-not-allowed text-rn-muted" : "cursor-pointer text-rn-ink-2 hover:bg-rn-page",
      )}
    >
      <RnCheckMark state={checked ? "on" : "off"} radio={radio} />
      <span className="min-w-0 py-1.5 leading-snug break-words">{label}</span>
      <span className="text-rn-12 text-rn-muted tabular-nums">{meta}</span>
    </div>
  );
}

/** Clickable group header inside an option list (selects / clears the whole group). */
export function RnGroupHeader({
  label,
  active,
  onToggle,
  title,
}: {
  label: ReactNode;
  active: boolean;
  onToggle: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onToggle}
      className={cx(
        "flex w-full cursor-pointer items-center gap-1 px-2.5 pt-2.5 pb-1 text-left text-rn-11 font-bold tracking-[0.04em] focus-visible:outline-2 focus-visible:outline-rn-navy",
        active ? "text-rn-navy" : "text-rn-muted hover:text-rn-ink",
      )}
    >
      {label}
      {active ? <Check className="size-3" aria-hidden /> : null}
    </button>
  );
}
