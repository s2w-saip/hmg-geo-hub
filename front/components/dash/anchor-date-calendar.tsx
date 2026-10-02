"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  daysInMonth,
  formatDay,
  parseDay,
  shiftMonth,
  weekdayIndex,
} from "./selectable-dates";
import type { TimeRangeValue } from "./filter-encoding";

// ════════════════════════════════════════════════════════════════════════════
// 회차 달력 — **회차가 있는 날짜만** 고를 수 있는 월 그리드 (스펙 §5.1)
// ════════════════════════════════════════════════════════════════════════════
//
// 종전 기간 축은 `<input type="date">` 두 개였다. 네이티브 입력은 `min`/`max` 밖의
// 날짜를 못 막는다 — "월요일만" 같은 목록 제약을 표현할 방법이 없다. 그래서
// `selectableDates` 가 주어질 때만 이 그리드로 바꾼다(없으면 패널이 종전 입력을
// 그대로 쓴다 = 렌더 결과 불변).
//
// 시계는 하나다: 모든 날짜 산술이 `selectable-dates.ts` 의 **KST 문자열 산술**이고
// `Date` 의 로컬 메서드는 쓰지 않는다. 요일 이름·월 이름만 `Intl` 로 뽑는데, 그때도
// `timeZone: "UTC"` 를 못박아 브라우저 시간대가 라벨을 흔들지 못하게 한다.
//
// 비활성 날짜는 ① `disabled` ② `aria-disabled="true"` ③ `tabIndex={-1}`
// ④ `title`(사유) 넷을 모두 단다 — 마우스·키보드·스크린리더 어느 경로로도 고를 수
// 없어야 하고, 왜 못 고르는지가 읽혀야 한다.

/** 요일 머리글 7개 — 일요일 시작. 2026-01-04 는 일요일(UTC). */
function weekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2026, 0, 4 + i))));
}

function monthLabel(locale: string, y: number, m: number): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

export interface AnchorDateCalendarProps {
  /** 선택 가능한 KST 날짜(오름차순·정규화 완료). 비면 이 컴포넌트를 쓰지 않는다. */
  selectableDates: readonly string[];
  /** 현재 선택 범위(이미 스냅된 값). */
  value: TimeRangeValue;
  onChange: (next: TimeRangeValue) => void;
  /** KST 의 오늘 — 주입받는다(컴포넌트가 시계를 직접 읽지 않는다). */
  todayKst: string;
  /** 수집 시작일 하한(YYYY-MM-DD). 이전 날짜는 비활성. 없으면 제한 없음. */
  minDay?: string | null;
  /**
   * **기간 미선택일 때 화면이 실제로 보고 있는 회차**(KST `YYYY-MM-DD`).
   *
   * 축이 켜지면 기간을 안 고른 기본 화면이 "노출 가능한 가장 최신 `round_date` 한
   * 회차" 다(메인 결정 2026-09-20, `anchorLatestRoundClause`). 달력이 그것을 안 그리면
   * 고객은 "아무것도 안 골랐으니 전 기간" 으로 읽는다 — 카드의 숫자와 어긋난다.
   *
   * 선택이 **하나도 없을 때만** 표시한다(고르면 그 선택이 정본이다). 선택이 아니라
   * 표시이므로 `aria-pressed` 는 false 이고 URL 도 건드리지 않는다.
   */
  defaultDay?: string | null;
}

