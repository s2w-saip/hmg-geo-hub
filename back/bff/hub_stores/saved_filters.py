"""Saved filters of the renewal screens, one list per HUB account and page (2026-10-28).

The filter panel's saved filters (load, save the current conditions, rename, overwrite, open by default,
delete with undo) lived in the browser's localStorage; as rows of the operations DB system.saved_filter an
account sees the same list in every browser. Lists are read with the read-only operations role and written
with hmg_saved_filter_editor (HGH_SAVED_FILTER_EDITOR_DB_URL), which can touch this one table only. Every
statement is bound to the signed-in account, so no one reads or changes another account's filters. `query`
is the page's own filter query string: kept as given and never interpreted here. One account's writes take
a lock in turn, so the order and the single default stay consistent across tabs and browsers."""
from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from bff.hub_stores import operations_db
from bff.hub_stores.catalog_editor import refused
from bff.hub_stores.hub_auth import Principal

# The renewal screens with a saved filter list (front: the `page` each gives its filter panel). A Website page
# keeps its own list (2026-10-30): its filters are the site axes, not the Global ones.
PAGES = ("overview", "mention", "citation", "acr", "visibility", "conversion", "prompts", "hub-prompts", "accounts", "ga4",
         "website-overview", "website-mention", "website-citation", "website-prompts", "website-conversion", "website-acr")
NAME_MAX = 40
QUERY_MAX = 4000
PER_PAGE_MAX = 50
FILTER_LOCK = 617427415   # with the account's hash (two-key advisory lock): one account's writes in turn
CONTROL = re.compile(r"[\x00-\x1f\x7f]")

LIST_SQL = """SELECT filter_id,name,query,is_default,created_at,updated_at FROM system.saved_filter
    WHERE user_id=$1 AND page=$2 ORDER BY position,created_at"""
OWN_SQL = "SELECT page,position FROM system.saved_filter WHERE filter_id=$1 AND user_id=$2"
LOCK_SQL = "SELECT pg_advisory_xact_lock($1,hashtext($2))"
COUNT_SQL = "SELECT count(*)::int FROM system.saved_filter WHERE user_id=$1 AND page=$2"
NEXT_SQL = "SELECT coalesce(max(position)+1,0) FROM system.saved_filter WHERE user_id=$1 AND page=$2"
SHIFT_SQL = "UPDATE system.saved_filter SET position=position+1 WHERE user_id=$1 AND page=$2 AND position>=$3"
CLEAR_DEFAULT_SQL = """UPDATE system.saved_filter SET is_default=false,updated_at=now()
    WHERE user_id=$1 AND page=$2 AND is_default AND filter_id<>$3"""
INSERT_SQL = """INSERT INTO system.saved_filter(filter_id,user_id,page,name,query,is_default,position)
    VALUES($1,$2,$3,$4,$5,$6,$7)"""
UPDATE_SQL = """UPDATE system.saved_filter SET name=coalesce($3,name),query=coalesce($4,query),
    is_default=coalesce($5,is_default),updated_at=now() WHERE filter_id=$1 AND user_id=$2"""
DELETE_SQL = "DELETE FROM system.saved_filter WHERE filter_id=$1 AND user_id=$2 RETURNING page"


# ═══ input ═══════════════════════════════════════════════════════════════════════════════════════════════

class FilterFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(max_length=4 * NAME_MAX)
    query: str = Field(max_length=QUERY_MAX)
    isDefault: bool = False


class FilterCreate(FilterFields):
    page: str
    # Undo of a delete: back in front of the filter that followed it (gone by now: at the end).
    before: UUID | None = None


class FilterChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, max_length=4 * NAME_MAX)
    query: str | None = Field(None, max_length=QUERY_MAX)
    isDefault: bool | None = None


class FilterImport(BaseModel):
    """A browser's earlier (localStorage) list of a page, moved to the account once."""
    model_config = ConfigDict(extra="forbid")
    page: str
    items: list[FilterFields] = Field(max_length=PER_PAGE_MAX)


def page_of(value) -> str:
    if value not in PAGES:
        raise refused(422, "invalid_value", "Unknown page", {"fields": ["page"]})
    return value


def name_of(value: str) -> str:
    name = value.strip()
    if not name or len(name) > NAME_MAX or CONTROL.search(name):
        raise refused(422, "invalid_value", f"A name is 1-{NAME_MAX} characters on one line", {"fields": ["name"]})
    return name


def query_of(value: str) -> str:
    if CONTROL.search(value):
        raise refused(422, "invalid_value", "The query must not contain control characters", {"fields": ["query"]})
    return value


