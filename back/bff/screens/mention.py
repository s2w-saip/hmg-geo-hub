"""Mention analysis screens (/standard, /website, /projects/{id} answer-analysis/mention).

One builder per Suspense section of the pages; each returns what that section rendered, every value
precomputed (bff.screens.mention_view = kpi-view.ts, bff.screens.mention_data = the adapters).
The query is the page's URL search params plus the route context (`ctx.metric`, `ctx.surface`,
`ctx.project_id`). Interactive choices of a section (competitor picks, type scope, competitor of the
type stack, ladder toggle, table sorts) come precomputed for every option; the client only selects.
"""
from __future__ import annotations

import asyncio
from typing import Any

from bff.screens import screen, split_context
from bff.screens._convert import round1
from bff.screens._period import kst_today, period_caption, period_chip, to_period_delta_view
from bff.screens._sort import locale_compare, sort_by
from bff.screens.mention_data import (
    begin_degrade_scope, load_brand_trend, load_engine_kpi_trend, load_first_position, load_kpi_hero_sub_kpis,
    load_kpi_hero_sub_kpis_prev, load_mention_brand_rows, load_mentions_as_of, load_mentions_live,
    load_period_compare, load_sentiment_totals, load_type_kpi, load_types_by_brand, mention_filters,
    mentions_degraded, surface_filters, was_first_position_hero_degraded, was_kpi_tab_degraded,
)
from bff.screens.mention_view import (
    brand_row_values, brand_trend_chart, competitor_kpi_rows, coverage_entries, delta_pp, engine_competitor_bars,
    engine_kpi_bars, engine_kpi_series, engine_trend_series_available, favorability_hero, favorability_trend_points,
    first_rank_competitor_cards, first_rank_hero, hero_trend_available, kpi_hero, kpi_trend_points,
    overlay_first_position_values, overview_delta_from_slots, own_share_donut, pct_or_null, rank_table_rows, rank_trend_chart,
    sentiment_segments, trend_axis, trend_coverage, type_combo_points, type_kpi_bars, type_sentiment_rows,
)

METRICS = ("exposure", "sov")
SPARK_CYCLES = 4
HERO_TOP_COMPETITORS = 4


def _metric(ctx: dict) -> str:
    m = ctx.get("metric")
    return m if m in METRICS else "exposure"


def _sign(x: float) -> int:
    return (x > 0) - (x < 0)


def _key_of(metric: str) -> str:
    return "visibility" if metric == "exposure" else "shareOfVoice"


# ── header + KPI body frame ─────────────────────────────────────────────────

@screen("mention/as-of")
async def as_of(q) -> dict:
    """Header pill / filter bar chip: meta.as_of of the brands call (loadMentionsAsOf); with
    ctx.surface=website it reads the website page's filters."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = surface_filters(ctx, sp)
    return {"asOf": await load_mentions_as_of(filters, mctx)}


def period_slots(compare: list | None, days) -> dict | None:
    """What PeriodDeltaSlot draws per metric (it used to call periodChip/periodCaption itself):
    the chip of the result and its caption for a window of `days ?? 0` (kind "window")."""
    if compare is None:
        return None
    out = {}
    for r in compare:
        chip_in = {"metric": r["metric"], **({"delta": r["delta"]} if "delta" in r else {})}
        out.setdefault(r["metric"], {"chip": period_chip(chip_in),
                                     "caption": period_caption(r, {"days": days if days is not None else 0, "kind": "window"})})
    return out


@screen("mention/kpi-period")
async def kpi_period(q) -> dict:
    """MentionsKpiBody frame: the period compare of the four tabs (one call) and the calendar-month line.
    `ctx.today` pins the KST day of the month label (tests); default: today in KST."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    p = await load_period_compare(filters, mctx)
    shape, compare = p["shape"], p["compare"]
    out: dict = {"periodCompare": compare, "periodSlots": period_slots(compare, p.get("days"))}
    if "days" in p:
        out["periodDays"] = p["days"]
    month_line = None
    if shape.get("months") and compare is not None:
        cur_lo = ((shape.get("weeks") or {}).get("cur") or {}).get("lo") or ((shape.get("months") or {}).get("cur") or {}).get("lo") \
            or filters.get("dateFrom")
        month_line = to_period_delta_view(compare, {"days": p.get("days") or 0, "kind": shape["kind"], "curLo": cur_lo,
                                                    "todayKst": ctx.get("today") or kst_today()})
    out["monthLine"] = month_line
    return out


