"""Filter state -> /v1 query, in one place (port of front/lib/hgh/query.ts and of analysisQuery /
hasClosedPeriod in front/lib/hgh/adapters/filters.ts), plus the account-scope rules both the URL
reader and the serializer read (lib/rhq effectiveScopeCountries, lib/scope/website-virtual-geo,
lib/scope/hmg-brands narrowScopeBrands).

Conventions (so a TS call ports mechanically and the function goldens call these with the TS args):
- Signatures follow the TS functions; a TS object is a dict with the same camelCase keys.
- A key TS leaves undefined is absent; a top-level undefined (argument or return) is None.
- JS semantics: String#trim (js_trim), ASCII-only \\d, `$` = end of string (fullmatch),
  default array sort = UTF-16 code-unit order, Set = insertion-ordered dedupe.

The result of common_query/analysis_query is {"query": {...}, "cf"?: {...}} like the TS
CommonFilterParams; to_api_params() flattens it into the params api.get sends.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from bff.screens._sort import code_unit_key

KST = ZoneInfo("Asia/Seoul")

# ── JS string semantics ──────────────────────────────────────────────────────

# String.prototype.trim: WhiteSpace (TAB VT FF SP NBSP ZWNBSP + Zs) and LineTerminator (LF CR LS PS).
# Python's str.strip() differs (it also strips U+001C..U+001F and U+0085, but not U+FEFF).
_JS_WS = ("\t\n\v\f\r              "
          "    　﻿")


def js_trim(s: str) -> str:
    return s.strip(_JS_WS)


_ISO_DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I | re.A)


def is_iso_day(v: Any) -> bool:
    """/^\\d{4}-\\d{2}-\\d{2}$/.test(v) for a string."""
    return isinstance(v, str) and _ISO_DAY.fullmatch(v) is not None


def is_uuid(v: Any) -> bool:
    """/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) for a string."""
    return isinstance(v, str) and _UUID.fullmatch(v) is not None


def js_sorted(values) -> list[str]:
    """[...values].sort() on strings (UTF-16 code-unit order)."""
    return sorted(values, key=code_unit_key)


def uniq(values) -> list:
    """[...new Set(values)] (first occurrence order)."""
    return list(dict.fromkeys(values))


# ── account scope (lib/scope/website-virtual-geo, lib/rhq, lib/scope/hmg-brands) ──

UMBRELLA_BRAND = "HMG"
SCOPE_DENY_BRAND = UMBRELLA_BRAND
SCOPE_DENY_COUNTRY = "ZZ"
# Every scope (the administrator's). The screens read with the request account's (bff/access.py reader_scope()).
READER_SCOPE: dict = {"all": True}

WEBSITE_BRAND_GEO_CODES = {"HYUNDAI-N": "Hyundai N"}
WEBSITE_DEDICATED_SITE_CODES = ("worldwide", "CPO", *WEBSITE_BRAND_GEO_CODES)
WEBSITE_SITE_GLOBAL_MARKETS = {"HYUNDAI-N": ("US", "KR")}
WEBSITE_SITE_BRAND_PARENT = {"Hyundai N": "Hyundai"}

# lib/rhq/_data/rhq-map.json: RHQ region id -> ISO countries (definition order).
RHQ_REGION_COUNTRIES: dict[str, tuple[str, ...]] = {
    "hyundai-europe": ("AL", "AM", "AT", "AZ", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "GE", "DE", "GR", "HU", "IS", "IE", "IT", "KZ", "KG", "LV", "LT", "LU", "MK", "MT", "MD", "NL", "NO", "PL", "PT", "RO", "RU", "RS", "SK", "SI", "ES", "SE", "CH", "TJ", "TM", "TR", "GB", "UA", "UZ"),
    "hyundai-asia-pacific": ("AS", "AU", "BD", "BT", "BN", "KH", "CN", "TL", "FM", "FJ", "PF", "GU", "HK", "IN", "ID", "JP", "KR", "LA", "MO", "MY", "MH", "MN", "MM", "NP", "NC", "NZ", "PH", "MP", "SG", "SB", "LK", "TH", "TO", "VU", "VN", "WS"),
    "hyundai-latin-america": ("AG", "AR", "AW", "BS", "BB", "BM", "BO", "BR", "KY", "CL", "CO", "CR", "CU", "CW", "DO", "EC", "SV", "GF", "GD", "GP", "GT", "GY", "HT", "HN", "JM", "MQ", "NI", "PA", "PY", "PE", "PR", "KN", "LC", "MF", "VC", "SR", "TT", "UY", "VE"),
    "hyundai-africa": ("DZ", "AO", "BJ", "BF", "CM", "CF", "TD", "CG", "CD", "DJ", "EG", "ET", "GM", "GH", "GN", "GW", "CI", "KE", "LR", "LY", "MG", "ML", "MR", "MU", "MA", "MZ", "NE", "NG", "RE", "RW", "SN", "SC", "SL", "ZA", "SD", "TG", "TN", "ZM", "ZW"),
    "hyundai-middle-east": ("AF", "BH", "IQ", "IL", "JO", "KW", "LB", "OM", "PK", "PS", "QA", "SA", "AE", "YE"),
    "hyundai-north-america": ("CA", "MX", "US"),
    "kia-asia-pacific": ("AU", "BD", "BT", "BN", "KH", "CN", "FJ", "HK", "IN", "ID", "JP", "KR", "LA", "MO", "MY", "MN", "MM", "NP", "NZ", "PK", "PH", "SG", "LK", "TW", "TH", "VN", "SB"),
    "kia-western-europe": ("AT", "BE", "CZ", "DK", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT", "LU", "MT", "NL", "NO", "PL", "SK", "PT", "ES", "SE", "CH", "GB"),
    "kia-eastern-europe": ("AM", "AZ", "BY", "BA", "BG", "HR", "CY", "EE", "GE", "KZ", "XK", "KG", "LV", "LT", "MD", "ME", "RO", "RU", "RS", "SI", "TR", "UA", "UZ", "TJ"),
    "kia-middle-east": ("BH", "IL", "JO", "KW", "LB", "IQ", "OM", "PS", "QA", "SA", "AE", "YE", "SY"),
    "kia-africa": ("DZ", "AO", "CM", "EG", "CI", "KE", "MU", "MA", "RE", "SC", "ZA", "SD", "TN", "GH", "LY"),
    "kia-north-america": ("CA", "US"),
    "kia-central-south-america": ("AR", "AW", "BZ", "BO", "BR", "DM", "KY", "CL", "CR", "CW", "CO", "EC", "SV", "GT", "HN", "JM", "MQ", "MX", "NI", "PA", "PY", "PE", "PR", "TT", "UY"),
    "genesis-asia-pacific": ("KR", "AU", "CN", "KZ", "ID"),
    "genesis-middle-east": ("BH", "KW", "OM", "QA", "SA", "AE", "IL"),
    "genesis-north-america": ("CA", "US", "PR"),
    "genesis-europe": ("DE", "GB", "CH", "RU", "NL", "ES", "IT", "FR"),
    "genesis-africa": ("MU", "EG", "TN"),
}


# lib/geo-catalog/pseudo-country.ts PSEUDO_COUNTRIES scopeParent: a website city site a scope with its country also
# reads (Genesis Saudi Arabia's city sites). CN-BJ has none on purpose (the Beijing Hyundai site is its own account's).
PSEUDO_COUNTRY_SCOPE_PARENT = {"SA-Dammam": "SA", "SA-Jeddah": "SA", "SA-Riyadh": "SA"}


def with_pseudo_countries(countries) -> list[str]:
    """withPseudoCountries: the countries, then the city sites whose scopeParent is one of them (website)."""
    out = list(countries or [])
    seen = {c.upper() for c in out}
    for code, parent in PSEUDO_COUNTRY_SCOPE_PARENT.items():
        if parent in seen and code.upper() not in seen:
            out.append(code)
            seen.add(code.upper())
    return out


def is_website_brand_geo_code(code: str) -> bool:
    return code in WEBSITE_BRAND_GEO_CODES


def website_dedicated_codes(countries) -> list[str]:
    return [c for c in (countries or []) if c in WEBSITE_DEDICATED_SITE_CODES]


def site_account_global_countries(countries) -> list[str] | None:
    dedicated = website_dedicated_codes(countries)
    if not dedicated:
        return None
    out = [c for c in (countries or []) if c not in WEBSITE_DEDICATED_SITE_CODES]
    for code in dedicated:
        for c in WEBSITE_SITE_GLOBAL_MARKETS.get(code, ()):
            if c not in out:
                out.append(c)
    return out


def website_scope_brands(brands, countries) -> list[str]:
    out = list(brands or [])
    if not out:
        return out
    for code in countries or []:
        site_brand = WEBSITE_BRAND_GEO_CODES.get(code)
        if not site_brand or site_brand in out:
            continue
        parent = WEBSITE_SITE_BRAND_PARENT.get(site_brand)
        if parent and parent in out:
            out.append(site_brand)
    return out


def _region_scope_countries(regions) -> list[str] | None:
    out: dict[str, None] = {}
    for rid in regions or []:
        for c in RHQ_REGION_COUNTRIES.get(rid, ()):
            out[c] = None
    return list(out) or None


def effective_scope_countries(scope: dict | None) -> list[str] | None:
    """lib/rhq effectiveScopeCountries (global surface): allowed ISO countries, None = no limit."""
    if scope is None or scope.get("all"):
        return None
    countries = scope.get("countries")
    site_global = site_account_global_countries(countries)
    if site_global is not None:
        return site_global if site_global else website_dedicated_codes(countries)
    if countries:
        return list(countries)
    return _region_scope_countries(scope.get("regions"))


def effective_website_scope_countries(scope: dict | None) -> list[str] | None:
    """lib/rhq effectiveWebsiteScopeCountries: the website surface's allowed site codes, None = no limit."""
    if scope is None or scope.get("all"):
        return None
    countries = scope.get("countries")
    dedicated = website_dedicated_codes(countries)
    if dedicated:
        return dedicated
    if countries:
        return list(countries)
    return _region_scope_countries(scope.get("regions"))


