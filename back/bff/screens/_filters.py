"""Filter bar data shared by every analysis screen (port of front/lib/hgh/adapters/filters.ts).

Also the URL reader (components/dash/filter-encoding.ts, standard-filters.ts,
project-custom-field-filters.ts), the panel options (F-1) and the local project gate
(lib/hgh/adapters/project-gate.ts). The query serializer is bff.screens._query.

Python shapes follow the TS ones: `sp` is the Next searchParams object (str or list[str] per key,
see search_params); result dicts carry the TS camelCase keys and omit what TS left undefined.
The local read-only session reads with READER_SCOPE ({all: true}); the scope branches are ported
anyway so a scoped session would get the same filters as the front.
"""
from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from bff import api
from bff.screens._convert import ascending_dates, filter_notices
from bff.screens._query import (
    SCOPE_DENY_BRAND, UMBRELLA_BRAND, WEBSITE_BRAND_GEO_CODES, analysis_query, effective_scope_countries,
    effective_website_scope_countries, is_iso_day, is_uuid, is_website_brand_geo_code, js_sorted, js_trim,
    narrow_scope_brands, uniq, website_scope_brands, with_params,
)
from bff.screens._sort import code_unit_compare, locale_compare, sort_by

ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


async def fetch_filter_dates(surface: str, project_id: str | None = None, family: str | None = None) -> dict:
    query: dict = {"surface": surface, "family": family or "mentions"}
    if project_id and surface != "global":
        query["project_id"] = project_id
    return await api.get("filters/dates", query)


def selectable_dates_of(data: dict) -> list[str] | None:
    dates = ascending_dates(data.get("dates"))
    return dates or None


def collection_start_day_of(data: dict) -> str | None:
    """first_measured_date as the ISO instant of that KST midnight (Date#toISOString format)."""
    d = data.get("first_measured_date")
    if not d or not ISO_DAY.match(d):
        return None
    instant = datetime.fromisoformat(d).replace(tzinfo=timezone(timedelta(hours=9))).astimezone(timezone.utc)
    return instant.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def filter_dates_view(res: dict) -> dict:
    data = res["data"]
    return {"selectableDates": selectable_dates_of(data),
            "latestAnchorDay": data.get("latest_round_date"),
            "collectionStartDay": collection_start_day_of(data),
            "firstMeasuredDate": data.get("first_measured_date"),
            "presets": list(data.get("presets") or []),
            "truncated": data.get("dates_truncated"),
            "notices": filter_notices(res.get("meta"))}


async def load_filter_dates(surface: str, project_id: str | None = None, family: str | None = None) -> dict:
    return filter_dates_view(await fetch_filter_dates(surface, project_id, family))


# ═══ URL -> StandardFilters ═════════════════════════════════════════════════════════

FILTER_SEP = "~"
TIME_RANGE_SEP = ".."
STANDARD_FILTER_ARRAY_AXES = ("region", "engine", "funnelStage", "brand", "brandPresence", "listType",
                              "depth1", "depth2", "depth3", "sourceCategory", "lang", "websiteCountry")


def search_params(q) -> dict[str, str | list[str]]:
    """Starlette QueryParams -> the Next searchParams object: one value = str, repeated key = list."""
    out: dict[str, str | list[str]] = {}
    for key in q.keys():
        values = q.getlist(key)
        out[key] = values[0] if len(values) == 1 else list(values)
    return out


def join_filter_values(values: Sequence[str]) -> str:
    return FILTER_SEP.join(values)


def split_filter_values(raw: str | Sequence[str] | None) -> list[str]:
    """A dimension URL value -> its values ("~"-joined; "all" and empty dropped)."""
    s = raw if isinstance(raw, str) else FILTER_SEP.join(raw) if isinstance(raw, (list, tuple)) else ""
    return [v for v in (js_trim(x) for x in s.split(FILTER_SEP)) if v and v != "all"]


def encode_time_range(rng: dict) -> str | None:
    """{from?, to?} -> "YYYY-MM-DD..YYYY-MM-DD" (one side may be empty); neither valid -> None."""
    frm = rng.get("from") if rng.get("from") and is_iso_day(rng.get("from")) else ""
    to = rng.get("to") if rng.get("to") and is_iso_day(rng.get("to")) else ""
    if not frm and not to:
        return None
    return f"{frm}{TIME_RANGE_SEP}{to}"


