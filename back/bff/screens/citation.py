"""Citation analysis screens (인용 분석): standard, website and project pages, the renewal page,
the prompt and tone sub pages, and the browser table routes (/api/citations/domains*).

Loaders port front/lib/hgh/adapters/citations.ts (loadCitationsView, loadCitationDeltas,
loadCitationSourceParts, loadCitationPeriodCompare, loadOwnedPromptPage, loadToneUrlPage,
loadTargetHitRate, listCitationDomains, loadDomainDrilldown) with the same calls and the same
degrade rule (degradeOnApiFailure: a 5xx / unreadable answer of the wrapped read -> null and the
section's degraded flag; a 4xx reaches the page). The view-model rules are citation_model.

Screens (query = route context `ctx.*` + the page's URL params):
  citation/as-of            header pill date + filter bar competitor options   ctx.surface
  citation/filter-bar       filter panel props (options, calendar)            ctx.surface
  citation/standard         /standard/.../citation body (ctx.variant=renewal: + the renewal model)
  citation/website          /website/.../citation body (ctx.variant=renewal: the renewal page)   ctx.role
  citation/project          /projects/[id]/analysis/citation                   ctx.project_id
  citation/prompts          /citation/prompts sub page                         ctx.surface, ctx.role
  citation/tone-urls        /citation/tone-urls sub page                       ctx.surface, ctx.role, ctx.client_nav
  citation/domains          GET /api/citations/domains                         ctx.surface, ctx.project_id
  citation/domain-detail    GET /api/citations/domains/[skey]                  ctx.skey
  citation/domains-export   GET /api/citations/domains/export
`ctx.today` (YYYY-MM-DD) pins "today" (KST) for the month label (golden replay).
"""
from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import quote

from fastapi import HTTPException

from bff import api
from bff.access import reader_scope
from bff.screens import screen, split_context
from bff.screens import citation_model as M
from bff.screens._compare import fetch_period_compare_api, prev_period_filters
from bff.screens._convert import as_of_date, delta1
from bff.screens._filters import (
    filter_dates_view, load_panel_options, read_project_custom_field_filters, read_project_custom_field_filters_raw,
    read_standard_filters, split_filter_values,
)
from bff.screens._period import kst_today, resolve_request_compare_period_shape, to_period_delta_view
from bff.screens._query import analysis_query, is_uuid, js_trim, to_api_params, with_params
from bff.screens._sort import code_unit_key
from bff.screens._summary import provenance_of, summary_query, url_prompt_rates
from bff.screens._trend import (
    overview_card_delta, overview_trend_values, split_trend_dims, to_standard_trend_buckets, trend_query,
)

DEGRADE_LABEL = {"global": "standardCitations", "website": "websiteCitations", "project": "projectCitations"}
WEBSITE_CITATION_GROUPS = ("geography", "language", "engine", "time", "source")
NON_FILTER_KEYS = frozenset({"tab", "tone", "q", "page", "by", "cursor", "sort", "dir", "limit", "locale", "surface", "projectId"})
_CURSOR = re.compile(r"[A-Za-z0-9_-]{1,8192}")


# ── small JS-semantics helpers ──────────────────────────────────────────────

def one(v: Any) -> str:
    """`(Array.isArray(v) ? v[0] : v) ?? ""`."""
    if isinstance(v, list):
        v = v[0] if v else None
    return v if v is not None else ""


def first(v: Any) -> str | None:
    """URLSearchParams#get / useSearchParams().get: the first value of a key."""
    if isinstance(v, list):
        return v[0] if v else None
    return v


def read_cursor_param(raw: Any) -> str | None:
    """lib/hgh/paginate readCursorParam: a string matching the cursor charset, else None."""
    return raw if isinstance(raw, str) and _CURSOR.fullmatch(raw) else None


def js_parse_int(s: str) -> int | None:
    """Number.parseInt(s, 10); NaN -> None."""
    m = re.match(r"[+-]?[0-9]+", js_trim(s))
    return int(m[0]) if m else None


def page_param(sp: dict) -> int:
    """`Math.max(1, Number.parseInt(one(sp.page) || "1", 10) || 1)`."""
    n = js_parse_int(one(sp.get("page")) or "1")
    return max(1, n or 1)


def page_info(meta: Any) -> dict:
    page = (meta or {}).get("page") if isinstance(meta, dict) else None
    page = page or {}
    return {"nextCursor": page.get("next_cursor") or None, "limit": page.get("limit"), "total": page.get("total")}


def _form_encode(s: str) -> str:
    """application/x-www-form-urlencoded byte serializer (URLSearchParams#toString)."""
    return quote(s, safe="*-._ ").replace(" ", "+").replace("~", "%7E")


def citation_route_query(sp: dict, surface: str, project_id: str | None = None, custom_field_ids: list[str] | None = None) -> str:
    """citationRouteQuery: the page's filter params (sub page / table state removed; on project only the
    active custom fields' cf_ params) + surface=website or projectId, as the client table sends them."""
    active_cf = {f"cf_{i}" for i in custom_field_ids or []}
    pairs: list[tuple[str, str]] = []
    for key in sorted(sp, key=code_unit_key):
        if key in NON_FILTER_KEYS:
            continue
        if key.startswith("cf_") and (surface != "project" or key not in active_cf):
            continue
        v = sp[key]
        for value in v if isinstance(v, list) else [v]:
            pairs.append((key, value))
    if surface == "website":
        pairs.append(("surface", "website"))
    if surface == "project" and project_id:
        pairs.append(("projectId", project_id))
    return "&".join(f"{_form_encode(k)}={_form_encode(v)}" for k, v in pairs)


