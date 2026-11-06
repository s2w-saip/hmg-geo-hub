"""Shape conversions shared by the screens (port of front/lib/hgh/convert.ts). The arithmetic is in bff/metrics/display.py."""
from __future__ import annotations

from typing import Any

from bff.metrics.display import Exact, delta1, exact, js_round, pct1_or_null, pct1_or_zero, rank_avg, ratio_value, round1  # noqa: F401 - the screens' names

SUPPRESS_REASONS = ("no_active_snapshot", "hidden", "partial_hidden", "no_data", "unsupported", "source_pending", "no_prev")


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
