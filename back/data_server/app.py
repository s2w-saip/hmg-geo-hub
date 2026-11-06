"""The data server: screens and metrics over gold_db, the Silver OBT and the input store. It sits behind the hub server, which signs in the
account and sends its scope here in an internal token (hub_stores/hub_auth.py): every route but /healthz refuses a request without one, and
screens and data reads run inside that scope (data_server/access.py). It writes only the cache."""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from data_server import access, api, screens
from data_server.gold_reader.db import close_pool, connection, open_pool
from data_server.hub_stores import (silver_db, analytics_db, cache_db, entity_roles, ga4_registry, metrics_db, hub_auth, input_db, interest,
                             source_lists, source_overrides)
from shared.input_common import entity_key

log = logging.getLogger("hgh.gold")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pool()
    await analytics_db.open_pool()
    await input_db.open_pool()
    await silver_db.open_pool()
    await cache_db.open_pool()
    await metrics_db.open_pool()
    try:
        yield
    finally:
        await close_pool()
        await analytics_db.close_pool()
        await input_db.close_pool()
        await silver_db.close_pool()
        await cache_db.close_pool()
        await metrics_db.close_pool()


app = FastAPI(title="HMG GEO HUB data server", lifespan=lifespan)

STATUS_CODES = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "read_only", 409: "conflict", 429: "rate_limited"}
RENDER = {"ensure_ascii": False, "allow_nan": False, "indent": None, "separators": (",", ":")}   # JSONResponse.render's


def encode_body(content) -> bytes:
    """JSONResponse(jsonable_encoder(content)).body in one pass (2026-10-30, ACR P5): json writes the JSON types itself
    and hands jsonable_encoder only what it cannot (a date, a Decimal, a model); a screen's answer is mostly JSON
    already (api.get parses the shared read). A dict key json cannot take (a date) takes the two passes. The one
    difference from two passes: jsonable_encoder drops dict keys that start with "_sa" (SQLAlchemy state); no answer
    has such a key (data_server.tests.test_app_encoding)."""
    try:
        text = json.dumps(content, default=jsonable_encoder, **RENDER)
    except TypeError:
        text = json.dumps(jsonable_encoder(content), **RENDER)
    return text.encode("utf-8")


class EncodedJSON(JSONResponse):
    """A JSONResponse whose body is encode_body(content): the same bytes as JSONResponse(jsonable_encoder(content))."""

    def render(self, content) -> bytes:
        return encode_body(content)


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    # A dict detail (HUB editing) names its own code and details; a string detail is the message.
    detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
    code = detail.get("code") or STATUS_CODES.get(exc.status_code) or ("source_unavailable" if exc.status_code >= 500 else "invalid_value")
    body = {"code": code, "message": detail.get("message", code), **({"details": detail["details"]} if "details" in detail else {})}
    return JSONResponse({"error": body}, status_code=exc.status_code)


@app.exception_handler(asyncpg.PostgresError)
async def database_error(request: Request, exc: asyncpg.PostgresError):
    # A PostgreSQL message can contain query values. Never return or log it.
    hub = request.url.path.startswith(("/v1/auth/", "/v1/hub/"))
    log.error("%s query failed: %s SQLSTATE=%s path=%s", "HUB" if hub else "Gold", type(exc).__name__, exc.sqlstate, request.url.path)
    message = "HUB data could not be read or written" if hub else "Gold data could not be read"
    return JSONResponse({"error": {"code": "source_unavailable", "message": message}}, status_code=503)


@app.exception_handler(TimeoutError)
async def pool_timeout(request: Request, exc: TimeoutError):
    # No free database connection in time (pool acquire / connect): a transient source failure.
    log.error("Gold read timed out: %s path=%s", type(exc).__name__, request.url.path)
    return JSONResponse({"error": {"code": "source_unavailable", "message": "Gold data could not be read in time"}}, status_code=503)


@app.get("/healthz")
async def healthz():
    async with connection() as conn:
        info = dict(await conn.fetchrow("SELECT current_database() AS database,current_user AS role,current_setting('transaction_read_only') AS read_only"))
    return {"ok": True, "source": "gold", **info, "analytics": await analytics_db.health(),
            "input": await input_db.health(), "cache": await cache_db.health()}


