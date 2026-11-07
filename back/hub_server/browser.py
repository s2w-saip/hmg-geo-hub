"""The browser's door (T14.5.2, 2026-11-07): the same-origin /api/* the React client calls, so it needs no server of its own. Here and only here a session is a cookie: this module
sets and clears it, checks a write's Origin, and turns the cookie into the token the /v1 routes take. It decides which screens a role may open and which `ctx.*` a browser may name.
It computes nothing and reshapes nothing: an answer leaves as the /v1 route gave it. What it keeps from Next's routes (front/app/api) is listed in docs/handoff/hub-server-scope.md."""
from __future__ import annotations

import base64
import json
import re
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from hub_server import auth as hub_auth
from shared.account import Principal

router = APIRouter()

COOKIE = "hgh_hub_session"
NO_STORE = {"Cache-Control": "no-store"}
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)

#: the signed-in roles and what they open (front/lib/auth/route-policy.ts, for the four roles an account has): Global and Website for all, Project for the administrator
ROLES = frozenset(("admin", "hq", "region", "country"))

#: /api/hub/<family>/… passes to /v1/hub/<family>/…, whose routes decide everything else
FAMILIES = frozenset(("accounts", "saved-filters", "global-prompts", "measurements", "ga4-properties", "source-overrides", "source-seeds", "source-socials", "source-codes",
                      "interest-keywords", "interest-sources", "entity-roles", "projects"))
SUB_PATH = re.compile(r"[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*")
WRITES = ["POST", "PUT", "PATCH", "DELETE"]

#: the screens the browser reads directly (front/lib/hub/screen-read.ts)
SCREENS = frozenset(
    [f"overview/{n}" for n in ("filters", "as-of", "cards", "card-trend", "brand-matrix", "geo")]
    + [f"website/{n}" for n in ("summary", "summary-deferred", "engines", "trend", "composition", "brands", "geo", "prompts-page", "prompts-insights", "prompts-options")]
    + [f"mention/{n}" for n in ("rn-page", "rn-asof", "rn-shell", "rn-compare", "rn-rate-value", "rn-rate-hero", "rn-rate-engines", "rn-rate-types", "rn-favor-hero", "rn-favor-dist",
                                "rn-favor-matrix", "rn-rank", "rn-bump", "rn-ranking", "rn-engine-extra", "rn-presence-split", "rn-tab-value", "rn-summary", "rn-tab-deltas",
                                "view-cards", "rn-markets", "view-weekly", "view-compare")]
    + [f"citation/{n}" for n in ("standard", "website", "project", "filter-bar", "as-of", "renewal-header", "prompts", "tone-urls")]
    + [f"projects/{n}" for n in ("list", "filters", "as-of", "settings", "prompts", "dash-summary", "dash-summary-deferred", "dash-engines", "dash-trend", "dash-composition", "dash-status")]
    + ["shared/service-week", "shared/panel-options", "shared/filter-dates", "catalog/prompts-page", "catalog/prompts-header", "catalog/prompts-history", "acr/renewal", "acr/renewal-header",
       "conversion/renewal", "conversion/renewal-header", "visibility/renewal", "visibility/renewal-header"])
#: what a browser may say of its context; the rest comes from the account
SCREEN_CONTEXT = ("ctx.project_id", "ctx.locale", "ctx.view", "ctx.variant", "ctx.kpi", "ctx.family", "ctx.client_nav")

DRILLS = {"answer": "mention/drill-answer", "brand-citations": "mention/drill-brand-citations", "brand-mention-prompts": "mention/drill-brand-prompts",
          "signal-prompts": "mention/drill-signal-prompts", "missing-prompts": "mention/drill-missing-prompts", "market-evidence": "overview/market-evidence"}
