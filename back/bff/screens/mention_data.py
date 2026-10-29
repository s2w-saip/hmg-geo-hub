"""Mention screens' data loaders: the /v1 reads of the mention pages in the shapes the front used.

Ports, bit for bit (same calls, same params, same conversions):
  front/lib/hgh/adapters/mentions.ts   brands / types / engines / summary / brand-trend reads, MentionsLive,
                                       Sub KPI rows, prev windows, the degrade labels (B034/B035)
  front/lib/hgh/adapters/kpi-tab.ts    KPI tab hero subs, engine trend, brand trend, first rank, type KPI
  front/lib/scope/result-adapter.ts    buildMentionTrend / buildWeeklyTrend / applyWeeklyTrendGaps
  front/app/[locale]/(dash)/standard/answer-analysis/_data/sub-kpis.ts  buildMentionSubKpis
  the period block of the KPI body (resolveRequestComparePeriodShape + fetchPeriodCompareApi)

Shapes: API JSON in, the TS camelCase view shapes out; a key TS left undefined is absent, None is
null. `filters` is a StandardFilters dict (bff.screens._filters.read_standard_filters) and `ctx`
the AnalysisQueryContext {surface, projectId?, scope, customFields?}.

Degrade marks (lib/scope/degrade-registry.ts degradeOnApiFailure / wasDegraded): a read that fails
transiently (5xx, a database error or timeout) records its label in the request's registry and
yields None; a 4xx is raised. A screen builder opens the registry with begin_degrade_scope().
The D6 "essentials first" call ordering of the front client is not reproduced: the reads of a
screen run concurrently here (identical concurrent reads share one execution in bff.api.get).
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any

import asyncpg
from fastapi import HTTPException

from bff import api
from bff.access import reader_scope
from bff.screens._competitors import rank_first_position_rows
from bff.screens._compare import fetch_period_compare_api, prev_period_filters
from bff.screens._convert import as_of_date, pct1_or_zero, rank_avg, round1, suppression_of, whole_suppression
from bff.screens._filters import read_standard_filters
from bff.screens._period import resolve_request_compare_period_shape
from bff.screens._query import analysis_query, to_api_params
from bff.screens._sort import code_unit_key
from bff.screens._summary import summary_query
from bff.screens._trend import (bucket_round_date, fetch_trend, mirror_pct, monday_of, point_gap, series_label,
                                 split_trend_dims, to_brand_trend_result, to_first_position_result,
                                 to_standard_trend_buckets, trend_gap_key_in_axis, trend_grid_of,
                                 with_engine_breakdown)

MENTION_TYPES = ("mention", "recommendation", "comparison", "definition", "final_choice")
SENTIMENT_KEYS4 = ("positive", "neutral", "negative", "mixed")

# ── degrade registry (request scoped) ─────────────────────────────────────

_DEGRADED: ContextVar[set | None] = ContextVar("mention_degraded", default=None)


def begin_degrade_scope() -> set:
    """Open this request's degrade registry (call once at the start of a screen builder)."""
    marks: set = set()
    _DEGRADED.set(marks)
    return marks


def mark_degraded(label: str) -> None:
    marks = _DEGRADED.get()
    if marks is not None:
        marks.add(label)


def was_degraded(label: str) -> bool:
    marks = _DEGRADED.get()
    return marks is not None and label in marks


def is_degradable(exc: BaseException) -> bool:
    """isDegradableApiFailure: a backend 5xx, a database failure, a timeout or a lost connection."""
    if isinstance(exc, HTTPException):
        return exc.status_code >= 500
    return isinstance(exc, (asyncpg.PostgresError, asyncpg.InterfaceError, TimeoutError, asyncio.TimeoutError,
                            ConnectionError))


async def degrade_on_api_failure(label: str, run: Callable[[], Awaitable[Any]]) -> Any:
    """degradeOnApiFailure: run(); a transient failure -> mark `label`, None; anything else raises."""
    try:
        return await run()
    except Exception as exc:  # noqa: BLE001 - classified below
        if not is_degradable(exc):
            raise
        mark_degraded(label)
        return None


async def degrade(label: str, run: Callable[[], Awaitable[Any]], fallback: Any) -> Any:
    v = await degrade_on_api_failure(label, run)
    return fallback if v is None else v


def start_early(run: Callable[[], Awaitable[Any]]) -> Callable[[], Awaitable[Any]]:
    """Start a read now that a loader only uses after an earlier read answered, and hand back the `run` for
    degrade_on_api_failure: its outcome (value or error) is classified and marked when the loader asks for it,
    as if it had started then. Started together, the page's identical reads still share one execution
    (bff.api.get); started after the gate, a read the other sections had just finished ran again (2.5 s of the
    renewal Mention's month view). A read nobody asks for (the gate failed) ends quietly."""
    task = asyncio.ensure_future(run())
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    return lambda: task


# ── filters ─────────────────────────────────────────────────────────────────

def mention_filters(sp: dict) -> tuple[dict, dict]:
    """The standard (global) mention screens: {...readStandardFilters(sp, scope), cumulative: true}
    and the api context {surface: global, scope}, with the signed-in account's scope."""
    scope = reader_scope()
    filters = {**read_standard_filters(sp, scope), "cumulative": True}
    return filters, {"surface": "global", "scope": scope}


WEBSITE_ONLY_GROUPS = ("geography", "language", "engine", "time")


def website_filters(sp: dict, admin: bool = False) -> tuple[dict, dict]:
    """The website mention page: readStandardFilters(sp, scope, WEBSITE_ONLY_GROUPS (+brand for an admin),
    "website"), websiteCountry = region, region dropped, cumulative; api ctx website."""
    scope = reader_scope()
    groups = [*WEBSITE_ONLY_GROUPS, *(["brand"] if admin else [])]
    raw = read_standard_filters(sp, scope, groups, "website")
    filters = {k: v for k, v in raw.items() if k != "region"}
    if raw.get("region") is not None:
        filters["websiteCountry"] = raw["region"]
    filters["cumulative"] = True
    return filters, {"surface": "website", "scope": scope}


