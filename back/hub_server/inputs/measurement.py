"""A project's measurement settings on the renewal Project › Setting screen (2026-11-06, SSOT shared/input-contract.md, 측정 설정): which
brands and countries to measure, the website units and their base URLs, the AI engines, the cadence, the ACR repeat count, the owned and
tracked URLs and the tracked brands and models. 수집 reads them through the prompt and reference API (back/ext).

catalog.project_measurement_version holds one numbered version per change and the newest is current. The Gold import records what Gold
holds as version 1 (origin gold_import) for a project with no version yet and leaves it alone afterwards; everything else starts empty
(CLAUDE.md 1절: nothing is made up). A change names the version it was made against; a stale one gets 409.

Writes use hmg_measurement_editor (HGH_MEASUREMENT_EDITOR_DB_URL): new versions only, naming their account, under the catalog lock
(617427413), so versions take change_seq in commit order. Top-level administrator only, like the other project pages (decision J)."""
from __future__ import annotations

import hashlib
import os
import re
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hub_server import input_db
from hub_server.inputs.catalog_editor import CATALOG_LOCK, LOCK_TIMEOUT, encoded, refused
from shared.account import Principal
from shared.measurement_view import CURRENT_SQL, LIST_SQL, OPTIONS_SQL, listed, options_of, view

CADENCES = ("weekly", "biweekly", "monthly")

URLS_MAX = 500       # owned or tracked URLs of one project

URL_MAX = 500

LIST_MAX = 300       # brands, countries, engines

TARGETS_MAX = 300

NAME_MAX = 200

UNITS_MAX = 300

BLANK = re.compile(r"[\s\x00-\x1f\x7f]")

INSERT_SQL = """INSERT INTO catalog.project_measurement_version(project_id,version,brands,countries,engines,cadence,acr_repeats,web_units,
    owned_urls,tracked_urls,tracked_targets,origin,sha256,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,'hub',$12,$13)"""

class WebUnit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fileSeq: int | None = None
    langCodes: list[str] = Field(default_factory=list, max_length=LIST_MAX)
    base: str | None = Field(None, max_length=URL_MAX)

class Target(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["brand", "model"]
    name: str = Field(max_length=NAME_MAX)
    brand: str | None = Field(None, max_length=NAME_MAX)

class MeasurementWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedVersion: int = Field(ge=0)   # 0: the project has no version yet
    brands: list[str] = Field(default_factory=list, max_length=LIST_MAX)
    countries: list[str] = Field(default_factory=list, max_length=LIST_MAX)
    engines: list[str] = Field(default_factory=list, max_length=LIST_MAX)
    cadence: Literal["weekly", "biweekly", "monthly"] | None = None
    acrRepeats: int | None = Field(None, ge=1, le=100)
    webUnits: list[WebUnit] = Field(default_factory=list, max_length=UNITS_MAX)
    ownedUrls: list[str] = Field(default_factory=list, max_length=URLS_MAX)
    trackedUrls: list[str] = Field(default_factory=list, max_length=URLS_MAX)
    trackedTargets: list[Target] = Field(default_factory=list, max_length=TARGETS_MAX)

def unique(values) -> list[str]:
    return list(dict.fromkeys(v for v in values if v))

def clean_url(raw: str) -> str:
    value = raw.strip()
    if BLANK.search(value) or len(value) > URL_MAX:
        raise refused(422, "invalid_value", "A URL must be one word of at most 500 characters", {"value": value[:100]})
    return value

def settings_of(body: MeasurementWrite) -> dict:
    """The stored shape of a write: codes in the reference tables' spelling, no repeats, no blanks."""
    targets, seen = [], set()
    for t in body.trackedTargets:
        name = t.name.strip()
        key = (t.kind, name.casefold())
        if name and key not in seen:
            seen.add(key)
            targets.append({"kind": t.kind, "name": name, **({"brand": t.brand.strip()} if t.brand and t.brand.strip() else {})})
    return {"brands": unique(v.strip().lower() for v in body.brands), "countries": unique(v.strip().upper() for v in body.countries),
            "engines": unique(v.strip().lower() for v in body.engines), "cadence": body.cadence, "acr_repeats": body.acrRepeats,
            "web_units": [{"file_seq": u.fileSeq, "lang_codes": unique(c.strip().lower() for c in u.langCodes),
                           "base": clean_url(u.base) if u.base and u.base.strip() else None} for u in body.webUnits],
            "owned_urls": unique(clean_url(u) for u in body.ownedUrls if u.strip()),
            "tracked_urls": unique(clean_url(u) for u in body.trackedUrls if u.strip()), "tracked_targets": targets}

def digest(settings: dict) -> str:
    return hashlib.sha256(encoded(settings).encode()).hexdigest()

def check_known(settings: dict, options: dict) -> None:
    """Every code must be one the reference values hold. Before the first Gold import there are none to check against."""
    unknown = {name: bad for name in ("brands", "countries", "engines") if options[name]
               and (bad := [v for v in settings[name] if v not in options[name]])}
    if unknown:
        raise refused(422, "unknown_code", "Unknown codes", {"unknown": unknown})

_pool = None

async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_MEASUREMENT_EDITOR_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-measurement-editor", "statement_timeout": "15000"},
        )

async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None

@asynccontextmanager
async def writing():
    if _pool is None:
        raise HTTPException(503, "Measurement settings are not configured (HGH_MEASUREMENT_EDITOR_DB_URL)")
    async with _pool.acquire() as conn, conn.transaction():
        await conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
        try:
            await conn.execute("SELECT pg_advisory_xact_lock($1)", CATALOG_LOCK)
        except asyncpg.LockNotAvailableError:
            raise HTTPException(503, "The Gold import is writing the catalog; try again shortly") from None
        yield conn

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
    return {"item": view(row), "options": options, "editing": _pool is not None}

async def listing() -> dict | None:
    """Admin › 측정 설정: every project and its settings, from the input store alone. None when the store is not there."""
    if not input_db.configured():
        return None
    try:
        async with input_db.connection() as conn:
            rows = await conn.fetch(LIST_SQL)
            options = options_of(await conn.fetch(OPTIONS_SQL))
    except (ConnectionError, OSError, asyncpg.PostgresError, TimeoutError):
        return None
    return {"items": [listed(r) for r in rows], "options": options, "editing": _pool is not None}

async def write(project_id: UUID, body: MeasurementWrite, actor: Principal) -> dict:
    settings = settings_of(body)
    async with writing() as conn:
        row = await conn.fetchrow(CURRENT_SQL, project_id)
        if row is None:
            raise HTTPException(404, "Project not found")
        current = row["version"] or 0
        if current != body.expectedVersion:
            raise refused(409, "version_conflict", "The settings were changed after you opened them; reload them", {"currentVersion": current})
        check_known(settings, options_of(await conn.fetch(OPTIONS_SQL)))
        sha = digest(settings)
        if row["sha256"] == sha:
            return {"item": view(row), "changed": False}
        await conn.execute(INSERT_SQL, project_id, current + 1, settings["brands"], settings["countries"], settings["engines"], settings["cadence"],
                           settings["acr_repeats"], encoded(settings["web_units"]), settings["owned_urls"], settings["tracked_urls"],
                           encoded(settings["tracked_targets"]), sha, actor.user_id)
        row = await conn.fetchrow(CURRENT_SQL, project_id)
    return {"item": view(row), "changed": True}
