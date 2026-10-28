"""External API (2026-10-28): the current prompts and the values collecting and processing them need,
read-only, for callers that hold an API key (back/hub_storage/manage.py ext-key-issue).

The process reaches only the HUB data DB, as hmg_ext_api, which can read the ext schema and nothing else.
Every request is one read-only transaction that first sets hgh.key_hash to the sha256 of the presented key.
The ext views then answer that caller's granted and approved projects and the approved reference families,
and nothing at all for an unknown, expired or revoked key. The scope is enforced by the database; this code
only shapes the rows. Stored definitions keep Gold's encoding (surface 1/2/3, brand bitmasks); responses
decode them with the HUB code tables (reference families surface and brand_bit), and an unknown code comes
out as {"code": null, "raw": n} instead of failing the request.

Change detection: every project, prompt and reference family carries change_seq (commit order) and etag.
A consumer keeps one after_seq per project. It reads a project from after_seq=0 when it first sees it, when it
reappears, or when reset_seq is above its after_seq (a grant or approval changed). It reads everything again
when meta.contract_version changes."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("hgh.ext")

CONTRACT = "ext-v1"
KEY_RE = re.compile(r"hgh_([0-9a-f]{32})_[A-Za-z0-9_-]{43}")
RATE_PER_MIN = int(os.environ.get("HGH_EXT_RATE_PER_MIN", "120"))     # per key
CONCURRENCY = int(os.environ.get("HGH_EXT_CONCURRENCY", "4"))         # per key
FAILURES_PER_MIN = int(os.environ.get("HGH_EXT_FAILURES_PER_MIN", "20"))  # per client address
PAGE_DEFAULT, PAGE_MAX = 500, 1000
STATUS_CODES = {401: "unauthorized", 404: "not_found", 405: "method_not_allowed", 422: "invalid_value", 429: "rate_limited"}
NO_STORE = {"Cache-Control": "no-store"}

META_SQL = "SELECT client_id,key_id,as_of,hub_reference FROM ext.meta"
CODES_SQL = "SELECT family,item_key,definition FROM ext.reference_items WHERE family IN ('surface','brand_bit')"
PROJECTS_SQL = "SELECT * FROM ext.projects ORDER BY project_id LIMIT $1"
PROJECT_SQL = "SELECT * FROM ext.projects WHERE project_id=$1"
PROMPTS_SQL = "SELECT * FROM ext.prompts WHERE project_id=$1 AND change_seq>$2 ORDER BY change_seq LIMIT $3"
SETS_SQL = "SELECT * FROM ext.reference_sets ORDER BY family"
SET_SQL = "SELECT * FROM ext.reference_sets WHERE family=$1"
ITEMS_SQL = "SELECT item_key,definition FROM ext.reference_items WHERE family=$1 AND item_key>$2 ORDER BY item_key LIMIT $3"
TAXON_KEYS = ("funnel", "brand_presence", "list_type", "depth1", "depth2", "depth3", "depth4")


# ═══ limits (one process) ════════════════════════════════════════════════════════════════════════════════

class Window:
    """At most `limit` events per key in the last `seconds`."""

    def __init__(self, limit: int, seconds: float = 60.0):
        self.limit, self.seconds, self.events = limit, seconds, {}

    def retry_after(self, key, now: float | None = None) -> int:
        """0 and the event counted, or the seconds until one is allowed."""
        now = time.monotonic() if now is None else now
        q = self.events.setdefault(key, deque())
        while q and q[0] <= now - self.seconds:
            q.popleft()
        if len(q) >= self.limit:
            return max(1, int(q[0] + self.seconds - now) + 1)
        q.append(now)
        return 0


requests_per_key, failures_per_address = Window(RATE_PER_MIN), Window(FAILURES_PER_MIN)
running: dict[str, int] = {}


def limited(retry: int, message: str) -> HTTPException:
    return HTTPException(429, message, headers={"Retry-After": str(retry)})


# ═══ connection and caller ═══════════════════════════════════════════════════════════════════════════════

_pool = None


async def open_pool():
    global _pool
    dsn = os.environ.get("HGH_EXT_DB_URL")
    if dsn:
        _pool = await asyncpg.create_pool(
            dsn, min_size=0, max_size=6, timeout=5, command_timeout=15, statement_cache_size=0,
            server_settings={"application_name": "hmg-geo-hub-ext", "default_transaction_read_only": "on"})


async def close_pool():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def presented_key(request: Request) -> str:
    """The Bearer key, refused before any database work when it is not shaped like one."""
    scheme, _, key = (request.headers.get("authorization") or "").partition(" ")
    if scheme.lower() != "bearer" or not KEY_RE.fullmatch(key.strip()):
        raise HTTPException(401, "Send Authorization: Bearer <API key>")
    return key.strip()


@asynccontextmanager
async def scoped(request: Request):
    """One read-only transaction scoped to the caller: (connection, meta row). 401 for a key the database does
    not accept, 429 past the caller's rate or concurrency. Failed keys are limited per client address."""
    address = request.client.host if request.client else "-"
    try:
        key = presented_key(request)
    except HTTPException:
        if retry := failures_per_address.retry_after(address):
            raise limited(retry, "Too many failed authentications") from None
        raise
    if _pool is None:
        raise HTTPException(503, "The external API store is not configured")
    async with _pool.acquire() as conn, conn.transaction(readonly=True):
        await conn.execute("SELECT set_config('hgh.key_hash',$1,true)", hashlib.sha256(key.encode()).hexdigest())
        meta = await conn.fetchrow(META_SQL)
        if meta is None:
            if retry := failures_per_address.retry_after(address):
                raise limited(retry, "Too many failed authentications")
            raise HTTPException(401, "Unknown, expired or revoked API key")
        key_id = str(meta["key_id"])
        request.state.client_id, request.state.key_id = str(meta["client_id"]), key_id
        if retry := requests_per_key.retry_after(key_id):
            raise limited(retry, f"More than {RATE_PER_MIN} requests a minute for this key")
        if running.get(key_id, 0) >= CONCURRENCY:
            raise limited(1, f"More than {CONCURRENCY} requests at once for this key")
        running[key_id] = running.get(key_id, 0) + 1
        try:
            yield conn, meta
        finally:
            running[key_id] -= 1


