"""Renewal Project tab (menu option D, 2026-11-03): the filter panel of the project pages and the Dashboard.

The Dashboard lays out the website Overview's sections on the project surface (Gold surface 3), read with the
project's filters (screens._filters.project_page_filters: 기간 · 측정 국가 · AI 엔진 · custom tags):
  projects/filters             the panel's options and calendar (custom tags = Gold dim_custom_field · prompt_custom_value)
  projects/as-of               the round the page shows (the header's 측정 회차 chip)
  projects/dash-summary        the KPI tiles at card speed (kpi/summary; 당사 = Gold's default perspective, HMG)
  projects/dash-summary-deferred   the same tiles with the engine badge and the round Δ (trend) merged in
  projects/dash-engines        the engine rows behind the badge (kpi/engines)
  projects/dash-composition    the source composition (citations/domains, top 7 + 기타)
  projects/dash-trend          the KPI trend (None under two rounds)
  projects/dash-status         the project's Gold facts and its latest measured prompts
Project reads are live only: no service week and no period compare (the original project page had neither). Every
value is Gold's; nothing is judged or added (a value Gold does not have is left to the page's '데이터 없음').
Scoped accounts never get here: access.clamp refuses every surface=project read (F20)."""
from __future__ import annotations

import asyncio

from bff import api
from bff.screens import screen, split_context
from bff.screens._convert import as_of_date
from bff.screens._filters import load_filter_dates, load_panel_options, project_page_filters
from bff.screens._query import analysis_query, to_api_params
from bff.screens.overview import (
    SOURCE_TOP_N,
    WEBSITE_OVERVIEW_TREND_METRICS,
    deferred_kpis,
    engines_view,
    fetch_dashboard_domains,
    fetch_dashboard_summary,
    fetch_engine_rows,
    is_transient,
    load_live_kpis,
    load_live_trend,
    or_none_on_transient,
    tiles_view,
    to_source_slices,
    trend_chart_view,
)
from bff.screens.sources import day_of

#: the latest measured prompts the Dashboard lists (the original's 최근 프롬프트 card)
RECENT_PROMPTS = 8


def _common(q) -> tuple[dict, dict, dict]:
    """(route ctx, filters, flat api params) of a project page request."""
    ctx, sp = split_context(q)
    filters, actx = project_page_filters(sp, ctx.get("project_id"))
    return ctx, filters, to_api_params(analysis_query(filters, actx))


@screen("projects/filters")
async def project_filters(q) -> dict:
    """The panel's option props (측정 국가 · AI 엔진 · custom tags) and the round calendar of the project (ctx.family:
    mentions (default) | citations). The period narrows the options as on the other pages."""
    ctx, sp = split_context(q)
    filters, _ = project_page_filters(sp, ctx.get("project_id"))
    pid = ctx["project_id"]
    options, dates = await asyncio.gather(
        load_panel_options({"surface": "project", "projectId": pid, "dateFrom": filters.get("dateFrom"),
                            "dateTo": filters.get("dateTo"), "scope": None, "filters": filters}),
        load_filter_dates("project", pid, ctx.get("family") or "mentions"))
    return {"geographyOptions": options.get("geographyOptions") or [], "engineOptions": options.get("engineOptions") or [],
            "dynamicAxes": options.get("dynamicAxes") or [], "selectableDates": dates["selectableDates"] or [],
            "latestAnchorDay": dates["latestAnchorDay"], "collectionStartDay": dates["collectionStartDay"]}


@screen("projects/as-of")
async def project_as_of(q) -> dict:
    """The latest round the page's read shows (None when it has none or failed transiently), as overview/as-of."""
    _, _, common = _common(q)
    res = await or_none_on_transient(fetch_dashboard_summary(common, "project"))
    return {"asOf": as_of_date(res["meta"]) if res else None}


async def _tiles(q, deferred: bool) -> dict:
    _, _, common = _common(q)
    state, kpis = await load_live_kpis(common, "project")
    if kpis is None:
        return {"state": state}
    if deferred:
        kpis = await deferred_kpis(kpis, common, "project")
    # live only: no period compare (compare None), so every tile carries the round Δ
    return {"state": "ok", "tiles": tiles_view(kpis, None, None, {"kind": None, "curLo": None, "todayKst": None})}


@screen("projects/dash-summary")
async def dash_summary(q) -> dict:
    """KPI tiles at card speed: state ok | empty | degraded (as website/summary)."""
    return await _tiles(q, False)


@screen("projects/dash-summary-deferred")
async def dash_summary_deferred(q) -> dict:
    """The same tiles with the engine consistency badge and the round Δ (the trend's last two rounds)."""
    return await _tiles(q, True)


@screen("projects/dash-engines")
async def dash_engines(q) -> dict:
    """엔진별 비교 (website/engines on the project). A transient failure -> degraded."""
    _, _, common = _common(q)
    try:
        res = await fetch_engine_rows(common, "project")
    except Exception as exc:  # noqa: BLE001
        if not is_transient(exc):
            raise
        return {"engines": [], "consistency": {}, "extremes": {}, "widest": None, "degraded": True}
    return {**engines_view(res["data"]["rows"]), "degraded": False}


@screen("projects/dash-composition")
async def dash_composition(q) -> dict:
    """출처별 구성비: top 7 domains + 기타 (website/composition on the project; no topics: project prompts carry no
    catalog). A transient failure empties it and degrades."""
    _, _, common = _common(q)
    try:
        data = (await fetch_dashboard_domains(common, "project", SOURCE_TOP_N))["data"]
    except Exception as exc:  # noqa: BLE001
        if not is_transient(exc):
            raise
        return {"topics": [], "sources": [], "degraded": True}
    return {"topics": [], "sources": to_source_slices(data), "degraded": False}


@screen("projects/dash-trend")
async def dash_trend(q) -> dict:
    """KPI trend by round: None (the "accruing" box) under two rounds."""
    _, _, common = _common(q)
    trend = await load_live_trend(common, "project", WEBSITE_OVERVIEW_TREND_METRICS, "week")
    return {"trend": trend_chart_view(trend) if trend and len(trend["points"]) >= 2 else None}


@screen("projects/dash-status")
async def dash_status(q) -> dict:
    """프로젝트 현황: the project's Gold facts (projects/list row: prompts, answers, rounds, countries, engines,
    custom tags, last measured) and its latest measured prompts (gold/projects/{id}, newest measurement first). Not
    narrowed by the filters: they are the project's, as the original tiles were."""
    ctx, _ = split_context(q)
    pid = ctx.get("project_id")
    listing, detail = await asyncio.gather(api.get("gold/projects"), api.get(f"gold/projects/{pid}"))
    row = next((r for r in listing["data"]["items"] if r["id"] == pid), None)
    prompts = [p for p in detail["data"].get("prompts") or [] if p.get("last_measured")]
    prompts.sort(key=lambda p: p["last_measured"], reverse=True)
    recent = [{"promptId": p["prompt_id"], "text": p["text"], "answers": p["answers"], "lastMeasuredDay": day_of(p["last_measured"])}
              for p in prompts[:RECENT_PROMPTS]]
    facts = None
    if row:
        facts = {"prompts": row["prompts"], "measuredPrompts": len(prompts), "answers": row["answers"], "rounds": row["rounds"],
                 "countries": row["countries"], "engines": row["engines"], "customFields": row["custom_fields"],
                 "lastMeasuredDay": day_of(row.get("last_measured"))}
    return {"facts": facts, "recent": recent}
