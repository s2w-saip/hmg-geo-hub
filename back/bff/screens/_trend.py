"""Trend (T-1 GET /v1/trend) in the shapes the legacy readers produced, and the shared trend value rules.

Ports, bit for bit:
  front/lib/hgh/adapters/trend.ts             query, dims split, buckets, LiveTrend, brand / first-position results
  front/lib/kpi/overview-card-values.ts       overviewTrendValues, overviewCardDelta, citationShareNumerator
  front/lib/viz/trend-gap.ts                  the gap data rules (trendGapApplies, ...; no chart geometry)
  dashboard/_data/trend-kpi-family.ts         trendKpiFamily, mixedTrendGapFamily
  dashboard/_data/live.ts                     applyTrendDeltas, sparklineTrend
  dashboard/_components/overview-kpi-cards.tsx sparkPoints, sparkYDomain

Shapes: API JSON (TrendData {bucket, dimension, own_label, buckets[], series[], dims?}) in, the TS view
shapes (camelCase) out. A TS Map is a dict here (insertion order kept); a PointIndex is
{bucket key: point}. A key TS left undefined is absent; None is JSON null.
`common` is the CommonFilters params dict (CommonQuery keys plus `cf.<uuid>` keys).
"""
from __future__ import annotations

import math
from typing import Any

from bff import api
from bff.screens._convert import Exact, delta1, filter_notices, pct1_or_null, pct1_or_zero, rank_avg, round1
from bff.screens._js import js_round
from bff.screens._period import iso_of_days, iso_parse_days, utc_day_of_week

OVERVIEW_TREND_METRICS = ("visibility", "share_of_voice", "sentiment", "position", "citation_share")
URL_TREND_METRICS = (*OVERVIEW_TREND_METRICS, "target_url_rate", "owned_url_rate")
WEBSITE_TREND_METRICS = (*URL_TREND_METRICS, "citation_accuracy")
PROJECT_TREND_METRICS = (*URL_TREND_METRICS, "citation_accuracy")
TREND_METRIC_KPI_KEY = {"visibility": "visibility", "share_of_voice": "shareOfVoice", "sentiment": "sentiment",
                        "position": "position", "citation_share": "citationShare"}
MENTION_FAMILY = frozenset({"visibility", "share_of_voice", "sentiment", "position", "type_exposure"})

DELTA_TREND_BUCKET = "day"
DELTA_TREND_WINDOW_DAYS = 30
SPARKLINE_POINTS = 5
SPARK_POINTS = 5


def _nn(v: Any, default: Any) -> Any:
    """`v ?? default`."""
    return v if v is not None else default


