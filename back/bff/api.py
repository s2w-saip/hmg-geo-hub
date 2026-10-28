"""The /v1 read routes as plain functions, so screen builders can compose them in-process.

The one channel the screens read through: analytics/* comes from the HUB's GA4/SEO store
(hub_stores), every other path from the external Gold DB (gold_reader)."""
from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Iterable, Mapping
from typing import Any

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from starlette.datastructures import QueryParams

from bff.gold_reader.readers import read as read_gold
from bff.hub_stores import analytics_reader
from bff.screens._js import js_str

ANALYTICS = {"analytics/conversion", "analytics/visibility"}


async def read(path: str, q: QueryParams) -> dict:
    """One /v1 GET, exactly as the HTTP route answers it (one read-only transaction)."""
    if path in ANALYTICS:
        return await analytics_reader.read(path.split("/")[1], q)
    return await read_gold(path, q)


def query(params: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None) -> QueryParams:
    """Serialize like the front client: lists repeat the key, booleans are true/false, numbers
    as String(n) (1.0 -> "1"), None and empty lists are dropped, keys are sorted."""
    items = params.items() if isinstance(params, Mapping) else (params or [])
    pairs: list[tuple[str, str]] = []
    for key, value in items:
        for v in (value if isinstance(value, (list, tuple)) else [value]):
            if v is None:
                continue
            pairs.append((key, "true" if v is True else "false" if v is False else js_str(v) if isinstance(v, (int, float)) else str(v)))
    pairs.sort(key=lambda kv: kv[0])
    return QueryParams(pairs)


_inflight: dict[str, asyncio.Future] = {}
READ_TIMEOUT_S = int(os.environ.get("HGH_SCREEN_READ_TIMEOUT_MS", "20000")) / 1000


async def get(path: str, params: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None) -> dict:
    """In-process GET returning the same JSON the HTTP route would send.

    Identical reads that run at the same time (sections of one page asking for the same
    summary) share one execution; nothing is kept here once it finishes (the one result cache, the filter
    options, is gold_reader.metrics.options)."""
    q = query(params)
    key = f"{path}?{q}"
    pending = _inflight.get(key)
    if pending is None:
        # The shared read is bounded too: a read that never returns (a connection lost mid-query) is
        # cancelled and leaves the table, so the next request reads again instead of joining it forever.
        pending = asyncio.ensure_future(asyncio.wait_for(_read_json(path, q), READ_TIMEOUT_S))
        _inflight[key] = pending
        pending.add_done_callback(lambda f, k=key: _forget(k, f))
    try:
        result = await asyncio.wait_for(asyncio.shield(pending), READ_TIMEOUT_S)
    except asyncio.TimeoutError:
        # The front's per-call timeout (HGH_API_TIMEOUT_MS, 20 s): the section degrades, the page
        # does not wait for one slow read.
        raise HTTPException(504, "Gold read timed out") from None
    return json.loads(json.dumps(result))


def _forget(key: str, done: asyncio.Future) -> None:
    _inflight.pop(key, None)
    if not done.cancelled():
        done.exception()  # read here: when every waiter already answered 504, nobody else does


async def _read_json(path: str, q: QueryParams) -> Any:
    return json.loads(json.dumps(jsonable_encoder(await read(path, q))))
