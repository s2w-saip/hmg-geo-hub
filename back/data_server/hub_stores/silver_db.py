"""Read-only access to the Silver OBT (HGH_SILVER_DB_URL), when HGH_METRIC_SOURCE=silver: public snapshots through silver_contract and the manifest, nothing else.
It is the pipeline's database. Until its connection details arrive a stand-in outside the service's architecture answers, and only this URL changes."""
import os
from contextlib import asynccontextmanager

import asyncpg

_pool = None


async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_SILVER_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=6, timeout=5, command_timeout=int(os.environ.get("HGH_SILVER_COMMAND_TIMEOUT_S", "120")), statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-silver-reader", "default_transaction_read_only": "on",
                             "statement_timeout": os.environ.get("HGH_SILVER_STATEMENT_TIMEOUT_MS", "120000")},
        )


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def configured() -> bool:
    return _pool is not None


@asynccontextmanager
async def connection():
    if _pool is None:
        raise ConnectionError("Reading the Silver OBT needs HGH_SILVER_DB_URL")
    async with _pool.acquire() as conn, conn.transaction(isolation="repeatable_read", readonly=True):
        yield conn
