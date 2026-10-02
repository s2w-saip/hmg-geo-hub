"""기간 비교 순수 로직 골든(현행 front/lib/kpi/period-compare.test.ts·calendar-month-window·period-compare-week 이식)."""
from __future__ import annotations

from datetime import date

import pytest

from app.features.analytics.kpi.compare.logic import (
    MISSING_SHARE_MAX,
    SUPPRESSION_PRECEDENCE,
    Ledger,
    Span,
    Windows,
    applies_missing_share,
    calendar_months,
    calendar_months_of,
    calendar_weeks,
    calendar_weeks_of,
    cycle_windows,
    delta_of,
    grace_days,
    judge_start_month,
    judge_start_window,
    resolve_windows,
    suppression_of,
    windows_from_range,
)

D = date.fromisoformat


def test_window_formula_spec_scenario():
    w = resolve_windows(D("2026-09-13"), 7)
    assert (w.cur.lo, w.cur.hi) == (D("2026-09-07"), D("2026-09-13"))
    assert (w.prev.lo, w.prev.hi) == (D("2026-08-31"), D("2026-09-06"))


@pytest.mark.parametrize("n", [7, 14, 30, 365])
def test_windows_equal_length_adjacent(n):
    w = resolve_windows(D("2026-09-13"), n)
    assert w.cur.days == n and w.prev.days == n
    assert (w.cur.lo - w.prev.hi).days == 1


def test_365_prev_and_range_entry():
    w = resolve_windows(D("2026-09-13"), 365)
    assert w.prev.days == 365
    r = windows_from_range(D("2026-09-01"), D("2026-09-30"))
    assert r.days == 30 and (r.prev.lo, r.prev.hi) == (D("2026-08-02"), D("2026-08-31"))
    with pytest.raises(ValueError):
        resolve_windows(D("2026-09-13"), 0)


def test_grace_days():
    assert [grace_days(n) for n in (7, 14, 30, 365)] == [2, 4, 8, 92]


def test_missing_share_and_threshold():
    led = Ledger(planned_units=35264, missing_units=14404)
    assert led.missing_share == pytest.approx(14404 / 35264)
    assert Ledger().missing_share == 0.0 and not Ledger().planned_known
    assert MISSING_SHARE_MAX == 0.3


def test_applies_missing_share():
    assert not applies_missing_share("window", 7) and not applies_missing_share("window", 14)
    assert applies_missing_share("window", 30) and applies_missing_share("window", 365)
    assert applies_missing_share("calendarMonth", 28) and applies_missing_share("calendarWeek", 7)
    assert applies_missing_share("cycle", 1)


def test_start_window():
    assert not judge_start_window(D("2026-07-22"), D("2026-07-16"), 30)   # grace 8 → 07-24 까지 허용
    assert judge_start_window(D("2026-07-30"), D("2026-07-16"), 30)
    assert not judge_start_window(D("2026-07-24"), D("2026-07-16"), 30)   # 경계일은 시작 구간 아님
    assert not judge_start_window(None, D("2026-07-16"), 30)
    assert not judge_start_window(D("2026-07-02"), D("2026-08-29"), 7)    # F 는 전 이력 첫 발행
    assert judge_start_window(D("2026-09-04"), D("2026-08-29"), 7)


def test_start_month():
    prev = Span(D("2026-07-01"), D("2026-07-31"))
    assert not judge_start_month(D("2026-07-20"), prev, before_data_cycles=1)
    assert not judge_start_month(D("2026-07-06"), prev, 0)               # 첫째 주 안 시작 = 온전한 달
    assert judge_start_month(D("2026-07-20"), prev, 0)
    assert not judge_start_month(D("2026-06-10"), prev, 0)               # 그 달 밖(더 과거)


def _w(kind="window", days=30):
    return Windows(kind, prev=Span(D("2026-07-16"), D("2026-08-14")), cur=Span(D("2026-08-15"), D("2026-09-13")), days=days)


def test_precedence_exhaustive():
    assert SUPPRESSION_PRECEDENCE == ("unsupported", "no_prev", "no_data", "missing_share", "start_window", "start_month")
    cur = Ledger(planned_units=10, published_cycles=2, data_cycles=2)

    def worst(**o):
        base = dict(planned_units=100, missing_units=45, published_cycles=2, data_cycles=2, first_published=D("2026-08-10"))
        base.update(o)
        return Ledger(**base)
    assert suppression_of(_w(), worst(published_cycles=0, data_cycles=0), cur, unsupported=True) == "unsupported"
    assert suppression_of(_w(), worst(published_cycles=0), cur) == "no_prev"
    assert suppression_of(_w(), worst(data_cycles=0), cur) == "no_data"
    assert suppression_of(_w(), worst(), cur) == "missing_share"
    assert suppression_of(_w(), worst(missing_units=0), cur) == "start_window"
    assert suppression_of(_w(), worst(missing_units=0, first_published=D("2026-06-07")), cur) is None


