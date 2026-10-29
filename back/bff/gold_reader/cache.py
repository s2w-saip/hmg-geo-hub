"""Result cache of the Gold /v1 reads (2026-10-29, the user's go-ahead after the renewal Mention load work).

A read is a function of its query, Gold's state and the day (Asia/Seoul: a cycle shows from its view_date on).
Gold's state is one fingerprint, read in one statement (~10 ms):
  - the active releases (a publish is a new release_id) and their items' state and build status,
  - gold.data_version (dimension, cycle, ... writes),
  - every gold table's relfilenode (a wholesale reload rewrites the table: on 2026-10-28 all 86 were reloaded
    and data_version did not move),
  - dim_cycle's visibility (servable, hidden_scope, view_date move without a release),
  - every gold table's write counters (pg_stat: any row written; not transactional, they lag about a second),
plus the day. A kept answer is served while the fingerprint is the one it was read under, for at most
HGH_GOLD_CACHE_S seconds (default 600, 0 = off) as a backstop.

An answer is kept only when the fingerprint taken after the read equals the one taken before it: the read's
snapshot falls between the two, so nothing it read was written in between. Gold loads table by table, so a read
during a load can see two generations; that one is answered, not kept. The check after the read runs once the
answer has gone out. Answers are kept as their JSON text, the least recently used dropped past HGH_GOLD_CACHE_MB
(default 256); an answer over a tenth of that is not kept.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from datetime import datetime
from zoneinfo import ZoneInfo

from bff.gold_reader.db import connection

log = logging.getLogger("hgh.gold")

MAX_AGE_S = int(os.environ.get("HGH_GOLD_CACHE_S", "600"))
BUDGET = int(os.environ.get("HGH_GOLD_CACHE_MB", "256")) * 1024 * 1024

STATE_SQL = """SELECT concat_ws('|',
    (SELECT json_agg(json_build_array(scope,read_mode,rule_signature,release_id,version)
        ORDER BY scope,read_mode,rule_signature) FROM gold.active_release)::text,
    (SELECT md5(string_agg(concat_ws(':',i.release_id,i.family,i.build_id,i.slice_key,i.state,b.status),','
        ORDER BY i.release_id,i.build_id,i.slice_key))
        FROM gold.release_item i JOIN gold.build b USING(build_id)
        WHERE i.release_id IN (SELECT release_id FROM gold.active_release)),
    (SELECT json_agg(json_build_array(scope,version) ORDER BY scope) FROM gold.data_version)::text,
    (SELECT md5(string_agg(c.relname||':'||c.relfilenode,',' ORDER BY c.relname)) FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gold' AND c.relkind IN ('r','p','m')),
    (SELECT md5(string_agg(concat_ws(':',cyc_key,round_date,servable,hidden_scope,view_date),',' ORDER BY cyc_key))
        FROM gold.dim_cycle),
    (SELECT md5(string_agg(relname||':'||(n_tup_ins+n_tup_upd+n_tup_del),',' ORDER BY relname))
        FROM pg_stat_all_tables WHERE schemaname='gold'))"""

#: key (path?query) -> (kept at, fingerprint, answer JSON)
_kept: OrderedDict[str, tuple[float, str, str]] = OrderedDict()
_size = 0
#: the probe in flight: (started at, its future); callers that may share it do
_probe: tuple[float, asyncio.Future] | None = None
#: the checks-and-keeps still running after their answers went out
_keeping: set[asyncio.Task] = set()


async def _fingerprint() -> str:
    async with connection() as conn:
        state = await conn.fetchval(STATE_SQL)
    return f"{state}|{datetime.now(ZoneInfo('Asia/Seoul')).date().isoformat()}"


async def state(started_after: float) -> str:
    """Gold's fingerprint from a probe started at `started_after` or later; concurrent callers share one."""
    global _probe
    if _probe is None or _probe[1].done() or _probe[0] < started_after:
        _probe = (time.monotonic(), asyncio.ensure_future(_fingerprint()))
    return await asyncio.shield(_probe[1])


async def read(key: str, run: Callable[[], Awaitable[str]]) -> str:
    """The answer (JSON text) of `run` for `key`: the kept one under Gold's current state, else a fresh read."""
    if MAX_AGE_S <= 0:
        return await run()
    started = time.monotonic()
    try:
        before = await state(0.0)
    except Exception:  # noqa: BLE001 - the cache never fails a read: no fingerprint, no caching
        log.warning("Gold state probe failed; reading %s uncached", key, exc_info=True)
        return await run()
    kept = _kept.get(key)
    if kept and kept[1] == before and time.monotonic() - kept[0] < MAX_AGE_S:
        _kept.move_to_end(key)
        return kept[2]
    text = await run()
    if len(text) <= BUDGET // 10:
        task = asyncio.ensure_future(_keep(key, before, text, started))
        _keeping.add(task)
        task.add_done_callback(_keeping.discard)
    return text


async def _keep(key: str, before: str, text: str, started: float) -> None:
    """Keep the answer if Gold's state did not move across the read (a probe started after the read began)."""
    global _size
    try:
        if await state(started) != before:
            return
    except Exception:  # noqa: BLE001 - not kept, nothing else
        log.warning("Gold state probe failed; %s not kept", key, exc_info=True)
        return
    old = _kept.pop(key, None)
    if old:
        _size -= len(old[2])
    _kept[key] = (time.monotonic(), before, text)
    _size += len(text)
    while _size > BUDGET and _kept:
        _size -= len(_kept.popitem(last=False)[1][2])


def clear() -> None:
    global _size, _probe
    _kept.clear()
    _size = 0
    _probe = None
