"""Local BFF/API over external Gold and separate HUB data/operations stores. Every route but /healthz and the
login needs a signed-in HUB account (hub_stores/hub_auth.py), and screens and data reads run inside its scope
(bff/access.py). Read-only, except what the HUB writes: every account changes its own password
(/v1/auth/password) and keeps its own saved filters (/v1/hub/saved-filters); the top-level administrator also
manages the accounts (/v1/hub/accounts), edits Global prompts (/v1/hub/global-prompts), keeps the GA4 property
registry (/v1/hub/ga4-properties) and the source category corrections (/v1/hub/source-overrides)."""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from uuid import UUID

import asyncpg
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from bff import access, api, screens
from bff.gold_reader.db import close_pool, connection, open_pool
from bff.hub_stores import (accounts, analytics_db, catalog_editor, ga4_registry, hub_auth, hub_catalog, operations_db, saved_filters,
                             source_lists, source_overrides)

log = logging.getLogger("hgh.gold")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pool()
    await analytics_db.open_pool()
    await operations_db.open_pool()
    await catalog_editor.open_pool()
    await saved_filters.open_pool()
    await accounts.open_pool()
    await ga4_registry.open_pool()
    await source_overrides.open_pool()
    try:
        yield
    finally:
        await close_pool()
        await analytics_db.close_pool()
        await operations_db.close_pool()
        await catalog_editor.close_pool()
        await saved_filters.close_pool()
        await accounts.close_pool()
        await ga4_registry.close_pool()
        await source_overrides.close_pool()


app = FastAPI(title="HMG GEO HUB BFF / read-only API", lifespan=lifespan)

STATUS_CODES = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "read_only", 409: "conflict", 429: "rate_limited"}
RENDER = {"ensure_ascii": False, "allow_nan": False, "indent": None, "separators": (",", ":")}   # JSONResponse.render's


def encode_body(content) -> bytes:
    """JSONResponse(jsonable_encoder(content)).body in one pass (2026-10-30, ACR P5): json writes the JSON types itself
    and hands jsonable_encoder only what it cannot (a date, a Decimal, a model); a screen's answer is mostly JSON
    already (api.get parses the shared read). A dict key json cannot take (a date) takes the two passes. The one
    difference from two passes: jsonable_encoder drops dict keys that start with "_sa" (SQLAlchemy state); no answer
    has such a key (bff.tests.test_app_encoding)."""
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
            "operations": await operations_db.health()}


# ─── HUB login, accounts, Global prompt editing and saved filters ─────────────────────────────────────
# Registered before /v1/hub/{kind} and the read-only catch-all so these paths reach their own handlers.

def hub_json(data, status: int = 200, database: str = "hmg_analytics") -> JSONResponse:
    source = "hub_operations" if database == "hmg_operations" else "hub_data"
    return JSONResponse(jsonable_encoder({"data": data, "meta": {"source": source, "database": database}}),
                        status_code=status, headers={"Cache-Control": "no-store"})


async def json_body(request: Request):
    try:
        return await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(422, "Request body must be JSON") from None


@app.post("/v1/auth/login")
async def auth_login(request: Request):
    body = await json_body(request)
    if not isinstance(body, dict) or not isinstance(body.get("login"), str) or not isinstance(body.get("password"), str):
        raise HTTPException(422, "login and password are required")
    session = await hub_auth.login(body["login"], body["password"])
    await accounts.signed_in(UUID(session["user"]["id"]))
    return hub_json(session)


@app.get("/v1/auth/me")
async def auth_me(request: Request):
    # An account that has to replace an issued password is still itself here (its pages then ask for the new one).
    who = await hub_auth.principal(request.headers.get("authorization"), password_change=True)
    return hub_json({"user": who.view()})


@app.post("/v1/auth/password")
async def auth_password(request: Request):
    body = catalog_editor.parse(accounts.PasswordChange, await json_body(request), "password")
    return hub_json(await accounts.change_password(request.headers.get("authorization"), body), database="hmg_operations")


# Admin › 사용자 관리 (hub_stores/accounts.py): the top-level administrator only.
@app.get("/v1/hub/accounts")
async def account_list(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await accounts.listing(actor), database="hmg_operations")


