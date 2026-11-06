"""비율 · 변화 · 반올림: what a screen builder does with the numerators and denominators a read gives it (CLAUDE.md 1절: no calculation in a screen).
A metric's definition is catalog · formulas · compute; these are the arithmetic after it, one function per form.

Ported from the front's expressions, which round the same ratio differently at exact .x5 boundaries, so the forms stay apart:
  pct1_or_zero = Math.round((n / d) * 1000) / 10, d=0 -> 0
  pct1_or_null = round1((100 * n) / d), d=0 -> null"""
from __future__ import annotations

import math
from typing import Any


def js_round(x: float) -> int | float:
    """Math.round: halves go toward +Infinity (Math.round(-2.5) === -2)."""
    if not math.isfinite(x):
        return x
    f = math.floor(x)
    return f + 1 if x - f >= 0.5 else f


class Exact(float):
    """A value rounded for display that keeps the exact value it was rounded from. A Δ or a gap subtracts
    the exact values and rounds once (2026-10-29 metric review R2: two rounded values subtracted are off by
    up to 0.1 — 2.286 → 2.345 showed "no change"). It compares, sorts and serializes as the rounded value;
    arithmetic on it gives a plain float."""
    __slots__ = ("exact",)

    def __new__(cls, value: float, exact_value: float) -> Exact:
        self = super().__new__(cls, value)
        self.exact = exact_value
        return self

    def __reduce__(self):
        return (Exact, (float(self), self.exact))


def exact(v: Any) -> Any:
    """The exact value behind a rounded one (the value itself when it carries none)."""
    return getattr(v, "exact", v)


def round1(n: float) -> float:
    return Exact(js_round(n * 10) / 10, exact(n))


def delta1(current: Any, previous: Any) -> float:
    """current − previous from the exact values, rounded once."""
    return round1(exact(current) - exact(previous))


def _den_ok(r: Any, key: str = "den") -> bool:
    return isinstance(r, dict) and isinstance(r.get(key), (int, float)) and r[key] > 0


def pct1(num: float, den: float) -> float:
    return Exact(js_round((num / den) * 1000) / 10, (100 * num) / den)


def pct1_or_zero(r: Any) -> float:
    if not _den_ok(r):
        return 0
    return pct1(r["num"], r["den"])


def pct1_or_null(r: Any) -> float | None:
    if not _den_ok(r):
        return None
    return round1((100 * r["num"]) / r["den"])


def ratio_value(r: Any) -> float | None:
    if not _den_ok(r):
        return None
    return r["num"] / r["den"]


def rank_avg(r: Any) -> float | None:
    if not _den_ok(r, "count"):
        return None
    return round1(r["sum"] / r["count"])


def share(num: float, den: float) -> float:
    """Percent, unrounded."""
    return (100 * num) / den


def share_of_fraction(num: float, den: float) -> float:
    """Percent, unrounded, from the fraction (the form some of the front's bars and segments took)."""
    return (num / den) * 100


def share1(num: float, den: float) -> float:
    """Percent to 0.1, keeping the exact value."""
    return round1((100 * num) / den)


def share_whole(num: float, den: float) -> int | float:
    return js_round((100 * num) / den)


def permille1(num: float, den: float) -> float:
    """Percent to 0.1, rounded on the per mille."""
    return js_round((1000 * num) / den) / 10


def permille1_exact(num: float, den: float) -> float:
    return Exact(js_round((1000 * num) / den) / 10, (100 * num) / den)


def plain1(num: float, den: float) -> float:
    """Percent to 0.1 without the exact value."""
    return js_round(((100 * num) / den) * 10) / 10


def average1(total: float, n: int) -> float:
    """An average to 0.1."""
    return js_round((total / n) * 10) / 10


def average1_exact(total: float, exact_total: float, n: int) -> float:
    """The average of rounded values, as shown, keeping the exact average (its gap is exact)."""
    return Exact(average1(total, n), exact_total / n)


def change_pct(current: float, previous: float) -> float:
    """Change on the previous value, percent."""
    return 100 * (current - previous) / previous


def relative_change(current: float, previous: float) -> float:
    return ((current - previous) / previous) * 100


def change1(current: Any, previous: Any) -> float:
    """Change on the previous value from the exact values, percent to 0.1."""
    return round1((100 * (exact(current) - exact(previous))) / exact(previous))


def point_change(current: float, previous: float) -> float:
    """A fraction's change in percentage points."""
    return (current - previous) * 100