STANDARD_PROMPTS = {"page": "catalog/prompts-page", "export": "catalog/prompts-export", "history": "catalog/prompts-history", "timeline": "catalog/prompts-timeline"}
WEBSITE_PROMPTS = {"page": "website/prompts-page", "rows": "website/prompts-rows", "insights": "website/prompts-insights"}
SERVICE_WEEK_PICKS = ("brand", "geography", "language", "engine")
AREAS = frozenset(("dashboard", "analysis", "funnel", "prompts"))
SURFACES = frozenset(("global", "website", "project"))
DOMAIN_SORTS = frozenset(("citations", "share", "coverage", "prompts", "skey"))
DOMAIN_PAGE = 200
CONTROL = re.compile(r"[\x00-\x1f\x7f]")

Query = list[tuple[str, str]]


def fail(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code}}, status, headers=NO_STORE)


def not_signed_in() -> JSONResponse:
    """One answer for every /api/* without a session, whose status is what the client acts on."""
    return JSONResponse({"error": {"code": "unauthorized", "message": "로그인이 필요합니다."}}, 401, headers=NO_STORE)


def same_origin(request: Request) -> bool:
    """A write's Origin must be this host (the cookie is SameSite=Strict as well)."""
    origin, host = request.headers.get("origin"), request.headers.get("host")
    if not origin or not host:
        return False
    return httpx.URL(origin).netloc.decode() == host if "://" in origin else False


def secure(request: Request) -> bool:
    return (request.headers.get("x-forwarded-proto") or request.url.scheme) == "https"


def set_session(response: Response, request: Request, token: str, expires_at: int) -> None:
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict", secure=secure(request), path="/", expires=datetime.fromtimestamp(expires_at, UTC))


def token_of(request: Request) -> str | None:
    return request.cookies.get(COOKIE) or None