export function AnchorDateCalendar({
  selectableDates,
  value,
  onChange,
  todayKst,
  minDay,
  defaultDay,
}: AnchorDateCalendarProps) {
  const t = useTranslations("dashboard.filters.timeRange");
  const locale = useLocale();

  const dates = selectableDates;
  const latest = dates.length > 0 ? dates[dates.length - 1] : todayKst;
  // 처음 펼칠 때 보여 줄 달 — 선택된 종료일 > 시작일 > 목록의 최신 날짜 순.
  const initial = parseDay(value.to ?? value.from ?? latest) ?? parseDay(todayKst)!;
  const [cursor, setCursor] = useState<{ y: number; m: number }>({
    y: initial.y,
    m: initial.m,
  });

  const selectableSet = useMemo(() => new Set(dates), [dates]);

  const cells = useMemo(() => {
    const first = formatDay(cursor.y, cursor.m, 1);
    const lead = weekdayIndex(first); // 그리드 앞쪽 빈 칸 수(일요일 시작)
    const total = daysInMonth(cursor.y, cursor.m);
    const out: Array<{ day: string | null }> = [];
    for (let i = 0; i < lead; i += 1) out.push({ day: null });
    for (let d = 1; d <= total; d += 1) out.push({ day: formatDay(cursor.y, cursor.m, d) });
    return out;
  }, [cursor]);

  // 달 이동의 끝 — 목록 밖으로 무한히 넘기지 않는다(빈 달만 보여 준다).
  const bounds = useMemo(() => {
    const lo = parseDay(dates[0] ?? todayKst)!;
    const hi = parseDay(latest)!;
    return { lo, hi };
  }, [dates, latest, todayKst]);
  const atFirst = cursor.y * 12 + cursor.m <= bounds.lo.y * 12 + bounds.lo.m;
  const atLast = cursor.y * 12 + cursor.m >= bounds.hi.y * 12 + bounds.hi.m;

  function pick(day: string) {
    // 범위 선택: 시작만 있고 그 이후를 누르면 종료일, 그 외에는 새 범위를 연다.
    if (value.from && !value.to && day >= value.from) onChange({ from: value.from, to: day });
    else onChange({ from: day, to: undefined });
  }

  const disabledTitle = t("noRoundOnDay");
  // 선택이 하나라도 있으면 기본 회차 표식은 끈다 — 두 개가 같이 빛나면 어느 쪽이
  // 화면의 모수인지 읽을 수 없다.
  const defaultRound = !value.from && !value.to ? (defaultDay ?? null) : null;
  const defaultTitle = t("defaultRound");

  return (
    <div
      className="px-2 py-1.5"
      data-anchor-calendar=""
      // 라딕스 메뉴가 화살표·스페이스를 항목 점프로 가로채지 않게 한다
      // (FacetedFilter 검색 입력과 같은 자세).
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1 flex items-center justify-between">
        <button
          type="button"
          aria-label={t("prevMonth")}
          disabled={atFirst}
          onClick={() => setCursor((c) => shiftMonth(c.y, c.m, -1))}
          className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        </button>
        <span className="text-xs font-medium tabular-nums" data-anchor-calendar-month="">
          {monthLabel(locale, cursor.y, cursor.m)}
        </span>
        <button
          type="button"
          aria-label={t("nextMonth")}
          disabled={atLast}
          onClick={() => setCursor((c) => shiftMonth(c.y, c.m, 1))}
          className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
        >
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {/* 행 구조가 없는 반쪽 grid 롤은 스크린리더에 해롭다 — 롤을 얹지 않고
          버튼 하나하나가 날짜(`aria-label`)와 선택 상태(`aria-pressed`)를 말한다. */}
      <div className="grid grid-cols-7 gap-0.5">
        {weekdayLabels(locale).map((w, i) => (
          <div
            key={`w${i}`}
            aria-hidden
            className="py-0.5 text-center text-[10px] text-muted-foreground"
          >
            {w}
          </div>
        ))}
        {cells.map((c, i) => {
          if (!c.day) return <div key={`e${i}`} aria-hidden />;
          const day = c.day;
          const ok = selectableSet.has(day) && (!minDay || day >= minDay);
          const isFrom = value.from === day;
          const isTo = value.to === day;
          const isDefault = day === defaultRound;
          const inRange = Boolean(
            value.from && value.to && day > value.from && day < value.to,
          );
          return (
            <button
              key={day}
              type="button"
              aria-label={day}
              data-day={day}
              data-selectable={ok ? "1" : "0"}
              data-in-range={isFrom || isTo || inRange ? "1" : undefined}
              data-today={day === todayKst ? "1" : undefined}
              data-default-round={isDefault ? "1" : undefined}
              disabled={!ok}
              aria-disabled={ok ? undefined : true}
              aria-pressed={isFrom || isTo}
              tabIndex={ok ? 0 : -1}
              title={ok ? (isDefault ? defaultTitle : undefined) : disabledTitle}
              onClick={() => ok && pick(day)}
              className={cn(
                "h-7 rounded-sm text-center text-[11px] tabular-nums transition-colors",
                ok
                  ? "text-foreground hover:bg-brand-700/10"
                  : "cursor-not-allowed text-muted-foreground/40",
                (isFrom || isTo) && "bg-brand-700 font-semibold text-white",
                inRange && "bg-brand-700/15",
                // 기본 회차 = 채우기(선택과 구분되게 연하게) + 굵은 글자.
                isDefault && "bg-brand-700/20 font-semibold text-foreground",
                day === todayKst && !(isFrom || isTo) && "ring-1 ring-brand-700/40",
              )}
            >
              {parseDay(day)!.d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