def view(row) -> dict:
    return {"id": str(row["filter_id"]), "name": row["name"], "query": row["query"], "isDefault": row["is_default"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


# ═══ connections ═════════════════════════════════════════════════════════════════════════════════════════

_pool = None


async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_SAVED_FILTER_EDITOR_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-saved-filters", "statement_timeout": "15000"},
        )


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def writing(actor: Principal):
    if _pool is None:
        raise HTTPException(503, "Saved filters are not configured (HGH_SAVED_FILTER_EDITOR_DB_URL)")
    async with _pool.acquire() as conn, conn.transaction():
        await conn.execute(LOCK_SQL, FILTER_LOCK, str(actor.user_id))
        yield conn


async def items(conn, actor: Principal, page: str) -> list[dict]:
    return [view(r) for r in await conn.fetch(LIST_SQL, actor.user_id, page)]


def answer(filter_id: UUID, listed: list[dict]) -> dict:
    return {"item": next(i for i in listed if i["id"] == str(filter_id)), "items": listed}


# ═══ reads and writes ════════════════════════════════════════════════════════════════════════════════════

async def listing(page, actor: Principal) -> dict:
    page = page_of(page)
    try:
        async with operations_db.connection() as conn:
            return {"items": await items(conn, actor, page)}
    except ConnectionError:
        raise HTTPException(503, "HUB operations store is not configured") from None


async def create(body: FilterCreate, actor: Principal) -> dict:
    page, name, query = page_of(body.page), name_of(body.name), query_of(body.query)
    filter_id = uuid4()
    async with writing(actor) as conn:
        if await conn.fetchval(COUNT_SQL, actor.user_id, page) >= PER_PAGE_MAX:
            raise refused(409, "limit", f"A page keeps at most {PER_PAGE_MAX} saved filters", {"limit": PER_PAGE_MAX})
        anchor = await conn.fetchrow(OWN_SQL, body.before, actor.user_id) if body.before else None
        if anchor is not None and anchor["page"] == page:
            position = anchor["position"]
            await conn.execute(SHIFT_SQL, actor.user_id, page, position)
        else:
            position = await conn.fetchval(NEXT_SQL, actor.user_id, page)
        if body.isDefault:
            await conn.execute(CLEAR_DEFAULT_SQL, actor.user_id, page, filter_id)
        await conn.execute(INSERT_SQL, filter_id, actor.user_id, page, name, query, body.isDefault, position)
        return answer(filter_id, await items(conn, actor, page))


async def change(filter_id: UUID, body: FilterChange, actor: Principal) -> dict:
    """Rename, overwrite with the current conditions, or open by default (on: the page's other one stops)."""
    if body.name is None and body.query is None and body.isDefault is None:
        raise refused(422, "invalid_value", "Nothing to change", {"fields": ["name", "query", "isDefault"]})
    name = name_of(body.name) if body.name is not None else None
    query = query_of(body.query) if body.query is not None else None
    async with writing(actor) as conn:
        own = await conn.fetchrow(OWN_SQL, filter_id, actor.user_id)
        if own is None:
            raise HTTPException(404, "No such saved filter")
        if body.isDefault:
            await conn.execute(CLEAR_DEFAULT_SQL, actor.user_id, own["page"], filter_id)
        await conn.execute(UPDATE_SQL, filter_id, actor.user_id, name, query, body.isDefault)
        return answer(filter_id, await items(conn, actor, own["page"]))


async def remove(filter_id: UUID, actor: Principal) -> dict:
    async with writing(actor) as conn:
        page = await conn.fetchval(DELETE_SQL, filter_id, actor.user_id)
        if page is None:
            raise HTTPException(404, "No such saved filter")
        return {"items": await items(conn, actor, page)}


async def import_items(body: FilterImport, actor: Principal) -> dict:
    """Appends the filters the account does not have yet (same name and query), up to the page limit. The
    first one marked default opens by default only when the account has no default there. Sent again (another
    tab, a retry), it adds nothing."""
    page = page_of(body.page)
    incoming = [(name_of(i.name), query_of(i.query), i.isDefault) for i in body.items]
    async with writing(actor) as conn:
        listed = await items(conn, actor, page)
        known = {(i["name"], i["query"]) for i in listed}
        has_default = any(i["isDefault"] for i in listed)
        position = await conn.fetchval(NEXT_SQL, actor.user_id, page)
        added = 0
        for name, query, default in incoming:
            if (name, query) in known or len(listed) + added >= PER_PAGE_MAX:
                continue
            default = default and not has_default
            has_default = has_default or default
            await conn.execute(INSERT_SQL, uuid4(), actor.user_id, page, name, query, default, position)
            known.add((name, query))
            position += 1
            added += 1
        if added:
            listed = await items(conn, actor, page)
    return {"items": listed, "imported": added, "skipped": len(incoming) - added}