async def inner(request: Request, method: str, path: str, query: Query | None = None, *, token: str | None = None, body: bytes | None = None) -> httpx.Response:
    """A /v1 route of this server, as Next's call to it was: the account is rechecked there, and a read goes on to the data server with the internal token."""
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    transport = httpx.ASGITransport(app=request.app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://hub-server", timeout=None) as client:
        return await client.request(method, path, params=httpx.QueryParams(query or []), headers=headers, content=body)


def passed_on(reply: httpx.Response, **headers: str) -> Response:
    return Response(reply.content, reply.status_code, headers={**NO_STORE, **headers}, media_type=reply.headers.get("content-type"))


def read_answer(reply: httpx.Response, **headers: str) -> Response:
    """A screen or data read: the answer as it is, but a failure says only its code. The backend's message and details stay here (front/lib/hgh/errors.ts hghErrorResponse)."""
    if reply.status_code >= 400:
        try:
            error = reply.json().get("error")
        except (json.JSONDecodeError, AttributeError):
            error = None
        if isinstance(error, dict) and "code" in error:
            return fail(reply.status_code, error["code"])
    return passed_on(reply, **headers)


async def account(request: Request) -> Principal | None:
    """The cookie's account now, or None (no cookie, or a session that has ended). An account that has to replace its password is still itself."""
    token = token_of(request)
    if not token:
        return None
    try:
        return await hub_auth.principal(f"Bearer {token}", password_change=True)
    except HTTPException as error:
        if error.status_code == 401:
            return None
        raise


def page_params(request: Request) -> Query:
    """The page's URL params, repeated keys and empty values kept. A browser never names the route context."""
    return [(k, v) for k, v in request.query_params.multi_items() if not k.startswith("ctx.")]


def may_open(who: Principal, surface: str) -> bool:
    return who.role in ROLES and (surface != "project" or who.role == "admin")


# ─── The session ────────────────────────────────────────────────────────────────────────────────────────

@router.get("/api/hub/session")
async def session_read(request: Request):
    token = token_of(request)
    if not token:
        return JSONResponse({"user": None}, headers=NO_STORE)
    reply = await inner(request, "GET", "/v1/auth/me", token=token)
    if reply.status_code == 401:
        return JSONResponse({"user": None}, headers=NO_STORE)
    if reply.status_code != 200:
        return passed_on(reply)
    return JSONResponse({"user": reply.json()["data"]["user"]}, headers=NO_STORE)


async def json_object(request: Request, *keys: str) -> dict | None:
    try:
        body = json.loads(await request.body())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return body if isinstance(body, dict) and all(isinstance(body.get(k), str) for k in keys) else None


def signed_in(reply: httpx.Response, request: Request) -> Response:
    """A login's answer without its token: that goes into the HttpOnly cookie and never reaches the page."""
    if reply.status_code != 200:
        return passed_on(reply)
    data = reply.json()["data"]
    response = JSONResponse({"user": data["user"]}, headers=NO_STORE)
    set_session(response, request, data["token"], data["expiresAt"])
    return response


@router.post("/api/hub/session")
async def session_start(request: Request):
    if not same_origin(request):
        return fail(403, "forbidden")
    body = await json_object(request, "login", "password")
    if body is None:
        return fail(422, "invalid_value")
    reply = await inner(request, "POST", "/v1/auth/login", body=json.dumps({"login": body["login"], "password": body["password"]}).encode())
    return signed_in(reply, request)


@router.delete("/api/hub/session")
async def session_end(request: Request):
    if not same_origin(request):
        return fail(403, "forbidden")
    response = Response(status_code=204, headers=NO_STORE)
    response.set_cookie(COOKIE, "", max_age=0, httponly=True, samesite="strict", secure=secure(request), path="/")
    return response


@router.post("/api/hub/password")
async def password_change(request: Request):
    if not same_origin(request):
        return fail(403, "forbidden")
    token = token_of(request)
    if not token:
        return not_signed_in()
    body = await json_object(request, "current", "new")
    if body is None:
        return fail(422, "invalid_value")
    reply = await inner(request, "POST", "/v1/auth/password", token=token, body=json.dumps({"current": body["current"], "new": body["new"]}).encode())
    return signed_in(reply, request)


# ─── Accounts, saved filters and input editing ──────────────────────────────────────────────────────────

@router.api_route("/api/hub/{family}", methods=["GET", *WRITES])
@router.api_route("/api/hub/{family}/{rest:path}", methods=["GET", *WRITES])
async def hub_family(family: str, request: Request, rest: str = ""):
    if family not in FAMILIES or (rest and not SUB_PATH.fullmatch(rest)):
        return fail(404, "not_found")
    if request.method != "GET" and not same_origin(request):
        return fail(403, "forbidden")
    token = token_of(request)
    if not token:
        return not_signed_in()
    body = (await request.body()) if request.method in ("POST", "PUT", "PATCH") else None
    path = f"/v1/hub/{family}/{rest}" if rest else f"/v1/hub/{family}"
    return passed_on(await inner(request, request.method, path, list(request.query_params.multi_items()), token=token, body=body))


# ─── Screens ────────────────────────────────────────────────────────────────────────────────────────────

def surface_of(name: str, requested: str) -> str:
    if name.startswith("website/") or name == "citation/website":
        return "website"
    if name.startswith("projects/") or name == "citation/project":
        return "project"
    if name.startswith(("catalog/", "acr/")) or name == "citation/standard":
        return "global"
    return requested


@router.get("/api/screens/{name:path}")
async def screen(name: str, request: Request):
    token = token_of(request)
    who = await account(request)
    if who is None:
        return not_signed_in()
    q = request.query_params
    if name not in SCREENS:
        return fail(404, "not_found")
    if who.must_change:
        return fail(403, "password_change_required")
    requested = q.get("ctx.surface") or q.get("surface") or "global"
    if requested not in SURFACES:
        return fail(422, "invalid_surface")
    surface = surface_of(name, requested)
    project_id = q.get("ctx.project_id") or ""
    if surface == "project" and name != "projects/list" and not UUID.fullmatch(project_id):
        return fail(422, "invalid_project_id")
    if name != "shared/service-week" and not may_open(who, "project" if name == "projects/list" else surface):
        return fail(403, "forbidden")
    if q.get("ctx.locale") and q.get("ctx.locale") not in ("ko", "en"):
        return fail(422, "invalid_locale")
    query = page_params(request)
    query += [(key, q[key]) for key in SCREEN_CONTEXT if key in q]   # a context value is one value, even when a caller repeats the key
    query += [("ctx.surface", surface), ("ctx.role", who.role), ("ctx.admin", "true" if who.role == "admin" else "false")]
    if name.startswith("citation/"):
        query = [(k, v) for k, v in query if k != "ctx.variant"] + [("ctx.variant", "renewal")]
    return passed_on(await inner(request, "GET", f"/v1/screens/{name}", query, token=token))


@router.get("/api/service-week")
async def service_week(request: Request):
    if await account(request) is None:
        return not_signed_in()
    query = [(k, request.query_params[k]) for k in SERVICE_WEEK_PICKS if request.query_params.get(k)]
    return read_answer(await inner(request, "GET", "/v1/screens/shared/service-week", query, token=token_of(request)))


@router.get("/api/filters/options")
async def filter_options(request: Request):
    q = request.query_params
    area, surface, project_id = q.get("area", ""), q.get("surface", ""), q.get("project_id")
    if area not in AREAS or surface not in SURFACES:
        return fail(422, "invalid_value")
    if surface != "global" and project_id is not None and not UUID.fullmatch(project_id):
        return fail(422, "invalid_value")
    if surface == "project" and project_id is None:
        return fail(422, "invalid_value")
    who = await account(request)
    if who is None:
        return not_signed_in()
    if not may_open(who, surface):
        return fail(403, "forbidden")
    query = [(k, q[k]) for k in (("time", "brand", "engine") if surface == "project" else ("time", "brand")) if q.get(k)]
    query.append(("surface", surface))
    if surface != "global" and project_id:
        query.append(("project_id", project_id))
    return read_answer(await inner(request, "GET", "/v1/screens/filters/options", query, token=token_of(request)))


@router.get("/api/scope/mention-compare")
async def mention_compare(request: Request):
    who = await account(request)
    if who is None:
        return not_signed_in()
    q = request.query_params
    surface = "project" if q.get("surface") == "project" else "website"
    project_id = q.get("projectId")
    if surface == "project" and not project_id:
        return JSONResponse({"error": "projectId required"}, 400, headers=NO_STORE)
    query = [(k, v) for k, v in page_params(request) if k not in ("surface", "projectId", "admin")]
    query.append(("ctx.surface", surface))
    if surface == "project":
        query.append(("ctx.project_id", project_id))
    if q.get("admin") == "1" and who.role == "admin":
        query.append(("ctx.admin", "true"))
    return read_answer(await inner(request, "GET", "/v1/screens/mention/view-compare", query, token=token_of(request)))


@router.get("/api/scope/{drill}")
async def scope_drill(drill: str, request: Request):
    """A drilldown's screen decides its status and body; the data server answers them as they are (its /v1/drill)."""
    target = DRILLS.get(drill)
    if target is None:
        return fail(404, "not_found")
    if await account(request) is None:
        return not_signed_in()
    params = json.dumps([list(pair) for pair in request.query_params.multi_items()], ensure_ascii=False)
    return read_answer(await inner(request, "GET", f"/v1/drill/{target}", [("ctx.params", params)], token=token_of(request)))


@router.get("/api/standard/acr/sheet")
async def acr_sheet(request: Request):
    who = await account(request)
    if who is None:
        return not_signed_in()
    if not may_open(who, "global"):
        return fail(403, "forbidden")
    return read_answer(await inner(request, "GET", "/v1/screens/acr/renewal-sheet", page_params(request), token=token_of(request)))


@router.get("/api/standard/prompts/{view}")
async def standard_prompts(view: str, request: Request):
    target = STANDARD_PROMPTS.get(view)
    if target is None:
        return fail(404, "not_found")
    who = await account(request)
    if who is None:
        return not_signed_in()
    if not may_open(who, "global"):
        return fail(403, "forbidden")
    return read_answer(await inner(request, "GET", f"/v1/screens/{target}", page_params(request), token=token_of(request)))


@router.get("/api/website/prompts/{view}")
async def website_prompts(view: str, request: Request):
    target = WEBSITE_PROMPTS.get(view)
    if target is None:
        return fail(404, "not_found")
    who = await account(request)
    if who is None:
        return not_signed_in()
    if not may_open(who, "website"):
        return fail(403, "forbidden")
    query = [*page_params(request), ("ctx.admin", "true" if who.role == "admin" else "false")]
    return read_answer(await inner(request, "GET", f"/v1/screens/{target}", query, token=token_of(request)))


# ─── Citation sources ───────────────────────────────────────────────────────────────────────────────────

def decode_skey(segment: str) -> str | None:
    """The source key of a path segment, or None unless it is the canonical base64url of printable text (a social key holds a slash)."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,1024}", segment):
        return None
    try:
        text = base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    canonical = base64.urlsafe_b64encode(text.encode("utf-8")).decode().rstrip("=")
    return text if text and canonical == segment and not CONTROL.search(text) else None


def search_is_bad(request: Request) -> bool:
    search = request.query_params.get("q", "").strip()
    return len(search) > 200 or bool(CONTROL.search(search))


def order_is_bad(request: Request) -> bool:
    q = request.query_params
    return q.get("sort", "citations") not in DOMAIN_SORTS or q.get("dir") not in (None, "asc", "desc")


def count_in(raw: str | None, largest: int) -> bool:
    return raw is None or (raw.isdigit() and 1 <= int(raw) <= largest)


async def citation_read(request: Request, screen_name: str, **more: str) -> Response:
    """Target, session, place: then the page's params and the route context (front/app/api/citations/_lib/route.ts)."""
    q = request.query_params
    project_id = q.get("projectId")
    if project_id is not None and not UUID.fullmatch(project_id):
        return fail(422, "invalid_value")
    surface = "project" if project_id is not None else "website" if q.get("surface") == "website" else "global"
    who = await account(request)
    if who is None:
        return not_signed_in()
    if not may_open(who, surface):
        return fail(403, "forbidden")
    query = [*page_params(request), ("ctx.surface", surface), ("ctx.role", who.role), *more.items()]
    if project_id:
        query.append(("ctx.project_id", project_id))
    extra = {"X-Content-Type-Options": "nosniff", "Content-Disposition": "attachment"} if screen_name == "citation/domains-export" else {}
    return read_answer(await inner(request, "GET", f"/v1/screens/{screen_name}", query, token=token_of(request)), **extra)


@router.get("/api/citations/domains")
async def citation_domains(request: Request):
    if order_is_bad(request) or not count_in(request.query_params.get("limit"), DOMAIN_PAGE) or search_is_bad(request):
        return fail(422, "invalid_value")
    return await citation_read(request, "citation/domains")


@router.get("/api/citations/domains/export")
async def citation_export(request: Request):
    q = request.query_params
    if order_is_bad(request) or q.get("locale", "ko") not in ("ko", "en") or not count_in(q.get("max_rows"), 5000) or search_is_bad(request):
        return fail(422, "invalid_value")
    return await citation_read(request, "citation/domains-export")


@router.get("/api/citations/domains/{skey}")
async def citation_domain(skey: str, request: Request):
    key = decode_skey(skey)
    if key is None:
        return fail(422, "invalid_value")
    return await citation_read(request, "citation/domain-detail", **{"ctx.skey": key})
