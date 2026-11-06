"""Adding a project (T6.3, 2026-11-07): the project surface only, with the fields of the legacy /projects/new form. The project, its first version and its first
measurement settings go in one transaction. Nothing else starts a project since the Gold import stopped (T10.1)."""
from __future__ import annotations

from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from hub_server.inputs import measurement, project_prompts
from hub_server.inputs.catalog_editor import digest, encoded, refused
from shared.account import Principal
from shared.measurement_view import OPTIONS_SQL, options_of

NAME_MAX = 200
DESCRIPTION_MAX = 2000
INSERT_PROJECT_SQL = "INSERT INTO catalog.project(project_id,origin) VALUES($1,'hub')"


class ProjectAdd(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(max_length=NAME_MAX)
    description: str | None = Field(None, max_length=DESCRIPTION_MAX)
    domain: str | None = None
    brand: str | None = None
    country: str
    engines: list[str] = Field(max_length=measurement.LIST_MAX)


def first_settings(body: ProjectAdd) -> dict:
    """The legacy form's seed: its brand, country and engines to measure, and its domain as the first owned URL."""
    domain = (body.domain or "").strip()
    return measurement.settings_of(measurement.MeasurementWrite(expectedVersion=0, brands=[body.brand] if body.brand and body.brand.strip() else [],
                                                                countries=[body.country], engines=body.engines, ownedUrls=[domain] if domain else []))


def definition_of(project_id: str, body: ProjectAdd, name: str, settings: dict) -> dict:
    """The keys every project-surface definition holds, so the prompt and reference API reads a new one like the others."""
    return {"name": name, "description": (body.description or "").strip() or None, "domain": settings["owned_urls"][0] if settings["owned_urls"] else None,
            "brands": None, "regions": None, "country": settings["countries"][0], "status": "active", "is_root": False, "site_id": None, "site_brand_bit": 0,
            "surface": 3, "scope_project_id": project_id, "source_project_id": project_id}


async def add(body: ProjectAdd, actor: Principal) -> dict:
    name = body.name.strip()
    if not name:
        raise refused(422, "name_required", "A project needs a name")
    if not body.country.strip():
        raise refused(422, "country_required", "A project needs a country")
    if not any(e.strip() for e in body.engines):
        raise refused(422, "engines_required", "A project needs at least one AI engine")
    settings = first_settings(body)
    project_id = uuid4()
    definition = definition_of(str(project_id), body, name, settings)
    async with project_prompts.writing() as conn:
        measurement.check_known(settings, options_of(await conn.fetch(OPTIONS_SQL)))
        await conn.execute(INSERT_PROJECT_SQL, project_id)
        await conn.execute(project_prompts.INSERT_PROJECT_REVISION_SQL, project_id, 1, encoded(definition), digest(None, definition), actor.user_id)
        await conn.execute(measurement.INSERT_SQL, project_id, 1, settings["brands"], settings["countries"], settings["engines"], settings["cadence"],
                           settings["acr_repeats"], encoded(settings["web_units"]), settings["owned_urls"], settings["tracked_urls"],
                           encoded(settings["tracked_targets"]), measurement.digest(settings), actor.user_id)
    return {"projectId": str(project_id)}
