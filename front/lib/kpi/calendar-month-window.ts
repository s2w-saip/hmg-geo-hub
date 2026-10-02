// ════════════════════════════════════════════════════════════════════════════
// 달력 월 구간 해소 — 순수 모듈(React·DB·`server-only` 비의존).
// ════════════════════════════════════════════════════════════════════════════
//
// GGMD-107 P1(제품 결정 Q2=b). "이번 달"·"지난달" 프리셋은 트레일링 창이 아니라
// **KST 달력 월**이고, 비교 대상도 다르다(스펙「달력 월 프리셋은 확정 MoM 정책을 따른다」):
//
//   | 프리셋   | 범위(cur)              | 비교 대상(prev) | 그 앞(before) |
//   | -------- | ---------------------- | --------------- | ------------- |
//   | 이번 달  | KST 이번 달 1일 ~ `E`  | 지난달 **전체** | 전전월 전체   |
//   | 지난달   | KST 지난달 1일 ~ 말일  | 전전월 **전체** | 그 앞 달 전체 |
//
// `before` 가 왜 필요한가: 달력 월은 창 비교의 `start_window`(`grace(N)`) 대신 MoM 의
// `start_month`(전전월 데이터 유무 2단 판정)를 쓴다 — 그 판정의 입력이 `before` 다.
//
// ── URL 에는 프리셋 이름이 없다 ────────────────────────────────────────────
//
// 기간 축의 URL 규약은 `?time=YYYY-MM-DD..YYYY-MM-DD` 하나뿐이고(design §2-1, 이 변경이
// 바꾸지 않는다) 프리셋 이름은 안 실린다. 그래서 서버는 **날짜쌍의 모양**으로 판정한다:
// 시작일이 어떤 KST 달의 1일이고 끝일이 **같은 달 안**이면 그 구간은 달력 월이다.
// 고객이 캘린더로 직접 `2026-09-01 ~ 2026-09-13` 을 골라도 같은 판정을 받는다 — 의도한
// 동작이다(그 구간의 자연스러운 비교 대상은 8월 전체다).
//
// 월 소속의 정본은 **KST** 다(design §13-2, mom `MOM_TIME_ZONE`). 실측(2026-09-17,
// 전 표면 1,028 회차)에서 월이 바뀌는 회차는 0건이라 §1-1 의 "멤버십은 UTC" 비대칭이
// 달력 월에서는 무해하다(날짜만 밀리는 회차 208).

import type { CompareKind, CompareWindow } from "@/lib/kpi/period-compare";

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** 그 달의 1일 / 말일. `m` 은 1~12 밖이어도 연도로 넘긴다(0 = 전년 12월). */
export function monthWindow(y: number, m: number): CompareWindow {
  const yy = y + Math.floor((m - 1) / 12);
  const mm = ((((m - 1) % 12) + 12) % 12) + 1;
  // `Date.UTC(y, m, 0)` 의 day=0 은 "그 달의 말일" — 30/31일·윤년을 달력이 스스로 센다.
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return { lo: `${yy}-${pad2(mm)}-01`, hi: `${yy}-${pad2(mm)}-${pad2(last)}` };
}

/** `YYYY-MM-DD` → 연·월·일. 형식이 아니면 `null`. */
function parseDay(day: string): { y: number; m: number; d: number } | null {
  const g = DAY_RE.exec(day);
  if (!g) return null;
  const y = Number(g[1]);
  const m = Number(g[2]);
  const d = Number(g[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

export interface CalendarMonths {
  /** 선택된 구간 그대로 — 진행 중인 달이면 부분 월이다. */
  cur: CompareWindow;
  /** 직전 달 **전체**. */
  prev: CompareWindow;
  /** 그 앞 달 전체 — `start_month` 2단 판정의 입력. */
  before: CompareWindow;
}

/**
 * 선택된 날짜쌍이 **달력 월**이면 세 구간을 돌려준다. 아니면 `null`(= 창 비교).
 *
 * 판정: `lo` 가 어떤 달의 1일이고 `hi` 가 같은 달 안이다.
 * 한쪽이라도 비면(open-ended) 기간 비교 자체가 성립하지 않으므로 `null`.
 */
export function resolveCalendarMonths(
  from: string | null | undefined,
  to: string | null | undefined,
): CalendarMonths | null {
  if (!from || !to) return null;
  const lo = parseDay(from);
  const hi = parseDay(to);
  if (!lo || !hi) return null;
  if (lo.d !== 1) return null;
  if (lo.y !== hi.y || lo.m !== hi.m) return null;
  const cur = monthWindow(lo.y, lo.m);
  // 끝일이 말일을 넘으면(2월 30일 같은 입력) 그 달이 아니다.
  if (to > cur.hi) return null;
  return {
    cur: { lo: cur.lo, hi: to },
    prev: monthWindow(lo.y, lo.m - 1),
    before: monthWindow(lo.y, lo.m - 2),
  };
}

/**
 * 지면이 게이트웨이에 넘길 **비교 모양** — 날짜쌍 하나에서 전부 파생된다.
 *
 * ⚠️ **네 지면이 반드시 이 함수를 쓴다**(대시보드 · 웹사이트 오버뷰 · 언급 · 인용).
 * 2026-09-19 프리뷰 실측 결함: 대시보드만 `kind:"window"` 를 하드코딩해서, 같은 URL
 * `?time=2026-09-01..2026-09-13` 이 대시보드에서는 **13일 트레일링**(+8.6pp), 언급
 * 페이지에서는 **달력 월 전체 대비**(+6.5pp)로 계산됐다. 스펙「달력 월 프리셋은 확정
 * MoM 정책을 따른다」(spec.md:242-250) SHALL 위반이고, 고객이 두 화면을 나란히 보면
 * 같은 기간의 같은 지표가 다른 수를 낸다. 판정을 지면에 흩으면 반드시 다시 갈린다.
 */
export interface PeriodCompareShape {
  kind: CompareKind;
  /** `kind:"calendarMonth"` 일 때만 채워진다. 게이트웨이에 그대로 넘긴다. */
  months?: { before: CompareWindow; prev: CompareWindow; cur: CompareWindow };
  /** 선택 구간의 길이(일, 양 끝 포함). 기간 미선택이면 `null`. 캡션 입력. */
  days: number | null;
}

/** `?time=lo..hi` 로 확정된 구간의 길이(일, 양 끝 포함). 한쪽이라도 비면 `null`. */
export function selectedWindowDays(
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  if (!from || !to) return null;
  const lo = Date.parse(`${from}T00:00:00Z`);
  const hi = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(lo) || Number.isNaN(hi) || hi < lo) return null;
  return Math.round((hi - lo) / 86_400_000) + 1;
}

export function resolvePeriodCompareShape(
  from: string | null | undefined,
  to: string | null | undefined,
): PeriodCompareShape {
  const months = resolveCalendarMonths(from, to);
  const days = selectedWindowDays(from, to);
  return months ? { kind: "calendarMonth", months, days } : { kind: "window", days };
}
