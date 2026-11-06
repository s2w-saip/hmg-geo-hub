"""The cache DB (SSOT service/cache-db.md): filtered query results until the next round goes live. Not a source of truth, so a failure
here never fails a read: get answers a miss and put gives up, and the caller counts the live snapshot as usual.

The key is the query, the live snapshot id and the metric definition version, hashed after writing the query one way. There is no TTL:
another snapshot or definition version is simply another key, and purge_other_snapshots removes the old rows when a new snapshot goes
live. data_server.metrics.serving reads and writes it; results travel as JSON text, as the reads answer."""
from __future__ import annotations

import hashlib
import json
import logging
import os

import asyncpg

log = logging.getLogger("hgh.cache")

UNAVAILABLE = (OSError, asyncpg.PostgresError, TimeoutError)
UPSERT_SQL = """INSERT INTO cache.query_result(cache_key,snapshot_id,definition_version,query,result) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)
    ON CONFLICT(cache_key) DO UPDATE SET result=EXCLUDED.result,created_at=now()"""

_pool = None


async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_CACHE_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-cache"},
        )


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def canonical_value(value):
    """One spelling for a condition: strings trimmed, list values without repeats and in order, empty conditions gone."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        return canonical_query(value)
    if isinstance(value, (list, tuple, set)):
        items = {json.dumps(canonical_value(v), ensure_ascii=False, sort_keys=True, default=str) for v in value}
        return [json.loads(v) for v in sorted(items)]
    return value


def canonical_query(query: dict) -> dict:
    """The same conditions always give the same dict: an absent condition and an empty one are the same query."""
    out = {str(k): canonical_value(v) for k, v in query.items()}
    return {k: out[k] for k in sorted(out) if out[k] not in (None, "", [], {})}


def cache_key(query: dict, snapshot_id: str, definition_version: str) -> str:
    text = json.dumps({"query": canonical_query(query), "snapshot": snapshot_id, "definition": definition_version},
                      ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode()).hexdigest()


async def get(query: dict, snapshot_id: str, definition_version: str) -> str | None:
    """The stored result as JSON text, or None on a miss (or when the cache cannot be read)."""
    if _pool is None:
        return None
    try:
        async with _pool.acquire() as conn:
            return await conn.fetchval("SELECT result::text FROM cache.query_result WHERE cache_key=$1", cache_key(query, snapshot_id, definition_version))
    except UNAVAILABLE as error:
        log.warning("cache read failed: %s", type(error).__name__)
        return None


async def put(query: dict, snapshot_id: str, definition_version: str, result: str) -> bool:
    """Store a result (JSON text)."""
    if _pool is None:
        return False
    try:
        async with _pool.acquire() as conn:
            await conn.execute(UPSERT_SQL, cache_key(query, snapshot_id, definition_version), snapshot_id, definition_version,
                               json.dumps(canonical_query(query), ensure_ascii=False, default=str), result)
    except UNAVAILABLE as error:
        log.warning("cache write failed: %s", type(error).__name__)
        return False
    return True


async def purge_other_snapshots(snapshot_ids: list[str]) -> int:
    """After a new snapshot goes live: remove every row of the others (each surface has its own). The number of rows removed."""
    if _pool is None:
        return 0
    async with _pool.acquire() as conn:
        status = await conn.execute("DELETE FROM cache.query_result WHERE NOT snapshot_id=ANY($1::text[])", snapshot_ids)
    return int(status.split()[-1])


async def health():
    if _pool is None:
        return {"ok": False, "configured": False}
    try:
        async with _pool.acquire() as conn:
            info = dict(await conn.fetchrow("SELECT current_database() AS database,current_user AS role,count(*)::int AS rows FROM cache.query_result"))
        return {"ok": True, "configured": True, **info}
    except UNAVAILABLE:
        return {"ok": False, "configured": True}
