"""Where a /v1 read's answer comes from (SSOT shared/project-architecture.md 6, service/cache-db.md):
- a read of metrics (ROW_READS) goes through its data source (metrics.gold_rows): a first screen's come from Gold's rows, a filtered
  one is counted from the live snapshot and stored in the cache DB.
- a list of an unfiltered first screen (a prompt list, filter options), which the rollup job keeps whole in Gold: the kept value, only
  while it is of the live snapshot and this definition version. A late or failed rollup: counted now as the last resort and cached like a
  filtered read; if that fails too, nothing is shown (503).
- any other read (a filter, a period, a scoped account's, a drill-down): the cache DB's, else counted from the live snapshot and stored.
- a read that holds no metric value (an answer's text, keyword and social research): read as it is.
While a rollup runs, the reads in its context are handed to it instead (recording)."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from collections.abc import Awaitable, Callable
from contextvars import ContextVar, Token
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from starlette.datastructures import QueryParams

from data_server.gold_reader.context import CALENDAR_SQL, SURFACES
from data_server.gold_reader.db import connection
from data_server.hub_stores import cache_db, metrics_db, service_week
from data_server.metrics import gold_rows, silver_obt
from data_server.metrics.catalog import DEFINITION_VERSION
from data_server.metrics.gold_judged import read_inputs

log = logging.getLogger("hgh.gold")

#: how long the live snapshot id is taken as read: it moves when the upstream publishes, so a few seconds of delay cost nothing
SNAPSHOT_TTL_S = float(os.environ.get("HGH_SNAPSHOT_TTL_S", "5"))
#: an answer past this is answered and not kept (a filtered list of everything)
MAX_KEPT_BYTES = 16 * 1024 * 1024
PLAIN_PATHS = ("answers", "gold/keywords", "gold/social", "source")
#: the reads whose counts come from a data source: Gold's rows answer them, no answer is kept whole
ROW_READS = frozenset({"kpi/summary", "kpi/engines", "kpi/compare", "mentions/brands", "mentions/types", "trend", "geo", "citations/domains", "citations/sources"})

_recording: ContextVar[Recording | None] = ContextVar("hgh_rollup_recording", default=None)
_snapshots: dict[str, tuple[float, asyncio.Future]] = {}
_keeping: set[asyncio.Task] = set()


def read_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def surface_of(path: str, q: QueryParams) -> str:
    return "project" if path.startswith("gold/projects") else q.get("surface", "global")


def keeps_values(path: str) -> bool:
    return not any(path == p or path.startswith(p + "/") for p in PLAIN_PATHS)


async def current_snapshot(surface: str) -> str:
    """The live snapshot of a surface, read now: Gold's live release, its visible rounds and the service week the reads stop at (a read
    of the same query answers differently under another of them), and on the OBT the manifest's operating snapshots (T9.3)."""
    today = datetime.now(ZoneInfo("Asia/Seoul")).date()
    # read as the capped reads read it: no week is the 503 they answer too, and the id never depends on whether it was read yet
    capped = await service_week.current_or_503() if surface != "project" else None
    async with connection() as conn:
        release = await conn.fetchrow("""SELECT release_id,version FROM gold.active_release
            WHERE scope=$1 AND read_mode='live' AND ($2::text IS NULL OR rule_signature=$2) ORDER BY updated_at DESC NULLS LAST LIMIT 1""",
            surface, os.environ.get("HGH_GOLD_RULE_SIGNATURE") or None)
        if release is None:
            raise HTTPException(503, "No published Gold release for this surface and read mode")
        rounds = [r["round_date"].isoformat() for r in await conn.fetch(
            CALENDAR_SQL, SURFACES[surface], None, today, release["release_id"], capped.end if capped is not None else None)]
        on_obt = silver_obt.enabled()
        held = {} if on_obt else await silver_obt.loaded_snapshots(conn, surface)
    # what a kept read depends on from the input store (the registered URLs, the excluded roles): a change is a new key, so it applies at once
    inputs = (await read_inputs()).inputs_digest
    public = f":{sorted((await silver_obt.public_snapshots(surface)).items())}" if on_obt else (f":{sorted(held.items())}" if held else "")
    digest = hashlib.sha256(f"{','.join(rounds)}:{inputs}{public}".encode()).hexdigest()[:12]
    return f"{'silver' if on_obt or held else 'gold-release'}:{release['release_id']}:{release['version']}:{digest}:{capped.seq if capped is not None else '-'}"