def narrow_scope_brands(scope: dict, requested_brands: list[str] | None = None) -> dict:
    """lib/scope/hmg-brands narrowScopeBrands: the account scope narrowed by the screen's brand choice."""
    if not requested_brands:
        return scope
    brands = scope.get("brands")
    if scope.get("all") or not brands:
        return {**scope, "all": False, "brands": requested_brands}
    scoped = [b for b in brands if b in requested_brands]
    return {**scope, "brands": scoped or list(brands)}


# ── CommonFilters ────────────────────────────────────────────────────────────

COMMON_QUERY_KEYS = ("surface", "project_id", "brand", "country", "lang", "engine", "from", "to", "funnel",
                     "brand_presence", "list_type", "depth1", "depth2", "depth3", "source")
CF_PREFIX = "cf."
API_DATE_MIN = "2000-01-01"
API_DATE_MAX = "2100-12-31"

CITATION_CATEGORY_SLUGS = {
    "Official (HMG)": "officialHmg",
    "Official (Competitor)": "officialCompetitor",
    "Dealer & Marketplace": "dealerMarketplace",
    "Automotive Media": "automotiveMedia",
    "News & Media": "newsMedia",
    "Community & Forums": "communityForums",
    "Social & Video": "socialVideo",
    "Blogs & Reviews": "blogsReviews",
    "Wiki & Reference": "wikiReference",
    "Government & Public": "governmentPublic",
    "Award & Certification": "awardCertification",
    "Academic & Research": "academicResearch",
    "Other": "other",
}
_SLUG_SET = frozenset(CITATION_CATEGORY_SLUGS.values())


