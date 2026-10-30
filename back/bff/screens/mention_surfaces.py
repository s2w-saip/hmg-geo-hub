"""Website and project mention pages (MentionsView: summary cards, head-to-head, sentiment and type
cards, weekly trend, brand table) — /website/answer-analysis/mention and /projects/{id}/analysis/mention.

Ports the pages' API branch (website/project page.tsx: loadMentionsLive, loadSubKpis, loadSubKpisPrev,
buildMentionSubKpis, the project's options read and custom-field filters) and the view logic of
_components/mentions-view.tsx (summaryDelta, ownCompareRow, the head-to-head pick, SentimentBreakdown,
TypeBreakdown with lib/scope/type-breakdown-legend.ts, MentionsTrendSection, BrandRankTable).

Text the view used to translate while building rows is a sentinel here: the own head-to-head row is
OWN_ROW ("__own" -> compare.ours) and the type stack's own / rest segments carry `labelKey`
("ours" / "others" under answerAnalysis.mentions.breakdown).
"""
from __future__ import annotations

import asyncio
from typing import Any

from bff.screens import screen, split_context
from bff.screens._convert import delta1, round1
from bff.screens._filters import load_filter_dates, load_panel_options, read_project_custom_field_filters, read_standard_filters
from bff.screens._js import js_round
from bff.screens._sort import locale_compare, sort_by
from bff.screens.mention import brand_table_view, trend_split
from bff.screens.mention_data import (
    begin_degrade_scope, build_mention_sub_kpis, load_mentions_live, load_sub_kpis, load_sub_kpis_prev, mentions_degraded,
    website_filters,
)

OWN_ROW = "__own"
TYPE_KEYS = ("mention", "recommendation", "comparison", "definition", "final_choice")
OTHER_SEG_COLORS = ("bg-brand-300", "bg-ink-500", "bg-ink-300")
SENTIMENT_SEGS = (("positive", "bg-emerald-500"), ("neutral", "bg-muted-foreground/40"), ("mixed", "bg-amber-400"),
                  ("negative", "bg-destructive"))


def _sign(x: float) -> int:
    return (x > 0) - (x < 0)


async def project_filters(sp: dict, project_id: str) -> tuple[dict, dict, dict]:
    """project page.tsx (api): options first (the custom fields), then the filters with them."""
    base = read_standard_filters(sp)
    options = await load_panel_options({"surface": "project", "projectId": project_id, "dateFrom": base.get("dateFrom"),
                                        "dateTo": base.get("dateTo"), "scope": None, "filters": base})
    custom = read_project_custom_field_filters(sp, options.get("dynamicAxes") or [])
    filters = {**base, **({"customFieldFilters": custom} if custom is not None else {}), "cumulative": True}
    ctx = {"surface": "project", "projectId": project_id, "scope": None,
           **({"customFields": custom} if custom is not None else {})}
    return filters, ctx, options


# ── mentions-view.tsx logic ─────────────────────────────────────────────────

def summary_delta(cur: Any, prev: Any, unit: str, positive_is_good: bool | None) -> dict | None:
    if cur is None or prev is None:
        return None
    diff = delta1(cur, prev)
    tone = "neutral" if diff == 0 or positive_is_good is None else "good" if (diff > 0) == positive_is_good else "bad"
    return {"diff": diff, "unit": unit, "tone": tone}


def summary_deltas(sub: dict | None, prev: dict | None) -> dict:
    p = prev or {}
    s = sub or {}
    out = {"total": summary_delta(s.get("totalMentions"), p.get("totalMentions"), "count", True),
           "totalPrompts": summary_delta(s.get("measuredPrompts"), p.get("measuredPrompts"), "count", None)}
    if sub:
        out.update({"missingPrompts": summary_delta(sub.get("missingPrompts"), p.get("missingPrompts"), "count", False),
                    "multiMention": summary_delta(sub.get("multiMentionAnswers"), p.get("multiMentionAnswers"), "count", True),
                    "top3Rate": summary_delta(sub.get("top3Rate"), p.get("top3Rate"), "pp", True)})
    return out


