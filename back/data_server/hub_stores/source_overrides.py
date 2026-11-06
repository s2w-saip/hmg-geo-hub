"""The Admin › 인용 출처 분류 list and the check before a correction is saved: what needs gold_db. The list is Gold's latest global round: its 500 most cited sources, every
source the HUB corrected and every source Gold applies a correction to, each with Gold's category and classification layer as Gold has them. The hub server edits the corrections
(hub_server/inputs/source_overrides.py) and asks this server for the check."""
from __future__ import annotations

import re
from contextlib import asynccontextmanager

from fastapi import HTTPException
from starlette.datastructures import QueryParams

from data_server.gold_reader import citations as gold_citations
from data_server.gold_reader import db as gold_db
from data_server.gold_reader.context import SQL, Context
from data_server.hub_stores import input_db
from shared.input_common import LAYERS, invalid, override_view as hub_view, published_view

ROW_COLUMNS = "skey,category,note,status,origin,created_at,updated_at,updated_by"
LIMIT = 500                # the most cited sources listed (as the original screen)


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


HUB_ROWS_SQL = f"SELECT {ROW_COLUMNS} FROM catalog.source_override"


PUBLISHED_SQL = """SELECT version,item_count,change_seq,recorded_at FROM catalog.current_reference_set
    WHERE family='source_override'"""


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


@asynccontextmanager
async def reading():
    try:
        async with input_db.connection() as conn:
            yield conn
    except ConnectionError:
        raise HTTPException(503, "HUB input store is not configured") from None


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
