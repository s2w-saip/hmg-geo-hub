import type { ReactNode } from "react";
import { RnServiceWeekChip } from "@/components/service-week/chip";

const META = "mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-rn-13 text-rn-muted";

/**
 * Page title block of a renewal page (S급 압축 머리; 새 외형 2026-11-05: 24px / 650 title): title, description · basis chip on one line, trailing actions.
 * The meta line ends with the service-week chip (2026-11-02: the week the page's Gold rounds are held to); a header
 * without a meta line gets the chip alone. The chip renders nothing outside the renewal shell's provider and on a
 * page not held to the week.
 */
export function RnPageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5">
      {/* flex-1: a long meta line (page description) wraps inside instead of pushing the actions to a new row */}
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-rn-24 leading-[1.25] font-[650] tracking-[-0.025em] text-balance text-rn-ink [&_span]:tracking-normal">{title}</h1>
        {meta ? (
          <div className={META}>
            {meta}
            <RnServiceWeekChip />
          </div>
        ) : (
          <RnServiceWeekChip row={META} />
        )}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
