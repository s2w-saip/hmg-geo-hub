"""The hub server (T13): Next's only door. It signs accounts in and checks them again on every request, keeps the accounts, each account's saved filters and every input edit,
and passes reads to the data server with the account's scope in a short-lived internal token. The proxy carries reads only. It holds no metric logic: every screen stops when it stops."""
from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager
from uuid import UUID

import asyncpg
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from hub_server import accounts, input_db, operations_db, proxy, saved_filters
from hub_server import auth as hub_auth
from hub_server.inputs import catalog_editor, entity_roles, ga4_registry, hub_catalog, interest, measurement, project_prompts, source_lists, source_overrides
from shared import internal_token
from shared.errors import parse

log = logging.getLogger("hgh.hub")


INPUT_EDITORS = (catalog_editor, entity_roles, ga4_registry, interest, measurement, project_prompts, source_overrides)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await operations_db.open_pool()
    await accounts.open_pool()
    await saved_filters.open_pool()
    await input_db.open_pool()
    for store in INPUT_EDITORS:
        await store.open_pool()
    await proxy.open_client()
    try:
        yield
    finally:
        await proxy.close_client()
        for store in INPUT_EDITORS:
            await store.close_pool()
        await input_db.close_pool()
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


def input_json(data, status: int = 200) -> JSONResponse:
    return hub_json(data, status, database="input_db")


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


# ─── Reads the data server answers ──────────────────────────────────────────────────────────────────────

async def _forward(request: Request):
    who = await hub_auth.principal(request.headers.get("authorization"))
    key = internal_token.key()
    if key is None:
        raise HTTPException(503, f"The hub server is not configured ({internal_token.ENV})")
    return await proxy.forward(request, internal_token.sign(key, who.scope(), time.time()))


# Input lists that need gold_db (D-26). Before /v1/hub/{kind}, which would take the one-segment ones.
for path in ("/v1/hub/source-overrides", "/v1/hub/source-seeds", "/v1/hub/source-socials", "/v1/hub/source-codes", "/v1/hub/interest-keywords", "/v1/hub/interest-sources",
             "/v1/hub/entity-roles", "/v1/hub/entity-roles/mentions", "/v1/hub/ga4-properties/{property_id}/events"):
    app.add_api_route(path, _forward, methods=["GET"])


def ga4_property_id(property_id: str) -> str:
    if not ga4_registry.PROPERTY.fullmatch(property_id):
        raise HTTPException(404, "No such GA4 property")
    return property_id


# ─── Input editing ──────────────────────────────────────────────────────────────────────────────────────

@app.get("/v1/hub/ga4-properties")
async def ga4_property_list(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await ga4_registry.listing())


