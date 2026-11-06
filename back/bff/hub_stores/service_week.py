"""The service week (서비스 기준 주): the one ISO week, Monday to Sunday, up to which every Global and Website screen
shows Gold's rounds (decisions '발행 시점 판정' and '기준 주 세부', 2026-11-02, docs/handoff/admin-todo.md).

The HUB job (back/hub_storage/service_week.py, `manage.py sync-service-week`) watches Gold and records the week in the
input store, one row per change (catalog.service_week; the newest is catalog.current_service_week). The BFF reads it
here through the input store's reader (input_db, role hmg_input_reader) and caps its Gold reads there
(gold_reader/context.py Context.create).

A Gold read never waits on the input store: every caller of Context.create holds one of Gold's 6 connections (critic
2026-11-02). So:
- the last good week is served at once and read again behind it once it is HGH_SERVICE_WEEK_CACHE_S seconds old
  (default 60), one read at a time, each bounded by READ_TIMEOUT_S;
- only the first read (no week yet) waits, bounded the same way, and its caller stops at READ_TIMEOUT_S on its own:
  a cut-off read still unwinds on the input store, which a stopped server does not answer (review r1-5); peek(), the
  result cache's view for the fingerprint of every Gold read (those of no round too), never waits (review r2-5);
- a read that fails (no table, no row, a refused connection, a timeout) keeps the last good week and is not tried again
  for RETRY_S; with no week at all it is ServiceWeekUnavailable, which the reads answer with 503: an unreadable week is
  never 'no cap';
- None only when the input store is not configured at all (HGH_INPUT_DB_URL unset: the tests, offline scripts).

A page reads the week (the shell's shared/service-week) and its body's screens in separate requests, so a page read as
the kept week moves may hold the week before in some of them; a read of the week again does not tell that order apart.
The week moved to says so for JUST_MOVED_S (just_moved), and the shell re-reads its page once (review r1-16). The
shell's read is no Gold read: it reads the week again before it answers (fresh()), so the screens read after it take its
week unless the job records the next one in between — a soft navigation's read of the week goes out while the new page
renders and can reach the BFF before the page's screens (review r5-2).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from bff.hub_stores import input_db

log = logging.getLogger("hgh.service_week")

KST = ZoneInfo("Asia/Seoul")
#: the front's delay notice: the week ended more than this many days ago (today KST − its Sunday)
DELAY_DAYS = 10
CACHE_S = float(os.environ.get("HGH_SERVICE_WEEK_CACHE_S", "60"))
READ_TIMEOUT_S = 2.0
RETRY_S = 5.0
#: how long the week moved to is just_moved: a page's reads go out together (front lib/screen.ts), so one that reached
#: the BFF before the move did so moments before the shell's read of the week
JUST_MOVED_S = 5.0
UNAVAILABLE = "서비스 기준 주를 읽지 못했습니다(HUB 입력 DB). 잠시 뒤 다시 시도해 주세요."
# The week alone. Not the cycles the job recorded in it: a held week keeps them while Gold re-opens its round, and the
# reads follow Gold live — whether the week holds a round of a surface is their calendar's (cycles/week-notes, review r4-2).
WEEK_SQL = """SELECT seq,week_start,week_end,recorded_at,checked_at FROM catalog.current_service_week
    ORDER BY seq DESC LIMIT 1"""


class ServiceWeekUnavailable(Exception):
    """The data DB is configured, but no service week could be read and none was read before."""


@dataclass(frozen=True)
class Week:
    seq: int
    start: date          # Monday
    end: date            # Sunday: no screen shows a round after it
    recorded_at: datetime
    checked_at: datetime


_last: Week | None = None
_next_at = 0.0                                  # monotonic time from which the week is read again
_retry_at = 0.0                                 # ...after a failed read, by the shell's read too (fresh)
_refresh: asyncio.Future | None = None          # the read in flight
_moved: tuple[date, float] | None = None        # the kept week's last move: the new week's last day, when (monotonic)


async def _read() -> Week:
    async with input_db.connection() as conn:
        row = await conn.fetchrow(WEEK_SQL)
    if row is None:
        raise LookupError("catalog.current_service_week has no row (manage.py sync-service-week has not run)")
    return Week(row["seq"], row["week_start"], row["week_end"], row["recorded_at"], row["checked_at"])


async def _refreshed() -> None:
    global _last, _next_at, _retry_at, _moved
    try:
        week = await asyncio.wait_for(_read(), READ_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 - every failure keeps the last good week (its message may name the server)
        _next_at = _retry_at = time.monotonic() + RETRY_S
        log.warning("service week read failed (%s); %s", type(exc).__name__,
                    f"keeping week {_last.start} (seq {_last.seq})" if _last else "no week yet")
        return
    if _last is not None and week.end != _last.end:
        _moved = (week.end, time.monotonic())
    _last, _next_at = week, time.monotonic() + CACHE_S


def _refreshing() -> asyncio.Future:
    """The read in flight, or a new one."""
    global _refresh
    if _refresh is None or _refresh.done():
        _refresh = asyncio.ensure_future(_refreshed())
    return _refresh


async def current() -> Week | None:
    """The service week; None when the input store is not configured. Raises ServiceWeekUnavailable when it is, but no
    week has been read yet and the read fails."""
    if not input_db.configured():
        return None
    due = time.monotonic() >= _next_at
    if _last is not None:
        if due:
            _refreshing()
        return _last
    if due or (_refresh is not None and not _refresh.done()):
        # bounded here as well (review r1-5): a read cut off at READ_TIMEOUT_S still unwinds on the input store (asyncpg's
        # rollback and release), which a server that stopped answering does not finish; the read goes on behind and is
        # waited on again, not started again, by the next caller
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(asyncio.shield(_refreshing()), READ_TIMEOUT_S)
    if _last is None:
        raise ServiceWeekUnavailable(UNAVAILABLE)
    return _last


async def fresh() -> Week | None:
    """current() for the shell's read of the week (shared/service-week: the layouts' read, and the shell's read again on
    a page or filter change and when the tab comes back), which holds none of Gold's connections: the week read again
    before it answers — the read in flight or a new one, waited on as a first read is — so the screens read after it
    take its week: a Gold read reads it again only CACHE_S later, and another shell's read sooner finds another week
    only when the job recorded one in between. On a soft navigation the shell's read goes out while the new page
    renders and can reach the BFF first: served the kept week while the next one was read behind it, it named the week
    before while the screens a moment later took the new one, and the shell, comparing the weeks it read, did not
    re-read the page (review r5-2). Waiting only for a read that was due left that order a moment earlier: the kept
    week falling due between the shell's read and the screens'. Within RETRY_S of a failed read nothing is read again:
    the kept week at once, or ServiceWeekUnavailable."""
    if not input_db.configured():
        return None
    if time.monotonic() >= _retry_at:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(asyncio.shield(_refreshing()), READ_TIMEOUT_S)
    if _last is None:
        raise ServiceWeekUnavailable(UNAVAILABLE)
    return _last


def peek() -> Week | None:
    """current() without its wait, for what must never wait on the input store: the result cache fingerprints every Gold
    read with the week, the reads of no round too (review r2-5). The kept week, read again behind it when due; with
    none yet the read starts behind it and this is ServiceWeekUnavailable at once (Context.create waits for it)."""
    if not input_db.configured():
        return None
    if time.monotonic() >= _next_at:
        _refreshing()
    if _last is None:
        raise ServiceWeekUnavailable(UNAVAILABLE)
    return _last


def just_moved(week: Week) -> bool:
    """Whether the kept week moved to `week` less than JUST_MOVED_S seconds ago: a read of the same page that reached
    the BFF just before may hold the week before (review r1-16). The first week a process reads is no move, and a week
    recorded again (a new seq, the same last day) moves no screen."""
    return _moved is not None and _moved[0] == week.end and time.monotonic() - _moved[1] < JUST_MOVED_S


async def current_or_503(*, shell: bool = False) -> Week | None:
    """current() for a read: no week is the 503 every screen answers (never no cap). shell=True: the shell's read of
    the week (fresh())."""
    try:
        return await (fresh() if shell else current())
    except ServiceWeekUnavailable as exc:
        raise HTTPException(503, str(exc)) from None


def label(day: date) -> tuple[int, int]:
    """The name of `day`'s ISO week: the month of its Thursday and the Thursday's week of that month, (10, 2) =
    '10월 2주차' (2026-10-05..10-11). A week across two months belongs to the one that holds its Thursday."""
    thursday = day - timedelta(days=day.weekday()) + timedelta(days=3)
    return thursday.month, (thursday.day - 1) // 7 + 1


def delay_days(week_end: date, today: date) -> int:
    """Days since the week ended (the front shows a delay notice past DELAY_DAYS)."""
    return (today - week_end).days


def today() -> date:
    """Today in Korea (Gold's sessions and the containers run in UTC)."""
    return datetime.now(KST).date()


def clear() -> None:
    """Forget the kept week (tests)."""
    global _last, _next_at, _retry_at, _refresh, _moved
    _last, _next_at, _retry_at, _refresh, _moved = None, 0.0, 0.0, None, None