def surface_filters(ctx: dict, sp: dict) -> tuple[dict, dict]:
    """Filters + api ctx of the global (default) or website (ctx.surface=website) mention page."""
    if ctx.get("surface") == "website":
        return website_filters(sp, ctx.get("admin") == "true")
    return mention_filters(sp)


def query_params(filters: dict, ctx: dict, extra: dict | None = None) -> dict:
    """analysisQuery(filters, ctx) + withParams(extra), flattened for api.get (cf.* keys included)."""
    return to_api_params(analysis_query(filters, ctx), extra)


def _qctx(ctx: dict) -> dict:
    """The AnalysisQueryContext keys of a mention context."""
    out = {"surface": ctx["surface"], "scope": ctx.get("scope")}
    if ctx.get("projectId"):
        out["projectId"] = ctx["projectId"]
    if ctx.get("customFields") is not None:
        out["customFields"] = ctx["customFields"]
    return out


# ── calls ───────────────────────────────────────────────────────────────────

BRANDS_TABLE = {"top_n": 100, "sort": "mentions", "split_own": True, "full": True, "include": ["multi", "prompts", "types"]}
# The website / project views read multi too (MentionView's multi toggle): the reader sent it unasked until it honoured
# ?include= (2026-10-29), so asking for it keeps what they show.
VIEW_BRANDS_TABLE = {**BRANDS_TABLE, "include": ["multi", "prompts", "types"]}
#: the period before: its rows give the Δ of mention rate, share, position and sentiment only (no prompt or multi counts)
PREV_BRANDS_TABLE = {k: v for k, v in BRANDS_TABLE.items() if k != "include"}
ENGINE_BRAND_TOP_N = 30
ENGINE_BRANDS = {"top_n": ENGINE_BRAND_TOP_N, "sort": "mentions", "split_own": True, "group_by": "engine",
                 "engine_only": True}
SUB_KPI_ENGINE_PART = "exposure"
KPI_TAB_ENGINE_PART = "sov"
MENTION_SUMMARY_PARTS = ("measured",)
BRAND_TREND_METRICS = ("visibility", "share_of_voice", "position")
CHART_BRAND_TREND_METRICS = ("share_of_voice",)
OVERVIEW_TREND_METRICS = ("visibility", "share_of_voice", "sentiment", "position")
ENGINE_TREND_METRICS = ("visibility", "share_of_voice", "sentiment")
MENTION_COMPARE_METRICS = ("visibility", "share", "favorability", "position", "mentionsPerAnswer")


def brands_table_of(ctx: dict) -> dict:
    return VIEW_BRANDS_TABLE if ctx["surface"] in ("website", "project") else BRANDS_TABLE


async def fetch_mention_brands(filters: dict, ctx: dict, req: dict | None = None) -> dict:
    req = req if req is not None else brands_table_of(ctx)
    extra: dict = {}
    if req.get("top_n") is not None:
        extra["top_n"] = req["top_n"]
    if req.get("sort"):
        extra["sort"] = req["sort"]
    if req.get("split_own"):
        extra["split_own"] = True
    if req.get("full"):
        extra["full"] = True
    if req.get("include"):
        extra["include"] = list(req["include"])
    if req.get("group_by"):
        extra["group_by"] = req["group_by"]
    if req.get("group_by") and req.get("engine_only"):
        extra["engine_only"] = True
    res = await api.get("mentions/brands", query_params(filters, _qctx(ctx), extra))
    return {"data": res["data"], "meta": res["meta"]}


async def fetch_mention_types(filters: dict, ctx: dict, stance: bool = False) -> dict:
    res = await api.get("mentions/types", query_params(filters, _qctx(ctx), None if stance else {"include_stance": False}))
    return {"data": res["data"], "meta": res["meta"]}


async def fetch_engine_rows(filters: dict, ctx: dict, cycle_offset: int = 0, part: str | None = None) -> dict:
    extra: dict = {"part": part or SUB_KPI_ENGINE_PART}
    if cycle_offset:
        extra["cycle_offset"] = cycle_offset
    res = await api.get("kpi/engines", query_params(filters, _qctx(ctx), extra))
    return {"data": res["data"], "meta": res["meta"]}


async def fetch_mention_summary(filters: dict, ctx: dict, cycle_offset: int = 0) -> dict:
    common = query_params(filters, _qctx(ctx))
    res = await api.get("kpi/summary", summary_query(common, {"surface": ctx["surface"], "cycleOffset": cycle_offset,
                                                             "parts": list(MENTION_SUMMARY_PARTS)}))
    return {"data": res["data"], "meta": res["meta"]}


async def fetch_brand_trend(filters: dict, ctx: dict) -> dict:
    chart_only = ctx["surface"] != "global"
    req: dict = {"surface": ctx["surface"], "bucket": "cycle", "dimension": "brand",
                 "metrics": list(CHART_BRAND_TREND_METRICS if chart_only else BRAND_TREND_METRICS), "top": 10,
                 "splitOwn": True}
    if chart_only:
        req["measuredDays"] = False
    return await fetch_trend(query_params(filters, _qctx(ctx)), req)


async def fetch_overview_trend(filters: dict, ctx: dict) -> dict:
    return await fetch_trend(query_params(filters, _qctx(ctx)),
                             {"surface": ctx["surface"], "bucket": "cycle", "dimension": "none",
                              "metrics": list(OVERVIEW_TREND_METRICS)})