@app.post("/v1/hub/ga4-properties")
async def ga4_property_create(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(ga4_registry.PropertyCreate, await json_body(request), "GA4 property")
    return input_json(await ga4_registry.create(body, actor), 201)


@app.get("/v1/hub/ga4-properties/{property_id}")
async def ga4_property(property_id: str, request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await ga4_registry.detail(ga4_property_id(property_id)))


@app.put("/v1/hub/ga4-properties/{property_id}")
async def ga4_property_update(property_id: str, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(ga4_registry.PropertyUpdate, await json_body(request), "GA4 property")
    return input_json(await ga4_registry.update(ga4_property_id(property_id), body, actor))


@app.post("/v1/hub/ga4-properties/{property_id}/{action}")
async def ga4_property_action(property_id: str, action: str, request: Request):
    if action not in ("stop", "resume"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await ga4_registry.set_enabled(ga4_property_id(property_id), action == "resume", actor))


@app.get("/v1/hub/source-overrides/history")
async def source_override_history(request: Request, skey: str | None = Query(None, max_length=400)):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await source_overrides.history(skey))


@app.post("/v1/hub/source-overrides")
async def source_override_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(source_overrides.OverrideSet, await json_body(request), "source correction")
    return input_json(await source_overrides.set_category(body, actor))


@app.post("/v1/hub/source-overrides/clear")
async def source_override_clear(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(source_overrides.OverrideClear, await json_body(request), "source correction")
    return input_json(await source_overrides.clear(body, actor))


@app.get("/v1/hub/source-seeds/history")
async def source_seed_history(request: Request, skey: str | None = Query(None, max_length=400)):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await source_lists.seed_history(skey))


@app.post("/v1/hub/source-seeds")
async def source_seed_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(source_lists.SeedSet, await json_body(request), "seed")
    return input_json(await source_lists.set_seed(body, actor))


@app.post("/v1/hub/source-seeds/remove")
async def source_seed_remove(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(source_lists.SeedKey, await json_body(request), "seed")
    return input_json(await source_lists.remove_seed(body, actor))


@app.get("/v1/hub/source-socials/history")
async def source_social_history(request: Request, key: str | None = Query(None, max_length=400)):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await source_lists.social_history(key))


@app.post("/v1/hub/source-socials")
async def source_social_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(source_lists.SocialSet, await json_body(request), "social account")
    return input_json(await source_lists.set_social(body, actor))


@app.post("/v1/hub/source-socials/{action}")
async def source_social_status(action: str, request: Request):
    if action not in ("stop", "resume"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(source_lists.SocialKey, await json_body(request), "social account")
    return input_json(await source_lists.set_social_status(body, action == "stop", actor))


@app.get("/v1/hub/source-codes/history")
async def source_code_history(request: Request, kind: str | None = Query(None, max_length=20),
                              code: str | None = Query(None, max_length=64)):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await source_lists.code_history(kind, code))


@app.post("/v1/hub/source-codes")
async def source_code_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(source_lists.CodeSet, await json_body(request), "code")
    return input_json(await source_lists.set_code(body, actor))


@app.post("/v1/hub/source-codes/order")
async def source_code_order(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(source_lists.CodeOrder, await json_body(request), "code order")
    return input_json(await source_lists.order_codes(body, actor))


@app.get("/v1/hub/interest-keywords/history")
async def interest_keyword_history(request: Request, term: str | None = Query(None, max_length=400)):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await interest.keyword_history(term))


@app.post("/v1/hub/interest-keywords")
async def interest_keyword_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(interest.KeywordSet, await json_body(request), "keyword")
    return input_json(await interest.set_keyword(body, actor))


@app.post("/v1/hub/interest-keywords/{action}")
async def interest_keyword_status(action: str, request: Request):
    if action not in ("stop", "resume"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(interest.KeywordKey, await json_body(request), "keyword")
    return input_json(await interest.set_keyword_status(body, action == "stop", actor))


@app.get("/v1/hub/interest-sources/history")
async def interest_source_history(request: Request, url: str | None = Query(None, max_length=600)):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await interest.source_history(url))


@app.post("/v1/hub/interest-sources")
async def interest_source_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(interest.SourceSet, await json_body(request), "source")
    return input_json(await interest.set_source(body, actor))


@app.post("/v1/hub/interest-sources/{action}")
async def interest_source_status(action: str, request: Request):
    if action not in ("stop", "resume"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(interest.SourceKey, await json_body(request), "source")
    return input_json(await interest.set_source_status(body, action == "stop", actor))


@app.get("/v1/hub/entity-roles/history")
async def entity_role_history(request: Request, entity: str | None = Query(None, max_length=40)):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await entity_roles.history(entity))


@app.post("/v1/hub/entity-roles")
async def entity_role_set(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(entity_roles.RoleSet, await json_body(request), "entity role")
    return input_json(await entity_roles.set_role(body, actor))


@app.post("/v1/hub/entity-roles/clear")
async def entity_role_clear(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(entity_roles.RoleClear, await json_body(request), "entity role")
    return input_json(await entity_roles.clear(body, actor))


# Project › Prompt (hub_stores/project_prompts.py): the top-level administrator only (project pages are, decision J).
@app.get("/v1/hub/projects/{project_id}/measurement")
async def project_measurement_read(project_id: UUID, request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    value = await measurement.read(project_id)
    if value is None:
        raise HTTPException(404, "The input store does not hold this project")
    return input_json(value)


@app.post("/v1/hub/projects/{project_id}/measurement")
async def project_measurement_write(project_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(measurement.MeasurementWrite, await json_body(request), "measurement")
    return input_json(await measurement.write(project_id, body, actor))


@app.post("/v1/hub/projects/{project_id}/prompts")
async def project_prompt_add(project_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(project_prompts.PromptAdd, await json_body(request))
    return input_json(await project_prompts.add(project_id, body, actor), 201)


@app.get("/v1/hub/projects/{project_id}/prompts/{prompt_id}/history")
async def project_prompt_history(project_id: UUID, prompt_id: UUID, request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await project_prompts.prompt_history(project_id, prompt_id))


@app.post("/v1/hub/projects/{project_id}/prompts/{prompt_id}")
async def project_prompt_edit(project_id: UUID, prompt_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(project_prompts.PromptEdit, await json_body(request))
    return input_json(await project_prompts.update(project_id, prompt_id, body, actor))


@app.post("/v1/hub/projects/{project_id}/prompts/{prompt_id}/{action}")
async def project_prompt_lifecycle(project_id: UUID, prompt_id: UUID, action: str, request: Request):
    if action not in project_prompts.LIFECYCLE:
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(project_prompts.VersionRef, await json_body(request))
    return input_json(await project_prompts.lifecycle(project_id, prompt_id, action, body, actor))


@app.post("/v1/hub/projects/{project_id}/prompt-tags")
async def project_prompt_tags(project_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(project_prompts.TagSet, await json_body(request), "tag")
    return input_json(await project_prompts.set_tags(project_id, body, actor))


@app.post("/v1/hub/projects/{project_id}/prompt-fields")
async def project_prompt_field_add(project_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(project_prompts.FieldAdd, await json_body(request), "tag")
    return input_json(await project_prompts.add_field(project_id, body, actor), 201)


@app.post("/v1/hub/projects/{project_id}/prompt-fields/{field_id}/{action}")
async def project_prompt_field_status(project_id: UUID, field_id: str, action: str, request: Request):
    if action not in ("archive", "restore"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await project_prompts.set_field_archived(project_id, field_id, action == "archive", actor))


@app.get("/v1/hub/global-prompts")
async def global_prompts(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await catalog_editor.listing(dict(request.query_params)))


@app.get("/v1/hub/global-prompts/options")
async def global_prompt_options(request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await catalog_editor.options())


@app.post("/v1/hub/global-prompts")
async def global_prompt_create(request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(catalog_editor.PromptFields, await json_body(request))
    return input_json(await catalog_editor.create(body, actor), 201)


@app.get("/v1/hub/global-prompts/{prompt_id}")
async def global_prompt(prompt_id: UUID, request: Request):
    await hub_auth.admin(request.headers.get("authorization"))
    return input_json(await catalog_editor.detail(prompt_id))


@app.put("/v1/hub/global-prompts/{prompt_id}")
async def global_prompt_update(prompt_id: UUID, request: Request):
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(catalog_editor.PromptWrite, await json_body(request))
    return input_json(await catalog_editor.update(prompt_id, body, actor))


@app.post("/v1/hub/global-prompts/{prompt_id}/{action}")
async def global_prompt_status(prompt_id: UUID, action: str, request: Request):
    if action not in ("archive", "restore"):
        raise HTTPException(404, "Unknown action")
    actor = await hub_auth.admin(request.headers.get("authorization"))
    body = parse(catalog_editor.VersionRef, await json_body(request))
    return input_json(await catalog_editor.set_status(prompt_id, body, "archived" if action == "archive" else "active", actor))


@app.get("/v1/hub/{kind}")
async def catalog(kind: str, request: Request, limit: int = Query(100, ge=1, le=1000),
                  offset: int = Query(0, ge=0), project_id: str | None = None):
    await hub_auth.admin(request.headers.get("authorization"))
    return JSONResponse(jsonable_encoder(await hub_catalog.listing(kind,limit,offset,project_id)),
                        headers={"Cache-Control":"no-store"})


# ─── Everything else ────────────────────────────────────────────────────────────────────────────────────

@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def to_data_server(path: str, request: Request):
    if request.method != "GET":
        raise HTTPException(405, "This service is read-only")
    return await _forward(request)
