"""Screens shared by every analysis page (filter bar data, panel options, project gate)."""
from __future__ import annotations

from fastapi import HTTPException

from bff.screens import screen
from bff.screens._filters import (
    load_filter_dates, load_panel_options, load_project_gate, load_website_prompt_options, project_locks,
    read_standard_filters, search_params,
)
from bff.screens._query import READER_SCOPE

SURFACES = ("global", "website", "project")


@screen("shared/filter-dates")
async def filter_dates(q) -> dict:
    return await load_filter_dates(q.get("surface", "global"), q.get("project_id"), q.get("family"))


@screen("shared/panel-options")
async def panel_options(q) -> dict:
    """The filter panel's option props (PanelFilterOptions) for the page URL.
    Query: surface, project_id (website: optional site, project: required), geo_only=true (the
    conversion pages), plus the page's URL params: time = the options window, brand = the applied
    brand narrowing (global/website). Global/website read with the session scope (local reader:
    every scope), project without one (the project pages' readStandardFilters(sp))."""
    surface = q.get("surface", "global")
    if surface not in SURFACES:
        raise HTTPException(422, "Unknown surface")
    project_id = q.get("project_id") if surface != "global" else None
    if surface == "project" and not project_id:
        raise HTTPException(422, "surface=project needs project_id")
    sp = search_params(q)
    scope = None if surface == "project" else READER_SCOPE
    filters = read_standard_filters(sp, scope)
    return await load_panel_options({"surface": surface, "projectId": project_id, "dateFrom": filters.get("dateFrom"),
                                     "dateTo": filters.get("dateTo"), "geoOnly": q.get("geo_only") in ("true", "1"),
                                     "scope": scope, "filters": filters})


@screen("shared/project-gate")
async def project_gate(q) -> dict:
    """The project pages' gate (local read-only) and their F4 locks: {project: GateProject|null, locks, lockedGroups}."""
    project = await load_project_gate(q.get("project_id", ""))
    return {"project": project, **(project_locks(project) if project else {"locks": [], "lockedGroups": []})}


@screen("shared/website-prompt-options")
async def website_prompt_options(q) -> dict:
    """/website/prompts filter option lists: {geographyOptions, languageOptions, brandOptions}."""
    return await load_website_prompt_options()