# ── degrade (lib/scope/degrade-registry degradeOnApiFailure) ────────────────

def _degradable(exc: BaseException) -> bool:
    """A backend outage on the wire: 5xx or an unreadable answer; a 4xx is the page's error."""
    if isinstance(exc, HTTPException):
        return exc.status_code >= 500
    return isinstance(exc, Exception)


async def degrade(aw) -> tuple[Any, bool]:
    """(value, False) or (None, True) when the read failed as a backend outage; 4xx re-raised."""
    try:
        return await aw, False
    except Exception as exc:  # noqa: BLE001 - classified below
        if not _degradable(exc):
            raise
        return None, True


def _shown_page(page_no: int, cursor: str | None, restarted: bool) -> int:
    """The page a sub page's window names: the URL's page while a cursor placed the rows, else page one, which is what
    a read without a cursor (or one restarted after a stale cursor) returns. ?page=N alone (an old link or bookmark)
    named page N over the first rows."""
    return page_no if cursor and not restarted else 1


async def _restartable_page(cursor: str | None, run):
    """pageOrFirst: a stale (409 cursor_stale) or foreign (422 cursor_invalid) cursor reads page one."""
    try:
        return await run(cursor), False
    except HTTPException as exc:
        code = getattr(exc, "code", None)
        if cursor and ((exc.status_code == 409 and code == "cursor_stale") or (exc.status_code == 422 and code == "cursor_invalid")):
            return await run(None), True
        raise


# ── page contexts (the URL read of each page and route) ─────────────────────

def global_context(sp: dict) -> tuple[dict, dict, list[str]]:
    """Standard page: readStandardFilters(sp, scope) + cumulative; the ?competitor= picks (every value)."""
    filters = {**read_standard_filters(sp, reader_scope()), "cumulative": True}
    return filters, {"surface": "global", "scope": reader_scope()}, split_filter_values(sp.get("competitor"))


def website_groups(role: str | None) -> list[str]:
    return [*WEBSITE_CITATION_GROUPS, *(["brand"] if role == "admin" else [])]


def website_filters(raw: dict) -> dict:
    """`{...raw, websiteCountry: raw.region, region: undefined, cumulative: true}`."""
    out = {k: v for k, v in raw.items() if k != "region"}
    if raw.get("region") is not None:
        out["websiteCountry"] = raw["region"]
    out["cumulative"] = True
    return out


def website_context(sp: dict, role: str | None) -> tuple[dict, dict]:
    """The website page's filters with the website account rule (site countries: a scope country's city sites stay)."""
    raw = read_standard_filters(sp, reader_scope(), website_groups(role), "website")
    return website_filters(raw), {"surface": "website", "scope": reader_scope()}


def route_context(sp: dict, surface: str, project_id: str | None, role: str | None) -> tuple[dict, dict, list[str]]:
    """citationRouteFilters: the filters each screen's page read from the same URL."""
    if surface == "project":
        custom = read_project_custom_field_filters_raw(sp)
        filters = {**read_standard_filters(sp), "cumulative": True}
        if custom is not None:
            filters["customFieldFilters"] = custom
        ctx = {"surface": "project", "projectId": project_id, "scope": None}
        if custom is not None:
            ctx["customFields"] = custom
        return filters, ctx, []
    if surface == "website":
        # the body's rule (2026-10-31 renewal audit 9-7: the table, drawer and export read the global one, so a scoped
        # account's city site fell back to the whole scope while the body read that site)
        filters, ctx = website_context(sp, role)
        return filters, ctx, []
    return global_context(sp)


def common_of(filters: dict, ctx: dict) -> dict:
    return to_api_params(analysis_query(filters, ctx))


def active_sources(sp: dict) -> list[str]:
    """useActiveCitationCategories: the first ?source= value split."""
    return split_filter_values(first(sp.get("source")))


def active_competitors(sp: dict) -> list[str]:
    """useActiveCompetitors: the first ?competitor= value split."""
    return split_filter_values(first(sp.get("competitor")))


# ── loaders (citations.ts) ──────────────────────────────────────────────────