async def fetch_engine_type_trends(filters: dict, ctx: dict) -> dict:
    """B038: the engine and type trends in one call -> {dimension: {data, meta}}."""
    res = await fetch_trend(query_params(filters, _qctx(ctx)),
                            {"surface": ctx["surface"], "bucket": "cycle", "dimension": "engine",
                             "metrics": list(ENGINE_TREND_METRICS),
                             "dims": [{"dimension": "type", "metrics": ["type_exposure"]}]})
    return split_trend_dims(res)


# ── conversions: mentions.ts ────────────────────────────────────────────────

def to_mentions_brand_live(item: dict) -> dict:
    out: dict = {"brand": item["name"], "mentions": item["mentions"], "prompts": _nn(item.get("prompts"), 0),
                 "share": pct1_or_zero(item.get("share")), "mentionRate": pct1_or_zero(item.get("exposure")),
                 "avgPosition": rank_avg(item.get("avg_rank")), "isTracked": item.get("is_own"),
                 "sentiment": dict(item["sentiment"])}
    multi = item.get("multi")
    if multi:
        out["multi"] = {k: multi[k] for k in ("mentions", "answers", "prompts") if k in multi}
    if item.get("brand_key") is not None:
        out["brandKey"] = item["brand_key"]
    if item.get("own_brand_code"):
        out["ownBrandCode"] = item["own_brand_code"]
    return out


def own_sentiment_totals(brands: list[dict]) -> dict | None:
    t = {"positive": 0, "neutral": 0, "negative": 0, "mixed": 0}
    for b in brands:
        if not b.get("is_own"):
            continue
        for k in SENTIMENT_KEYS4:
            t[k] = t[k] + b["sentiment"][k]
    return t if t["positive"] + t["neutral"] + t["negative"] + t["mixed"] > 0 else None


def type_breakdown(counts: dict | None) -> dict:
    counts = counts or {}
    return {t: _nn(counts.get(t), 0) for t in MENTION_TYPES}


def to_type_totals(types: dict, brands: list[dict]) -> dict | None:
    own_mentions = 0
    for b in brands:
        if b.get("is_own"):
            own_mentions = own_mentions + b["mentions"]
    if own_mentions <= 0:
        return None
    by_type: dict = {}
    for r in types["by_type"]:
        by_type[r["type"]] = r.get("own_mentions")
    return type_breakdown(by_type)


def to_types_by_brand(data: dict) -> dict | None:
    totals = type_breakdown(data.get("types_total"))
    total = 0
    for t in MENTION_TYPES:
        total = total + totals[t]
    if total <= 0:
        return None
    return {"totals": totals,
            "brands": [{"brand": b["name"], "isTracked": b.get("is_own"), "types": type_breakdown(b.get("types"))}
                       for b in data["brands"]]}


def apply_weekly_trend_gaps(trend: dict | None, gap_weeks: list[str]) -> dict | None:
    """applyWeeklyTrendGaps + insertTrendGapSlots: gap weeks inside the axis that have no point."""
    if not trend or not gap_weeks:
        return trend
    rows = trend["points"]
    if len(rows) < 2:
        return trend
    present = {str(r["week"]) for r in rows}
    first, last = str(rows[0]["week"]), str(rows[-1]["week"])
    add = sorted((k for k in dict.fromkeys(gap_weeks) if k not in present and trend_gap_key_in_axis(k, first, last)),
                 key=code_unit_key)
    if not add:
        return trend
    out: list = []
    i = 0
    for row in rows:
        k = str(row["week"])
        while i < len(add) and add[i] < k:
            gap_row: dict = {"week": add[i], "gap": {"reason": "collection_error"}}
            for s in trend["series"]:
                gap_row[s] = None
            out.append(gap_row)
            i += 1
        out.append(row)
    return {"series": trend["series"], "points": out}


def build_weekly_trend(entries: list[dict], series: list, gap_weeks: list[str] | None = None) -> dict | None:
    """buildWeeklyTrend: entries {key, count, week} summed per week; fewer than 2 weeks -> None."""
    if not series:
        return None
    in_series = set(series)
    weeks: dict = {}
    for e in entries:
        if e["key"] not in in_series:
            continue
        wk = e.get("week")
        if not wk:
            continue
        bm = weeks.setdefault(wk, {})
        bm[e["key"]] = _nn(bm.get(e["key"]), 0) + e["count"]
    if len(weeks) < 2:
        return None
    points = []
    for wk in sorted(weeks, key=code_unit_key):
        bm = weeks[wk]
        row: dict = {"week": wk}
        for k in series:
            row[_key(k)] = _nn(bm.get(k), 0)
        points.append(row)
    return apply_weekly_trend_gaps({"series": series, "points": points}, list(gap_weeks or []))


def to_mention_trend(data: dict) -> dict | None:
    """B3 -> MentionTrend (the bottom weekly chart, toMentionTrend)."""
    series = [s for s in data["series"] if s.get("metric") == "share_of_voice"]
    ordered = [s for s in series if s.get("is_own")] + [s for s in series if not s.get("is_own")]
    labels: list = []
    entries: list[dict] = []
    gap_weeks: dict = {}
    round_of = {b["key"]: bucket_round_date(b) for b in data["buckets"]}
    for s in ordered:
        label = series_label(s, data)
        if label not in labels:
            labels.append(label)
        for p in s["points"]:
            rnd = round_of.get(p.get("bucket"))
            if rnd is None:
                rnd = p.get("bucket")
            if point_gap(p):
                gap_weeks[monday_of(rnd)] = True
                continue
            if not p.get("ratio"):
                continue
            entries.append({"date": rnd, "week": monday_of(rnd), "key": label, "count": p["ratio"]["num"]})
    latest_of_week: dict = {}
    for e in entries:
        if _nn(latest_of_week.get(e["week"]), "") < e["date"]:
            latest_of_week[e["week"]] = e["date"]
    weekly = [e for e in entries if latest_of_week.get(e["week"]) == e["date"]]
    return build_weekly_trend(weekly, labels, sorted(gap_weeks, key=code_unit_key))