# ── exposure / share tab ───────────────────────────────────────────────────

@screen("mention/kpi-hero")
async def kpi_hero_screen(q) -> dict:
    ctx, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    metric = _metric(ctx)
    sub = await load_kpi_hero_sub_kpis(filters, mctx, metric)
    return {"hero": kpi_hero(sub, metric), "degraded": was_kpi_tab_degraded("hero")}


@screen("mention/kpi-hero-delta")
async def kpi_hero_delta(q) -> dict:
    """HeroDelta fallback badge (cycle Δ -> previous-round Δ) and HeroDeltaBasis caption."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    metric = _metric(ctx)
    sub, prev, engine = await asyncio.gather(load_kpi_hero_sub_kpis(filters, mctx, metric),
                                             load_kpi_hero_sub_kpis_prev(filters, mctx, metric),
                                             load_engine_kpi_trend(filters, mctx))
    own_pct = kpi_hero(sub, metric)["pct"]
    prev_sub = (prev or {}).get("sub")
    cycle = overview_delta_from_slots((engine or {}).get("overviewDeltaSlots"), _key_of(metric))
    value = cycle["pp"] if cycle else delta_pp(own_pct, kpi_hero(prev_sub, metric)["pct"]) if prev_sub else None
    return {"value": value, "basis": _basis(cycle, (prev or {}).get("asOf"))}


def _basis(cycle: dict | None, prev_date: str | None) -> dict | None:
    if cycle:
        return {"key": "hero.deltaBasisCycle", "date": cycle["basisDate"]}
    if prev_date:
        return {"key": "hero.deltaBasis", "date": prev_date}
    return None


def _top_competitors(rows: list[dict]) -> list[dict]:
    def cmp(a: dict, b: dict) -> int:
        if a["pct"] is None and b["pct"] is None:
            return 0
        if a["pct"] is None:
            return 1
        if b["pct"] is None:
            return -1
        return _sign(b["pct"] - a["pct"])
    return sort_by([r for r in rows if not r["isTracked"]], cmp)[:HERO_TOP_COMPETITORS]


def _own_brand_label(rows: list[dict]) -> dict:
    tracked = [r for r in rows if r["isTracked"]]
    if len(tracked) == 1:
        return {"kind": "brand", "brand": tracked[0]["brand"]}
    if len(tracked) > 1:
        return {"kind": "set", "n": len(tracked)}
    return {"kind": "default"}


@screen("mention/kpi-competitors")
async def kpi_competitors(q) -> dict:
    """HeroCompetitors (top 4) + CompetitorBlock (table, donut base, coverage) of one metric."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    metric = _metric(ctx)
    sub, brands, trend = await asyncio.gather(load_kpi_hero_sub_kpis(filters, mctx, metric),
                                              load_mention_brand_rows(filters, mctx), load_brand_trend(filters, mctx))
    own_pct = kpi_hero(sub, metric)["pct"]
    rows = competitor_kpi_rows({"brands": brands, "trend": trend, "metric": metric, "ownPct": own_pct, "values": None})
    pcts = [r["pct"] if r["pct"] is not None else 0 for r in rows]
    return {"ownPct": own_pct, "rows": rows, "top": _top_competitors(rows),
            "coverage": trend_coverage(trend_axis(trend["buckets"], trend["unit"], trend) if trend else []),
            "donut": own_share_donut(own_pct), "barMax": max([1, *pcts]), "ownBrand": _own_brand_label(rows)}


