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
(617427413, the Gold import's), records a source_override_event row and publishes the active corrections as the
reference family `source_override` for the external API when they changed (change_seq). A revert keeps the row
(status cleared). Gold is read before the lock, never under it."""
from __future__ import annotations

import json
import os
import re
from contextlib import asynccontextmanager

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from starlette.datastructures import QueryParams

from bff.gold_reader import citations as gold_citations
from bff.gold_reader import db as gold_db
from bff.gold_reader.context import SQL, Context
from bff.hub_stores import analytics_db
from bff.hub_stores.catalog_editor import actors, refused
from bff.hub_stores.hub_auth import Principal

LIMIT = 500                # the most cited sources listed (as the original screen)
CATALOG_LOCK = 617427413   # the Gold import's lock (sync_catalog.py): one catalog writer at a time
LOCK_TIMEOUT = "5s"        # a write waits this long for a running Gold import, then 503
HISTORY_LIMIT = 100
# gold.dim_source.category_src -> the layer that decided the category (Gold ERD: 1 교정 2 공식 소셜 3 당사 도메인 4 시드 5 규칙 6 Other)
LAYERS = {1: "override", 2: "social", 3: "owned", 4: "seed", 5: "rule", 6: "fallback"}
KEY_MAX = 300
CONTROL = re.compile(r"[\s\x00-\x1f\x7f]")

# ═══ SQL ═════════════════════════════════════════════════════════════════════════════════════════════════

# Gold: the sources of the latest global round's citations (the citation screens' population), the top LIMIT by
# citations, plus the sources the HUB corrected and the ones Gold applies a correction to, whatever their count.
GOLD_ROWS_SQL = """WITH a AS (SELECT f.source_key,count(*)::int AS citations FROM gold.citation_fact f
        WHERE {where} AND f.source_key<>0 GROUP BY f.source_key),
    top AS (SELECT a.source_key FROM a JOIN gold.dim_source s USING(source_key) ORDER BY a.citations DESC,s.skey LIMIT {limit}),
    picked AS (SELECT source_key FROM top UNION
        SELECT source_key FROM gold.dim_source WHERE source_key<>0 AND (category_src=1 OR lower(skey)=ANY({keys})))
    SELECT s.skey,s.domain,s.is_social,s.category_src,s.owned_brand_bit,c.slug,coalesce(a.citations,0)::int AS citations,
        EXISTS(SELECT 1 FROM top t WHERE t.source_key=p.source_key) AS in_top
    FROM picked p JOIN gold.dim_source s USING(source_key) LEFT JOIN a USING(source_key)
    LEFT JOIN gold.dim_category c ON c.category_key=s.category_key"""
GOLD_CATEGORIES_SQL = "SELECT slug,name,ord FROM gold.dim_category WHERE coalesce(slug,'')<>'' ORDER BY ord,slug"
GOLD_SOURCE_SQL = """SELECT s.skey,s.category_src,c.slug FROM gold.dim_source s LEFT JOIN gold.dim_category c USING(category_key)
    WHERE s.source_key<>0 AND lower(s.skey)=$1 ORDER BY s.source_key LIMIT 1"""

ROW_COLUMNS = "skey,category,note,status,origin,created_at,updated_at,updated_by"
HUB_ROWS_SQL = f"SELECT {ROW_COLUMNS} FROM catalog.source_override"
ONE_SQL = f"SELECT {ROW_COLUMNS} FROM catalog.source_override WHERE skey=$1"
PUBLISHED_SQL = """SELECT version,item_count,change_seq,recorded_at FROM catalog.current_reference_set
    WHERE family='source_override'"""
HISTORY_SQL = """SELECT event_id,skey,action,actor_id,changes,published_seq,occurred_at FROM catalog.source_override_event
    WHERE skey=$1 ORDER BY occurred_at DESC,event_id DESC LIMIT $2"""
RECENT_SQL = """SELECT event_id,skey,action,actor_id,changes,published_seq,occurred_at FROM catalog.source_override_event
    ORDER BY occurred_at DESC,event_id DESC LIMIT $1"""

LOCK_SQL = "SELECT pg_advisory_xact_lock($1)"
INSERT_SQL = "INSERT INTO catalog.source_override(skey,category,origin,updated_by) VALUES($1,$2,'hub',$3)"
SET_SQL = "UPDATE catalog.source_override SET category=$2,status='active',updated_at=now(),updated_by=$3 WHERE skey=$1"
CLEAR_SQL = "UPDATE catalog.source_override SET status='cleared',updated_at=now(),updated_by=$2 WHERE skey=$1"
PUBLISH_SQL = "SELECT set_version,set_change_seq FROM catalog.publish_source_overrides()"
EVENT_SQL = """INSERT INTO catalog.source_override_event(skey,action,actor_id,changes,published_seq)
    VALUES($1,$2,$3,$4::jsonb,$5)"""


# ═══ input ═══════════════════════════════════════════════════════════════════════════════════════════════

class OverrideSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skey: str = Field(max_length=KEY_MAX + 20)
    category: str = Field(max_length=64)


class OverrideClear(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skey: str = Field(max_length=KEY_MAX + 20)


def invalid(message: str, *fields: str) -> HTTPException:
    return refused(422, "invalid_value", message, {"fields": list(fields)})


def key_of(value: str) -> str:
    """The key the HUB and the pipeline compare (catalog.source_override.skey): lower case, trimmed, no leading
    www. A source key is a domain or an official social account (host/account)."""
    key = re.sub(r"^www\.", "", (value or "").strip().lower())
    if not 3 <= len(key) <= KEY_MAX or "." not in key or CONTROL.search(key):
        raise invalid("A source key is the domain (or social account) as the list shows it", "skey")
    return key


# ═══ view ════════════════════════════════════════════════════════════════════════════════════════════════

def hub_view(row) -> dict | None:
    if row is None:
        return None
    return {"category": row["category"], "note": row["note"], "status": row["status"], "origin": row["origin"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def state_of(hub, gold) -> str | None:
    """applied / pending: whether Gold applies the HUB's decision yet; upstream: Gold applies a correction the HUB
    does not have; None: nothing to compare (no correction either side, or a revert Gold already follows)."""
    gold_override = gold is not None and gold["category_src"] == 1
    if hub is None:
        return "upstream" if gold_override else None
    if hub["status"] == "active":
        return "applied" if gold_override and gold["slug"] == hub["category"] else "pending"
    return "pending" if gold_override else None


def row_view(key: str, hub, gold) -> dict:
    """One list row. category / source are what the row means now: the HUB's correction when it has an active one,
    else Gold's category and layer. gold keeps Gold's own values for the comparison."""
    active = hub is not None and hub["status"] == "active"
    layer = LAYERS.get(gold["category_src"]) if gold else None
    return {
        "skey": gold["skey"] if gold else key, "key": key,
        "domain": (gold["domain"] or gold["skey"]) if gold else key,
        "isSocial": bool(gold["is_social"]) if gold else False,
        "citations": gold["citations"] if gold else 0,
        "category": hub["category"] if active else (gold["slug"] if gold and gold["slug"] else "other"),
        "source": "override" if active else (layer or "fallback"),
        "gold": {"category": gold["slug"], "source": layer} if gold else None,
        "override": hub_view(hub),
        "state": state_of(hub, gold),
        # Gold's owned flag (dim_source.owned_brand_bit) under an active HUB correction
        "shadowsOwned": bool(active and gold and (gold["owned_brand_bit"] or 0) != 0),
    }


def published_view(row) -> dict | None:
    if row is None:
        return None
    return {"version": row["version"], "items": row["item_count"], "changeSeq": row["change_seq"], "recordedAt": row["recorded_at"]}


def event_view(row, names: dict) -> dict:
    changes = row["changes"] if isinstance(row["changes"], dict) else json.loads(row["changes"] or "{}")
    actor = str(row["actor_id"]) if row["actor_id"] else None
    return {"id": row["event_id"], "skey": row["skey"], "action": row["action"], "at": row["occurred_at"],
            "actor": names.get(actor) if actor else None, "changes": changes, "publishedSeq": row["published_seq"]}


# ═══ connections ═════════════════════════════════════════════════════════════════════════════════════════

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
            raise HTTPException(503, "The Gold import is writing the catalog; try again shortly") from None
        yield conn


@asynccontextmanager
async def reading():
    try:
        async with analytics_db.connection() as conn:
            yield conn
    except ConnectionError:
        raise HTTPException(503, "HUB data store is not configured") from None


# ═══ Gold reads (read-only; never under the catalog lock) ════════════════════════════════════════════════

async def gold_list(keys: list[str]) -> dict:
    """Gold's latest global round: categories, the round, and the source rows (see GOLD_ROWS_SQL)."""
    async with gold_db.connection() as conn:
        ctx = await Context.create(conn, QueryParams("surface=global"))
        b = SQL()
        where = gold_citations.predicate(ctx, b)
        sql = GOLD_ROWS_SQL.format(where=where, limit=b.bind(LIMIT, "int"), keys=b.bind(keys, "text[]"))
        rows = [dict(r) for r in await conn.fetch(sql, *b.args)]
        categories = [dict(r) for r in await conn.fetch(GOLD_CATEGORIES_SQL)]
    return {"asOf": ctx.selected_dates[0] if ctx.selected_dates else None, "categories": categories, "rows": rows}


async def gold_check(key: str, category: str | None) -> dict | None:
    """Before a write: the category is one of Gold's, and Gold's row for the key (None when Gold has no such source)."""
    async with gold_db.connection() as conn:
        if category is not None:
            slugs = {r["slug"] for r in await conn.fetch(GOLD_CATEGORIES_SQL)}
            if category not in slugs:
                raise invalid("The category is one of Gold's source categories", "category")
        row = await conn.fetchrow(GOLD_SOURCE_SQL, key)
    return dict(row) if row else None


# ═══ reads ═══════════════════════════════════════════════════════════════════════════════════════════════

async def listing() -> dict:
    async with reading() as conn:
        hub = {r["skey"]: r for r in await conn.fetch(HUB_ROWS_SQL)}
        published = await conn.fetchrow(PUBLISHED_SQL)
    gold = await gold_list(sorted(hub))
    by_key: dict[str, dict] = {}
    for r in gold["rows"]:
        by_key.setdefault(key_of_gold(r["skey"]), r)
    items = []
    for key, g in by_key.items():
        item = row_view(key, hub.get(key), g)
        # every top source, every active correction and every difference with Gold; a revert Gold already follows
        # is an ordinary Gold row again, listed only while it is among the top sources
        if g["in_top"] or item["source"] == "override" or item["state"] is not None:
            items.append(item)
    for key, h in hub.items():
        if key not in by_key and h["status"] == "active":
            items.append(row_view(key, h, None))
    items.sort(key=lambda i: (-i["citations"], i["key"]))
    return {"asOf": gold["asOf"], "limit": LIMIT, "categories": [{"slug": c["slug"], "name": c["name"]} for c in gold["categories"]],
            "items": items, "published": published_view(published)}


def key_of_gold(skey: str) -> str:
    return re.sub(r"^www\.", "", (skey or "").strip().lower())


async def history(skey: str | None) -> dict:
    """One source's correction and history, or the latest changes of every source (no skey)."""
    key = key_of(skey) if skey else None
    async with reading() as conn:
        row = await conn.fetchrow(ONE_SQL, key) if key else None
        events = await (conn.fetch(HISTORY_SQL, key, HISTORY_LIMIT) if key else conn.fetch(RECENT_SQL, HISTORY_LIMIT))
    names = await actors({str(e["actor_id"]) for e in events if e["actor_id"]})
    return {"skey": key, "override": hub_view(row), "history": [event_view(e, names) for e in events]}


# ═══ writes ══════════════════════════════════════════════════════════════════════════════════════════════

async def publish_and_record(conn, actor: Principal, key: str, action: str, changes: dict) -> dict | None:
    published = await conn.fetchrow(PUBLISH_SQL)
    seq = published["set_change_seq"] if published else None
    await conn.execute(EVENT_SQL, key, action, actor.user_id, json.dumps(changes, ensure_ascii=False), seq)
    return {"version": published["set_version"], "changeSeq": seq} if published else None


async def set_category(body: OverrideSet, actor: Principal) -> dict:
    """Correct a source's category (a new correction, a change, or a reverted one again). The same category as the
    active correction changes nothing."""
    key = key_of(body.skey)
    category = body.category.strip()
    gold = await gold_check(key, category)
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
