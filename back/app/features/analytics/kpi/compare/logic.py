"""기간 비교 Δ 순수 로직(DB·시계 비의존). 현행 front/lib/kpi/period-compare.ts·calendar-month-window.ts·period-compare-week.ts 이식.

창 수식(period-compare.ts 머리 주석): cur = [E−(N−1), E], prev = [E−(2N−1), E−N]. 달력 월 = 그 달 1일~E, 직전 달, 전전 달.
달력 주 = 그 주 월요일~E, 직전 주(7일). cycle(신설) = 최신 노출 회차 하루와 직전 노출 회차 하루(함대 규칙 Q1).
억제 사유 6종과 우선순위 = suppressionOf(period-compare.ts:490). 누락 비중 = Σ 미발행 expected_units ÷ Σ expected_units(Q2 가중).
답변당 언급·인용 수(BG-05, 현행 mentionsPerAnswer·citationsPerAnswer, summary-period-compare.ts:793-800)는 요청할 때만 낸다
(기본 지표 목록 METRICS 는 M01~M05 그대로). 단위 pct = 증감률 round1((cur − prev) ÷ prev × 100), 직전 값 0 이면 null(현행 deltaOf).

현행 프로필(core.profile, 제품 결정 19·24·25, 계획서 WU-9). 새 정의(스위치 꺼짐)는 적용일 게이트·집계층 억제가 없다(모듈-KPI §2 K-2).
켜면 현행 게이트웨이 fetchPeriodCompare(front/lib/scope/server.ts:5921-6034)의 두 분기를 그대로 재현한다:
- compare_epoch_gate: cur.hi < 적용일이면 비교하지 않는다(현행 `null` = 화면은 종전 Δ, server.ts:5959, 판정 period-compare.ts:297-302).
  적용일 = PERIOD_COMPARE_EPOCH(2026-09-08). 현행은 summary_settings.period_compare_epoch 행이 있으면 그 값이 이기지만(server.ts:5711)
  운영에 그 행이 없다(2026-10-01 WU-0 old-context: summary_settings 3행 read_enabled·read_screens·website_excluded_fs) = 상수와 같다.
  허브에는 그 설정 표가 없어 값을 바꾸려면 이 상수를 고친다(빌드 식별자가 바뀌어 결과 캐시도 새 키).
- compare_suppress: 현행 집계층이 표현 못 하는 조합(planTrendRead ok:false, summary-trend-aggregates.ts:388-451)은 전 지표
  `unsupported` 억제(값 없음·원장 0, server.ts:5986-5989·6060 emptyCompare). 조합 = depth2 또는 depth3 필터, 또는 관점 브랜드가 여럿이지만
  전부는 아닌 것(resolveOwnVariantKey null = admin 임의 다중 브랜드·다중 브랜드 스코프 계정). 판정 순서도 현행과 같다: 적용일 게이트가 먼저다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

from app.core.codes import OWN_BITS
from app.core.measure import round1

CompareKind = Literal["window", "calendarMonth", "calendarWeek", "cycle"]
CompareUnit = Literal["pp", "rank", "pct"]
CompareFamily = Literal["mention", "citation"]
SuppressReason = Literal["unsupported", "no_prev", "no_data", "missing_share", "start_window", "start_month"]
MetricKey = Literal["visibility", "share_of_voice", "sentiment", "position", "citation_share",
                    "mentions_per_answer", "citations_per_answer"]

METRICS: tuple[str, ...] = ("visibility", "share_of_voice", "sentiment", "position", "citation_share")   # 기본(metrics[] 생략)
PER_ANSWER_METRICS: tuple[str, ...] = ("mentions_per_answer", "citations_per_answer")                      # 요청할 때만(BG-05)
METRIC_UNIT: dict[str, CompareUnit] = {"visibility": "pp", "share_of_voice": "pp", "sentiment": "pp", "position": "rank",
                                       "citation_share": "pp", "mentions_per_answer": "pct", "citations_per_answer": "pct"}
# 지표 → 계열. 기본값을 두지 않는다(빠진 지표가 조용히 언급 계열로 떨어지지 않게: period-compare.ts COMPARE_METRIC_FAMILY).
METRIC_FAMILY: dict[str, CompareFamily] = {"visibility": "mention", "share_of_voice": "mention", "sentiment": "mention",
                                           "position": "mention", "citation_share": "citation",
                                           "mentions_per_answer": "mention", "citations_per_answer": "citation"}
SUPPRESSION_PRECEDENCE: tuple[SuppressReason, ...] = ("unsupported", "no_prev", "no_data", "missing_share", "start_window", "start_month")
MISSING_SHARE_MAX = 0.3                 # 경계 포함(>=)
MISSING_SHARE_MIN_WINDOW_DAYS = 30      # 창 비교만 길이 하한
START_MONTH_FIRST_WEEK_LAST_DAY = 7
CALENDAR_WEEK_DAYS = 7

# ── 현행 프로필(compare_epoch_gate·compare_suppress) ──
PERIOD_COMPARE_EPOCH = date(2026, 9, 8)     # 현행 period-compare.ts:297 PERIOD_COMPARE_EPOCH(운영 DB 덮어쓰기 행 없음, 머리 주석)
EPOCH_GATED = "before_epoch"                # meta.suppressed['*']: 적용일 전이라 비교 안 함(현행 null = 종전 Δ). 어댑터가 null 로 바꾼다
LEGACY_UNSUPPORTED_SURFACES = ("global", "website")    # 현행 fetchPeriodCompare 표면(project 는 현행 기간 비교가 없다)
N_OWN_BRANDS = len(OWN_BITS)                # 현행 자사 명부 브랜드 수(Hyundai·Kia·Genesis = rd.answer 당사 열 h·k·g)


def period_compare_applies(cur_hi: date, epoch: date = PERIOD_COMPARE_EPOCH) -> bool:
    """periodCompareApplies 이식(period-compare.ts:300): cur.hi ≥ 적용일이면 비교한다(경계 포함)."""
    return cur_hi >= epoch


def legacy_unsupported_reason(surface: str, *, depth2: bool, depth3: bool, own_bits: tuple[int, ...] | list[int]) -> str | None:
    """planTrendRead ok:false 이식(summary-trend-aggregates.ts:421-451, 관점 판정 :388-398). 사유 문자열은 현행 로그 표기(unsupported-agg:*)와 같다.
    관점 브랜드: 현행 resolveOwnVariantKey 는 선택 명부가 전부면 ALL, 정본 브랜드 하나면 그 브랜드, 둘 이상이면 null(폴백 신호).
    허브 관점 비트(ReadContext.own_bits, 하위 브랜드는 부모 비트로 접힘)의 서로 다른 개수로 같은 판정을 한다."""
    if surface not in LEGACY_UNSUPPORTED_SURFACES:
        return None
    if depth2:
        return "unsupported-agg:depth2"
    if depth3:
        return "unsupported-agg:depth3"
    n = len(set(own_bits))
    if 1 < n < N_OWN_BRANDS:
        return "unsupported-agg:own-variant"
    return None


@dataclass(frozen=True)
class Span:
    """양 끝 포함 구간(round_date 축)."""
    lo: date
    hi: date

    def __contains__(self, d: object) -> bool:
        return isinstance(d, date) and self.lo <= d <= self.hi

    @property
    def days(self) -> int:
        return (self.hi - self.lo).days + 1


@dataclass(frozen=True)
class Windows:
    kind: CompareKind
    prev: Span | None                   # cycle 에서 직전 노출 회차가 없으면 None(no_prev)
    cur: Span
    before: Span | None = None
    days: int | None = None             # 창 비교의 N(억제 판정 입력)

    def spans(self) -> dict[str, Span]:
        out = {"cur": self.cur}
        if self.prev is not None:
            out["prev"] = self.prev
        if self.before is not None:
            out["before"] = self.before
        return out

    def label_of(self, d: date) -> str | None:
        for k, s in self.spans().items():
            if d in s:
                return k
        return None

    @property
    def scan(self) -> Span:
        ss = self.spans().values()
        return Span(min(s.lo for s in ss), max(s.hi for s in ss))


@dataclass
class Ledger:
    """구간 하나의 회차 원장 요약. planned·missing·published 는 필터 무관, data_cycles 만 필터 적용 후(현행 CompareLedger)."""
    planned_units: int = 0
    missing_units: int = 0
    published_cycles: int = 0
    data_cycles: int = 0
    first_published: date | None = None

    @property
    def planned_known(self) -> bool:
        return self.planned_units > 0

    @property
    def missing_share(self) -> float:
        return self.missing_units / self.planned_units if self.planned_units > 0 else 0.0


# ── 창 ──────────────────────────────────────────────────────────────────────
def resolve_windows(end: date, days: int) -> Windows:
    if days < 1:
        raise ValueError(f"창 길이는 1 이상: {days}")
    return Windows("window", prev=Span(end - timedelta(days=2 * days - 1), end - timedelta(days=days)),
                   cur=Span(end - timedelta(days=days - 1), end), days=days)


def windows_from_range(lo: date, hi: date) -> Windows:
    if hi < lo:
        raise ValueError("from ≤ to")
    return resolve_windows(hi, (hi - lo).days + 1)


def _month_span(y: int, m: int) -> Span:
    yy, mm = y + (m - 1) // 12, (m - 1) % 12 + 1
    first = date(yy, mm, 1)
    nxt = date(yy + (mm // 12), mm % 12 + 1, 1)
    return Span(first, nxt - timedelta(days=1))


def calendar_months(lo: date, hi: date) -> Windows | None:
    """resolveCalendarMonths 이식: from 이 1일이고 to 가 같은 달 안이어야 한다(아니면 None)."""
    if lo.day != 1 or (lo.year, lo.month) != (hi.year, hi.month) or hi < lo:
        return None
    return Windows("calendarMonth", prev=_month_span(lo.year, lo.month - 1), cur=Span(lo, hi),
                   before=_month_span(lo.year, lo.month - 2))


def calendar_months_of(end: date) -> Windows:
    return calendar_months(end.replace(day=1), end)  # type: ignore[return-value]


def calendar_weeks(lo: date, hi: date) -> Windows | None:
    """resolveCalendarWeeks 이식: from 이 월요일이고 to 가 그 주 안이어야 한다(아니면 None)."""
    if lo.isoweekday() != 1 or hi < lo or hi > lo + timedelta(days=CALENDAR_WEEK_DAYS - 1):
        return None
    pm = lo - timedelta(days=CALENDAR_WEEK_DAYS)
    return Windows("calendarWeek", prev=Span(pm, pm + timedelta(days=CALENDAR_WEEK_DAYS - 1)), cur=Span(lo, hi))


def calendar_weeks_of(end: date) -> Windows:
    return calendar_weeks(end - timedelta(days=end.isoweekday() - 1), end)  # type: ignore[return-value]


def cycle_windows(cur: date, prev: date | None) -> Windows:
    return Windows("cycle", prev=Span(prev, prev) if prev is not None else None, cur=Span(cur, cur))


# ── 억제 ────────────────────────────────────────────────────────────────────
def grace_days(days: int) -> int:
    if days < 1:
        raise ValueError(f"창 길이는 1 이상: {days}")
    return math.ceil(days / 4)


def applies_missing_share(kind: CompareKind, days: int) -> bool:
    """달력 월·주·cycle 은 항상, 창 비교는 30일 이상(appliesMissingShare 이식, cycle 은 주와 같은 원장 모양이라 항상)."""
    if kind in ("calendarMonth", "calendarWeek", "cycle"):
        return True
    return days >= MISSING_SHARE_MIN_WINDOW_DAYS


def judge_start_window(first: date | None, prev_lo: date, days: int) -> bool:
    return first is not None and first > prev_lo + timedelta(days=grace_days(days))


def judge_start_month(first: date | None, prev: Span, before_data_cycles: int) -> bool:
    if before_data_cycles > 0 or first is None or first not in prev:
        return False
    return first.day > START_MONTH_FIRST_WEEK_LAST_DAY


def suppression_of(w: Windows, prev: Ledger, cur: Ledger, *, before: Ledger | None = None,
                   unsupported: bool = False) -> SuppressReason | None:
    days = w.days if w.days is not None else w.cur.days
    if w.prev is None:
        return "unsupported" if unsupported else "no_prev"
    hit: set[str] = set()
    if unsupported:
        hit.add("unsupported")
    if prev.published_cycles <= 0:
        hit.add("no_prev")
    if prev.data_cycles <= 0 or cur.data_cycles <= 0:
        hit.add("no_data")
    if applies_missing_share(w.kind, days):
        def over(x: Ledger) -> bool:
            return x.planned_known and x.missing_share >= MISSING_SHARE_MAX
        if over(prev) or over(cur):
            hit.add("missing_share")
    if w.kind in ("window", "calendarWeek"):
        if judge_start_window(prev.first_published, w.prev.lo, CALENDAR_WEEK_DAYS if w.kind == "calendarWeek" else days):
            hit.add("start_window")
    elif w.kind == "calendarMonth" and judge_start_month(prev.first_published, w.prev, before.data_cycles if before else 0):
        hit.add("start_month")
    return next((r for r in SUPPRESSION_PRECEDENCE if r in hit), None)


# ── Δ ───────────────────────────────────────────────────────────────────────
def delta_of(unit: CompareUnit, prev: tuple[int, int], cur: tuple[int, int]) -> float | None:
    """pp = round1((cur − prev) × 100), rank = round1(cur − prev), pct = round1((cur − prev) ÷ prev × 100)(직전 값 0 이면 None,
    현행 deltaOf period-compare.ts:538). 분모 0 이면 None. 부호는 원시값(순위 반전은 화면)."""
    (pn, pd), (cn, cd) = prev, cur
    if pd <= 0 or cd <= 0:
        return None
    p, c = pn / pd, cn / cd
    if unit == "pct":
        return None if p == 0 else round1((c - p) / p * 100)
    return round1((c - p) * 100) if unit == "pp" else round1(c - p)
