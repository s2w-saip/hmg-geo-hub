"""Renewal mention page (/renewal/standard/answer-analysis/mention): screens "mention/rn-<section>".

Port of the page's client view model (mention-model.ts), the brand-group master data
(brand-groups.ts), useCompare (mention-context.tsx) and the card computations of
mention-body / -tabs / -rate / -rank / -favor / -brands.tsx. Every number comes from the mention
view functions (bff.screens.mention_view = kpi-view.ts) over the mention loaders
(bff.screens.mention_data = lib/hgh/adapters/mentions.ts + kpi-tab.ts); this module regroups
them for the redesign and derives the summary rules.

Compare brands (max 3, picked in the control bar) stay UI state in Next. Everything computed
over them is precomputed here for every pick: a pick is a subset of the covered competitors
(at most 3 of them, keyed by the bit mask of their positions in `covered`), and per subset the
payload carries the rule outcome. Where the old code broke a tie by pick order (the leading
compare brand of a type), the payload lists the tied brands and Next takes the first one the
user picked, which is the same brand the old reduce kept.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import unicodedata
from functools import cmp_to_key
from itertools import combinations
from typing import Any

from bff.screens import screen, split_context
from bff.screens._competitors import competitor_value_of
from bff.screens._convert import Exact, delta1, exact
from bff.screens._convert import round1 as _exact_round1
from bff.screens._period import kst_today, period_caption, to_period_delta_view
from bff.screens._sort import locale_compare, table_orders

OWN_KEY = "__own"
KPI_TABS = ("exposure", "sov", "favorability", "first-rank")
HERO_METRICS = ("exposure", "sov", "favorability")
RATE_METRICS = ("exposure", "sov")
MENTION_AXES = ("brand", "geography", "language", "engine", "time", "promptContext", "brandPresence", "listType",
                "depth1", "depth2", "depth3", "depth4")
SENTIMENT_KEYS = ("positive", "neutral", "mixed", "negative")
#: strongest endorsement first (mention-model TYPE_STRENGTH)
TYPE_STRENGTH = ("final_choice", "recommendation", "comparison", "definition", "mention")
#: The summary findings in one fixed order, 당사 first (standing, engine gap, type, negative signals), then the
#: competitors' moves: no threshold or HUB priority decides which show or their tone, which follows the direction
#: only — a competitor's move is not good or bad in itself (2026-10-30 W6 review, the user's go-ahead).
FINDING_ORDER = {"standingLead": 6, "standingTrail": 6, "engine": 5, "typeTrail": 4, "typeLead": 4, "negative": 3, "mover": 2, "climb": 1}
TYPE_AVG_TOP = 5
#: competitor rows on the board (the original table's cap, own rows excluded)
BOARD_COMPETITORS = 12
#: board rows shown before "more" (mention-rate BOARD_TOP)
BOARD_TOP = 5
#: max compare brands (mention-context COMPARE_COLORS.length)
COMPARE_MAX = 3
#: the treemap's brands and the shell's drawer rows; the ranking table shows this many first (mention-brands TOP)
BRANDS_TOP = 100
TREEMAP_FOLD = "__rest"
FOLD_SHARE = 1.5
FOLD_AFTER = 14
OVERVIEW_KEY = {"exposure": "visibility", "sov": "shareOfVoice"}
COMPARE_KEY = {"exposure": "visibility", "sov": "share"}


# ── JS semantics ──────────────────────────────────────────────────────────────


def _truthy(v: Any) -> bool:
    """JavaScript truthiness of a JSON value ({} and [] are truthy)."""
    if v is None or v is False:
        return False
    if v is True:
        return True
    if isinstance(v, (int, float)):
        return v != 0 and not math.isnan(v)
    if isinstance(v, str):
        return v != ""
    return True


def _sign(x: float) -> int:
    return (x > 0) - (x < 0)


def _js_sum(values) -> float:
    """reduce((s, v) => s + v, 0): left to right (Python's sum() compensates floats). A sum of rounded values
    keeps the sum of their exact values (a Δ of it subtracts exact values)."""
    s = 0
    e = 0
    rounded = False
    for v in values:
        s = s + v
        e = e + exact(v)
        rounded = rounded or isinstance(v, Exact)
    return Exact(s, e) if rounded else s


def round1(n: float) -> float:
    return _exact_round1(n)


def _mean1(values: list) -> float:
    """The average rounded to 0.1 from the rounded values, as the front did, keeping the exact average."""
    s = _js_sum(values)
    return Exact(round1(s / len(values)), exact(s) / len(values))


def _sort(items: list, cmp) -> list:
    return sorted(items, key=cmp_to_key(cmp))


def _last_two(s: list, diff) -> Any:
    return diff(s[-1], s[-2]) if len(s) >= 2 else None


def is_hmg_sibling(hmg_own: Any, tracked: bool) -> bool:
    """An HMG brand that is not 당사 for this account (brand accounts see their siblings as brands). Which brands are
    HMG's is Gold's (`is_hmg_own` = dim_brand.own_bit, the body read's `hmgOwn`); it was a HUB name list (renewal
    audit 8-1)."""
    return not tracked and hmg_own is True


def hmg_flags(brands: list[dict] | None) -> dict[str, bool]:
    """Gold's HMG flag of each rival in the body brand rows, by name (Gold's dim_brand.name, unique)."""
    return {b["brand"]: b.get("hmgOwn") is True for b in brands or [] if not b.get("isTracked")}


# ── brand → parent group (brand-groups.ts master data) ────────────────────────

NON_AUTO_GROUP = "__nonAuto"

#: (group label, ISO country of the parent, member brand names)
GROUPS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("HMG", "KR", ("Hyundai", "Kia", "Genesis", "Mobis", "Hyundai Mobis")),
    ("Toyota", "JP", ("Toyota", "Lexus", "Daihatsu", "Hino")),
    ("VW", "DE", ("Volkswagen", "VW", "Audi", "Porsche", "Skoda", "SEAT", "CUPRA", "Bentley", "Lamborghini", "Ducati", "Scout")),
    ("Stellantis", "NL", ("Stellantis", "Peugeot", "Citroen", "DS Automobiles", "DS", "Opel", "Vauxhall", "Fiat", "Abarth",
                          "Lancia", "Jeep", "Alfa Romeo", "Maserati", "Dodge", "Ram", "Chrysler")),
    ("GM", "US", ("General Motors", "GM", "Chevrolet", "Cadillac", "GMC", "Buick", "BrightDrop", "Holden")),
    ("Ford", "US", ("Ford", "Lincoln")),
    ("BMW", "DE", ("BMW", "MINI", "Rolls-Royce", "BMW Motorrad")),
    ("Mercedes-Benz", "DE", ("Mercedes-Benz", "Mercedes", "Maybach", "Mercedes-Maybach", "Mercedes-AMG", "AMG", "Daimler")),
    ("Geely", "CN", ("Geely", "Volvo", "Polestar", "Zeekr", "Lotus", "Lynk & Co")),
    ("BYD", "CN", ("BYD", "Denza", "Yangwang", "Fangchengbao")),
    ("Tesla", "US", ("Tesla",)),
    ("Honda", "JP", ("Honda", "Acura")),
    ("Renault", "FR", ("Renault", "Dacia", "Alpine")),
    ("Nissan", "JP", ("Nissan", "Infiniti", "Datsun")),
    ("Tata", "IN", ("Tata", "Tata Motors", "Jaguar", "Land Rover", "Range Rover", "Jaguar Land Rover", "JLR")),
    ("SAIC", "CN", ("SAIC", "MG", "Wuling", "Baojun", "Maxus", "Roewe", "IM Motors")),
    ("Great Wall", "CN", ("Great Wall", "Great Wall Motor", "GWM", "Haval", "Ora", "Tank", "Wey")),
    ("Suzuki", "JP", ("Suzuki", "Maruti", "Maruti Suzuki")),
    ("Rimac", "HR", ("Rimac", "Bugatti", "Bugatti Rimac")),
    ("Seres", "CN", ("Seres", "Aito")),
    ("Changan", "CN", ("Changan", "Deepal", "Avatr")),
    ("GAC", "CN", ("GAC", "Aion", "Trumpchi")),
    ("Chery", "CN", ("Chery", "Omoda", "Jaecoo", "Exeed")),
    ("Mazda", "JP", ("Mazda",)),
    ("Subaru", "JP", ("Subaru",)),
    ("Mitsubishi", "JP", ("Mitsubishi",)),
    ("Isuzu", "JP", ("Isuzu",)),
    ("Ferrari", "IT", ("Ferrari",)),
    ("McLaren", "GB", ("McLaren",)),
    ("Aston Martin", "GB", ("Aston Martin",)),
    ("Rivian", "US", ("Rivian",)),
    ("Lucid", "US", ("Lucid",)),
    ("NIO", "CN", ("NIO",)),
    ("XPeng", "CN", ("XPeng",)),
    ("Li Auto", "CN", ("Li Auto",)),
    ("Xiaomi", "CN", ("Xiaomi",)),
    ("Leapmotor", "CN", ("Leapmotor",)),
    ("Smart", "CN", ("Smart",)),
    ("VinFast", "VN", ("VinFast",)),
    ("Mahindra", "IN", ("Mahindra",)),
    ("Togg", "TR", ("Togg",)),
    ("Proton", "MY", ("Proton",)),
    ("Perodua", "MY", ("Perodua",)),
    # not car makers: AI assistants, map apps, tech platforms, sport, fashion (they appear in answers as brands)
    (NON_AUTO_GROUP, "", ("Alexa", "Waze", "Alphabet", "Google", "Huawei", "Apple", "Amazon", "Formula 1", "Giorgio Armani",
                          "G2", "Apollo")),
)

_COMBINING = re.compile("[̀-ͯ]")
_NOT_KEY = re.compile("[^a-z0-9&]")


def brand_fold_key(name: str) -> str:
    """Fold case, accents and punctuation: "Škoda" → "skoda", "Rolls-Royce" → "rollsroyce"."""
    s = _COMBINING.sub("", unicodedata.normalize("NFD", name))
    return _NOT_KEY.sub("", s.lower())


_GROUP_BY_KEY: dict[str, str] = {}
for _g, _cc, _members in GROUPS:
    for _m in _members:
        _GROUP_BY_KEY[brand_fold_key(_m)] = _g
_COUNTRY_OF: dict[str, str] = {g: cc for g, cc, _ in GROUPS}


def parent_group_of(brand: str) -> str:
    """The parent group of a brand; a brand outside the table is its own group (its own name)."""
    return _GROUP_BY_KEY.get(brand_fold_key(brand), brand)


def is_mapped_brand(brand: str) -> bool:
    return brand_fold_key(brand) in _GROUP_BY_KEY


def group_country(group: str) -> str:
    return _COUNTRY_OF.get(group, "")


# ── the mention view (kpi-view.ts) and loaders, imported lazily so this module loads alone ──


def _mv():
    from bff.screens import mention_view
    return mention_view


def _md():
    from bff.screens import mention_data
    return mention_data


def delta_pp(cur: Any, prev: Any) -> Any:
    return _mv().delta_pp(cur, prev)


def pct_or_null(num: Any, den: Any) -> Any:
    return _mv().pct_or_null(num, den)


# ── Δ: the original's precedence, one function ───────────────────────────────


def resolve_delta(inp: dict) -> dict:
    """period compare (that metric) → the Overview card rule (last two valued slots) → the previous
    snapshot (resolveDelta)."""
    period = inp.get("period")
    key = inp.get("compareKey")
    r = None
    if key and period is not None:
        for x in period.get("compare") or []:
            if x.get("metric") == key:
                r = x
                break
    if r is not None and period is not None:
        d = r.get("delta")
        v = None if d is None else _sign(d) * round1(abs(d))
        days = period.get("days")
        return {"value": 0 if v == 0 else v,
                "basis": {"kind": "period", "caption": period_caption(r, {"days": 0 if days is None else days, "kind": period.get("kind")})}}
    cycle = inp.get("cycle")
    if cycle:
        return {"value": cycle["pp"], "basis": {"kind": "cycle", "date": cycle["basisDate"]}}
    prev = inp.get("prev")
    if prev:
        return {"value": delta_pp(prev.get("cur"), prev.get("prev")), "basis": {"kind": "prev", "date": prev["asOf"]}}
    return {"value": None, "basis": None}


# ── KPI heroes ────────────────────────────────────────────────────────────────


def _slots(engine: Any, key: str = "overviewDeltaSlots") -> Any:
    return engine.get(key) if isinstance(engine, dict) else None


def rate_hero(metric: str, sub: Any, prev: Any, engine: Any, period: Any) -> dict:
    mv = _mv()
    hero = mv.kpi_hero(sub, metric)
    cycle = mv.overview_delta_from_slots(_slots(engine), OVERVIEW_KEY[metric])
    points = [{"key": p["bucketStart"], "pct": p.get("pct"), "numerator": p.get("numerator"), "denominator": p.get("denominator"),
               "gap": _truthy(p.get("gap"))} for p in mv.kpi_trend_points(engine, metric)]
    return {
        "metric": metric,
        "pct": hero["pct"],
        "numerator": hero["numerator"],
        "denominator": hero["denominator"],
        "delta": resolve_delta({
            "period": period,
            "compareKey": COMPARE_KEY[metric],
            "cycle": cycle,
            "prev": {"cur": hero["pct"], "prev": mv.kpi_hero(prev["sub"], metric)["pct"], "asOf": prev["asOf"]} if prev else None,
        }),
        "points": points,
        "trendMissing": not mv.hero_trend_available(engine),
    }


def favor_hero(sub: Any, prev: Any, engine: Any, period: Any) -> dict:
    mv = _mv()
    h = mv.favorability_hero(sub)
    p = mv.favorability_hero(prev["sub"]) if _truthy(prev) else None
    both = _truthy(prev) and p is not None
    return {
        "positivePct": h["positivePct"],
        "negativePct": h["negativePct"],
        "positive": h["positive"],
        "total": h["total"],
        "positiveDelta": resolve_delta({
            "period": period,
            "compareKey": "favorability",
            "cycle": mv.overview_delta_from_slots(_slots(engine), "sentiment"),
            "prev": {"cur": h["positivePct"], "prev": p["positivePct"], "asOf": prev["asOf"]} if both else None,
        }),
        # 부정 비율은 계약 지표가 없다 → 종전 Δ(직전 스냅샷)만.
        "negativeDelta": resolve_delta({"period": None, "compareKey": None, "cycle": None,
                                        "prev": {"cur": h["negativePct"], "prev": p["negativePct"], "asOf": prev["asOf"]} if both else None}),
        "mixedBasis": _truthy(sub.get("overviewCards")) if isinstance(sub, dict) else False,
        "points": [{"key": x["bucketStart"], "positive": x.get("positivePct"), "negative": x.get("negativePct"), "gap": _truthy(x.get("gap"))}
                   for x in mv.favorability_trend_points(engine)],
        # the points come from the overview slots when the load has them (as the rate hero's trend), so a failed
        # sibling read of the load does not hide them
        "trendMissing": not mv.hero_trend_available(engine),
    }


def _axis_keys(mv, res: Any) -> list[str]:
    return [a["bucketStart"] for a in mv.trend_axis(res["buckets"], res["unit"], res)]


def rank_hero(fp: Any, period: Any) -> dict:
    mv = _mv()
    h = mv.first_rank_hero(fp)
    r = None
    if isinstance(period, dict):
        r = next((x for x in period.get("compare") or [] if x.get("metric") == "position"), None)
    if r is not None:
        delta = resolve_delta({"period": period, "compareKey": "position", "cycle": None, "prev": None})
    else:
        d = h.get("delta")
        delta = {"value": d, "basis": None if d is None else {"kind": "cycle", "date": mv.first_rank_delta_basis(fp)}}
    return {
        "avgPosition": h.get("avgPosition"),
        "rankedAnswers": h.get("rankedAnswers"),
        "delta": delta,
        # 당사's line: the brand trend's own rows weighted by their ranked answers. The reader sends one own series, the
        # perspective's date totals (2026-10-29 metric review R1), so this is Gold's perspective value round by round,
        # the hero's own (renewal audit 5-3 / U11: checked against the overview trend on live data, 2026-10-31).
        "series": mv.own_position_series(fp) if fp else [],
        "axis": _axis_keys(mv, fp) if fp else [],
    }


# ── 경쟁 구도 board (exposure / sov) ─────────────────────────────────────────


def _board_cmp(a: dict, b: dict) -> int:
    d = (b["pct"] if b["pct"] is not None else -1) - (a["pct"] if a["pct"] is not None else -1)
    if d != 0:
        return _sign(d)
    return -1 if a["own"] else 1 if b["own"] else locale_compare(a["key"], b["key"])


def _prev_value(prev_brands: list[dict], brand: str, key: str) -> Any:
    """A brand's value on the period before (competitor_value_of the body row), None when it had none."""
    row = next((b for b in prev_brands if b["brand"] == brand), None)
    return competitor_value_of(row, key) if row else None