def empty_mentions_live() -> dict:
    return {"summary": {"total": 0, "uniqueBrands": 0, "totalPrompts": 0}, "asOf": None, "brands": [],
            "perBrandPrompts": {}, "sentimentTotals": None, "typeTotals": None, "hasPosition": False, "trend": None}


def brands_truncated(res: dict) -> bool:
    return res["data"].get("truncated") is True or ((res["meta"] or {}).get("truncated") or {}).get("brands") is True


def to_mentions_live(p: dict) -> dict | None:
    """B1..B4 -> MentionsLive (toMentionsLive). p = {brands, types, summary, trend, trendFailed?}."""
    brands_res = p["brands"]
    if whole_suppression(brands_res["meta"]):
        return None
    d = brands_res["data"]
    if d["totals"]["answers"] == 0:
        return empty_mentions_live()
    summary = p.get("summary")
    types = p.get("types")
    trend = p.get("trend")
    out: dict = {"summary": {"total": d["totals"]["mentions_total"], "uniqueBrands": d["totals"]["brand_count"],
                             "totalPrompts": _nn(summary["data"]["params"].get("measured_prompts") if summary else None, None),
                             "totalAnswers": d["totals"]["answers"]}}
    if brands_truncated(brands_res):
        out["brandsTotal"] = d["totals"]["brand_count"]
    own = d["own"]
    out.update({
        "asOf": as_of_date(brands_res["meta"]),
        "brands": [to_mentions_brand_live(b) for b in d["brands"]],
        "perBrandPrompts": {},
        "sentimentTotals": own_sentiment_totals(d["brands"]),
        "typeTotals": to_type_totals(types["data"], d["brands"]) if types and not whole_suppression(types["meta"]) else None,
        "typesByBrand": to_types_by_brand(d),
        "hasPosition": any(_nn((b.get("avg_rank") or {}).get("count"), 0) > 0 for b in d["brands"]),
        "own": {"share": pct1_or_zero(own.get("share")), "avgPosition": rank_avg(own.get("avg_rank")),
                "mentionRate": pct1_or_zero(own.get("exposure"))},
        "trend": to_mention_trend(trend["data"]) if trend else None,
    })
    if p.get("trendFailed"):
        out["trendDegraded"] = True
    return out


def to_sub_kpi_row(r: dict) -> dict:
    def n(k: str) -> Any:
        return _nn(r.get(k), 0)
    ranked = n("ranked")
    return {"engine": r["engine"], "answers": n("answers"), "tracked": n("tracked"), "multi": n("multi"),
            "top1": n("top1"), "top3": n("top3"), "avgPosition": n("rank_sum") / ranked if ranked > 0 else None,
            "totalMentions": n("total_mentions"), "trackedMentions": n("tracked_mentions"),
            "sentMentions": n("sent_mentions"), "positiveMentions": n("positive_mentions"),
            "negativeMentions": n("negative_mentions"), "citTotal": n("cit_total"), "citOwned": n("cit_owned")}


_MENTION_KEYS = ("visibility", "share_of_voice", "sentiment", "position")


def to_sub_kpi_rows(engines: dict) -> list[dict]:
    s = (engines["meta"] or {}).get("suppressed") or {}
    if s.get("*") or any(s.get(k) == "hidden" for k in _MENTION_KEYS):
        return []
    return [to_sub_kpi_row(r) for r in engines["data"]["rows"]]


def to_standard_sub_kpis(engines: dict, summary: dict | None) -> dict:
    params = summary["data"]["params"] if summary and not whole_suppression(summary["meta"]) else None
    return {"rows": to_sub_kpi_rows(engines),
            "promptsWithoutBrand": _nn(params.get("prompts_without_brand"), None) if params else None,
            "measuredPrompts": params.get("measured_prompts") if params else None}


# ── loaders: mentions.ts ────────────────────────────────────────────────────

async def load_mentions_live(filters: dict, ctx: dict) -> dict | None:
    label = f"{ctx['surface']}Mentions"
    types_run = start_early(lambda: fetch_mention_types(filters, ctx))
    summary_run = start_early(lambda: fetch_mention_summary(filters, ctx))
    trend_run = start_early(lambda: fetch_brand_trend(filters, ctx))
    brands = await degrade_on_api_failure(label, lambda: fetch_mention_brands(filters, ctx))
    if not brands:
        return None
    types, summary, trend = await asyncio.gather(
        degrade_on_api_failure(f"{label}.types", types_run),
        degrade_on_api_failure(f"{label}.summary", summary_run),
        degrade_on_api_failure(f"{label}.trend", trend_run),
    )
    return to_mentions_live({"brands": brands, "types": types, "summary": summary, "trend": trend,
                             "trendFailed": trend is None})


async def load_mentions_brands(filters: dict, ctx: dict) -> list[dict] | None:
    """load_mentions_live(...)["brands"] without its types / summary / trend reads: None when the read failed
    (marked as load_mentions_live marks it) or is suppressed, [] on a window without answers."""
    res = await degrade_on_api_failure(f"{ctx['surface']}Mentions", lambda: fetch_mention_brands(filters, ctx))
    if not res or whole_suppression(res["meta"]):
        return None
    if res["data"]["totals"]["answers"] == 0:
        return []
    return [to_mentions_brand_live(b) for b in res["data"]["brands"]]


