"""/website/prompts: filter options, one keyset page of the list, and the export file
(ports of lib/website/prompt-query.ts, lib/hgh/adapters/catalog.ts website list, the page's
Suspense key and the table's paging labels); /renewal/website/prompts (2026-10-30): one numbered
page of the same query (narrowed by the list's own picks), every row of it for the browser-built export, and
the list's insights — counts of the listed rows' own values (Gold's), nothing estimated or judged."""
from __future__ import annotations

import asyncio
import math
import re
from collections import Counter
from collections.abc import Mapping
from typing import Any

import icu
from fastapi import HTTPException

from data_server import api
from data_server.access import reader_scope
from data_server.screens import _xlsx, screen, split_context
from data_server.screens._filters import load_filter_dates, load_website_prompt_options, read_standard_filters, standard_filter_key
from data_server.screens._js import js_parse_int
from data_server.screens._period import kst_today
from data_server.screens._query import analysis_query, js_trim, to_api_params
from data_server.screens.mention_view import fill_trend_gaps

PAGE_SIZE = 50
PAGE_SIZES = (25, 50, 100)      # the renewal page's page sizes
READ_LIMIT = 20000              # one /v1/prompts page holds the whole website catalog (12,729 rows)
SORT_KEYS = ("prompt", "brand", "country", "lang", "targetUrl", "answers", "lastMeasuredAt", "firstMeasuredAt", "rounds")
SORT_API = {"prompt": "prompt", "brand": "brand", "country": "country", "lang": "lang",
            "targetUrl": "target_url", "answers": "answers", "lastMeasuredAt": "last_measured",
            "firstMeasuredAt": "first_measured", "rounds": "rounds"}
DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
CURSOR_RE = re.compile(r"[A-Za-z0-9_-]{1,8192}")
#: the legacy page's file (messages website.prompts.*, as the removed back/app/features/catalog/prompts/catalog/screen_export.py at git d77f278)
EXPORT_WORDS = {
    "ko": {"headers": ("프롬프트", "브랜드", "국가", "언어", "타겟 URL", "측정 횟수", "최근 측정", "측정 엔진"), "not_measured": "측정 없음", "file": "웹사이트-프롬프트", "sheet": "웹사이트 프롬프트"},
    "en": {"headers": ("Prompt", "Brand", "Country", "Language", "Target URL", "Measurements", "Last measured", "Engines"), "not_measured": "Not measured", "file": "website-prompts", "sheet": "Website Prompts"},
}
#: site codes that are no country (front lib/geo-catalog/pseudo-country.ts): the browser's Intl does not know them either
PSEUDO_COUNTRIES = {"SA-Dammam": {"ko": "사우디 아라비아 - 담맘", "en": "Saudi Arabia - Dammam"}, "SA-Jeddah": {"ko": "사우디 아라비아 - 제다", "en": "Saudi Arabia - Jeddah"},
                    "SA-Riyadh": {"ko": "사우디 아라비아 - 리야드", "en": "Saudi Arabia - Riyadh"}, "CN-BJ": {"ko": "중국-베이징", "en": "China-Beijing"}}
REGION_RE = re.compile(r"(?:[A-Z]{2}|[0-9]{3})")


def one(v: Any) -> Any:
    return v[0] if isinstance(v, list) else v


def is_admin(ctx: dict) -> bool:
    """The page passes the session role (the brand axis is admin-only)."""
    return ctx.get("admin") == "true"


def filter_groups(is_admin: bool) -> list[str]:
    return ["geography", "language", "engine", "time", *(["brand"] if is_admin else [])]


def read_cursor_param(raw: Any) -> str | None:
    return raw if isinstance(raw, str) and CURSOR_RE.fullmatch(raw) else None


def read_query(sp: dict, scope: dict | None, is_admin: bool) -> dict:
    """readWebsitePromptQuery: the one derivation shared by the page and the export."""
    raw = read_standard_filters(sp, scope, filter_groups(is_admin), "website")
    sort_param = one(sp.get("sort"))
    sort = sort_param if sort_param in SORT_KEYS else "lastMeasuredAt"
    direction = "asc" if one(sp.get("dir")) == "asc" else "desc"
    requested = js_parse_int(one(sp.get("page")) if one(sp.get("page")) is not None else "1")
    page = requested if not (isinstance(requested, float) and math.isnan(requested)) and requested > 0 else 1
    filters = {k: v for k, v in (("brands", raw.get("brand")), ("countries", raw.get("region")), ("langs", raw.get("lang")),
                                 ("search", one(sp.get("q"))), ("engines", raw.get("engine")),
                                 ("dateFrom", raw.get("dateFrom")), ("dateTo", raw.get("dateTo"))) if v is not None}
    return {"filters": filters, "sort": sort, "dir": direction, "page": page, "cursor": read_cursor_param(one(sp.get("cursor")))}


