import type { ReactNode } from "react";

/** Page title block of a renewal page (S급 압축 머리): 26px title, description · basis chip on one line, trailing actions. */
export function RnPageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5">
      {/* flex-1: a long meta line (page description) wraps inside instead of pushing the actions to a new row */}
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-rn-26 font-bold tracking-[-0.025em] text-balance text-rn-ink [&_span]:tracking-normal">{title}</h1>
        {meta ? <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-rn-13 text-rn-muted">{meta}</div> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