def own_compare_row(own_rows: list[dict], own: dict | None, own_mention_rate: Any, label: str) -> dict:
    s = n = 0
    for b in own_rows:
        if b.get("avgPosition") is not None:
            s = s + b["avgPosition"] * b["mentions"]
            n = n + b["mentions"]
    mentions = prompts = share = 0
    for b in own_rows:
        mentions = mentions + b["mentions"]
    for b in own_rows:
        prompts = prompts + b["prompts"]
    if not own:
        for b in own_rows:
            share = share + b["share"]
    rate = own_mention_rate
    if rate is None:
        rate = (own or {}).get("mentionRate")
    if rate is None:
        rate = 0
        for b in own_rows:
            rate = max(rate, b["mentionRate"])
    return {"brand": label, "mentions": mentions, "prompts": prompts, "share": own["share"] if own else share,
            "mentionRate": rate,
            "avgPosition": own["avgPosition"] if own else (js_round((s / n) * 10) / 10 if n > 0 else None),
            "isTracked": True}


def comparison_of(data: dict, sub: dict | None, designated: str | None, manual: str | None) -> dict | None:
    brands = data["brands"]
    own_rows = [b for b in brands if b["isTracked"]]
    external = [b for b in brands if not b["isTracked"]]
    if not own_rows or not external:
        return None
    own = own_compare_row(own_rows, data.get("own"), (sub or {}).get("ownMentionRate"), OWN_ROW)
    by_sov = sort_by(external, lambda a, b: _sign(b["share"] - a["share"]))
    effective = manual if manual is not None else designated
    mode = "manual" if manual else "designated" if designated else "auto"
    if effective:
        target = next((b for b in external if b["brand"].lower() == effective.lower()), None) or {
            "brand": effective, "mentions": 0, "prompts": 0, "share": 0, "mentionRate": 0, "avgPosition": None,
            "isTracked": False}
    else:
        target = by_sov[0]
    peers = [b for b in by_sov if b["brand"] != target["brand"]][:2]
    return {"own": own, "target": target, "peers": peers, "mode": mode, "options": [b["brand"] for b in by_sov],
            "ownBrands": [b["brand"] for b in own_rows]}


def sentiment_view(totals: dict | None) -> list[dict] | None:
    """SentimentBreakdown segments: value and its share of the four (total 0 -> 1)."""
    if not totals:
        return None
    total = totals["positive"] + totals["neutral"] + totals["negative"] + totals["mixed"] or 1
    return [{"key": k, "value": totals[k], "cls": cls, "share": (totals[k] / total) * 100} for k, cls in SENTIMENT_SEGS]


def assign_other_colors(brand_totals: list[dict], colors: tuple) -> dict:
    ranked = sort_by([b for b in brand_totals if b["total"] > 0],
                     lambda a, b: _sign(b["total"] - a["total"]) or locale_compare(a["brand"], b["brand"]))
    return {b["brand"]: colors[i] for i, b in enumerate(ranked[:len(colors)])}


def legend_from_segments(rows: list[dict]) -> list[dict]:
    """Unique colours in first-seen order, each with the label (or key) of its last segment."""
    out: dict = {}
    for r in rows:
        for s in r["segs"]:
            if s["val"] > 0:
                item = {"color": s["color"], **({"labelKey": s["labelKey"]} if "labelKey" in s else {"label": s["label"]})}
                out[s["color"]] = item
    return list(out.values())