class Reads:
    """The reads of one screen request: identical /v1 reads share one answer (the page's in-request
    dedupe). Every read starts at once (2026-10-27): the screen answers after all of them settled,
    so the old page's staging (D6: trends and the prompt split after the essentials, at most four
    calls at a time, G-25) only added the stages up, 4.6 s on the global page. The Gold pool bounds
    the database work (bff/gold_reader/db.py), as for the mention screens."""

    def __init__(self, filters: dict, ctx: dict, competitor: list[str] | None = None) -> None:
        self.filters, self.ctx = filters, ctx
        self.surface = ctx["surface"]
        self.picks = M.pick_list(competitor) if self.surface == "global" else []
        self.common = common_of(filters, ctx)
        self._memo: dict[str, asyncio.Future] = {}

    def get(self, path: str, params: dict) -> asyncio.Future:
        key = f"{path}?{api.query(params)}"
        fut = self._memo.get(key)
        if fut is None:
            fut = asyncio.ensure_future(api.get(path, params))
            # an unread failure must not be reported as "never retrieved": it is read where used
            fut.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
            self._memo[key] = fut
        return fut

    # the calls of the page's first render
    def domains(self) -> asyncio.Future:
        return self.get("citations/domains", with_params(self.common, M.domains_params(M.main_domains_request(self.surface, self.picks))))

    def sources(self) -> asyncio.Future:
        return self.get("citations/sources", with_params(self.common, M.sources_params(M.main_sources_request(self.surface))))

    def dates(self) -> asyncio.Future:
        query = {"surface": self.surface, "family": "citations"}
        if self.ctx.get("projectId") and self.surface != "global":
            query["project_id"] = self.ctx["projectId"]
        return self.get("filters/dates", query)

    def summary(self) -> asyncio.Future:
        return self.get("kpi/summary", summary_query(self.common, {"surface": self.surface}))

    def trends(self) -> asyncio.Future:
        """fetchCitationTrends: source top 15 with the category top 13 as a dims block of one call."""
        return self.get("trend", trend_query(self.common, {"surface": self.surface, "bucket": "cycle", "dimension": "source",
                                                           "top": M.SOURCE_TREND_TOP, "measuredDays": False,
                                                           "dims": [{"dimension": "category", "top": M.CATEGORY_TREND_TOP}]}))

    def share_trend(self) -> asyncio.Future:
        """The Overview card's citation share per round (the card Δ; the website 공식(당사) line)."""
        return self.get("trend", trend_query(self.common, {"surface": self.surface, "bucket": "cycle", "dimension": "none",
                                                           "metrics": ["visibility", "citation_share"], "measuredDays": False}))


def split_citation_trends(res: dict) -> dict:
    parts = split_trend_dims({"data": res["data"], "meta": res.get("meta")})
    return {"source": parts.get("source"), "category": parts.get("category")}


async def load_view(r: Reads) -> dict:
    """loadCitationsView: {live, table, competitorOptions, degraded}."""

    async def core():
        return await asyncio.gather(r.domains(), r.sources())

    async def trends():
        return split_citation_trends(await r.trends())

    async def source_trend():
        return (await trends())["source"]

    async def category_trend():
        return (await trends())["category"]

    async def owned():
        return await r.get("citations/prompts", with_params(r.common, M.prompts_params(M.split_prompts_request(r.surface))))

    async def picked():
        req = {"limit": M.DOMAIN_PAGE, "skey": r.picks, "competitor": r.picks, "competitorTotals": False}
        return await r.get("citations/domains", with_params(r.common, M.domains_params(req)))

    async def none():
        return None, False

    # the 출처 filter leaves the prompt split uncomputed, as the original (scope-aggregates wantSplit): under a
    # source filter it counted only prompts that cited that source (2026-10-29 metric review R4: 미인용 530 for 5,758)
    split_off = bool(r.filters.get("sourceCategory"))
    (core_v, core_d), (st_v, st_d), (ct_v, ct_d), (own_v, own_d), (pick_v, _) = await asyncio.gather(
        degrade(core()), degrade(source_trend()), degrade(category_trend()), none() if split_off else degrade(owned()),
        degrade(picked()) if r.picks else none())
    degraded = {"data": core_d, "trend": st_d, "categoryTrend": ct_d, "split": own_d}
    if not core_v:
        return {"live": None, "table": None, "competitorOptions": [], "degraded": degraded}
    domains, sources = core_v
    live = M.to_citations_live({"domains": domains, "sources": sources, "sourceTrend": st_v, "categoryTrend": ct_v, "owned": own_v,
                                "splitOff": split_off})
    if live is not None and pick_v:
        have = {row["domain"] for row in live["domains"]}
        for row in pick_v["data"]["items"]:
            if row["skey"] not in have:
                live["domains"].append(M.to_citation_domain(row))
    page = page_info(domains.get("meta"))
    return {"live": live, "table": {"nextCursor": page["nextCursor"], "total": page["total"]} if live is not None else None,
            "competitorOptions": M.competitor_options_of(domains["data"]), "degraded": degraded}


async def load_deltas(r: Reads) -> dict:
    """loadCitationDeltas: the Overview card Δ (share trend) and the previous round's category totals. In
    period mode the values are period totals: every share (공식(HMG) too) compares with the period before."""
    prev_filters = prev_period_filters(r.filters)
    if prev_filters is not None:
        before = Reads(prev_filters, r.ctx)
        (cur, _), (prev, _) = await asyncio.gather(degrade(r.sources()), degrade(before.sources()))
        window = {"from": prev_filters["dateFrom"], "to": prev_filters["dateTo"]}
        return {"officialDelta": None,
                "prevCategories": M.period_categories_of(cur["data"], prev["data"], window) if cur and prev else None}
    async def share():
        return await r.share_trend()

    async def category():
        return split_citation_trends(await r.trends())["category"]

    async def none():
        return None

    # the Overview card Δ reads cells with no 출처 axis: under a source filter 공식(HMG) takes its category Δ
    # (2026-10-29 metric review R4: "100.0% ▲1.3pp" for 100 % → 100 %)
    filtered = bool(r.filters.get("sourceCategory"))
    (share_v, _), (cat, _) = await asyncio.gather(degrade(none() if filtered else share()), degrade(category()))
    official = overview_card_delta(to_standard_trend_buckets(share_v["data"]), "citationShare") if share_v else None
    return {"officialDelta": official, "prevCategories": M.prev_categories_of(cat)}