def _js_text(v: Any) -> str:
    """`${v}` for the values that reach a template string here."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _round1(v: float) -> float:
    return round1(v)


# ── trend-gap rules (lib/viz/trend-gap.ts, data side) ─────────────────────

TREND_GAP_REASONS = frozenset({"collection_error", "not_published", "no_value"})
COLLECTION_ERROR_GAP = {"reason": "collection_error"}
CITATIONS_COLLECTION_ERROR_GAP = {"reason": "collection_error", "scope": "citations"}
NOT_PUBLISHED_GAP = {"reason": "not_published"}
NO_VALUE_GAP = {"reason": "no_value"}


def trend_gap_scope_of(gap: Any) -> str:
    return _nn(gap.get("scope") if isinstance(gap, dict) else None, "all")


def trend_gap_applies(gap: dict | None, family: str) -> bool:
    """Does a consumer of this family read the gap as a gap: citation -> always, mention -> scope all only."""
    if not gap:
        return False
    return family == "citation" or trend_gap_scope_of(gap) == "all"


def is_trend_gap(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("reason"), str) and value["reason"] in TREND_GAP_REASONS


def row_trend_gap(row: Any) -> dict | None:
    if not isinstance(row, dict):
        return None
    g = row.get("gap")
    return g if is_trend_gap(g) else None


def trend_gap_key_in_axis(key: str, first_key: str | None, last_key: str | None) -> bool:
    if first_key is None or last_key is None:
        return False
    return first_key < key < last_key


def trend_gap_keys_to_mark(axis_keys: list[str], gap_keys: list[str], has_value) -> list[str]:
    """Keys to mark as gaps on an existing slot axis. has_value: callable(key) or a collection of valued keys.
    Returns the keys in first-seen gap_keys order (the TS Set)."""
    check = has_value if callable(has_value) else (lambda k, s=set(has_value): k in s)
    out: list[str] = []
    if len(axis_keys) < 2 or not gap_keys:
        return out
    first, last = axis_keys[0], axis_keys[-1]
    axis = set(axis_keys)
    for k in dict.fromkeys(gap_keys):
        if k not in axis or not trend_gap_key_in_axis(k, first, last) or check(k):
            continue
        out.append(k)
    return out


def collection_error_gap(scope: str) -> dict:
    return dict(CITATIONS_COLLECTION_ERROR_GAP if scope == "citations" else COLLECTION_ERROR_GAP)


# ── dashboard/_data/trend-kpi-family.ts ────────────────────────────────────

CITATION_KPI_KEYS = frozenset({"citationShare", "citationAccuracy", "ownedUrlRate", "targetUrlRate"})


def trend_kpi_family(key: str) -> str:
    return "citation" if key in CITATION_KPI_KEYS else "mention"


def mixed_trend_gap_family(keys) -> str:
    any_key = False
    for k in keys:
        any_key = True
        if trend_kpi_family(k) == "mention":
            return "mention"
    return "citation" if any_key else "mention"


# ── lib/kpi/overview-card-values.ts ────────────────────────────────────────

def citation_share_numerator(c: dict) -> float:
    v = c.get("officialHmgCitations")
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else c.get("ownedCitations")


def _pct(n: float, d: Any) -> float:
    return Exact(js_round((n / d) * 1000) / 10, (100 * n) / d) if isinstance(d, (int, float)) and d > 0 else 0


def overview_trend_values(b: dict) -> dict:
    """One slot's card values (overviewTrendValues): a missing metric has no key."""
    gap = b.get("gap")
    if trend_gap_applies(gap, "mention") or b.get("answers") == 0:
        return {}
    values = {"visibility": _pct(b["trackedAnswers"], b["answers"])}
    if b["totalMentions"] > 0:
        values["shareOfVoice"] = _pct(b["trackedMentions"], b["totalMentions"])
    if b["sentMentions"] > 0:
        values["sentiment"] = _round1((100 * b["positiveMentions"]) / b["sentMentions"])
    if b.get("avgPosition") is not None:
        values["position"] = b["avgPosition"]
    if not trend_gap_applies(gap, "citation") and b["totalCitations"] > 0:
        values["citationShare"] = _pct(citation_share_numerator(b), b["totalCitations"])
    return values


def overview_card_delta(slots: list[dict] | None, key: str) -> dict | None:
    """Δ vs the previous valued slot ({delta, basisDate}) or None with fewer than two values."""
    if not slots:
        return None
    valued = []
    for b in slots:
        v = overview_trend_values(b).get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            valued.append((v, _nn(b.get("roundDate"), b.get("bucketStart"))))
    if len(valued) < 2:
        return None
    (pv, pat), (lv, _) = valued[-2], valued[-1]
    return {"delta": delta1(lv, pv), "basisDate": pat}


def delta_trend_filters(filters: dict, now_ms: float | None = None) -> dict:
    """The Δ roll-up filters: the URL period as is, else the last 30 days (dateFrom = now - 30 d, UTC day)."""
    if filters.get("dateFrom") or filters.get("dateTo"):
        return filters
    if now_ms is None:
        import time
        now_ms = time.time() * 1000
    ms = now_ms - DELTA_TREND_WINDOW_DAYS * 86_400_000
    return {**filters, "dateFrom": iso_of_days(math.floor(ms / 86_400_000))}


# ── query ──────────────────────────────────────────────────────────────────

def dims_param(spec: dict) -> str:
    """The backend dims item of a spec: `dimension[:metric,…][@top]`."""
    metrics = spec.get("metrics")
    m = f":{','.join(dict.fromkeys(metrics))}" if metrics else ""
    top = f"@{_js_text(spec['top'])}" if "top" in spec else ""
    return f"{spec['dimension']}{m}{top}"