def board(inp: dict) -> dict:
    """경쟁 구도 board. In period mode (`prevBrands` = the rows of the period before) a rival's Δ compares its
    period total with that period, like 당사's; else the last two rounds of its trend."""
    mv = _mv()
    metric, brands, trend, values, hero = inp["metric"], inp["brands"], inp.get("trend"), inp.get("values"), inp["hero"]
    prev_brands = inp.get("prevBrands")
    tracked = len([b for b in brands if b.get("isTracked")])
    rows = mv.competitor_kpi_rows({"brands": brands, "trend": trend, "metric": metric, "ownPct": hero["pct"], "values": values,
                                   "limit": tracked + BOARD_COMPETITORS})
    axis_entries = mv.trend_axis(trend["buckets"], trend["unit"], trend) if trend else []
    axis = [a["bucketStart"] for a in axis_entries]
    series = {b["brand"] for b in (trend or {}).get("brands") or []} if trend else set()
    hero_by = {p["key"]: p["pct"] for p in hero["points"]}
    own_spark = [hero_by.get(k) for k in axis] if axis else [p["pct"] for p in hero["points"]]
    own = {"key": OWN_KEY, "own": True, "sibling": False, "pct": hero["pct"], "mentions": None, "spark": own_spark,
           "delta": hero["delta"]["value"], "gap": None, "covered": True}
    key = mv.overview_key_of(metric)
    hmg = hmg_flags(brands)
    comps = [{"key": r["brand"], "own": False, "sibling": is_hmg_sibling(hmg.get(r["brand"]), False), "pct": r["pct"], "mentions": r["mentions"],
              "spark": r["spark"], "gap": r["gapPp"], "covered": r["brand"] in series,
              "delta": r["wowPp"] if prev_brands is None else delta_pp(r["pct"], _prev_value(prev_brands, r["brand"], key))}
             for r in rows if not r["isTracked"]]
    all_rows = _sort([own, *comps], _board_cmp)
    own_index = next(i for i, r in enumerate(all_rows) if r["own"])
    return {
        "rows": all_rows,
        "axis": axis,
        "measuredCycles": len([a for a in axis_entries if a["measured"]]),
        "ownRank": None if hero["pct"] is None else own_index + 1,
    }


