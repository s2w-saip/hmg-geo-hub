"""The Project › Setting screen's read (screens/project_dashboard.py). The hub server edits the settings (hub_server/inputs/measurement.py)."""
from __future__ import annotations

from uuid import UUID

import asyncpg

from data_server.hub_stores import input_db
from shared.measurement_view import CURRENT_SQL, OPTIONS_SQL, options_of, view

async def read(project_id: UUID) -> dict | None:
    """The screen's value: the current settings and the codes the form offers. None when the input store is not there or does not hold
    the project (a Gold project the import has not recorded yet)."""
    if not input_db.configured():
        return None
    try:
        async with input_db.connection() as conn:
            row = await conn.fetchrow(CURRENT_SQL, project_id)
            if row is None:
                return None
            options = options_of(await conn.fetch(OPTIONS_SQL))
    except (ConnectionError, OSError, asyncpg.PostgresError, TimeoutError):
        return None
    return {"item": view(row), "options": options, "editing": True}