# ═══ decoding ════════════════════════════════════════════════════════════════════════════════════════════

def loaded(value):
    return json.loads(value) if isinstance(value, str) else value


class Codes:
    """The HUB code tables of this transaction: surface numbers and brand bits to codes."""

    def __init__(self, rows):
        self.surfaces, self.bits = {}, {}
        for r in rows:
            d = loaded(r["definition"])
            if r["family"] == "surface":
                self.surfaces[d["value"]] = d["code"]
            else:
                self.bits[d["bit"]] = d["code"]

    def surface(self, value):
        if value is None:
            return None
        return self.surfaces.get(value) or {"code": None, "raw": value}

    def brands(self, mask):
        """A bitmask as codes in bit order; bits without a code come last as one {"code": null, "raw": n}."""
        mask = mask or 0
        out, rest = [], mask
        for bit in sorted(self.bits):
            if mask & bit:
                out.append(self.bits[bit])
                rest &= ~bit
        return out + ([{"code": None, "raw": rest}] if rest else [])


def contract_version(meta) -> str:
    return f"{CONTRACT}+{hashlib.sha256((meta['hub_reference'] or '').encode()).hexdigest()[:12]}"


def etag(contract: str, sha: str) -> str:
    return hashlib.sha256(f"{contract}:{sha}".encode()).hexdigest()