def hero_trend_series(hero: dict, trend: Any, metric: str, compare: list[str]) -> dict:
    """Hero chart series on the hero axis: 당사 + the compare brands (or the covered competitors' average)."""
    x = [p["key"] for p in hero["points"]]
    by_bucket = {b["bucketStart"]: b for b in (trend or {}).get("buckets") or []} if trend else {}

    def value_of(brand: str, key: str) -> Any:
        b = by_bucket.get(key)
        hit = next((h for h in b["brands"] if h["brand"] == brand), None) if b else None
        if not hit:
            return None
        return hit.get("exposurePct") if metric == "exposure" else hit.get("sharePct")

    competitors = [b["brand"] for b in ((trend or {}).get("brands") or []) if not b.get("isTracked")] if trend else []
    # the average stays the top-10 rivals' (the reader's pinned top rival only adds a line to compare, 2026-10-30)
    top = [b["brand"] for b in ((trend or {}).get("brands") or []) if not b.get("isTracked") and not b.get("pinned")] if trend else []
    brands = [{"key": key, "values": [value_of(key, k) for k in x]} for key in compare if key in competitors]
    average = None
    if len(compare) == 0 and top:
        average = []
        for k in x:
            vs = [v for v in (value_of(b, k) for b in top) if v is not None]
            average.append(_mean1(vs) if vs else None)
    return {"x": x, "own": [p["pct"] for p in hero["points"]], "brands": brands, "average": average}


# ── AI 엔진별 ─────────────────────────────────────────────────────────────────


def engine_rows(engine: Any, metric: str, prev_engines: dict | None = None) -> dict:
    """AI 엔진별 cards; in period mode (`prev_engines` = {engine: 당사 point of the period before}) the Δ compares
    the period with that period, else the last two rounds."""
    mv = _mv()
    bars = mv.engine_competitor_bars(engine, metric)
    points = mv.engine_kpi_series(engine, metric)["points"]
    x = [p["bucketStart"] for p in points]
    rows = []
    for b in bars:
        series = []
        for p in points:
            v = p.get(b["engine"])
            series.append(v if isinstance(v, (int, float)) and not isinstance(v, bool) else None)
        if prev_engines is None:
            delta = _last_two(series, delta_pp)
        else:
            p = prev_engines.get(b["engine"])
            delta = delta_pp(b["ownPct"], (p["exposurePct"] if metric == "exposure" else p["sovPct"]) if p else None)
        rows.append({"engine": b["engine"], "own": b["ownPct"], "avg": b["competitorAvgPct"], "avgCount": b["competitorCount"],
                     "gap": delta_pp(b["ownPct"], b["competitorAvgPct"]), "series": series, "delta": delta})
    return {"rows": rows, "x": x, "trendMissing": not mv.engine_trend_series_available(engine)}


# ── 멘션 유형 ─────────────────────────────────────────────────────────────────


def _type_avg_set(tb: dict, brands: list[dict], by_brand: dict) -> list[str]:
    pool = [b for b in brands if not b.get("isTracked") and b["brand"] in by_brand]
    return [b["brand"] for b in _sort(pool, lambda a, b: _sign(b["mentions"] - a["mentions"]))[:TYPE_AVG_TOP]]


def type_compare_base(tb: dict, brands: list[dict]) -> dict:
    """The part of type_compare_rows no pick changes (the brand index, 당사 and the rival average per type),
    computed once for the cards that run every pick: per pick it re-sorted every brand (0.5 s a month view)."""
    by_brand = {b["brand"]: b for b in tb["brands"]}
    avg_set = _type_avg_set(tb, brands, by_brand)
    types = []
    for type_ in TYPE_STRENGTH:
        total = tb["totals"][type_]
        own = pct_or_null(_js_sum(b["types"][type_] for b in tb["brands"] if b.get("isTracked")), total)
        avg_vals = [v for v in (pct_or_null(by_brand[b]["types"][type_], total) for b in avg_set) if v is not None]
        types.append((type_, total, own, _mean1(avg_vals) if avg_vals else None))
    return {"byBrand": by_brand, "types": types}


def type_compare_rows(inp: dict, base: dict | None = None) -> list[dict]:
    """`base` = type_compare_base(inp["typesByBrand"], inp["brands"]) when the caller has it."""
    tb = inp.get("typesByBrand")
    if not tb:
        return []
    base = base or type_compare_base(tb, inp["brands"])
    by_brand = base["byBrand"]
    out = []
    for type_, total, own, avg in base["types"]:

        def share(n: Any, total=total) -> Any:
            return pct_or_null(n, total)

        dots = []
        for brand in inp["compare"]:
            hit = by_brand.get(brand)
            dots.append({"brand": brand, "value": share(hit["types"][type_]) if hit and not hit.get("isTracked") else None})
        valued = [d for d in dots if d["value"] is not None]
        if valued:
            ref = valued[0]
            for c in valued[1:]:
                if c["value"] > ref["value"]:
                    ref = c
        else:
            ref = {"brand": None, "value": avg}
        out.append({"type": type_, "own": own, "avg": avg, "dots": dots, "ref": ref, "gap": delta_pp(own, ref["value"])})
    return out


def _type_rounds(engine: Any, metric: str) -> tuple[list[str], list]:
    """The rounds of the 당사 type lines: the exposure trend's keys and each one's type trend bucket (None = a gap or
    no type answers). The share view has no lines."""
    if metric != "exposure":
        return [], []
    mv = _mv()
    type_by = {b["bucketStart"]: b for b in (engine.get("typeTrend") or [])} if isinstance(engine, dict) else {}
    points = mv.kpi_trend_points(engine, "exposure")
    return [p["bucketStart"] for p in points], [None if p.get("gap") else type_by.get(p["bucketStart"]) for p in points]


def type_own_rows(kpi: Any, engine: Any, metric: str) -> list[dict]:
    if not kpi:
        return []
    # each type's line on the exposure trend's rounds: the type trend's own answers over the round's answers. A round
    # with type answers was measured; the shared type_combo_points keeps only rounds with measurement days, which the
    # Gold reader sends as null, so every line was empty (2026-10-29).
    _, rounds = _type_rounds(engine, metric)
    out = []
    for type_ in TYPE_STRENGTH:
        r = next((x for x in kpi["rows"] if x["type"] == type_), None)
        spark = [pct_or_null(b["byType"][type_], b["answers"]) if b else None for b in rounds]
        pct = None
        if r:
            pct = r["ownExposurePct"] if metric == "exposure" else pct_or_null(r["ownMentions"], kpi["ownMentions"])
        out.append({"type": type_, "pct": pct, "signals": r["ownMentions"] if r and r.get("ownMentions") is not None else 0,
                    "spark": spark, "delta": _last_two(spark, delta_pp)})
    return out


# ── 우호도 ────────────────────────────────────────────────────────────────────


def favor_distribution(totals: Any) -> list[dict]:
    return _mv().sentiment_segments(totals)


def favor_matrix(kpi: Any, totals: Any = None) -> list[dict]:
    """전체 first, then the types strongest endorsement first. 전체 is every 당사 mention (`totals`, the 감정 분포
    card's counts), not the type rows summed: a mention can carry several types, so the sum counted it once a type
    and showed another 우호도 (58.1 % against the page's 54.1 %, 2026-10-29). No totals, no 전체 row."""
    rows = _mv().type_sentiment_rows(kpi, "own")
    if not rows:
        return []
    picked = [next((r for r in rows if r["type"] == t), None) for t in TYPE_STRENGTH]
    segs = favor_distribution(totals)
    total = _js_sum(x["count"] for x in segs)
    all_row = {"type": "all", **{x["key"]: x["count"] for x in segs}, "total": total,
               "positivePct": pct_or_null(totals["positive"], total), "segments": segs} if segs else None
    return [*([all_row] if all_row else []), *[r for r in picked if r]]


# ── 우선 노출도 ───────────────────────────────────────────────────────────────


def _rank_cmp(a: dict, b: dict) -> int:
    ap, bp = a["avgPosition"], b["avgPosition"]
    if ap is None and bp is not None:
        return 1
    if bp is None and ap is not None:
        return -1
    if ap is not None and bp is not None and ap - bp != 0:
        return _sign(ap - bp)
    return -1 if a["own"] else 1 if b["own"] else locale_compare(a["key"], b["key"])


def rank_board(fp: Any, values: Any, hero: dict, prev_brands: list[dict] | None = None, brands: list[dict] | None = None) -> dict:
    """The 우선 노출도 table; in period mode a rival's Δ compares its period average with the period before. `brands` (the
    body brand rows, the read the table's latest values come from) name the HMG siblings."""
    mv = _mv()
    hmg = hmg_flags(brands)
    overlaid = mv.overlay_first_position_values(fp, values)
    table = mv.rank_table_rows(overlaid, {"sparkCycles": 4})
    series = set(overlaid.get("brands") or []) if overlaid else set()
    own = {"key": OWN_KEY, "own": True, "sibling": False, "avgPosition": hero["avgPosition"], "rank": None,
           "spark": hero["series"][-4:], "delta": hero["delta"]["value"], "gap": None, "covered": True}
    comps = []
    for r in table:
        if r["isTracked"]:
            continue
        gap = mv.delta_position(r["avgPosition"], hero["avgPosition"]) if r["avgPosition"] is not None and hero["avgPosition"] is not None else None
        delta = r["wow"] if prev_brands is None else mv.delta_position(r["avgPosition"], _prev_value(prev_brands, r["brand"], "position"))
        comps.append({"key": r["brand"], "own": False, "sibling": is_hmg_sibling(hmg.get(r["brand"]), False), "avgPosition": r["avgPosition"],
                      "rank": r["rank"], "spark": r["spark"], "delta": delta, "gap": gap, "covered": r["brand"] in series})
    rows = _sort([own, *comps], _rank_cmp)
    ahead = 0 if hero["avgPosition"] is None else len([r for r in comps if r["avgPosition"] is not None and r["avgPosition"] < hero["avgPosition"]])
    return {"rows": rows, "ahead": ahead}


