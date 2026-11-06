"""The hub server (T13): Next's only door. It signs accounts in and checks them again on every request, keeps the accounts and each account's saved filters, and passes every
other /v1 request to the data server with the account in a short-lived internal token. Input editing moves here in step 1f; from then on the proxy carries reads only. It holds no metric logic: every screen stops when it stops."""
from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager
from uuid import UUID

import asyncpg
from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from hub_server import accounts, operations_db, proxy, saved_filters
from hub_server import auth as hub_auth
from shared import internal_token
from shared.errors import parse

log = logging.getLogger("hgh.hub")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await operations_db.open_pool()
    await accounts.open_pool()
    await saved_filters.open_pool()
    await proxy.open_client()
    try:
        yield
    finally:
        await proxy.close_client()
        await saved_filters.close_pool()
        await accounts.close_pool()
        await operations_db.close_pool()


app = FastAPI(title="HMG GEO HUB hub server", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

STATUS_CODES = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "read_only", 409: "conflict", 429: "rate_limited"}


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    # A dict detail names its own code and details; a string detail is the message.
    detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
    code = detail.get("code") or STATUS_CODES.get(exc.status_code) or ("source_unavailable" if exc.status_code >= 500 else "invalid_value")
    body = {"code": code, "message": detail.get("message", code), **({"details": detail["details"]} if "details" in detail else {})}
    return JSONResponse({"error": body}, status_code=exc.status_code)


@app.exception_handler(asyncpg.PostgresError)
async def database_error(request: Request, exc: asyncpg.PostgresError):
    # A PostgreSQL message can contain query values. Never return or log it.
    log.error("HUB query failed: %s SQLSTATE=%s path=%s", type(exc).__name__, exc.sqlstate, request.url.path)
    return JSONResponse({"error": {"code": "source_unavailable", "message": "HUB data could not be read or written"}}, status_code=503)


@app.exception_handler(TimeoutError)
async def pool_timeout(request: Request, exc: TimeoutError):
    # No free database connection in time (pool acquire / connect): a transient source failure.
    log.error("HUB read timed out: %s path=%s", type(exc).__name__, request.url.path)
    return JSONResponse({"error": {"code": "source_unavailable", "message": "HUB data could not be read in time"}}, status_code=503)


@app.get("/healthz")
async def healthz():
    return {"ok": True, "service": "hub_server", "operations": await operations_db.health()}


def hub_json(data, status: int = 200, database: str = "operations_db") -> JSONResponse:
    source = {"operations_db": "hub_operations", "input_db": "hub_input"}.get(database, "hub_data")
    return JSONResponse(jsonable_encoder({"data": data, "meta": {"source": source, "database": database}}),
                        status_code=status, headers={"Cache-Control": "no-store"})


async def json_body(request: Request):
    try:
        return await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(422, "Request body must be JSON") from None


# ─── Login and accounts ─────────────────────────────────────────────────────────────────────────────────
# Registered before the proxy's catch-all so these paths reach their own handlers.

@app.post("/v1/auth/login")
async def auth_login(request: Request):
    body = await json_body(request)
    if not isinstance(body, dict) or not isinstance(body.get("login"), str) or not isinstance(body.get("password"), str):
        raise HTTPException(422, "login and password are required")
    session = await hub_auth.login(body["login"], body["password"])
    await accounts.signed_in(UUID(session["user"]["id"]))
    return hub_json(session, database="input_db")


@app.get("/v1/auth/me")
async def auth_me(request: Request):
    # An account that has to replace an issued password is still itself here (its pages then ask for the new one).
    who = await hub_auth.principal(request.headers.get("authorization"), password_change=True)
    return hub_json({"user": who.view()}, database="input_db")


@app.post("/v1/auth/password")
async def auth_password(request: Request):
    body = parse(accounts.PasswordChange, await json_body(request), "password")
    return hub_json(await accounts.change_password(request.headers.get("authorization"), body))


# Admin › 사용자 관리 (accounts.py): the top-level administrator only.
@app.get("/v1/hub/accounts")
async def account_list(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await accounts.listing(actor))


@app.post("/v1/hub/accounts")
async def account_create(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(accounts.AccountCreate, await json_body(request), "account")
    return hub_json(await accounts.create(body, actor), 201)


@app.get("/v1/hub/accounts/{user_id}")
async def account(user_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    return hub_json(await accounts.detail(user_id, actor))


@app.put("/v1/hub/accounts/{user_id}")
async def account_update(user_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(accounts.AccountUpdate, await json_body(request), "account")
    return hub_json(await accounts.update(user_id, body, actor))


@app.post("/v1/hub/accounts/{user_id}/{action}")
async def account_action(user_id: UUID, action: str, request: Request):
    if action not in ("disable", "enable", "reset-password"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    if action == "reset-password":
        return hub_json(await accounts.reset_password(user_id, actor))
    return hub_json(await accounts.set_status(user_id, "active" if action == "enable" else "disabled", actor))


# The signed-in account's own saved filters of a renewal page (saved_filters.py).
@app.get("/v1/hub/saved-filters")
async def saved_filter_list(request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    return hub_json(await saved_filters.listing(request.query_params.get("page"), actor))


@app.post("/v1/hub/saved-filters")
async def saved_filter_create(request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    body = parse(saved_filters.FilterCreate, await json_body(request), "saved filter")
    return hub_json(await saved_filters.create(body, actor), 201)


@app.post("/v1/hub/saved-filters/import")
async def saved_filter_import(request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    body = parse(saved_filters.FilterImport, await json_body(request), "saved filter")
    return hub_json(await saved_filters.import_items(body, actor))


@app.patch("/v1/hub/saved-filters/{filter_id}")
async def saved_filter_change(filter_id: UUID, request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    body = parse(saved_filters.FilterChange, await json_body(request), "saved filter")
    return hub_json(await saved_filters.change(filter_id, body, actor))


@app.delete("/v1/hub/saved-filters/{filter_id}")
async def saved_filter_delete(filter_id: UUID, request: Request):
    actor = await hub_auth.principal(request.headers.get("authorization"))
    return hub_json(await saved_filters.remove(filter_id, actor))


# ─── Everything else ────────────────────────────────────────────────────────────────────────────────────

@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def to_data_server(path: str, request: Request):
    who = await hub_auth.principal(request.headers.get("authorization"))
    key = internal_token.key()
    if key is None:
        raise HTTPException(503, f"The hub server is not configured ({internal_token.ENV})")
    return await proxy.forward(request, internal_token.sign(key, who, time.time()))
