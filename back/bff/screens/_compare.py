"""Period comparison (K-2 GET /v1/kpi/compare) in the legacy CompareResult shape
(port of front/lib/hgh/adapters/compare.ts).

Call rule: no call (None = "draw the previous Δ") unless the URL period has both ends in order;
None too when the backend reports the epoch gate (meta.suppressed["*"] == "before_epoch").
`common` is the CommonFilters params dict of the screen (CommonQuery keys plus `cf.<uuid>` keys),
built by the shared query module; the compare params are added on top of it.
"""
from __future__ import annotations

import re
from typing import Any

from bff import api
from bff.screens._convert import filter_notices

COMPARE_METRIC_TO_API = {"visibility": "visibility", "share": "share_of_voice", "favorability": "sentiment",
                         "position": "position", "mentionsPerAnswer": "mentions_per_answer",
                         "citationsPerAnswer": "citations_per_answer"}
API_METRIC_TO_COMPARE = {v: k for k, v in COMPARE_METRIC_TO_API.items()}
COMPARE_EPOCH_GATED = "before_epoch"

_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}\Z", re.ASCII)


def _gt0(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0


def compare_measure_value(m: dict | None) -> float | None:
    """Ratio -> num/den, RankAvg -> sum/count; empty denominator -> None."""
    if not m:
        return None
    if "den" in m:
        return m["num"] / m["den"] if _gt0(m["den"]) else None
    return m["sum"] / m["count"] if _gt0(m.get("count")) else None


def legacy_compare_delta(unit: str | None, prev: float | None, cur: float | None) -> float | None:
    """Legacy deltaOf, unrounded: pp = (cur - prev) x 100, rank = cur - prev, pct = (cur - prev) / prev x 100."""
    if prev is None or cur is None:
        return None
    if unit == "pp":
        return (cur - prev) * 100
    if unit == "rank":
        return cur - prev
    if prev == 0:
        return None
    return ((cur - prev) / prev) * 100


_ITEM_FIELDS = (("cyclesPrev", "cycles_prev"), ("cyclesCur", "cycles_cur"), ("plannedPrev", "planned_prev"),
                ("plannedCur", "planned_cur"), ("missingSharePrev", "missing_share_prev"),
                ("missingShareCur", "missing_share_cur"))


def to_compare_result(item: dict) -> dict | None:
    """One CompareItem -> CompareResult, None for a metric the legacy screens never had (citation_share)."""
    metric = API_METRIC_TO_COMPARE.get(item.get("metric"))
    if not metric:
        return None
    prev = compare_measure_value(item.get("prev"))
    cur = compare_measure_value(item.get("cur"))
    out: dict = {"metric": metric}
    if "unit" in item:
        out["unit"] = item["unit"]
    out.update({"prev": prev, "cur": cur,
                "delta": None if item.get("suppressed") else legacy_compare_delta(item.get("unit"), prev, cur)})
    if "suppressed" in item:
        out["suppressed"] = item["suppressed"]
    out["reason"] = item.get("reason")
    for k, src in _ITEM_FIELDS:
        if src in item:
            out[k] = item[src]
    return out


def to_compare_results(items: list[dict], requested: list[str]) -> list[dict]:
    """Items -> results in the requested order (a requested metric the answer lacks is skipped)."""
    by_metric: dict[str, dict] = {}
    for item in items:
        r = to_compare_result(item)
        if r and r["metric"] not in by_metric:
            by_metric[r["metric"]] = r
    return [by_metric[m] for m in requested if m in by_metric]


def has_closed_period(filters: dict) -> bool:
    """Both ends of the URL period set, ISO days, in order (filters.ts hasClosedPeriod)."""
    f, t = filters.get("dateFrom"), filters.get("dateTo")
    return bool(f and t and isinstance(f, str) and isinstance(t, str) and _ISO_DAY.match(f) and _ISO_DAY.match(t)
                and f <= t)


def compare_query(common: dict, req: dict) -> dict:
    """Params of GET /v1/kpi/compare: common + kind, metrics (API names, deduped in order), card=true
    off project (cardParam(surface, true)). req = {surface, kind, metrics}."""
    metrics = list(dict.fromkeys(COMPARE_METRIC_TO_API[m] for m in req["metrics"]))
    extra: dict = {"kind": req["kind"], "metrics": metrics}
    if req["surface"] != "project":
        extra["card"] = True
    return {**common, **extra}


async def fetch_period_compare_view(filters: dict, common: dict, req: dict) -> dict | None:
    """fetchPeriodCompareView: None without a closed period or when the epoch gate answers;
    else {results, compare (meta.compare), notices}."""
    if not has_closed_period(filters):
        return None
    res = await api.get("kpi/compare", compare_query(common, req))
    meta = res.get("meta") or {}
    if (meta.get("suppressed") or {}).get("*") == COMPARE_EPOCH_GATED:
        return None
    out: dict = {"results": to_compare_results(res["data"], req["metrics"])}
    if "compare" in meta:
        out["compare"] = meta["compare"]
    out["notices"] = filter_notices(meta)
    return out


async def fetch_period_compare_api(filters: dict, common: dict, req: dict) -> list[dict] | None:
    """Drop-in for the legacy fetchPeriodCompare: CompareResult[] or None."""
    view = await fetch_period_compare_view(filters, common, req)
    return view["results"] if view else None
