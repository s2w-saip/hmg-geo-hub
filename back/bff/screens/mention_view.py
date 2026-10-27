"""The mention KPI tabs' view model (port of front/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-view.ts
and _data/prompt-rank.ts), bit for bit: same branches, same float expressions, same orders.

Every function takes and returns the TS JSON shapes (camelCase keys). A TS function taking one object
takes one dict with the same keys; positional args stay positional. JS truthiness is kept where it
differs from Python's: an empty array is truthy (`if (trend.overviewSlots)` is true for []), so presence
checks here test `is not None`. A TS Set result is a list in insertion order.
"""
from __future__ import annotations

import math
from typing import Any

from bff.screens._competitors import (brand_key, competitor_mini_picks, competitor_value_index, competitor_value_of,
                                       rank_first_position_rows, resolve_competitor_overlay)
from bff.screens._convert import round1
from bff.screens._js import is_num, js_round
from bff.screens._period import iso_of_days, iso_parse_days
from bff.screens._sort import code_unit_key, locale_compare, sort_by
from bff.screens._trend import COLLECTION_ERROR_GAP, overview_card_delta, trend_gap_applies, trend_gap_keys_to_mark

TREND_GAP_FIELD = "gap"
COMPETITOR_ROW_LIMIT = 12
MAX_BRAND_SERIES = 8
MAX_RANK_SERIES = 8
MAX_GAP_FILL_PER_HOLE = 200
MAX_TREND_POINTS = 600
MENTION_TYPE_KEYS_UI = ("mention", "recommendation", "comparison", "definition", "final_choice")
SENTIMENT_KEYS = ("positive", "neutral", "mixed", "negative")
STANCE_CARD_ENABLED = False
RANK_TOOLTIP_OWN_RANKED = "__ownRankedAnswers"
TOP_RANK_THRESHOLD = 3


def _sign(x: float) -> int:
    return (x > 0) - (x < 0)


def _nn(v: Any, default: Any) -> Any:
    return v if v is not None else default


def _gt0(v: Any) -> bool:
    return is_num(v) and v > 0


def _gap() -> dict:
    return dict(COLLECTION_ERROR_GAP)


def overview_key_of(metric: str) -> str:
    return "visibility" if metric == "exposure" else "shareOfVoice"


def pct_or_null(num: float, den: float) -> float | None:
    """Denominator 0 -> None; round1((100 * num) / den)."""
    return round1((100 * num) / den) if _gt0(den) else None


# ── hero scalar ─────────────────────────────────────────────────────────────

def kpi_hero(sub: dict | None, metric: str) -> dict:
    cards = (sub or {}).get("overviewCards")
    from_overview = None
    if cards is not None:
        from_overview = cards.get("visibility") if metric == "exposure" else cards.get("shareOfVoice")
    if from_overview is not None:
        n, d = from_overview["numerator"], from_overview["denominator"]
        return {"pct": pct_or_null(n, d), "numerator": n, "denominator": d}
    rows = (sub or {}).get("rows") or []
    num = den = 0
    for r in rows:
        num = num + (r["tracked"] if metric == "exposure" else r["trackedMentions"])
    for r in rows:
        den = den + (r["answers"] if metric == "exposure" else r["totalMentions"])
    return {"pct": pct_or_null(num, den), "numerator": num, "denominator": den}