def rank_series_of(fp: Any, brand: str, axis: list[str]) -> list:
    """Position per slot of a competitor (rank chart), on the hero axis."""
    by = {b["bucketStart"]: b for b in (fp or {}).get("buckets") or []} if fp else {}
    out = []
    for k in axis:
        b = by.get(k)
        hit = next((x for x in b["brands"] if x["brand"] == brand), None) if b else None
        out.append(hit.get("avgPosition") if hit else None)
    return out


# ── 브랜드 언급 상세: bump, share Δ, treemap ───────────────────────────────────


def bump_data(trend: Any) -> dict | None:
    """Weekly mention ranks of 당사 (all tracked brands summed) and the top-10 competitor series (not the reader's
    pinned top rival, 2026-10-30)."""
    if not trend or len(trend["buckets"]) == 0:
        return None
    axis = _mv().trend_axis(trend["buckets"], trend["unit"], trend)
    by = {b["bucketStart"]: b for b in trend["buckets"]}
    comps = [b["brand"] for b in trend["brands"] if not b.get("isTracked") and not b.get("pinned")]
    has_own = any(b.get("isTracked") for b in trend["brands"])
    keys = ([OWN_KEY] if has_own else []) + comps
    series = [{"key": k, "own": k == OWN_KEY, "mentions": [], "shares": [], "ranks": []} for k in keys]
    for a in axis:
        b = by.get(a["bucketStart"]) if a["measured"] else None
        for s in series:
            if not b:
                s["mentions"].append(None)
                s["shares"].append(None)
                continue
            hits = [x for x in b["brands"] if x.get("isTracked")] if s["own"] else [x for x in b["brands"] if x["brand"] == s["key"]]
            s["mentions"].append(_js_sum(x["mentions"] for x in hits) if hits else 0)
            s["shares"].append(round1(_js_sum((x.get("sharePct") if x.get("sharePct") is not None else 0) for x in hits)) if hits else 0)
    for i in range(len(axis)):
        def cmp(a: int, b: int, i=i) -> int:
            sa, sb = series[a], series[b]
            d = sb["mentions"][i] - sa["mentions"][i]
            if d != 0:
                return _sign(d)
            d = (sb["shares"][i] if sb["shares"][i] is not None else 0) - (sa["shares"][i] if sa["shares"][i] is not None else 0)
            if d != 0:
                return _sign(d)
            return locale_compare(sa["key"], sb["key"])
        order = _sort([j for j, s in enumerate(series) if s["mentions"][i] is not None], cmp)
        pos = {j: n + 1 for n, j in enumerate(order)}
        for j, s in enumerate(series):
            s["ranks"].append(None if s["mentions"][i] is None else pos[j])
    measured = [i for i, a in enumerate(axis) if a["measured"] and a["bucketStart"] in by]
    if not measured:
        return None
    return {"x": [a["bucketStart"] for a in axis], "series": series, "first": measured[0], "last": measured[-1]}


def share_deltas(trend: Any) -> dict:
    """Share Δ (pp, last two axis slots) per series brand. 당사 = sum of tracked (TS Map → dict, same key order)."""
    out: dict = {}
    if not trend:
        return out
    axis = _mv().trend_axis(trend["buckets"], trend["unit"], trend)
    by = {b["bucketStart"]: b for b in trend["buckets"]}

    def spark_of(pick) -> list:
        res = []
        for a in axis:
            b = by.get(a["bucketStart"]) if a["measured"] else None
            res.append(pick(b) if b else None)
        return res

    for s in trend["brands"]:
        def pick(b, name=s["brand"]):
            hit = next((x for x in b["brands"] if x["brand"] == name), None)
            return hit.get("sharePct") if hit and hit.get("sharePct") is not None else None
        out[s["brand"]] = _last_two(spark_of(pick), delta_pp)
    if any(b.get("isTracked") for b in trend["brands"]):
        out[OWN_KEY] = _last_two(spark_of(lambda b: round1(_js_sum((x.get("sharePct") if x.get("sharePct") is not None else 0)
                                                                   for x in b["brands"] if x.get("isTracked")))), delta_pp)
    return out


def period_share_deltas(brands: list[dict], prev_brands: list[dict]) -> dict:
    """Period mode: share Δ (pp) of each brand row vs the period before (brands without a value then: none)."""
    out: dict = {}
    for b in brands:
        prev = _prev_value(prev_brands, b["brand"], "shareOfVoice")
        cur = competitor_value_of(b, "shareOfVoice")
        if prev is not None and cur is not None:
            out[b["brand"]] = delta_pp(cur, prev)
    return out


def _group_of(key: str, members: list[dict], total: float) -> dict:
    sorted_m = _sort(list(members), lambda a, b: _sign(b["value"] - a["value"]))
    value = _js_sum(m["value"] for m in sorted_m)
    with_d = [m for m in sorted_m if m["delta"] is not None]
    return {
        "key": key,
        "members": sorted_m,
        "value": value,
        "share": round1((100 * value) / total),
        "delta": round1(_js_sum(m["delta"] for m in with_d)) if with_d else None,
        "partial": 0 < len(with_d) < len(sorted_m),
        "own": any(m["own"] for m in sorted_m),
    }


def treemap_groups(rows: list[dict], total: float) -> list[dict]:
    """Top brands → parent groups; a group's share is of every mention (`total`, the brands' share base — 2026-10-29
    metric review R6: it divided by the shown brands'); groups under 1.5 % (or past the 14th) fold into one block;
    the group holding 당사 always stays. The '자동차 외' group (`NON_AUTO_GROUP`) follows the same rule: it folded
    always, whatever its share (renewal audit 8-2: a display grouping, not a reason to hide)."""
    by: dict[str, list[dict]] = {}
    for r in rows:
        by.setdefault(parent_group_of(r["brand"]), []).append(r)
    total = total or 1
    groups = _sort([_group_of(k, m, total) for k, m in by.items()], lambda a, b: _sign(b["value"] - a["value"]))
    keep_idx = [i for i, g in enumerate(groups) if g["own"] or (i < FOLD_AFTER and g["share"] >= FOLD_SHARE)]
    keep = [groups[i] for i in keep_idx]
    rest = [g for i, g in enumerate(groups) if i not in set(keep_idx)]
    if rest:
        return [*keep, _group_of(TREEMAP_FOLD, [m for g in rest for m in g["members"]], total)]
    return keep


# ── 이번 회차 요약: rules over the numbers on the page ─────────────────────────


def _standing_finding(ex: Any) -> dict | None:
    if not ex:
        return None
    rows = ex["rows"]
    own_i = next((i for i, r in enumerate(rows) if r["own"]), None)
    if own_i is None or rows[own_i]["pct"] is None:
        return None
    own = rows[own_i]
    rank = own_i + 1
    rival = (rows[1] if len(rows) > 1 else None) if rank == 1 else rows[0]
    if not rival or rival["pct"] is None:
        return None
    gap = delta1(own["pct"], rival["pct"])
    move = delta1(own["delta"], rival["delta"]) if own["delta"] is not None and rival["delta"] is not None else None
    lead = rank == 1
    params: dict = {"rank": rank, "rival": rival["key"], "gap": abs(gap), "own": own["pct"]}
    if move is not None:
        params["move"] = abs(move)
        params["widened"] = "true" if lead == (move > 0) else "false"
    kind = "standingLead" if lead else "standingTrail"
    return {"kind": kind, "tone": "good" if lead else "warn", "pri": FINDING_ORDER[kind],
            "target": "sec-comp", "kpi": "exposure", "brand": rival["key"], "params": params}


def _type_finding(types_rows: Any) -> dict | None:
    types = [t for t in (types_rows or []) if t["gap"] is not None]
    if not types:
        return None
    # the type of the smallest gap (the largest trail, else the smallest lead): magnitude only, no type preferred
    pick = _sort(list(types), lambda a, b: _sign(a["gap"] - b["gap"]))[0]
    trail = pick["gap"] < 0
    kind = "typeTrail" if trail else "typeLead"
    out = {"kind": kind, "tone": "warn" if trail else "good", "pri": FINDING_ORDER[kind], "target": "sec-mix", "kpi": "exposure"}
    ref_brand = pick["ref"]["brand"]
    if _truthy(ref_brand):
        out["brand"] = ref_brand
    out["params"] = {"type": pick["type"], "ref": ref_brand if ref_brand is not None else "", "gap": abs(pick["gap"]),
                     "own": pick["own"] if pick["own"] is not None else 0}
    return out