def list_query(req: dict, scope: dict | None) -> dict:
    """websitePromptQuery: analysisQuery on the website surface + search, sort, dir."""
    f = req["filters"]
    common = {k: v for k, v in (("brand", f.get("brands")), ("websiteCountry", f.get("countries")), ("region", f.get("countries")),
                                ("lang", f.get("langs")), ("engine", f.get("engines")), ("dateFrom", f.get("dateFrom")),
                                ("dateTo", f.get("dateTo"))) if v is not None}
    # websitePromptQuery keeps only the common query (no cf.* on the website surface).
    params = {"query": {**analysis_query(common, {"surface": "website", "scope": scope})["query"], "surface": "website"}}
    search = js_trim(f["search"]) if isinstance(f.get("search"), str) else None
    extra = {**({"search": search} if search else {}), "sort": SORT_API[req["sort"]], "dir": req["dir"]}
    return to_api_params(params, extra)


def request_query(sp: dict, is_admin: bool) -> dict:
    """The derivation chain as one pure function (golden-tested against the front's TS):
    readWebsitePromptQuery -> websitePromptQuery, plus the page/cursor read-back."""
    req = read_query(sp, reader_scope(), is_admin)
    return {"query": list_query(req, reader_scope()), "page": req["page"], "cursor": req["cursor"]}


def suspense_key(sp: dict, scope: dict | None, is_admin: bool) -> str:
    raw = read_standard_filters(sp, scope, filter_groups(is_admin), "website")
    rest = [one(sp.get(k)) for k in ("q", "sort", "dir", "page", "cursor")]
    return "|".join([standard_filter_key(raw), *(v if v is not None else "" for v in rest)])


def view_row(r: dict) -> dict:
    return {"id": r["website_prompt_id"], "promptText": r["prompt_text"], "brand": r["brand_code"],
            "countryCode": r["country_code"], "langCode": r["lang_code"], "targetUrl": r["target_url"],
            "domain": r["domain"], "answers": r["answers"], "lastMeasuredAt": r.get("last_measured"),
            "engines": list(r["engines"]), "firstMeasuredAt": r.get("first_measured"), "rounds": list(r.get("rounds") or []),
            "engineAnswers": dict(r.get("engine_answers") or {})}


def error_code(exc: HTTPException) -> str:
    """The code the HTTP route puts in the error envelope (data_server/app.py http_error)."""
    s = exc.status_code
    return "read_only" if s == 405 else "not_found" if s == 404 else "source_unavailable" if s >= 500 else "invalid_value"


async def list_page(base: dict, cursor: str | None) -> dict:
    async def read(c: str | None) -> dict:
        res = await api.get("prompts", {**base, "limit": PAGE_SIZE, **({"cursor": c} if c else {})})
        page = (res.get("meta") or {}).get("page") or {}
        rows = [view_row(r) for r in res["data"]["items"] if "website_prompt_id" in r]
        total = page.get("total")
        return {"rows": rows, "total": total if total is not None else len(rows), "nextCursor": page.get("next_cursor") or None}
    try:
        return {**await read(cursor), "restarted": False}
    except HTTPException as exc:
        code = error_code(exc)
        unusable = (exc.status_code == 409 and code == "cursor_stale") or (exc.status_code == 422 and code == "cursor_invalid")
        if cursor is not None and unusable:
            return {**await read(None), "restarted": True}
        raise


@screen("website/prompts-options")
async def prompts_options(q) -> dict:
    """Filter bar options + calendar + the list's Suspense key."""
    ctx, sp = split_context(q)
    options, dates = await asyncio.gather(load_website_prompt_options(), load_filter_dates("website", None, "all"))
    return {**options, "selectableDates": dates["selectableDates"], "listKey": suspense_key(sp, reader_scope(), is_admin(ctx))}


