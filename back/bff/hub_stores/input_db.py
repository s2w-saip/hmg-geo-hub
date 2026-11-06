"""Read-only access to the input store (input_db, 2026-11-06): prompts, measurement settings and the collecting and analysis
reference values. The screens' writes use their own roles (catalog_editor, project_prompts, measurement, source_overrides, interest,
entity_roles); 수집 and 분석 read the same data through back/ext."""
import os
from contextlib import asynccontextmanager

import asyncpg

_pool = None


async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_INPUT_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=4, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-input-reader",
                             "default_transaction_read_only": "on", "statement_timeout": "15000"},
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
        raise ConnectionError("HUB input connection is not configured")
    async with _pool.acquire() as conn, conn.transaction(isolation="repeatable_read", readonly=True):
        yield conn


async def health():
    if _pool is None:
        return {"ok": False, "configured": False}
    try:
        async with connection() as conn:
            info = dict(await conn.fetchrow("SELECT current_database() AS database,current_user AS role,current_setting('transaction_read_only') AS read_only"))
        return {"ok": True, "configured": True, **info}
    except (OSError, asyncpg.PostgresError, TimeoutError):
        return {"ok": False, "configured": True}