def _mover_finding(sov: Any) -> dict | None:
    rows = (sov or {}).get("rows") or [] if sov else []
    # the largest exact move (two moves both shown as 0.3 are told apart by their exact values)
    movers = _sort([r for r in rows if not r["own"] and r["delta"] is not None],
                   lambda a, b: _sign(abs(exact(b["delta"])) - abs(exact(a["delta"]))))
    if not movers:
        return None
    m = movers[0]
    own_sov = next((r for r in rows if r["own"]), None)
    own_delta = own_sov["delta"] if own_sov and own_sov["delta"] is not None else ""
    return {"kind": "mover", "tone": "info", "pri": FINDING_ORDER["mover"], "target": "sec-brands",
            "brand": m["key"], "params": {"brand": m["key"], "delta": m["delta"], "own": own_delta}}


def _engine_finding(engines: Any) -> dict | None:
    eg = _sort([r for r in (engines or []) if r["gap"] is not None], lambda a, b: _sign(a["gap"] - b["gap"]))
    if not eg:
        return None
    nxt = eg[1] if len(eg) > 1 else None
    return {"kind": "engine", "tone": "warn" if eg[0]["gap"] < 0 else "good", "pri": FINDING_ORDER["engine"], "target": "sec-mix",
            "kpi": "exposure", "params": {"engine": eg[0]["engine"], "gap": eg[0]["gap"], "next": nxt["engine"] if nxt else "",
                                          "nextGap": nxt["gap"] if nxt and nxt["gap"] is not None else ""}}


def _climb_finding(bump: Any) -> dict | None:
    if not bump or not bump["last"] > bump["first"]:
        return None
    first, last = bump["first"], bump["last"]
    cands = [{"key": s["key"], "r0": s["ranks"][first], "r1": s["ranks"][last]} for s in bump["series"]
             if not s["own"] and s["ranks"][first] is not None and s["ranks"][last] is not None]
    cands = _sort(cands, lambda a, b: _sign(b["r0"] - b["r1"] - (a["r0"] - a["r1"])))
    climb = cands[0] if cands else None
    if not climb or not climb["r0"] > climb["r1"]:
        return None
    return {"kind": "climb", "tone": "info", "pri": FINDING_ORDER["climb"], "target": "sec-brands", "brand": climb["key"],
            "params": {"brand": climb["key"], "from": climb["r0"], "to": climb["r1"], "weeks": last - first + 1}}


def _negative_finding(favor: Any) -> dict | None:
    if not favor or favor["negativePct"] is None:
        return None
    v = favor["negativeDelta"]["value"]
    if v is None:
        return None
    return {"kind": "negative", "tone": "warn" if v > 0 else "good" if v < 0 else "info", "pri": FINDING_ORDER["negative"],
            "target": "sec-overview", "kpi": "favorability",
            "params": {"pct": favor["negativePct"], "delta": v}}


def _top_findings(items: list[dict]) -> list[dict]:
    return _sort(items, lambda a, b: _sign(b["pri"] - a["pri"]))[:4]


def findings(f: dict) -> list[dict]:
    """The summary findings: at most four, in FINDING_ORDER (mention-model findings)."""
    items = [x for x in (_standing_finding(f.get("exposure")), _type_finding(f.get("types")), _mover_finding(f.get("sov")),
                         _engine_finding(f.get("engines")), _climb_finding(f.get("bump")), _negative_finding(f.get("favor"))) if x]
    return _top_findings(items)


# ── compare picks: covered competitors and their subsets ───────────────────────


def covered_brands(brands: list[dict], trend: Any) -> list[str]:
    """useCompare: covered competitors in share-of-voice order (body snapshot), then the other
    series competitors in series order."""
    series: list[str] = []
    for b in ((trend or {}).get("brands") or []) if trend else []:
        if not b.get("isTracked") and b["brand"] not in series:
            series.append(b["brand"])
    pool = [b for b in brands if not b.get("isTracked") and b["brand"] in series]
    covered = [b["brand"] for b in _sort(pool, lambda a, b: _sign(b["share"] - a["share"]))]
    for b in series:
        if b not in covered:
            covered.append(b)
    return covered


def compare_subsets(covered: list[str]) -> list[tuple[str, list[str]]]:
    """Every pick of up to three covered brands: (key, the brands in covered order). The key is the
    bit mask of their covered positions (Next builds it from the picked brands)."""
    out = []
    for size in range(COMPARE_MAX + 1):
        for idx in combinations(range(len(covered)), size):
            out.append((str(sum(1 << i for i in idx)), [covered[i] for i in idx]))
    return out


def ref_candidates(row: dict) -> list[str]:
    """The compare brands tied at the leading value of a type row ([] = the competitor average)."""
    valued = [d for d in row["dots"] if d["value"] is not None]
    if not valued:
        return []
    top = row["ref"]["value"]
    return [d["brand"] for d in valued if d["value"] == top]


# CORE-GAP: kpi-view.ts rankAxisTicks (not in bff.screens.mention_view); the rank chart's y ticks.
def rank_axis_ticks(y_max: float) -> list[int]:
    """Always 1; up to 10 every integer, above that 1 + multiples of 5·10·20·50… (at most 8 ticks)."""
    top = math.floor(y_max) if isinstance(y_max, (int, float)) and math.isfinite(y_max) else 1
    if top <= 1:
        return [1]
    if top <= 10:
        return list(range(1, top + 1))
    max_ticks = 8
    step, mag = 5, 1
    while 1 + top // step > max_ticks:
        if step == 5 * mag:
            step = 10 * mag
        elif step == 10 * mag:
            step = 20 * mag
        else:
            mag *= 10
            step = 5 * mag
    ticks = [1]
    v = step
    while v <= top:
        ticks.append(v)
        v += step
    return ticks


def type_dots_top(rows: list[dict]) -> int:
    """TypeDots axis top: max(10, ceil(max value × 1.1 / 10) × 10)."""
    vals = [v for r in rows for v in [r["own"], r["avg"], *[d["value"] for d in r["dots"]]] if v is not None]
    m = 0
    for v in vals:
        if v > m:
            m = v
    return max(10, math.ceil((m * 1.1) / 10) * 10)


# ══ section payloads (pure: loaded reads in, what the section renders out) ═══════


def own_label_of(filters: dict) -> str:
    """당사 label: the applied brands without the HMG umbrella, else "HMG"."""
    own = [b for b in filters.get("brand") or [] if b != "HMG"]
    return ", ".join(own) if own else "HMG"


def period_of(filters: dict) -> dict | None:
    """dateFrom..dateTo when a period is set (cumulative), None = latest round snapshot."""
    if not filters.get("dateFrom") and not filters.get("dateTo"):
        return None
    return {"from": filters.get("dateFrom"), "to": filters.get("dateTo")}


def per_answer_line(period: Any, filters: dict, today: str | None) -> dict | None:
    """The calendar-month line of the original KPI body (kpi-period monthLine) with the one compare metric no tab
    shows: 답변당 언급 수 (renewal audit 5-2; the renewal Citation's month line keeps its per-answer metric the same
    way). The reader answers it when asked (audit U10). A window, a week or no period: no line."""
    shape = (period or {}).get("shape") if isinstance(period, dict) else None
    compare = period.get("compare") if isinstance(period, dict) else None
    if not shape or not shape.get("months") or compare is None:
        return None
    results = [r for r in compare if r.get("metric") == "mentionsPerAnswer"]
    if not results:
        return None
    cur_lo = ((shape.get("weeks") or {}).get("cur") or {}).get("lo") or ((shape.get("months") or {}).get("cur") or {}).get("lo") \
        or filters.get("dateFrom")
    vctx: dict = {"days": shape.get("days") if shape.get("days") is not None else 0, "kind": shape["kind"],
                  "todayKst": today or kst_today()}
    if cur_lo is not None:
        vctx["curLo"] = cur_lo
    return to_period_delta_view(results, vctx)


def page_payload(filters: dict) -> dict:
    return {"ownLabel": own_label_of(filters), "period": period_of(filters)}


def tab_value_payload(kpi: str, sub: Any = None, fp: Any = None) -> dict:
    """TabValue: the hero value of one KPI from its own read only."""
    if kpi == "first-rank":
        return {"value": rank_hero(_mv().overlay_first_position_values(fp, None), None)["avgPosition"]}
    if kpi == "favorability":
        return {"value": favor_hero(sub, None, None, None)["positivePct"]}
    return {"value": rate_hero(kpi, sub, None, None, None)["pct"]}


def tab_deltas_payload(period: Any, engine: Any, subs: dict, prevs: dict, fp: Any) -> dict:
    """TabDelta of every tab: the same Δ (value + basis) the tab's hero shows."""
    return {
        "exposure": rate_hero("exposure", subs["exposure"], prevs["exposure"], engine, period)["delta"],
        "sov": rate_hero("sov", subs["sov"], prevs["sov"], engine, period)["delta"],
        "favorability": favor_hero(subs["favorability"], prevs["favorability"], engine, period)["positiveDelta"],
        "first-rank": rank_hero(_mv().overlay_first_position_values(fp, None), period)["delta"],
    }


def _drawer_row(row: dict, rank: int, types: Any) -> dict:
    sent = row.get("sentiment")
    total = _js_sum(sent[k] for k in SENTIMENT_KEYS) if sent else 0
    return {
        "brand": row["brand"],
        "rank": rank,
        "isTracked": row["isTracked"],
        "own": {"code": row.get("ownBrandCode")} if row["isTracked"] else None,
        "sibling": is_hmg_sibling(row.get("hmgOwn"), bool(row["isTracked"])),
        "mentions": row["mentions"],
        "share": row["share"],
        "avgPosition": row["avgPosition"],
        "mentionRate": row["mentionRate"],
        "sentiment": sent if sent and total > 0 else None,
        "sentimentPct": {k: (100 * sent[k]) / total for k in SENTIMENT_KEYS} if sent and total > 0 else None,
        "types": types,
    }


