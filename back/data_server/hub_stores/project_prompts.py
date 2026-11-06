"""The Project › Prompt screen's read of the project's prompts and tag columns (screens/project_dashboard.py). The hub server edits them (hub_server/inputs/project_prompts.py)."""
from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException

from data_server.hub_stores.catalog_editor import reading
from shared.project_prompt_views import LANGUAGES_SQL, PROJECT_SQL, PROMPTS_SQL, fields_of, prompt_view
from shared.prompt_revisions import definition_of

def editing() -> bool:
    """Editing is the hub server's; a hub server without its editor account answers the save with 503."""
    return True


async def catalog(project_id: UUID) -> dict | None:
    """The project's prompts and tag columns as the HUB holds them, or None when the HUB catalog cannot say (the store is
    not configured, or the project is not in it yet: the page then shows Gold's rows read only)."""
    try:
        async with reading() as conn:
            project = await conn.fetchrow(PROJECT_SQL, project_id)
            if project is None or definition_of(project).get("surface") != 3:
                return None
            rows = await conn.fetch(PROMPTS_SQL, project_id)
            languages = sorted(r["item_key"] for r in await conn.fetch(LANGUAGES_SQL))
    except HTTPException:
        return None
    return {"version": project["version"], "fields": fields_of(definition_of(project)), "prompts": [prompt_view(r) for r in rows],
            "languages": languages, "editable": editing()}
