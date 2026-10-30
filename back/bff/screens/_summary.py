"""Summary cards (K-1 GET /v1/kpi/summary) in the KpiSummary shape the screens render
(port of front/lib/hgh/adapters/summary.ts, plus the card helpers of the dashboard:
dashboard/_data/card-state.ts overviewCardState and dashboard/_data/live.ts applyEngineConsistency).

KpiSummary = {key, value, delta, direction, ratio?: {numerator, denominator}, provenance?,
competitorSov?: {brand, value}, engineConsistency?, coverage?, copyVariant?, sparkline?}.
A key TS left undefined is absent here (JSON omits it), None is JSON null.
`common` is the CommonFilters params dict (CommonQuery keys plus `cf.<uuid>` keys).
"""
from __future__ import annotations

from typing import Any

from bff import api
from bff.screens._convert import (as_of_date, filter_notices, pct1_or_null, pct1_or_zero, rank_avg, round1,
                                   suppression_of, whole_suppression)
from bff.screens._js import js_round

ALL_SUMMARY_PARTS = ("applied", "gap", "measured", "urls")
DASHBOARD_SUMMARY_PARTS = ("urls",)
ANALYSIS_SUMMARY_PARTS = ("gap", "measured", "urls")
_MISSING = object()


def _gt0(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0


# ── query ──────────────────────────────────────────────────────────────────

def summary_query(common: dict, req: dict) -> dict:
    """Params of GET /v1/kpi/summary (fetchKpiSummary). req = {surface, card?, cycleOffset?, byFunnel?, parts?}:
    card=true off project, cycle_offset when non-zero, by_funnel when asked, parts sorted and deduped
    (default: card -> every part, else the analysis parts) and sent only when not every part."""
    extra: dict = {}
    if req.get("card") and req["surface"] != "project":
        extra["card"] = True
    if req.get("cycleOffset"):
        extra["cycle_offset"] = req["cycleOffset"]
    if req.get("byFunnel"):
        extra["by_funnel"] = True
    parts = req.get("parts")
    if parts is None:
        parts = ALL_SUMMARY_PARTS if req.get("card") else ANALYSIS_SUMMARY_PARTS
    want = sorted(set(parts))
    if want and len(want) < len(ALL_SUMMARY_PARTS):
        extra["parts"] = want
    return {**common, **extra}


async def fetch_kpi_summary(common: dict, req: dict) -> dict:
    res = await api.get("kpi/summary", summary_query(common, req))
    return {"data": res["data"], "meta": res["meta"]}


async def load_kpi_summary(common: dict, req: dict) -> dict:
    """fetchKpiSummary (every part unless req.parts narrows it) + toKpiSummaryView."""
    return to_kpi_summary_view(await fetch_kpi_summary(common, {"parts": ALL_SUMMARY_PARTS, **req}))


# ── cards ──────────────────────────────────────────────────────────────────

def blocked(meta: Any, key: str) -> str | None:
    """A card blocked by suppression other than no_data (hidden, unsupported, ...)."""
    r = suppression_of(meta, key)
    return r if r and r != "no_data" else None


def card(key: str, value: float | None, ratio: dict | None = None) -> dict:
    out = {"key": key, "value": value, "delta": None, "direction": "flat"}
    if ratio:
        out["ratio"] = ratio
    return out


def _ratio_pair(r: dict) -> dict:
    return {"numerator": r["num"], "denominator": r["den"]}


def to_mirror_kpis(data: dict, meta: Any) -> list[dict]:
    """①~⑤ in buildMirrorKpis order and shape."""
    vis = None if blocked(meta, "visibility") else data.get("visibility")
    sov = None if blocked(meta, "share_of_voice") else data.get("share_of_voice")
    sen = None if blocked(meta, "sentiment") else data.get("sentiment")
    pos = None if blocked(meta, "position") else data.get("position")
    cit = None if blocked(meta, "citation_share") else data.get("citation_share")
    answers = data["params"].get("answers")

    if blocked(meta, "visibility"):
        vis_card = card("visibility", None)
    elif vis:
        vis_card = card("visibility", pct1_or_zero(vis), _ratio_pair(vis))
    else:
        vis_card = card("visibility", 0, {"numerator": 0, "denominator": answers})
    if blocked(meta, "share_of_voice"):
        sov_card = card("shareOfVoice", None)
    elif sov and _gt0(sov.get("den")):
        sov_card = card("shareOfVoice", pct1_or_zero(sov), _ratio_pair(sov))
    else:
        sov_card = card("shareOfVoice", 0)
    sen_value = pct1_or_null(sen)
    sentiment_card = card("sentiment", sen_value, _ratio_pair(sen) if sen and sen_value is not None else None)
    pos_value = rank_avg(pos)
    position_card = card("position", pos_value,
                         {"numerator": pos["sum"], "denominator": pos["count"]} if pos and pos_value is not None else None)
    citation_card = (card("citationShare", pct1_or_zero(cit), _ratio_pair(cit)) if cit and _gt0(cit.get("den"))
                     else card("citationShare", None))
    return [vis_card, sov_card, sentiment_card, position_card, citation_card]


def provenance_of(meta: Any) -> dict | None:
    """meta.source -> KpiProvenance (published: first publication labels, round_date, site_count; live)."""
    src = meta.get("source") if isinstance(meta, dict) else None
    if not isinstance(src, dict) or not src.get("url_rates"):
        return None
    if src["url_rates"] != "report":
        return {"source": "live", "cycleLabel": None, "cycleLabelEn": None}
    details = src.get("publication_details")
    d = details[0] if details else None
    d = d if isinstance(d, dict) else {}
    out = {"source": "published", "cycleLabel": d.get("cycle_label"), "cycleLabelEn": d.get("cycle_label_en")}
    if src.get("round_date"):
        out["roundDate"] = src["round_date"]
    sc = src.get("site_count")
    if isinstance(sc, (int, float)) and not isinstance(sc, bool):
        out["siteCount"] = sc
    return out


def url_prompt_rates(data: dict, meta: Any) -> dict:
    """Website owned / target URL rates per prompt (url_prompts), legacy rounding by value source."""
    u = data.get("url_prompts")
    if not u or not _gt0(u.get("measured_prompts")):
        mp = u.get("measured_prompts") if u else None
        return {"hitPrompts": 0, "ownedPrompts": 0, "measuredPrompts": mp if mp is not None else 0,
                "rate": None, "ownedRate": None}
    src = meta.get("source") if isinstance(meta, dict) else None
    report = isinstance(src, dict) and src.get("url_rates") == "report"

    def rate(n: float) -> float:
        r = {"num": n, "den": u["measured_prompts"]}
        if report:
            return pct1_or_zero(r)
        v = pct1_or_null(r)
        return v if v is not None else 0

    return {"hitPrompts": u["target_prompts"], "ownedPrompts": u["owned_prompts"],
            "measuredPrompts": u["measured_prompts"], "rate": rate(u["target_prompts"]),
            "ownedRate": rate(u["owned_prompts"])}


def to_url_rate_kpis(data: dict, meta: Any) -> dict | None:
    """Website/project URL-rate cards (owned, target, citation accuracy); None on global."""
    m = meta if isinstance(meta, dict) else {}
    if m.get("surface") == "global" or (m.get("suppressed") or {}).get("owned_url_rate") == "not_website_surface":
        return None
    provenance = provenance_of(meta)

    def with_provenance(c: dict) -> dict:
        return {**c, "provenance": provenance} if provenance else c

    acc = data.get("citation_accuracy")
    acc_value = pct1_or_null(acc)
    citation_accuracy = card("citationAccuracy", acc_value, _ratio_pair(acc) if acc and acc_value is not None else None)
    if m.get("surface") == "website":
        p = url_prompt_rates(data, meta)

        def pair(n: float) -> dict | None:
            return {"numerator": n, "denominator": p["measuredPrompts"]} if _gt0(p["measuredPrompts"]) else None

        return {"ownedUrlRate": with_provenance(card("ownedUrlRate", p["ownedRate"], pair(p["ownedPrompts"]))),
                "targetUrlRate": with_provenance(card("targetUrlRate", p["rate"], pair(p["hitPrompts"]))),
                "citationAccuracy": citation_accuracy, "unit": "prompt"}

    def rate(key: str, r: dict | None) -> dict:
        return with_provenance(card(key, pct1_or_null(r), _ratio_pair(r) if r and _gt0(r.get("den")) else None))

    return {"ownedUrlRate": rate("ownedUrlRate", data.get("owned_url_rate")),
            "targetUrlRate": rate("targetUrlRate", data.get("target_url_rate")),
            "citationAccuracy": citation_accuracy, "unit": "measurement"}


def summary_is_empty(data: dict, meta: Any) -> bool:
    """Whole-answer suppression ('*') or no answers."""
    return whole_suppression(meta) is not None or data["params"].get("answers") == 0


def to_kpi_summary_view(res: dict) -> dict:
    data, meta = res["data"], res["meta"]
    gap = data.get("analysis_gap")
    whole = whole_suppression(meta)
    params = data["params"]
    out: dict = {"asOf": as_of_date(meta)}
    if "mode" in meta:
        out["mode"] = meta["mode"]
    funnel = params.get("measured_by_funnel")
    out.update({
        "cycles": list(meta.get("cycles") or []),
        "empty": summary_is_empty(data, meta),
        "emptyReason": whole if whole is not None else ("no_answers" if params.get("answers") == 0 else None),
        "kpis": to_mirror_kpis(data, meta),
        "urlRates": to_url_rate_kpis(data, meta),
        "params": {
            "answers": params.get("answers"),
            "appliedPrompts": params.get("applied_prompts"),
            "measuredPrompts": params.get("measured_prompts"),
            "promptsWithoutBrand": params.get("prompts_without_brand"),
            "measuredByFunnel": None if funnel is None else [
                {"funnel": f.get("funnel"), "measuredPrompts": f.get("measured_prompts")} for f in funnel],
        },
        "analysisGap": {"gapAnswers": gap["gap_answers"], "baseAnswers": gap["base_answers"],
                        "rate": pct1_or_null({"num": gap["gap_answers"], "den": gap["base_answers"]})} if gap else None,
    })
    provenance = provenance_of(meta)
    if provenance is not None:
        out["provenance"] = provenance
    out["suppressed"] = dict(meta.get("suppressed") or {})
    out["notices"] = filter_notices(meta)
    return out


def apply_competitor_sov_from_brands(kpis: list[dict], own_mentions: float | None, brands: list[dict],
                                     designated_target: str | None = None) -> list[dict]:
    """KPI #16 on the shareOfVoice card: own mentions / the reference brand's mentions x 100, one decimal.
    Reference = the designated target (case-insensitive name, mentions 0 when absent) or the most
    mentioned competitor that is neither own nor an HMG sibling. No competitor -> kpis unchanged.
    No own mentions count (None: 당사's share of voice has no numerator) or a reference without mentions
    -> the row with no value (renewal audit 3-3, 2026-10-31: it was taken as 0 mentions, "0.0배")."""
    competitors = [b for b in brands if not b.get("is_own") and b.get("is_hmg_own") is not True]
    if designated_target:
        t = designated_target.lower()
        target = next((b for b in competitors if b["name"].lower() == t), None) or {"name": designated_target, "mentions": 0}
    else:
        ranked = sorted(competitors, key=lambda b: -b["mentions"])
        target = ranked[0] if ranked else None
    if not target:
        return kpis
    m = target["mentions"]
    value = js_round((1000 * own_mentions) / m) / 10 if own_mentions is not None and m > 0 else None
    competitor_sov = {"brand": target["name"], "value": value}
    return [{**k, "competitorSov": competitor_sov} if k.get("key") == "shareOfVoice" else k for k in kpis]


# ── card helpers of the dashboards ─────────────────────────────────────────

def overview_card_state(k: dict | None) -> dict:
    """overviewCardState: value None, or 0 without a denominator, is "측정 대기" (no Δ)."""
    k = k or {}
    value = k.get("value")
    raw_delta = k.get("delta")
    denom = (k.get("ratio") or {}).get("denominator")
    if value is None or (value == 0 and (denom is None or denom == 0)):
        return {"value": None, "pending": True, "delta": None}
    return {"value": value, "pending": False, "delta": raw_delta}


def consistency(values: list[float]) -> float | None:
    """Engine consistency = min / max x 100 (one decimal); fewer than two engines or max <= 0 -> None."""
    if len(values) < 2:
        return None
    mn, mx = min(values), max(values)
    return round1((100 * mn) / mx) if mx > 0 else None


def apply_engine_consistency(kpis: list[dict], rows: list[dict] | None) -> list[dict]:
    """applyEngineConsistency: engineConsistency on ①~⑤ from the per-engine rows (SubKpiEngineRow)."""
    if not rows:
        return kpis

    def vals_of(f) -> list[float]:
        return [v for v in (f(r) for r in rows) if v is not None]

    cons = {
        "visibility": consistency(vals_of(lambda r: r["tracked"] / r["answers"] if r["answers"] > 0 else None)),
        "shareOfVoice": consistency(vals_of(
            lambda r: r["trackedMentions"] / r["totalMentions"] if r["totalMentions"] > 0 else None)),
        "sentiment": consistency(vals_of(
            lambda r: r["positiveMentions"] / r["sentMentions"] if r["sentMentions"] > 0 else None)),
        "position": consistency(vals_of(lambda r: r.get("avgPosition"))),
        "citationShare": consistency(vals_of(lambda r: r["citOwned"] / r["citTotal"] if r["citTotal"] > 0 else None)),
    }
    out = []
    for k in kpis:
        v = cons.get(k.get("key"))
        out.append({**k, "engineConsistency": v} if v is not None and k.get("value", _MISSING) is not None else k)
    return out