def shell_payload(data: Any, degraded: bool, types_by_brand: Any) -> dict:
    """MentionShell (page state) + the brand drawer's rows (first row of a name) of the first BRANDS_TOP body
    brands: every body brand made the shell 0.3-0.6 MB, and the whole body waits on it. The drawer opens from those
    rows (the treemap, the boards); a ranking row past them carries its own drawer row (ranking_payload)."""
    measured = bool(data) and len(data["brands"]) > 0
    if not measured:
        return {"measured": False, "degraded": bool(degraded), "ownBrands": [], "drawer": []}
    brands = data["brands"]
    tb_by: dict = {}
    if types_by_brand:
        for b in types_by_brand.get("brands") or []:
            tb_by.setdefault(b["brand"], b["types"])  # brands.find(): a repeated name keeps the first row
    seen: set[str] = set()
    drawer = []
    for i, row in enumerate(brands[:BRANDS_TOP]):
        if row["brand"] in seen:
            continue
        seen.add(row["brand"])
        drawer.append(_drawer_row(row, i + 1, tb_by.get(row["brand"])))
    return {"measured": True, "degraded": bool(degraded), "ownBrands": [b["brand"] for b in brands if b["isTracked"]], "drawer": drawer}


def compare_payload(brands: list[dict], trend: Any) -> dict:
    return {"covered": covered_brands(brands, trend)}


def _type_finding_ref_free(tf: dict, rows: list[dict]) -> dict:
    """A type finding without its pick-order dependent brand: the tied candidates instead."""
    row = next(r for r in rows if r["type"] == tf["params"]["type"])
    out = {k: v for k, v in tf.items() if k not in ("brand", "params")}
    out["params"] = {k: v for k, v in tf["params"].items() if k != "ref"}
    out["refCands"] = ref_candidates(row)
    return out


def summary_payload(period: Any, subs: dict, prevs: dict, engine: Any, trend: Any, types_by_brand: Any, fp: Any,
                    brands: list[dict], prev_brands: list[dict] | None = None,
                    prev_engines: dict | None = None) -> dict:
    """이번 회차 요약: headline values + the findings for every compare pick.

    `fixed` = the findings that do not depend on the pick (standing, mover, engine, climb,
    negative; insertion order). Per pick: `type` = index into `typeFindings` (or None) and
    `order` = the four shown, highest priority first (-1 = the type finding)."""
    hero_e = rate_hero("exposure", subs["exposure"], prevs["exposure"], engine, period)
    hero_s = rate_hero("sov", subs["sov"], prevs["sov"], engine, period)
    ex = board({"metric": "exposure", "brands": brands, "trend": trend, "values": None, "hero": hero_e, "prevBrands": prev_brands})
    sov = board({"metric": "sov", "brands": brands, "trend": trend, "values": None, "hero": hero_s, "prevBrands": prev_brands})
    favor = favor_hero(subs["favorability"], prevs["favorability"], engine, period)
    rank = rank_hero(_mv().overlay_first_position_values(fp, None), period)
    standing = _standing_finding(ex)
    rest = [f for f in (_mover_finding(sov), _engine_finding(engine_rows(engine, "exposure", prev_engines)["rows"]),
                        _climb_finding(bump_data(trend)), _negative_finding(favor)) if f]
    fixed = ([standing] if standing else []) + rest
    covered = covered_brands(brands, trend)
    type_findings: list[dict] = []
    seen: dict[str, int] = {}
    options: dict[str, dict] = {}
    type_base = type_compare_base(types_by_brand, brands) if types_by_brand else None
    for key, pick in compare_subsets(covered):
        rows = type_compare_rows({"typesByBrand": types_by_brand, "brands": brands, "compare": pick}, type_base)
        tf = _type_finding(rows)
        ids: list[tuple[int, dict]] = [(0, standing)] if standing else []
        if tf:
            ids.append((-1, tf))
        base = len(ids) - (1 if tf else 0)
        ids += [(base + j, f) for j, f in enumerate(rest)]
        top = _top_findings_ids(ids)
        t_idx = None
        if tf:
            enc = _type_finding_ref_free(tf, rows)
            sig = json.dumps(enc, sort_keys=True, ensure_ascii=False)
            if sig not in seen:
                seen[sig] = len(type_findings)
                type_findings.append(enc)
            t_idx = seen[sig]
        options[key] = {"type": t_idx, "order": top}
    as_of = None
    for p in hero_e["points"]:
        if p["pct"] is not None:
            as_of = p["key"]
    return {
        "asOf": as_of,
        "exp": {"rank": ex["ownRank"], "pct": hero_e["pct"], "delta": hero_e["delta"]["value"]},
        "sov": {"rank": sov["ownRank"], "pct": hero_s["pct"], "delta": hero_s["delta"]["value"]},
        "fav": favor["positivePct"],
        "pos": rank["avgPosition"],
        "covered": covered,
        "fixed": fixed,
        "typeFindings": type_findings,
        "options": options,
    }


def _top_findings_ids(ids: list[tuple[int, dict]]) -> list[int]:
    return [i for i, _ in _sort(ids, lambda a, b: _sign(b[1]["pri"] - a[1]["pri"]))[:4]]


def _parts(value: Any, *parts: Any) -> list:
    """A hero's parts (numerator, denominator, counts) only next to its value: without one (the read failed or was
    suppressed, or 당사 has no rank) they are unknown, not 0 — the page showed "—%" over "0 / 0" (2026-10-29 metric
    review, Mention #69)."""
    return [None if value is None else p for p in parts]


def rate_value_payload(subs: dict, degraded: bool) -> dict:
    """HeroValue of the exposure and share tabs (+ the hero degrade mark)."""
    out: dict = {}
    for m in RATE_METRICS:
        h = rate_hero(m, subs[m], None, None, None)
        num, den = _parts(h["pct"], h["numerator"], h["denominator"])
        out[m] = {"pct": h["pct"], "numerator": num, "denominator": den}
    out["degraded"] = bool(degraded)
    return out


def _has_value(values: list) -> bool:
    return any(v is not None for v in values)


def _max_from_one(values) -> float:
    """Math.max(1, ...values)."""
    m = 1
    for v in values:
        if v > m:
            m = v
    return m


def rate_hero_payload(metric: str, sub: Any, prev: Any, engine: Any, period: Any, brands: list[dict], trend: Any,
                      prev_brands: list[dict] | None = None) -> dict:
    """HeroDelta · HeroStanding · HeroTrend · Board of one rate metric."""
    hero = rate_hero(metric, sub, prev, engine, period)
    b = board({"metric": metric, "brands": brands, "trend": trend, "values": None, "hero": hero, "prevBrands": prev_brands})
    rows = b["rows"]
    own_i = next((i for i, r in enumerate(rows) if r["own"]), None)
    standing = None
    if own_i is not None and rows[own_i]["pct"] is not None and b["ownRank"] is not None:
        own = rows[own_i]
        other = (rows[1] if len(rows) > 1 else None) if b["ownRank"] == 1 else rows[0]
        gap = delta1(own["pct"], other["pct"]) if other and other["pct"] is not None else None
        standing = {"n": len(rows), "rank": b["ownRank"], "other": other["key"] if other else None, "gap": gap}
    top_keys = {r["key"] for r in [r for r in rows if not r["own"]][:BOARD_TOP]}
    board_rows = [{**r, "pos": i + 1, "top": r["own"] or r["key"] in top_keys, "hasSpark": _has_value(r["spark"])}
                  for i, r in enumerate(rows)]
    base = hero_trend_series(hero, trend, metric, [])
    competitors = [x["brand"] for x in ((trend or {}).get("brands") or []) if not x.get("isTracked")] if trend else []
    uniq = list(dict.fromkeys(competitors))
    values = [hero_trend_series(hero, trend, metric, [c])["brands"][0]["values"] for c in uniq]
    # each round's numerator and denominator under 당사's rate (the original's tooltip), none without a rate
    counts = [_parts(p["pct"], p["numerator"], p["denominator"]) for p in hero["points"]]
    return {
        "delta": hero["delta"],
        "standing": standing,
        "trend": {"missing": hero["trendMissing"], "x": base["x"], "own": base["own"], "average": base["average"],
                  "ownNum": [c[0] for c in counts], "ownDen": [c[1] for c in counts],
                  "competitors": uniq, "values": values},
        "board": {"rows": board_rows, "axis": b["axis"], "measuredCycles": b["measuredCycles"],
                  "barMax": _max_from_one(r["pct"] if r["pct"] is not None else 0 for r in rows)},
    }


def rate_engines_payload(engine: Any, metric: str, prev_engines: dict | None = None) -> dict:
    e = engine_rows(engine, metric, prev_engines)
    return {"rows": [{**r, "hasSeries": _has_value(r["series"])} for r in e["rows"]], "x": e["x"], "trendMissing": e["trendMissing"]}


def _dot_cell(own: Any, value: Any) -> dict:
    both = own is not None and value is not None
    return {"value": value, "gap": delta_pp(own, value), "lo": min(own, value) if both else None, "hi": max(own, value) if both else None}