def type_share_view(types_by_brand: dict | None, tracked: set, comparison_brand: str | None) -> dict | None:
    """TypeBreakdown stacked rows (own · comparison · top-3 others · rest) and their legend."""
    if not types_by_brand:
        return None
    brands = types_by_brand["brands"]
    totals_of = []
    for b in brands:
        if b["brand"] in tracked or b["brand"] == comparison_brand:
            continue
        t = 0
        for k in TYPE_KEYS:
            t = t + b["types"][k]
        totals_of.append({"brand": b["brand"], "total": t})
    colors = assign_other_colors(totals_of, OTHER_SEG_COLORS)
    rows = []
    for typ in TYPE_KEYS:
        total = types_by_brand["totals"][typ]
        own = 0
        for b in brands:
            if b["brand"] in tracked:
                own = own + b["types"][typ]
        comp = 0
        if comparison_brand:
            hit = next((b for b in brands if b["brand"] == comparison_brand), None)
            comp = hit["types"][typ] if hit else 0
        others = sort_by([{"brand": b["brand"], "val": b["types"][typ]} for b in brands if b["brand"] in colors
                          and b["types"][typ] > 0], lambda a, b: _sign(b["val"] - a["val"]))
        others_sum = 0
        for o in others:
            others_sum = others_sum + o["val"]
        etc = max(0, total - own - comp - others_sum)
        segs = [{"key": "ours", "labelKey": "ours", "val": own, "color": "bg-brand-700"}]
        if comp > 0 and comparison_brand:
            segs.append({"key": "comp", "label": comparison_brand, "val": comp, "color": "bg-accent-gold"})
        segs += [{"key": f"o:{o['brand']}", "label": o["brand"], "val": o["val"], "color": colors[o["brand"]]} for o in others]
        if etc > 0:
            segs.append({"key": "etc", "labelKey": "others", "val": etc, "color": "bg-ink-100"})
        for s in segs:
            s["width"] = (s["val"] / total) * 100 if total > 0 else 0
        rows.append({"type": typ, "total": total, "trackedShare": (own / total) * 100 if total > 0 else 0, "segs": segs})
    return {"rows": rows, "legend": legend_from_segments(rows)}


def type_abs_view(types: dict | None) -> list[dict] | None:
    """The own type counts list: value and its width against the largest (min 1)."""
    if not types:
        return None
    mx = max(types["mention"], types["recommendation"], types["comparison"], types["definition"], types["final_choice"], 1)
    return [{"key": k, "value": types[k], "width": (types[k] / mx) * 100} for k in TYPE_KEYS]


def compare_parts(data: dict, sub: dict | None, designated: str | None, manual: str | None) -> dict:
    """The head-to-head and the type stack that follows its target."""
    comparison = comparison_of(data, sub, designated, manual)
    tracked = {b["brand"] for b in data["brands"] if b["isTracked"]}
    target = comparison["target"]["brand"] if comparison else None
    return {"comparison": comparison, "typeShare": type_share_view(data.get("typesByBrand"), tracked, target)}


async def _surface_reads(ctx: dict, sp: dict, full: bool = True) -> dict:
    """The page's reads: mentions, Sub KPI, (full: the previous Sub KPI and, project, the calendar)."""
    surface = ctx.get("surface", "website")
    project_id = ctx.get("project_id")
    options = None
    if surface == "project":
        filters, mctx, options = await project_filters(sp, project_id)
    else:
        filters, mctx = website_filters(sp, ctx.get("admin") == "true")

    async def none() -> None:
        return None
    data, sub, prev, dates = await asyncio.gather(
        load_mentions_live(filters, mctx), load_sub_kpis(filters, mctx),
        load_sub_kpis_prev(filters, mctx) if full else none(),
        load_filter_dates("project", project_id, "mentions") if full and surface == "project" else none())
    return {"data": data, "sub": sub, "prev": prev, "dates": dates, "options": options,
            "degraded": mentions_degraded(mctx)}


