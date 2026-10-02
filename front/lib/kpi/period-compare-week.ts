// ════════════════════════════════════════════════════════════════════════════
// 달력 주(WoW) 구간 해소 + 회차의 **정규 요일** — 순수 모듈(React·DB 비의존).
// ════════════════════════════════════════════════════════════════════════════
//
// 달력 월(`lib/kpi/calendar-month-window.ts`)의 주 단위 짝이다. 산식·억제·표시는
// 한 벌뿐이고(`period-compare.ts` · `period-compare-view.ts`), 이 파일이 더하는 것은
// **"어느 날짜쌍이 한 주인가"** 와 **"그 주의 회차는 무슨 요일에 귀속되는가"** 둘뿐이다.
//
// ── 왜 주 경계가 월~일인가 ─────────────────────────────────────────────────
//
// 앵커 축의 주 버킷은 `scope_answer_cycle_anchors.anchor_week` = **`round_date` 가 속한
// KST 주의 월요일**이다(계약 §2). 정규 요일(스펙 §9.2)은 글로벌 = 월요일, 웹사이트 =
// 금요일이므로 월~일 버킷 하나에 표면별 정규 회차가 **정확히 하나** 들어온다. 그래서
// "직전 주 = 직전 `anchor_week`" 가 곧 "글로벌은 월요일 회차끼리, 웹사이트는 금요일
// 회차끼리" 이고, 표면별로 다른 주 경계를 둘 필요가 없다.
//
// 웹사이트 기준으로 금~목 주를 따로 만들지 않은 이유도 같다: 그렇게 하면 한 회차가
// 두 표면에서 다른 주에 속해 `anchor_week` 와 갈린다(조인이 에러 없이 행을 잃는 형태).
//
// ── 날짜는 이미 KST 달력 일자다 ────────────────────────────────────────────
//
// 입력 `Day`(`YYYY-MM-DD`)는 앵커 축에서 이미 KST 로 잘린 값이다(계약 §2 `round_date`).
// 따라서 이 파일의 산술에 타임존이 다시 끼면 안 된다 — 문자열을 UTC 자정으로 고정해
// **달력 산술만** 한다(`period-compare.ts` 의 `addDays` 와 같은 자세).

import {
  addDays,
  assertDay,
  diffDays,
  CALENDAR_WEEK_DAYS,
  type CompareKind,
  type CompareWindow,
  type Day,
} from "@/lib/kpi/period-compare";
import { resolveCalendarMonths, type CalendarMonths } from "@/lib/kpi/calendar-month-window";

/** 요일 번호 — 월=1 … 일=7(ISO). `Date.getUTCDay()`(일=0)와 다르다. */
export type IsoDow = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * 표면별 **정규 회차 요일**(스펙 §9.2, 제품 확정 2026-09-19 밤).
 *
 * 프로젝트 표면은 정규 요일이 없다 — 귀속 날짜가 곧 `anchor_date` 라 여기 없는 것이 맞다.
 * 리터럴을 흩지 말고 이 표를 경유한다(요일이 바뀌면 고칠 자리가 하나여야 한다).
 */
export const REGULAR_ROUND_DOW = {
  global: 1, // 월요일
  website: 5, // 금요일
} as const satisfies Record<"global" | "website", IsoDow>;

export type RegularRoundSurface = keyof typeof REGULAR_ROUND_DOW;

/** `YYYY-MM-DD` → ISO 요일(월=1 … 일=7). */
export function isoDowOf(day: string): IsoDow {
  const d = new Date(`${assertDay(day, "day")}T00:00:00Z`);
  return (((d.getUTCDay() + 6) % 7) + 1) as IsoDow;
}

/** 그 날이 속한 KST 주의 **월요일**. `anchor_week` 와 같은 값이어야 한다. */
export function weekMondayOf(day: string): Day {
  return addDays(assertDay(day, "day"), -(isoDowOf(day) - 1));
}

/** 월요일 → 그 주 구간(월~일, 양 끝 포함). */
export function weekWindowOf(monday: string): CompareWindow {
  const lo = assertDay(monday, "monday");
  return { lo, hi: addDays(lo, CALENDAR_WEEK_DAYS - 1) };
}