async def snapshot_of(surface: str) -> str:
    """current_snapshot, shared by the reads of a few seconds."""
    kept = _snapshots.get(surface)
    now = time.monotonic()
    if kept is None or now - kept[0] > SNAPSHOT_TTL_S or (kept[1].done() and (kept[1].cancelled() or kept[1].exception() is not None)):
        kept = (now, asyncio.ensure_future(current_snapshot(surface)))
        _snapshots[surface] = kept
    return await asyncio.shield(kept[1])


def forget_snapshots() -> None:
    _snapshots.clear()


class Recording:
    """A rollup's reads: each one counted once and handed to `keep(surface, path, query, text, error)`."""

    def __init__(self, keep: Callable[..., Awaitable[None]]) -> None:
        self.keep = keep
        self.seen: dict[str, asyncio.Future] = {}
        self.failed = 0

    async def read(self, path: str, q: QueryParams, run: Callable[[], Awaitable[str]]) -> str:
        if not keeps_values(path) or path in ROW_READS:   # the row reads record through their data source
            return await run()
        key = f"{path}?{q}"
        pending = self.seen.get(key)
        if pending is None:
            pending = self.seen[key] = asyncio.ensure_future(self._count(path, q, run))
        return await asyncio.shield(pending)

    async def _count(self, path: str, q: QueryParams, run: Callable[[], Awaitable[str]]) -> str:
        try:
            text = await run()
        except Exception as error:
            self.failed += 1
            await self.keep(surface_of(path, q), path, str(q), None, f"{type(error).__name__}: {getattr(error, 'detail', None) or error}"[:300])
            raise
        await self.keep(surface_of(path, q), path, str(q), text, None)
        return text


def start_recording(run: Recording) -> Token:
    return _recording.set(run)


def stop_recording(token: Token) -> None:
    _recording.reset(token)


async def _last_resort(path: str, run: Callable[[], Awaitable[str]]) -> str:
    log.warning("Late pre-computed read, counting it: %s", path)
    try:
        async with gold_rows.last_resort():
            return await run()
    except Exception as error:  # noqa: BLE001 - whatever stopped the count, the screen part says the value is not ready
        log.warning("The last resort failed: %s", path, exc_info=True)
        raise HTTPException(503, gold_rows.NOT_READY) from error


async def read(path: str, q: QueryParams, run: Callable[[], Awaitable[str]]) -> str:
    """The read's answer as JSON text."""
    active = _recording.get()
    if active is not None:
        return await active.read(path, q, run)
    if not keeps_values(path):
        return await run()
    try:
        snapshot = await snapshot_of(surface_of(path, q))
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - no snapshot to key on: the read itself says what is wrong
        log.warning("Live snapshot not read; reading %s as it is", path, exc_info=True)
        return await run()
    late = False
    if path not in ROW_READS:
        kept = await metrics_db.first_screen(read_key(f"{path}?{q}"))
        if kept is not None:
            if kept["error"] is None and kept["snapshot_id"] == snapshot and kept["definition_version"] == DEFINITION_VERSION:
                return kept["result"]
            late = True
    query = {"path": path, **{k: q.getlist(k) for k in dict.fromkeys(q.keys())}}
    cached = await cache_db.get(query, snapshot, DEFINITION_VERSION)
    if cached is not None:
        return cached
    usage = {"live": False}
    token = gold_rows.track_usage(usage)
    try:
        text = await (_last_resort(path, run) if late else run())
    finally:
        gold_rows.stop_tracking(token)
    # a read Gold's rows answered is kept there already
    if (path not in ROW_READS or usage["live"]) and len(text) <= MAX_KEPT_BYTES:
        task = asyncio.ensure_future(cache_db.put(query, snapshot, DEFINITION_VERSION, text))
        _keeping.add(task)
        task.add_done_callback(_keeping.discard)
    return text
