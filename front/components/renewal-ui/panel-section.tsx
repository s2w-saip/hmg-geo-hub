"use client";

import type { ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";
import { cx } from "./cx";
import { RnCountBadge } from "./chip";

/** Collapsible section of the left filter panel. */
export function RnPanelSection({
  title,
  open,
  onToggle,
  badge,
  summary,
  focusKey,
  children,
}: {
  title: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Number of picked values — shown as a navy count badge. */
  badge?: number;
  /** Short text instead of a count (e.g. a date range). */
  summary?: string;
  focusKey?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-rn-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        data-fk={focusKey}
        className="flex w-full cursor-pointer items-center gap-2 pt-3 pr-3.5 pb-2 pl-4.5 text-left text-rn-13 font-bold text-rn-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-rn-navy"
      >
        <ChevronDown aria-hidden className={cx("size-3.5 shrink-0 text-rn-muted transition-transform", !open && "-rotate-90")} />
        <span>{title}</span>
        {badge ? (
          <RnCountBadge className="ml-auto">{badge}</RnCountBadge>
        ) : summary ? (
          <span className="ml-auto max-w-[150px] text-right text-rn-12 font-semibold text-rn-navy">{summary}</span>
        ) : null}
      </button>
      {open ? <div className="px-2 pb-3">{children}</div> : null}
    </section>
  );
}

/** Small uppercase label that separates groups of sections (e.g. 디멘션 / 프롬프트 필터). */
export function RnPanelGroupLabel({ children }: { children: ReactNode }) {
  return <div className="px-4.5 pt-3.5 pb-0.5 text-rn-11 font-bold tracking-[0.06em] text-rn-muted">{children}</div>;
}

export function RnSearchField({
  value,
  onChange,
  placeholder,
  label,
  id,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  id?: string;
  className?: string;
}) {
  return (
    <label className={cx("relative block", className)}>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-rn-muted" />
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-[34px] w-full rounded-rn-control border border-rn-line-2 bg-rn-surface pr-2.5 pl-8 text-rn-13 text-rn-ink outline-none placeholder:text-rn-muted focus:border-rn-navy focus:ring-3 focus:ring-rn-navy/12"
      />
    </label>
  );
}
