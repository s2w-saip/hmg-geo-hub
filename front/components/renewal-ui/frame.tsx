"use client";

import type { ReactNode } from "react";
import { Sparkles, TrendingUp, TriangleAlert } from "lucide-react";
import { cx } from "./cx";

// Page frame of the analysis renewal pages (ACR, Mention, Citation): section heads, a control
// bar that stays under the app header (page-level controls), the "이번 회차 요약" finding grid, one card head anatomy (title · ⓘ · basis chips ·
// controls · actions) and a segmented radio group. Copy comes in through props.
// A `.rn-dense` ancestor (density toggle) tightens the rhythm and hides helper copy.

/** Section heading (20px) with an optional chip (e.g. the KPI it shows) and a one-line description; `id` is the jump target. */
export function RnSectionHead({ id, title, chip, desc }: { id: string; title: ReactNode; chip?: ReactNode; desc?: ReactNode }) {
  return (
    <div id={id} data-rn-sec="" className="mt-4 -mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1.5 [.rn-dense_&]:mt-2">
      <h2 className="m-0 text-rn-20 font-bold tracking-[-0.02em] text-rn-ink">{title}</h2>
      {chip}
      {desc ? <p className="m-0 text-rn-12 break-keep text-rn-muted [.rn-dense_&]:hidden">{desc}</p> : null}
    </div>
  );
}

/**
 * Bar that sticks under the app header with the page-level controls (KPI in view, compare
 * brands, density). No section quick-nav (user 2026-10-22: "빠른 이동 UI는 필요하지 않아").
 */
export function RnControlBar({
  label,
  children,
}: {
  /** Accessible name of the bar. */
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      data-rn-cbar=""
      className="sticky top-16 z-20 flex flex-wrap items-center justify-end gap-x-3.5 gap-y-2 rounded-xl bg-rn-surface py-2 pr-2.5 pl-2 shadow-[var(--shadow-rn-1),0_0_0_1px_var(--color-rn-line)]"
    >
      {children}
    </div>
  );
}

export type RnFindingTone = "warn" | "good" | "info";
export interface RnFinding {
  key: string;
  tone: RnFindingTone;
  tag: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
}
const TONE_BAR: Record<RnFindingTone, string> = {
  warn: "shadow-[inset_3px_0_0_#d65a43]",
  good: "shadow-[inset_3px_0_0_var(--color-rn-up)]",
  info: "shadow-[inset_3px_0_0_var(--color-rn-navy-300)]",
};
const TONE_ICON: Record<RnFindingTone, string> = { warn: "text-[#d65a43]", good: "text-rn-up", info: "text-rn-navy-300" };

/** "이번 회차 요약" findings: up to four read-only cards (no jump to the card — user 2026-10-22: no scroll jumps). */
export function RnFindingGrid({ items }: { items: ReadonlyArray<RnFinding> }) {
  return (
    <div className="grid grid-cols-1 gap-2.5 px-6 @min-[900px]/rnpage:grid-cols-4 @min-[560px]/rnpage:grid-cols-2 [.rn-dense_&]:px-4.5">
      {items.map((x) => {
        const Icon = x.tone === "warn" ? TriangleAlert : x.tone === "good" ? TrendingUp : Sparkles;
        return (
          <div
            key={x.key}
            data-rn-finding={x.key}
            className={cx("flex min-w-0 flex-col gap-1 rounded-[10px] bg-rn-page pt-2.5 pr-3.5 pb-3 pl-4 break-keep [.rn-dense_&]:py-2", TONE_BAR[x.tone])}
          >
            <span className="flex items-center gap-1.5 text-rn-11 font-bold text-rn-muted">
              <Icon className={cx("size-3", TONE_ICON[x.tone])} aria-hidden />
              {x.tag}
            </span>
            <b className="text-rn-13 leading-[1.45] font-bold text-rn-ink">{x.title}</b>
            {x.detail ? <span className="text-rn-12 leading-[1.45] text-rn-muted [.rn-dense_&]:hidden">{x.detail}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Basis chip on a card head ("측정 기준일 …", "추이 12회차"). */
export function RnBasisChip({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1 rounded-full bg-rn-page px-2 text-rn-11 font-semibold whitespace-nowrap text-rn-muted [&_svg]:text-rn-faint">
      {icon}
      {children}
    </span>
  );
}

/** Card head: title · ⓘ · basis chips, then controls and the card actions on the right. */
export function RnCardHead({
  title,
  info,
  chips,
  controls,
  actions,
  sub,
}: {
  title: ReactNode;
  info?: ReactNode;
  chips?: ReactNode;
  controls?: ReactNode;
  actions?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 pt-4 pr-5 pb-3 pl-6 [.rn-dense_&]:pt-2.5 [.rn-dense_&]:pb-2 [.rn-dense_&]:pl-4.5">
      <h2 className="m-0 text-rn-15 font-bold text-rn-ink">{title}</h2>
      {info}
      {chips}
      {controls || actions ? (
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          {controls}
          {actions}
        </div>
      ) : null}
      {sub ? <p className="m-0 -mt-1 w-full text-rn-12 break-keep text-rn-muted [.rn-dense_&]:hidden">{sub}</p> : null}
    </div>
  );
}

/** Segmented single choice (radio group). */
export function RnSegmented<T extends string>({
  value,
  onChange,
  items,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: ReadonlyArray<{ value: T; label: ReactNode }>;
  label: string;
  className?: string;
}) {
  return (
    <span role="radiogroup" aria-label={label} className={cx("inline-flex rounded-lg bg-rn-inset p-0.5", className)}>
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-rn-seg={it.value}
            onClick={() => onChange(it.value)}
            className={cx(
              "h-[26px] cursor-pointer rounded-md px-2.5 text-rn-12 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rn-navy",
              on ? "bg-rn-surface font-bold text-rn-ink shadow-rn-1" : "font-medium text-rn-muted hover:text-rn-ink",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </span>
  );
}
