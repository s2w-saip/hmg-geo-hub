"""The Project › Prompt screen's read of the project's prompts and tag columns (screens/project_dashboard.py). The hub server edits them (hub_server/inputs/project_prompts.py)."""
from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException

from data_server.hub_stores.catalog_editor import reading
from shared.project_prompt_views import LANGUAGES_SQL, PROJECT_SQL, PROMPTS_SQL, fields_of, prompt_view
from shared.prompt_revisions import definition_of

#: projects the input store names or that Gold cannot hold yet: a project the administrator added (T6.3) has no Gold row until its first round is loaded
ADDED_SQL = """SELECT p.project_id::text AS id,p.origin,p.definition->>'name' AS name,m.countries,m.engines,
        (SELECT count(*)::int FROM catalog.current_prompt q WHERE q.project_id=p.project_id) AS prompts,
        (SELECT q.text FROM catalog.current_prompt q WHERE q.project_id=p.project_id ORDER BY q.registered_at,q.prompt_id LIMIT 1) AS first_prompt
    FROM catalog.current_project p LEFT JOIN catalog.current_measurement m ON m.project_id=p.project_id
    WHERE p.definition->>'surface'='3' AND (p.origin='hub' OR p.definition->>'name' IS NOT NULL)"""


async def added_projects() -> list[dict]:
    """The rows of projects/list the input store knows: a name, and for one Gold does not hold yet what a row shows. Empty when the store is not there."""
    try:
        async with reading() as conn:
            rows = await conn.fetch(ADDED_SQL)
    except HTTPException:
        return []
    return [{"id": r["id"], "name": r["name"], "prompts": r["prompts"], "answers": 0, "last_measured_day": None, "countries": list(r["countries"] or []),
             "engines": list(r["engines"] or []), "languages": [], "rounds": 0, "custom_fields": 0, "first_prompt": r["first_prompt"]} for r in rows]


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