@app.post("/v1/hub/accounts")
async def account_create(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(accounts.AccountCreate, await json_body(request), "account")
    return hub_json(await accounts.create(body, actor), 201, database="hmg_operations")


@app.get("/v1/hub/accounts/{user_id}")
async def account(user_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await accounts.detail(user_id, actor), database="hmg_operations")


@app.put("/v1/hub/accounts/{user_id}")
async def account_update(user_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(accounts.AccountUpdate, await json_body(request), "account")
    return hub_json(await accounts.update(user_id, body, actor), database="hmg_operations")


@app.post("/v1/hub/accounts/{user_id}/{action}")
async def account_action(user_id: UUID, action: str, request: Request):
    if action not in ("disable", "enable", "reset-password"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    if action == "reset-password":
        return hub_json(await accounts.reset_password(user_id, actor), database="hmg_operations")
    return hub_json(await accounts.set_status(user_id, "active" if action == "enable" else "disabled", actor),
                    database="hmg_operations")


# Admin › GA4 연동 (hub_stores/ga4_registry.py): the top-level administrator only.
def ga4_property_id(property_id: str) -> str:
    if not ga4_registry.PROPERTY.fullmatch(property_id):
        raise HTTPException(404, "No such GA4 property")
    return property_id


@app.get("/v1/hub/ga4-properties")
async def ga4_property_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await ga4_registry.listing())


@app.post("/v1/hub/ga4-properties")
async def ga4_property_create(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(ga4_registry.PropertyCreate, await json_body(request), "GA4 property")
    return hub_json(await ga4_registry.create(body, actor), 201)


@app.get("/v1/hub/ga4-properties/{property_id}")
async def ga4_property(property_id: str, request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await ga4_registry.detail(ga4_property_id(property_id)))


@app.put("/v1/hub/ga4-properties/{property_id}")
async def ga4_property_update(property_id: str, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(ga4_registry.PropertyUpdate, await json_body(request), "GA4 property")
    return hub_json(await ga4_registry.update(ga4_property_id(property_id), body, actor))


@app.get("/v1/hub/ga4-properties/{property_id}/events")
async def ga4_property_events(property_id: str, request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await ga4_registry.events(ga4_property_id(property_id)))


@app.post("/v1/hub/ga4-properties/{property_id}/{action}")
async def ga4_property_action(property_id: str, action: str, request: Request):
    if action not in ("stop", "resume"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await ga4_registry.set_enabled(ga4_property_id(property_id), action == "resume", actor))


# Admin › 인용 출처 분류 (hub_stores/source_overrides.py): the top-level administrator only. A source key can hold a
# slash (an official social account), so it travels in the body or the query, not in the path.
@app.get("/v1/hub/source-overrides")
async def source_override_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_overrides.listing())


@app.get("/v1/hub/source-overrides/history")
async def source_override_history(request: Request, skey: str | None = Query(None, max_length=400)):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_overrides.history(skey))


@app.post("/v1/hub/source-overrides")
async def source_override_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(source_overrides.OverrideSet, await json_body(request), "source correction")
    return hub_json(await source_overrides.set_category(body, actor))


@app.post("/v1/hub/source-overrides/clear")
async def source_override_clear(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(source_overrides.OverrideClear, await json_body(request), "source correction")
    return hub_json(await source_overrides.clear(body, actor))


# Admin › 인용 출처 분류, the seed / official social / code table tabs (hub_stores/source_lists.py): the top-level
# administrator only; keys travel in the body or the query.
@app.get("/v1/hub/source-seeds")
async def source_seed_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_lists.seeds())


@app.get("/v1/hub/source-seeds/history")
async def source_seed_history(request: Request, skey: str | None = Query(None, max_length=400)):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_lists.seed_history(skey))


@app.post("/v1/hub/source-seeds")
async def source_seed_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(source_lists.SeedSet, await json_body(request), "seed")
    return hub_json(await source_lists.set_seed(body, actor))


@app.post("/v1/hub/source-seeds/remove")
async def source_seed_remove(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(source_lists.SeedKey, await json_body(request), "seed")
    return hub_json(await source_lists.remove_seed(body, actor))


@app.get("/v1/hub/source-socials")
async def source_social_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_lists.socials())


@app.get("/v1/hub/source-socials/history")
async def source_social_history(request: Request, key: str | None = Query(None, max_length=400)):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_lists.social_history(key))


@app.post("/v1/hub/source-socials")
async def source_social_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(source_lists.SocialSet, await json_body(request), "social account")
    return hub_json(await source_lists.set_social(body, actor))


