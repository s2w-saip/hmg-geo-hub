"""Seeds, official social accounts and the code table on the renewal Admin › 인용 출처 분류 screen (2026-10-30).

The rest of the source classification inputs the HUB owns, next to the corrections of source_overrides.py
(docs/handoff/admin-todo.md, decisions 코드표 · G · '2 남은 범위'): the curated seed domains, the official HMG social
accounts with their URL matchers, and the code table (categories, tied to Gold dim_category and answer_fact.cit_c<k>,
and the classification layers of dim_source.category_src). Gold only holds their results, so every list is shown
next to what Gold applies now and `state` compares the two (a comparison of values, not a judgment):
- seed: applied (Gold's layer is seed with the same category) · shadowed (a higher layer decides: correction, official
  social, owned) · pending (Gold has the source otherwise) · upstream (Gold's seed the HUB does not have) · None.
- social: applied (Gold has the account at layer social) · pending · upstream · None (Gold has no such source).
- category: applied (Gold's name and order equal the HUB's) · pending.
Code rows are only imported (manage.py import-source-lists); the screen changes names, description and the category
order, never adds or removes one.

Writes use the 인용 출처 분류 role (hmg_source_override_editor, the pool of source_overrides.py) under the catalog lock,
record an event row and publish the list (source_seed / source_social / source_code, source hub_edit) when it changed."""
from __future__ import annotations

import json
import re

from pydantic import BaseModel, ConfigDict, Field
from starlette.datastructures import QueryParams

from bff.gold_reader import citations as gold_citations
from bff.gold_reader import db as gold_db
from bff.gold_reader.context import SQL, Context
from bff.hub_stores.catalog_editor import actors, refused
from bff.hub_stores.hub_auth import Principal
from bff.hub_stores.source_overrides import CONTROL, KEY_MAX, LAYERS, invalid, published_view, reading, writing

HISTORY_LIMIT = 100
MATCHERS_MAX = 10
NAME_MAX = 80
DESCRIPTION_MAX = 500
HIGHER_LAYERS = (1, 2, 3)  # correction, official social, owned: they decide before a seed (dim_source.category_src)

# ═══ SQL ═════════════════════════════════════════════════════════════════════════════════════════════════

# Gold: the given sources and every source at `layer`, with their citations in the latest global round.
GOLD_SOURCES_SQL = """WITH a AS (SELECT f.source_key,count(*)::int AS citations FROM gold.citation_fact f
        WHERE {where} AND f.source_key<>0 GROUP BY f.source_key)
    SELECT s.skey,s.category_src,c.slug,coalesce(a.citations,0)::int AS citations
    FROM gold.dim_source s LEFT JOIN a USING(source_key) LEFT JOIN gold.dim_category c ON c.category_key=s.category_key
    WHERE s.source_key<>0 AND (s.category_src={layer} OR regexp_replace(lower(s.skey),'^www\\.','')=ANY({keys}))"""
GOLD_CATEGORIES_SQL = "SELECT slug,name,ord FROM gold.dim_category WHERE coalesce(slug,'')<>''"

SEED_COLUMNS = "skey,category,note,status,origin,created_at,updated_at,updated_by"
SOCIAL_COLUMNS = "account_key,display_key,domain,matchers,note,status,origin,created_at,updated_at,updated_by"
CODE_COLUMNS = "kind,code,number,name_en,name_ko,ord,description,updated_at,updated_by"


def published_sql(family: str) -> str:
    return f"""SELECT version,item_count,change_seq,recorded_at FROM catalog.current_reference_set WHERE family='{family}'"""


def history_sql(table: str, where: str) -> str:
    return f"""SELECT * FROM catalog.{table}_event {where} ORDER BY occurred_at DESC,event_id DESC LIMIT {HISTORY_LIMIT}"""


# ═══ input ═══════════════════════════════════════════════════════════════════════════════════════════════

class SeedSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skey: str = Field(max_length=KEY_MAX + 20)
    category: str = Field(max_length=64)