def trend_query(common: dict, req: dict) -> dict:
    """Params of GET /v1/trend (fetchTrend). req = {surface, bucket, dimension?, metrics?, top?, brandKeys?,
    splitOwn?, measuredDays?, card?, dims?}."""
    dimension = req["dimension"] if "dimension" in req else "none"
    extra: dict = {"bucket": req.get("bucket"), "dimension": dimension}
    if req.get("card") and req["surface"] != "project":
        extra["card"] = True
    if req.get("metrics"):
        extra["metrics"] = list(dict.fromkeys(req["metrics"]))
    if "top" in req:
        extra["top"] = req["top"]
    if dimension == "brand":
        if req.get("brandKeys"):
            extra["brand_key"] = sorted(dict.fromkeys(req["brandKeys"]))
        extra["split_own"] = _nn(req.get("splitOwn"), True)
    if req.get("measuredDays") is False:
        extra["measured_days"] = False
    if req.get("dims"):
        extra["dims"] = [dims_param(d) for d in req["dims"]]
    return {**common, **extra}


async def fetch_trend(common: dict, req: dict) -> dict:
    res = await api.get("trend", trend_query(common, req))
    return {"data": res["data"], "meta": res["meta"]}


def split_trend_dims(res: dict) -> dict:
    """A dims answer -> {dimension: {data, meta}} (the primary first, its data without dims)."""
    data = {k: v for k, v in res["data"].items() if k != "dims"}
    out = {data.get("dimension"): {"data": data, "meta": res.get("meta")}}
    for b in res["data"].get("dims") or []:
        entry: dict = {"data": {**data, "dimension": b.get("dimension"), "series": b.get("series")}}
        if "meta" in b:
            entry["meta"] = b["meta"]
        out[b.get("dimension")] = entry
    return out


async def fetch_trend_dims(common: dict, req: dict) -> dict:
    return split_trend_dims(await fetch_trend(common, req))


async def load_trend(common: dict, req: dict) -> dict:
    """fetchTrend + meta notices: {data, notices, suppressed}."""
    res = await fetch_trend(common, req)
    return {"data": res["data"], "notices": filter_notices(res["meta"]),
            "suppressed": _nn((res["meta"] or {}).get("suppressed"), {})}


# ── point helpers ──────────────────────────────────────────────────────────

def point_gap(p: dict | None) -> dict | None:
    """collection_error -> {reason: collection_error}, hidden -> {reason: not_published}, else None."""
    if not p:
        return None
    if p.get("gap_reason") == "collection_error":
        return {"reason": "collection_error"}
    if p.get("gap_reason") == "hidden":
        return {"reason": "not_published"}
    return None


def mirror_pct(r: dict | None) -> float | None:
    """Legacy mirror percent Math.round(n/d*1000)/10, den 0 -> None."""
    return pct1_or_zero(r) if r and isinstance(r.get("den"), (int, float)) and r["den"] > 0 else None


def index_points(s: dict) -> dict:
    return {p.get("bucket"): p for p in s["points"]}


def series_by_metric(data: dict) -> dict:
    """{metric: PointIndex} of the first series per metric."""
    out: dict = {}
    for s in data["series"]:
        if s.get("metric") not in out:
            out[s.get("metric")] = index_points(s)
    return out


def bucket_round_date(b: dict) -> str:
    """The last ledger round of a bucket (cycle: the key itself)."""
    rds = b["round_dates"]
    return _nn(rds[-1] if rds else None, b["key"])


def bucket_gap(series: dict, key: str) -> dict | None:
    """Slot gap from the series at that bucket: a gapped mention series = whole slot (no scope), only
    citation series gapped = scope citations, a slot without a mention answer = no_value."""
    mention = citation = None
    no_value = False
    for metric, idx in series.items():
        p = idx.get(key)
        g = point_gap(p)
        if not g:
            if metric in MENTION_FAMILY and p and p.get("gap_reason") in ("no_answer", "analysis_pending"):
                no_value = True
            continue
        if metric in MENTION_FAMILY:
            mention = mention or g
        else:
            citation = citation or g
    if mention:
        return {"reason": mention["reason"]}
    if citation:
        return {"reason": citation["reason"], "scope": "citations"}
    if no_value:
        return {"reason": "no_value"}
    return None


def _ratio_of(idx: dict | None, key: str) -> dict | None:
    return ((idx or {}).get(key) or {}).get("ratio") if idx is not None else None


def _rank_of(idx: dict | None, key: str) -> dict | None:
    return ((idx or {}).get(key) or {}).get("rank") if idx is not None else None


def _num(r: dict | None, field: str) -> Any:
    return _nn((r or {}).get(field), 0)


# ── StandardTrendBucket ────────────────────────────────────────────────────