def test_missing_share_skipped_for_short_window_and_unknown_plan():
    cur = Ledger(planned_units=10, published_cycles=1, data_cycles=1)
    prev = Ledger(planned_units=100, missing_units=90, published_cycles=1, data_cycles=1)
    assert suppression_of(_w(days=7), prev, cur) is None                        # 7일 창은 누락 임계 미적용
    unknown = Ledger(planned_units=0, missing_units=0, published_cycles=1, data_cycles=1)
    assert suppression_of(_w(), unknown, cur) is None                           # 계획 단위 모름 = 판정 건너뜀


def test_start_kinds_do_not_mix():
    prev = Ledger(planned_units=100, published_cycles=1, data_cycles=1, first_published=D("2026-07-20"))
    cur = Ledger(planned_units=100, published_cycles=1, data_cycles=1)
    m = calendar_months(D("2026-08-01"), D("2026-08-31"))
    assert suppression_of(m, prev, cur, before=Ledger()) == "start_month"
    w = Windows("window", prev=Span(D("2026-07-01"), D("2026-07-31")), cur=Span(D("2026-08-01"), D("2026-08-31")), days=31)
    assert suppression_of(w, prev, cur) == "start_window"


def test_calendar_month_windows():
    m = calendar_months(D("2026-09-01"), D("2026-09-14"))
    assert (m.cur.lo, m.cur.hi) == (D("2026-09-01"), D("2026-09-14"))
    assert (m.prev.lo, m.prev.hi) == (D("2026-08-01"), D("2026-08-31"))
    assert (m.before.lo, m.before.hi) == (D("2026-07-01"), D("2026-07-31"))
    assert calendar_months(D("2026-09-02"), D("2026-09-14")) is None             # 1일 아님
    assert calendar_months(D("2026-09-01"), D("2026-10-01")) is None             # 달을 넘음
    j = calendar_months_of(D("2026-01-15"))
    assert (j.prev.lo, j.before.lo) == (D("2025-12-01"), D("2025-11-01"))


def test_calendar_week_windows():
    w = calendar_weeks(D("2026-09-14"), D("2026-09-16"))
    assert (w.prev.lo, w.prev.hi) == (D("2026-09-07"), D("2026-09-13")) and w.before is None
    assert calendar_weeks(D("2026-09-15"), D("2026-09-16")) is None              # 월요일 아님
    assert calendar_weeks(D("2026-09-14"), D("2026-09-21")) is None              # 주를 넘음
    assert calendar_weeks_of(D("2026-09-18")).cur.lo == D("2026-09-14")
    # 달력 주의 start_window 유예는 7일 고정(부분 주 cur 길이와 무관)
    prev = Ledger(planned_units=1, published_cycles=1, data_cycles=1, first_published=D("2026-09-09"))
    cur = Ledger(planned_units=1, published_cycles=1, data_cycles=1)
    assert suppression_of(w, prev, cur) is None                                  # 09-09 ≤ 09-07 + 2
    prev2 = Ledger(planned_units=1, published_cycles=1, data_cycles=1, first_published=D("2026-09-10"))
    assert suppression_of(w, prev2, cur) == "start_window"


def test_cycle_windows_and_no_prev():
    w = cycle_windows(D("2026-09-14"), D("2026-09-07"))
    assert w.label_of(D("2026-09-07")) == "prev" and w.label_of(D("2026-09-10")) is None
    lone = cycle_windows(D("2026-09-14"), None)
    assert lone.prev is None and suppression_of(lone, Ledger(), Ledger(published_cycles=1, data_cycles=1)) == "no_prev"


def test_delta_golden_g1_and_rank():
    # 골든 G1(글로벌 7일): 24336/37570 → 56033/75138 = +9.7984 %p → round1 9.8
    assert delta_of("pp", (24336, 37570), (56033, 75138)) == 9.8
    # 골든 G2: 14234/19536 → 80369/112708 = −1.5531 %p → −1.6
    assert delta_of("pp", (14234, 19536), (80369, 112708)) == -1.6
    assert delta_of("rank", (5, 2), (3, 2)) == -1.0                               # 부호 원시값(순위 반전은 화면)
    assert delta_of("pp", (1, 0), (1, 2)) is None


def test_delta_pct_unit_bg05():
    """BG-05 pct = 증감률 round1((cur − prev) ÷ prev × 100)(현행 deltaOf period-compare.ts:538), 직전 값 0 이면 None."""
    assert delta_of("pct", (4, 1), (5, 3)) == -58.3
    assert delta_of("pct", (2, 4), (3, 4)) == 50.0
    assert delta_of("pct", (0, 4), (3, 4)) is None
    assert delta_of("pct", (1, 0), (3, 4)) is None and delta_of("pct", (1, 2), (3, 0)) is None
