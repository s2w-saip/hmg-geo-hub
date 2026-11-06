"""Entity roles on the renewal Admin › 엔티티 카탈로그 screen (2026-11-02).

Who is own and who is excluded is decided by people, so it is the HUB's (docs/handoff/admin-todo.md, decisions A · F and
'기준값 편집 공통 구조'); competitor is the default and is not stored. The entities, their display brand, their kind and
their numbers are Gold's: the list is every entity of gold.entity_mention_total, plus every entity with a role on either
side, and nothing here merges or re-attributes them. `state` only compares the HUB's role with Gold's: applied (Gold has
the HUB's role and own brand) · pending (not yet; for a cleared role, Gold still has one) · upstream (Gold has a role the
HUB does not have) · None (nothing to compare).

There is no draft, preview or approval: applying a role means rebuilding Gold, which the pipeline does after it reads the
list, and a preview would be the HUB recomputing the KPIs (decision F). A change reaches the numbers after that rebuild.

Writes use hmg_entity_role_editor (HGH_ENTITY_ROLE_EDITOR_DB_URL), which can write the roles and their history and call
catalog.publish_entity_roles(), nothing else. Every write runs under the catalog lock (617427413), records an event row and
publishes the active roles (entity_role, source hub_edit) when they changed. Rows are never deleted: back to competitor is
status=cleared. Gold is read before the lock, never under it."""
from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hub_server.inputs.catalog_editor import refused
from hub_server.inputs.source_lists import events_view, history_sql, publish, record
from hub_server.inputs.source_overrides import CATALOG_LOCK, LOCK_SQL, LOCK_TIMEOUT, invalid, reading
from hub_server import data_checks
from shared.account import Principal
from shared.input_common import BRANDS, entity_key, entity_role_view as hub_view, gold_own_brand

NOTE_MAX = 500

ROLES = ("own", "excluded")

ROW_COLUMNS = "entity_id,rep_name,role,brand,note,status,origin,created_at,updated_at,updated_by"

ONE_SQL = f"SELECT {ROW_COLUMNS} FROM catalog.entity_role WHERE entity_id=$1"

class RoleSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entityId: str = Field(max_length=40)
    role: str = Field(max_length=16)
    brand: str | None = Field(default=None, max_length=16)
    note: str | None = Field(default=None, max_length=NOTE_MAX + 20)

class RoleClear(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entityId: str = Field(max_length=40)

def clean_role(role: str, brand: str | None) -> tuple[str, str | None]:
    """own carries one of the HMG brands; excluded none. Competitor is not a stored role: it is clearing one."""
    if role not in ROLES:
        raise invalid("The role is own or excluded; competitor is clearing the role", "role")
    if role == "own":
        if brand not in BRANDS:
            raise invalid("An own entity names its HMG brand", "brand")
        return role, brand
    if brand is not None:
        raise invalid("Only an own entity names a brand", "brand")
    return role, None

def clean_note(value: str | None) -> str | None:
    note = (value or "").strip()
    if len(note) > NOTE_MAX or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", note):
        raise invalid(f"A note of up to {NOTE_MAX} characters", "note")
    return note or None

_pool = None

async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_ENTITY_ROLE_EDITOR_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-entity-roles", "statement_timeout": "15000"},
        )

async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None

@asynccontextmanager
async def writing():
    if _pool is None:
        raise HTTPException(503, "Entity role editing is not configured (HGH_ENTITY_ROLE_EDITOR_DB_URL)")
    async with _pool.acquire() as conn, conn.transaction():
        await conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
        try:
            await conn.execute(LOCK_SQL, CATALOG_LOCK)
        except asyncpg.LockNotAvailableError:
            raise HTTPException(503, "The Gold import is writing the catalog; try again shortly") from None
        yield conn

async def history(entity: str | None) -> dict:
    """One entity's history, or the latest changes of every entity (no entity)."""
    key = entity_key(entity) if entity else None
    async with reading() as conn:
        events = await (conn.fetch(history_sql("entity_role", "WHERE entity_id=$1"), key) if key
                        else conn.fetch(history_sql("entity_role", "")))
    return {"entityId": str(key) if key else None, "history": await events_view(events, "entity_id")}

def row_of(row) -> dict:
    return {"entityId": str(row["entity_id"]), "name": row["rep_name"], **hub_view(row)}

async def set_role(body: RoleSet, actor: Principal) -> dict:
    """Give an entity a role, change it, or give a cleared one a role again. The same values change nothing. Gold is the
    list of entities: one it does not have cannot get a role."""
    key = entity_key(body.entityId)
    role, brand = clean_role(body.role, body.brand)
    note = clean_note(body.note)
    gold = await data_checks.entity(key, actor)
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(ONE_SQL, key)
        if row is None:
            if gold is None:
                raise refused(404, "not_found", "Gold has no such entity")
            name = gold["rep_name"] or gold["brand"] or str(key)
            await conn.execute("""INSERT INTO catalog.entity_role(entity_id,rep_name,role,brand,note,origin,updated_by)
                VALUES($1,$2,$3,$4,$5,'hub',$6)""", key, name, role, brand, note, actor.user_id)
            published = await publish(conn, "publish_entity_roles")
            changes = {k: [None, v] for k, v in (("role", role), ("brand", brand), ("note", note), ("status", "active")) if v}
            await record(conn, "entity_role", ("entity_id",), (key,), actor, "set", changes, published)
        else:
            new = {"role": role, "brand": brand, "note": note, "status": "active"}
            changes = {k: [row[k], v] for k, v in new.items() if row[k] != v}
            if changes:
                await conn.execute("""UPDATE catalog.entity_role SET role=$2,brand=$3,note=$4,status='active',updated_at=now(),updated_by=$5
                    WHERE entity_id=$1""", key, role, brand, note, actor.user_id)
                published = await publish(conn, "publish_entity_roles")
                await record(conn, "entity_role", ("entity_id",), (key,), actor, "set", changes, published)
        row = await conn.fetchrow(ONE_SQL, key)
    return {"entityId": str(key), "role": row_of(row), "published": published}

async def clear(body: RoleClear, actor: Principal) -> dict:
    """Back to the default (competitor): the row stays (status cleared) and leaves the published list. A role only Gold
    has gets a cleared row, so the HUB's decision and its history exist. Clearing a cleared role changes nothing."""
    key = entity_key(body.entityId)
    gold = await data_checks.entity(key, actor)
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(ONE_SQL, key)
        if row is None:
            if gold is None or not gold["registry_role"]:
                raise refused(404, "not_found", "The entity has no role to clear")
            role, brand = gold["registry_role"], gold_own_brand(gold)
            await conn.execute("""INSERT INTO catalog.entity_role(entity_id,rep_name,role,brand,status,origin,updated_by)
                VALUES($1,$2,$3,$4,'cleared','hub',$5)""", key, gold["rep_name"] or gold["brand"] or str(key), role, brand, actor.user_id)
            published = await publish(conn, "publish_entity_roles")
            await record(conn, "entity_role", ("entity_id",), (key,), actor, "clear", {"status": [None, "cleared"]}, published)
        elif row["status"] == "active":
            await conn.execute("UPDATE catalog.entity_role SET status='cleared',updated_at=now(),updated_by=$2 WHERE entity_id=$1", key, actor.user_id)
            published = await publish(conn, "publish_entity_roles")
            await record(conn, "entity_role", ("entity_id",), (key,), actor, "clear", {"status": ["active", "cleared"]}, published)
        row = await conn.fetchrow(ONE_SQL, key)
    return {"entityId": str(key), "role": row_of(row), "published": published}
