"""Read-only access to Gold, the rollup job's tables (gold_db, SSOT shared/project-architecture.md 6): the
values of the unfiltered first screens. A store that cannot be read answers nothing, and the read goes on as any other."""
from __future__ import annotations

import json
import logging
import os

import asyncpg

log = logging.getLogger("hgh.gold")

UNAVAILABLE = (OSError, asyncpg.PostgresError, TimeoutError)
_pool = None


async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_METRICS_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=8, timeout=5, command_timeout=10, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-metrics", "default_transaction_read_only": "on"},
        )


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def configured() -> bool:
    return _pool is not None


async def call_states(surface: str, project_key: int, call: str, scope: str) -> dict:
    """{round: its gold.metric_call row} of a call; empty when it was never computed or the store cannot be read."""
    if _pool is None:
        return {}
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch("""SELECT round_date,snapshot_id,definition_version,error FROM gold.metric_call
                WHERE surface=$1 AND project_key=$2 AND call=$3 AND scope=$4""", surface, project_key, call, scope)
    except UNAVAILABLE as error:
        log.warning("Gold rollup read failed: %s", type(error).__name__)
        return {}
    return {r["round_date"]: dict(r) for r in rows}


async def metric_rows(surface: str, project_key: int, call: str, scope: str, rounds: list) -> list[dict]:
    """The call's rows on these rounds, in the order the data source answered them."""
    async with _pool.acquire() as conn:
        rows = await conn.fetch("""SELECT round_date,dims::text AS dims,counts::text AS counts FROM gold.metric_row
            WHERE surface=$1 AND project_key=$2 AND call=$3 AND scope=$4 AND round_date=ANY($5::date[]) ORDER BY round_date,ord""",
            surface, project_key, call, scope, rounds)
    return [{"round_date": r["round_date"], "dims": json.loads(r["dims"]), "counts": json.loads(r["counts"])} for r in rows]


async def first_screen(read_key: str) -> dict | None:
    """The kept read (snapshot_id, definition_version, result as JSON text, error), None when no run ever kept it."""
    if _pool is None:
        return None
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow("SELECT snapshot_id,definition_version,result::text AS result,error FROM gold.first_screen_read WHERE read_key=$1", read_key)
    except UNAVAILABLE as error:
        log.warning("Gold rollup read failed: %s", type(error).__name__)
        return None
    return dict(row) if row else None
