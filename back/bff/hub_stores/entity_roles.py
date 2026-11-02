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
import uuid
from contextlib import asynccontextmanager

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from starlette.datastructures import QueryParams

from bff.gold_reader import db as gold_db
from bff.gold_reader.context import SQL, Context
from bff.hub_stores.catalog_editor import refused
from bff.hub_stores.ga4_registry import BRANDS
from bff.hub_stores.hub_auth import Principal
from bff.hub_stores.source_lists import events_view, history_sql, publish, published_sql, record
from bff.hub_stores.source_overrides import CATALOG_LOCK, LOCK_SQL, LOCK_TIMEOUT, invalid, published_view, reading

NOTE_MAX = 500
ROLES = ("own", "excluded")
KINDS = {1: "own", 2: "competitor", 3: "nonCompetitor"}  # gold.dim_brand.kind (0 = no name)
SAMPLE_ROUNDS = 8     # the latest global rounds the samples are read from
SAMPLE_KEYS = 2000    # the display brand's latest answers searched for this entity's occurrences
SAMPLE_LIMIT = 8
SURFACE_LIMIT = 12

# ═══ SQL ═════════════════════════════════════════════════════════════════════════════════════════════════

# Gold: the entities with numbers (Brand with a display name, all time), the ones with a role, and the HUB's.
GOLD_ROWS_SQL = """SELECT e.entity_id,e.entity_type,e.registry_role,e.rep_name,e.first_seen,e.brand_key,
        CASE WHEN b.kind<>0 THEN b.name END AS brand,b.kind,
        coalesce(t.answers,0)::int AS answers,coalesce(t.mentions,0)::int AS mentions
    FROM gold.dim_entity e LEFT JOIN gold.entity_mention_total t USING(entity_id) LEFT JOIN gold.dim_brand b USING(brand_key)
    WHERE t.entity_id IS NOT NULL OR e.registry_role IS NOT NULL OR e.entity_id=ANY($1::uuid[])"""
GOLD_ENTITY_SQL = """SELECT e.entity_id,e.entity_type,e.registry_role,e.rep_name,e.first_seen,e.brand_key,
        CASE WHEN b.kind<>0 THEN b.name END AS brand,b.kind
    FROM gold.dim_entity e LEFT JOIN gold.dim_brand b USING(brand_key) WHERE e.entity_id=$1"""
# One row per entity, surface and month: the count is the months a surface was observed in, not its mentions.
GOLD_SURFACES_SQL = """SELECT surface,count(DISTINCT run_month)::int AS months FROM gold.entity_mention_surface
    WHERE entity_id=$1 AND surface IS NOT NULL GROUP BY surface ORDER BY months DESC,surface LIMIT $2"""
# answer_occurrence has no index on the entity (a rare one takes 18 s): the brand's latest answers come first, through
# the fact's key, and the occurrences are read by answer_key, as the original screen did.
GOLD_SAMPLE_KEYS_SQL = """SELECT f.answer_key,f.round_date FROM gold.answer_brand_fact f WHERE {where} AND f.brand_key={brand}
    ORDER BY f.round_date DESC,f.answer_key DESC LIMIT {limit}"""
GOLD_OCCURRENCES_SQL = """SELECT DISTINCT ON(o.answer_key) o.answer_key,o.surface_text,o.context_snippet,o.sentiment,o.mention_role
    FROM gold.answer_occurrence o WHERE o.answer_key=ANY($1::int[]) AND o.entity_id=$2 AND o.context_snippet IS NOT NULL
    ORDER BY o.answer_key DESC,o.ord"""

ROW_COLUMNS = "entity_id,rep_name,role,brand,note,status,origin,created_at,updated_at,updated_by"
ONE_SQL = f"SELECT {ROW_COLUMNS} FROM catalog.entity_role WHERE entity_id=$1"


# ═══ input ═══════════════════════════════════════════════════════════════════════════════════════════════

class RoleSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entityId: str = Field(max_length=40)
    role: str = Field(max_length=16)
    brand: str | None = Field(default=None, max_length=16)
    note: str | None = Field(default=None, max_length=NOTE_MAX + 20)