# ─── Input lists that need gold_db (D-26), and the checks before a save ─────────────────────────────────
# Registered before the read catch-all so these paths reach their own handlers. The hub server edits the inputs.

def hub_json(data, status: int = 200, database: str = "input_db") -> JSONResponse:
    source = {"operations_db": "hub_operations", "input_db": "hub_input"}.get(database, "hub_data")
    return JSONResponse(jsonable_encoder({"data": data, "meta": {"source": source, "database": database}}),
                        status_code=status, headers={"Cache-Control": "no-store"})


# Admin › GA4 연동 (hub_stores/ga4_registry.py): the top-level administrator only.
def ga4_property_id(property_id: str) -> str:
    if not ga4_registry.PROPERTY.fullmatch(property_id):
        raise HTTPException(404, "No such GA4 property")
    return property_id


@app.get("/v1/hub/ga4-properties/{property_id}/events")
async def ga4_property_events(property_id: str, request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await ga4_registry.events(ga4_property_id(property_id)))


# Admin › 인용 출처 분류 (hub_stores/source_overrides.py): the top-level administrator only. A source key can hold a
# slash (an official social account), so it travels in the body or the query, not in the path.
@app.get("/v1/hub/source-overrides")
async def source_override_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_overrides.listing())


# Admin › 인용 출처 분류, the seed / official social / code table tabs (hub_stores/source_lists.py): the top-level
# administrator only; keys travel in the body or the query.
@app.get("/v1/hub/source-seeds")
async def source_seed_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_lists.seeds())


@app.get("/v1/hub/source-socials")
async def source_social_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_lists.socials())


@app.get("/v1/hub/source-codes")
async def source_code_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_lists.codes())


# Admin › 고객 관심 데이터 관리 (hub_stores/interest.py): the top-level administrator only. A keyword or a URL can hold any
# character, so it travels in the body or the query, not in the path.
@app.get("/v1/hub/interest-keywords")
async def interest_keyword_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await interest.keywords())


@app.get("/v1/hub/interest-sources")
async def interest_source_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await interest.sources())


# Admin › 엔티티 카탈로그 (hub_stores/entity_roles.py): the top-level administrator only.
@app.get("/v1/hub/entity-roles")
async def entity_role_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await entity_roles.listing())


@app.get("/v1/hub/entity-roles/mentions")
async def entity_role_mentions(request: Request, entity: str | None = Query(None, max_length=40)):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await entity_roles.mentions(entity))


@app.get("/v1/hub/source-overrides/check")
async def source_override_check(request: Request, skey: str = Query(max_length=400), category: str | None = Query(None, max_length=64)):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json({"gold": await source_overrides.gold_check(skey, category)})


@app.get("/v1/hub/entity-roles/check")
async def entity_role_check(request: Request, entity: str = Query(max_length=40)):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json({"gold": await entity_roles.gold_entity(entity_key(entity))})


@app.get("/v1/screens/{path:path}")
async def screen(path: str, request: Request):
    who = await hub_auth.principal(request.headers.get("authorization"))
    with access.scoped(who.scope()):
        built = await screens.build(path, request.query_params)
    return EncodedJSON(built, headers={"Cache-Control": "no-store"})


#: the screens whose answer says its own status (screens/mention_drilldown.py, overview market evidence): {status, body}
DRILLS = frozenset(("mention/drill-answer", "mention/drill-brand-citations", "mention/drill-brand-prompts", "mention/drill-signal-prompts", "mention/drill-missing-prompts",
                    "overview/market-evidence"))


@app.get("/v1/drill/{path:path}")
async def drill(path: str, request: Request):
    """A drilldown as the browser's route answers it: the screen's body with the screen's status. The hub server forwards it as it is."""
    if path not in DRILLS:
        raise HTTPException(404, f"Unknown drilldown: {path}")
    who = await hub_auth.principal(request.headers.get("authorization"))
    with access.scoped(who.scope()):
        reply = await screens.build(path, request.query_params)
    return EncodedJSON(reply["body"], status_code=reply["status"], headers={"Cache-Control": "no-store"})


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def read(path: str, request: Request):
    if request.method != "GET":
        raise HTTPException(405, "This service is read-only")
    who = await hub_auth.principal(request.headers.get("authorization"))
    data = await api.read(path, access.clamp(request.query_params, who.scope(), path))
    return EncodedJSON(data, headers={"Cache-Control": "no-store"})