def parse_time_range(raw: str | Sequence[str] | None) -> dict | None:
    """?time= -> {from?, to?} (a reversed range is swapped); malformed -> None (no period)."""
    if isinstance(raw, str):
        s = raw
    elif isinstance(raw, (list, tuple)):
        s = raw[0] if raw else None
    else:
        s = ""
    if not s or not isinstance(s, str) or TIME_RANGE_SEP not in s:
        return None
    raw_from, raw_to = s.split(TIME_RANGE_SEP)[:2]
    frm = raw_from if is_iso_day(raw_from) else None
    to = raw_to if is_iso_day(raw_to) else None
    if not frm and not to:
        return None
    if frm and to and frm > to:
        frm, to = to, frm
    out = {}
    if frm:
        out["from"] = frm
    if to:
        out["to"] = to
    return out


def _put(out: dict, key: str, value: Any) -> None:
    if value is not None:
        out[key] = value


def read_standard_filters(sp: dict, scope: dict | None = None, visible_groups: Sequence[str] | None = None,
                          surface: str | None = "standard") -> dict:
    """readStandardFilters: the panel's URL params -> StandardFilters. The scope's brand lock and
    allowed countries are injected; params of groups outside `visible_groups` are ignored;
    surface = "standard" | "website" (which account-country rule applies)."""
    surface = surface or "standard"
    vis = set(visible_groups) if visible_groups is not None else None

    def param(group: str):
        return None if vis is not None and group not in vis else sp.get(group)

    def many(v) -> list[str] | None:
        return split_filter_values(v) or None

    engine = many(param("engine"))
    scope_brand = [*scope["brands"], UMBRELLA_BRAND] if scope and not scope.get("all") and scope.get("brands") else None
    brand = scope_brand if scope_brand is not None else many(param("brand"))
    scope_countries = effective_website_scope_countries(scope) if surface == "website" else effective_scope_countries(scope)
    url_geo = many(param("geography"))
    if url_geo and scope_countries is not None:
        allowed = set(scope_countries)
        scope_brand_set = set(website_scope_brands((scope or {}).get("brands"), (scope or {}).get("countries")))
        intersected = [c for c in url_geo if c in allowed
                       or (is_website_brand_geo_code(c) and WEBSITE_BRAND_GEO_CODES[c] in scope_brand_set)]
        region = intersected or scope_countries
    else:
        region = url_geo if url_geo is not None else scope_countries
    time_range = parse_time_range(param("time"))
    lang = many(param("language"))
    out: dict[str, Any] = {}
    _put(out, "region", region)
    _put(out, "engine", [e.lower() for e in engine] if engine is not None else None)
    _put(out, "dateFrom", time_range.get("from") if time_range else None)
    _put(out, "dateTo", time_range.get("to") if time_range else None)
    _put(out, "funnelStage", many(param("promptContext")))
    _put(out, "brand", brand)
    _put(out, "brandPresence", many(param("brandPresence")))
    _put(out, "listType", many(param("listType")))
    _put(out, "depth1", many(param("depth1")))
    _put(out, "depth2", many(param("depth2")))
    _put(out, "depth3", many(param("depth3")))
    _put(out, "sourceCategory", many(param("source")))
    _put(out, "lang", [v.lower() for v in lang] if lang is not None else None)
    return out


def standard_filter_key(filters: dict) -> str:
    """standardFilterKey: stable cache/Suspense key of a filter set (axis values sorted)."""
    date_range = f"{filters.get('dateFrom') or ''}..{filters.get('dateTo') or ''}"
    axes = [",".join(js_sorted(filters.get(k) or [])) for k in STANDARD_FILTER_ARRAY_AXES]
    return "|".join([date_range, *axes])


def custom_field_param_name(field_id: str) -> str:
    return f"cf_{field_id}"


def read_project_custom_field_filters(sp: dict, fields: Sequence[dict]) -> dict | None:
    """cf_<fieldId> URL params of the project's custom fields -> {fieldId: values}; None when none."""
    out = {}
    for f in fields:
        values = split_filter_values(sp.get(custom_field_param_name(f["id"])))
        if values:
            out[f["id"]] = values
    return out or None


