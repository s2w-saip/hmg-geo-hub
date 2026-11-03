"""A HUB data DB holding a service week, for the tests of what reads it (bff/hub_stores/service_week.py): the
provider, the Gold reads it caps and the screens that show it."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, contextmanager
from datetime import UTC, date, datetime, timedelta
from unittest import mock

from bff.hub_stores import analytics_db

RECORDED = datetime(2026, 10, 25, 1, 10, tzinfo=UTC)
CHECKED = datetime(2026, 11, 2, 1, 10, tzinfo=UTC)
#: Monday 2026-11-02 08:30 in Korea, still Sunday 11-01 in UTC: the day a read binds is the KST one (clock())
NOW = datetime(2026, 11, 1, 23, 30, tzinfo=UTC)


def week_row(start: date, seq: int = 1, global_cycles: int = 1, website_cycles: int = 96) -> dict:
    """A catalog.current_service_week row: the ISO week starting `start` (a Monday) and how many complete cycles of each
    surface the job recorded in it (today's week: 1 global, 96 website). The provider reads the week alone: whether the
    week holds a round of a surface is Gold's calendar's (cycles/week-notes), not this record's (review r4-2)."""
    return {"seq": seq, "week_start": start, "week_end": start + timedelta(days=6), "global_cycles": global_cycles,
            "website_cycles": website_cycles, "recorded_at": RECORDED, "checked_at": CHECKED}


class HubData:
    """The data DB's catalog.current_service_week: `row` (None = no row), `error` raised by the read, `refuse` raised
    when a connection is asked for (a server that is down); `hang` = a read that never answers; `stall` = a server that
    stops answering for that many seconds: its read never answers and, cut off, takes that long to unwind (asyncpg rolls
    the transaction back and releases the pooled connection on the server, review r1-5); `gate` (an asyncio.Event the
    test sets) = a read that answers once it is set, a read in flight for as long as the test needs. `connects` counts
    the connections asked for, `reads` the reads."""

    def __init__(self, row: dict | None = None, error: BaseException | None = None, refuse: BaseException | None = None,
                 hang: bool = False, stall: float = 0.0) -> None:
        self.row, self.error, self.refuse, self.hang, self.stall = row, error, refuse, hang, stall
        self.gate: asyncio.Event | None = None
        self.connects = self.reads = 0

    async def fetchrow(self, sql, *args):
        if "catalog.current_service_week" not in sql:
            raise AssertionError(sql[:80])
        self.reads += 1
        if self.hang or self.stall:
            await asyncio.Event().wait()
        if self.gate is not None:
            await self.gate.wait()
        if self.error is not None:
            raise self.error
        return self.row


@contextmanager
def clock(module, now: datetime = NOW):
    """`module`'s datetime stopped at `now` on a host in UTC, as the containers run: a naive now() is UTC's wall clock,
    so only a day taken in Asia/Seoul is 11-02 (review r1-6: on the real clock of a Mac in Korea a naive day was the
    KST one, and a UTC day equalled it from 09:00 to 24:00)."""
    utc = now.astimezone(UTC).replace(tzinfo=None)
    with mock.patch.object(module, "datetime", wraps=datetime) as dt:
        dt.now.side_effect = lambda tz=None: utc if tz is None else now.astimezone(tz)
        dt.utcnow.side_effect = lambda: utc
        yield dt


def forget() -> None:
    """The provider's kept week, dropped (nothing to drop before the provider exists)."""
    try:
        from bff.hub_stores import service_week
    except ImportError:
        return
    service_week.clear()


@contextmanager
def hub(data: HubData | None):
    """The HUB data DB configured and holding `data` (None = not configured: the tests' and offline scripts' state)."""
    forget()

    @asynccontextmanager
    async def connection():
        if data is None:
            raise ConnectionError("HUB analytics connection is not configured")
        data.connects += 1
        if data.refuse is not None:
            raise data.refuse
        try:
            yield data
        except BaseException:
            if data.stall:
                await asyncio.sleep(data.stall)   # the rollback and the release wait on the stopped server
            raise

    with mock.patch.object(analytics_db, "_pool", None if data is None else object()), \
            mock.patch.object(analytics_db, "connection", connection):
        try:
            yield data
        finally:
            forget()
