"""Source category corrections on the renewal Admin › 인용 출처 분류 screen (2026-10-30).

The HUB owns the corrections people make (the override layer); Gold owns the automatic classification. The social and
seed lists are the HUB's to edit too (admin-todo decision G, not built yet); until then this module reads those layers
as Gold has them (docs/handoff/admin-todo.md, '기준값 편집 공통 구조'). The list is
Gold's latest global round (live read mode): its 500 most cited sources, every source the HUB corrected and every
source Gold applies a correction to, each with Gold's category and classification layer (dim_source.category_src)
as Gold has them. The HUB's correction is shown next to Gold's, and `state` compares the two: applied when Gold
applies the HUB's category (category_src 1 with the same category; for a revert, Gold no longer applies one),
pending until then, upstream for a correction Gold applies that the HUB does not have. Nothing here re-decides
Gold's attribution: a correction reaches the citation numbers after the pipeline reads it and Gold is rebuilt.

Writes use hmg_source_override_editor (HGH_SOURCE_OVERRIDE_EDITOR_DB_URL), which can write the corrections and their
history and call catalog.publish_source_overrides(), nothing else. Every write runs under the catalog lock
(617427413), records a source_override_event row and publishes the active corrections as the
reference family `source_override` for the external API when they changed (change_seq). A revert keeps the row
(status cleared). The data store records the whole row as its next version on every change (data-013,
catalog.source_override_version, change_seq like prompt revisions). Gold is read before the lock, never under it."""
from __future__ import annotations

import json
import os
import re
from contextlib import asynccontextmanager

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hub_server.inputs.catalog_editor import refused
from hub_server import data_checks, input_db
from shared.account import Principal
from shared.input_common import CONTROL, KEY_MAX, invalid, override_view as hub_view

CATALOG_LOCK = 617427413   # one catalog writer at a time: change_seq order = commit order

LOCK_TIMEOUT = "5s"        # a write waits this long for another writer, then 503

HISTORY_LIMIT = 100

ROW_COLUMNS = "skey,category,note,status,origin,created_at,updated_at,updated_by"

ONE_SQL = f"SELECT {ROW_COLUMNS} FROM catalog.source_override WHERE skey=$1"

HISTORY_SQL = """SELECT event_id,skey,action,actor_id,actor_login,actor_name,changes,published_seq,occurred_at FROM catalog.source_override_event
    WHERE skey=$1 ORDER BY occurred_at DESC,event_id DESC LIMIT $2"""

RECENT_SQL = """SELECT event_id,skey,action,actor_id,actor_login,actor_name,changes,published_seq,occurred_at FROM catalog.source_override_event
    ORDER BY occurred_at DESC,event_id DESC LIMIT $1"""

LOCK_SQL = "SELECT pg_advisory_xact_lock($1)"

INSERT_SQL = "INSERT INTO catalog.source_override(skey,category,origin,updated_by) VALUES($1,$2,'hub',$3)"

SET_SQL = "UPDATE catalog.source_override SET category=$2,status='active',updated_at=now(),updated_by=$3 WHERE skey=$1"

CLEAR_SQL = "UPDATE catalog.source_override SET status='cleared',updated_at=now(),updated_by=$2 WHERE skey=$1"

PUBLISH_SQL = "SELECT set_version,set_change_seq FROM catalog.publish_source_overrides()"

EVENT_SQL = """INSERT INTO catalog.source_override_event(skey,action,actor_id,actor_login,actor_name,changes,published_seq)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)"""

class OverrideSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skey: str = Field(max_length=KEY_MAX + 20)
    category: str = Field(max_length=64)