def read_project_custom_field_filters_raw(sp: dict) -> dict | None:
    """Every cf_<uuid> URL param -> {fieldId: values} (no field list needed); None when none."""
    out = {}
    for key, raw in sp.items():
        if not key.startswith("cf_"):
            continue
        field_id = key[3:]
        if not is_uuid(field_id):
            continue
        values = split_filter_values(raw)
        if values:
            out[field_id] = values
    return out or None


# ═══ F-1 filter options -> panel props ══════════════════════════════════════════════

async def fetch_filter_options(req: dict) -> dict:
    """GET /v1/filters/options with surface, project_id and the period only (+ geo_only).
    req = {surface, projectId?, dateFrom?, dateTo?, geoOnly?}. Returns {"data", "meta"}."""
    f = {k: req[k] for k in ("dateFrom", "dateTo") if req.get(k) is not None}
    query = analysis_query(f, {"surface": req["surface"], "projectId": req.get("projectId"), "scope": None})["query"]
    res = await api.get("filters/options", with_params(query, {"geo_only": True}) if req.get("geoOnly") else query)
    return {"data": res["data"], "meta": res.get("meta")}


def by_nullable_text(a: str | None, b: str | None) -> int:
    """PostgreSQL ASC: NULLs last, code-unit order for the rest."""
    if a == b:
        return 0
    if a is None:
        return 1
    if b is None:
        return -1
    return code_unit_compare(a, b)


_CATALOG_KEYS = (("brand", "brand"), ("brandPresence", "brand_presence"), ("listType", "list_type"),
                 ("depth1", "depth1"), ("depth2", "depth2"), ("depth3", "depth3"), ("depth4", "depth4"))
_CATALOG_ORDER = ("listType", "depth1", "depth2", "depth3", "brand", "brandPresence", "depth4")


def _catalog_cmp(a: dict, b: dict) -> int:
    for k in _CATALOG_ORDER:
        c = by_nullable_text(a[k], b[k])
        if c:
            return c
    return 0


def to_catalog_rows(catalog: dict | None) -> list[dict] | None:
    """data.catalog -> CatalogTaxonomyRow[] (funnel dropped, deduped, legacy order); no catalog -> None."""
    if not catalog:
        return None
    seen: dict[tuple, dict] = {}
    for r in catalog["rows"]:
        row = {camel: r.get(snake) for camel, snake in _CATALOG_KEYS}
        seen.setdefault(tuple(row.values()), row)
    return sort_by(list(seen.values()), _catalog_cmp)


def option_brands_for(scope: dict | None, requested: Sequence[str] | None = None) -> list[str] | None:
    """Brands the legacy option readers narrowed to: None = no narrowing, [] = common rows only."""
    narrowed = narrow_scope_brands(scope if scope is not None else {"all": True}, list(requested) if requested else None)
    if narrowed.get("all") or not narrowed.get("brands"):
        return None
    return [b for b in narrowed["brands"] if b != SCOPE_DENY_BRAND]


def _matrix_cmp(a: dict, b: dict) -> int:
    return (by_nullable_text(a["region"], b["region"]) or by_nullable_text(a["lang"], b["lang"])
            or by_nullable_text(a["brand"], b["brand"]))


_MISSING = object()


def narrow_geo_matrix(matrix: Sequence[dict], brands: Sequence[str] | None) -> list[dict]:
    """geo_matrix rows kept by a brand narrowing (brand-null rows always stay), legacy order."""
    allowed = set(brands) if brands is not None else None
    out = []
    for r in matrix:
        brand = r.get("brand", _MISSING)
        if allowed is not None and brand is not None and (brand is _MISSING or brand not in allowed):
            continue
        out.append({"brand": None if brand is _MISSING else brand, "region": r["region"], "lang": r.get("lang")})
    return sort_by(out, _matrix_cmp)


def region_options_of(matrix: Sequence[dict], brands: Sequence[str] | None) -> list[str]:
    """Distinct regions of the narrowed matrix, sorted."""
    return js_sorted(uniq(r["region"] for r in narrow_geo_matrix(matrix, brands)))


def language_options_of(matrix: Sequence[dict], brands: Sequence[str] | None) -> list[str]:
    """Distinct non-empty languages of the narrowed matrix, sorted."""
    return js_sorted(uniq(r["lang"] for r in narrow_geo_matrix(matrix, brands) if r["lang"]))