def project_view(row, codes: Codes, contract: str) -> dict:
    d = loaded(row["definition"])
    head = {"id": str(row["project_id"]), "status": d.get("status") or "active", "change_seq": row["change_seq"],
            "reset_seq": row["reset_seq"], "etag": etag(contract, row["sha256"]), "recorded_at": row["recorded_at"]}
    if head["status"] != "active":
        return head
    return {**head, "origin": row["origin"], "name": d.get("name"), "surface": codes.surface(d.get("surface")),
            "is_root": d.get("is_root"), "site_brands": codes.brands(d.get("site_brand_bit")), "country": d.get("country"),
            "regions": d.get("regions") or [], "brands": d.get("brands"), "domain": d.get("domain"),
            "custom_fields": d.get("custom_fields") or [], "web": d.get("web")}


def in_catalog(origin: str, d: dict) -> bool:
    if origin == "hub":
        return True     # an active HUB Global prompt (archived ones are tombstones)
    flag = {1: "in_root_catalog", 2: "web_reg", 3: "in_project_catalog"}.get(d.get("surface"))
    return bool(flag and d.get(flag))


def prompt_view(row, codes: Codes, contract: str) -> dict:
    d = loaded(row["definition"])
    head = {"id": str(row["prompt_id"]), "project_id": str(row["project_id"]), "status": d.get("status") or "active",
            "change_seq": row["change_seq"], "etag": etag(contract, row["sha256"]), "recorded_at": row["recorded_at"]}
    if head["status"] != "active":
        return head
    catalogs = [{"catalog_row_id": c.get("catalog_row_id"), "brands": codes.brands(c.get("brand_bit")), "kind": c.get("kind"),
                 **{k: c.get(k) for k in TAXON_KEYS}} for c in d.get("catalogs") or []]
    return {**head, "origin": row["origin"], "text": row["text"], "surface": codes.surface(d.get("surface")),
            "kind": d.get("kind"), "language": d.get("language"), "regions": d.get("regions") or [],
            "in_catalog": in_catalog(row["origin"], d), **{k: d.get(k) for k in TAXON_KEYS}, "catalogs": catalogs,
            "unit_file_seq": d.get("unit_file_seq"), "target_url": d.get("target_url"), "custom_values": d.get("custom_values") or {}}


def envelope(meta, data, **extra) -> JSONResponse:
    body = {"data": data, "meta": {"contract_version": contract_version(meta), "as_of": meta["as_of"], **extra}}
    return JSONResponse(jsonable_encoder(body), headers=NO_STORE)


# ═══ app ═════════════════════════════════════════════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pool()
    try:
        yield
    finally:
        await close_pool()


app = FastAPI(title="HMG GEO HUB external API", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def error_response(status: int, message: str, headers=None) -> JSONResponse:
    code = STATUS_CODES.get(status) or ("source_unavailable" if status >= 500 else "invalid_value")
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers={**NO_STORE, **(headers or {})})


@app.exception_handler(StarletteHTTPException)   # ours and the router's (unknown path 404, non-GET 405)
async def http_error(request: Request, exc: StarletteHTTPException):
    message = "Read-only: GET only" if exc.status_code == 405 else str(exc.detail)
    return error_response(exc.status_code, message, getattr(exc, "headers", None))


@app.exception_handler(RequestValidationError)
async def invalid(request: Request, exc: RequestValidationError):
    return error_response(422, "Invalid parameters: " + ", ".join(sorted({".".join(map(str, e["loc"][1:])) for e in exc.errors()})))


@app.exception_handler(asyncpg.PostgresError)
async def database_error(request: Request, exc: asyncpg.PostgresError):
    # A PostgreSQL message can contain query values. Never return or log it.
    log.error("ext query failed: %s SQLSTATE=%s", type(exc).__name__, exc.sqlstate)
    return error_response(503, "The external API store could not be read")


@app.exception_handler(TimeoutError)
async def pool_timeout(request: Request, exc: TimeoutError):
    return error_response(503, "The external API store did not answer in time")