def mentions_degraded(ctx: dict) -> dict:
    s = ctx["surface"]
    return {"data": was_degraded(f"{s}Mentions"), "types": was_degraded(f"{s}Mentions.types"),
            "subKpis": any(was_degraded(lb) for lb in (f"{s}SubKpis", f"{s}SubKpis.summary", f"{s}SubKpisPrev",
                                                        f"{s}Mentions.summary"))}


async def _brands_or_none(filters: dict, ctx: dict) -> dict | None:
    res = await degrade_on_api_failure(f"{ctx['surface']}Mentions", lambda: fetch_mention_brands(filters, ctx))
    return None if not res or whole_suppression(res["meta"]) else res


async def load_mentions_as_of(filters: dict, ctx: dict) -> str | None:
    res = await _brands_or_none(filters, ctx)
    return as_of_date(res["meta"]) if res else None


async def load_mention_brand_rows(filters: dict, ctx: dict) -> list[dict]:
    res = await _brands_or_none(filters, ctx)
    return [to_mentions_brand_live(b) for b in res["data"]["brands"]] if res else []


async def load_sentiment_totals(filters: dict, ctx: dict) -> dict | None:
    res = await _brands_or_none(filters, ctx)
    return own_sentiment_totals(res["data"]["brands"]) if res else None


async def load_types_by_brand(filters: dict, ctx: dict) -> dict | None:
    res = await _brands_or_none(filters, ctx)
    return to_types_by_brand(res["data"]) if res else None


async def load_sub_kpis(filters: dict, ctx: dict) -> dict:
    s = ctx["surface"]
    engines, summary = await asyncio.gather(
        degrade_on_api_failure(f"{s}SubKpis", lambda: fetch_engine_rows(filters, ctx)),
        degrade_on_api_failure(f"{s}SubKpis.summary", lambda: fetch_mention_summary(filters, ctx)),
    )
    if not engines:
        return {"rows": [], "promptsWithoutBrand": None,
                "measuredPrompts": summary["data"]["params"].get("measured_prompts") if summary else None}
    return to_standard_sub_kpis(engines, summary)


def first_cycle(meta: dict | None) -> str | None:
    cycles = sorted((meta or {}).get("cycles") or [], key=code_unit_key)
    return cycles[0] if cycles else None


async def load_sub_kpis_prev(filters: dict, ctx: dict) -> dict | None:
    """loadSubKpisPrev: cumulative -> up to the window's first round (None with fewer than 2 rounds);
    snapshot -> cycle_offset=1. A transient failure -> None (marked)."""

    async def run() -> dict | None:
        if filters.get("dateFrom") or filters.get("dateTo"):
            cur = await fetch_mention_summary(filters, ctx)
            cycles = sorted(dict.fromkeys((cur["meta"] or {}).get("cycles") or []), key=code_unit_key)
            if len(cycles) < 2:
                return None
            first = cycles[0]
            frm = filters["dateFrom"] if filters.get("dateFrom") and filters["dateFrom"] <= first else first
            prev_filters = {**filters, "dateFrom": frm, "dateTo": first}
            engines, summary = await asyncio.gather(fetch_engine_rows(prev_filters, ctx),
                                                    fetch_mention_summary(prev_filters, ctx))
            return {"sub": to_standard_sub_kpis(engines, summary), "asOf": first}
        engines, summary = await asyncio.gather(fetch_engine_rows(filters, ctx, cycle_offset=1),
                                                fetch_mention_summary(filters, ctx, cycle_offset=1))
        if whole_suppression(engines["meta"]) or not (engines["meta"] or {}).get("as_of"):
            return None
        return {"sub": to_standard_sub_kpis(engines, summary), "asOf": engines["meta"]["as_of"]}

    try:
        return await run()
    except Exception as exc:  # noqa: BLE001
        if not is_degradable(exc):
            raise
        mark_degraded(f"{ctx['surface']}SubKpisPrev")
        return None


# ── sub-kpis.ts buildMentionSubKpis ─────────────────────────────────────────

def build_mention_sub_kpis(sub: dict | None) -> dict | None:
    """StandardSubKpis -> MentionSubKpis (the website/project summary cards)."""
    if not sub or not sub["rows"]:
        return None
    rows = sub["rows"]

    def total(k: str) -> Any:
        s = 0
        for r in rows:
            s = s + r[k]
        return s

    tracked, answers, sent = total("tracked"), total("answers"), total("sentMentions")
    return {"missingPrompts": sub.get("promptsWithoutBrand"),
            "multiMentionAnswers": total("multi"),
            "top3Rate": round1((100 * total("top3")) / tracked) if tracked > 0 else None,
            "top3Count": total("top3") if tracked > 0 else None,
            "top3Base": tracked if tracked > 0 else None,
            "positiveKeywords": total("positiveMentions") if sent > 0 else None,
            "negativeKeywords": total("negativeMentions") if sent > 0 else None,
            "ownMentionRate": round1((100 * tracked) / answers) if answers > 0 else None,
            "totalMentions": total("totalMentions"),
            "measuredPrompts": sub.get("measuredPrompts")}


# ── kpi-tab.ts ──────────────────────────────────────────────────────────────

KPI_TAB_DEGRADE_LABELS = {"hero": "standardKpiHero", "types": "standardKpiTypes"}
FIRST_POSITION_HERO_LABELS = ("standardKpiFirstPosition.trend", "standardKpiFirstPosition.summary",
                              "standardKpiFirstPosition.overview")
HERO_FIELD = {"exposure": "visibility", "sov": "share_of_voice"}


def was_kpi_tab_degraded(which: str) -> bool:
    return was_degraded(KPI_TAB_DEGRADE_LABELS[which])


def was_first_position_hero_degraded() -> bool:
    return any(was_degraded(lb) for lb in FIRST_POSITION_HERO_LABELS)


