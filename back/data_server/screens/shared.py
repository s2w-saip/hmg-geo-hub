"""Screens shared by every analysis page (filter bar data, panel options, project gate, the service week)."""
from __future__ import annotations

import logging
from datetime import date, timedelta

import asyncpg
from fastapi import HTTPException

from data_server import api
from data_server.access import reader_scope
from data_server.hub_stores import service_week
from data_server.screens import screen
from data_server.screens._filters import (
    load_filter_dates, load_panel_options, load_project_gate, load_website_prompt_options, project_locks,
    read_standard_filters, search_params,
)
from data_server.screens._query import common_query
from data_server.screens._week import week_view

log = logging.getLogger("hgh.service_week")

SURFACES = ("global", "website", "project")


@screen("shared/filter-dates")
async def filter_dates(q) -> dict:
    return await load_filter_dates(q.get("surface", "global"), q.get("project_id"), q.get("family"))


@screen("filters/options")
async def browser_panel_options(q) -> dict:
    """The filter panel's options as the browser's /api/filters/options answers them."""
    return {"options": await panel_options(q)}


@screen("shared/panel-options")
async def panel_options(q) -> dict:
    """The filter panel's option props (PanelFilterOptions) for the page URL.
    Query: surface, project_id (website: optional site, project: required), geo_only=true (the
    conversion pages), plus the page's URL params: time = the options window, brand = the applied
    brand narrowing (global/website). Global/website read with the session scope (local reader:
    every scope), project without one (the project pages' readStandardFilters(sp))."""
    surface = q.get("surface", "global")
    if surface not in SURFACES:
        raise HTTPException(422, "Unknown surface")
    project_id = q.get("project_id") if surface != "global" else None
    if surface == "project" and not project_id:
        raise HTTPException(422, "surface=project needs project_id")
    sp = search_params(q)
    scope = None if surface == "project" else reader_scope()
    filters = read_standard_filters(sp, scope)
    return await load_panel_options({"surface": surface, "projectId": project_id, "dateFrom": filters.get("dateFrom"),
                                     "dateTo": filters.get("dateTo"), "geoOnly": q.get("geo_only") in ("true", "1"),
                                     "scope": scope, "filters": filters})


@screen("shared/project-gate")
async def project_gate(q) -> dict:
    """The project pages' gate (local read-only) and their F4 locks: {project: GateProject|null, locks, lockedGroups}."""
    project = await load_project_gate(q.get("project_id", ""))
    return {"project": project, **(project_locks(project) if project else {"locks": [], "lockedGroups": []})}


@screen("shared/website-prompt-options")
async def website_prompt_options(q) -> dict:
    """/website/prompts filter option lists: {geographyOptions, languageOptions, brandOptions}."""
    return await load_website_prompt_options()