class RoleClear(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entityId: str = Field(max_length=40)


def entity_key(value: str | None) -> uuid.UUID:
    try:
        return uuid.UUID(value or "")
    except ValueError:
        raise invalid("An entity is its Gold entity_id", "entityId") from None


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


# ═══ views ═══════════════════════════════════════════════════════════════════════════════════════════════

def gold_own_brand(gold) -> str | None:
    """The own brand Gold has for the entity: its display brand when that is an own brand (the family `entity`'s rule)."""
    return gold["brand"] if gold and gold["kind"] == 1 else None


def state_of(hub, gold) -> str | None:
    gold_role = gold["registry_role"] if gold else None
    if hub is None:
        return "upstream" if gold_role else None
    if hub["status"] != "active":
        return "pending" if gold_role else None
    same = gold_role == hub["role"] and (hub["role"] != "own" or gold_own_brand(gold) == hub["brand"])
    return "applied" if same else "pending"


def hub_view(row) -> dict | None:
    if row is None:
        return None
    return {"role": row["role"], "brand": row["brand"], "note": row["note"], "status": row["status"], "origin": row["origin"],
            "updatedAt": row["updated_at"]}


def row_view(key: str, hub, gold) -> dict:
    """One list row. role / brand are what the row means now: the HUB's active role, else Gold's, else the default."""
    active = hub is not None and hub["status"] == "active"
    gold_role = gold["registry_role"] if gold else None
    cleared = hub is not None and not active
    role = hub["role"] if active else ("competitor" if cleared or not gold_role else gold_role)
    brand = hub["brand"] if active else (gold_own_brand(gold) if role == "own" else None)
    return {"entityId": key, "name": (gold["rep_name"] if gold else None) or (hub["rep_name"] if hub else None) or (gold["brand"] if gold else None) or key,
            "type": gold["entity_type"] if gold else None, "displayBrand": gold["brand"] if gold else None,
            "kind": KINDS.get(gold["kind"]) if gold else None, "firstSeen": gold["first_seen"] if gold else None,
            "answers": gold["answers"] if gold else 0, "mentions": gold["mentions"] if gold else 0,
            "role": role, "brand": brand, "hub": hub_view(hub),
            "gold": {"role": gold_role, "brand": gold_own_brand(gold)} if gold else None, "state": state_of(hub, gold)}


# ═══ connections ═════════════════════════════════════════════════════════════════════════════════════════

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


# ═══ Gold reads (read-only; never under the catalog lock) ════════════════════════════════════════════════

async def gold_rows(keys: list[uuid.UUID]) -> dict[str, dict]:
    async with gold_db.connection() as conn:
        rows = await conn.fetch(GOLD_ROWS_SQL, keys)
    return {str(r["entity_id"]): dict(r) for r in rows}


async def gold_entity(key: uuid.UUID) -> dict | None:
    async with gold_db.connection() as conn:
        row = await conn.fetchrow(GOLD_ENTITY_SQL, key)
    return dict(row) if row else None


# ═══ reads ═══════════════════════════════════════════════════════════════════════════════════════════════

async def listing() -> dict:
    async with reading() as conn:
        hub = {str(r["entity_id"]): r for r in await conn.fetch(f"SELECT {ROW_COLUMNS} FROM catalog.entity_role")}
        published = await conn.fetchrow(published_sql("entity_role"))
    gold = await gold_rows([uuid.UUID(k) for k in hub])
    items = [row_view(k, hub.get(k), g) for k, g in gold.items()]
    items += [row_view(k, h, None) for k, h in hub.items() if k not in gold]
    items.sort(key=lambda i: (-i["answers"], i["name"], i["entityId"]))
    return {"items": items, "published": published_view(published)}


async def history(entity: str | None) -> dict:
    """One entity's history, or the latest changes of every entity (no entity)."""
    key = entity_key(entity) if entity else None
    async with reading() as conn:
        events = await (conn.fetch(history_sql("entity_role", "WHERE entity_id=$1"), key) if key
                        else conn.fetch(history_sql("entity_role", "")))
    return {"entityId": str(key) if key else None, "history": await events_view(events, "entity_id")}


async def mentions(entity: str | None) -> dict:
    """What Gold has for one entity to judge its role by: its observed surfaces (all time) and occurrences with their
    context in the latest global rounds. Read-only values, shown as they are."""
    key = entity_key(entity)
    async with gold_db.connection() as conn:
        row = await conn.fetchrow(GOLD_ENTITY_SQL, key)
        if row is None:
            raise refused(404, "not_found", "Gold has no such entity")
        surfaces = await conn.fetch(GOLD_SURFACES_SQL, key, SURFACE_LIMIT)
        latest = await Context.create(conn, QueryParams("surface=global"))
        rounds = sorted(latest.dates, reverse=True)[:SAMPLE_ROUNDS]
        samples, keys = [], []
        if row["brand_key"] and rounds:
            ctx = await Context.create(conn, QueryParams({"surface": "global", "from": rounds[-1].isoformat()}))
            b = SQL()
            where = ctx.predicate(b, family="fact")
            sql = GOLD_SAMPLE_KEYS_SQL.format(where=where, brand=b.bind(row["brand_key"], "int"), limit=b.bind(SAMPLE_KEYS, "int"))
            keys = await conn.fetch(sql, *b.args)
        if keys:
            occurrences = await conn.fetch(GOLD_OCCURRENCES_SQL, [k["answer_key"] for k in keys], key)
            when = {k["answer_key"]: k["round_date"] for k in keys}
            samples = [{"answerKey": o["answer_key"], "round": when[o["answer_key"]], "surface": o["surface_text"], "context": o["context_snippet"],
                        "sentiment": o["sentiment"], "mentionRole": o["mention_role"]} for o in occurrences[:SAMPLE_LIMIT]]
    return {"entityId": str(key), "rounds": len(rounds), "surfaces": [{"surface": s["surface"], "months": s["months"]} for s in surfaces], "samples": samples}


# ═══ writes ══════════════════════════════════════════════════════════════════════════════════════════════

def row_of(row) -> dict:
    return {"entityId": str(row["entity_id"]), "name": row["rep_name"], **hub_view(row)}


async def set_role(body: RoleSet, actor: Principal) -> dict:
    """Give an entity a role, change it, or give a cleared one a role again. The same values change nothing. Gold is the
    list of entities: one it does not have cannot get a role."""
    key = entity_key(body.entityId)
    role, brand = clean_role(body.role, body.brand)
    note = clean_note(body.note)
    gold = await gold_entity(key)
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
    gold = await gold_entity(key)
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
