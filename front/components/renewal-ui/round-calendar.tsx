"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { daysInMonth, formatDay, parseDay, shiftMonth, weekdayIndex } from "@/components/dash/selectable-dates";
import { cx } from "./cx";
import { RnIconButton } from "./button";

export type RnDayRange = { from?: string; to?: string };

/**
 * Month grid where only measured-round dates can be picked (Sunday first).
 * Range rule = the app's AnchorDateCalendar: with only a start picked, a later
 * (or same) day closes the range; anything else opens a new range.
 * `defaultDay` marks the round the page shows when no period is chosen.
 */
export function RnRoundCalendar({
  selectableDates,
  value,
  onChange,
  defaultDay,
  labels,
}: {
  selectableDates: readonly string[];
  value: RnDayRange;
  onChange: (next: RnDayRange) => void;
  defaultDay: string | null;
  labels: {
    prev: string;
    next: string;
    noRound: string;
    defaultRound: string;
    weekdays: readonly string[];
    month: (y: number, m: number) => string;
  };
}) {
  const latest = selectableDates[selectableDates.length - 1] ?? null;
  const initial = parseDay(value.to ?? value.from ?? latest ?? "") ?? { y: 2026, m: 1, d: 1 };
  const [cursor, setCursor] = useState({ y: initial.y, m: initial.m });
  const set = useMemo(() => new Set(selectableDates), [selectableDates]);
  const lo = parseDay(selectableDates[0] ?? "");
  const hi = parseDay(latest ?? "");
  const idx = cursor.y * 12 + cursor.m;
  const atFirst = !lo || idx <= lo.y * 12 + lo.m;
  const atLast = !hi || idx >= hi.y * 12 + hi.m;
  const first = formatDay(cursor.y, cursor.m, 1);
  const lead = weekdayIndex(first);
  const total = daysInMonth(cursor.y, cursor.m);
  const mark = !value.from && !value.to ? defaultDay : null;
  const pick = (day: string) => {
    if (value.from && !value.to && day >= value.from) onChange({ from: value.from, to: day });
    else onChange({ from: day, to: undefined });
  };
  return (
    <div className="rounded-[10px] border border-rn-line px-2 pt-1.5 pb-2" data-rn-calendar="">
      <div className="flex items-center justify-between text-rn-13 font-bold text-rn-ink">
        <RnIconButton label={labels.prev} disabled={atFirst} onClick={() => setCursor(shiftMonth(cursor.y, cursor.m, -1))}>
          <ChevronLeft className="size-3.5" aria-hidden />
        </RnIconButton>
        <span className="tabular-nums">{labels.month(cursor.y, cursor.m)}</span>
        <RnIconButton label={labels.next} disabled={atLast} onClick={() => setCursor(shiftMonth(cursor.y, cursor.m, 1))}>
          <ChevronRight className="size-3.5" aria-hidden />
        </RnIconButton>
      </div>
      <div className="mt-1 grid grid-cols-7 gap-0.5 text-center">
        {labels.weekdays.map((w) => (
          <span key={w} className="py-0.5 text-rn-11 text-rn-muted">
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead${i}`} />
        ))}
        {Array.from({ length: total }, (_, i) => {
          const day = formatDay(cursor.y, cursor.m, i + 1);
          const ok = set.has(day);
          const end = day === value.from || day === value.to;
          const inside = !!value.from && !!value.to && day > value.from && day < value.to;
          return (
            <button
              key={day}
              type="button"
              data-day={day}
              disabled={!ok}
              aria-disabled={!ok || undefined}
              aria-pressed={ok ? end : undefined}
              tabIndex={ok ? 0 : -1}
              title={!ok ? labels.noRound : day === mark ? labels.defaultRound : undefined}
              aria-label={day}
              onClick={() => ok && pick(day)}
              className={cx(
                "h-7 rounded-md text-rn-12 tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rn-navy",
                !ok && "cursor-default text-rn-muted",
                ok && !end && "cursor-pointer bg-rn-navy-25 font-bold text-rn-navy hover:bg-rn-navy-50",
                ok && inside && "bg-rn-navy-50",
                end && "cursor-pointer bg-rn-navy font-bold text-white",
                day === mark && "shadow-[inset_0_0_0_1.5px_var(--color-rn-navy)]",
              )}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}
