"""External Gold business data. No seed, mirror, migration, or write connection."""
from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg

_pool: asyncpg.Pool | None = None


async def open_pool() -> None:
    global _pool
    dsn = os.environ.get("HGH_GOLD_DB_URL", "").strip()
    if not dsn:
        raise RuntimeError("HGH_GOLD_DB_URL is required; there is no sample-data fallback")
    _pool = await asyncpg.create_pool(
        dsn, min_size=1, max_size=6, timeout=8, command_timeout=20,
        statement_cache_size=0,
        server_settings={"application_name": "hmg-geo-hub-gold", "default_transaction_read_only": "on",
                         "statement_timeout": "15000", "idle_in_transaction_session_timeout": "30000"},
    )
    async with connection() as conn:
        if not await conn.fetchval("SELECT to_regclass('gold.active_release') IS NOT NULL"):
            raise RuntimeError("The configured database does not contain the Gold schema")


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def connection() -> AsyncIterator[asyncpg.Connection]:
    if _pool is None:
        raise RuntimeError("Gold connection is not initialized")
    async with _pool.acquire() as conn, conn.transaction(isolation="repeatable_read", readonly=True):
        yield conn