@app.post("/v1/hub/source-socials/{action}")
async def source_social_status(action: str, request: Request):
    if action not in ("stop", "resume"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(source_lists.SocialKey, await json_body(request), "social account")
    return hub_json(await source_lists.set_social_status(body, action == "stop", actor))


@app.get("/v1/hub/source-codes")
async def source_code_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_lists.codes())


@app.get("/v1/hub/source-codes/history")
async def source_code_history(request: Request, kind: str | None = Query(None, max_length=20),
                              code: str | None = Query(None, max_length=64)):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await source_lists.code_history(kind, code))


@app.post("/v1/hub/source-codes")
async def source_code_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(source_lists.CodeSet, await json_body(request), "code")
    return hub_json(await source_lists.set_code(body, actor))


@app.post("/v1/hub/source-codes/order")
async def source_code_order(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(source_lists.CodeOrder, await json_body(request), "code order")
    return hub_json(await source_lists.order_codes(body, actor))


@app.get("/v1/hub/global-prompts")
async def global_prompts(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await catalog_editor.listing(dict(request.query_params)))


@app.get("/v1/hub/global-prompts/options")
async def global_prompt_options(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await catalog_editor.options())


@app.post("/v1/hub/global-prompts")
async def global_prompt_create(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(catalog_editor.PromptFields, await json_body(request))
    return hub_json(await catalog_editor.create(body, actor), 201)


@app.get("/v1/hub/global-prompts/{prompt_id}")
async def global_prompt(prompt_id: UUID, request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await catalog_editor.detail(prompt_id))


@app.put("/v1/hub/global-prompts/{prompt_id}")
async def global_prompt_update(prompt_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(catalog_editor.PromptWrite, await json_body(request))
    return hub_json(await catalog_editor.update(prompt_id, body, actor))


@app.post("/v1/hub/global-prompts/{prompt_id}/{action}")
async def global_prompt_status(prompt_id: UUID, action: str, request: Request):
    if action not in ("archive", "restore"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = catalog_editor.parse(catalog_editor.VersionRef, await json_body(request))
    return hub_json(await catalog_editor.set_status(prompt_id, body, "archived" if action == "archive" else "active", actor))


# The signed-in account's own saved filters of a renewal page (hub_stores/saved_filters.py).
@app.get("/v1/hub/saved-filters")
async def saved_filter_list(request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    return hub_json(await saved_filters.listing(request.query_params.get("page"), actor), database="hmg_operations")


@app.post("/v1/hub/saved-filters")
async def saved_filter_create(request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    body = catalog_editor.parse(saved_filters.FilterCreate, await json_body(request), "saved filter")
    return hub_json(await saved_filters.create(body, actor), 201, database="hmg_operations")


@app.post("/v1/hub/saved-filters/import")
async def saved_filter_import(request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    body = catalog_editor.parse(saved_filters.FilterImport, await json_body(request), "saved filter")
    return hub_json(await saved_filters.import_items(body, actor), database="hmg_operations")


@app.patch("/v1/hub/saved-filters/{filter_id}")
async def saved_filter_change(filter_id: UUID, request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    body = catalog_editor.parse(saved_filters.FilterChange, await json_body(request), "saved filter")
    return hub_json(await saved_filters.change(filter_id, body, actor), database="hmg_operations")


@app.delete("/v1/hub/saved-filters/{filter_id}")
async def saved_filter_delete(filter_id: UUID, request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    return hub_json(await saved_filters.remove(filter_id, actor), database="hmg_operations")


@app.get("/v1/hub/{kind}")
async def catalog(kind: str, request: Request, limit: int = Query(100, ge=1, le=1000),
                  offset: int = Query(0, ge=0), project_id: str | None = None):
    await hub_auth.admin(request.headers.get("authorization"))
    return JSONResponse(jsonable_encoder(await hub_catalog.listing(kind,limit,offset,project_id)),
                        headers={"Cache-Control":"no-store"})


@app.get("/v1/screens/{path:path}")
async def screen(path: str, request: Request):
    who = await hub_auth.principal(request.headers.get("authorization"))
    with access.scoped(who.scope()):
        built = await screens.build(path, request.query_params)
    return EncodedJSON(built, headers={"Cache-Control": "no-store"})


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def read(path: str, request: Request):
    if request.method != "GET":
        raise HTTPException(405, "This service is read-only")
    who = await hub_auth.principal(request.headers.get("authorization"))
    data = await api.read(path, access.clamp(request.query_params, who.scope()))
    return EncodedJSON(data, headers={"Cache-Control": "no-store"})