def rate_types_payload(types_by_brand: Any, brands: list[dict], kpi: Any, engine: Any, trend: Any, degraded: bool) -> dict:
    """멘션 유형 card: the compare view (per type, per covered brand and per pick) and the 당사 view
    of both metrics. `dots[i][t]` = covered[i] on TYPE_STRENGTH[t]; `avgRef[t]` = the competitor
    average as the reference; `options[pick].refs[t]` = the tied leading compare brands."""
    covered = covered_brands(brands, trend)
    type_base = type_compare_base(types_by_brand, brands) if types_by_brand else None
    base = type_compare_rows({"typesByBrand": types_by_brand, "brands": brands, "compare": covered}, type_base)
    cmp: dict = {"covered": covered, "rows": [], "avgRef": [], "dots": [], "options": {}}
    if base:
        cmp["rows"] = [{"type": r["type"], "own": r["own"], "avg": r["avg"]} for r in base]
        cmp["avgRef"] = [_dot_cell(r["own"], r["avg"]) for r in base]
        cmp["dots"] = [[_dot_cell(r["own"], r["dots"][i]["value"]) for r in base] for i in range(len(covered))]
        for key, pick in compare_subsets(covered):
            rows = type_compare_rows({"typesByBrand": types_by_brand, "brands": brands, "compare": pick}, type_base)
            cmp["options"][key] = {"refs": [ref_candidates(r) for r in rows], "top": type_dots_top(rows)}
    own: dict = {}
    for m in RATE_METRICS:
        rows = type_own_rows(kpi, engine, m)
        # each round's answers (the original type chart's bar) and each line's type answers in them, none without a rate
        x, rounds = _type_rounds(engine, m) if kpi else ([], [])
        counts = {r["type"]: [_parts(v, b["byType"][r["type"]] if b else None)[0] for v, b in zip(r["spark"], rounds)] for r in rows}
        own[m] = {"rows": [{**r, "hasSpark": _has_value(r["spark"]), "counts": counts[r["type"]]} for r in rows],
                  "maxPct": _max_from_one(r["pct"] if r["pct"] is not None else 0 for r in rows),
                  "maxCount": _max_from_one(r["signals"] for r in rows),
                  "x": x, "answers": [b["answers"] if b else None for b in rounds]}
    return {"degraded": bool(degraded), "cmp": cmp, "own": own}


def favor_hero_payload(sub: Any, prev: Any, engine: Any, period: Any, degraded: bool) -> dict:
    h = favor_hero(sub, prev, engine, period)
    positive, total = _parts(h["positivePct"], h["positive"], h["total"])
    # each round's positive and all signals under its rates (the original's tooltip), none without a rate
    rounds = _mv().favorability_trend_points(engine)
    points = [{**p, **dict(zip(("positiveCount", "total"), _parts(p["positive"], r.get("positive"), r.get("total"))))}
              for p, r in zip(h["points"], rounds)]
    return {**h, "positive": positive, "total": total, "points": points, "degraded": bool(degraded)}


def favor_dist_payload(totals: Any) -> dict:
    segs = favor_distribution(totals)
    return {"segments": segs, "total": _js_sum(s["count"] for s in segs)}


def favor_matrix_payload(kpi: Any, totals: Any = None) -> dict:
    return {"rows": favor_matrix(kpi, totals)}


def rank_payload(fp: Any, period: Any, brands: list[dict], trend: Any, degraded: bool, prev_brands: list[dict] | None = None) -> dict:
    """RankHeroCard + RankTable (useRank) and the rank chart's y top for every compare pick."""
    mv = _mv()
    overlaid = mv.overlay_first_position_values(fp, None)
    hero = rank_hero(overlaid, period)
    rb = rank_board(fp, None, hero, prev_brands, brands)
    rows = rb["rows"]
    pts = [r["avgPosition"] for r in rows if r["avgPosition"] is not None]
    covered = covered_brands(brands, trend)
    series = [rank_series_of(overlaid, b, hero["axis"]) for b in covered]
    own_vals = [v for v in hero["series"] if v is not None]
    options: dict[str, int] = {}
    ticks: dict[str, list] = {}
    for key, pick in compare_subsets(covered):
        observed = 0
        for b in pick:
            s = series[covered.index(b)]
            if _has_value(s):
                for v in s:
                    if v is not None and v > observed:
                        observed = v
        for v in own_vals:
            if v > observed:
                observed = v
        hi = max(5, math.ceil(observed))
        options[key] = hi
        if str(hi) not in ticks:
            ticks[str(hi)] = rank_axis_ticks(hi)
    ranked, ahead = _parts(hero["avgPosition"], hero["rankedAnswers"], rb["ahead"])
    return {
        "fp": fp is not None,
        "degraded": bool(degraded),
        "hero": {**hero, "rankedAnswers": ranked},
        "ahead": ahead,
        "rows": [{**r, "pos": i + 1, "hasSpark": _has_value(r["spark"])} for i, r in enumerate(rows)],
        "ownFirst": [i for i, r in enumerate(rows) if r["own"]] + [i for i, r in enumerate(rows) if not r["own"]],
        "barMax": _max_from_one(r["avgPosition"] if r["avgPosition"] is not None else 0 for r in rows),
        "track": {"lo": min(pts), "hi": max(pts)} if pts else None,
        "covered": covered,
        "series": series,
        "hasValue": [_has_value(s) for s in series],
        "options": options,
        "ticks": ticks,
    }


def bump_payload(trend: Any) -> dict:
    d = bump_data(trend)
    if not d:
        return {"trend": trend is not None, "data": None, "measured": 0, "maxShare": 1}
    measured = len([i for i in range(len(d["x"])) if any(s["mentions"][i] is not None for s in d["series"])])
    series = []
    for s in d["series"]:
        r0, r1 = s["ranks"][d["first"]], s["ranks"][d["last"]]
        series.append({**s, "move": r0 - r1 if r0 is not None and r1 is not None else None})
    return {"trend": trend is not None, "data": {**d, "series": series}, "measured": measured,
            "maxShare": _max_from_one(v for s in d["series"] for v in s["shares"] if v is not None)}


RANKING_SORT_KEYS = ("rank", "brand", "mentions", "share", "delta", "avgPosition", "prompts", "mentionRate")


def brand_row_values(row: dict, multi: bool, multi_total: float, total_answers: Any) -> dict:
    """prompt-rank.ts brandRowValues."""
    if not multi:
        return {"mentions": row["mentions"], "prompts": row["prompts"], "share": row["share"], "mentionRate": row["mentionRate"]}
    m = row.get("multi")
    if not m:
        return {"mentions": None, "prompts": None, "share": None, "mentionRate": None}
    return {
        "mentions": m["mentions"],
        "prompts": m["prompts"],
        "share": round1((100 * m["mentions"]) / multi_total) if multi_total > 0 else None,
        "mentionRate": round1((100 * m["answers"]) / total_answers) if total_answers is not None and total_answers > 0 else None,
    }


def _ranking_value(mode: str, key: str):
    if key == "rank":
        return lambda r: r["rank"]
    if key == "brand":
        return lambda r: r["brand"]
    if key == "avgPosition":
        return lambda r: r["avgPosition"]
    return lambda r: r[mode][key]


def ranking_payload(data: Any, trend: Any, prev_brands: list[dict] | None = None) -> dict:
    """브랜드 언급 순위: every body brand's row with both value sets (multi off / on), their sort orders and the
    treemap groups of both (the top BRANDS_TOP rows). The table shows BRANDS_TOP rows first, searches them all and
    shows more (renewal audit 6-1: it showed and searched the first 100 only; the original Global searched every brand
    and showed 100, the original website table every brand). A row past the shell's drawer rows (the first
    BRANDS_TOP, shell_payload) carries its own `drawer` row, so its drawer opens with its values."""
    brands = data["brands"] if data else []
    deltas = share_deltas(trend) if prev_brands is None else period_share_deltas(brands, prev_brands)
    multi_total = _js_sum((b["multi"]["mentions"] if b.get("multi") else 0) for b in brands)
    total_answers = (data.get("summary") or {}).get("totalAnswers") if data else None
    tb_by: dict = {}
    for b in ((data.get("typesByBrand") if data else None) or {}).get("brands") or []:
        tb_by.setdefault(b["brand"], b["types"])  # a repeated name keeps the first row, as the shell's drawer
    in_drawer = {row["brand"] for row in brands[:BRANDS_TOP]}
    rows = []
    for i, row in enumerate(brands):
        group = parent_group_of(row["brand"])
        out_row = {
            "brand": row["brand"], "rank": i + 1, "own": row["isTracked"], "sibling": is_hmg_sibling(row.get("hmgOwn"), row["isTracked"]),
            "avgPosition": row["avgPosition"], "group": group, "grouped": group != row["brand"], "hasMulti": _truthy(row.get("multi")),
            "off": {**brand_row_values(row, False, multi_total, total_answers), "delta": deltas.get(row["brand"]),
                    "covered": row["brand"] in deltas},
            "on": {**brand_row_values(row, True, multi_total, total_answers), "delta": None, "covered": False},
        }
        if row["brand"] not in in_drawer:
            in_drawer.add(row["brand"])
            out_row["drawer"] = _drawer_row(row, i + 1, tb_by.get(row["brand"]))
        rows.append(out_row)
    orders: dict = {}
    treemap: dict = {}
    for mode in ("off", "on"):
        orders[mode] = table_orders(rows, {k: _ranking_value(mode, k) for k in RANKING_SORT_KEYS})
        tm = [{"brand": r["brand"], "value": r[mode]["mentions"] if r[mode]["mentions"] is not None else 0,
               "share": r[mode]["share"] if r[mode]["share"] is not None else 0, "delta": r[mode]["delta"], "own": r["own"],
               "sibling": r["sibling"]}
              for r in rows[:BRANDS_TOP] if (r[mode]["mentions"] if r[mode]["mentions"] is not None else 0) > 0]
        treemap[mode] = treemap_groups(tm, multi_total if mode == "on" else (data.get("summary") or {}).get("total") if data else 0)
    out = {"rows": rows, "count": len(brands), "multiUnavailable": any(not r["hasMulti"] for r in rows), "orders": orders,
           "treemap": treemap}
    if data and data.get("brandsTotal") is not None:
        out["total"] = data["brandsTotal"]
    return out


