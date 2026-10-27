"""Shape conversions shared by the screens (port of front/lib/hgh/convert.ts, same rounding rules).

The two percent helpers round the same ratio differently at exact .x5 boundaries; each one
reproduces the front rule it replaces:
  pct1_or_zero = Math.round((n / d) * 1000) / 10, d=0 -> 0
  pct1_or_null = round1((100 * n) / d), d=0 -> null
"""
from __future__ import annotations

from typing import Any

from bff.screens._js import js_round

SUPPRESS_REASONS = ("no_active_snapshot", "hidden", "partial_hidden", "no_data", "unsupported", "source_pending", "no_prev")


def round1(n: float) -> float:
    return js_round(n * 10) / 10


def _den_ok(r: Any, key: str = "den") -> bool:
    return isinstance(r, dict) and isinstance(r.get(key), (int, float)) and r[key] > 0


def pct1_or_zero(r: Any) -> float:
    if not _den_ok(r):
        return 0
    return js_round((r["num"] / r["den"]) * 1000) / 10


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


def suppression_of(meta: Any, key: str) -> str | None:
    s = (meta or {}).get("suppressed") if isinstance(meta, dict) else None
    if not s:
        return None
    reason = s.get(key)
    if reason is None:
        reason = s.get("*")
    if not reason:
        return None
    return reason if reason in SUPPRESS_REASONS else "unsupported"


def whole_suppression(meta: Any) -> str | None:
    return suppression_of(meta, "*")


def unless_suppressed(meta: Any, key: str, value: Any) -> Any:
    return None if suppression_of(meta, key) else value


def filter_notices(meta: Any) -> dict:
    meta = meta or {}
    ignored = list(meta.get("ignored_filters") or [])
    dropped = {axis: list(values) for axis, values in (meta.get("dropped_filters") or {}).items() if values}
    return {"ignored": ignored, "dropped": dropped, "hasAny": bool(ignored) or bool(dropped)}


def as_of_date(meta: Any) -> str | None:
    return (meta or {}).get("as_of") if isinstance(meta, dict) else None


def ascending_dates(dates: Any) -> list[str]:
    from bff.screens._sort import code_unit_key
    return sorted(list(dates or []), key=code_unit_key)