def to_standard_trend_buckets(data: dict) -> list[dict]:
    """dimension=none answer -> StandardTrendBucket[] (legacy trend reader shape), in API order."""
    series = series_by_metric(data)
    vis, sov, sen = series.get("visibility"), series.get("share_of_voice"), series.get("sentiment")
    pos, cit = series.get("position"), series.get("citation_share")
    out = []
    for b in data["buckets"]:
        k = b["key"]
        v, s, e, c = _ratio_of(vis, k), _ratio_of(sov, k), _ratio_of(sen, k), _ratio_of(cit, k)
        gap = bucket_gap(series, k)
        row: dict = {"bucketStart": k, "roundDate": bucket_round_date(b)}
        if data.get("bucket") == "cycle":
            row["cycleAnchorAt"] = k
        row["gridSlot"] = True
        if gap:
            row["gap"] = gap
        row.update({
            "answers": _num(v, "den"), "trackedAnswers": _num(v, "num"),
            "totalMentions": _num(s, "den"), "trackedMentions": _num(s, "num"),
            "sentMentions": _num(e, "den"), "positiveMentions": _num(e, "num"),
            "avgPosition": rank_avg(_rank_of(pos, k)),
            "totalCitations": _num(c, "den"), "ownedCitations": _num(c, "num"),
            "measuredDays": _nn(b.get("measured_days"), 0), "firstAt": None, "lastAt": None,
        })
        out.append(row)
    return out


def with_engine_breakdown(buckets: list[dict], engine_data: dict) -> list[dict]:
    """Adds `engines` (per-engine counts) from a dimension=engine answer of the same filters and bucket."""
    by_engine: dict = {}
    for s in engine_data["series"]:
        if not s.get("key"):
            continue
        m = by_engine.setdefault(s["key"], {})
        if s.get("metric") not in m:
            m[s.get("metric")] = index_points(s)
    out = []
    for b in buckets:
        engines = []
        for engine, m in by_engine.items():
            k = b["bucketStart"]
            v = _ratio_of(m.get("visibility"), k)
            if v is None:
                continue
            s, e, r = _ratio_of(m.get("share_of_voice"), k), _ratio_of(m.get("sentiment"), k), _rank_of(m.get("position"), k)
            engines.append({"engine": engine, "answers": v.get("den"), "trackedAnswers": v.get("num"),
                            "totalMentions": _num(s, "den"), "trackedMentions": _num(s, "num"),
                            "sentMentions": _num(e, "den"), "positiveMentions": _num(e, "num"),
                            "rankSum": _num(r, "sum"), "rankedAnswers": _num(r, "count")})
        out.append({**b, "engines": engines} if engines else {**b})
    return out


# ── LiveTrend ──────────────────────────────────────────────────────────────

def to_live_trend(data: dict, opts: dict | None = None) -> dict:
    """dimension=none answer -> LiveTrend {unit, axis: anchor, points, lastMeasuredAt, totalAnswers}.
    opts = {unit?} (default week)."""
    opts = opts or {}
    buckets = to_standard_trend_buckets(data)
    series = series_by_metric(data)
    tgt, own, acc_series = series.get("target_url_rate"), series.get("owned_url_rate"), series.get("citation_accuracy")
    points = []
    for b in buckets:
        k = b["bucketStart"]
        gap = b.get("gap")
        origin = ((own or {}).get(k) or {}).get("origin") if own is not None else None
        if origin is None:
            origin = ((tgt or {}).get(k) or {}).get("origin") if tgt is not None else None
        mention_gap = bool(gap) and _nn(gap.get("scope"), "all") == "all"
        p: dict = {"bucketStart": k}
        if b.get("roundDate"):
            p["roundDate"] = b["roundDate"]
        if mention_gap or b["answers"] == 0:
            p.update({"firstAt": None, "values": {}, "measuredDays": 0, "answers": 0, "lastAt": None})
        else:
            values = dict(overview_trend_values(b))
            acc = pct1_or_null(_ratio_of(acc_series, k)) if acc_series is not None else None
            if acc is not None:
                values["citationAccuracy"] = acc
            p.update({"firstAt": None, "values": values, "measuredDays": b["measuredDays"], "answers": b["answers"],
                      "lastAt": None})
        if gap:
            p["gap"] = gap
        if origin:
            p["urlRateOrigin"] = origin
        points.append(p)
    valued = [p for p in points if p["answers"] > 0]
    last = valued[-1] if valued else None
    return {"unit": _nn(opts.get("unit"), "week"), "axis": "anchor", "points": points,
            "lastMeasuredAt": None if last is None else _nn(last.get("roundDate"), last.get("bucketStart")),
            "totalAnswers": _sum_in_order(p["answers"] for p in valued)}


