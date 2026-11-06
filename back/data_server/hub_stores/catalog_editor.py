"""The Global prompts history screen's read (screens/standard_prompts.py). The hub server edits the prompts (hub_server/inputs/catalog_editor.py)."""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException

from data_server.hub_stores import input_db
from shared.prompt_revisions import GLOBAL_PROJECT_SQL, HISTORY_ROWS_SQL, audit_row

@asynccontextmanager
async def reading():
    try:
        async with input_db.connection() as conn:
            yield conn
    except ConnectionError:
        raise HTTPException(503, "HUB input store is not configured") from None


async def global_project(conn) -> UUID:
    rows = await conn.fetch(GLOBAL_PROJECT_SQL)
    if len(rows) != 1:
        raise HTTPException(503, "The Global project is not in the HUB catalog; run manage.py sync-gold-catalog")
    return rows[0]["project_id"]


async def history_rows(prompt_id: UUID | None, limit: int | None, since: datetime | None = None) -> list[dict]:
    """The Global catalog's latest revisions (one prompt's, or all), newest first; limit None = every one since `since`."""
    async with reading() as conn:
        rows = await conn.fetch(HISTORY_ROWS_SQL, await global_project(conn), prompt_id, limit, since)
    return [audit_row(r) for r in rows]
