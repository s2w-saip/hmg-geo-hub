"""The 측정 기간 of the renewal pages that read the HUB analytics store (AI Visibility, AI Conversion): days,
not rounds. The URL carries `days` (a preset 7 · 28 · 90 or any 1–366) or a custom `from` / `to`; the reader
ends the period at the last measured day. Changes compare with the previous period of the same length."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from bff.screens.sources import source_query

PRESET_DAYS = (7, 28, 90)
DEFAULT_DAYS = 28


def _iso(v: Any) -> str | None:
    if isinstance(v, list):
        v = v[-1] if v else None
    try:
        return date.fromisoformat(str(v)).isoformat() if v else None
    except ValueError:
        return None


def period_params(sp: dict) -> dict:
    """days (1–366) or from / to from the URL; anything the reader would reject (422) is dropped.
    No period at all = the last 28 days up to the last measured day (the reader's default)."""
    start, end = _iso(sp.get("from")), _iso(sp.get("to"))
    if start and end and start > end:
        start, end = end, start
    if start or end:
        return {k: v for k, v in (("from", start), ("to", end)) if v}
    raw = sp.get("days")
    try:
        days = int(raw[-1] if isinstance(raw, list) else raw)
    except (TypeError, ValueError):
        days = DEFAULT_DAYS
    return {"days": str(days if 1 <= days <= 366 else DEFAULT_DAYS)}


def period_choice(sp: dict) -> dict:
    """What the period control shows: a preset (7 · 28 · 90) or the custom from / to."""
    p = period_params(sp)
    if "days" in p:
        d = int(p["days"])
        return {"preset": d if d in PRESET_DAYS else None, "days": d, "from": None, "to": None}
    return {"preset": None, "days": None, "from": p.get("from"), "to": p.get("to")}


def reader_query(sp: dict) -> dict:
    """source_query (the original's URL → reader params) with this page's period and without the tab."""
    raw = {k: v for k, v in sp.items() if k not in ("view", "days", "from", "to", "period", "time")}
    return {**source_query(raw), **period_params(sp)}


def prev_period(period: dict) -> dict | None:
    """The from / to of the period of the same length right before the reader's period."""
    if not period.get("from") or not period.get("to"):
        return None
    a, b = date.fromisoformat(period["from"]), date.fromisoformat(period["to"])
    span = (b - a).days + 1
    return {"from": (a - timedelta(days=span)).isoformat(), "to": (a - timedelta(days=1)).isoformat()}


def days_of(start: str, end: str) -> list[str]:
    a, b = date.fromisoformat(start), date.fromisoformat(end)
    return [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]


def blocks_of(days: list[str], block: int = 7) -> list[tuple[int, int]]:
    """7-day blocks counted back from the last day (index ranges into `days`, inclusive); a shorter first block is left out."""
    out = []
    e = len(days) - 1
    while e - (block - 1) >= 0:
        out.insert(0, (e - block + 1, e))
        e -= block
    return out