class OverrideClear(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skey: str = Field(max_length=KEY_MAX + 20)

def key_of(value: str) -> str:
    """The key the HUB and the pipeline compare (catalog.source_override.skey): lower case, trimmed, no leading
    www. A source key is a domain or an official social account (host/account)."""
    key = re.sub(r"^www\.", "", (value or "").strip().lower())
    if not 3 <= len(key) <= KEY_MAX or "." not in key or CONTROL.search(key):
        raise invalid("A source key is the domain (or social account) as the list shows it", "skey")
    return key

def event_view(row) -> dict:
    changes = row["changes"] if isinstance(row["changes"], dict) else json.loads(row["changes"] or "{}")
    return {"id": row["event_id"], "skey": row["skey"], "action": row["action"], "at": row["occurred_at"],
            "actor": {"login": row["actor_login"], "displayName": row["actor_name"]} if row["actor_login"] else None, "changes": changes, "publishedSeq": row["published_seq"]}

_pool = None

async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_SOURCE_OVERRIDE_EDITOR_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-source-overrides", "statement_timeout": "15000"},
        )

async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None

@asynccontextmanager
async def writing():
    if _pool is None:
        raise HTTPException(503, "Source correction editing is not configured (HGH_SOURCE_OVERRIDE_EDITOR_DB_URL)")
    async with _pool.acquire() as conn, conn.transaction():
        await conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
        try:
            await conn.execute(LOCK_SQL, CATALOG_LOCK)
        except asyncpg.LockNotAvailableError:
            raise HTTPException(503, "Another edit is writing the catalog; try again shortly") from None
        yield conn

@asynccontextmanager
async def reading():
    try:
        async with input_db.connection() as conn:
            yield conn
    except ConnectionError:
        raise HTTPException(503, "HUB input store is not configured") from None


async def history(skey: str | None) -> dict:
    """One source's correction and history, or the latest changes of every source (no skey)."""
    key = key_of(skey) if skey else None
    async with reading() as conn:
        row = await conn.fetchrow(ONE_SQL, key) if key else None
        events = await (conn.fetch(HISTORY_SQL, key, HISTORY_LIMIT) if key else conn.fetch(RECENT_SQL, HISTORY_LIMIT))
    return {"skey": key, "override": hub_view(row), "history": [event_view(e) for e in events]}

async def publish_and_record(conn, actor: Principal, key: str, action: str, changes: dict) -> dict | None:
    published = await conn.fetchrow(PUBLISH_SQL)
    seq = published["set_change_seq"] if published else None
    await conn.execute(EVENT_SQL, key, action, actor.user_id, actor.login, actor.display_name, json.dumps(changes, ensure_ascii=False), seq)
    return {"version": published["set_version"], "changeSeq": seq} if published else None

async def set_category(body: OverrideSet, actor: Principal) -> dict:
    """Correct a source's category (a new correction, a change, or a reverted one again). The same category as the
    active correction changes nothing."""
    key = key_of(body.skey)
    category = body.category.strip()
    gold = await data_checks.source(key, category, actor)
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(ONE_SQL, key)
        if row is None and gold is None:
            raise refused(404, "not_found", "Gold has no such source")
        if row is None:
            await conn.execute(INSERT_SQL, key, category, actor.user_id)
            published = await publish_and_record(conn, actor, key, "set", {"category": [None, category], "status": [None, "active"]})
        elif row["status"] != "active" or row["category"] != category:
            changes = {}
            if row["category"] != category:
                changes["category"] = [row["category"], category]
            if row["status"] != "active":
                changes["status"] = [row["status"], "active"]
            await conn.execute(SET_SQL, key, category, actor.user_id)
            published = await publish_and_record(conn, actor, key, "set", changes)
        row = await conn.fetchrow(ONE_SQL, key)
    return {"skey": key, "override": hub_view(row), "published": published}

async def clear(body: OverrideClear, actor: Principal) -> dict:
    """Revert a correction: the row stays (status cleared) and leaves the published list, so the pipeline returns
    the source to its default classification. Reverting a reverted one changes nothing."""
    key = key_of(body.skey)
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(ONE_SQL, key)
        if row is None:
            raise refused(404, "not_found", "The HUB has no correction for this source")
        if row["status"] == "active":
            await conn.execute(CLEAR_SQL, key, actor.user_id)
            published = await publish_and_record(conn, actor, key, "clear", {"status": ["active", "cleared"]})
        row = await conn.fetchrow(ONE_SQL, key)
    return {"skey": key, "override": hub_view(row), "published": published}
