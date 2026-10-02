// ════════════════════════════════════════════════════════════════════════════
// 선택 가능한 회차 날짜 — **순수 모듈**(React·DB·`server-only` 비의존).
// ════════════════════════════════════════════════════════════════════════════
//
// 앵커 축 전환(스펙 `hmg-geo-answer-anchor-table-spec-2026-09-19` §5.1·§9.2)에서
// 기간 필터의 달력은 **회차가 있는 날짜만** 고를 수 있어야 한다. 그 날짜 목록은
// 서버가 `listSelectableAnchorDates` 로 뽑아 prop `selectableDates` 로 내려준다
// (KST `YYYY-MM-DD`, 오름차순). 목록이 없으면(`undefined`) 종전 동작 그대로다.
//
// ── 시계가 하나뿐인 이유 ───────────────────────────────────────────────────
//
// 종전 패널 안에는 시계가 셋이었다: `isoDay(d: Date)` 는 **브라우저 로컬 달력**,
// `kstYmd` 는 KST, 서버 창 산술은 UTC. 같은 "오늘"이 사용자의 시간대에 따라 셋으로
// 갈린다. 이 모듈의 함수는 전부 **KST 날짜 문자열 산술**만 쓴다:
//   · `Date` 의 로컬 메서드(`getFullYear`·`getMonth`·`getDate`·`getDay`)를 쓰지 않는다.
//   · 달력 산술이 필요할 때만 `Date.UTC(...)` + `getUTC*` 를 쓴다 — 이건 시간대가 아니라
//     "윤년·30/31일을 달력이 스스로 세게" 하는 순수 계산이다.
//   · "오늘"은 instant 를 KST 로 옮긴 뒤 UTC 필드를 읽어 만든다(`kstToday`).

import type { TimeRangeValue } from "./filter-encoding";

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad2 = (n: number) => String(n).padStart(2, "0");

export function isDay(s: string | null | undefined): s is string {
  return typeof s === "string" && DAY_RE.test(s);
}