def pct_or_null(n: float, d: float) -> float | None:
    """kpi-tab pctOrNull = mirrorPct({num, den}): Math.round(n/d*1000)/10, d 0 -> None."""
    return mirror_pct({"num": n, "den": d})


def _pair(r: dict | None) -> dict:
    return {"numerator": _nn((r or {}).get("num"), 0), "denominator": _nn((r or {}).get("den"), 0)}


def to_overview_cards(data: dict) -> dict:
    return {"visibility": _pair(data.get("visibility")), "shareOfVoice": _pair(data.get("share_of_voice")),
            "sentiment": _pair(data.get("sentiment")),
            "position": {"avgPosition": rank_avg(data.get("position")),
                         "sampledAnswers": _nn((data.get("position") or {}).get("count"), 0)},
            "citationShare": _pair(data.get("citation_share"))}


def to_hero_sub_kpis(res: dict, metric: str) -> dict:
    params = None if whole_suppression(res["meta"]) else res["data"]["params"]
    field = HERO_FIELD[metric]
    measured = params.get("measured_prompts") if params else None
    if not params or suppression_of(res["meta"], field) or not res["data"].get(field):
        return {"rows": [], "promptsWithoutBrand": None, "measuredPrompts": measured}
    return {"rows": [], "promptsWithoutBrand": None, "measuredPrompts": measured,
            "overviewCards": to_overview_cards(res["data"])}


def to_favorability_sub_kpis(engines: dict) -> dict:
    return {"rows": to_sub_kpi_rows(engines), "promptsWithoutBrand": None, "measuredPrompts": None}


def _empty_sub() -> dict:
    return {"rows": [], "promptsWithoutBrand": None, "measuredPrompts": None}


async def load_kpi_hero_sub_kpis(filters: dict, ctx: dict, metric: str) -> dict:
    label = KPI_TAB_DEGRADE_LABELS["hero"]
    if metric == "favorability":
        engines = await degrade_on_api_failure(label, lambda: fetch_engine_rows(filters, ctx, part=KPI_TAB_ENGINE_PART))
        return to_favorability_sub_kpis(engines) if engines else _empty_sub()
    res = await degrade_on_api_failure(label, lambda: fetch_mention_summary(filters, ctx))
    return to_hero_sub_kpis(res, metric) if res else _empty_sub()


async def load_kpi_hero_sub_kpis_prev(filters: dict, ctx: dict, metric: str) -> dict | None:
    """Period mode -> None; snapshot -> the previous round ({sub, asOf}) or None."""
    if filters.get("dateFrom") or filters.get("dateTo"):
        return None

    async def run() -> dict | None:
        if metric == "favorability":
            engines = await fetch_engine_rows(filters, ctx, cycle_offset=1, part=KPI_TAB_ENGINE_PART)
            if whole_suppression(engines["meta"]) or not (engines["meta"] or {}).get("as_of"):
                return None
            return {"sub": to_favorability_sub_kpis(engines), "asOf": engines["meta"]["as_of"]}
        res = await fetch_mention_summary(filters, ctx, cycle_offset=1)
        if whole_suppression(res["meta"]) or not (res["meta"] or {}).get("as_of"):
            return None
        return {"sub": to_hero_sub_kpis(res, metric), "asOf": res["meta"]["as_of"]}

    return await degrade_on_api_failure("standardKpiHeroPrev", run)


def to_engine_point(r: dict) -> dict:
    def n(k: str) -> Any:
        return _nn(r.get(k), 0)
    answers, total = n("answers"), n("total_mentions")
    return {"engine": r["engine"], "answers": answers, "trackedAnswers": n("tracked"),
            "exposurePct": pct_or_null(n("tracked"), answers), "totalMentions": total,
            "trackedMentions": n("tracked_mentions"), "sovPct": pct_or_null(n("tracked_mentions"), total),
            "sentSignals": n("sent_mentions"), "positiveSignals": n("positive_mentions"),
            "negativeSignals": n("negative_mentions")}


def to_latest_brands(data: dict) -> list[dict]:
    out = []
    for e in data.get("by_engine") or []:
        for b in e["brands"]:
            out.append({"engine": e["engine"], "brand": b["name"], "isTracked": b.get("is_own"),
                        "answersWithBrand": b["exposure"]["num"], "mentions": b["mentions"]})
    return out


def _index(points: list[dict]) -> dict:
    out: dict = {}
    for p in points:
        out[p.get("bucket")] = p
    return out


def to_engine_buckets(data: dict) -> dict:
    by_engine: dict = {}
    for s in data["series"]:
        if not s.get("key"):
            continue
        m = by_engine.setdefault(s["key"], {})
        if s.get("metric") not in m:
            m[s.get("metric")] = _index(s["points"])
    engines = sorted(by_engine, key=code_unit_key)
    buckets = []
    for b in data["buckets"]:
        points = []
        for engine in engines:
            m = by_engine[engine]
            vp = (m.get("visibility") or {}).get(b["key"])
            if not vp or point_gap(vp) or vp.get("gap") or not vp.get("ratio"):
                continue
            v = vp["ratio"]
            s = (m.get("share_of_voice") or {}).get(b["key"])
            e = (m.get("sentiment") or {}).get(b["key"])
            sv = s.get("ratio") if s and not s.get("gap") else None
            ev = e.get("ratio") if e and not e.get("gap") else None
            points.append({"engine": engine, "answers": v["den"], "trackedAnswers": v["num"],
                           "exposurePct": pct_or_null(v["num"], v["den"]),
                           "totalMentions": _nn((sv or {}).get("den"), 0), "trackedMentions": _nn((sv or {}).get("num"), 0),
                           "sovPct": pct_or_null(sv["num"], sv["den"]) if sv else None,
                           "sentSignals": _nn((ev or {}).get("den"), 0), "positiveSignals": _nn((ev or {}).get("num"), 0),
                           "negativeSignals": _nn(e.get("negative"), 0) if e and not e.get("gap") else 0})
        if not points:
            continue
        buckets.append({"bucketStart": bucket_round_date(b), "measuredDays": _nn(b.get("measured_days"), 0),
                        "firstAt": None, "lastAt": None, "engines": points})
    return {"engines": engines, "buckets": buckets}