@screen("website/prompts-list")
async def prompts_list(q) -> dict:
    """WebsitePromptTable props, with the paging labels computed here."""
    ctx, sp = split_context(q)
    req = read_query(sp, reader_scope(), is_admin(ctx))
    res = await list_page(list_query(req, reader_scope()), req["cursor"])
    page = req["page"] if req["cursor"] and not res["restarted"] else 1
    total = res["total"]
    pages = max(1, math.ceil(total / PAGE_SIZE))
    return {"rows": res["rows"], "total": total, "page": page, "pageSize": PAGE_SIZE, "sort": req["sort"], "dir": req["dir"],
            "cursorPaging": {"nextCursor": res["nextCursor"]},
            "pages": pages, "rangeFrom": 0 if total == 0 else (page - 1) * PAGE_SIZE + 1, "rangeTo": min(page * PAGE_SIZE, total),
            "nextPage": page + 1}


def country_name(code: str | None, locale: str) -> str:
    """As the page prints a country (front countryName): a site code's own label, else ICU's name (the same as the browser's on every code in Gold), else the code."""
    if not code:
        return ""
    pseudo = PSEUDO_COUNTRIES.get(code.strip())
    if pseudo:
        return pseudo[locale]
    upper = code.strip().upper()
    return icu.Locale("und", upper).getDisplayCountry(icu.Locale(locale)) if REGION_RE.fullmatch(upper) else code


def language_name(code: str | None, locale: str) -> str:
    """As the page prints a language (front languageName)."""
    return icu.Locale(code.strip().lower().replace("-", "_")).getDisplayName(icu.Locale(locale)) if code else ""


def file_row(r: dict, locale: str) -> list:
    last = r["lastMeasuredAt"]
    return [r["promptText"], r["brand"], country_name(r["countryCode"], locale), language_name(r["langCode"], locale), r["targetUrl"], int(r["answers"] or 0),
            (last.isoformat() if hasattr(last, "isoformat") else last) or EXPORT_WORDS[locale]["not_measured"], ", ".join(r["engines"])]


@screen("website/prompts-export")
async def prompts_export(q) -> Any:
    """The legacy page's Excel button: every row of the list under the page's filters, in its order, in the page's 8 columns. The route names the file."""
    ctx, sp = split_context(q)
    req = read_query(sp, reader_scope(), is_admin(ctx))
    locale = ctx["locale"] if ctx.get("locale") in EXPORT_WORDS else "ko"
    words = EXPORT_WORDS[locale]
    rows = await all_rows(list_query(req, reader_scope()))
    day = kst_today()
    return _xlsx.attachment(_xlsx.workbook(words["sheet"], words["headers"], [file_row(r, locale) for r in rows]), f"{words['file']}-{day}.xlsx", ascii_name=f"website-prompts-{day}.xlsx")


async def all_rows(base: dict) -> list[dict]:
    """Every row of the query in the reader's order. The read is the same for each page of one query, so the
    pages share it (api.get keeps the answer under Gold's state)."""
    rows: list[dict] = []
    cursor: str | None = None
    while True:
        res = await api.get("prompts", {**base, "limit": READ_LIMIT, **({"cursor": cursor} if cursor else {})})
        rows.extend(view_row(r) for r in res["data"]["items"] if "website_prompt_id" in r)
        cursor = ((res.get("meta") or {}).get("page") or {}).get("next_cursor") or None
        if cursor is None:
            return rows


def read_size(raw: Any) -> int:
    size = js_parse_int(raw) if isinstance(raw, str) else PAGE_SIZE
    return size if size in PAGE_SIZES else PAGE_SIZE


def read_drill(sp: dict) -> dict:
    """The renewal list's own picks, made from its insights (one value each, malformed ones ignored):
    rd a round the prompt was measured in · miss a round it was not · last its latest round (none = unmeasured) ·
    eset its exact engine set (none = no engine)."""
    out: dict[str, Any] = {}
    for key in ("rd", "miss", "last"):
        v = one(sp.get(key))
        if isinstance(v, str) and (DAY_RE.fullmatch(v) or (key == "last" and v == "none")):
            out[key] = v
    eset = one(sp.get("eset"))
    if isinstance(eset, str) and eset:
        out["eset"] = "none" if eset == "none" else "~".join(sorted({e.lower() for e in eset.split("~") if e}))
    return out


def drilled(rows: list[dict], drill: dict) -> list[dict]:
    def keep(r: dict) -> bool:
        if "rd" in drill and drill["rd"] not in r["rounds"]:
            return False
        if "miss" in drill and drill["miss"] in r["rounds"]:
            return False
        if "last" in drill and (r["lastMeasuredAt"] or "none") != drill["last"]:
            return False
        return "eset" not in drill or ("~".join(sorted(r["engines"])) or "none") == drill["eset"]
    return [r for r in rows if keep(r)] if drill else rows