class SeedKey(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skey: str = Field(max_length=KEY_MAX + 20)


class Matcher(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prefix: str = Field(max_length=KEY_MAX + 20)
    boundary: bool


class SocialSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(max_length=KEY_MAX + 20)
    matchers: list[Matcher] = Field(min_length=1, max_length=MATCHERS_MAX)


class SocialKey(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(max_length=KEY_MAX + 20)


class CodeSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = Field(pattern="^(category|layer)$")
    code: str = Field(max_length=64)
    nameEn: str = Field(max_length=NAME_MAX + 20)
    nameKo: str = Field(max_length=NAME_MAX + 20)
    description: str | None = Field(default=None, max_length=DESCRIPTION_MAX + 20)


class CodeOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")
    codes: list[str] = Field(min_length=1, max_length=99)


def seed_key(value: str) -> str:
    """A seed is a domain: lower case, trimmed, no leading www., a dot, no slash (catalog.source_seed.skey)."""
    key = re.sub(r"^www\.", "", (value or "").strip().lower())
    if not 3 <= len(key) <= KEY_MAX or "." not in key or "/" in key or CONTROL.search(key):
        raise invalid("A seed is a domain such as example.com (no path)", "skey")
    return key


def social_key(value: str) -> tuple[str, str, str]:
    """An official social account: `<domain>/<path>` as shown (case kept) → (display key, account key, domain)."""
    display = (value or "").strip()
    domain, _, path = display.partition("/")
    domain = domain.lower()
    if (not 5 <= len(display) <= KEY_MAX or not path or "." not in domain or domain.startswith("www.")
            or CONTROL.search(display)):
        raise invalid("An account is the domain and the account path, such as instagram.com/hyundai", "key")
    return display, display.lower(), domain


def clean_matchers(domain: str, matchers: list[Matcher]) -> list[dict]:
    out, seen = [], set()
    for i, m in enumerate(matchers):
        prefix = m.prefix.strip()
        if (prefix != prefix.lower() or not prefix.startswith(domain + "/") or len(prefix) > KEY_MAX
                or len(prefix) <= len(domain) + 1 or CONTROL.search(prefix) or prefix in seen):
            raise invalid(f"Matcher {i + 1}: a lower-case URL prefix that starts with {domain}/, once", f"matchers.{i}.prefix")
        seen.add(prefix)
        out.append({"prefix": prefix, "boundary": m.boundary})
    return out


def clean_name(value: str, field: str) -> str:
    name = (value or "").strip()
    if not 1 <= len(name) <= NAME_MAX or re.search(r"[\x00-\x1f\x7f]", name):
        raise invalid(f"A name of 1 to {NAME_MAX} characters on one line", field)
    return name


def clean_description(value: str | None) -> str | None:
    text = (value or "").strip()
    if len(text) > DESCRIPTION_MAX or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
        raise invalid(f"A description of up to {DESCRIPTION_MAX} characters", "description")
    return text or None


# ═══ views ═══════════════════════════════════════════════════════════════════════════════════════════════

def as_json(value):
    return json.loads(value) if isinstance(value, str) else value


def event_view(row, names: dict, key_field: str) -> dict:
    actor = str(row["actor_id"]) if row["actor_id"] else None
    return {"id": row["event_id"], "key": row[key_field] if key_field != "code" else f"{row['kind']}:{row['code']}",
            "action": row["action"], "at": row["occurred_at"], "actor": names.get(actor) if actor else None,
            "changes": as_json(row["changes"]) or {}, "publishedSeq": row["published_seq"]}


async def events_view(rows, key_field: str) -> list[dict]:
    names = await actors({str(e["actor_id"]) for e in rows if e["actor_id"]})
    return [event_view(e, names, key_field) for e in rows]


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


def seed_row(row) -> dict | None:
    if row is None:
        return None
    return {"skey": row["skey"], "category": row["category"], "note": row["note"], "status": row["status"],
            "origin": row["origin"], "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


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


def social_row(row) -> dict | None:
    if row is None:
        return None
    return {"key": row["display_key"], "accountKey": row["account_key"], "domain": row["domain"],
            "matchers": as_json(row["matchers"]), "note": row["note"], "status": row["status"], "origin": row["origin"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def code_row(row, gold: dict | None = None, compare: bool = False) -> dict:
    view = {"code": row["code"], "number": row["number"], "nameEn": row["name_en"], "nameKo": row["name_ko"],
            "ord": row["ord"], "description": row["description"], "updatedAt": row["updated_at"]}
    if compare:
        g = (gold or {}).get(row["code"])
        view["gold"] = {"name": g["name"], "ord": g["ord"]} if g else None
        view["state"] = "applied" if g and g["name"] == row["name_en"] and g["ord"] == row["ord"] else "pending"
    return view


# ═══ Gold reads (read-only; never under the catalog lock) ════════════════════════════════════════════════

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


# ═══ seeds ═══════════════════════════════════════════════════════════════════════════════════════════════

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


async def seed_history(skey: str | None) -> dict:
    key = seed_key(skey) if skey else None
    async with reading() as conn:
        row = await conn.fetchrow(f"SELECT {SEED_COLUMNS} FROM catalog.source_seed WHERE skey=$1", key) if key else None
        events = await (conn.fetch(history_sql("source_seed", "WHERE skey=$1"), key) if key
                        else conn.fetch(history_sql("source_seed", "")))
    return {"skey": key, "seed": seed_row(row), "history": await events_view(events, "skey")}


async def publish(conn, function: str) -> dict | None:
    published = await conn.fetchrow(f"SELECT set_version,set_change_seq FROM catalog.{function}()")
    return {"version": published["set_version"], "changeSeq": published["set_change_seq"]} if published else None


async def record(conn, table: str, key_columns: tuple[str, ...], keys: tuple, actor: Principal, action: str,
                 changes: dict, published: dict | None):
    cols = ",".join(key_columns)
    marks = ",".join(f"${i}" for i in range(1, len(keys) + 1))
    n = len(keys)
    await conn.execute(f"INSERT INTO catalog.{table}_event({cols},action,actor_id,changes,published_seq) "
                       f"VALUES({marks},${n + 1},${n + 2},${n + 3}::jsonb,${n + 4})",
                       *keys, action, actor.user_id, json.dumps(changes, ensure_ascii=False),
                       published["changeSeq"] if published else None)


async def set_seed(body: SeedSet, actor: Principal) -> dict:
    """Add a seed, change its category, or restore a removed one. The active seed's own category changes nothing."""
    key = seed_key(body.skey)
    category = body.category.strip()
    published = None
    async with writing() as conn:
        if not await conn.fetchval("SELECT EXISTS(SELECT 1 FROM catalog.source_code WHERE kind='category' AND code=$1)", category):
            raise invalid("The category is one of the code table's categories", "category")
        row = await conn.fetchrow(f"SELECT {SEED_COLUMNS} FROM catalog.source_seed WHERE skey=$1", key)
        if row is None:
            await conn.execute("INSERT INTO catalog.source_seed(skey,category,origin,updated_by) VALUES($1,$2,'hub',$3)",
                               key, category, actor.user_id)
            published = await publish(conn, "publish_source_seeds")
            await record(conn, "source_seed", ("skey",), (key,), actor, "add", {"category": [None, category]}, published)
        elif row["status"] != "active" or row["category"] != category:
            changes = {}
            if row["category"] != category:
                changes["category"] = [row["category"], category]
            if row["status"] != "active":
                changes["status"] = [row["status"], "active"]
            await conn.execute("UPDATE catalog.source_seed SET category=$2,status='active',updated_at=now(),updated_by=$3 WHERE skey=$1",
                               key, category, actor.user_id)
            published = await publish(conn, "publish_source_seeds")
            await record(conn, "source_seed", ("skey",), (key,), actor, "set", changes, published)
        row = await conn.fetchrow(f"SELECT {SEED_COLUMNS} FROM catalog.source_seed WHERE skey=$1", key)
    return {"skey": key, "seed": seed_row(row), "published": published}


async def remove_seed(body: SeedKey, actor: Principal) -> dict:
    """Take a seed out of the list: the row stays (status removed) and leaves the published list."""
    key = seed_key(body.skey)
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(f"SELECT {SEED_COLUMNS} FROM catalog.source_seed WHERE skey=$1", key)
        if row is None:
            raise refused(404, "not_found", "The HUB has no such seed")
        if row["status"] == "active":
            await conn.execute("UPDATE catalog.source_seed SET status='removed',updated_at=now(),updated_by=$2 WHERE skey=$1",
                               key, actor.user_id)
            published = await publish(conn, "publish_source_seeds")
            await record(conn, "source_seed", ("skey",), (key,), actor, "remove", {"status": ["active", "removed"]}, published)
        row = await conn.fetchrow(f"SELECT {SEED_COLUMNS} FROM catalog.source_seed WHERE skey=$1", key)
    return {"skey": key, "seed": seed_row(row), "published": published}


# ═══ official social accounts ════════════════════════════════════════════════════════════════════════════

async def socials() -> dict:
    async with reading() as conn:
        hub = {r["account_key"]: r for r in await conn.fetch(f"SELECT {SOCIAL_COLUMNS} FROM catalog.source_social")}
        published = await conn.fetchrow(published_sql("source_social"))
    as_of, gold = await gold_sources(2, sorted(hub))
    items = [social_view(key, h, gold.get(key)) for key, h in hub.items()]
    items += [social_view(key, None, g, g["skey"]) for key, g in gold.items() if key not in hub and g["category_src"] == 2]
    items.sort(key=lambda i: (-(i["gold"] or {}).get("citations", 0), i["accountKey"]))
    return {"asOf": as_of, "items": items, "published": published_view(published)}


async def social_history(key: str | None) -> dict:
    account = social_key(key)[1] if key else None
    async with reading() as conn:
        row = await conn.fetchrow(f"SELECT {SOCIAL_COLUMNS} FROM catalog.source_social WHERE account_key=$1", account) if account else None
        events = await (conn.fetch(history_sql("source_social", "WHERE account_key=$1"), account) if account
                        else conn.fetch(history_sql("source_social", "")))
    return {"key": row["display_key"] if row else key, "account": social_row(row), "history": await events_view(events, "account_key")}


async def set_social(body: SocialSet, actor: Principal) -> dict:
    """Add an account, or replace the matchers of one (its status stays). The same matchers change nothing."""
    display, account, domain = social_key(body.key)
    matchers = clean_matchers(domain, body.matchers)
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(f"SELECT {SOCIAL_COLUMNS} FROM catalog.source_social WHERE account_key=$1", account)
        if row is None:
            await conn.execute("""INSERT INTO catalog.source_social(account_key,display_key,domain,matchers,origin,updated_by)
                VALUES($1,$2,$3,$4::jsonb,'hub',$5)""", account, display, domain, json.dumps(matchers), actor.user_id)
            published = await publish(conn, "publish_source_socials")
            await record(conn, "source_social", ("account_key",), (account,), actor, "add", {"matchers": [None, matchers]}, published)
        elif as_json(row["matchers"]) != matchers:
            await conn.execute("UPDATE catalog.source_social SET matchers=$2::jsonb,updated_at=now(),updated_by=$3 WHERE account_key=$1",
                               account, json.dumps(matchers), actor.user_id)
            published = await publish(conn, "publish_source_socials")
            await record(conn, "source_social", ("account_key",), (account,), actor, "set",
                         {"matchers": [as_json(row["matchers"]), matchers]}, published)
        row = await conn.fetchrow(f"SELECT {SOCIAL_COLUMNS} FROM catalog.source_social WHERE account_key=$1", account)
    return {"key": row["display_key"], "account": social_row(row), "published": published}


async def set_social_status(body: SocialKey, stop: bool, actor: Principal) -> dict:
    """Stop an account (it leaves the published list) or resume it. The same status changes nothing."""
    account = social_key(body.key)[1]
    want = "stopped" if stop else "active"
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(f"SELECT {SOCIAL_COLUMNS} FROM catalog.source_social WHERE account_key=$1", account)
        if row is None:
            raise refused(404, "not_found", "The HUB has no such account")
        if row["status"] != want:
            await conn.execute("UPDATE catalog.source_social SET status=$2,updated_at=now(),updated_by=$3 WHERE account_key=$1",
                               account, want, actor.user_id)
            published = await publish(conn, "publish_source_socials")
            await record(conn, "source_social", ("account_key",), (account,), actor, "stop" if stop else "resume",
                         {"status": [row["status"], want]}, published)
        row = await conn.fetchrow(f"SELECT {SOCIAL_COLUMNS} FROM catalog.source_social WHERE account_key=$1", account)
    return {"key": row["display_key"], "account": social_row(row), "published": published}


# ═══ code table ══════════════════════════════════════════════════════════════════════════════════════════

async def codes() -> dict:
    async with reading() as conn:
        rows = await conn.fetch(f"SELECT {CODE_COLUMNS} FROM catalog.source_code ORDER BY kind,ord,number")
        published = await conn.fetchrow(published_sql("source_code"))
    gold = await gold_categories()
    return {"categories": [code_row(r, gold, compare=True) for r in rows if r["kind"] == "category"],
            "layers": sorted((code_row(r) for r in rows if r["kind"] == "layer"), key=lambda r: r["number"]),
            "published": published_view(published)}


async def code_history(kind: str | None, code: str | None) -> dict:
    if kind not in (None, "category", "layer") or (code and not re.fullmatch(r"[a-z][A-Za-z0-9]{0,63}", code)):
        raise invalid("kind is category or layer, code a code-table code", "kind")
    async with reading() as conn:
        events = await (conn.fetch(history_sql("source_code", "WHERE kind=$1 AND code=$2"), kind, code) if kind and code
                        else conn.fetch(history_sql("source_code", "")))
    return {"kind": kind, "code": code, "history": await events_view(events, "code")}


async def set_code(body: CodeSet, actor: Principal) -> dict:
    """Change a code's names and description. A code is never added or removed here."""
    new = {"name_en": clean_name(body.nameEn, "nameEn"), "name_ko": clean_name(body.nameKo, "nameKo"),
           "description": clean_description(body.description)}
    published = None
    async with writing() as conn:
        row = await conn.fetchrow(f"SELECT {CODE_COLUMNS} FROM catalog.source_code WHERE kind=$1 AND code=$2", body.kind, body.code)
        if row is None:
            raise refused(404, "not_found", "The code table has no such code")
        changes = {k: [row[k], v] for k, v in new.items() if row[k] != v}
        if changes:
            await conn.execute("""UPDATE catalog.source_code SET name_en=$3,name_ko=$4,description=$5,updated_at=now(),updated_by=$6
                WHERE kind=$1 AND code=$2""", body.kind, body.code, new["name_en"], new["name_ko"], new["description"], actor.user_id)
            published = await publish(conn, "publish_source_codes")
            await record(conn, "source_code", ("kind", "code"), (body.kind, body.code), actor, "set", changes, published)
        row = await conn.fetchrow(f"SELECT {CODE_COLUMNS} FROM catalog.source_code WHERE kind=$1 AND code=$2", body.kind, body.code)
    return {"kind": body.kind, "code": body.code, "row": code_row(row), "published": published}


async def order_codes(body: CodeOrder, actor: Principal) -> dict:
    """Set the category order: the list names every category once; ord = position + 1."""
    published = None
    async with writing() as conn:
        rows = {r["code"]: r for r in await conn.fetch(f"SELECT {CODE_COLUMNS} FROM catalog.source_code WHERE kind='category'")}
        if sorted(body.codes) != sorted(rows) or len(set(body.codes)) != len(body.codes):
            raise invalid("The order lists every category code exactly once", "codes")
        moved = [(code, rows[code]["ord"], i) for i, code in enumerate(body.codes, 1) if rows[code]["ord"] != i]
        for code, _, ord_ in moved:
            await conn.execute("UPDATE catalog.source_code SET ord=$2,updated_at=now(),updated_by=$3 WHERE kind='category' AND code=$1",
                               code, ord_, actor.user_id)
        if moved:
            published = await publish(conn, "publish_source_codes")
            for code, before, after in moved:
                await record(conn, "source_code", ("kind", "code"), ("category", code), actor, "order", {"ord": [before, after]}, published)
        rows = await conn.fetch(f"SELECT {CODE_COLUMNS} FROM catalog.source_code WHERE kind='category' ORDER BY ord,number")
    return {"categories": [code_row(r) for r in rows], "published": published}