def to_type_trend(data: dict) -> list[dict]:
    idx: dict = {}
    for s in data["series"]:
        if s.get("key"):
            idx[s["key"]] = _index(s["points"])
    out = []
    for b in data["buckets"]:
        answers = None
        by_type: dict = {}
        for t in MENTION_TYPES:
            p = (idx.get(t) or {}).get(b["key"])
            if p and not p.get("gap") and p.get("ratio"):
                if answers is None:
                    answers = p["ratio"]["den"]
                by_type[t] = p["ratio"]["num"]
            else:
                by_type[t] = 0
        if answers is None:
            continue
        out.append({"bucketStart": bucket_round_date(b), "answers": answers, "byType": by_type})
    return out


def to_engine_kpi_trend(p: dict) -> dict:
    """K-3 + M-1(engine) + T-1(engine, type, none) -> EngineKpiTrend."""
    degraded = not p.get("engineTrend") or not p.get("overview") or not p.get("typeTrend") or not p.get("latestBrands")
    eng = to_engine_buckets(p["engineTrend"]["data"]) if p.get("engineTrend") else {"engines": [], "buckets": []}
    engines_res = p["engines"]
    latest = [] if whole_suppression(engines_res["meta"]) else [to_engine_point(r) for r in engines_res["data"]["rows"]]
    lb = p.get("latestBrands")
    out: dict = {"unit": "week", "engines": eng["engines"], "buckets": eng["buckets"],
                 "latestBrands": to_latest_brands(lb["data"]) if lb and not whole_suppression(lb["meta"]) else [],
                 "typeTrend": to_type_trend(p["typeTrend"]["data"]) if p.get("typeTrend") else [],
                 "latest": latest, "latestMeasuredAt": _nn((engines_res["meta"] or {}).get("as_of"), None),
                 "trendDegraded": degraded, "windowStartBucket": None, "windowEndBucket": None}
    if p.get("overview"):
        base = to_standard_trend_buckets(p["overview"]["data"])
        slots = with_engine_breakdown(base, p["engineTrend"]["data"]) if p.get("engineTrend") else base
        out["overviewSlots"] = slots
        out["overviewDeltaSlots"] = slots
        out["trendGrid"] = trend_grid_of(p["overview"]["data"])
    return out


async def load_engine_kpi_trend(filters: dict, ctx: dict) -> dict | None:
    brands_run = start_early(lambda: fetch_mention_brands(filters, ctx, ENGINE_BRANDS))
    trends_run = start_early(lambda: fetch_engine_type_trends(filters, ctx))
    overview_run = start_early(lambda: fetch_overview_trend(filters, ctx))
    engines = await degrade_on_api_failure(
        "standardKpiEngineTrend", lambda: fetch_engine_rows(filters, ctx, part=KPI_TAB_ENGINE_PART))
    if not engines:
        return None
    latest_brands, trends, overview = await asyncio.gather(
        degrade_on_api_failure("standardKpiEngineTrend.brands", brands_run),
        degrade_on_api_failure("standardKpiEngineTrend.trend", trends_run),
        degrade_on_api_failure("standardKpiEngineTrend.overview", overview_run),
    )
    return to_engine_kpi_trend({"engines": engines, "latestBrands": latest_brands,
                                "engineTrend": (trends or {}).get("engine"), "typeTrend": (trends or {}).get("type"),
                                "overview": overview})


async def load_brand_trend(filters: dict, ctx: dict) -> dict | None:
    res = await degrade_on_api_failure("standardKpiBrandTrend", lambda: fetch_brand_trend(filters, ctx))
    return to_brand_trend_result(res["data"]) if res else None


def to_first_position_latest(series: list, brands: dict | None) -> list[dict]:
    rows = (brands or {}).get("brands") or []
    by_name: dict = {}
    for b in rows:
        by_name[b["name"]] = b
    if series:
        names = list(series)
    else:
        names = []
        competitors = 0
        for b in rows:
            if b.get("is_own"):
                names.append(b["name"])
            else:
                competitors += 1
                if competitors - 1 < 10:
                    names.append(b["name"])
    out = []
    for name in names:
        b = by_name.get(name)
        out.append({"brand": name, "isTracked": _nn((b or {}).get("is_own"), False),
                    "avgPosition": rank_avg((b or {}).get("avg_rank")),
                    "rankedAnswers": _nn(((b or {}).get("avg_rank") or {}).get("count"), 0),
                    "mentions": _nn((b or {}).get("mentions"), 0)})
    return rank_first_position_rows(out)


def to_first_position_result_api(p: dict) -> dict:
    base = to_first_position_result(p["trend"]["data"]) if p.get("trend") else {"unit": "week", "brands": [],
                                                                                 "buckets": [], "latest": []}
    br = p.get("brands")
    brands = br["data"] if br and not whole_suppression(br["meta"]) else None
    out = {**base, "latest": to_first_position_latest(base["brands"], brands)}
    summary = p.get("summary")
    if summary and not whole_suppression(summary["meta"]) and not suppression_of(summary["meta"], "position"):
        out["overviewCards"] = to_overview_cards(summary["data"])
    if p.get("overview"):
        slots = to_standard_trend_buckets(p["overview"]["data"])
        out["overviewSlots"] = slots
        out["overviewDeltaSlots"] = slots
    return out


