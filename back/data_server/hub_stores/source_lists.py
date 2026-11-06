"""The Admin › 인용 출처 분류 seed, official social and code table lists: what needs gold_db. Each list compares the HUB's rows with Gold's. The hub server edits the rows
(hub_server/inputs/source_lists.py)."""
from __future__ import annotations

import re

from starlette.datastructures import QueryParams

from data_server.gold_reader import citations as gold_citations
from data_server.gold_reader import db as gold_db
from data_server.gold_reader.context import SQL, Context
from data_server.hub_stores.source_overrides import reading
from shared.input_common import LAYERS, as_json, code_row, published_sql, published_view

SEED_COLUMNS = "skey,category,note,status,origin,created_at,updated_at,updated_by"
SOCIAL_COLUMNS = "account_key,display_key,domain,matchers,note,status,origin,created_at,updated_at,updated_by"
CODE_COLUMNS = "kind,code,number,name_en,name_ko,ord,description,updated_at,updated_by"
HIGHER_LAYERS = (1, 2, 3)  # correction, official social, owned: they decide before a seed (dim_source.category_src)


# Gold: the given sources and every source at `layer`, with their citations in the latest global round.
GOLD_SOURCES_SQL = """WITH a AS (SELECT f.source_key,count(*)::int AS citations FROM gold.citation_fact f
        WHERE {where} AND f.source_key<>0 GROUP BY f.source_key)
    SELECT s.skey,s.category_src,c.slug,coalesce(a.citations,0)::int AS citations
    FROM gold.dim_source s LEFT JOIN a USING(source_key) LEFT JOIN gold.dim_category c ON c.category_key=s.category_key
    WHERE s.source_key<>0 AND (s.category_src={layer} OR regexp_replace(lower(s.skey),'^www\\.','')=ANY({keys}))"""


GOLD_CATEGORIES_SQL = "SELECT slug,name,ord FROM gold.dim_category WHERE coalesce(slug,'')<>''"


def gold_view(g, with_category: bool = True) -> dict | None:
    if g is None:
        return None
    view = {"source": LAYERS.get(g["category_src"]), "citations": g["citations"]}
    if with_category:
        view["category"] = g["slug"]
    return view


def seed_state(hub, gold) -> str | None:
    if hub is None:
        return "upstream" if gold is not None and gold["category_src"] == 4 else None
    if gold is None:
        return None
    if hub["status"] == "removed":
        return "pending" if gold["category_src"] == 4 else None
    if gold["category_src"] == 4:
        return "applied" if gold["slug"] == hub["category"] else "pending"
    return "shadowed" if gold["category_src"] in HIGHER_LAYERS else "pending"


def seed_view(key: str, hub, gold) -> dict:
    return {"skey": key, "category": hub["category"] if hub else None, "note": hub["note"] if hub else None,
            "status": hub["status"] if hub else None, "origin": hub["origin"] if hub else None,
            "updatedAt": hub["updated_at"] if hub else None, "gold": gold_view(gold), "state": seed_state(hub, gold)}


def social_state(hub, gold) -> str | None:
    if hub is None:
        return "upstream" if gold is not None and gold["category_src"] == 2 else None
    if gold is None:
        return None
    if hub["status"] == "stopped":
        return "pending" if gold["category_src"] == 2 else None
    return "applied" if gold["category_src"] == 2 else "pending"


def social_view(key: str, hub, gold, gold_key: str | None = None) -> dict:
    display = hub["display_key"] if hub else (gold_key or key)
    return {"key": display, "accountKey": key, "domain": hub["domain"] if hub else display.split("/")[0].lower(),
            "matchers": as_json(hub["matchers"]) if hub else [], "note": hub["note"] if hub else None,
            "status": hub["status"] if hub else None, "origin": hub["origin"] if hub else None,
            "updatedAt": hub["updated_at"] if hub else None, "gold": gold_view(gold, with_category=False),
            "state": social_state(hub, gold)}


def gold_key(skey: str) -> str:
    return re.sub(r"^www\.", "", (skey or "").strip().lower())


async def gold_sources(layer: int, keys: list[str]) -> tuple[str | None, dict]:
    """The latest global round's date and {key: Gold row} for the keys and every source at `layer`."""
    async with gold_db.connection() as conn:
        ctx = await Context.create(conn, QueryParams("surface=global"))
        b = SQL()
        where = gold_citations.predicate(ctx, b)
        sql = GOLD_SOURCES_SQL.format(where=where, layer=int(layer), keys=b.bind(keys, "text[]"))
        rows = [dict(r) for r in await conn.fetch(sql, *b.args)]
    found: dict[str, dict] = {}
    for r in rows:
        found.setdefault(gold_key(r["skey"]), r)
    return (ctx.selected_dates[0] if ctx.selected_dates else None), found


async def gold_categories() -> dict:
    async with gold_db.connection() as conn:
        return {r["slug"]: dict(r) for r in await conn.fetch(GOLD_CATEGORIES_SQL)}


async def seeds() -> dict:
    async with reading() as conn:
        hub = {r["skey"]: r for r in await conn.fetch(f"SELECT {SEED_COLUMNS} FROM catalog.source_seed")}
        categories = await conn.fetch("SELECT code,name_en FROM catalog.source_code WHERE kind='category' ORDER BY ord,number")
        published = await conn.fetchrow(published_sql("source_seed"))
    as_of, gold = await gold_sources(4, sorted(hub))
    items = [seed_view(key, h, gold.get(key)) for key, h in hub.items()]
    items += [seed_view(key, None, g) for key, g in gold.items() if key not in hub and g["category_src"] == 4]
    items.sort(key=lambda i: (-(i["gold"] or {}).get("citations", 0), i["skey"]))
    return {"asOf": as_of, "categories": [{"slug": c["code"], "name": c["name_en"]} for c in categories],
            "items": items, "published": published_view(published)}


async def socials() -> dict:
    async with reading() as conn:
        hub = {r["account_key"]: r for r in await conn.fetch(f"SELECT {SOCIAL_COLUMNS} FROM catalog.source_social")}
        published = await conn.fetchrow(published_sql("source_social"))
    as_of, gold = await gold_sources(2, sorted(hub))
    items = [social_view(key, h, gold.get(key)) for key, h in hub.items()]
    items += [social_view(key, None, g, g["skey"]) for key, g in gold.items() if key not in hub and g["category_src"] == 2]
    items.sort(key=lambda i: (-(i["gold"] or {}).get("citations", 0), i["accountKey"]))
    return {"asOf": as_of, "items": items, "published": published_view(published)}


async def codes() -> dict:
    async with reading() as conn:
        rows = await conn.fetch(f"SELECT {CODE_COLUMNS} FROM catalog.source_code ORDER BY kind,ord,number")
        published = await conn.fetchrow(published_sql("source_code"))
    gold = await gold_categories()
    return {"categories": [code_row(r, gold, compare=True) for r in rows if r["kind"] == "category"],
            "layers": sorted((code_row(r) for r in rows if r["kind"] == "layer"), key=lambda r: r["number"]),
            "published": published_view(published)}