async def load_source_parts(r: Reads) -> dict:
    """loadCitationSourceParts: type composition and tone tiles from one C-2 answer (None = degraded)."""
    res, _ = await degrade(r.get("citations/sources", dict(r.common)))
    if not res:
        return {"typeCategories": None, "toneSummary": None}
    return {"typeCategories": M.to_type_category_rows(res["data"]), "toneSummary": M.to_tone_summary(res["data"])}


async def load_period_view(r: Reads, today: str | None) -> dict | None:
    """The month line: calendar month only (axis on: month -> week -> window), citations per answer;
    a backend outage drops it, toPeriodDeltaView of the results."""
    shape = resolve_request_compare_period_shape(r.filters.get("dateFrom"), r.filters.get("dateTo"))
    if not shape.get("months"):
        return None
    results, _ = await degrade(fetch_period_compare_api(r.filters, r.common, {
        "surface": r.surface, "kind": shape["kind"], "metrics": ["citationsPerAnswer"], "card": False}))
    if results is None:
        return None
    cur_lo = ((shape.get("weeks") or {}).get("cur") or {}).get("lo") or ((shape.get("months") or {}).get("cur") or {}).get("lo") \
        or r.filters.get("dateFrom")
    vctx: dict = {"days": shape.get("days") if shape.get("days") is not None else 0, "kind": shape["kind"],
                  "todayKst": today or kst_today()}
    if cur_lo is not None:
        vctx["curLo"] = cur_lo
    return to_period_delta_view(results, vctx)


def to_target_hit_rate_from_summary(res: dict) -> dict:
    """toTargetHitRateFromSummary: K-1 url_prompts rates + the published / live origin."""
    out = dict(url_prompt_rates(res["data"], res.get("meta")))
    prov = provenance_of(res.get("meta"))
    if prov and prov.get("source") == "published":
        out["source"] = "published"
        round_date = prov.get("roundDate")
        if round_date is None:
            round_date = as_of_date(res.get("meta"))
        out["publication"] = {"cycleLabel": prov.get("cycleLabel"), "cycleLabelEn": prov.get("cycleLabelEn"),
                              "roundDate": round_date if round_date is not None else "",
                              "siteCount": prov.get("siteCount") if prov.get("siteCount") is not None else 0}
    elif prov and prov.get("source") == "live":
        out["source"] = "live"
    return out


async def load_target_hit_rate(r: Reads) -> dict:
    """loadTargetHitRate: K-1 url_prompts, or the empty card under a source category filter."""
    if not M.targets_applicable(r.filters):
        return M.empty_target_hit_rate()
    return to_target_hit_rate_from_summary(await r.summary())


async def load_own_share_line(r: Reads) -> dict:
    """The website 공식(당사) tile's Δ and weekly line (its value is the citation read's own share). 당사 is the site's
    brand scope, not the 공식(HMG) category: on the website the two shares differ (2026-10-30: 24.9 % vs 61.7 %).
    Δ: the Overview card's (previous round, the share trend), in period mode the period before's own share. The
    share trend has no 출처 axis, so a source filter drops the line and the round Δ (as the card Δ, R4)."""
    prev_filters = prev_period_filters(r.filters)
    filtered = bool(r.filters.get("sourceCategory"))

    async def line():
        return None if filtered else await r.share_trend()

    async def before():
        if prev_filters is None:
            return None
        b = Reads(prev_filters, r.ctx)
        return await b.get("citations/domains", with_params(b.common, M.domains_params({"limit": 1, "competitorTotals": False})))

    (line_v, _), (before_v, _) = await asyncio.gather(degrade(line()), degrade(before()))
    slots = to_standard_trend_buckets(line_v["data"]) if line_v else []
    spark = [overview_trend_values(b).get("citationShare") for b in slots]
    if prev_filters is not None:
        prev = M.mirror_pct_or_null(before_v["data"]["summary"].get("own_share")) if before_v else None
        return {"prev": prev, "window": {"from": prev_filters["dateFrom"], "to": prev_filters["dateTo"]}, "spark": spark}
    return {"card": overview_card_delta(slots, "citationShare"), "spark": spark}


def url_funnel(res: dict) -> dict:
    """One K-1 answer's prompt-unit URL funnel: measured → owned URL cited → target page cited (one denominator,
    the original's rate cards and their rounding: url_prompt_rates)."""
    rates = url_prompt_rates(res["data"], res.get("meta"))
    return {"measured": rates["measuredPrompts"], "owned": rates["ownedPrompts"], "target": rates["hitPrompts"],
            "ownedRate": rates["ownedRate"], "targetRate": rates["rate"]}