@screen("mention/kpi-hero-trend")
async def kpi_hero_trend(q) -> dict:
    """HeroTrend: the share tab's brand lines, the degraded notice, or the own single line."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    metric = _metric(ctx)
    sub, brands, trend, engine = await asyncio.gather(
        load_kpi_hero_sub_kpis(filters, mctx, metric), load_mention_brand_rows(filters, mctx),
        load_brand_trend(filters, mctx), load_engine_kpi_trend(filters, mctx))
    own_pct = kpi_hero(sub, metric)["pct"]
    rows = competitor_kpi_rows({"brands": brands, "trend": trend, "metric": metric, "ownPct": own_pct, "values": None})
    chart = brand_trend_chart(rows, trend, metric)
    if metric == "sov" and chart["series"]:
        return {"kind": "brand", "chart": chart}
    if not hero_trend_available(engine):
        return {"kind": "degraded"}
    points = kpi_trend_points(engine, metric)
    return {"kind": "line", "points": points, "coverage": coverage_entries(points)}


@screen("mention/kpi-engines")
async def kpi_engines(q) -> dict:
    """EngineBlock (bars, own vs competitor average, engine lines) and TypeCombo (one engine trend read)."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    metric = _metric(ctx)
    engine = await load_engine_kpi_trend(filters, mctx)
    coverage = coverage_entries(kpi_trend_points(engine, metric))
    return {"engine": {"bars": engine_kpi_bars(engine, metric), "competitorBars": engine_competitor_bars(engine, metric),
                       "series": engine_kpi_series(engine, metric), "coverage": coverage,
                       "trendUnavailable": not engine_trend_series_available(engine)},
            "combo": {"combo": type_combo_points(engine), "coverage": coverage,
                      "trendUnavailable": engine is None or engine.get("trendDegraded") is True}}


