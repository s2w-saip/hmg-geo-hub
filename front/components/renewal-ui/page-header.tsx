import type { ReactNode } from "react";

/** Page title block of a renewal page: 32px title, meta line, trailing actions. */
export function RnPageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
      <div className="min-w-0">
        <h1 className="m-0 text-rn-32 font-bold tracking-[-0.03em] text-balance text-rn-ink">{title}</h1>
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2 text-rn-13 text-rn-muted">{meta}</div> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