async def load_url_reach(r: Reads, deltas: asyncio.Future) -> dict:
    """The website 사이트 인용 도달 card: the URL funnel per prompt, its Δ and the same funnel per engine.
    Δ compares with the round the page's other Δ use (the category trend's previous valued round: one K-1 read of
    that day, which is that round exactly) or in period mode with the period before; only two answers of one value
    source (published / live) compare. The engines are those the citation read found; 전체 counts a prompt once
    whichever engine cited it, so it is not the engines' average. A source filter leaves it uncomputed (the original's
    cards: the 출처 class is per citation, the funnel per prompt)."""
    if not M.targets_applicable(r.filters):
        return {"status": "notComputed"}
    cur_res, _ = await degrade(r.summary())
    if not cur_res:
        return {"status": "degraded"}
    cur = url_funnel(cur_res)
    if not cur["measured"]:
        return {"status": "none"}
    prev_filters = prev_period_filters(r.filters)
    basis: dict = {"basis": None, "date": None}
    if prev_filters is not None:
        before: Reads | None = Reads(prev_filters, r.ctx)
        basis = {"basis": "period", "date": prev_filters["dateTo"], "from": prev_filters["dateFrom"]}
    else:
        day = ((await deltas)["prevCategories"] or {}).get("asOf")
        before = Reads({**r.filters, "dateFrom": day, "dateTo": day}, r.ctx) if day else None
        basis = {"basis": "round", "date": day}
    sources, _ = await degrade(r.sources())
    codes = [e["engine"] for e in ((sources or {}).get("data") or {}).get("by_engine") or []]

    async def none():
        return None, False
    answers = await asyncio.gather(degrade(before.summary()) if before else none(),
                                   *(degrade(Reads({**r.filters, "engine": [c]}, r.ctx).summary()) for c in codes))
    prev_res = answers[0][0]
    prev = url_funnel(prev_res) if prev_res else None
    comparable = prev is not None and prev["measured"] > 0 and \
        (provenance_of(prev_res.get("meta")) or {}).get("source") == (provenance_of(cur_res.get("meta")) or {}).get("source")
    delta = {k: delta1(cur[k], prev[k]) if comparable and cur[k] is not None and prev[k] is not None else None
             for k in ("ownedRate", "targetRate")}
    engines = [{"engine": M.provider_label(c), **url_funnel(res)} for c, (res, _) in zip(codes, answers[1:]) if res]
    engines = [e for e in engines if e["measured"]]
    engines.sort(key=lambda e: (-e["measured"], -e["owned"], e["engine"]))
    prov = provenance_of(cur_res.get("meta")) or {}
    out = {"status": "ok", **cur, "prev": prev if comparable else None, "delta": {**delta, **(basis if comparable else {"basis": None, "date": None})},
           "engines": engines, "enginesDegraded": any(d for _, d in answers[1:])}
    target = to_target_hit_rate_from_summary(cur_res)
    if "source" in target:
        out["source"] = target["source"]
    if "publication" in target:
        out["publication"] = target["publication"]
    return out


def own_share_tile(live: dict | None, line: dict) -> dict | None:
    """ShareTile of the website 공식(당사) share: value, Δ (+ basis), weekly line; None without the citation read."""
    if live is None:
        return None
    value = live["summary"].get("officialOwnShare")
    delta: dict = {"value": None, "basis": None, "date": None}
    if "window" in line:
        if value is not None and line["prev"] is not None:
            delta = {"value": delta1(value, line["prev"]), "basis": "period", "date": line["window"]["to"], "from": line["window"]["from"]}
    elif line["card"]:
        delta = {"value": line["card"]["delta"], "basis": "card", "date": line["card"]["basisDate"]}
    spark = line["spark"]
    return {"value": value, "delta": delta, "spark": spark, "sparkOn": value is not None and any(v is not None for v in spark)}


def table_source(view: dict, query: str) -> dict | None:
    return {"query": query, **view["table"]} if view["table"] else None


# ── view models of the pages ────────────────────────────────────────────────

def citations_view_vm(live: dict | None) -> dict | None:
    """CitationsView (website / project): dealer tile share, donut centre, engine chart."""
    if live is None:
        return None
    categories = live.get("categories")
    return {"dealerShare": M.category_share_raw(categories, M.DEALER_CATEGORY),
            "officialPct": M.donut_official_pct(categories) if categories is not None else None,
            "engineChart": M.engine_chart(live.get("engineCategories")),
            "domains": M.numbered_rows(live["domains"], "matchRank")}


def standard_vm(live: dict | None, deltas: dict, parts: dict, degraded: dict, sp: dict) -> dict | None:
    """CitationsStandardView: every section's numbers (status, categories, engines, types, table rows)."""
    if live is None:
        return None
    active, picked = active_sources(sp), active_competitors(sp)
    card, prev = deltas["officialDelta"], deltas["prevCategories"]
    return {
        "status": M.standard_status(live, card, prev, active, degraded),
        "category": M.standard_category_block(live, prev, picked, active),
        "engineChart": M.engine_chart(live.get("engineCategories")),
        "domains": M.numbered_rows(M.apply_competitor_pick(live["domains"], picked), "rank"),
    }


def type_chart(rows: list[dict] | None) -> dict | None:
    """TypeBlock / TypeCategoryChart: the type bars and whether any type has citations; None = degraded."""
    if rows is None:
        return None
    bars = M.type_category_bars(rows)
    return {**bars, "hasAny": any(b["total"] > 0 for b in bars["bars"])}