/** `YYYY-MM-DD` → 연·월·일. 형식이 아니면 `null`. */
export function parseDay(day: string): { y: number; m: number; d: number } | null {
  const g = DAY_RE.exec(day);
  if (!g) return null;
  const y = Number(g[1]);
  const m = Number(g[2]);
  const d = Number(g[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

export const formatDay = (y: number, m: number, d: number): string =>
  `${y}-${pad2(m)}-${pad2(d)}`;

/**
 * **KST 의 오늘**(`YYYY-MM-DD`). instant 를 +9h 옮긴 뒤 UTC 필드를 읽는다 —
 * 브라우저가 어느 시간대에 있든 같은 값이다.
 * (검증: `2026-09-18T15:00:00Z` = KST 2026-09-19 00:00 → `"2026-09-19"`)
 */
export function kstToday(now: Date = new Date()): string {
  const t = new Date(now.getTime() + KST_OFFSET_MS);
  return formatDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 그 달의 일 수. `Date.UTC(y, m, 0)` 의 day=0 = "그 달의 말일". */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 요일 인덱스(0=일 … 6=토). KST 날짜 문자열을 그대로 센다(시간대 변환 없음). */
export function weekdayIndex(day: string): number {
  const p = parseDay(day);
  if (!p) return 0;
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/** 날짜 문자열 ± n일. 달·해 넘김은 달력이 센다. */
export function addDays(day: string, n: number): string {
  const p = parseDay(day);
  if (!p) return day;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * 86_400_000);
  return formatDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * 날짜 문자열 ± n년 — 같은 월·일, 없는 날(2/29)은 그 달의 말일로 **클램프**한다.
 * (`Date.setFullYear` 는 2/29 를 3/1 로 넘긴다. 기간의 시작일이 달을 넘어가면
 *  "1년 전 같은 날"이라는 라벨과 어긋나므로 클램프 쪽을 택한다.)
 */
export function addYears(day: string, n: number): string {
  const p = parseDay(day);
  if (!p) return day;
  const y = p.y + n;
  return formatDay(y, p.m, Math.min(p.d, daysInMonth(y, p.m)));
}

/** `YYYY-MM` ± n개월 → `{ y, m }`. */
export function shiftMonth(y: number, m: number, n: number): { y: number; m: number } {
  const total = y * 12 + (m - 1) + n;
  return { y: Math.floor(total / 12), m: (((total % 12) + 12) % 12) + 1 };
}

// ─── 스냅 ────────────────────────────────────────────────────────────────────

/**
 * 목록을 **정렬·중복 제거·형식 검사**한 정규형으로 만든다.
 *
 * 아래 스냅 함수들은 전부 "오름차순"을 전제로 이진 탐색 대신 `find`/`pop` 을 쓴다.
 * 서버 리더가 이미 `ORDER BY d` 로 주지만, prop 은 통합 단계에서 다른 경로로도
 * 들어올 수 있으므로 컴포넌트 경계에서 한 번만 정규화한다(무해한 멱등 연산).
 */
export function normalizeSelectableDates(dates: readonly string[]): string[] {
  return [...new Set(dates.filter(isDay))].sort();
}

/** 목록에 그 날짜가 있는가. */
export const isSelectable = (day: string, dates: readonly string[]): boolean =>
  dates.includes(day);

/**
 * `day` 에 가장 가까운 선택 가능 날짜. 동점(앞뒤 거리가 같음)이면 `tie` 쪽.
 * 목록이 비면 `null`.
 */
export function nearestSelectable(
  day: string,
  dates: readonly string[],
  tie: "earlier" | "later" = "earlier",
): string | null {
  if (dates.length === 0) return null;
  if (!isDay(day)) return null;
  const before = [...dates].filter((d) => d <= day).pop() ?? null;
  const after = dates.find((d) => d >= day) ?? null;
  if (before === null) return after;
  if (after === null) return before;
  if (before === after) return before;
  const db = dayDiff(before, day);
  const da = dayDiff(day, after);
  if (db < da) return before;
  if (da < db) return after;
  return tie === "earlier" ? before : after;
}

/** 두 날짜의 일수 차(`b - a`). 형식이 아니면 `Infinity`(= 후보에서 밀린다). */
export function dayDiff(a: string, b: string): number {
  const pa = parseDay(a);
  const pb = parseDay(b);
  if (!pa || !pb) return Number.POSITIVE_INFINITY;
  return (
    (Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000
  );
}

export interface SnappedRange {
  from?: string;
  to?: string;
  /** 시작일이 요청과 달라졌다. */
  snappedFrom: boolean;
  /** 종료일이 요청과 달라졌다. */
  snappedTo: boolean;
  /** 스냅 전의 요청값(사용자에게 "무엇이 무엇으로 바뀌었는지" 보여 주기 위해). */
  requested: TimeRangeValue;
}

/**
 * URL·직접 입력으로 들어온 범위를 **선택 가능한 날짜로** 스냅한다.
 *
 * 순서가 중요하다 — **종료일을 먼저** 스냅하고, 시작일은 그 종료일 **이하**에서
 * 가장 가까운 날짜로 스냅한다. 양쪽을 따로 스냅하면 동점 처리에 따라 시작일이
 * 종료일을 넘어설 수 있다(예: 목록 `[09-07, 09-13]`, 요청 `09-10..09-10` →
 * 시작 09-13 · 종료 09-07). 이 순서면 정의상 `from <= to` 다.
 *
 * 목록이 비면 스냅하지 않는다(= "모른다", 종전 동작).
 */
export function snapRange(
  range: TimeRangeValue | null | undefined,
  dates: readonly string[],
): SnappedRange {
  const requested: TimeRangeValue = { from: range?.from, to: range?.to };
  if (dates.length === 0 || (!requested.from && !requested.to)) {
    return { ...requested, snappedFrom: false, snappedTo: false, requested };
  }
  let to = requested.to;
  if (to) to = nearestSelectable(to, dates, "earlier") ?? to;
  let from = requested.from;
  if (from) {
    const pool = to ? dates.filter((d) => d <= to!) : dates;
    from = nearestSelectable(from, pool, "later") ?? nearestSelectable(from, dates, "later") ?? from;
  }
  return {
    from,
    to,
    snappedFrom: Boolean(requested.from) && from !== requested.from,
    snappedTo: Boolean(requested.to) && to !== requested.to,
    requested,
  };
}

/**
 * 창 `[from, to]` 안의 **회차 수**. 한쪽이 비면 그쪽은 무제한으로 본다.
 * (달력이 "회차 3개"로 보여 주는 값 — 기간 술어가 `round_date BETWEEN` 이므로
 *  창 안의 선택 가능 날짜 수가 곧 조회에 들어오는 회차 수다.)
 */
export function countRounds(
  dates: readonly string[],
  from?: string | null,
  to?: string | null,
): number {
  return dates.filter((d) => (!from || d >= from) && (!to || d <= to)).length;
}

/**
 * 프리셋의 **원본 창**을 선택 가능한 날짜로 스냅한다(요구 3).
 *   · 끝점 = 창 안에서 **가장 늦은** 선택 가능 날짜(= 목록 최신 날짜 이하에서 가장 가까운 날짜)
 *   · 시작점 = 창 안에서 **가장 이른** 선택 가능 날짜
 * 창 안에 회차가 하나도 없으면 `null` → 호출부가 그 프리셋을 비활성화한다.
 */
export function snapPresetWindow(
  raw: { from: string; to: string },
  dates: readonly string[],
): { from: string; to: string } | null {
  const inWindow = dates.filter((d) => d >= raw.from && d <= raw.to);
  if (inWindow.length === 0) return null;
  return { from: inWindow[0], to: inWindow[inWindow.length - 1] };
}

// ─── 프리셋 창 (KST 문자열 산술) ─────────────────────────────────────────────

/** 트레일링 창 프리셋의 길이(일). `yearly` 만 여기 없다(1년 전 같은 날부터). */
const TRAILING_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

/**
 * 그 날이 속한 **KST 주의 월요일**. 앵커 테이블의 `anchor_week`(= `round_date` 가 속한
 * KST 주의 월요일, 계약 §2)와 같은 값이어야 한다.
 *
 * `lib/kpi/period-compare-week.ts::weekMondayOf` 와 같은 규칙이지만 여기서 한 번 더
 * 정의한다 — 이 모듈은 **클라이언트 번들**(필터 패널)에 들어가고 저쪽은 비교 산식
 * 모듈을 끌고 온다. 두 벌이 갈리지 않는 것은 테스트가 같은 날짜쌍으로 고정한다.
 */
export function weekMondayOfDay(day: string): string {
  const dow = weekdayIndex(day); // 0=일 … 6=토
  return addDays(day, -((dow + 6) % 7));
}

/** 월요일 → 그 주의 월~일 구간(양 끝 포함). */
export function weekBounds(monday: string): { lo: string; hi: string } {
  return { lo: monday, hi: addDays(monday, 6) };
}

/**
 * 회차가 하나도 없는 창에서 내는 **이동 제안** — 가장 가까운 회차가 속한 **KST 주**(월~일).
 *
 * 왜 하루가 아니라 주인가(2026-09-20 프리뷰 실측): 종전에는 `snapRange` 결과를 그대로
 * 제안해 `2026-09-07..2026-09-07` 같은 **하루 창**을 냈다. 그것을 적용하면 직전 구간도
 * 하루가 되어 비교할 회차가 없고, 카드 5개의 증감이 전부 `―` 가 된다 — "가장 가까운
 * 회차로 이동" 을 눌렀는데 증감이 통째로 비는 화면이 되는 것이다.
 * 같은 회차를 품은 주 창(`2026-09-07..2026-09-13`)은 `calendarWeek` 으로 읽혀
 * **직전 주와 비교(WoW)** 가 살아난다(실측: 그 창에서 `전전주 대비 8.1pp`).
 *
 * 표면별 요일 차이는 이 함수가 알 필요가 없다 — 글로벌은 회차가 월요일이라 그 주의
 * 월~일이 되고, website 는 금요일이라 **그 금요일이 속한** 월~일이 된다. 어느 쪽이든
 * 제안 창은 그 회차를 반드시 포함한다(주 경계로 넓히기만 하므로).
 *
 * 한쪽만 열린 요청(`from` 만·`to` 만)도 **닫힌 주 창**으로 낸다: 빈 화면에서 여는
 * 제안이라 열린 창을 유지할 이유가 없고, 열린 채로 두면 직전 구간 길이가 정의되지 않아
 * 같은 결함(증감 전멸)이 그대로 남는다.
 */
export function suggestWeekWindow(
  range: TimeRangeValue | null | undefined,
  dates: readonly string[],
): { from: string; to: string } | null {
  const snapped = snapRange(range, dates);
  const lo = snapped.from ?? snapped.to;
  const hi = snapped.to ?? snapped.from;
  if (!isDay(lo) || !isDay(hi)) return null;
  return { from: weekMondayOfDay(lo), to: weekBounds(weekMondayOfDay(hi)).hi };
}

/**
 * 프리셋의 **원본 창**을 KST 문자열 산술로 만든다 — `selectableDates` 경로 전용.
 *
 * 종전 `presetRange` 와 같은 의미이되 시계가 하나다: 끝점 `E` 가 없으면 **KST 의
 * 오늘**을 쓴다(종전에는 브라우저 로컬 달력의 오늘이었다).
 *
 * @param todayKst `kstToday(now)` 의 결과를 주입받는다(순수 함수로 두기 위해).
 */
export function presetWindowKst(
  preset: string,
  endDay: string | null | undefined,
  minDay: string | null | undefined,
  todayKst: string,
): { from: string; to: string } {
  const end = isDay(endDay) ? endDay : todayKst;

  const span = TRAILING_DAYS[preset];
  const from0 = span ? addDays(end, -(span - 1)) : addYears(end, -1);
  const from = isDay(minDay) && from0 < minDay && minDay < end ? minDay : from0;
  return { from, to: end };
}