def _sum_in_order(values) -> float:
    total = 0
    for v in values:
        total = total + v
    return total


def apply_trend_deltas(kpis: list[dict], trend: dict | None) -> list[dict]:
    """Card Δ = last two valued trend points (round1), direction with a ±0.05 dead band (applyTrendDeltas)."""
    if not trend:
        return kpis

    def delta_for(key: str) -> dict | None:
        vals = [v for v in ((p.get("values") or {}).get(key) for p in trend["points"])
                if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if len(vals) < 2:
            return None
        delta = delta1(vals[-1], vals[-2])
        return {"delta": delta, "direction": "up" if delta > 0.05 else "down" if delta < -0.05 else "flat"}

    out = []
    for k in kpis:
        d = delta_for(k.get("key"))
        out.append({**k, **d} if d else k)
    return out


def sparkline_trend(trend: dict | None) -> dict | None:
    """The last SPARKLINE_POINTS points only (what the card sparkline draws)."""
    if not trend or len(trend["points"]) <= SPARKLINE_POINTS:
        return trend
    return {**trend, "points": trend["points"][-SPARKLINE_POINTS:]}


def spark_points(trend: dict | None, key: str) -> list[dict]:
    """Card sparkline points: the last 5 slots, value, WoW vs the previous slot, gap only for this family."""
    family = trend_kpi_family(key)
    arr = ((trend or {}).get("points") or [])[-SPARK_POINTS:]
    out = []
    for i, p in enumerate(arr):
        v = (p.get("values") or {}).get(key)
        prev = (arr[i - 1].get("values") or {}).get(key) if i > 0 else None
        row: dict = {"bucketStart": p.get("bucketStart")}
        if p.get("cycleAnchorAt"):
            row["cycleAnchorAt"] = p["cycleAnchorAt"]
        row["value"] = v
        row["wow"] = delta1(v, prev) if v is not None and prev is not None else None
        if trend_gap_applies(p.get("gap"), family):
            row["gap"] = p["gap"]
        out.append(row)
    return out


def spark_y_domain(points: list[dict], is_rank: bool) -> list[float]:
    """Sparkline y domain: [0, 100]; rank cards [1, max(5, ceil(observed max))]."""
    if not is_rank:
        return [0, 100]
    vals = [p.get("value") for p in points if p.get("value") is not None]
    return [1, max(5, math.ceil(max(vals) if vals else 0))]


# ── brand dimension ────────────────────────────────────────────────────────

def series_label(s: dict, data: dict) -> Any:
    """own -> own_brand_code (split) or own_label (merged); else label ?? key ?? ""."""
    if s.get("is_own"):
        return _nn(s.get("own_brand_code"), data.get("own_label"))
    return _nn(s.get("label"), _nn(s.get("key"), ""))


def brand_groups(data: dict) -> list[dict]:
    """Series grouped per (own|comp, label): own first, then competitors, API order; {name, isOwn, vis?, sov?, pos?}."""
    groups: dict = {}

    def add(s: dict) -> None:
        name = series_label(s, data)
        gid = f"{'own' if s.get('is_own') else 'comp'}:{_js_text(name)}"
        g = groups.get(gid)
        if g is None:
            g = groups[gid] = {"name": name, "isOwn": s.get("is_own") is True}
        idx = index_points(s)
        metric = s.get("metric")
        if metric == "visibility":
            g.setdefault("vis", idx)
        elif metric == "share_of_voice":
            g.setdefault("sov", idx)
        elif metric == "position":
            g.setdefault("pos", idx)

    for s in data["series"]:
        if s.get("is_own"):
            add(s)
    for s in data["series"]:
        if not s.get("is_own"):
            add(s)
    return list(groups.values())


def monday_of(day: str) -> str:
    """Monday of the week a YYYY-MM-DD day falls in (Date parse of `${day}T00:00:00Z`)."""
    n = iso_parse_days(day)
    if n is None:
        raise ValueError(f"invalid day: {day}")
    return iso_of_days(n - (utc_day_of_week(n) + 6) % 7)


def slot_gap_reason(data: dict, key: str) -> str | None:
    """hidden-collection-error first, else not-published, else None."""
    reason = None
    for s in data["series"]:
        p = next((x for x in s["points"] if x.get("bucket") == key), None)
        if p and p.get("gap_reason") == "collection_error":
            return "hidden-collection-error"
        if p and p.get("gap_reason") == "hidden":
            reason = "not-published"
    return reason


def trend_grid_of(data: dict) -> list[dict]:
    """The ledger slots as the legacy trend grid: {roundDate, anchorWeek, gapReason}."""
    out = []
    for b in data["buckets"]:
        rd = bucket_round_date(b)
        out.append({"roundDate": rd, "anchorWeek": b["key"] if data.get("bucket") == "week" else monday_of(rd),
                    "gapReason": slot_gap_reason(data, b["key"])})
    return out


def gap_keys(data: dict) -> list[str]:
    return [s["roundDate"] for s in trend_grid_of(data) if s["gapReason"] is not None]


def to_brand_trend_result(data: dict, opts: dict | None = None) -> dict:
    """dimension=brand -> BrandTrendResult (+ trendGrid, gapBuckets). opts = {unit?, mentions?: {brand: n}}."""
    opts = opts or {}
    groups = brand_groups(data)
    rounds = [bucket_round_date(b) for b in data["buckets"]]

    def first_den(field: str, k: str) -> Any:
        for g in groups:
            r = ((g.get(field) or {}).get(k) or {}).get("ratio")
            if r is not None:
                return r.get("den")
        return 0

    buckets = []
    for b in data["buckets"]:
        answers = first_den("vis", b["key"])
        if answers == 0:
            continue
        rows = []
        for g in groups:
            v = ((g.get("vis") or {}).get(b["key"]) or {}).get("ratio")
            s = ((g.get("sov") or {}).get(b["key"]) or {}).get("ratio")
            rows.append({"brand": g["name"], "isTracked": g["isOwn"], "mentions": _num(s, "num"),
                         "answers": _num(v, "num"), "exposurePct": mirror_pct(v), "sharePct": mirror_pct(s)})
        buckets.append({"bucketStart": bucket_round_date(b), "answers": answers,
                        "totalMentions": first_den("sov", b["key"]), "measuredDays": _nn(b.get("measured_days"), 0),
                        "firstAt": None, "lastAt": None, "brands": rows})
    mentions = opts.get("mentions") or {}
    brands = []
    for g in groups:
        if "sov" in g:
            total = _sum_in_order(_num(p.get("ratio"), "num") for p in g["sov"].values())
        else:
            total = _nn(mentions.get(g["name"]), 0)
        brands.append({"brand": g["name"], "isTracked": g["isOwn"], "mentions": total})
    out = {"unit": _nn(opts.get("unit"), "week"), "brands": brands, "buckets": buckets,
           "windowStartBucket": rounds[0] if rounds else None,
           "windowEndBucket": rounds[-1] if rounds else None,
           "trendGrid": trend_grid_of(data)}
    gaps = gap_keys(data)
    if gaps:
        out["gapBuckets"] = gaps
    return out


def to_first_position_result(data: dict, opts: dict | None = None) -> dict:
    """dimension=brand, metric position -> FirstPositionResult (latest empty: filled from mentions/brands)."""
    opts = opts or {}
    groups = [g for g in brand_groups(data) if "pos" in g]

    def rank_at(g: dict, k: str) -> dict | None:
        return ((g.get("pos") or {}).get(k) or {}).get("rank")

    buckets = []
    for b in data["buckets"]:
        if not any(rank_at(g, b["key"]) is not None for g in groups):
            continue
        rows = []
        for g in groups:
            r = rank_at(g, b["key"])
            rows.append({"brand": g["name"], "isTracked": g["isOwn"], "avgPosition": rank_avg(r),
                         "rankedAnswers": _num(r, "count")})
        buckets.append({"bucketStart": bucket_round_date(b), "measuredDays": _nn(b.get("measured_days"), 0),
                        "firstAt": None, "lastAt": None, "brands": rows})
    out = {"unit": _nn(opts.get("unit"), "week"), "brands": [g["name"] for g in groups], "buckets": buckets,
           "latest": [], "trendGrid": trend_grid_of(data)}
    gaps = gap_keys(data)
    if gaps:
        out["gapBuckets"] = gaps
    return out