def renewal_vm(live: dict | None, deltas: dict, parts: dict, degraded: dict, sp: dict) -> dict | None:
    """The renewal citation body (citation-model.ts + the cards' scales, lists and flags)."""
    if live is None:
        return None
    active, picked = active_sources(sp), active_competitors(sp)
    card, prev = deltas["officialDelta"], deltas["prevCategories"]
    rows = M.category_rows(live, prev, card, picked)
    for r in rows:
        d = None if r["deltaHidden"] else r["delta"]
        r["moved"] = d is not None and abs(d) >= M.MOVED_MIN
    lens = M.lens(live, prev, card, active, degraded)
    order = [r["name"] for r in rows]
    engine = M.engine_matrix(live.get("engineCategories"), order)
    types = parts["typeCategories"]
    type_m = M.type_matrix(types, order)
    bump = M.domain_bump(live.get("trend"), live["domains"])
    one_source = len(active) == 1
    initial = M.numbered_rows(M.ranked_domains(live["domains"], picked), "position")
    return {
        "rows": rows,
        "lens": M.lens_view(lens),
        "hmgRank": next((i for i, r in enumerate(rows) if r["name"] == M.OFFICIAL_HMG_CATEGORY), -1) + 1,
        "maxPct": max([1, *(r["pct"] if r["pct"] is not None else 0 for r in rows)]),
        "cap": M.delta_axis(rows),
        "trendOn": any(any(v is not None for v in (r["trend"] or [])) for r in rows),
        "findings": M.findings(rows, lens["hmg"]["delta"]["value"], picked, engine, type_m, lens["split"], bump),
        "engineMatrix": {"status": "ok" if engine else "pending", "m": M.matrix_view(engine, one_source)},
        # no type with citations: the original type chart's empty note (every column would read '—')
        "typeMatrix": {"status": "degraded", "m": None} if types is None else
                      {"status": "empty", "m": None} if types and not any(t["total"] > 0 for t in types) else
                      {"status": "ok" if type_m else "pending", "m": M.matrix_view(type_m, one_source)},
        "oneSource": one_source,
        "bump": M.bump_view(bump, live["domains"]),
        "table": {"rows": initial, "views": M.table_views(initial), "categories": M.category_options(live.get("categories"))},
    }


# ── screens ─────────────────────────────────────────────────────────────────

@screen("citation/as-of")
async def as_of(q) -> dict:
    """What the header pill and the filter bar read from the citation read (loadCitationsView): its round
    date (loadCitationsAsOf) and the competitor options of the main domains call. Global with the
    ?competitor= picks, website without."""
    ctx, sp = split_context(q)
    if ctx.get("surface") == "website":
        filters, actx = website_context(sp, ctx.get("role"))
        view = await load_view(Reads(filters, actx))
    else:
        filters, actx, competitor = global_context(sp)
        view = await load_view(Reads(filters, actx, competitor))
    return {"asOf": (view["live"] or {}).get("asOf"), "competitorOptions": view["competitorOptions"]}


@screen("citation/filter-bar")
async def filter_bar(q) -> dict:
    """The filter panel props: F-1 options of the URL period and the citation calendar. The competitor
    options come with citation/as-of (the citation read)."""
    ctx, sp = split_context(q)
    surface = "website" if ctx.get("surface") == "website" else "global"
    if surface == "website":
        filters, actx = website_context(sp, ctx.get("role"))
        r = Reads(filters, actx)
    else:
        filters, actx, competitor = global_context(sp)
        r = Reads(filters, actx, competitor)
    options, dates = await asyncio.gather(
        load_panel_options({"surface": surface, "dateFrom": filters.get("dateFrom"), "dateTo": filters.get("dateTo"),
                            "scope": reader_scope(), "filters": filters}),
        r.dates())
    return {"options": options, "dates": filter_dates_view(dates)}


@screen("citation/standard")
async def standard(q) -> dict:
    """The standard citation body: CitationsStandardView props + precomputed numbers + the month line;
    ctx.variant=renewal adds the renewal model."""
    ctx, sp = split_context(q)
    filters, actx, competitor = global_context(sp)
    r = Reads(filters, actx, competitor)
    view, deltas, parts, period = await asyncio.gather(
        load_view(r), load_deltas(r), load_source_parts(r), load_period_view(r, ctx.get("today")))
    live, degraded = view["live"], view["degraded"]
    out = {"live": live, "dataDegraded": degraded["data"], "sectionDegraded": degraded,
           "officialDelta": deltas["officialDelta"], "prevCategories": deltas["prevCategories"],
           "typeCategories": parts["typeCategories"], "typeChart": type_chart(parts["typeCategories"]),
           "toneSummary": parts["toneSummary"],
           "tableSource": table_source(view, citation_route_query(sp, "global")), "periodView": period,
           "vm": standard_vm(live, deltas, parts, degraded, sp)}
    if ctx.get("variant") == "renewal":
        out["rn"] = renewal_vm(live, deltas, parts, degraded, sp)
    return out