# ══ screens ═════════════════════════════════════════════════════════════════════


def _begin(q) -> tuple[dict, Any, Any]:
    """Route context + the page's filters: global, or the website page's with ctx.surface=website (2026-10-30, the
    renewal Website Mention: site country, language, engine, period; brand for ctx.admin=true)."""
    c, sp = split_context(q)
    md = _md()
    md.begin_degrade_scope()
    filters, ctx = md.surface_filters(c, sp)
    # every section's body brand read asks for Gold's HMG flag (the 'HMG 계열' badge, renewal audit 8-1): still one read
    ctx["hmg"] = True
    return c, filters, ctx


async def _subs(md, filters, ctx, metrics=HERO_METRICS) -> dict:
    vals = await asyncio.gather(*(md.load_kpi_hero_sub_kpis(filters, ctx, m) for m in metrics))
    return dict(zip(metrics, vals))


async def _prevs(md, filters, ctx, metrics=HERO_METRICS) -> dict:
    vals = await asyncio.gather(*(md.load_kpi_hero_sub_kpis_prev(filters, ctx, m) for m in metrics))
    return dict(zip(metrics, vals))


async def _body_brands(md, filters, ctx) -> list[dict]:
    """The body aggregate's brand rows (the client's ctx.brands = loadMentionsLive().brands), without the
    aggregate's other reads."""
    return await md.load_mentions_brands(filters, ctx) or []


@screen("mention/rn-page")
async def rn_page(q) -> dict:
    """Header values: 당사 label and the selected period (URL → filters)."""
    _, filters, _ = _begin(q)
    return page_payload(filters)


@screen("mention/rn-asof")
async def rn_asof(q) -> dict:
    _, filters, ctx = _begin(q)
    return {"asOf": await _md().load_mentions_as_of(filters, ctx)}


@screen("mention/rn-tab-value")
async def rn_tab_value(q) -> dict:
    """One KPI tab's value (ctx.kpi = exposure | sov | favorability | first-rank)."""
    from fastapi import HTTPException
    c, filters, ctx = _begin(q)
    kpi = c.get("kpi")
    if kpi not in KPI_TABS:
        raise HTTPException(422, "ctx.kpi must be one of exposure, sov, favorability, first-rank")
    md = _md()
    if kpi == "first-rank":
        return tab_value_payload(kpi, fp=await md.load_first_position(filters, ctx, pin_top=True))
    return tab_value_payload(kpi, sub=await md.load_kpi_hero_sub_kpis(filters, ctx, kpi))


@screen("mention/rn-tab-deltas")
async def rn_tab_deltas(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    period, engine, subs, prevs, fp = await asyncio.gather(
        md.load_period_compare(filters, ctx), md.load_engine_kpi_trend(filters, ctx), _subs(md, filters, ctx),
        _prevs(md, filters, ctx), md.load_first_position(filters, ctx, pin_top=True))
    return tab_deltas_payload(period, engine, subs, prevs, fp)


@screen("mention/rn-shell")
async def rn_shell(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    # the brand rows only: the whole body waits on this section, and the aggregate's brand trend took twice as long
    brands, tb = await asyncio.gather(md.load_mentions_brands(filters, ctx), md.load_types_by_brand(filters, ctx))
    return shell_payload(None if brands is None else {"brands": brands}, md.mentions_degraded(ctx)["data"], tb)


@screen("mention/rn-compare")
async def rn_compare(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    brands, trend = await asyncio.gather(_body_brands(md, filters, ctx), md.load_brand_trend(filters, ctx, pin_top=True))
    return compare_payload(brands, trend)


@screen("mention/rn-summary")
async def rn_summary(q) -> dict:
    """이번 회차 요약 and, in a calendar month, the 답변당 언급 수 line under it (`ctx.today` pins the KST day of its
    month label, tests)."""
    c, filters, ctx = _begin(q)
    md = _md()
    period, subs, prevs, engine, trend, tb, fp, brands, prev_brands, prev_engines = await asyncio.gather(
        md.load_period_compare(filters, ctx), _subs(md, filters, ctx), _prevs(md, filters, ctx), md.load_engine_kpi_trend(filters, ctx),
        md.load_brand_trend(filters, ctx, pin_top=True), md.load_types_by_brand(filters, ctx), md.load_first_position(filters, ctx, pin_top=True),
        _body_brands(md, filters, ctx), md.load_prev_period_brands(filters, ctx), md.load_prev_period_engines(filters, ctx))
    return {**summary_payload(period, subs, prevs, engine, trend, tb, fp, brands, prev_brands, prev_engines),
            "monthLine": per_answer_line(period, filters, c.get("today"))}


@screen("mention/rn-rate-value")
async def rn_rate_value(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    t_exp = asyncio.ensure_future(md.load_kpi_hero_sub_kpis(filters, ctx, "exposure"))
    t_sov = asyncio.ensure_future(md.load_kpi_hero_sub_kpis(filters, ctx, "sov"))
    sub_e = await t_exp
    # the mark is read once the exposure hero read settled (page.tsx degraded.hero)
    degraded = md.was_kpi_tab_degraded("hero")
    return rate_value_payload({"exposure": sub_e, "sov": await t_sov}, degraded)


@screen("mention/rn-rate-hero")
async def rn_rate_hero(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    period, subs, prevs, engine, trend, brands, prev_brands = await asyncio.gather(
        md.load_period_compare(filters, ctx), _subs(md, filters, ctx, RATE_METRICS), _prevs(md, filters, ctx, RATE_METRICS),
        md.load_engine_kpi_trend(filters, ctx), md.load_brand_trend(filters, ctx, pin_top=True), _body_brands(md, filters, ctx),
        md.load_prev_period_brands(filters, ctx))
    return {m: rate_hero_payload(m, subs[m], prevs[m], engine, period, brands, trend, prev_brands) for m in RATE_METRICS}


@screen("mention/rn-rate-engines")
async def rn_rate_engines(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    engine, prev_engines = await asyncio.gather(md.load_engine_kpi_trend(filters, ctx), md.load_prev_period_engines(filters, ctx))
    return {m: rate_engines_payload(engine, m, prev_engines) for m in RATE_METRICS}


@screen("mention/rn-rate-types")
async def rn_rate_types(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    t_kpi = asyncio.ensure_future(md.load_type_kpi(filters, ctx))
    rest = asyncio.ensure_future(asyncio.gather(md.load_types_by_brand(filters, ctx), _body_brands(md, filters, ctx),
                                                md.load_engine_kpi_trend(filters, ctx), md.load_brand_trend(filters, ctx, pin_top=True)))
    kpi = await t_kpi
    # page.tsx degraded.types: the mark once the type read settled
    degraded = md.was_kpi_tab_degraded("types")
    tb, brands, engine, trend = await rest
    return rate_types_payload(tb, brands, kpi, engine, trend, degraded)


@screen("mention/rn-favor-hero")
async def rn_favor_hero(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    t_exp = asyncio.ensure_future(md.load_kpi_hero_sub_kpis(filters, ctx, "exposure"))
    rest = asyncio.ensure_future(asyncio.gather(
        md.load_kpi_hero_sub_kpis(filters, ctx, "favorability"), md.load_kpi_hero_sub_kpis_prev(filters, ctx, "favorability"),
        md.load_engine_kpi_trend(filters, ctx), md.load_period_compare(filters, ctx)))
    await t_exp
    degraded = md.was_kpi_tab_degraded("hero")
    sub, prev, engine, period = await rest
    return favor_hero_payload(sub, prev, engine, period, degraded)


@screen("mention/rn-favor-dist")
async def rn_favor_dist(q) -> dict:
    _, filters, ctx = _begin(q)
    return favor_dist_payload(await _md().load_sentiment_totals(filters, ctx))


@screen("mention/rn-favor-matrix")
async def rn_favor_matrix(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    kpi, totals = await asyncio.gather(md.load_type_kpi(filters, ctx), md.load_sentiment_totals(filters, ctx))
    return favor_matrix_payload(kpi, totals)


@screen("mention/rn-rank")
async def rn_rank(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    t_fp = asyncio.ensure_future(md.load_first_position(filters, ctx, pin_top=True))
    rest = asyncio.ensure_future(asyncio.gather(md.load_period_compare(filters, ctx), _body_brands(md, filters, ctx),
                                                md.load_brand_trend(filters, ctx, pin_top=True), md.load_prev_period_brands(filters, ctx)))
    fp = await t_fp
    degraded = md.was_first_position_hero_degraded()
    period, brands, trend, prev_brands = await rest
    return rank_payload(fp, period, brands, trend, degraded, prev_brands)


@screen("mention/rn-bump")
async def rn_bump(q) -> dict:
    _, filters, ctx = _begin(q)
    return bump_payload(await _md().load_brand_trend(filters, ctx, pin_top=True))


@screen("mention/rn-ranking")
async def rn_ranking(q) -> dict:
    _, filters, ctx = _begin(q)
    md = _md()
    data, trend, prev_brands = await asyncio.gather(md.load_mentions_live(filters, ctx, pin_top=True), md.load_brand_trend(filters, ctx, pin_top=True),
                                                    md.load_prev_period_brands(filters, ctx))
    return ranking_payload(data, trend, prev_brands)