@app.middleware("http")
async def access_log(request: Request, call_next):
    """One structured line per request: who (client and key ids, never the key), which route, how it went."""
    request_id, started = str(uuid.uuid4()), time.monotonic()
    request.state.client_id = request.state.key_id = None
    response = await call_next(request)
    route = request.scope.get("route")
    log.info(json.dumps({"request_id": request_id, "client_id": request.state.client_id, "key_id": request.state.key_id,
                         "method": request.method, "route": getattr(route, "path", None), "status": response.status_code,
                         "ms": round((time.monotonic() - started) * 1000)}))
    response.headers["X-Request-Id"] = request_id
    return response


@app.get("/ext/healthz")
async def healthz():
    """Liveness without names: no database, role or caller details."""
    if _pool is None:
        return JSONResponse({"ok": False}, status_code=503, headers=NO_STORE)
    try:
        async with _pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
    except (OSError, asyncpg.PostgresError, TimeoutError):
        return JSONResponse({"ok": False}, status_code=503, headers=NO_STORE)
    return JSONResponse({"ok": True}, headers=NO_STORE)


@app.get("/ext/v1/projects")
async def projects(request: Request):
    async with scoped(request) as (conn, meta):
        codes, contract = Codes(await conn.fetch(CODES_SQL)), contract_version(meta)
        rows = await conn.fetch(PROJECTS_SQL, PAGE_MAX)
    items = [{k: v for k, v in project_view(r, codes, contract).items() if k in
              ("id", "status", "surface", "change_seq", "reset_seq", "etag")} for r in rows]
    return envelope(meta, {"items": items})


@app.get("/ext/v1/projects/{project_id}")
async def project(project_id: uuid.UUID, request: Request):
    async with scoped(request) as (conn, meta):
        codes = Codes(await conn.fetch(CODES_SQL))
        row = await conn.fetchrow(PROJECT_SQL, project_id)
    if row is None:
        raise HTTPException(404, "No such project for this key")
    return envelope(meta, project_view(row, codes, contract_version(meta)))


@app.get("/ext/v1/projects/{project_id}/prompts")
async def prompts(project_id: uuid.UUID, request: Request, after_seq: int = Query(0, ge=0),
                  limit: int = Query(PAGE_DEFAULT, ge=1, le=PAGE_MAX)):
    async with scoped(request) as (conn, meta):
        if await conn.fetchrow(PROJECT_SQL, project_id) is None:
            raise HTTPException(404, "No such project for this key")
        codes, contract = Codes(await conn.fetch(CODES_SQL)), contract_version(meta)
        rows = await conn.fetch(PROMPTS_SQL, project_id, after_seq, limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    return envelope(meta, {"items": [prompt_view(r, codes, contract) for r in rows]},
                    next_after_seq=rows[-1]["change_seq"] if rows else after_seq, has_more=more)


@app.get("/ext/v1/reference")
async def reference(request: Request):
    async with scoped(request) as (conn, meta):
        rows = await conn.fetch(SETS_SQL)
    contract = contract_version(meta)
    return envelope(meta, {"families": [{"family": r["family"], "source": r["source"], "item_count": r["item_count"],
                                         "change_seq": r["change_seq"], "etag": etag(contract, r["sha256"])} for r in rows]})


@app.get("/ext/v1/reference/{family}")
async def reference_family(family: str, request: Request, after_key: str = Query("", max_length=2000),
                           limit: int = Query(PAGE_DEFAULT, ge=1, le=PAGE_MAX)):
    async with scoped(request) as (conn, meta):
        head = await conn.fetchrow(SET_SQL, family)
        if head is None:
            raise HTTPException(404, "No such reference family for this key")
        rows = await conn.fetch(ITEMS_SQL, family, after_key, limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    return envelope(meta, {"family": family, "items": [{"key": r["item_key"], **loaded(r["definition"])} for r in rows]},
                    etag=etag(contract_version(meta), head["sha256"]), change_seq=head["change_seq"],
                    next_after_key=rows[-1]["item_key"] if rows else after_key, has_more=more)
