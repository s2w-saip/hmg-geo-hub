import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/** Thin animated bar on a card's top edge while its data is being replaced. */
export function RnProgressLine({ className }: { className?: string }) {
  return (
    <div aria-hidden data-rn-progress="" className={cx("pointer-events-none absolute inset-x-0 top-0 z-[3] h-[3px] overflow-hidden rounded-t-rn-card bg-rn-navy-25 [.rn-hero_&]:bg-white/25", className)}>
      <span className="absolute inset-y-0 w-[35%] animate-rn-progress bg-rn-navy [.rn-hero_&]:bg-white" />
    </div>
  );
}

/**
 * White surface card (S급: 16px corners, a 1px line + a faint shadow). `tone="hero"` is the
 * page's one navy accent card (.rn-hero, app/renewal-theme.css). The current content always
 * stays on screen; the progress line shows when `busy` is set or when an ancestor busy scope
 * (`group/rnbusy` with `data-rn-busy`) is refetching — so server-rendered cards need no client state.
 */
export function RnCard({
  busy = false,
  tone = "default",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { busy?: boolean; tone?: "default" | "hero" }) {
  return (
    <section
      aria-busy={busy || undefined}
      data-rn-tone={tone === "hero" ? "hero" : undefined}
      className={cx("relative rounded-rn-card", tone === "hero" ? "rn-hero" : "bg-rn-surface shadow-rn-card", className)}
      {...rest}
    >
      <RnProgressLine className={busy ? undefined : "hidden group-data-[rn-busy]/rnbusy:block"} />
      {children}
    </section>
  );
}

export function RnCardHeader({
  title,
  hint,
  actions,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 pt-[18px] pr-[22px] pb-3 pl-6">
      <h2 className="m-0 text-rn-16 font-bold tracking-[-0.01em] text-rn-ink [.rn-hero_&]:text-white">{title}</h2>
      {hint ? <span className="text-rn-12 text-rn-muted [.rn-hero_&]:text-white/72">{hint}</span> : null}
      {actions ? <div className="ml-auto flex items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}

/** Inline notice box (white, hairline border). */
export function RnNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-rn-surface px-3.5 py-2.5 text-rn-12 text-rn-ink-2 shadow-[inset_0_0_0_1px_var(--color-rn-line-2)]", className)}>
      {children}
    </div>
  );
}

/** Muted empty/explanation block inside a card. */
export function RnEmpty({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("m-0 rounded-[10px] bg-rn-page p-3.5 text-rn-12 text-rn-muted", className)}>{children}</p>;
}