async def round_axis(req: dict, rows: list[dict]) -> list[str]:
    """The lens's rounds, oldest first: the website rounds shown (the panel's calendar) inside the period, with
    any round a row was measured in."""
    dates = (await load_filter_dates("website", None, "all"))["selectableDates"] or []
    f = req["filters"]
    lo, hi = f.get("dateFrom") or "", f.get("dateTo") or "9999-12-31"
    return sorted({d for d in dates if lo <= d <= hi} | {d for r in rows for d in r["rounds"]})


@screen("website/prompts-page")
async def prompts_page(q) -> dict:
    """The renewal list: page ?page of ?size (25/50/100) rows, filters, search and order as website/prompts-list,
    narrowed by the list's own picks (read_drill); a page past the end shows the last one. `roundAxis` = the
    lens's rounds, for the detail sheet's measured-rounds strip."""
    ctx, sp = split_context(q)
    req = read_query(sp, reader_scope(), is_admin(ctx))
    listed = await all_rows(list_query(req, reader_scope()))
    rows = drilled(listed, read_drill(sp))
    size = read_size(one(sp.get("size")))
    total = len(rows)
    pages = max(1, math.ceil(total / size))
    page = min(req["page"], pages)
    start = (page - 1) * size
    return {"rows": rows[start:start + size], "total": total, "listed": len(listed), "page": page, "pages": pages,
            "pageSize": size, "rangeFrom": 0 if total == 0 else start + 1, "rangeTo": min(start + size, total),
            "sort": req["sort"], "dir": req["dir"], "roundAxis": await round_axis(req, listed)}


@screen("website/prompts-rows")
async def prompts_rows(q) -> dict:
    """Every row of the renewal list (its picks included) in list order (its xlsx is built in the browser)."""
    ctx, sp = split_context(q)
    req = read_query(sp, reader_scope(), is_admin(ctx))
    listed = await all_rows(list_query(req, reader_scope()))
    return {"rows": drilled(listed, read_drill(sp)), "roundAxis": await round_axis(req, listed)}


def round_slots(axis: list[str], counts: Mapping[str, int]) -> list[dict]:
    """Measured prompts per round of the lens, oldest first. A week with no round between them is a slot without a
    count (`prompts` null): rounds are weekly, and Gold has no job on 2026-07-31."""
    points = [{"bucketStart": d} for d in axis]
    return [{"date": p["bucketStart"], "prompts": None if p.get("gap") else counts.get(p["bucketStart"], 0)}
            for p in fill_trend_gaps(points, "week", lambda k: {"bucketStart": k, "gap": True})]


def insights_of(rows: list[dict], axis: list[str]) -> dict:
    """What the listed rows hold, counted: what is measured, where and how steadily: the rounds each prompt was
    measured in, its engine sets, and its brands and countries (with the counts of its target sites and languages)."""
    brands = Counter(r["brand"] for r in rows)
    markets: dict[str, dict] = {}
    for r in rows:
        m = markets.setdefault(r["countryCode"], {"prompts": 0, "brands": {}})
        m["prompts"] += 1
        m["brands"][r["brand"]] = m["brands"].get(r["brand"], 0) + 1
    sets = Counter("~".join(sorted(r["engines"])) for r in rows)
    return {
        "prompts": len(rows),
        "engines": sorted({code for r in rows for code in r["engineAnswers"]}),
        "rounds": round_slots(axis, Counter(d for r in rows for d in r["rounds"])),
        "engineSets": [{"engines": k.split("~") if k else [], "prompts": n} for k, n in sorted(sets.items(), key=lambda kv: (-kv[1], kv[0]))],
        "brands": [k for k, _ in sorted(brands.items(), key=lambda kv: (-kv[1], kv[0]))],
        "markets": [{"country": k, **v} for k, v in sorted(markets.items(), key=lambda kv: (-kv[1]["prompts"], kv[0]))],
        "langCount": len({r["langCode"] for r in rows}),
        "siteCount": len({r["domain"] for r in rows}),
    }


@screen("website/prompts-insights")
async def prompts_insights(q) -> dict:
    """The renewal list's insights over its filters, search and lens (not its own picks, which the insights
    highlight): every number is a count or a sum of the listed rows' Gold values."""
    ctx, sp = split_context(q)
    req = read_query(sp, reader_scope(), is_admin(ctx))
    rows = await all_rows(list_query(req, reader_scope()))
    return insights_of(rows, await round_axis(req, rows))
