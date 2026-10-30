"""The signed-in account's data scope on every read (2026-10-29).

Screens and /v1 reads run for one HUB account (hub_auth.Principal, from the request's token), and its scope
(front lib/auth/scope-policy AllowedScope) is kept in a context variable for that request:
- the screen builders read their filters with it (reader_scope(): the filter panel's brand lock and country
  narrowing, as the original front did for that account);
- every data read (api.get, the /v1 read route: Gold and the HUB analytics store) is clamped to it, as the
  original API did from the token (back/app core/auth.py DataScope): brand = the requested brands inside the
  scope, else the scope's brands; country = the requested countries inside the scope, else the scope's countries
  (an account's regions stand for every country of them). HMG (the umbrella, every brand) is never a scoped
  account's brand. The original front left a scoped account's brand and countries out of the query (the API
  added them), so the clamp is what keeps a scoped read inside the scope.
The global and website surfaces are open to a scoped account (website since 2026-10-31, renewal audit step 2, ⛔J):
the website read is clamped as the global one is, its countries being site countries (front lib/auth/route-policy:
country = its own sites, region · hq = the sites of the region's countries; the 브랜드 통합 view stays the
administrator's: a scoped account reads its own brands only). A scope with a country also reads that country's city
sites (lib/geo-catalog/pseudo-country.ts scopeParent: SA -> SA-Dammam · SA-Jeddah · SA-Riyadh), as the original
website reads did; site hubs (worldwide · EU · MIDDLEEAST · CPO · CN-BJ) are no country of a region, so only an
account without countries (hq) reads them. The dedicated-site rules of the original (an account holding worldwide ·
CPO · HYUNDAI-N) have no account here: the Admin screen gives countries of the account's RHQ regions only
(hub_stores/accounts.py scope_of). The project surface stays refused."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar

from fastapi import HTTPException
from starlette.datastructures import QueryParams

from bff.screens._query import RHQ_REGION_COUNTRIES, with_pseudo_countries

ALL: dict = {"all": True}
BRANDS = ("Hyundai", "Kia", "Genesis")
SURFACES = ("global", "website")   # the surfaces a scoped account reads
_scope: ContextVar[dict] = ContextVar("hgh_scope", default=ALL)


def reader_scope() -> dict:
    """The scope of this request's account (every scope outside a request, e.g. tests and imports)."""
    return _scope.get()


@contextmanager
def scoped(scope: dict):
    token = _scope.set(scope)
    try:
        yield
    finally:
        _scope.reset(token)


def scope_countries(scope: dict) -> list[str] | None:
    """Allowed ISO countries: the account's countries, else every country of its regions, None = every country.
    Regions that do not resolve deny everything ([]), never every country."""
    if scope.get("all"):
        return None
    if scope.get("countries"):
        return [c.upper() for c in scope["countries"]]
    regions = scope.get("regions") or []
    if not regions:
        return None
    out: dict[str, None] = {}
    for rid in regions:
        for c in RHQ_REGION_COUNTRIES.get(rid, ()):
            out[c] = None
    return [] if any(r not in RHQ_REGION_COUNTRIES for r in regions) else list(out)


def surface_countries(scope: dict, surface: str) -> list[str] | None:
    """The countries the account reads on one surface (None = every country, [] = none): scope_countries, and on the
    website surface also the city sites of those countries."""
    countries = scope_countries(scope)
    return with_pseudo_countries(countries) if surface == "website" and countries else countries


def forbidden(message: str) -> HTTPException:
    return HTTPException(403, {"code": "out_of_scope", "message": message})


def clamp(q: QueryParams, scope: dict | None = None) -> QueryParams:
    """One read's query inside the account's scope (unchanged for every scope)."""
    scope = reader_scope() if scope is None else scope
    if scope.get("all"):
        return q
    surface = q.get("surface", "global")
    if surface not in SURFACES:
        raise forbidden("This account reads the global and website surfaces only")
    allowed = {b.lower(): b for b in scope.get("brands") or () if b in BRANDS}
    countries = surface_countries(scope, surface)
    if not allowed or countries == []:
        raise forbidden("The account has no data scope")
    asked = [v for v in q.getlist("brand") if v]
    brands = [v for v in asked if v.lower() in allowed] or list(allowed.values())
    asked_countries = [v for v in q.getlist("country") if v]
    if countries is not None:
        inside = {c.upper() for c in countries}
        asked_countries = [v for v in asked_countries if v.upper() in inside] or countries
    pairs = [(k, v) for k, v in q.multi_items() if k not in ("brand", "country")]
    pairs += [("brand", b) for b in brands] + [("country", c) for c in asked_countries]
    pairs.sort(key=lambda kv: kv[0])   # api.query's order, so equal reads share one key
    return QueryParams(pairs)