@screen("mention/kpi-types")
async def kpi_types(q) -> dict:
    """TypeBlock: bars of both scopes, the per-competitor segments of the stacked scope, the total row."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    metric = _metric(ctx)
    kpi, by_brand, sub = await asyncio.gather(load_type_kpi(filters, mctx), load_types_by_brand(filters, mctx),
                                              load_kpi_hero_sub_kpis(filters, mctx, metric))
    return {**type_bars_view(kpi, by_brand, metric), "total": _type_total(kpi, by_brand, sub, metric),
            "degraded": was_kpi_tab_degraded("types")}


def _type_total(kpi: dict | None, by_brand: dict | None, sub: dict | None, metric: str) -> dict:
    own_signals = None
    if kpi:
        own_signals = 0
        for b in type_kpi_bars({"kpi": kpi, "typesByBrand": by_brand, "metric": metric, "scope": "own"}):
            own_signals = own_signals + b["ownSignals"]
    return {"pct": kpi_hero(sub, metric)["pct"], "ownSignals": own_signals}


def type_bars_view(kpi: dict | None, by_brand: dict | None, metric: str) -> dict:
    """typeKpiBars for the own scope, the stacked scope without a competitor, and the stacked scope with
    each competitor of the dropdown (the non-tracked typesByBrand rows): per competitor and type
    [competitorPct, otherPct, competitorSignals, otherSignals] (the other fields do not change)."""
    competitors = [b["brand"] for b in (by_brand or {}).get("brands") or [] if not b["isTracked"]]
    base = {"kpi": kpi, "typesByBrand": by_brand, "metric": metric}
    own = type_kpi_bars({**base, "scope": "own"})
    all_ = type_kpi_bars({**base, "scope": "all", "competitor": None})
    per: dict = {}
    if kpi and by_brand:
        # typeKpiBars(scope all, competitor c) per competitor, with the per-type parts that do not depend
        # on c (total, own sum) computed once: same expressions, same order.
        first: dict = {}
        for b in by_brand["brands"]:
            if not b["isTracked"] and b["brand"] not in first:
                first[b["brand"]] = b
        parts = []
        for r in kpi["rows"]:
            total = by_brand["totals"][r["type"]]
            own_sum = 0
            for b in by_brand["brands"]:
                if b["isTracked"]:
                    own_sum = own_sum + b["types"][r["type"]]
            parts.append((r["type"], total, own_sum, pct_or_null(own_sum, total)))
        for c in competitors:
            if c in per:
                continue
            hit = first.get(c)
            segs = []
            for typ, total, own_sum, own_pct in parts:
                comp = hit["types"][typ] if hit else 0
                rest = max(0, total - own_sum - comp)
                if total <= 0:
                    segs.append([None, None, comp, rest])
                    continue
                comp_pct = pct_or_null(comp, total) if hit else None
                other = round1(100 - (own_pct if own_pct is not None else 0) - (comp_pct if comp_pct is not None else 0))
                segs.append([comp_pct, max(0, other), comp, rest])
            per[c] = segs
    else:
        for c in competitors:
            if c not in per:
                per[c] = [[b["competitorPct"], b["otherPct"], b["competitorSignals"], b["otherSignals"]]
                          for b in type_kpi_bars({**base, "scope": "all", "competitor": c})]
    return {"own": own, "all": all_, "byCompetitor": per, "competitors": competitors}


# ── favorability tab ────────────────────────────────────────────────────────

@screen("mention/favor-hero")
async def favor_hero(q) -> dict:
    _, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    sub = await load_kpi_hero_sub_kpis(filters, mctx, "favorability")
    return {"hero": favorability_hero(sub), "degraded": was_kpi_tab_degraded("hero"),
            "negativeBasisNote": sub.get("overviewCards") is not None}


@screen("mention/favor-delta")
async def favor_delta(q) -> dict:
    """The two ratio cards' fallback Δ (positive: cycle Δ -> previous round; negative: previous round) and
    the basis caption."""
    _, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    sub, prev, engine = await asyncio.gather(load_kpi_hero_sub_kpis(filters, mctx, "favorability"),
                                             load_kpi_hero_sub_kpis_prev(filters, mctx, "favorability"),
                                             load_engine_kpi_trend(filters, mctx))
    hero = favorability_hero(sub)
    prev_sub = (prev or {}).get("sub")
    prev_hero = favorability_hero(prev_sub)
    cycle = overview_delta_from_slots((engine or {}).get("overviewDeltaSlots"), "sentiment")
    positive = cycle["pp"] if cycle else delta_pp(hero["positivePct"], prev_hero["positivePct"]) if prev_sub else None
    negative = delta_pp(hero["negativePct"], prev_hero["negativePct"]) if prev_sub else None
    return {"positive": positive, "negative": negative, "basis": _basis(cycle, (prev or {}).get("asOf"))}


@screen("mention/favor-trend")
async def favor_trend(q) -> dict:
    _, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    engine = await load_engine_kpi_trend(filters, mctx)
    if engine is None or engine.get("trendDegraded") is True:
        return {"unavailable": True}
    points = favorability_trend_points(engine)
    return {"unavailable": False, "points": points, "coverage": coverage_entries(points)}


@screen("mention/favor-sentiment")
async def favor_sentiment(q) -> dict:
    _, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    segs = sentiment_segments(await load_sentiment_totals(filters, mctx))
    return {"segments": segs, "hasAny": any(s["count"] > 0 for s in segs)}


@screen("mention/favor-matrix")
async def favor_matrix(q) -> dict:
    _, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    rows = type_sentiment_rows(await load_type_kpi(filters, mctx), "own")
    return {"rows": rows, "hasAny": any(r["total"] > 0 for r in rows)}


# ── first-rank tab ──────────────────────────────────────────────────────────

def _by_position(a: dict, b: dict) -> int:
    if a["avgPosition"] is None and b["avgPosition"] is None:
        return 0
    if a["avgPosition"] is None:
        return 1
    if b["avgPosition"] is None:
        return -1
    return _sign(a["avgPosition"] - b["avgPosition"])


def rank_row_orders(rows: list[dict]) -> dict:
    """first-rank-row-order.ts orderRankRows as row indices: ladder on = the ranked order as is,
    ladder off = own rows first, each block by average position (stable, None last)."""
    idx = list(range(len(rows)))
    own = sort_by([i for i in idx if rows[i]["isTracked"]], lambda a, b: _by_position(rows[a], rows[b]))
    others = sort_by([i for i in idx if not rows[i]["isTracked"]], lambda a, b: _by_position(rows[a], rows[b]))
    return {"ladder": idx, "ownFirst": own + others}


@screen("mention/first-rank")
async def first_rank(q) -> dict:
    """RankHero + RankSection (one first-position read shared by both boundaries)."""
    _, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    fp = overlay_first_position_values(await load_first_position(filters, mctx), None)
    degraded = was_first_position_hero_degraded()
    rows = rank_table_rows(fp, {"sparkCycles": SPARK_CYCLES})
    competitors = [r for r in rows if not r["isTracked"]]
    best = next((r["brand"] for r in competitors if r["avgPosition"] is not None), None)
    positions = [r["avgPosition"] if r["avgPosition"] is not None else 0 for r in rows]
    return {"available": fp is not None, "degraded": degraded, "hero": first_rank_hero(fp),
            "cards": first_rank_competitor_cards(rows, None), "chart": rank_trend_chart(fp, rows),
            "rows": rows, "orders": rank_row_orders(rows), "ladderDefault": best,
            "worst": max([1, *positions]), "cycles": len(rows[0]["spark"]) if rows else SPARK_CYCLES}


# ── bottom section: prompts and answers (standard) ─────────────────────────

def _js_infinity_cmp(a: float | None, b: float | None, direction: int) -> int:
    """dir * ((a ?? Infinity) - (b ?? Infinity)), NaN (both None) = tie."""
    if a is None and b is None:
        return 0
    if a is None:
        return direction
    if b is None:
        return -direction
    return direction * _sign(a - b)


def brand_table_view(brands: list[dict], total_answers: Any) -> dict:
    """BrandRankTable: per-row values (normal and multi), the default rank (server order), the
    precomputed orders of every sortable column (asc/desc), the multi-unavailable flag."""
    multi_total = 0
    for b in brands:
        multi_total = multi_total + ((b.get("multi") or {}).get("mentions") or 0)
    opts = {"multiTotalMentions": multi_total, "totalAnswers": total_answers}
    rows = []
    for i, b in enumerate(brands):
        rows.append({"rank": i + 1, "values": brand_row_values(b, {**opts, "multi": False}),
                     "multiValues": brand_row_values(b, {**opts, "multi": True})})

    def order(key: str, direction: int) -> list[int]:
        idx = list(range(len(brands)))
        if key == "brand":
            return sort_by(idx, lambda a, b: direction * locale_compare(brands[a]["brand"], brands[b]["brand"]))
        if key == "avgPosition":
            return sort_by(idx, lambda a, b: _js_infinity_cmp(brands[a].get("avgPosition"), brands[b].get("avgPosition"),
                                                              direction))
        field = "mentions" if key == "multiMentions" else "mentionRate" if key == "multiRate" else key
        src = "multiValues" if key in ("multiMentions", "multiRate") else "values"

        def cmp(a: int, b: int) -> int:
            av, bv = rows[a][src][field], rows[b][src][field]
            if av is None and bv is None:
                return 0
            if av is None:
                return 1
            if bv is None:
                return -1
            return direction * _sign(av - bv)
        return sort_by(idx, cmp)

    keys = ("brand", "mentions", "share", "avgPosition", "prompts", "mentionRate", "multiMentions", "multiRate")
    return {"rows": rows, "orders": {k: {"asc": order(k, 1), "desc": order(k, -1)} for k in keys},
            "multiUnavailable": any(not b.get("multi") for b in brands)}


def trend_split(trend: dict | None, brands: list[dict]) -> dict | None:
    """MentionTrendChart series split: own (tracked brands) and competitors, series order."""
    if not trend:
        return None
    tracked = {b["brand"] for b in brands if b["isTracked"]}
    return {"own": [s for s in trend["series"] if s in tracked], "competitors": [s for s in trend["series"] if s not in tracked]}


@screen("mention/prompts-section")
async def prompts_section(q) -> dict:
    """MentionsPromptsSection (the standard bottom section): the weekly chart and the brand table."""
    _, sp = split_context(q)
    begin_degrade_scope()
    filters, mctx = mention_filters(sp)
    data = await load_mentions_live(filters, mctx)
    degraded = mentions_degraded(mctx)["data"]
    if data is None:
        return {"data": None, "degraded": degraded}
    return {"data": data, "degraded": degraded,
            "table": brand_table_view(data["brands"], data["summary"].get("totalAnswers")),
            "trendSeries": trend_split(data.get("trend"), data["brands"])}
