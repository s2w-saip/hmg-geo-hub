"""The service week on the screens (hub_stores/service_week.py): a week as the shell names it, and the URL period as the
capped reads take it, for the screens that echo the period in a header (2026-11-02: for time=2026-10-01..2026-10-31 the
headers said '10-01 ~ 10-31' while every read stopped at the service week's last day, 10-11) and for what the screens
derive from it (the compare kind and days, the labels, the period before a Δ compares with: screens._compare)."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from bff.hub_stores import service_week
from bff.screens._query import has_closed_period


def week_view(start: date) -> dict:
    """{start, end, month, nth} of the ISO week starting `start`: '10월 2주차 · 10/5~10/11' = 2026-10-05, 2026-10-11, 10, 2."""
    month, nth = service_week.label(start)
    return {"start": start.isoformat(), "end": (start + timedelta(days=6)).isoformat(), "month": month, "nth": nth}


def period_echo(date_from: str | None, date_to: str | None, week: Any) -> dict | None:
    """The URL period {from, to} (an end may be open, None = no period: a snapshot) with its end the service week's last
    day at the latest, as the reads take it. A period that starts after the week holds no round a screen shows: None,
    the header's no-round state, not a day after the week."""
    if not date_from and not date_to:
        return None
    if week is not None:
        last = week.end.isoformat()
        if date_from and date_from > last:
            return None
        if date_to and date_to > last:
            date_to = last
    return {"from": date_from, "to": date_to}


async def period_week(filters: dict) -> Any:
    """The service week a closed URL period is read under (current_or_503: an unreadable week is 503, never no cap), for
    the windows derived from that period; None without one: a snapshot or an open end has no window the week moves, and
    a project page's filters (`uncapped`, _filters.project_page_filters: the project surface is not held to the week)."""
    if filters.get("uncapped"):
        return None
    return await service_week.current_or_503() if has_closed_period(filters) else None