@screen("citation/website")
async def website(q) -> dict:
    """The website citation body: CitationsView props (+ the URL rate cards) and its numbers. ctx.variant=renewal
    answers the renewal page instead: the citation/standard renewal fields on the website surface + the 공식(당사)
    tile (`own`) and the URL funnel card (`reach`)."""
    ctx, sp = split_context(q)
    filters, actx = website_context(sp, ctx.get("role"))
    r = Reads(filters, actx)
    query = citation_route_query(sp, "website")
    if ctx.get("variant") != "renewal":
        view, target = await asyncio.gather(load_view(r), load_target_hit_rate(r))
        return {"live": view["live"], "targetHitRate": target, "tableSource": table_source(view, query),
                "dataDegraded": view["degraded"]["data"], "degradedSections": view["degraded"], "vm": citations_view_vm(view["live"])}
    deltas_t = asyncio.ensure_future(load_deltas(r))
    view, deltas, parts, period, own_line, reach = await asyncio.gather(
        load_view(r), deltas_t, load_source_parts(r), load_period_view(r, ctx.get("today")), load_own_share_line(r),
        load_url_reach(r, deltas_t))
    live, degraded = view["live"], view["degraded"]
    # The Overview card Δ is 공식(당사)'s here (the share trend counts the site's own brands), not the 공식(HMG)
    # category's: the category rows and the 공식(HMG) tile take their own category Δ.
    category_deltas = {**deltas, "officialDelta": None}
    return {"live": live, "tableSource": table_source(view, query),
            "dataDegraded": degraded["data"], "sectionDegraded": degraded, "prevCategories": deltas["prevCategories"],
            "toneSummary": parts["toneSummary"], "periodView": period,
            "rn": renewal_vm(live, category_deltas, parts, degraded, sp), "own": own_share_tile(live, own_line), "reach": reach}


@screen("citation/project")
async def project(q) -> dict:
    """The project citation page: options first (its custom fields read the cf_ URL filters), then the
    citation read and the calendar; CitationsView props and numbers."""
    ctx, sp = split_context(q)
    pid = ctx.get("project_id") or ""
    base = read_standard_filters(sp)
    options = await load_panel_options({"surface": "project", "projectId": pid, "dateFrom": base.get("dateFrom"),
                                        "dateTo": base.get("dateTo"), "scope": None, "filters": base})
    fields = options.get("dynamicAxes") or []
    custom = read_project_custom_field_filters(sp, fields)
    filters = {**base, "cumulative": True}
    if custom is not None:
        filters["customFieldFilters"] = custom
    actx = {"surface": "project", "projectId": pid, "scope": None}
    if custom is not None:
        actx["customFields"] = custom
    r = Reads(filters, actx)
    view, dates = await asyncio.gather(load_view(r), r.dates())
    query = citation_route_query(sp, "project", pid, [f["id"] for f in fields])
    panel = {k: options[k] for k in ("catalogRows", "engineOptions") if k in options}
    return {"live": view["live"], "options": {**panel, "dynamicAxes": fields},
            "selectableDates": filter_dates_view(dates)["selectableDates"], "tableSource": table_source(view, query),
            "dataDegraded": view["degraded"]["data"], "degradedSections": view["degraded"], "vm": citations_view_vm(view["live"])}


def sub_page_context(ctx: dict, sp: dict) -> tuple[dict, dict]:
    """The sub pages read their page's filters: the website page's (ctx.surface=website) or the standard page's."""
    if ctx.get("surface") == "website":
        return website_context(sp, ctx.get("role"))
    filters, actx, _ = global_context(sp)
    return filters, actx


@screen("citation/prompts")
async def prompts(q) -> dict:
    """The owned / uncited prompts sub page (loadOwnedPromptPage): rows, both tab counts, the page window."""
    ctx, sp = split_context(q)
    filters, actx = sub_page_context(ctx, sp)
    tab = "uncited" if one(sp.get("tab")) == "uncited" else "owned"
    page_no = page_param(sp)
    text = one(sp.get("q"))
    cursor = read_cursor_param(sp.get("cursor"))
    common = common_of(filters, actx)

    async def run(c):
        return await api.get("citations/prompts", with_params(common, M.prompts_params(
            {"owned": tab == "owned", "limit": M.SUBPAGE_SIZE, "q": text, "cursor": c, "fields": "text"})))

    got, _ = await degrade(_restartable_page(cursor, run))
    out: dict = {"tab": tab, "q": text}
    if not got:
        return {**out, "page": None, "ownedCount": None, "uncitedCount": None}
    res, restarted = got
    info = page_info(res.get("meta"))
    data = res["data"]
    tab_count = data["counts"]["owned"] if tab == "owned" else data["counts"]["uncited"]
    total = info["total"] if info["total"] is not None else (len(data["items"]) if js_trim(text) else tab_count)
    page_size = info["limit"] if info["limit"] is not None else M.SUBPAGE_SIZE
    rows = []
    for r in data["items"]:
        p = M.to_citation_prompt(r)
        rows.append({k: p[k] for k in ("id", "promptText", "funnelStage", "citations", "providers", "answers")})
    page = {"rows": rows, "total": total, "page": _shown_page(page_no, cursor, restarted), "pageSize": page_size,
            "nextCursor": info["nextCursor"]}
    page["win"] = M.page_window(total, page["page"], page_size)
    owned_zero = data["counts"]["owned"] == 0
    return {**out, "page": page, "ownedCount": None if owned_zero else data["counts"]["owned"],
            "uncitedCount": None if owned_zero else data["counts"]["uncited"]}