def to_dynamic_axes(fields: Sequence[dict] | None) -> list[dict]:
    """data.custom_fields -> DynamicAxis[] (values sorted with localeCompare)."""
    return [{"id": f["field_id"], "label": f["label"], "options": sort_by(list(f["values"]), locale_compare)}
            for f in (fields or [])]


def engine_options_of(engines: Sequence[dict]) -> list[str]:
    return [e["code"] for e in engines]


def default_engine_of(engines: Sequence[dict]) -> str | None:
    return next((e["code"] for e in engines if e.get("is_default")), None)


def _source_category_cmp(a: dict, b: dict) -> int:
    d = a["ord"] - b["ord"]
    return ((d > 0) - (d < 0)) or by_nullable_text(a.get("slug"), b.get("slug"))


def source_category_options_of(cats: Sequence[dict] | None) -> list[dict]:
    """Source categories in display order (ord, then slug)."""
    return sort_by(list(cats or []), _source_category_cmp)


def to_panel_options(res: dict, ctx: dict) -> dict:
    """F-1 answer -> PanelFilterOptions (the option props each surface's page passed).
    ctx = {surface, scope, filters: {brand?}}."""
    data = res["data"]
    matrix = data["geo_matrix"]
    out: dict[str, Any] = {}
    if ctx["surface"] == "project":
        _put(out, "catalogRows", to_catalog_rows(data.get("catalog")))
        out["geographyOptions"] = region_options_of(matrix, None)
        out["engineOptions"] = engine_options_of(data["engines"])
        out["dynamicAxes"] = to_dynamic_axes(data.get("custom_fields"))
        return out
    brands = option_brands_for(ctx.get("scope"), (ctx.get("filters") or {}).get("brand"))
    out["geographyOptions"] = region_options_of(matrix, brands)
    out["languageOptions"] = language_options_of(matrix, brands)
    if ctx["surface"] == "website":
        out["optionMatrix"] = narrow_geo_matrix(matrix, brands)
        return out
    _put(out, "catalogRows", to_catalog_rows(data.get("catalog")))
    out["optionMatrix"] = narrow_geo_matrix(matrix, None)
    return out


async def load_panel_options(req: dict) -> dict:
    """loadPanelOptions: one /v1/filters/options read -> PanelFilterOptions.
    req = {surface, projectId?, dateFrom?, dateTo?, geoOnly?, scope, filters: {brand?}}."""
    res = await fetch_filter_options(req)
    return to_panel_options(res, {"surface": req["surface"], "scope": req.get("scope"), "filters": req.get("filters") or {}})


def website_prompt_options_of(data: dict) -> dict:
    """/website/prompts option lists (lib/hgh/adapters/catalog.ts loadWebsitePromptOptions)."""
    return {"geographyOptions": js_sorted(uniq(r["code"] for r in data["regions"] if r.get("kind") != "virtual_brand")),
            "languageOptions": js_sorted(uniq(data["languages"])),
            "brandOptions": js_sorted(uniq(r.get("brand") for r in data["geo_matrix"] if r.get("brand")))}


async def load_website_prompt_options() -> dict:
    """GET /v1/filters/options?surface=website (no period) -> {geographyOptions, languageOptions, brandOptions}."""
    return website_prompt_options_of((await fetch_filter_options({"surface": "website"}))["data"])


# ═══ project gate, local read-only branch (lib/hgh/adapters/project-gate.ts) ═════════

def is_project_id(project_id: Any) -> bool:
    return is_uuid(project_id)


async def load_project_gate(project_id: str) -> dict | None:
    """fetchProjectGate in local read-only mode: GET /v1/gold/projects/{id}?view=gate -> GateProject;
    None for a non-uuid id (nothing read) or a project Gold does not have (404)."""
    if not is_project_id(project_id):
        return None
    try:
        res = await api.get(f"gold/projects/{project_id}", {"view": "gate"})
    except HTTPException as exc:
        if exc.status_code == 404:
            return None
        raise
    regions = res["data"]["project"].get("regions")
    return {"id": project_id, "name": project_id, "description": None, "createdAt": None, "brand": None,
            "country": regions[0] if regions and len(regions) == 1 else "", "ga4PropertyId": None, "myRole": None}


def project_locks(p: dict) -> dict:
    """F4 dimension locks of the project analysis and funnel pages (country only)."""
    locks = [{"group": "geography", "value": p["country"]}] if p.get("country") else []
    return {"locks": locks, "lockedGroups": [lock["group"] for lock in locks]}
