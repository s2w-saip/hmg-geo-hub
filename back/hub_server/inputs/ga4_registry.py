"""The GA4 property registry on the renewal Admin › GA4 연동 screen (2026-10-29).

The top-level administrator registers the GA4 properties the collector reads (back/analytics/ga4_collect.py): the
property ID, its market (brand × country, one collected property per market), the conversion basis (GA4 key events,
or the listed events) and whether it is collected (stop / resume; a property is never deleted). Reads use the
read-only input store role; writes use hmg_ga4_registry_editor (HGH_GA4_REGISTRY_EDITOR_DB_URL), which can touch the
registry and its history only. Every change is a ga4_registry_event row, shown as the property's history.

The BFF does not call GA4. A change reaches the AI Conversion screen when the collector next runs, and the
collector's last result per property (ga4_collect_status: collected / pending_grant / failed / stopped) is shown
as it left it. The events offered for the listed-events basis are the ones the collector already stored for the
property (its last 90 collected days). Writes run one at a time (advisory lock), so a market is checked and taken
in turn."""
from __future__ import annotations

import hashlib
import json
import os
import re
from contextlib import asynccontextmanager

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hub_server import input_db
from hub_server.inputs.catalog_editor import refused
from shared.account import Principal
from shared.input_common import BRANDS

BASIS = {"key_events": 1, "events": 2}

BASIS_NAMES = {v: k for k, v in BASIS.items()}

REGISTRY_LOCK = 617427421

PROPERTY = re.compile(r"[0-9]{1,20}")

COUNTRY = re.compile(r"[A-Z]{2}")

# A GA4 event name: a letter, then letters, digits and underscores, at most 40 characters.
EVENT = re.compile(r"[^\W\d_]\w{0,39}")

EVENTS_MAX = 50

REGISTRY_COLUMNS = """r.property_id,r.brand,r.country,r.conv_basis,r.conv_events,r.enabled,r.created_at,r.updated_at,
    s.status,s.checked_at,s.error,s.collected_at,s.collected_to
    FROM catalog.ga4_registry r LEFT JOIN catalog.ga4_collect_status s USING(property_id)"""

LIST_SQL = f"SELECT {REGISTRY_COLUMNS} ORDER BY r.brand,r.country,r.property_id"

ONE_SQL = f"SELECT {REGISTRY_COLUMNS} WHERE r.property_id=$1"

HISTORY_SQL = """SELECT event_id,action,actor_id,actor_login,actor_name,changes,occurred_at FROM catalog.ga4_registry_event
    WHERE property_id=$1 ORDER BY occurred_at DESC,event_id DESC LIMIT 100"""

LOCK_SQL = "SELECT pg_advisory_xact_lock($1)"

TAKEN_SQL = "SELECT 1 FROM catalog.ga4_registry WHERE property_id=$1"

MARKET_SQL = "SELECT property_id FROM catalog.ga4_registry WHERE brand=$1 AND country=$2 AND enabled AND property_id<>$3"

INSERT_SQL = "INSERT INTO catalog.ga4_registry(property_id,brand,country,conv_basis,conv_events) VALUES($1,$2,$3,$4,$5)"

UPDATE_SQL = """UPDATE catalog.ga4_registry SET brand=$2,country=$3,conv_basis=$4,conv_events=$5,updated_at=now()
    WHERE property_id=$1"""

ENABLED_SQL = "UPDATE catalog.ga4_registry SET enabled=$2,updated_at=now() WHERE property_id=$1"

EVENT_SQL = "INSERT INTO catalog.ga4_registry_event(property_id,action,actor_id,actor_login,actor_name,changes) VALUES($1,$2,$3,$4,$5,$6::jsonb)"

class PropertyFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    brand: str = Field(max_length=20)
    country: str = Field(max_length=8)
    basis: str = Field(max_length=20)
    events: list[str] = Field(default_factory=list, max_length=EVENTS_MAX)

class PropertyCreate(PropertyFields):
    propertyId: str = Field(max_length=40)

class PropertyUpdate(PropertyFields):
    expectedVersion: str = Field(max_length=64)

def invalid(message: str, *fields: str) -> HTTPException:
    return refused(422, "invalid_value", message, {"fields": list(fields)})

def property_of(value: str) -> str:
    pid = value.strip()
    if not PROPERTY.fullmatch(pid):
        raise invalid("A GA4 property ID is its number (Admin › Property settings), digits only", "propertyId")
    return pid

def fields_of(body: PropertyFields) -> tuple[str, str, int, list[str]]:
    """brand, country, basis, events as stored: the collector's registry rules (load_registry before 2026-10-29)
    and GA4's event name rule. Events are kept with the listed-events basis only."""
    names = {b.lower(): b for b in BRANDS}
    brand = names.get(body.brand.strip().lower())
    if brand is None:
        raise invalid("The brand is Hyundai, Kia or Genesis", "brand")
    country = body.country.strip().upper()
    if not COUNTRY.fullmatch(country):
        raise invalid("The country is an ISO 3166-1 alpha-2 code", "country")
    basis = BASIS.get(body.basis)
    if basis is None:
        raise invalid("The conversion basis is key_events or events", "basis")
    events = list(dict.fromkeys(e.strip() for e in body.events if e.strip())) if basis == 2 else []
    if basis == 2 and not events:
        raise invalid("List the GA4 events counted as conversions", "events")
    if any(not EVENT.fullmatch(e) for e in events):
        raise invalid("A GA4 event name starts with a letter and has letters, digits and _ only (at most 40)", "events")
    return brand, country, basis, events