@screen("citation/tone-urls")
async def tone_urls(q) -> dict:
    """The positive / negative URL sub page (loadToneUrlPage): rows, the tab counts (None = reuse the
    shown ones on an in-page cursor / search move, ctx.client_nav=1), the page window."""
    ctx, sp = split_context(q)
    filters, actx = sub_page_context(ctx, sp)
    tone = "negative" if one(sp.get("tone")) == "negative" else "positive"
    page_no = page_param(sp)
    text = one(sp.get("q"))
    by_domain = one(sp.get("by")) == "domain"
    cursor = read_cursor_param(sp.get("cursor"))
    reuse = bool(cursor or js_trim(text)) and ctx.get("client_nav") in ("1", "true")
    with_counts = not reuse
    group_by = "source" if by_domain else "url"
    common = common_of(filters, actx)

    async def run(c):
        return await api.get("citations/sources/tone", with_params(common, M.tone_params(
            {"tone": tone, "groupBy": group_by, "limit": M.SUBPAGE_SIZE, "q": text, "cursor": c, "withCounts": with_counts})))

    got, _ = await degrade(_restartable_page(cursor, run))
    out: dict = {"tone": tone, "q": text, "byDomain": by_domain}
    if not got:
        return {**out, "page": None, "counts": {"positive": None, "negative": None}}
    res, restarted = got
    info = page_info(res.get("meta"))
    data = res["data"]
    total = info["total"] if info["total"] is not None else len(data["items"])
    page_size = info["limit"] if info["limit"] is not None else M.SUBPAGE_SIZE
    page = {"rows": [M.to_tone_url_row(r, group_by) for r in data["items"]], "total": total,
            "page": _shown_page(page_no, cursor, restarted), "pageSize": page_size, "nextCursor": info["nextCursor"]}
    page["win"] = M.page_window(total, page["page"], page_size)
    counts = data.get("counts") or {}
    return {**out, "page": page,
            "counts": {"positive": counts.get("positive"), "negative": counts.get("negative")} if with_counts else None}


def _route_target(ctx: dict) -> tuple[str, str | None]:
    surface = ctx.get("surface") or "global"
    if surface not in ("global", "website", "project"):
        raise HTTPException(422, "Unknown surface")
    pid = ctx.get("project_id")
    if surface == "project" and not is_uuid(pid):
        raise HTTPException(422, "Invalid project id")
    return surface, pid if surface == "project" else None


@screen("citation/domains")
async def domains(q) -> dict:
    """GET /api/citations/domains (listCitationDomains): one page of rows + cursor + total, each row with
    its '#' (global: rank, else matchRank or the loaded position) and the renewal table's views."""
    ctx, sp = split_context(q)
    surface, pid = _route_target(ctx)
    filters, actx, competitor = route_context(sp, surface, pid, ctx.get("role"))
    raw_limit = first(sp.get("limit"))
    limit = int(raw_limit) if raw_limit is not None and re.fullmatch(r"[0-9]+", raw_limit) else M.DOMAIN_PAGE
    cursor = read_cursor_param(first(sp.get("cursor")))
    req: dict = {"limit": limit, "cursor": cursor, "q": js_trim(first(sp.get("q")) or ""),
                 "sort": first(sp.get("sort")) or "citations", "competitor": competitor, "competitorTotals": False}
    if first(sp.get("dir")):
        req["dir"] = first(sp.get("dir"))
    res = await api.get("citations/domains", with_params(common_of(filters, actx), M.domains_params(req)))
    info = page_info(res.get("meta"))
    offset = int(cursor) if cursor and cursor.isdigit() else 0
    rows = M.numbered_rows([M.to_citation_domain(r) for r in res["data"]["items"]],
                           "rank" if surface == "global" else "matchRank", offset)
    return {"rows": rows, "nextCursor": info["nextCursor"], "total": info["total"], "views": M.table_views(rows)}


@screen("citation/domain-detail")
async def domain_detail(q) -> dict:
    """GET /api/citations/domains/[skey] (loadDomainDrilldown): the row's URL and prompt lists, each
    prompt's share of the source's citations and the prompt table's sort orders."""
    ctx, sp = split_context(q)
    surface, pid = _route_target(ctx)
    skey = ctx.get("skey") or ""
    filters, actx, _ = route_context(sp, surface, pid, ctx.get("role"))
    res = await api.get(f"citations/domains/{skey}", common_of(filters, actx))
    out = M.to_domain_drilldown(res["data"])
    out["promptOrders"] = M.prompt_drilldown({"citations": res["data"].get("citations"), "promptList": out["promptList"]})
    return out


@screen("citation/domains-export")
async def domains_export(q) -> dict:
    """GET /api/citations/domains/export: the BG-22 export read as the route relayed it (Gold has no
    export: the read answers 404, which the route returns)."""
    ctx, sp = split_context(q)
    surface, pid = _route_target(ctx)
    filters, actx, competitor = route_context(sp, surface, pid, ctx.get("role"))
    lst = M.domains_params({"q": js_trim(first(sp.get("q")) or ""), "sort": first(sp.get("sort")) or "citations",
                            "dir": first(sp.get("dir")) or None, "competitor": competitor})
    extra = {**lst, "locale": first(sp.get("locale")) or "ko", "format": "xlsx"}
    max_rows = first(sp.get("max_rows"))
    if max_rows and max_rows.isdigit() and int(max_rows) > 0:
        extra["max_rows"] = int(max_rows)
    return await api.get("citations/domains/export", with_params(common_of(filters, actx), extra))