async def load_first_position(filters: dict, ctx: dict) -> dict | None:
    trend_run = start_early(lambda: fetch_brand_trend(filters, ctx))
    summary_run = start_early(lambda: fetch_mention_summary(filters, ctx))
    overview_run = start_early(lambda: fetch_overview_trend(filters, ctx))
    brands = await degrade_on_api_failure("standardKpiFirstPosition", lambda: fetch_mention_brands(filters, ctx))
    if not brands:
        return None
    t_label, s_label, o_label = FIRST_POSITION_HERO_LABELS
    trend, summary, overview = await asyncio.gather(
        degrade_on_api_failure(t_label, trend_run),
        degrade_on_api_failure(s_label, summary_run),
        degrade_on_api_failure(o_label, overview_run),
    )
    return to_first_position_result_api({"trend": trend, "brands": brands, "summary": summary, "overview": overview})


def to_type_kpi(data: dict) -> dict:
    by_type: dict = {}
    for r in data["by_type"]:
        by_type[r["type"]] = r
    total_answers = data["answers_total"]
    rows = []
    for t in MENTION_TYPES:
        r = by_type.get(t) or {}
        own, other = _nn(r.get("own_mentions"), 0), _nn(r.get("other_mentions"), 0)
        total = own + other
        rows.append({"type": t, "ownMentions": own, "otherMentions": other, "totalMentions": total,
                     "ownAnswers": _nn(r.get("own_answers"), 0), "otherAnswers": _nn(r.get("other_answers"), 0),
                     "ownExposurePct": pct_or_null(_nn(r.get("own_answers"), 0), total_answers),
                     "otherExposurePct": pct_or_null(_nn(r.get("other_answers"), 0), total_answers),
                     "ownSharePct": pct_or_null(own, total)})

    def matrix(scope: str) -> list[dict]:
        out = []
        for t in MENTION_TYPES:
            c = next((m for m in data["sentiment_matrix"] if m.get("scope") == scope and m.get("type") == t), None) or {}
            out.append({"type": t, "rows": _nn(c.get("rows"), 0), "positive": _nn(c.get("positive"), 0),
                        "neutral": _nn(c.get("neutral"), 0), "negative": _nn(c.get("negative"), 0),
                        "mixed": _nn(c.get("mixed"), 0)})
        return out

    total_mentions = own_mentions = 0
    for r in rows:
        total_mentions = total_mentions + r["totalMentions"]
    for r in rows:
        own_mentions = own_mentions + r["ownMentions"]
    return {"totalAnswers": total_answers, "totalMentions": total_mentions, "ownMentions": own_mentions,
            "rows": rows, "sentimentMatrix": {"own": matrix("own"), "all": matrix("all")}}


async def load_type_kpi(filters: dict, ctx: dict) -> dict | None:
    res = await degrade_on_api_failure(KPI_TAB_DEGRADE_LABELS["types"], lambda: fetch_mention_types(filters, ctx))
    if not res or whole_suppression(res["meta"]):
        return None
    return to_type_kpi(res["data"])


# ── period block of the KPI body ────────────────────────────────────────────

async def load_period_compare(filters: dict, ctx: dict) -> dict:
    """resolveRequestComparePeriodShape (api source: month -> week -> window) + fetchPeriodCompareApi
    (degrade "standardPeriodCompare" -> None): {compare, days?, kind, shape}."""
    shape = resolve_request_compare_period_shape(filters.get("dateFrom"), filters.get("dateTo"))
    common = query_params(filters, _qctx(ctx))
    compare = await degrade(
        "standardPeriodCompare",
        lambda: fetch_period_compare_api(filters, common, {"surface": ctx["surface"], "kind": shape["kind"],
                                                           "metrics": list(MENTION_COMPARE_METRICS), "card": False}),
        None)
    out: dict = {"compare": compare}
    if shape.get("days") is not None:
        out["days"] = shape["days"]
    out["kind"] = shape["kind"]
    out["shape"] = shape
    return out


# ── the period before (period mode) ──────────────────────────────────────────
# A Δ next to a period total compares it with the period just before — the window /v1/kpi/compare compares
# 당사 with — for the rivals and the engines too (2026-10-29 metric review R3: their Δ was the last round's).

async def load_prev_period_brands(filters: dict, ctx: dict) -> list[dict] | None:
    """Period mode: the body's brand rows on the period before ([] = nothing measured then, or the read
    failed); None outside period mode."""
    prev = prev_period_filters(filters)
    if prev is None:
        return None
    res = await degrade_on_api_failure(f"{ctx['surface']}MentionsPrevPeriod", lambda: fetch_mention_brands(prev, ctx, PREV_BRANDS_TABLE))
    if not res or whole_suppression(res["meta"]) or res["data"]["totals"]["answers"] == 0:
        return []
    return [to_mentions_brand_live(b) for b in res["data"]["brands"]]


async def load_prev_period_engines(filters: dict, ctx: dict) -> dict | None:
    """Period mode: {engine: the engine card's 당사 point} on the period before; None outside period mode."""
    prev = prev_period_filters(filters)
    if prev is None:
        return None
    res = await degrade_on_api_failure("standardKpiEngineTrend.prevPeriod",
                                       lambda: fetch_engine_rows(prev, ctx, part=KPI_TAB_ENGINE_PART))
    if not res or whole_suppression(res["meta"]):
        return {}
    return {p["engine"]: p for p in (to_engine_point(r) for r in res["data"]["rows"])}


# ── helpers ─────────────────────────────────────────────────────────────────

def _nn(v: Any, default: Any) -> Any:
    return v if v is not None else default


def _key(k: Any) -> str:
    """A JS property key (String(k))."""
    if k is None:
        return "null"
    if isinstance(k, bool):
        return "true" if k else "false"
    return str(k)