/**
 * 그 날이 속한 주의 **정규 회차 날짜**(표면별). 스펙 §9.2 의 귀속 날짜와 같은 값이다.
 *
 * ⚠️ **§9.2 의 happy path 만** 구현한다. 앵커가 정규 요일이 아닐 때의 "앞 자리·뒤 자리"
 *    배정은 그 프로젝트의 다른 회차를 봐야 정해지고, 그 배정은 **저장된 값**이다
 *    (`scope_answer_cycle_anchors.round_date`). 그래서 이 함수는 그 저장값을 읽을 수
 *    **없는 회차에만** 쓰는 폴백이다 — 앵커 테이블에 행이 없는 회차, 즉 완료 답변이
 *    한 건도 없는 **미발행 회차**가 사실상 전부다(발행 회차는 답변이 있으므로 저장값이 있다).
 *    미발행 회차를 축에서 떨어뜨리면 그 계획 단위가 사라져 **누락 비중이 항상 0** 이 된다
 *    (= 억제가 영영 안 걸린다). 모르면 억제되는 쪽으로 세는 것이 이 폴백의 목적이다.
 */
export function regularRoundDateOf(surface: RegularRoundSurface, day: string): Day {
  return addDays(weekMondayOf(day), REGULAR_ROUND_DOW[surface] - 1);
}

export interface CalendarWeeks {
  /** 선택된 구간 그대로 — 진행 중인 주면 부분 주다. */
  cur: CompareWindow;
  /** 직전 주 **전체**(월~일). */
  prev: CompareWindow;
  /** 그 앞 주 전체. 달력 월의 `before` 와 같은 자리(진단·확장용). */
  before: CompareWindow;
}

/**
 * 선택된 날짜쌍이 **달력 주**면 세 구간을 돌려준다. 아니면 `null`(= 창 비교).
 *
 * 판정: `lo` 가 월요일이고 `hi` 가 **같은 주 안**이다. 달력 월과 같은 자세로, URL 에
 * 프리셋 이름이 없으므로(`?time=lo..hi` 하나뿐) **날짜쌍의 모양**으로만 판정한다.
 * 고객이 달력에서 월요일~오늘을 직접 골라도 같은 판정을 받는다 — 그 구간의 자연스러운
 * 비교 대상은 직전 주 전체다.
 *
 * ⚠️ 월과 주가 **동시에** 성립하는 날짜쌍이 있다(그 달 1일이 월요일인 달의 첫 주).
 *    우선순위는 `resolveComparePeriodShape` 가 정한다 — 월이 이긴다.
 */
export function resolveCalendarWeeks(
  from: string | null | undefined,
  to: string | null | undefined,
): CalendarWeeks | null {
  if (!from || !to) return null;
  let lo: Day;
  let hi: Day;
  try {
    lo = assertDay(from, "from");
    hi = assertDay(to, "to");
  } catch {
    return null;
  }
  if (hi < lo) return null;
  if (isoDowOf(lo) !== 1) return null;
  const week = weekWindowOf(lo);
  if (hi > week.hi) return null;
  const prevMonday = addDays(lo, -CALENDAR_WEEK_DAYS);
  return {
    cur: { lo, hi },
    prev: weekWindowOf(prevMonday),
    before: weekWindowOf(addDays(prevMonday, -CALENDAR_WEEK_DAYS)),
  };
}

/**
 * 지면이 게이트웨이에 넘길 **비교 모양** — 달력 월 판정(`resolvePeriodCompareShape`)의
 * 상위 집합이다. 월 → 주 → 창 순으로 본다.
 *
 * 월을 먼저 보는 이유: 1일이 월요일인 달의 `2026-06-01..2026-06-07` 은 두 판정이 모두
 * 참인데, 고객이 그 구간을 고르는 맥락은 "이번 달"(프리셋)이 압도적이고 비교 대상도
 * 직전 **달**이 자연스럽다. 순서를 지면마다 고르게 두면 같은 URL 이 화면마다 다른 수를
 * 낸다 — 2026-09-19 프리뷰에서 실제로 났던 결함(대시보드만 `kind:"window"` 하드코딩)이
 * 정확히 그 형태다.
 */
export interface ComparePeriodShape {
  kind: CompareKind;
  months?: CalendarMonths;
  weeks?: CalendarWeeks;
  /** 선택 구간의 길이(일, 양 끝 포함). 기간 미선택이면 `null`. 캡션 입력. */
  days: number | null;
}

export function resolveComparePeriodShape(
  from: string | null | undefined,
  to: string | null | undefined,
): ComparePeriodShape {
  const days = from && to ? safeDays(from, to) : null;
  const months = resolveCalendarMonths(from, to);
  if (months) return { kind: "calendarMonth", months, days };
  const weeks = resolveCalendarWeeks(from, to);
  if (weeks) return { kind: "calendarWeek", weeks, days };
  return { kind: "window", days };
}

function safeDays(from: string, to: string): number | null {
  try {
    const n = diffDays(assertDay(from, "from"), assertDay(to, "to")) + 1;
    return n >= 1 ? n : null;
  } catch {
    return null;
  }
}
