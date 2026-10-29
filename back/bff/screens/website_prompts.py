"""/website/prompts: filter options, one keyset page of the list, and the export relay
(ports of lib/website/prompt-query.ts, lib/hgh/adapters/catalog.ts website list, the page's
Suspense key and the table's paging labels)."""
from __future__ import annotations

import asyncio
import math
import re
from typing import Any

from fastapi import HTTPException

from bff import api
from bff.access import reader_scope
from bff.screens import screen, split_context
from bff.screens._filters import load_filter_dates, load_website_prompt_options, read_standard_filters, standard_filter_key
from bff.screens._js import js_parse_int
from bff.screens._query import analysis_query, js_trim, to_api_params

PAGE_SIZE = 50
SORT_KEYS = ("prompt", "brand", "country", "lang", "targetUrl", "answers", "lastMeasuredAt")
SORT_API = {"prompt": "prompt", "brand": "brand", "country": "country", "lang": "lang",
            "targetUrl": "target_url", "answers": "answers", "lastMeasuredAt": "last_measured"}
CURSOR_RE = re.compile(r"[A-Za-z0-9_-]{1,8192}")


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
            "engines": list(r["engines"])}


def error_code(exc: HTTPException) -> str:
    """The code the HTTP route puts in the error envelope (bff/app.py http_error)."""
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


@screen("website/prompts-export")
async def prompts_export(q) -> Any:
    """The export relay body: /v1/prompts for the same query + format=xlsx, columns=screen, locale."""
    ctx, sp = split_context(q)
    req = read_query(sp, reader_scope(), is_admin(ctx))
    return await api.get("prompts", {**list_query(req, reader_scope()), "format": "xlsx", "columns": "screen", "locale": ctx.get("locale", "ko")})