def version_of(row) -> str:
    """The fields the edit form changes, as it saw them. A stop, a resume or a collector run in the meantime does
    not make an edit conflict; another edit of these fields does."""
    parts = [row["brand"], row["country"], row["conv_basis"], list(row["conv_events"] or [])]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:16]

def view(row) -> dict:
    """`collection` is the collector's last result as it left it; `pending` = the registry changed after that run
    (or it never ran for the property), so the change is not on the AI Conversion screen yet."""
    checked = row["checked_at"]
    return {"propertyId": row["property_id"], "brand": row["brand"], "country": row["country"],
            "basis": BASIS_NAMES[row["conv_basis"]], "events": list(row["conv_events"] or []), "enabled": row["enabled"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"], "version": version_of(row),
            "collection": {"status": row["status"], "checkedAt": checked, "error": row["error"],
                           "collectedAt": row["collected_at"], "collectedTo": row["collected_to"],
                           "pending": checked is None or checked < row["updated_at"]}}

def event_view(row) -> dict:
    changes = row["changes"] if isinstance(row["changes"], dict) else json.loads(row["changes"] or "{}")
    return {"id": row["event_id"], "action": row["action"], "at": row["occurred_at"],
            "actor": {"login": row["actor_login"], "displayName": row["actor_name"]} if row["actor_login"] else None, "changes": changes}

_pool = None

async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_GA4_REGISTRY_EDITOR_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-ga4-registry", "statement_timeout": "15000"},
        )

async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None

@asynccontextmanager
async def writing():
    if _pool is None:
        raise HTTPException(503, "GA4 registry editing is not configured (HGH_GA4_REGISTRY_EDITOR_DB_URL)")
    async with _pool.acquire() as conn, conn.transaction():
        await conn.execute(LOCK_SQL, REGISTRY_LOCK)
        yield conn

@asynccontextmanager
async def reading():
    try:
        async with input_db.connection() as conn:
            yield conn
    except ConnectionError:
        raise HTTPException(503, "HUB input store is not configured") from None

async def current(conn, pid: str):
    row = await conn.fetchrow(ONE_SQL, pid)
    if row is None:
        raise HTTPException(404, "No such GA4 property")
    return row

async def record(conn, actor: Principal, pid: str, action: str, changes: dict) -> None:
    await conn.execute(EVENT_SQL, pid, action, actor.user_id, actor.login, actor.display_name, json.dumps(changes, ensure_ascii=False))

async def check_market(conn, brand: str, country: str, pid: str) -> None:
    other = await conn.fetchval(MARKET_SQL, brand, country, pid)
    if other:
        raise refused(409, "market_taken", "Another collected property has this market",
                      {"fields": ["brand", "country"], "propertyId": other})

async def listing() -> dict:
    async with reading() as conn:
        return {"items": [view(r) for r in await conn.fetch(LIST_SQL)]}

async def detail(pid: str) -> dict:
    async with reading() as conn:
        row = await current(conn, pid)
        history = await conn.fetch(HISTORY_SQL, pid)
    return {"item": view(row), "history": [event_view(e) for e in history]}

async def create(body: PropertyCreate, actor: Principal) -> dict:
    pid = property_of(body.propertyId)
    brand, country, basis, events_ = fields_of(body)
    async with writing() as conn:
        if await conn.fetchval(TAKEN_SQL, pid):
            raise refused(409, "property_taken", "The GA4 property is registered", {"fields": ["propertyId"]})
        await check_market(conn, brand, country, pid)
        await conn.execute(INSERT_SQL, pid, brand, country, basis, events_)
        await record(conn, actor, pid, "create", {"brand": [None, brand], "country": [None, country],
                                                  "basis": [None, BASIS_NAMES[basis]], **({"events": [[], events_]} if events_ else {})})
        row = await current(conn, pid)
    return {"item": view(row)}

async def update(pid: str, body: PropertyUpdate, actor: Principal) -> dict:
    brand, country, basis, events_ = fields_of(body)
    async with writing() as conn:
        row = await current(conn, pid)
        if version_of(row) != body.expectedVersion:
            raise refused(409, "version_conflict", "The property changed since it was opened")
        before = {"brand": row["brand"], "country": row["country"], "basis": BASIS_NAMES[row["conv_basis"]],
                  "events": list(row["conv_events"] or [])}
        after = {"brand": brand, "country": country, "basis": BASIS_NAMES[basis], "events": events_}
        changes = {k: [before[k], after[k]] for k in after if before[k] != after[k]}
        if changes:
            if row["enabled"] and changes.keys() & {"brand", "country"}:
                await check_market(conn, brand, country, pid)
            await conn.execute(UPDATE_SQL, pid, brand, country, basis, events_)
            await record(conn, actor, pid, "update", changes)
            row = await current(conn, pid)
    return {"item": view(row)}

async def set_enabled(pid: str, enabled: bool, actor: Principal) -> dict:
    """Stop: the collector leaves the property out from its next run and the AI Conversion screen with it; its
    rows stay. Resume: collected again, if its market has no other collected property."""
    async with writing() as conn:
        row = await current(conn, pid)
        if row["enabled"] != enabled:
            if enabled:
                await check_market(conn, row["brand"], row["country"], pid)
            await conn.execute(ENABLED_SQL, pid, enabled)
            await record(conn, actor, pid, "resume" if enabled else "stop", {"enabled": [row["enabled"], enabled]})
            row = await current(conn, pid)
    return {"item": view(row)}
