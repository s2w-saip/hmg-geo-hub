"""Screens read straight from the Gold/HUB sources: GA4 conversion, SEO visibility, projects,
keyword and social research (components/source-*.tsx, gold-*.tsx)."""
from __future__ import annotations

import math
from typing import Any

from bff import api
from bff.screens import screen, split_context
from bff.screens._filters import parse_time_range, split_filter_values
from bff.screens._js import is_num, js_number, js_str

SOURCE_AXES = (("geography", "country"), ("language", "lang"), ("visitorType", "visitor_type"),
               ("brand", "brand"), ("engine", "engine"), ("device", "device"))
PAGE_SIZE = 50  # gold readers' default page (context.limit default)


def truthy(v: Any) -> bool:
    return bool(v) if not isinstance(v, list) else True


def source_query(sp: dict) -> dict:
    """components/source-data-ui.tsx sourceQuery: every URL param, then the UI axes renamed."""
    query: dict = {k: v for k, v in sp.items() if v is not None}
    for ui, name in SOURCE_AXES:
        if truthy(sp.get(ui)):
            query[name] = split_filter_values(sp[ui])
    period = sp.get("period")
    if truthy(period):
        text = ",".join(period) if isinstance(period, list) else str(period)
        query["days"] = text[:-1] if text.endswith("d") else text
    rng = parse_time_range(sp.get("time"))
    if rng and rng.get("from"):
        query["from"] = rng["from"]
    if rng and rng.get("to"):
        query["to"] = rng["to"]
    return query


def prev_cursor(sp: dict) -> str | None:
    """SourcePager: Number(sp.cursor ?? 0); a link back by one page when it is above 0."""
    current = js_number(sp.get("cursor", 0))
    if not (isinstance(current, (int, float)) and not math.isnan(current) and current > 0):
        return None
    return js_str(max(0, current - PAGE_SIZE))


def day_of(ts: Any) -> str | None:
    """`ts?.slice(0, 10)`: the leading date of the ISO string as sent (UTC for timestamptz)."""
    return ts[:10] if isinstance(ts, str) else None


@screen("sources/analytics")
async def analytics(q) -> dict:
    ctx, sp = split_context(q)
    kind = ctx.get("kind", "conversion")
    query = source_query(sp)
    if ctx.get("project_id"):
        query["project_id"] = ctx["project_id"]
    res = await api.get(f"analytics/{kind}", query)
    for row in res["data"].get("windows") or []:
        row["filter_all"] = all(is_num(row.get(k)) and row[k] == 0 for k in ("engine_mask", "device_mask", "nvr_mask"))
    return res


@screen("projects/list")
async def projects_list(q) -> dict:
    data = (await api.get("gold/projects"))["data"]
    for p in data["items"]:
        p["last_measured_day"] = day_of(p.get("last_measured"))
    return data


KPI_KEYS = ("visibility", "share_of_voice", "sentiment", "citation_share")


@screen("projects/detail")
async def project_detail(q) -> dict:
    ctx, _ = split_context(q)
    pid = ctx["project_id"]
    data = (await api.get(f"gold/projects/{pid}"))["data"]
    for p in data.get("prompts") or []:
        p["last_measured_day"] = day_of(p.get("last_measured"))
    if ctx.get("kpis") == "true":
        summary = await api.get("kpi/summary", {"surface": "project", "project_id": pid})
        values = {}
        for key in KPI_KEYS:
            r = summary["data"].get(key)
            values[key] = 100 * r["num"] / r["den"] if isinstance(r, dict) and r.get("den") else None
        data["kpis"] = values
    return data


def distinct(values: list) -> list:
    return list(dict.fromkeys(values))


@screen("intent/keywords")
async def keywords(q) -> dict:
    _, sp = split_context(q)
    res = await api.get("gold/keywords", {k: v for k, v in sp.items() if v is not None})
    data, meta = res["data"], res["meta"]
    data["location_options"] = distinct([js_str(js_number(r.get("location_code"))) for r in data.get("markets") or []])
    data["language_options"] = distinct([js_str(r.get("language_code")) if r.get("language_code") is not None else "null" for r in data.get("markets") or []])
    for r in data.get("items") or []:
        # String(r.seed_kw_key ?? r.kw_key)
        if r.get("seed_kw_key") is not None:
            r["keyword_ref"] = js_str(r["seed_kw_key"])
        else:
            r["keyword_ref"] = "undefined" if "kw_key" not in r else "null" if r["kw_key"] is None else js_str(r["kw_key"])
    page = meta.get("page") or {}
    data["pager"] = {"total": page.get("total"), "next": page.get("next_cursor"), "prev": prev_cursor(sp)}
    return data


@screen("intent/social")
async def social(q) -> dict:
    _, sp = split_context(q)
    res = await api.get("gold/social", {k: v for k, v in sp.items() if v is not None})
    data, meta = res["data"], res["meta"]
    if (data.get("tab") or "contexts") == "combinations":
        for r in data.get("items") or []:
            # r.description ?? [r.condition_a, r.condition_b].filter(Boolean).join(" · ")
            label = r.get("description")
            r["label"] = label if label is not None else " · ".join(js_str(v) for v in (r.get("condition_a"), r.get("condition_b")) if v)
    stats = data.get("stats") or {}
    data["research_runs_shown"] = stats.get("research_runs") or None
    data["claims_shown"] = stats.get("claims") or None
    detail = data.get("detail")
    if isinstance(detail, dict) and ("evidence" in detail or "combination_evidence" in detail):
        rows = [r for k in ("evidence", "combination_evidence") for r in (detail.get(k) if isinstance(detail.get(k), list) else [])]
        for r in rows:
            label = next((r.get(k) for k in ("source_title", "source_host", "source_url") if r.get(k) is not None), None)
            r["source_label"] = label
        data["evidence_rows"] = rows
    page = meta.get("page") or {}
    data["pager"] = {"total": page.get("total"), "next": page.get("next_cursor"), "prev": prev_cursor(sp)}
    return data