@screen("shared/service-week")
async def service_week_view(q) -> dict:
    """The service week every global and website screen shows Gold's rounds up to (decisions '발행 시점 판정' · '기준 주
    세부', 2026-11-02), for the shell (the header chip, the delay notice, the site notes): {state: ok | unconfigured
    (no HUB data DB: nothing is capped), week {start, end, month, nth}, delay {days, threshold, next: the week after}
    when the week ended more than DELAY_DAYS days ago (today in Korea), checkedAt · recordedAt (the HUB job's last check
    of Gold, its record of the week), justMoved (the BFF moved to this week moments ago: a screen of the same page read
    just before may hold the week before, so the shell re-reads its page once — review r1-16), rounds {global,
    website}: whether the week holds a round of the surface (False = the reads take no snapshot of it, and a page
    reading one says '측정 없음' for the week — review r1-19) as the reads' own calendar has it (cycles/week-notes; the
    job's record of the week's complete cycles stays as recorded while it holds a week whose round Gold re-opened —
    review r4-2), null when not known, notes: per surface and week up to it, the sites the week shows nothing of —
    unpublished (Gold has not published them) and hidden (an operator hid them) — among the page's sites (note_sites:
    the renewal shell passes the page URL's `brand` · `geography` · `language` · `engine` on), with the round days each
    is about (days: a page's period that holds none of them holds none of the week's values — review r2-10)}. An
    unreadable week is 503. The week is read again before the answer (service_week.fresh(), before any Gold read): a
    soft navigation's read of it can reach the BFF before the page's screens, which then take its week (review r5-2)."""
    week = await service_week.current_or_503(shell=True)
    if week is None:
        return {"state": "unconfigured", "week": None, "delay": None, "checkedAt": None, "recordedAt": None,
                "justMoved": False, "rounds": None, "notes": []}
    days = service_week.delay_days(week.end, service_week.today())
    delay = {"days": days, "threshold": service_week.DELAY_DAYS, "next": week_view(week.start + timedelta(days=7))} \
        if days > service_week.DELAY_DAYS else None
    notes, rounds = await week_notes(q, week)
    return {"state": "ok", "week": week_view(week.start), "delay": delay, "checkedAt": week.checked_at.isoformat(),
            "recordedAt": week.recorded_at.isoformat(), "justMoved": service_week.just_moved(week),
            "rounds": rounds, "notes": notes}


def note_sites(q) -> dict:
    """The website sites the page reads, for its notes: the URL's `geography`, `language`, `engine` and, for an
    administrator, its `brand` — the axes the website pages take a site's cells by — read as those pages read them
    (overview · mention · citation · prompts: read_standard_filters on the website surface, then common_query), so a
    note names only sites whose values the page shows (review r1-7, 2026-11-03: a Genesis page over July named Kia
    Italy's unpublished site; review r5-1: a German page an Italian and an English one). The read's clamp keeps them
    inside the account's scope, as it keeps the pages' reads. The global notes are no page's sites: the reader counts
    them for everyone."""
    scope = reader_scope()
    raw = read_standard_filters(search_params(q), scope, ["geography", "language", "engine", *(["brand"] if scope.get("all") else [])],
                                "website")
    picks = {k: v for k, v in (("brand", raw.get("brand")), ("websiteCountry", raw.get("region")), ("lang", raw.get("lang")),
                               ("engine", raw.get("engine"))) if v is not None}
    query = common_query(picks, {"surface": "website", "scope": scope})["query"]
    return {k: query[k] for k in ("brand", "country", "lang", "engine") if k in query}


async def week_notes(q, week: service_week.Week) -> tuple[list[dict], dict | None]:
    """cycles/week-notes as the notes say it, and its rounds of `week`. A site with nothing shown, held back by nothing
    and hidden by no one has only cycles Gold superseded or set aside: Gold published nothing of it that week, as of an
    unpublished one. The notes explain values beside them: when they cannot be read (Gold down, an account with no data
    scope) they are left out and the week still shows; the values fail on their own. The rounds are then not known,
    and neither are those of another week (the kept week moved on before the notes' read took it): None."""
    try:
        # read on the website surface: an account's scope narrows it to the website sites its reads take (city sites
        # included), the page's picks to the page's
        data = (await api.get("cycles/week-notes", {"surface": "website", **note_sites(q)}))["data"]
    except (HTTPException, asyncpg.PostgresError, asyncpg.InterfaceError, TimeoutError, OSError) as exc:
        log.warning("service week notes not read (%s)", getattr(exc, "status_code", None) or type(exc).__name__)
        return [], None
    notes = []
    for n in data["items"]:
        unpublished, hidden = n["unpublished"] + n["other"], n["hidden"]
        if unpublished or hidden:
            notes.append({"surface": n["surface"], "week": week_view(date.fromisoformat(n["week_start"])),
                          "unpublished": unpublished, "hidden": hidden, "days": n["days"]})
    return notes, data["rounds"] if data["week_start"] == week.start.isoformat() else None