class HghQueryError(ValueError):
    """lib/hgh/query.ts HghQueryError: project_id_required, open_ended_range_needs_bounds,
    common_key_override, invalid_custom_field."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def today_kst(now: datetime | str | None = None) -> str:
    """todayKst / kstToday: the KST calendar day (YYYY-MM-DD) of `now` (default: the current instant).
    A string is an ISO instant with Z or an offset (Date#toISOString form)."""
    if now is None:
        instant = datetime.now(timezone.utc)
    elif isinstance(now, str):
        instant = datetime.fromisoformat(now)
    else:
        instant = now
    if instant.tzinfo is None:
        raise ValueError("today_kst needs an aware instant")
    return instant.astimezone(KST).date().isoformat()


def is_open_ended_range(f: dict) -> bool:
    """True when exactly one end of the URL range is set."""
    return bool(f.get("dateFrom")) != bool(f.get("dateTo"))


def clamp_day(d: str) -> str:
    if d < API_DATE_MIN:
        return API_DATE_MIN
    if d > API_DATE_MAX:
        return API_DATE_MAX
    return d


def resolve_date_range(f: dict, bounds: dict | None, today: str | None = None) -> dict | None:
    """from/to for the API, or None (no period). A one-sided range is closed with the
    /v1/filters/dates bounds (from: firstMeasuredDate, to: latestRoundDate, else today KST)."""
    if today is None:
        today = today_kst()
    raw_from = f.get("dateFrom") if f.get("dateFrom") and is_iso_day(f.get("dateFrom")) else None
    raw_to = f.get("dateTo") if f.get("dateTo") and is_iso_day(f.get("dateTo")) else None
    if not raw_from and not raw_to:
        return None
    if raw_from and raw_to:
        a, b = (raw_from, raw_to) if raw_from <= raw_to else (raw_to, raw_from)
        return {"from": clamp_day(a), "to": clamp_day(b)}
    if bounds is None:
        raise HghQueryError("open_ended_range_needs_bounds", "one-sided date range: pass dateBounds from GET /v1/filters/dates")
    frm, to = raw_from, raw_to
    if not to:
        latest = bounds.get("latestRoundDate")
        to = latest if latest and is_iso_day(latest) else today
    if not frm:
        first = bounds.get("firstMeasuredDate")
        frm = first if first and is_iso_day(first) else to
    frm, to = clamp_day(frm), clamp_day(to)
    if frm > to:
        to = frm
    return {"from": frm, "to": to}


def _uniq_sorted(values, fn=None) -> list[str]:
    if not values:
        return []
    out: dict[str, None] = {}
    for raw in values:
        v = js_trim(fn(raw) if fn else raw)
        if v:
            out[v] = None
    return js_sorted(out)


def _lower(v: str) -> str:
    return v.lower()


def source_slug(value: str) -> str:
    """URL source name ('Official (HMG)') -> slug ('officialHmg'). Slugs pass; unknown names pass raw."""
    if value in _SLUG_SET:
        return value
    return CITATION_CATEGORY_SLUGS.get(value, value)


def url_countries(countries: list[str] | None, scope: dict | None) -> list[str]:
    """Countries chosen in the URL, or [] when they are the scope injection of read_standard_filters."""
    values = _uniq_sorted(countries)
    if not values:
        return []
    injected = effective_scope_countries(scope)
    if injected and set(values) == set(injected):
        return []
    return values


def url_brands(brands: list[str] | None, scope: dict | None) -> list[str]:
    """Brand values chosen in the URL, or [] when read_standard_filters applied the brand lock."""
    locked = bool(scope and not scope.get("all") and scope.get("brands"))
    return [] if locked else _uniq_sorted(brands)


def card_param(surface: str, on: bool | None) -> dict:
    """{card: true} for a global or website card read, else {}."""
    return {"card": True} if on and surface != "project" else {}


def with_params(common: dict, extra: dict) -> dict:
    """Feature params added to a common query; a CommonFilters name or cf.* key is refused."""
    for key in extra:
        if key in COMMON_QUERY_KEYS or key.startswith(CF_PREFIX):
            raise HghQueryError("common_key_override", f'withParams: "{key}" is a common filter key')
    return {**common, **extra}


def common_query(f: dict, ctx: dict) -> dict:
    """toCommonQuery: StandardFilters -> {"query": CommonQuery, "cf"?: {fieldId: values}}.
    ctx = {surface, projectId?, scope, customFields?, dateBounds?, today?}."""
    surface = ctx.get("surface")
    if surface == "project" and not ctx.get("projectId"):
        raise HghQueryError("project_id_required", "surface=project needs projectId")
    today = ctx.get("today")
    rng = resolve_date_range(f, ctx.get("dateBounds") if is_open_ended_range(f) else None,
                             today if today is not None else today_kst())
    query: dict[str, Any] = {"surface": surface}
    if ctx.get("projectId") and surface != "global":
        query["project_id"] = ctx["projectId"]
    if rng:
        query["from"] = rng["from"]
        query["to"] = rng["to"]
    scope = ctx.get("scope")

    def put(key: str, values: list[str]) -> None:
        if values:
            query[key] = values

    put("brand", url_brands(f.get("brand"), scope))
    put("brand_presence", _uniq_sorted(f.get("brandPresence")))
    region = f.get("websiteCountry") if surface == "website" and f.get("websiteCountry") is not None else f.get("region")
    put("country", url_countries(region, scope))
    put("depth1", _uniq_sorted(f.get("depth1")))
    put("depth2", _uniq_sorted(f.get("depth2")))
    put("depth3", _uniq_sorted(f.get("depth3")))
    put("engine", _uniq_sorted(f.get("engine"), _lower))
    put("funnel", _uniq_sorted(f.get("funnelStage")))
    put("lang", _uniq_sorted(f.get("lang"), _lower))
    put("list_type", _uniq_sorted(f.get("listType")))
    put("source", _uniq_sorted(f.get("sourceCategory"), source_slug))

    cf: dict[str, list[str]] | None = None
    custom = ctx.get("customFields")
    if surface == "project" and custom:
        for field_id, raw in custom.items():
            if not is_uuid(field_id):
                continue
            values = _uniq_sorted(raw)
            if values:
                cf = cf if cf is not None else {}
                cf[field_id.lower()] = values
    return {"query": query, "cf": cf} if cf else {"query": query}


def analysis_query(f: dict, ctx: dict) -> dict:
    """analysisQuery: common_query, except a one-sided period is sent as that end alone
    (the backend closes it), so no /v1/filters/dates read is needed first."""
    if not is_open_ended_range(f):
        return common_query(f, ctx)
    out = common_query({k: v for k, v in f.items() if k not in ("dateFrom", "dateTo")}, ctx)
    if f.get("dateFrom") and is_iso_day(f.get("dateFrom")):
        out["query"]["from"] = clamp_day(f["dateFrom"])
    elif f.get("dateTo") and is_iso_day(f.get("dateTo")):
        out["query"]["to"] = clamp_day(f["dateTo"])
    return out


def has_closed_period(f: dict) -> bool:
    """Both ends of a period are set and ordered."""
    a, b = f.get("dateFrom"), f.get("dateTo")
    return bool(a and b and is_iso_day(a) and is_iso_day(b) and a <= b)


def to_api_params(params: dict, extra: dict | None = None) -> dict:
    """{"query", "cf"?} (+ feature params through with_params) -> the flat params for api.get:
    query keys, the extra params and cf.<lowercase uuid> keys (lib/hgh/query toSearchParams)."""
    out = with_params(params["query"], extra) if extra else dict(params["query"])
    for field_id, values in (params.get("cf") or {}).items():
        if not is_uuid(field_id):
            raise HghQueryError("invalid_custom_field", f"cf field id is not a UUID: {field_id[:40]}")
        out[f"{CF_PREFIX}{field_id.lower()}"] = list(values)
    return out
