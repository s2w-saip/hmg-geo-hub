"""The Admin › 엔티티 카탈로그 list, one entity's mentions, and the check before a role is saved: what needs gold_db. Gold is the list of entities; the HUB's roles are shown next to
Gold's. The hub server edits the roles (hub_server/inputs/entity_roles.py) and asks this server for the check."""
from __future__ import annotations

import uuid

from starlette.datastructures import QueryParams

from data_server.gold_reader import db as gold_db
from data_server.gold_reader.context import SQL, Context
from data_server.hub_stores.source_overrides import reading
from shared.errors import refused
from shared.input_common import entity_key, entity_role_view as hub_view, gold_own_brand, published_sql, published_view

ROW_COLUMNS = "entity_id,rep_name,role,brand,note,status,origin,created_at,updated_at,updated_by"
SAMPLE_ROUNDS = 8     # the latest global rounds the samples are read from
SAMPLE_KEYS = 2000    # the display brand's latest answers searched for this entity's occurrences
SAMPLE_LIMIT = 8
SURFACE_LIMIT = 12
KINDS = {1: "own", 2: "competitor", 3: "nonCompetitor"}  # gold.dim_brand.kind (0 = no name)


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


def state_of(hub, gold) -> str | None:
    gold_role = gold["registry_role"] if gold else None
    if hub is None:
        return "upstream" if gold_role else None
    if hub["status"] != "active":
        return "pending" if gold_role else None
    same = gold_role == hub["role"] and (hub["role"] != "own" or gold_own_brand(gold) == hub["brand"])
    return "applied" if same else "pending"


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


async def gold_rows(keys: list[uuid.UUID]) -> dict[str, dict]:
    async with gold_db.connection() as conn:
        rows = await conn.fetch(GOLD_ROWS_SQL, keys)
    return {str(r["entity_id"]): dict(r) for r in rows}


async def gold_entity(key: uuid.UUID) -> dict | None:
    async with gold_db.connection() as conn:
        row = await conn.fetchrow(GOLD_ENTITY_SQL, key)
    return dict(row) if row else None


async def listing() -> dict:
    async with reading() as conn:
        hub = {str(r["entity_id"]): r for r in await conn.fetch(f"SELECT {ROW_COLUMNS} FROM catalog.entity_role")}
        published = await conn.fetchrow(published_sql("entity_role"))
    gold = await gold_rows([uuid.UUID(k) for k in hub])
    items = [row_view(k, hub.get(k), g) for k, g in gold.items()]
    items += [row_view(k, h, None) for k, h in hub.items() if k not in gold]
    items.sort(key=lambda i: (-i["answers"], i["name"], i["entityId"]))
    return {"items": items, "published": published_view(published)}


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