def delta_pp(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None:
        return None
    return round1(current - previous)


def wow_pct(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None or previous == 0:
        return None
    return round1((100 * (current - previous)) / previous)


# ── axis ────────────────────────────────────────────────────────────────────

def next_bucket_key(key: str, unit: str) -> str:
    n = iso_parse_days(key)
    if n is None:
        return key
    return iso_of_days(n + (7 if unit == "week" else 1))


def fill_trend_gaps(points: list, unit: str, make_gap) -> list:
    if len(points) < 2:
        return points
    out: list = []
    for i, p in enumerate(points):
        out.append(p)
        nxt = points[i + 1] if i + 1 < len(points) else None
        if nxt is None:
            break
        k = next_bucket_key(p["bucketStart"], unit)
        guard = 0
        while k < nxt["bucketStart"] and guard < MAX_GAP_FILL_PER_HOLE and len(out) < MAX_TREND_POINTS:
            out.append(make_gap(k))
            k = next_bucket_key(k, unit)
            guard += 1
    return out


def trend_grid_key_resolver(slots: list[dict]):
    """lib/period/trend-grid-axis.ts trendGridKeyResolver: round dates, plus the anchor week of a
    week with exactly one slot."""
    by_alias: dict = {}
    for s in slots:
        by_alias[s["roundDate"]] = s["roundDate"]
    per_week: dict = {}
    for s in slots:
        per_week[s["anchorWeek"]] = _nn(per_week.get(s["anchorWeek"]), 0) + 1
    for s in slots:
        if per_week.get(s["anchorWeek"]) != 1:
            continue
        if s["anchorWeek"] not in by_alias:
            by_alias[s["anchorWeek"]] = s["roundDate"]
    return lambda key: _nn(by_alias.get(key), key)


def trend_axis(buckets: list[dict], unit: str, bounds: dict | None = None) -> list[dict]:
    grid = (bounds or {}).get("trendGrid")
    if grid is not None:
        key_of = trend_grid_key_resolver(grid)
        measured_keys = {key_of(b["bucketStart"]) for b in buckets}
        return [{"bucketStart": s["roundDate"], "measured": s.get("gapReason") is None and s["roundDate"] in measured_keys}
                for s in grid]
    measured = [{"bucketStart": b["bucketStart"], "measured": True} for b in buckets]
    anchors = []
    start = (bounds or {}).get("windowStartBucket") or None
    end = (bounds or {}).get("windowEndBucket") or None
    if start and (not measured or start < measured[0]["bucketStart"]):
        anchors.append({"bucketStart": start, "measured": False})
    if end and (not measured or end > measured[-1]["bucketStart"]):
        anchors.append({"bucketStart": end, "measured": False})
    seeded = sort_by(anchors + measured, lambda a, b: locale_compare(a["bucketStart"], b["bucketStart"]))
    deduped = [e for i, e in enumerate(seeded) if i == 0 or e["bucketStart"] != seeded[i - 1]["bucketStart"]]
    return fill_trend_gaps(deduped, unit, lambda k: {"bucketStart": k, "measured": False})


def trend_coverage(axis: list[dict]) -> dict:
    measured = len([a for a in axis if a["measured"]])
    return {"cycles": len(axis), "measuredCycles": measured, "missingCycles": len(axis) - measured}


def trend_gap_mark_set(axis: list[dict], gap_buckets: list[str] | None) -> list[str]:
    if not gap_buckets:
        return []
    measured = {a["bucketStart"] for a in axis if a["measured"]}
    return trend_gap_keys_to_mark([a["bucketStart"] for a in axis], gap_buckets, lambda k: k in measured)


# ── hero trend ──────────────────────────────────────────────────────────────

def _empty_point(key: str) -> dict:
    return {"bucketStart": key, "pct": None, "numerator": None, "denominator": None, "numeratorWow": None,
            "denominatorWow": None, "measuredDays": 0, "firstAt": None, "lastAt": None}


def _apply_wow(points: list[dict], a: str, b: str, wa: str, wb: str) -> None:
    for i in range(1, len(points)):
        points[i][wa] = wow_pct(points[i][a], points[i - 1][a])
        points[i][wb] = wow_pct(points[i][b], points[i - 1][b])


def kpi_trend_points(trend: dict | None, metric: str) -> list[dict]:
    if not trend:
        return []
    if trend.get("overviewSlots") is not None:
        return overview_trend_points(trend["overviewSlots"], "visibility" if metric == "exposure" else "shareOfVoice")
    by_bucket = {b["bucketStart"]: b for b in trend["buckets"]}
    axis = trend_axis(trend["buckets"], trend["unit"], trend)
    marks = set(trend_gap_mark_set(axis, trend.get("gapBuckets")))
    points = []
    for a in axis:
        b = by_bucket.get(a["bucketStart"]) if a["measured"] else None
        if not b:
            p = _empty_point(a["bucketStart"])
            if a["bucketStart"] in marks:
                p["gap"] = _gap()
            points.append(p)
            continue
        num = den = 0
        for e in b["engines"]:
            num = num + (e["trackedAnswers"] if metric == "exposure" else e["trackedMentions"])
        for e in b["engines"]:
            den = den + (e["answers"] if metric == "exposure" else e["totalMentions"])
        points.append({"bucketStart": b["bucketStart"], "pct": pct_or_null(num, den), "numerator": num,
                       "denominator": den, "numeratorWow": None, "denominatorWow": None,
                       "measuredDays": b["measuredDays"], "firstAt": b.get("firstAt"), "lastAt": b.get("lastAt")})
    _apply_wow(points, "numerator", "denominator", "numeratorWow", "denominatorWow")
    return points


def overview_trend_points(slots: list[dict], metric: str) -> list[dict]:
    points = []
    for b in slots:
        key = _nn(b.get("roundDate"), b["bucketStart"])
        if trend_gap_applies(b.get("gap"), "mention"):
            p = _empty_point(key)
            p["gap"] = b["gap"]
            points.append(p)
            continue
        num = b["trackedAnswers"] if metric == "visibility" else b["trackedMentions"]
        den = b["answers"] if metric == "visibility" else b["totalMentions"]
        points.append({"bucketStart": key, "pct": pct_or_null(num, den), "numerator": num, "denominator": den,
                       "numeratorWow": None, "denominatorWow": None, "measuredDays": b["measuredDays"],
                       "firstAt": b.get("firstAt"), "lastAt": b.get("lastAt")})
    _apply_wow(points, "numerator", "denominator", "numeratorWow", "denominatorWow")
    return points


def overview_delta_from_slots(slots: list[dict] | None, key: str) -> dict | None:
    d = overview_card_delta(slots, key)
    return {"pp": d["delta"], "basisDate": d["basisDate"]} if d else None


def exposure_delta_from_slots(slots: list[dict] | None) -> dict | None:
    return overview_delta_from_slots(slots, "visibility")


def coverage_entries(points: list[dict]) -> list[dict]:
    return [{"bucketStart": p["bucketStart"], "measuredDays": p["measuredDays"]} for p in points if p["measuredDays"] > 0]


# ── competitor table ────────────────────────────────────────────────────────

def competitor_kpi_rows(inp: dict) -> list[dict]:
    brands, trend, metric, own_pct = inp["brands"], inp.get("trend"), inp["metric"], inp.get("ownPct")
    limit = max(1, _nn(inp.get("limit"), COMPETITOR_ROW_LIMIT))
    metric_key = overview_key_of(metric)
    by_brand = competitor_value_index(inp.get("values"))
    usable = resolve_competitor_overlay(brands, by_brand)["usable"]
    axis = trend_axis(trend["buckets"], trend["unit"], trend) if trend else []
    by_bucket = {b["bucketStart"]: b for b in trend["buckets"]} if trend else {}
    series_brands = {b["brand"] for b in trend["brands"]} if trend else set()
    series_unknown = len(series_brands) == 0

    def spark_of(brand: str) -> list:
        out = []
        for a in axis:
            if not a["measured"]:
                out.append(None)
                continue
            bucket = by_bucket.get(a["bucketStart"])
            hit = next((x for x in bucket["brands"] if x["brand"] == brand), None) if bucket else None
            out.append((hit["exposurePct"] if metric == "exposure" else hit["sharePct"]) if hit else None)
        return out

    rows = []
    for b in brands:
        in_series = series_unknown or b["brand"] in series_brands
        spark = spark_of(b["brand"]) if in_series else []
        src = by_brand.get(brand_key(b["brand"])) if usable else b
        pct = competitor_value_of(src, metric_key) if src else None
        rows.append({"brand": b["brand"], "isTracked": b["isTracked"], "pct": pct,
                     "mentions": src["mentions"] if src else None, "spark": spark,
                     "wowPp": delta_pp(spark[-1], spark[-2]) if len(spark) >= 2 else None,
                     "gapPp": None if b["isTracked"] else delta_pp(pct, own_pct), "inTrendSeries": in_series})
    tracked = [r for r in rows if r["isTracked"]]
    others = sort_by([r for r in rows if not r["isTracked"]],
                     lambda a, b: _sign(_nn(b["pct"], -1) - _nn(a["pct"], -1)) or locale_compare(a["brand"], b["brand"]))
    return (tracked + others)[:limit]


def brand_trend_chart(rows: list[dict], trend: dict | None, metric: str, opts: dict | None = None) -> dict:
    empty = {"series": [], "points": [], "coverage": []}
    if not trend or not trend["buckets"]:
        return empty
    mx = max(1, _nn((opts or {}).get("maxSeries"), MAX_BRAND_SERIES))
    in_series = {b["brand"] for b in trend["brands"]}
    series = [{"brand": r["brand"], "isTracked": r["isTracked"], "colorIndex": i} for i, r in enumerate(rows)
              if r["brand"] in in_series][:mx]
    if not series:
        return empty
    by_bucket = {b["bucketStart"]: b for b in trend["buckets"]}
    axis = trend_axis(trend["buckets"], trend["unit"], trend)
    marks = set(trend_gap_mark_set(axis, trend.get("gapBuckets")))
    points = []
    for a in axis:
        bucket = by_bucket.get(a["bucketStart"]) if a["measured"] else None
        row: dict = {"bucketStart": a["bucketStart"]}
        for s in series:
            hit = next((x for x in bucket["brands"] if x["brand"] == s["brand"]), None) if bucket else None
            row[s["brand"]] = (hit["exposurePct"] if metric == "exposure" else hit["sharePct"]) if hit else None
        if a["bucketStart"] in marks:
            row[TREND_GAP_FIELD] = _gap()
        points.append(row)
    coverage = []
    for a in axis:
        if not a["measured"]:
            continue
        days = _nn((by_bucket.get(a["bucketStart"]) or {}).get("measuredDays"), 0)
        if days > 0:
            coverage.append({"bucketStart": a["bucketStart"], "measuredDays": days})
    return {"series": series, "points": points, "coverage": coverage}


def own_share_donut(own_pct: float | None) -> dict | None:
    if own_pct is None:
        return None
    own = max(0, min(100, own_pct))
    return {"own": own, "rest": round1(100 - own)}


# ── engine section ──────────────────────────────────────────────────────────

def engine_kpi_bars(trend: dict | None, metric: str) -> list[dict]:
    out = []
    for e in (trend or {}).get("latest") or []:
        out.append({"engine": e["engine"], "pct": e["exposurePct"] if metric == "exposure" else e["sovPct"],
                    "numerator": e["trackedAnswers"] if metric == "exposure" else e["trackedMentions"],
                    "denominator": e["answers"] if metric == "exposure" else e["totalMentions"]})
    return out


def slot_has_mention_value(b: dict) -> bool:
    return not trend_gap_applies(b.get("gap"), "mention") and b["answers"] > 0


def engine_series_uses_slots(trend: dict | None) -> bool:
    if not trend or trend.get("overviewSlots") is None:
        return False
    valued = [b for b in trend["overviewSlots"] if slot_has_mention_value(b)]
    return len(valued) > 0 and all(len(_nn(b.get("engines"), [])) > 0 for b in valued)


def hero_trend_available(trend: dict | None) -> bool:
    if not trend:
        return False
    if trend.get("overviewSlots") is not None:
        return True
    return trend.get("trendDegraded") is not True


def engine_trend_series_available(trend: dict | None) -> bool:
    if not trend:
        return False
    if engine_series_uses_slots(trend):
        return True
    return trend.get("trendDegraded") is not True


def _engine_series_from_slots(slots: list[dict], metric: str) -> dict:
    engines = sorted(dict.fromkeys(e["engine"] for b in slots for e in _nn(b.get("engines"), [])), key=code_unit_key)
    points = []
    for b in slots:
        key = _nn(b.get("roundDate"), b["bucketStart"])
        row: dict = {"bucketStart": key}
        gap = trend_gap_applies(b.get("gap"), "mention")
        for engine in engines:
            hit = None if gap else next((e for e in _nn(b.get("engines"), []) if e["engine"] == engine), None)
            if hit:
                row[engine] = (pct_or_null(hit["trackedAnswers"], hit["answers"]) if metric == "exposure"
                               else pct_or_null(hit["trackedMentions"], hit["totalMentions"]))
            else:
                row[engine] = None
        if gap and b.get("gap"):
            row[TREND_GAP_FIELD] = b["gap"]
        points.append(row)
    return {"engines": engines, "points": points}


def engine_kpi_series(trend: dict | None, metric: str) -> dict:
    if not trend:
        return {"engines": [], "points": []}
    if engine_series_uses_slots(trend) and trend.get("overviewSlots") is not None:
        return _engine_series_from_slots(trend["overviewSlots"], metric)
    by_bucket = {b["bucketStart"]: b for b in trend["buckets"]}
    axis = trend_axis(trend["buckets"], trend["unit"], trend)
    marks = set(trend_gap_mark_set(axis, trend.get("gapBuckets")))
    points = []
    for a in axis:
        bucket = by_bucket.get(a["bucketStart"]) if a["measured"] else None
        row: dict = {"bucketStart": a["bucketStart"]}
        for engine in trend["engines"]:
            hit = next((e for e in bucket["engines"] if e["engine"] == engine), None) if bucket else None
            row[engine] = (hit["exposurePct"] if metric == "exposure" else hit["sovPct"]) if hit else None
        if a["bucketStart"] in marks:
            row[TREND_GAP_FIELD] = _gap()
        points.append(row)
    return {"engines": trend["engines"], "points": points}


def engine_competitor_bars(trend: dict | None, metric: str) -> list[dict]:
    if not trend:
        return []
    latest_by = {e["engine"]: e for e in trend["latest"]}
    by_engine: dict = {}
    for b in trend.get("latestBrands") or []:
        by_engine.setdefault(b["engine"], []).append(b)
    out = []
    for e in trend["latest"]:
        rows = by_engine.get(e["engine"]) or []
        denom = e["answers"] if metric == "exposure" else e["totalMentions"]
        comps = [r for r in rows if not r["isTracked"] and r["mentions"] > 0]
        pcts = [v for v in (pct_or_null(r["answersWithBrand"] if metric == "exposure" else r["mentions"], denom)
                            for r in comps) if v is not None]
        own = latest_by.get(e["engine"])
        total = 0
        for v in pcts:
            total = total + v
        out.append({"engine": e["engine"],
                    "ownPct": (own["exposurePct"] if metric == "exposure" else own["sovPct"]) if own else None,
                    "competitorAvgPct": js_round((total / len(pcts)) * 10) / 10 if pcts else None,
                    "competitorCount": len(pcts)})
    return out


# ── type section ────────────────────────────────────────────────────────────

def type_kpi_bars(inp: dict) -> list[dict]:
    kpi, metric, scope = inp.get("kpi"), inp["metric"], inp["scope"]
    tbb = inp.get("typesByBrand")
    competitor = inp.get("competitor")
    if not kpi:
        return []
    out = []
    for r in kpi["rows"]:
        if scope == "own":
            own_pct = r["ownExposurePct"] if metric == "exposure" else pct_or_null(r["ownMentions"], kpi["ownMentions"])
            out.append({"type": r["type"], "ownPct": own_pct, "competitorPct": None, "otherPct": None,
                        "ownSignals": r["ownMentions"], "competitorSignals": 0, "otherSignals": r["otherMentions"]})
            continue
        total = tbb["totals"][r["type"]] if tbb else r["totalMentions"]
        if tbb:
            own = 0
            for b in tbb["brands"]:
                if b["isTracked"]:
                    own = own + b["types"][r["type"]]
        else:
            own = r["ownMentions"]
        comp_hit = (next((b for b in tbb["brands"] if b["brand"] == competitor and not b["isTracked"]), None)
                    if competitor and tbb else None)
        comp = comp_hit["types"][r["type"]] if comp_hit else 0
        rest = max(0, total - own - comp)
        if total <= 0:
            out.append({"type": r["type"], "ownPct": None, "competitorPct": None, "otherPct": None,
                        "ownSignals": own, "competitorSignals": comp, "otherSignals": rest})
            continue
        own_pct = pct_or_null(own, total)
        comp_pct = pct_or_null(comp, total) if comp_hit else None
        other = round1(100 - _nn(own_pct, 0) - _nn(comp_pct, 0))
        out.append({"type": r["type"], "ownPct": own_pct, "competitorPct": comp_pct, "otherPct": max(0, other),
                    "ownSignals": own, "competitorSignals": comp, "otherSignals": rest})
    return out


def type_combo_points(trend: dict | None, first_position: dict | None = None) -> list[dict]:
    exposure = kpi_trend_points(trend, "exposure")
    sov_by = {p["bucketStart"]: p for p in kpi_trend_points(trend, "sov")}
    type_by = {b["bucketStart"]: b for b in _nn((trend or {}).get("typeTrend"), [])}
    fav_by: dict = {}
    for b in _nn((trend or {}).get("buckets"), []):
        sent = pos = 0
        for e in b["engines"]:
            sent = sent + e["sentSignals"]
        for e in b["engines"]:
            pos = pos + e["positiveSignals"]
        fav_by[b["bucketStart"]] = pct_or_null(pos, sent)
    rank_by: dict = {}
    if first_position:
        for b in first_position["buckets"]:
            rank_by[b["bucketStart"]] = _own_weighted_position(b["brands"])["pos"]
    out = []
    for p in exposure:
        tb = type_by.get(p["bucketStart"]) if p["measuredDays"] > 0 else None
        by_type = {k: (pct_or_null(tb["byType"][k], tb["answers"]) if tb else None) for k in MENTION_TYPE_KEYS_UI}
        sov = sov_by.get(p["bucketStart"])
        row = {"bucketStart": p["bucketStart"], "answers": p["denominator"], "exposurePct": p["pct"],
               "sovPct": _nn(sov["pct"] if sov else None, None), "byType": by_type,
               "favorabilityPct": _nn(fav_by.get(p["bucketStart"]), None) if p["measuredDays"] > 0 else None,
               "avgPosition": _nn(rank_by.get(p["bucketStart"]), None) if p["measuredDays"] > 0 else None}
        if p.get("gap"):
            row["gap"] = p["gap"]
        out.append(row)
    return out


# ── measurement overview card ───────────────────────────────────────────────

def has_answer_only_axes(f: dict) -> bool:
    return bool(f.get("region") or f.get("engine") or f.get("dateFrom") or f.get("dateTo"))


def prompt_coverage(applied: Any, measured: Any, opts: dict | None = None) -> dict:
    a = applied if is_num(applied) else None
    m = measured if is_num(measured) else None
    conditional = (opts or {}).get("conditional") is True
    return {"applied": a, "measured": m,
            "unmeasured": max(0, a - m) if not conditional and a is not None and m is not None else None,
            "conditional": conditional}


# ── favorability ────────────────────────────────────────────────────────────

def favorability_hero(sub: dict | None) -> dict:
    rows = (sub or {}).get("rows") or []
    ov = ((sub or {}).get("overviewCards") or {}).get("sentiment")
    total = positive = negative = 0
    for r in rows:
        total = total + r["sentMentions"]
    for r in rows:
        positive = positive + r["positiveMentions"]
    for r in rows:
        negative = negative + r["negativeMentions"]
    if ov is not None:
        return {"positivePct": pct_or_null(ov["numerator"], ov["denominator"]), "negativePct": pct_or_null(negative, total),
                "positive": ov["numerator"], "negative": negative, "total": ov["denominator"]}
    return {"positivePct": pct_or_null(positive, total), "negativePct": pct_or_null(negative, total),
            "positive": positive, "negative": negative, "total": total}


def _empty_fav(key: str) -> dict:
    return {"bucketStart": key, "positivePct": None, "negativePct": None, "positive": None, "negative": None,
            "total": None, "positiveWow": None, "totalWow": None, "measuredDays": 0, "firstAt": None, "lastAt": None}


def favorability_trend_points(trend: dict | None) -> list[dict]:
    if not trend:
        return []
    if trend.get("overviewSlots") is not None:
        return _favorability_from_slots(trend)
    by_bucket = {b["bucketStart"]: b for b in trend["buckets"]}
    axis = trend_axis(trend["buckets"], trend["unit"], trend)
    marks = set(trend_gap_mark_set(axis, trend.get("gapBuckets")))
    points = []
    for a in axis:
        b = by_bucket.get(a["bucketStart"]) if a["measured"] else None
        if not b:
            p = _empty_fav(a["bucketStart"])
            if a["bucketStart"] in marks:
                p["gap"] = _gap()
            points.append(p)
            continue
        total = positive = negative = 0
        for e in b["engines"]:
            total = total + _nn(e.get("sentSignals"), 0)
        for e in b["engines"]:
            positive = positive + _nn(e.get("positiveSignals"), 0)
        for e in b["engines"]:
            negative = negative + _nn(e.get("negativeSignals"), 0)
        points.append({"bucketStart": b["bucketStart"], "positivePct": pct_or_null(positive, total),
                       "negativePct": pct_or_null(negative, total), "positive": positive, "negative": negative,
                       "total": total, "positiveWow": None, "totalWow": None, "measuredDays": b["measuredDays"],
                       "firstAt": b.get("firstAt"), "lastAt": b.get("lastAt")})
    _apply_wow(points, "positive", "total", "positiveWow", "totalWow")
    return points


def _favorability_from_slots(trend: dict) -> list[dict]:
    slots = _nn(trend.get("overviewSlots"), [])
    mirror_by = {b["bucketStart"]: b for b in trend["buckets"]}
    points = []
    for b in slots:
        key = _nn(b.get("roundDate"), b["bucketStart"])
        if trend_gap_applies(b.get("gap"), "mention"):
            p = _empty_fav(key)
            p["gap"] = b["gap"]
            points.append(p)
            continue
        mb = mirror_by.get(key)
        negative = None
        mirror_total = 0
        if mb:
            negative = 0
            for e in mb["engines"]:
                negative = negative + _nn(e.get("negativeSignals"), 0)
            for e in mb["engines"]:
                mirror_total = mirror_total + _nn(e.get("sentSignals"), 0)
        points.append({"bucketStart": key, "positivePct": pct_or_null(b["positiveMentions"], b["sentMentions"]),
                       "negativePct": None if negative is None else pct_or_null(negative, mirror_total),
                       "positive": b["positiveMentions"], "negative": negative, "total": b["sentMentions"],
                       "positiveWow": None, "totalWow": None, "measuredDays": b["measuredDays"],
                       "firstAt": b.get("firstAt"), "lastAt": b.get("lastAt")})
    _apply_wow(points, "positive", "total", "positiveWow", "totalWow")
    return points


def favorability_coverage(points: list[dict]) -> list[dict]:
    return coverage_entries(points)


def sentiment_segments(totals: dict | None) -> list[dict]:
    if not totals:
        return []
    total = 0
    for k in SENTIMENT_KEYS:
        total = total + totals[k]
    return [{"key": k, "count": totals[k], "pct": pct_or_null(totals[k], total)} for k in SENTIMENT_KEYS]


def stance_segments(dist: dict | None) -> list[dict]:
    return sentiment_segments(dist)


def stance_pairs(dist: dict | None) -> int | None:
    return dist["pairs"] if dist else None


def type_sentiment_rows(kpi: dict | None, scope: str = "own") -> list[dict]:
    if not kpi:
        return []
    rows = _nn(kpi["sentimentMatrix"].get(scope), [])
    if not rows:
        return []

    def to_vm(typ: str, r: dict) -> dict:
        total = r["positive"] + r["neutral"] + r["mixed"] + r["negative"]
        return {"type": typ, "positive": r["positive"], "neutral": r["neutral"], "mixed": r["mixed"],
                "negative": r["negative"], "total": total, "positivePct": pct_or_null(r["positive"], total),
                "segments": [{"key": k, "count": r[k], "pct": pct_or_null(r[k], total)} for k in SENTIMENT_KEYS]}

    acc = {"positive": 0, "neutral": 0, "mixed": 0, "negative": 0}
    for r in rows:
        acc = {k: acc[k] + r[k] for k in acc}
    return [to_vm("all", acc)] + [to_vm(r["type"], r) for r in rows]


# ── first rank ──────────────────────────────────────────────────────────────

def _own_weighted_position(points: list[dict]) -> dict:
    wsum = w = 0
    for p in points:
        if not p["isTracked"] or p.get("avgPosition") is None or p["rankedAnswers"] <= 0:
            continue
        wsum = wsum + p["avgPosition"] * p["rankedAnswers"]
        w = w + p["rankedAnswers"]
    return {"pos": round1(wsum / w) if w > 0 else None, "ranked": w}


def delta_position(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None:
        return None
    return round1(current - previous)


def own_position_series(fp: dict) -> list:
    axis = trend_axis(fp["buckets"], fp["unit"], fp)
    by_bucket = {b["bucketStart"]: b for b in fp["buckets"]}
    out = []
    for a in axis:
        b = by_bucket.get(a["bucketStart"]) if a["measured"] else None
        out.append(_own_weighted_position(b["brands"])["pos"] if b else None)
    return out


def first_rank_hero(fp: dict | None) -> dict:
    if not fp:
        return {"avgPosition": None, "rank": None, "rankedAnswers": 0, "delta": None, "brands": []}
    own = [r for r in fp["latest"] if r["isTracked"]]
    w = _own_weighted_position(own)
    rank = None
    for r in own:
        if r.get("rank") is not None and (rank is None or r["rank"] < rank):
            rank = r["rank"]
    ov = (fp.get("overviewCards") or {}).get("position")
    if ov is not None:
        d = overview_delta_from_slots(fp.get("overviewDeltaSlots"), "position")
        return {"avgPosition": ov["avgPosition"], "rank": rank, "rankedAnswers": ov["sampledAnswers"],
                "delta": d["pp"] if d else None, "brands": [r["brand"] for r in own]}
    series = own_position_series(fp)
    n = len(series)
    delta = delta_position(series[n - 1], series[n - 2]) if n >= 2 else None
    return {"avgPosition": w["pos"], "rank": rank, "rankedAnswers": w["ranked"], "delta": delta,
            "brands": [r["brand"] for r in own]}


def first_rank_delta_basis(fp: dict | None) -> str | None:
    if not fp or fp.get("overviewCards") is None:
        return None
    d = overview_delta_from_slots(fp.get("overviewDeltaSlots"), "position")
    return d["basisDate"] if d else None


def overlay_first_position_values(fp: dict | None, values: list[dict] | None) -> dict | None:
    if not fp or values is None:
        return fp
    by_brand = competitor_value_index(values)
    overlay = resolve_competitor_overlay(fp["latest"], by_brand)
    if not overlay["usable"]:
        return fp
    rows = []
    for r in fp["latest"]:
        src = by_brand.get(brand_key(r["brand"]))
        avg = competitor_value_of(src, "position") if src else None
        rows.append({"brand": r["brand"], "isTracked": r["isTracked"], "avgPosition": avg,
                     "rankedAnswers": r["rankedAnswers"] if avg is not None else 0, "mentions": r["mentions"]})
    return {**fp, "latest": rank_first_position_rows(rows)}


def rank_table_rows(fp: dict | None, opts: dict | None = None) -> list[dict]:
    if not fp:
        return []
    cycles = max(1, _nn((opts or {}).get("sparkCycles"), 4))
    axis = trend_axis(fp["buckets"], fp["unit"], fp)
    by_bucket = {b["bucketStart"]: b for b in fp["buckets"]}
    tail = axis[-cycles:] if cycles else []
    out = []
    for i, r in enumerate(fp["latest"]):
        spark = []
        for a in tail:
            b = by_bucket.get(a["bucketStart"]) if a["measured"] else None
            hit = next((x for x in b["brands"] if x["brand"] == r["brand"]), None) if b else None
            spark.append(_nn(hit.get("avgPosition"), None) if hit else None)
        out.append({"brand": r["brand"], "isTracked": r["isTracked"], "rank": r.get("rank"),
                    "avgPosition": r.get("avgPosition"), "rankedAnswers": r["rankedAnswers"], "mentions": r["mentions"],
                    "spark": spark, "wow": delta_position(spark[-1], spark[-2]) if len(spark) >= 2 else None,
                    "colorIndex": i})
    return out


def first_rank_competitor_cards(rows: list[dict], values: list[dict] | None = None, limit: int = 4) -> list[dict]:
    if values:
        source = list(values)
    else:
        source = [{"brand": r["brand"], "mentions": r["mentions"], "share": 0, "mentionRate": 0,
                   "avgPosition": r["avgPosition"], "isTracked": r["isTracked"]} for r in rows]
    by_key: dict = {}
    for r in rows:
        by_key[brand_key(r["brand"])] = r
    out = []
    for p in competitor_mini_picks(source, "position", limit):
        r = by_key.get(brand_key(p["brand"]))
        if r:
            out.append({"brand": r["brand"], "rank": r["rank"], "avgPosition": r["avgPosition"], "wow": r["wow"],
                        "colorIndex": r["colorIndex"]})
        else:
            out.append({"brand": p["brand"], "rank": None, "avgPosition": p["value"], "wow": None,
                        "colorIndex": len(rows)})
    return out


def rank_trend_chart(fp: dict | None, rows: list[dict], opts: dict | None = None) -> dict:
    empty = {"series": [], "points": [], "coverage": [], "yMax": 5}
    if not fp or not fp["buckets"]:
        return empty
    mx = max(1, _nn((opts or {}).get("maxSeries"), MAX_RANK_SERIES))
    in_series = set(fp["brands"])
    own = [r for r in rows if r["isTracked"] and r["brand"] in in_series]
    others = [r for r in rows if not r["isTracked"] and r["brand"] in in_series]
    series = [{"brand": r["brand"], "isTracked": r["isTracked"], "colorIndex": r["colorIndex"]}
              for r in (own + others)[:mx]]
    if not series:
        return empty
    by_bucket = {b["bucketStart"]: b for b in fp["buckets"]}
    axis = trend_axis(fp["buckets"], fp["unit"], fp)
    marks = set(trend_gap_mark_set(axis, fp.get("gapBuckets")))
    observed_max = 0
    points = []
    for a in axis:
        bucket = by_bucket.get(a["bucketStart"]) if a["measured"] else None
        row: dict = {"bucketStart": a["bucketStart"]}
        for s in series:
            hit = next((x for x in bucket["brands"] if x["brand"] == s["brand"]), None) if bucket else None
            v = _nn(hit.get("avgPosition"), None) if hit else None
            if v is not None and v > observed_max:
                observed_max = v
            row[s["brand"]] = v
        if bucket:
            ranked = 0
            for b in bucket["brands"]:
                if b["isTracked"]:
                    ranked = ranked + _nn(b.get("rankedAnswers"), 0)
            row[RANK_TOOLTIP_OWN_RANKED] = ranked
        else:
            row[RANK_TOOLTIP_OWN_RANKED] = None
        if a["bucketStart"] in marks:
            row[TREND_GAP_FIELD] = _gap()
        points.append(row)
    coverage = []
    for a in axis:
        if not a["measured"]:
            continue
        days = _nn((by_bucket.get(a["bucketStart"]) or {}).get("measuredDays"), 0)
        if days > 0:
            coverage.append({"bucketStart": a["bucketStart"], "measuredDays": days})
    return {"series": series, "points": points, "coverage": coverage, "yMax": max(5, math.ceil(observed_max))}


def rank_ladder(rows: list[dict]) -> list[dict]:
    ranked = [r for r in rows if r.get("avgPosition") is not None]
    if not ranked:
        return []
    lo = min(r["avgPosition"] for r in ranked)
    hi = max(r["avgPosition"] for r in ranked)
    return [{"brand": r["brand"], "isTracked": r["isTracked"], "rank": r["rank"], "avgPosition": r["avgPosition"],
             "offsetPct": round1((100 * (r["avgPosition"] - lo)) / (hi - lo)) if hi > lo else 0,
             "colorIndex": r["colorIndex"]} for r in ranked]


# ── prompt-rank.ts ──────────────────────────────────────────────────────────

def prompt_best_rank(row: dict) -> int | None:
    best = None
    for a in _nn(row.get("answers"), []):
        pos = a.get("position")
        if pos is None or pos <= 0:
            continue
        if best is None or pos < best:
            best = pos
    return best


def is_top_rank(rank: float | None) -> bool:
    return rank is not None and rank <= TOP_RANK_THRESHOLD


def brand_row_values(row: dict, opts: dict) -> dict:
    if not opts["multi"]:
        return {"mentions": row["mentions"], "prompts": row["prompts"], "share": row["share"],
                "mentionRate": row["mentionRate"]}
    m = row.get("multi")
    if not m:
        return {"mentions": None, "prompts": None, "share": None, "mentionRate": None}
    total, answers = opts["multiTotalMentions"], opts.get("totalAnswers")
    return {"mentions": m["mentions"], "prompts": m["prompts"],
            "share": round1((100 * m["mentions"]) / total) if total > 0 else None,
            "mentionRate": round1((100 * m["answers"]) / answers) if answers is not None and answers > 0 else None}
