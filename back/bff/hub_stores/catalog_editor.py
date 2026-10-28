"""Global prompts in the HUB data catalog, managed by the top-level administrator (2026-10-27).

HUB-owned prompts (origin=hub) are created, edited, archived and restored here. Gold-imported ones are
listed read-only: sync_catalog.py records the Gold definition again over any HUB revision of them.
Every change is one more catalog.prompt_version row written by the INSERT-only editor role
(HGH_CATALOG_EDITOR_DB_URL); an archive is a revision with status=archived, so ids and history stay.
A write names the version it was made against and a stale one is refused with 409 (the revision
primary key is the last guard). Codes must be Gold's: the taxonomy fields take the codes of the taxonomy the
last Gold import recorded (catalog.current_reference, family taxon; Gold itself is never called while the
catalog lock is held), and depth2/depth3 must sit under the depth1/depth2 chosen with them. Language and
markets take the ones the Global catalog already uses. A Gold prompt that left Gold is `removed` (read-only,
like every Gold prompt). HUB prompts are not measured until a measurement hand-off exists
(back/hub_storage/README.md)."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID, uuid4

import asyncpg
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from bff.hub_stores import analytics_db, operations_db
from bff.hub_stores.hub_auth import Principal

log = logging.getLogger("hgh.hub")

# API field -> definition key (the keys sync_catalog.py records for Gold prompts)
LABELS = {"funnel": "funnel", "brandPresence": "brand_presence", "listType": "list_type",
          "depth1": "depth1", "depth2": "depth2", "depth3": "depth3", "depth4": "depth4"}
# gold.dim_taxon axis -> API field (Gold has no depth4 axis)
TAXON_AXES = {"funnel": "funnel", "presence": "brandPresence", "list_type": "listType",
              "depth1": "depth1", "depth2": "depth2", "depth3": "depth3", "depth4": "depth4"}
# The taxonomy as the last Gold import recorded it; path = the ancestor codes (depth3: depth1, depth2).
TAXON_SQL = """SELECT definition->>'axis' AS axis,definition->>'code' AS code,definition->'path' AS path
    FROM catalog.current_reference WHERE family='taxon'"""
TEXT_MAX = 2000
CODE_MAX = 200
REGIONS_MAX = 300
LIST_LIMIT_MAX = 200
HISTORY_LIMIT = 100
CATALOG_LOCK = 617427413   # the Gold import's lock (sync_catalog.py): one catalog writer at a time
LOCK_TIMEOUT = "5s"        # a write waits this long for a running Gold import, then 503
STATUSES = ("active", "archived", "removed")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")

GLOBAL_PROJECT_SQL = """SELECT project_id FROM catalog.current_project
    WHERE definition->>'surface'='1' AND definition->>'is_root'='true' AND coalesce(definition->>'status','active')<>'removed'"""
CURRENT_SQL = """SELECT p.prompt_id,p.project_id,p.origin,p.registered_at,v.version,v.text,v.definition,v.sha256,v.recorded_at
    FROM catalog.prompt p JOIN LATERAL (SELECT version,text,definition,sha256,recorded_at FROM catalog.prompt_version
    WHERE prompt_id=p.prompt_id ORDER BY version DESC LIMIT 1) v ON true WHERE p.prompt_id=$1"""
VERSIONS_SQL = """SELECT version,text,definition,recorded_at,recorded_by FROM catalog.prompt_version
    WHERE prompt_id=$1 ORDER BY version DESC LIMIT $2"""
SCALARS = {"language": "language", **LABELS}
VOCABULARY_SQL = f"""SELECT k.key,k.value,count(*)::int AS n FROM catalog.current_prompt p
    CROSS JOIN LATERAL (VALUES {",".join(f"('{api}',p.definition->>'{key}')" for api, key in SCALARS.items())}) k(key,value)
    WHERE p.project_id=$1 AND k.value<>'' GROUP BY 1,2
    UNION ALL
    SELECT 'regions',r.value,count(*)::int FROM catalog.current_prompt p CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(p.definition->'regions')='array' THEN p.definition->'regions' ELSE '[]'::jsonb END) r(value)
    WHERE p.project_id=$1 AND r.value<>'' GROUP BY 2"""
DUPLICATE_SQL = """SELECT prompt_id FROM catalog.current_prompt WHERE project_id=$1 AND text=$2
    AND coalesce(lower(definition->>'language'),'')=$3 AND coalesce(definition->>'status','active')='active'
    AND ($4::uuid IS NULL OR prompt_id<>$4) LIMIT 1"""
COUNTS_SQL = """SELECT count(*)::int AS total,count(*) FILTER (WHERE origin='hub')::int AS hub,
    count(*) FILTER (WHERE origin='gold')::int AS gold,
    count(*) FILTER (WHERE coalesce(definition->>'status','active')='archived')::int AS archived,
    count(*) FILTER (WHERE coalesce(definition->>'status','active')='removed')::int AS removed
    FROM catalog.current_prompt WHERE project_id=$1"""


# ═══ input ═══════════════════════════════════════════════════════════════════════════════════════════════

class PromptFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=4 * TEXT_MAX)
    kind: Literal["single", "acr"] = "single"
    language: str | None = Field(None, max_length=CODE_MAX)
    regions: list[str] = Field(default_factory=list, max_length=REGIONS_MAX)
    funnel: str | None = Field(None, max_length=CODE_MAX)
    brandPresence: str | None = Field(None, max_length=CODE_MAX)
    listType: str | None = Field(None, max_length=CODE_MAX)
    depth1: str | None = Field(None, max_length=CODE_MAX)
    depth2: str | None = Field(None, max_length=CODE_MAX)
    depth3: str | None = Field(None, max_length=CODE_MAX)
    depth4: str | None = Field(None, max_length=CODE_MAX)


class PromptWrite(PromptFields):
    expectedVersion: int = Field(ge=1)


class VersionRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedVersion: int = Field(ge=1)


def refused(status: int, code: str, message: str, details: dict | None = None) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message, **({"details": details} if details else {})})


def parse(model: type[BaseModel], body, what: str = "prompt") -> BaseModel:
    """A request body as `model`, or 422 in the error envelope (not FastAPI's default validation shape)."""
    try:
        return model.model_validate(body)
    except ValidationError as e:
        fields = sorted({".".join(str(p) for p in err["loc"]) for err in e.errors()})
        raise refused(422, "invalid_value", f"Invalid {what} fields", {"fields": fields}) from None


def clean(value: str | None) -> str | None:
    value = (value or "").strip()
    if CONTROL.search(value):
        raise refused(422, "invalid_value", "Codes must not contain control characters")
    return value or None


def normalize_region(raw: str) -> str | None:
    """Same codes as the Global prompts screen (screens/standard_prompts.normalize_market): KR, x:WW."""
    value = raw.strip()
    if not value:
        return None
    return f"x:{value[2:].upper()}" if value.lower().startswith("x:") else value.upper()


def normalize(fields: PromptFields) -> tuple[str, dict]:
    """The text and definition to record (status is added by the caller)."""
    text = fields.text.strip()
    if not text:
        raise refused(422, "invalid_value", "Prompt text is required", {"fields": ["text"]})
    if len(text) > TEXT_MAX:
        raise refused(422, "invalid_value", f"Prompt text is longer than {TEXT_MAX} characters", {"fields": ["text"]})
    if CONTROL.search(text):
        raise refused(422, "invalid_value", "Prompt text must be one line without control characters", {"fields": ["text"]})
    language = clean(fields.language)
    regions = sorted({r for r in (normalize_region(clean(x) or "") for x in fields.regions) if r})
    definition = {"surface": 1, "kind": fields.kind, "language": language.lower() if language else None, "regions": regions}
    for api, key in LABELS.items():
        definition[key] = clean(getattr(fields, api))
    return text, definition


def check_vocabulary(definition: dict, vocabulary: dict[str, list[dict]]) -> None:
    """Every code must be one `vocabulary` offers: Gold's taxonomy, the catalog's languages and markets."""
    known = {k: {v["value"] for v in values} for k, values in vocabulary.items()}
    unknown = []
    for api, key in SCALARS.items():
        value = definition.get(key)
        if value is not None and value not in known.get(api, set()):
            unknown.append(api)
    if any(r not in known.get("regions", set()) for r in definition["regions"]):
        unknown.append("regions")
    if unknown:
        raise refused(422, "unknown_code", "Use Gold's taxonomy codes and the languages and markets the Global catalog uses", {"fields": unknown})


def check_taxonomy_path(definition: dict, taxa: list[tuple[str, str, tuple]]) -> None:
    """depth2 must sit under the chosen depth1, depth3 under depth1/depth2: the same code exists under
    several parents (RAV4 under 9 depth2 codes). No recorded taxonomy yet: nothing to check against."""
    known = {(field, path, code) for field, code, path in taxa}
    if not known:
        return
    chain = []
    for n in (1, 2, 3):
        code = definition.get(f"depth{n}")
        if code is None:
            deeper = [f"depth{m}" for m in range(n + 1, 4) if definition.get(f"depth{m}") is not None]
            if deeper:
                raise refused(422, "invalid_taxonomy", f"Choose depth{n} before {deeper[0]}", {"fields": deeper})
            return
        if (f"depth{n}", tuple(chain), code) not in known:
            raise refused(422, "invalid_taxonomy", f"depth{n} {code} is not under {' / '.join(chain) or 'the top level'}",
                          {"fields": [f"depth{n}"]})
        chain.append(code)


# ═══ stored rows → views ═════════════════════════════════════════════════════════════════════════════════

def encoded(value) -> str:
    """The same canonical JSON as hub_storage/sync_catalog.py, so HUB and Gold revisions hash alike."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def digest(text: str, definition: dict) -> str:
    return hashlib.sha256(encoded({"definition": definition, "text": text}).encode()).hexdigest()


def definition_of(row) -> dict:
    value = row["definition"]
    return json.loads(value) if isinstance(value, str) else dict(value)


def status_of(definition: dict) -> str:
    status = definition.get("status")
    return status if status in ("archived", "removed") else "active"


def snapshot(text: str, definition: dict) -> dict:
    """The fields the screen shows and edits, from a stored text + definition (Gold or HUB)."""
    regions = definition.get("regions")
    return {"text": text, "kind": definition.get("kind") or "single", "language": definition.get("language") or None,
            "regions": sorted({r for r in (normalize_region(str(x)) for x in regions) if r}) if isinstance(regions, list) else [],
            **{api: definition.get(key) or None for api, key in LABELS.items()}, "status": status_of(definition)}


def item_view(row) -> dict:
    return {"id": str(row["prompt_id"]), "origin": row["origin"], "editable": row["origin"] == "hub",
            "version": row["version"], **snapshot(row["text"], definition_of(row)),
            "recordedAt": row["recorded_at"], "registeredAt": row["registered_at"]}


def history(rows: list) -> list[dict]:
    """Revisions oldest -> newest as events newest first: created / updated / archived / restored, with the
    changed fields (old -> new). A Gold revision that changed only fields this screen does not show has
    no changes listed."""
    events, previous = [], None
    for r in rows:
        current = snapshot(r["text"], definition_of(r))
        if previous is None:
            event, changes = "created", {}
        else:
            changes = {k: {"old": previous[k], "new": v} for k, v in current.items() if k != "status" and previous[k] != v}
            status = current["status"]
            event = "updated" if previous["status"] == status else status if status in ("archived", "removed") else "restored"
        events.append({"version": r["version"], "event": event, "changes": changes, "recordedAt": r["recorded_at"],
                       "recordedBy": str(r["recorded_by"]) if r["recorded_by"] else None})
        previous = current
    return events[::-1]


# ═══ connections ═════════════════════════════════════════════════════════════════════════════════════════

_pool = None


async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_CATALOG_EDITOR_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=2, timeout=5, command_timeout=20, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-catalog-editor", "statement_timeout": "15000"},
        )


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def writing():
    if _pool is None:
        raise HTTPException(503, "HUB catalog editing is not configured (HGH_CATALOG_EDITOR_DB_URL)")
    async with _pool.acquire() as conn, conn.transaction():
        await conn.execute(f"SET LOCAL lock_timeout='{LOCK_TIMEOUT}'")
        try:
            await conn.execute("SELECT pg_advisory_xact_lock($1)", CATALOG_LOCK)
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


async def global_project(conn) -> UUID:
    rows = await conn.fetch(GLOBAL_PROJECT_SQL)
    if len(rows) != 1:
        raise HTTPException(503, "The Global project is not in the HUB catalog; run manage.py sync-gold-catalog")
    return rows[0]["project_id"]


async def taxonomy(conn) -> list[tuple[str, str, tuple]]:
    """(API field, code, ancestor codes) for every taxon the last Gold import recorded; none before the first
    import (then only the codes the HUB catalog already uses are offered and accepted)."""
    out = []
    for r in await conn.fetch(TAXON_SQL):
        if r["axis"] in TAXON_AXES and r["code"]:
            path = json.loads(r["path"]) if isinstance(r["path"], str) else (r["path"] or [])
            out.append((TAXON_AXES[r["axis"]], r["code"], tuple(path)))
    if not out:
        log.warning("No recorded taxonomy for Global prompt codes; run manage.py sync-gold-catalog")
    return out


async def vocabulary(conn, project: UUID, taxa: list[tuple[str, str, tuple]] | None = None) -> dict[str, list[dict]]:
    """Codes per field with their use in the Global catalog: language and markets as used, the taxonomy
    fields as Gold defines them (an unused code counts 0)."""
    out: dict[str, list[dict]] = {api: [] for api in ("language", "regions", *LABELS)}
    for r in await conn.fetch(VOCABULARY_SQL, project):
        value = r["value"].lower() if r["key"] == "language" else normalize_region(r["value"]) if r["key"] == "regions" else r["value"]
        out[r["key"]].append({"value": value, "count": r["n"]})
    for field, code, _ in taxa if taxa is not None else await taxonomy(conn):
        out[field].append({"value": code, "count": 0})
    for key, values in out.items():
        merged: dict[str, int] = {}
        for v in values:   # Gold spellings that normalize alike (x:ww / x:WW) count as one code
            merged[v["value"]] = merged.get(v["value"], 0) + v["count"]
        out[key] = [{"value": v, "count": n} for v, n in sorted(merged.items(), key=lambda kv: (-kv[1], kv[0]))]
    return out


async def actors(ids: set[str]) -> dict[str, dict]:
    if not ids:
        return {}
    try:
        async with operations_db.connection() as conn:
            rows = await conn.fetch("SELECT user_id,subject,display_name FROM system.user_account WHERE user_id=ANY($1::uuid[])",
                                    [UUID(i) for i in ids])
    except ConnectionError:
        return {}
    return {str(r["user_id"]): {"login": r["subject"], "displayName": r["display_name"]} for r in rows}


# ═══ reads ═══════════════════════════════════════════════════════════════════════════════════════════════

def list_filters(q: dict, project: UUID) -> tuple[str, list]:
    conds, args = ["p.project_id=$1"], [project]

    def bind(sql: str, value) -> None:
        args.append(value)
        conds.append(sql.replace("$?", f"${len(args)}"))

    status = q.get("status") or "active"
    if status not in (*STATUSES, "all"):
        raise refused(422, "invalid_value", "status must be active, archived, removed or all")
    if status != "all":
        bind("coalesce(p.definition->>'status','active')=$?", status)
    origin = q.get("origin") or "all"
    if origin not in ("hub", "gold", "all"):
        raise refused(422, "invalid_value", "origin must be hub, gold or all")
    if origin != "all":
        bind("p.origin=$?", origin)
    if q.get("kind"):
        if q["kind"] not in ("single", "acr"):
            raise refused(422, "invalid_value", "kind must be single or acr")
        bind("coalesce(p.definition->>'kind','single')=$?", q["kind"])
    if q.get("language"):
        bind("lower(p.definition->>'language')=$?", q["language"].strip().lower())
    search = (q.get("q") or "").strip()
    if search:
        if len(search) > 200 or CONTROL.search(search):
            raise refused(422, "invalid_value", "Search text is too long or has control characters")
        bind("strpos(lower(p.text),lower($?))>0", search)
    return " AND ".join(conds), args


def page_bounds(q: dict) -> tuple[int, int]:
    try:
        limit, offset = int(q.get("limit") or 50), int(q.get("offset") or 0)
    except ValueError:
        raise refused(422, "invalid_value", "limit and offset must be integers") from None
    if not (1 <= limit <= LIST_LIMIT_MAX) or offset < 0:
        raise refused(422, "invalid_value", f"limit must be 1..{LIST_LIMIT_MAX} and offset >= 0")
    return limit, offset


async def listing(q: dict) -> dict:
    limit, offset = page_bounds(q)
    async with reading() as conn:
        project = await global_project(conn)
        where, args = list_filters(q, project)
        total = await conn.fetchval(f"SELECT count(*) FROM catalog.current_prompt p WHERE {where}", *args)
        rows = await conn.fetch(f"""SELECT p.* FROM catalog.current_prompt p WHERE {where}
            ORDER BY (p.origin='hub') DESC,p.recorded_at DESC,p.prompt_id LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}""",
                                *args, limit, offset)
        counts = dict(await conn.fetchrow(COUNTS_SQL, project))
    return {"items": [item_view(r) for r in rows], "page": {"total": total, "limit": limit, "offset": offset}, "counts": counts}


async def options() -> dict:
    async with reading() as conn:
        return {"kinds": ["single", "acr"], **await vocabulary(conn, await global_project(conn))}


async def detail(prompt_id: UUID) -> dict:
    async with reading() as conn:
        project = await global_project(conn)
        row = await conn.fetchrow(CURRENT_SQL, prompt_id)
        if row is None or row["project_id"] != project:
            raise HTTPException(404, "Global prompt not found")
        versions = await conn.fetch(VERSIONS_SQL, prompt_id, HISTORY_LIMIT + 1)
    # one revision more than shown: the oldest shown one is compared with it
    events = history(list(reversed(versions)))[:HISTORY_LIMIT]
    names = await actors({e["recordedBy"] for e in events if e["recordedBy"]})
    for e in events:
        e["actor"] = names.get(e["recordedBy"]) if e["recordedBy"] else None
    return {"item": item_view(row), "history": events}


# ═══ writes ══════════════════════════════════════════════════════════════════════════════════════════════

def version_conflict(current: int) -> HTTPException:
    return refused(409, "version_conflict", "The prompt was changed after you opened it; reload it", {"currentVersion": current})


async def refuse_duplicate(conn, project: UUID, text: str, definition: dict, own: UUID | None) -> None:
    other = await conn.fetchval(DUPLICATE_SQL, project, text, definition.get("language") or "", own)
    if other:
        raise refused(409, "duplicate", "An active Global prompt already has this text and language", {"promptId": str(other)})


async def editable(conn, prompt_id: UUID, project: UUID, expected: int):
    row = await conn.fetchrow(CURRENT_SQL, prompt_id)
    if row is None or row["project_id"] != project:
        raise HTTPException(404, "Global prompt not found")
    if row["origin"] != "hub":
        raise refused(409, "gold_owned", "Gold prompts are read-only here: the Gold import would overwrite the change")
    if row["version"] != expected:
        raise version_conflict(row["version"])
    return row


async def check_codes(conn, project: UUID, definition: dict) -> None:
    taxa = await taxonomy(conn)
    check_vocabulary(definition, await vocabulary(conn, project, taxa))
    check_taxonomy_path(definition, taxa)


async def record(conn, prompt_id: UUID, version: int, text: str, definition: dict, actor: Principal) -> None:
    try:
        await conn.execute("""INSERT INTO catalog.prompt_version(prompt_id,version,text,definition,sha256,recorded_by)
            VALUES($1,$2,$3,$4::jsonb,$5,$6)""", prompt_id, version, text, encoded(definition), digest(text, definition), actor.user_id)
    except asyncpg.UniqueViolationError:
        raise version_conflict(version - 1) from None


async def create(body: PromptFields, actor: Principal) -> dict:
    text, definition = normalize(body)
    definition["status"] = "active"
    async with writing() as conn:
        project = await global_project(conn)
        await check_codes(conn, project, definition)
        await refuse_duplicate(conn, project, text, definition, None)
        prompt_id = uuid4()
        await conn.execute("INSERT INTO catalog.prompt(prompt_id,project_id,origin) VALUES($1,$2,'hub')", prompt_id, project)
        await record(conn, prompt_id, 1, text, definition, actor)
        row = await conn.fetchrow(CURRENT_SQL, prompt_id)
    return {"item": item_view(row), "changed": True}


async def update(prompt_id: UUID, body: PromptWrite, actor: Principal) -> dict:
    text, definition = normalize(body)
    definition["status"] = "active"
    async with writing() as conn:
        project = await global_project(conn)
        row = await editable(conn, prompt_id, project, body.expectedVersion)
        if status_of(definition_of(row)) == "archived":
            raise refused(409, "archived", "Restore the prompt before editing it")
        if digest(text, definition) == row["sha256"]:
            return {"item": item_view(row), "changed": False}
        await check_codes(conn, project, definition)
        await refuse_duplicate(conn, project, text, definition, prompt_id)
        await record(conn, prompt_id, row["version"] + 1, text, definition, actor)
        row = await conn.fetchrow(CURRENT_SQL, prompt_id)
    return {"item": item_view(row), "changed": True}


async def set_status(prompt_id: UUID, body: VersionRef, status: Literal["active", "archived"], actor: Principal) -> dict:
    async with writing() as conn:
        project = await global_project(conn)
        row = await editable(conn, prompt_id, project, body.expectedVersion)
        definition = definition_of(row)
        if status_of(definition) == status:
            return {"item": item_view(row), "changed": False}
        if status == "active":
            await refuse_duplicate(conn, project, row["text"], definition, prompt_id)
        await record(conn, prompt_id, row["version"] + 1, row["text"], {**definition, "status": status}, actor)
        row = await conn.fetchrow(CURRENT_SQL, prompt_id)
    return {"item": item_view(row), "changed": True}