@screen("mention/view")
async def view(q) -> dict:
    """MentionsView of the website / project page: every value of the four sections, the default
    head-to-head target (project designated brand: none in local read-only mode, as the page)."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    r = await _surface_reads(ctx, sp)
    data, prev = r["data"], r["prev"]
    sub_kpis = build_mention_sub_kpis(r["sub"])
    prev_sub = build_mention_sub_kpis(prev["sub"]) if prev else None
    out: dict = {"data": data, "degraded": r["degraded"], "subKpis": sub_kpis, "prevSubKpis": prev_sub,
                 "prevBasisDate": (prev or {}).get("asOf")}
    if r["options"] is not None:
        o = r["options"]
        out["panel"] = {**{k: o[k] for k in ("catalogRows", "engineOptions") if k in o},
                        "dynamicAxes": o.get("dynamicAxes") or [],
                        "selectableDates": (r["dates"] or {}).get("selectableDates")}
    if data is None:
        return out
    out.update({"deltas": summary_deltas(sub_kpis, prev_sub), **compare_parts(data, sub_kpis, None, None),
                "sentiment": sentiment_view(data.get("sentimentTotals")), "typeAbs": type_abs_view(data.get("typeTotals")),
                "trendSeries": trend_split(data.get("trend"), data["brands"]),
                "table": brand_table_view(data["brands"], data["summary"].get("totalAnswers"))})
    return out


@screen("mention/view-compare")
async def view_compare(q) -> dict:
    """The head-to-head and type stack for a target the user picked (`target`), or the default
    (no `target`): the same reads and rules as mention/view."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    manual = sp.pop("target", None)
    manual = manual[0] if isinstance(manual, list) else manual
    r = await _surface_reads(ctx, sp, full=False)
    if r["data"] is None:
        return {"comparison": None, "typeShare": None}
    return compare_parts(r["data"], build_mention_sub_kpis(r["sub"]), None, manual or None)


@screen("mention/view-cards")
async def view_cards(q) -> dict:
    """The summary cards of MentionsView alone, for the renewal Website Mention (2026-10-30, the user: a legacy KPI is
    reshaped, never dropped): mention/view's summary, Sub KPI, Δ and Δ basis from the same reads, without the
    head-to-head, the breakdowns, the trend and the table. The basis date only with a Δ to show (as the view drew it)."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    r = await _surface_reads(ctx, sp)
    data, prev = r["data"], r["prev"]
    sub_kpis = build_mention_sub_kpis(r["sub"])
    prev_sub = build_mention_sub_kpis(prev["sub"]) if prev else None
    return {"asOf": data.get("asOf") if data else None, "summary": data["summary"] if data else None, "subKpis": sub_kpis,
            "deltas": summary_deltas(sub_kpis, prev_sub) if data else None,
            "prevBasisDate": prev["asOf"] if sub_kpis and prev_sub else None, "degraded": r["degraded"]}


@screen("mention/view-weekly")
async def view_weekly(q) -> dict:
    """The weekly brand mentions of MentionsView (당사 + the top 10 by share) as rows for the renewal Website
    Mention's 브랜드 상세 (2026-10-30, a legacy KPI is reshaped, never dropped): each brand's weekly counts (null = a
    collection gap week), its latest measured week and the change from the week before when both were measured."""
    ctx, sp = split_context(q)
    begin_degrade_scope()
    r = await _surface_reads(ctx, sp, full=False)
    data = r["data"]
    trend = (data or {}).get("trend")
    if not trend:
        return {"weeks": [], "gaps": [], "rows": [], "degraded": bool((data or {}).get("trendDegraded")) or r["degraded"]["data"]}
    tracked = set(trend_split(trend, data["brands"])["own"])
    points = trend["points"]
    rows = []
    for s in trend["series"]:
        values = [None if p.get("gap") else p.get(s) for p in points]
        last = max((i for i, v in enumerate(values) if v is not None), default=None)
        before = values[last - 1] if last is not None and last > 0 else None
        rows.append({"brand": s, "own": s in tracked, "values": values, "latest": values[last] if last is not None else None,
                     "delta": values[last] - before if before is not None else None})
    return {"weeks": [p["week"] for p in points], "gaps": [bool(p.get("gap")) for p in points], "rows": rows,
            "degraded": False}
