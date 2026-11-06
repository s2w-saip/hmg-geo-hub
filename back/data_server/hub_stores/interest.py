"""The Admin › 고객 관심 데이터 lists: what needs gold_db. Each list compares the HUB's rows with Gold's seed rows and social snapshot. The hub server edits the rows
(hub_server/inputs/interest.py)."""
from __future__ import annotations

from data_server.gold_reader import db as gold_db
from data_server.hub_stores.source_overrides import reading
from shared.input_common import as_json, host_of, published_sql, published_view

KEYWORD_COLUMNS = "term_norm,term,conditions,source_types,brands,note,status,origin,created_at,updated_at,updated_by"
SOURCE_COLUMNS = "source_key,url,channel,brands,note,status,created_at,updated_at,updated_by"


# Gold: the seed rows of the keyword collections (the reference family `keyword`), one row per term and condition.
GOLD_SEEDS_SQL = """SELECT k.term,k.term_norm,s.location_code,s.language_code,max(s.observed_at) AS observed_at
    FROM gold.kw_suggestion s JOIN gold.dim_keyword k ON k.kw_key=s.kw_key WHERE s.is_seed
    GROUP BY k.term,k.term_norm,s.location_code,s.language_code"""


# Gold: the active social snapshot (gold_reader.insights.social picks it the same way) and its hosts, without www., each
# with Gold's source category when dim_source has exactly that host (a subdomain does not take its parent's: kin.naver.com
# would read as naver.com's automotive media). Gold keeps no channel per host.
GOLD_SNAPSHOT_SQL = """SELECT snapshot_id,taken_at,source_total FROM gold.ctx_snapshot ORDER BY is_active DESC,taken_at DESC,snapshot_id DESC LIMIT 1"""


GOLD_HOSTS_SQL = """SELECT d.host,count(DISTINCT d.entity_id)::int AS entities,sum(d.n)::int AS mentions,max(c.slug) AS category FROM (
        SELECT regexp_replace(lower(host),'^www\\.','') AS host,entity_id,n FROM gold.ctx_domain WHERE snapshot_id=$1) d
    LEFT JOIN gold.dim_source s ON s.skey=d.host LEFT JOIN gold.dim_category c ON c.category_key=s.category_key
    GROUP BY d.host"""


def gold_keyword(rows: list[dict]) -> dict | None:
    if not rows:
        return None
    conditions = sorted(rows, key=lambda r: (r["location_code"], r["language_code"]))
    return {"conditions": [{"location_code": r["location_code"], "language_code": r["language_code"], "observedAt": r["observed_at"]}
                           for r in conditions],
            "observedAt": max(r["observed_at"] for r in rows)}


def collected(conditions: list[dict], rows: list[dict]) -> int:
    """How many of the conditions Gold's seed rows hold."""
    seen = {(r["location_code"], r["language_code"]) for r in rows}
    return sum((c["location_code"], c["language_code"]) in seen for c in conditions)


def keyword_state(hub, rows: list[dict]) -> str | None:
    if hub is None:
        return "upstream" if rows else None
    if hub["status"] != "active":
        return None
    conditions = as_json(hub["conditions"])
    return "applied" if collected(conditions, rows) == len(conditions) else "pending"


def keyword_view(term_norm: str, hub, rows: list[dict]) -> dict:
    """One list row. A Gold seed the HUB does not have carries Gold's own term and conditions, to take over."""
    conditions = as_json(hub["conditions"]) if hub else [{"location_code": r["location_code"], "language_code": r["language_code"]}
                                                         for r in sorted(rows, key=lambda r: (r["location_code"], r["language_code"]))]
    return {"term": hub["term"] if hub else rows[0]["term"], "termNorm": term_norm, "conditions": conditions,
            "sourceTypes": list(hub["source_types"]) if hub else [], "brands": list(hub["brands"]) if hub else [],
            "note": hub["note"] if hub else None, "status": hub["status"] if hub else None, "origin": hub["origin"] if hub else None,
            "updatedAt": hub["updated_at"] if hub else None, "gold": gold_keyword(rows), "collected": collected(conditions, rows),
            "state": keyword_state(hub, rows)}


def source_state(hub, gold) -> str | None:
    if hub is None:
        return "upstream" if gold is not None else None
    return "observed" if gold is not None else "unseen"


def source_view(key: str, hub, gold) -> dict:
    return {"key": key, "url": hub["url"] if hub else key, "host": host_of(key), "channel": hub["channel"] if hub else None,
            "brands": list(hub["brands"]) if hub else [], "note": hub["note"] if hub else None,
            "status": hub["status"] if hub else None, "updatedAt": hub["updated_at"] if hub else None,
            "gold": {"entities": gold["entities"], "mentions": gold["mentions"], "category": gold["category"]} if gold else None,
            "state": source_state(hub, gold)}


async def gold_seeds() -> dict[str, list[dict]]:
    """{term_norm: its seed rows}."""
    async with gold_db.connection() as conn:
        rows = [dict(r) for r in await conn.fetch(GOLD_SEEDS_SQL)]
    found: dict[str, list[dict]] = {}
    for r in rows:
        found.setdefault(r["term_norm"], []).append(r)
    return found


async def gold_hosts() -> tuple[dict | None, dict[str, dict]]:
    """The active snapshot as Gold states it (date, source count) and {host: its counts}."""
    async with gold_db.connection() as conn:
        snapshot = await conn.fetchrow(GOLD_SNAPSHOT_SQL)
        rows = await conn.fetch(GOLD_HOSTS_SQL, snapshot["snapshot_id"]) if snapshot else []
    view = {"takenAt": snapshot["taken_at"], "sources": snapshot["source_total"]} if snapshot else None
    return view, {r["host"]: dict(r) for r in rows}


async def keywords() -> dict:
    async with reading() as conn:
        hub = {r["term_norm"]: r for r in await conn.fetch(f"SELECT {KEYWORD_COLUMNS} FROM catalog.interest_keyword")}
        published = await conn.fetchrow(published_sql("interest_keyword"))
    gold = await gold_seeds()
    items = [keyword_view(k, h, gold.get(k, [])) for k, h in hub.items()]
    items += [keyword_view(k, None, rows) for k, rows in gold.items() if k not in hub]
    items.sort(key=lambda i: i["termNorm"])
    return {"items": items, "published": published_view(published)}


async def sources() -> dict:
    async with reading() as conn:
        hub = {r["source_key"]: r for r in await conn.fetch(f"SELECT {SOURCE_COLUMNS} FROM catalog.interest_source")}
        published = await conn.fetchrow(published_sql("interest_source"))
    snapshot, gold = await gold_hosts()
    items = [source_view(k, h, gold.get(host_of(k))) for k, h in hub.items()]
    registered = {host_of(k) for k in hub}
    items += [source_view(host, None, g) for host, g in gold.items() if host not in registered]
    items.sort(key=lambda i: (-(i["gold"] or {}).get("mentions", 0), i["key"]))
    return {"snapshot": snapshot, "items": items, "published": published_view(published)}
