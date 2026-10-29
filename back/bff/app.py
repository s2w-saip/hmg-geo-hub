"""Local BFF/API over external Gold and separate HUB data/operations stores. Every route but /healthz and the
login needs a signed-in HUB account (hub_stores/hub_auth.py), and screens and data reads run inside its scope
(bff/access.py). Read-only, except what the HUB writes: every account changes its own password
(/v1/auth/password) and keeps its own saved filters (/v1/hub/saved-filters); the top-level administrator also
manages the accounts (/v1/hub/accounts) and edits Global prompts (/v1/hub/global-prompts)."""
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
from bff.hub_stores import accounts, analytics_db, catalog_editor, hub_auth, hub_catalog, operations_db, saved_filters

log = logging.getLogger("hgh.gold")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pool()
    await analytics_db.open_pool()
    await operations_db.open_pool()
    await catalog_editor.open_pool()
    await saved_filters.open_pool()
    await accounts.open_pool()
    try:
        yield
    finally:
        await close_pool()
        await analytics_db.close_pool()
        await operations_db.close_pool()
        await catalog_editor.close_pool()
        await saved_filters.close_pool()
        await accounts.close_pool()


app = FastAPI(title="HMG GEO HUB BFF / read-only API", lifespan=lifespan)

STATUS_CODES = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "read_only", 409: "conflict", 429: "rate_limited"}


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
    return JSONResponse(jsonable_encoder(built), headers={"Cache-Control": "no-store"})


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def read(path: str, request: Request):
    if request.method != "GET":
        raise HTTPException(405, "This service is read-only")
    who = await hub_auth.principal(request.headers.get("authorization"))
    data = await api.read(path, access.clamp(request.query_params, who.scope()))
    return JSONResponse(jsonable_encoder(data), headers={"Cache-Control": "no-store"})
