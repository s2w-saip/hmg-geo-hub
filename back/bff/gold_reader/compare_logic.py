"""Existing period comparison rules, independent of legacy storage."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal

OWN_BITS = (1, 2, 4)
def round1(value: float) -> float:
    return math.floor(value * 10 + 0.5) / 10

CompareKind = Literal["window", "calendarMonth", "calendarWeek", "cycle"]
CompareUnit = Literal["pp", "rank", "pct"]
CompareFamily = Literal["mention", "citation"]
SuppressReason = Literal["unsupported", "no_prev", "no_data"]
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
# 비교할 값이 없을 때만 억제한다(⛔K, 2026-10-31 HUB 규칙 5: 측정 방식 · 범위가 달라 값이 튀어도 숨기거나 경고하지 않는다).
# 원본 API 명세의 missing_share(수집분 70% 미만) · start_window · start_month(시작 유예)와 적용일(2026-09-08) 게이트는 뺐다.
SUPPRESSION_PRECEDENCE: tuple[SuppressReason, ...] = ("unsupported", "no_prev", "no_data")
CALENDAR_WEEK_DAYS = 7

# ── 현행 프로필(compare_suppress) ──
LEGACY_UNSUPPORTED_SURFACES = ("global", "website")    # 현행 fetchPeriodCompare 표면(project 는 현행 기간 비교가 없다)
N_OWN_BRANDS = len(OWN_BITS)                # 현행 자사 명부 브랜드 수(Hyundai·Kia·Genesis = rd.answer 당사 열 h·k·g)


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
    days: int | None = None             # 창 비교의 N

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
    """구간 하나의 회차 원장 요약. planned·missing·published 는 필터 무관, data_cycles 만 필터 적용 후(현행 CompareLedger).
    planned · missing 은 응답의 planned_* · missing_share_* 로 그대로 싣는다(억제 판정에는 쓰지 않는다, ⛔K)."""
    planned_units: int = 0
    missing_units: int = 0
    published_cycles: int = 0
    data_cycles: int = 0

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


def range_windows(kind: str, lo: date, hi: date) -> Windows | None:
    """The windows of a closed period lo..hi by comparison kind (None when the period does not fit the kind)."""
    if kind == "window":
        return windows_from_range(lo, hi)
    if kind == "calendarMonth":
        return calendar_months(lo, hi)
    if kind == "calendarWeek":
        return calendar_weeks(lo, hi)
    return None


def cycle_windows(cur: date, prev: date | None) -> Windows:
    return Windows("cycle", prev=Span(prev, prev) if prev is not None else None, cur=Span(cur, cur))


# ── 억제 ────────────────────────────────────────────────────────────────────
def suppression_of(w: Windows, prev: Ledger, cur: Ledger, *, unsupported: bool = False) -> SuppressReason | None:
    """비교할 값이 없을 때의 사유(우선순위 SUPPRESSION_PRECEDENCE), 비교하면 None. 수집분 비중 · 측정 시작 구간은 보지
    않는다(⛔K 2026-10-31)."""
    if w.prev is None:
        return "unsupported" if unsupported else "no_prev"
    hit: set[str] = set()
    if unsupported:
        hit.add("unsupported")
    if prev.published_cycles <= 0:
        hit.add("no_prev")
    if prev.data_cycles <= 0 or cur.data_cycles <= 0:
        hit.add("no_data")
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
