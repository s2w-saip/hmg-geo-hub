"""ACR screens (AI 최종 추천 선택률): /standard/ai-funnel/acr, the Gold ACR view of the website and
project pages (components/gold-acr.tsx) and the renewal ACR page.

Ports, with the front's rules unchanged:
- lib/hgh/adapters/funnel.ts toStandardAcr (A1..A7) and loadAcrScreen
- (dash)/standard/ai-funnel/_data/acr-card.ts acrCardRow and the AcrLiveView computations
  (acr-live-view.tsx: language axis rule, trend rows, brand colours, table orders, battle pivot and
  top 30, territory legend and per-row choice counts)
- (renewal)/renewal/standard/ai-funnel/acr: acr-model.ts acrView / acrFindings / sortBrandRows,
  the derived values of acr-body.tsx and acr-detail.tsx
  (gap, standing count, board orders and bar scale, map dots, battle views, engine segments
  base, model orders and scale, distribution sheets: own picks, orders, present brands, CSV pivot)
  and the page-level period / filtered / 당사 label.

JS semantics kept on purpose: `null + n` is n (null choice / valid_acr count as 0), `x || 1`
guards, Object.keys order for brand keys (array-index names first), the territory's first entry is
its dominant brand in API order, float sums in array order (no compensated summation).
Findings are codes + params only; the front turns them into text."""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import HTTPException

from bff import api
from bff.access import reader_scope
from bff.screens import screen, split_context
from bff.screens._convert import as_of_date, delta1, exact, filter_notices, pct1_or_null, whole_suppression
from bff.screens._filters import load_filter_dates, load_panel_options, read_standard_filters
from bff.screens._js import is_num, js_str
from bff.screens._query import UMBRELLA_BRAND, analysis_query, to_api_params
from bff.screens._sort import locale_compare, sort_by, table_orders
from bff.screens.sources import source_query

# ── JS helpers ───────────────────────────────────────────────────────────────


def _n(v: Any) -> Any:
    """A JSON value in JS arithmetic: null -> 0 (`s + null === s`)."""
    return 0 if v is None else v


def _key(v: Any) -> str:
    """A value used as a JS object key (String(v))."""
    if v is None:
        return "null"
    return v if isinstance(v, str) else js_str(v)


_MAX_INDEX = 2 ** 32 - 1


def _is_index(k: str) -> bool:
    return k.isascii() and k.isdigit() and (k == "0" or k[0] != "0") and int(k) < _MAX_INDEX


def js_keys(obj: dict) -> list[str]:
    """Object.keys order: array-index names ascending, then the other names in insertion order."""
    keys = list(obj)
    return sorted((k for k in keys if _is_index(k)), key=int) + [k for k in keys if not _is_index(k)]


def _sum(values) -> float:
    """reduce((s, v) => s + v, 0) — left to right, like the front (Python 3.12 sum() compensates)."""
    s = 0
    for v in values:
        s = s + v
    return s


def _cmp_num(d: float) -> int:
    return (d > 0) - (d < 0)


# ── AcrData -> StandardAcr (funnel.ts toStandardAcr, rules A1..A7) ───────────

def _empty_acr() -> dict:
    return {"measured": False, "brands": [], "trend": [], "battle": [], "modelConversion": [], "territory": [],
            "totals": {"promptRuns": 0, "prompts": 0, "iterations": 0, "engines": []}}


def _nn(v: Any) -> Any:
    """`v ?? null`."""
    return None if v is None else v


def _hmg(row: dict, src: dict) -> dict:
    """The row with Gold's HMG flag (`isHmg`) when the reader sent it (`is_hmg`, 2026-10-31 renewal audit 11-2)."""
    if "is_hmg" in src:
        row["isHmg"] = bool(src["is_hmg"])
    return row


def to_standard_acr(d: dict, meta: Any) -> dict:
    totals = d["totals"]
    runs = totals.get("prompt_runs")
    if not (is_num(runs) and runs > 0) or whole_suppression(meta):
        return _empty_acr()
    out: dict[str, Any] = {
        "measured": True,
        "brands": [_hmg({"brand": b["brand"], "isOurs": b["is_ours"], "choiceCount": b["choice"], "appearanceCount": b["appearance"],
                         "choiceShare": pct1_or_null(b.get("choice_share")), "coverage": pct1_or_null(b.get("coverage"))}, b)
                   for b in d["brands"]],
    }
    own = d.get("own")
    if isinstance(own, dict):
        out["own"] = {"choiceCount": own.get("choice"), "appearanceCount": own.get("appearance"),
                      "choiceShare": pct1_or_null(own.get("choice_share")), "coverage": pct1_or_null(own.get("coverage"))}
        # 당사 = every own brand of the total and its standing among the chosen brands (the reader's, beyond the table)
        out["ownBrands"] = list(own["brands"])
        out["ownStanding"] = {"rank": own["rank"], "of": own["ranked_brands"]}
    trend = []
    for b in d["trend"]["buckets"]:
        if b.get("gap") or not (is_num(b.get("den")) and b["den"] > 0):
            continue
        series: dict[str, Any] = {}
        for p in b["series"]:
            series[_key(p["brand"])] = pct1_or_null({"num": p["num"], "den": b["den"]})
        trend.append({"date": b["round_date"], "series": series, "own": pct1_or_null({"num": b["own"], "den": b["den"]})})
    out["trend"] = sort_by(trend, lambda a, b: locale_compare(a["date"], b["date"]))
    out["battle"] = [{"promptId": r["prompt_id"], "promptText": _nn(r.get("prompt_text")),
                      "cells": [{"engine": c["engine"], "winner": _nn(c.get("winner_brand")), "winnerIsOurs": c["winner_is_ours"],
                                 "choiceCount": c["choice"]} for c in r["cells"]]}
                     for r in d["battle"]]
    out["modelConversion"] = [_hmg({"brand": _nn(m.get("brand")), "model": m["model"], "isOurs": m["is_ours"],
                                    "conversionRate": pct1_or_null(m.get("conversion")), "shortlistCount": m["cells"], "top1Count": m["top1"]}, m)
                              for m in d["model_conversion"]]
    out["territory"] = [_territory_sheet(s) for s in d["territory"]]
    h = d.get("head_to_head")
    out["headToHead"] = None if h is None else {
        "sample": {"iterations": h["sample"]["iterations"], "cells": h["sample"]["cells"]},
        "rows": [_hmg({"engine": r["engine"], "brand": r["brand"], "iterations": r["iterations"], "ownWins": r["own_wins"],
                       "rivalWins": r["rival_wins"]}, r) for r in h["rows"]]}
    out["totals"] = {"promptRuns": totals["prompt_runs"], "prompts": totals["prompts"], "iterations": totals["iterations"],
                     "engines": list(totals["engines"])}
    return out


def _territory_sheet(s: dict) -> dict:
    """An AcrTerritorySheet of funnel/acr or funnel/acr/territory (rowCount: its rows, sent or not)."""
    return {"region": _nn(s.get("country")), "engine": s["engine"], "rowCount": s["row_count"], "states": dict(s["states"]),
            "rows": [{"promptId": r["prompt_id"], "promptText": _nn(r.get("prompt_text")), "validAcr": r["valid_acr"], "cells": r["cells"],
                      "entries": [{"brand": e["brand"], "choice": e["choice"], "appearance": e["appearance"], "isOurs": e["is_ours"]}
                                  for e in r["entries"]]}
                     for r in s["rows"]]}


async def load_acr_screen(filters: dict, ctx: dict, territory_rows: str = "all", duels: bool = False) -> dict:
    """loadAcrScreen: GET /v1/funnel/acr with the screen's filters (analysisQuery) and the B097 flags. The renewal
    page asks for the first sheet's rows only (territory_rows=first; acr/renewal-sheet reads the others) and for the
    head-to-head (include_head_to_head). `asOf` is the read's round (meta.as_of: the snapshot's, a period's last)."""
    flags: dict[str, Any] = {"include_option_countries": False, "include_catalog_count": False}
    if territory_rows != "all":
        flags["territory_rows"] = territory_rows
    if duels:
        flags["include_head_to_head"] = True
    params = to_api_params(analysis_query(filters, ctx), flags)
    res = await api.get("funnel/acr", params)
    data, meta = res["data"], res.get("meta")
    count = data["totals"].get("catalog_acr_prompts")
    return {"data": to_standard_acr(data, meta), "acrPromptCount": 0 if count is None else count,
            "languageOptions": list((data.get("options") or {}).get("langs") or []), "notices": filter_notices(meta),
            "asOf": as_of_date(meta)}


# ── panel props ──────────────────────────────────────────────────────────────

STANDARD_ACR_ONLY_GROUPS = ("geography", "language", "engine", "time", "brandPresence", "listType", "depth1", "depth2", "depth3")


def only_groups(language_options: list | None) -> list[str]:
    """acr-live-view.tsx acrOnlyGroups: the language axis only with measured ACR languages."""
    if language_options:
        return list(STANDARD_ACR_ONLY_GROUPS)
    return [g for g in STANDARD_ACR_ONLY_GROUPS if g != "language"]


def _put(out: dict, key: str, value: Any) -> None:
    if value is not None:
        out[key] = value


def _panel_props(options: dict, languages: list, dates: dict) -> dict:
    """The option props AcrDataApi / apiRead passed (catalog rows and countries from /v1/filters/options,
    languages from the ACR answer, the round calendar). A TS undefined stays absent."""
    out: dict[str, Any] = {}
    _put(out, "catalogRows", options.get("catalogRows"))
    _put(out, "geographyOptions", options.get("geographyOptions"))
    out["languageOptions"] = languages
    _put(out, "selectableDates", dates.get("selectableDates"))
    return out


async def _global_reads(filters: dict, territory_rows: str = "all", duels: bool = False) -> tuple[dict, dict, dict]:
    """AcrDataApi's three calls in parallel: ACR, filter options (no period), the round calendar."""
    return await asyncio.gather(
        load_acr_screen(filters, {"surface": "global", "scope": reader_scope()}, territory_rows, duels),
        load_panel_options({"surface": "global", "scope": reader_scope(), "filters": filters}),
        load_filter_dates("global", None, "all"),
    )


# ── AcrLiveView view model (standard page, Gold website/project view) ───────

BATTLE_VISIBLE = 30
INK_300 = "var(--color-ink-300)"
ACR_SERIES_FALLBACK = ("#4a6685", "#8a8f98", "#a36b4f", "#6b89b3", "#c4c9d4")
BATTLE_BRAND_COLORS = {"Hyundai": "#002c5f", "Kia": "#a36b4f", "Genesis": "#6b89b3", "Toyota": "#e63312",
                       "Tesla": "#00aad2", "BMW": "#1a4d8e", "Honda": "#8a8f98"}


def acr_card_row(data: dict) -> dict | None:
    """acr-card.ts: the viewpoint own total, else the first own brand row."""
    own = data.get("own")
    if own is not None:
        return own
    return next((b for b in data["brands"] if b["isOurs"]), None)


def trend_brands(data: dict) -> list[str]:
    """Every series brand, first appearance order (Object.keys per bucket)."""
    seen: dict[str, None] = {}
    for b in data["trend"]:
        for k in js_keys(b["series"]):
            seen[k] = None
    return list(seen)


def brand_colors(data: dict, series_brands: list[str]) -> dict:
    """One colour per brand: the brand table, the series, the territory entries (in that order);
    a brand without a fixed colour takes the next fallback colour."""
    colors: dict[Any, str] = {}
    i = 0

    def assign(brand: Any) -> None:
        nonlocal i
        if brand in colors:
            return
        c = BATTLE_BRAND_COLORS.get(brand) if isinstance(brand, str) else None
        if c is None:
            c = ACR_SERIES_FALLBACK[i % len(ACR_SERIES_FALLBACK)]
            i += 1
        colors[brand] = c

    for b in data["brands"]:
        assign(b["brand"])
    for b in series_brands:
        assign(b)
    for s in data["territory"]:
        for row in s["rows"]:
            for e in row["entries"]:
                assign(e["brand"])
    return colors


def _label(row: dict) -> Any:
    """`promptText ?? promptId`."""
    return row["promptId"] if row.get("promptText") is None else row["promptText"]


def live_vm(data: dict, acr_prompt_count: Any) -> dict:
    """Everything AcrLiveView computed from StandardAcr + the waiting-state count."""
    series_brands = trend_brands(data)
    colors = brand_colors(data, series_brands)

    def color(b: Any) -> str:
        return colors.get(b, INK_300)

    ours = acr_card_row(data)
    brands = [{**b, "color": color(b["brand"])} for b in data["brands"]]
    trend_rows = []
    for b in data["trend"]:
        row = {"date": b["date"]}
        for k in js_keys(b["series"]):
            row[k] = b["series"][k]
        trend_rows.append(row)
    engines = data["totals"]["engines"]
    battle = []
    for r in data["battle"]:
        cells = []
        for m in engines:
            c = next((x for x in r["cells"] if x["engine"] == m), None)
            cells.append(None if c is None else {"winner": c["winner"], "winnerIsOurs": c["winnerIsOurs"]})
        battle.append({"promptId": r["promptId"], "label": _label(r), "cells": cells})
    territory = []
    for s in data["territory"]:
        counts: dict[Any, Any] = {}
        rows = []
        for row in s["rows"]:
            chosen = 0
            for e in row["entries"]:
                counts[e["brand"]] = _n(counts.get(e["brand"])) + _n(e["choice"])
                chosen = chosen + _n(e["choice"])
            dom = row["entries"][0] if row["entries"] else None
            rows.append({"promptId": row["promptId"], "label": _label(row),
                         "entries": [{"brand": e["brand"], "choice": e["choice"], "color": color(e["brand"])} for e in row["entries"]],
                         "noChoice": max(0, _n(row["validAcr"]) - chosen),
                         "dominant": None if dom is None else {"brand": dom["brand"], "choice": dom["choice"], "color": color(dom["brand"])}})
        legend = [b for b, _ in sort_by(list(counts.items()), lambda a, b: _cmp_num(b[1] - a[1]))]
        territory.append({"region": s["region"], "engine": s["engine"], "legend": [{"brand": b, "color": color(b)} for b in legend],
                          "rows": rows})
    models = data["modelConversion"]
    return {
        "measured": bool(data["measured"]),
        "acrPromptCount": acr_prompt_count,
        "brands": brands,
        "brandOrders": table_orders(data["brands"], {
            "brand": lambda r: r["brand"],
            "top1": lambda r: -1 if r["choiceShare"] is None else r["choiceShare"],
            "coverage": lambda r: -1 if r["coverage"] is None else r["coverage"],
            "choices": lambda r: r["choiceCount"],
            "appearances": lambda r: r["appearanceCount"],
        }),
        "kpi": {"top1": None if ours is None else ours.get("choiceShare"),
                "top5": None if ours is None else ours.get("coverage"),
                "rank1": 0 if ours is None or ours.get("choiceCount") is None else ours["choiceCount"]},
        "totals": data["totals"],
        "trendBrands": [{"brand": b, "color": color(b)} for b in series_brands],
        "trendRows": trend_rows,
        "battle": battle,
        "battleVisible": BATTLE_VISIBLE,
        "battleHidden": len(battle) - min(len(battle), BATTLE_VISIBLE),
        "models": models,
        "modelOrders": table_orders(models, {
            "brand": lambda r: "" if r["brand"] is None else r["brand"],
            "model": lambda r: r["model"],
            "conv": lambda r: -1 if r["conversionRate"] is None else r["conversionRate"],
            "shortlist": lambda r: r["shortlistCount"],
            "top1": lambda r: r["top1Count"],
        }),
        "territory": territory,
    }


@screen("acr/standard")
async def standard(q) -> dict:
    """/standard/ai-funnel/acr: {panel: DimensionFilterPanel option props + onlyGroups, view: AcrLiveVm}."""
    _, sp = split_context(q)
    filters = read_standard_filters(sp, reader_scope())
    acr, options, dates = await _global_reads(filters)
    panel = _panel_props(options, acr["languageOptions"], dates)
    panel["onlyGroups"] = only_groups(acr["languageOptions"])
    return {"panel": panel, "view": live_vm(acr["data"], acr["acrPromptCount"])}


@screen("acr/gold")
async def gold(q) -> dict:
    """The website / project ACR pages in local read-only mode (components/gold-acr.tsx): the URL params
    through sourceQuery (brandPresence / listType / depth axes are passed as is, the API ignores them),
    no filter options (no catalog axis), the catalog count only when the API sends it (null = 데이터 없음)."""
    ctx, sp = split_context(q)
    project_id = ctx.get("project_id")
    query = {**source_query(sp), "surface": "project" if project_id else "website"}
    if project_id:
        query["project_id"] = project_id
    data = (await api.get("funnel/acr", query))["data"]
    langs = list((data.get("options") or {}).get("langs") or [])
    count = data["totals"].get("catalog_acr_prompts")
    return {"panel": {"catalogRows": [], "languageOptions": langs, "onlyGroups": only_groups(langs)},
            "view": live_vm(to_standard_acr(data, {"suppressed": {}}), count)}


# ── renewal ACR (acr-model.ts + acr-body.tsx / acr-detail.tsx) ───────────────

ACR_AXES = ("brand", "geography", "language", "engine", "time", "brandPresence", "listType", "depth1", "depth2", "depth3")
DIST_VISIBLE = 20
CONVERSION_VISIBLE = 15
DUEL_ROWS = 12
STATES = ("pick", "listed", "absent")


def page_state(sp: dict, filters: dict) -> dict:
    """renewal acr/page.tsx: period (cumulative), any ACR filter in the URL, the 당사 label."""
    own = [b for b in (filters.get("brand") or []) if b != UMBRELLA_BRAND]
    return {"period": bool(filters.get("dateFrom") or filters.get("dateTo")),
            "dateFrom": filters.get("dateFrom"), "dateTo": filters.get("dateTo"),
            "filtered": any(sp.get(k) is not None and sp.get(k) != "" for k in ACR_AXES),
            "ownLabel": ", ".join(own) if own else UMBRELLA_BRAND}


def _last_two(vs: list) -> float | None:
    idx: list[int] = []
    i = len(vs) - 1
    while i >= 0 and len(idx) < 2:
        if vs[i] is not None:
            idx.append(i)
        i -= 1
    return delta1(vs[idx[0]], vs[idx[1]]) if len(idx) == 2 else None


def acr_view(data: dict, own: dict | None, round_buckets: bool, period: bool) -> dict:
    """acr-model.ts acrView (findings included). 당사 (its brands, trend and standing) is the reader's own total:
    every own brand, not the own brands among the top series (2026-10-29 metric review R1)."""
    own_brands = list(data.get("ownBrands") or [])
    series_keys = trend_brands(data)
    series_set = set(series_keys)
    dates = [b["date"] for b in data["trend"]]
    own_trend = [b["own"] for b in data["trend"]] if own is not None and data["trend"] else None
    show_delta = bool(round_buckets and not period)

    def series_of(brand: Any) -> list | None:
        if not isinstance(brand, str) or brand not in series_set:
            return None
        return [b["series"].get(brand) for b in data["trend"]]

    brands = []
    for i, b in enumerate(data["brands"]):
        trend = own_trend if b["isOurs"] and len(own_brands) == 1 and own_trend is not None else series_of(b["brand"])
        brands.append({**b, "rank": i + 1, "trend": trend, "d": _last_two(trend) if show_delta and trend is not None else None})
    own_delta = _last_two(own_trend) if show_delta and own_trend is not None else None
    rivals = [b["brand"] for b in data["brands"] if not b["isOurs"] and isinstance(b["brand"], str) and b["brand"] in series_set]
    comps = [b for b in data["brands"] if not b["isOurs"]]
    standing = data.get("ownStanding") or {"rank": None, "of": None}

    if data["totals"]["engines"]:
        engines = list(data["totals"]["engines"])
    else:
        engines = list(dict.fromkeys(c["engine"] for r in data["battle"] for c in r["cells"]))
    engine_wins = []
    for engine in engines:
        by_brand: dict[Any, int] = {}
        own_wins = 0
        for r in data["battle"]:
            c = next((x for x in r["cells"] if x["engine"] == engine), None)
            w = None if c is None else c["winner"]
            by_brand[w] = by_brand.get(w, 0) + 1
            if c is not None and c["winnerIsOurs"]:
                own_wins += 1
        engine_wins.append({"engine": engine, "ownWins": own_wins, "noneWins": by_brand.get(None, 0),
                            "byBrand": [{"brand": b, "count": n} for b, n in by_brand.items()]})
    sweep_count: dict[str, int] = {}
    if len(engines) > 1:
        for r in data["battle"]:
            ws = [c["winner"] for c in r["cells"]]
            if len(ws) == len(engines) and all(w and w == ws[0] for w in ws) and not r["cells"][0]["winnerIsOurs"]:
                sweep_count[ws[0]] = sweep_count.get(ws[0], 0) + 1
    sweeps = sort_by([{"brand": b, "count": n} for b, n in sweep_count.items()],
                     lambda a, b: _cmp_num(b["count"] - a["count"]) or locale_compare(a["brand"], b["brand"]))
    view = {"own": own, "ownBrands": own_brands, "brands": brands, "dates": dates, "ownTrend": own_trend, "ownDelta": own_delta,
            "rivals": rivals, "showDelta": show_delta, "rank": standing["rank"], "standingN": standing["of"],
            "leader": comps[0] if comps else None,
            "engines": engines, "engineWins": engine_wins, "sweeps": sweeps}
    view["findings"] = acr_findings(data, view)
    return view


#: The round summary's findings in one fixed order — 당사's standing, an own brand against the rival shortlisted most
#: alike, 당사 by engine, a rival topping every engine, 당사's models, the prompts 당사 was never picked in, then the
#: brand that moved most — the first FINDINGS_MAX that have a value. No threshold or HUB priority decides which show
#: or their tone, which follows 당사's direction only: a competitor's fact is info (2026-10-31 renewal audit 11-1, the
#: rule W6 gave Mention · Citation · Conversion on 2026-10-30).
FINDING_ORDER = {"standing": 7, "leak": 6, "engine": 5, "sweep": 4, "model": 3, "dist": 2, "mover": 1}
FINDINGS_MAX = 4


def _closest_rival(a: dict, rivals: list[dict]) -> dict:
    """The rival whose 후보군 포함율 is closest to `a`'s (exact values), the first in table order on a tie."""
    best = rivals[0]
    for c in rivals[1:]:
        if abs(exact(a["coverage"]) - exact(c["coverage"])) < abs(exact(a["coverage"]) - exact(best["coverage"])):
            best = c
    return best


def acr_findings(data: dict, v: dict) -> list[dict]:
    """acr-model.ts acrFindings: the page's numbers restated in FINDING_ORDER, the first FINDINGS_MAX with a value."""
    out: list[dict] = []
    o = v["own"]
    lead = v["leader"]
    if o is not None and o.get("choiceShare") is not None and lead is not None and lead.get("choiceShare") is not None:
        gap = delta1(o["choiceShare"], lead["choiceShare"])
        first = gap >= 0
        lead_row = next((b for b in v["brands"] if b["brand"] == lead["brand"]), None)
        gap_move = (delta1(v["ownDelta"], lead_row["d"])
                    if v["ownDelta"] is not None and lead_row is not None and lead_row["d"] is not None else None)
        out.append({"kind": "standing", "tone": "good" if first else "warn", "pri": FINDING_ORDER["standing"], "target": "sec-comp",
                    "brand": lead["brand"],
                    "params": {"rival": lead["brand"], "gap": abs(gap), "first": 1 if first else 0,
                               "move": "" if gap_move is None else abs(gap_move),
                               # a change shown as 0.0 is no change (W6; renewal audit 15: it read widened or narrowed)
                               "widened": "" if gap_move is None else "same" if gap_move == 0 else (1 if (gap_move > 0) == first else 0),
                               "own": o["choiceShare"], "rivalShare": lead["choiceShare"]}})
    # an own brand against the rival whose 후보군 포함율 is closest to its own, the own brand with the smallest Top1 ACR
    # difference (the largest trail, else the smallest lead; the first in table order on a tie): 'shortlisted alike'
    # was a cut-off (6pp apart, then −0.5pp), the closest rival is a fact
    def valued(b: dict) -> bool:
        return b["coverage"] is not None and b["choiceShare"] is not None
    rivals = [b for b in data["brands"] if not b["isOurs"] and valued(b)]
    leak = None
    for a in (b for b in data["brands"] if b["isOurs"] and valued(b)) if rivals else ():
        c = _closest_rival(a, rivals)
        dt = delta1(a["choiceShare"], c["choiceShare"])
        if leak is None or dt < leak[2]:
            leak = (a, c, dt)
    if leak is not None:
        a, c, dt = leak
        out.append({"kind": "leak", "tone": "info" if dt == 0 else "warn" if dt < 0 else "good", "pri": FINDING_ORDER["leak"],
                    "target": "sec-comp", "brand": c["brand"],
                    "params": {"own": a["brand"], "rival": c["brand"], "gap": abs(dt), "dir": "same" if dt == 0 else "less" if dt < 0 else "more",
                               "ownCov": a["coverage"], "rivalCov": c["coverage"], "ownTop1": a["choiceShare"], "rivalTop1": c["choiceShare"]}})
    if len(v["engineWins"]) > 1:
        # 당사's prompts on the engine it tops fewest against the one it tops most (diff 0: the same on every engine)
        w = sort_by(list(v["engineWins"]), lambda a, b: _cmp_num(a["ownWins"] - b["ownWins"]))
        lo, hi = w[0], w[-1]
        out.append({"kind": "engine", "tone": "info", "pri": FINDING_ORDER["engine"], "target": "sec-prompt", "act": {"battle": "notown"},
                    "params": {"engine": lo["engine"], "wins": lo["ownWins"], "total": len(data["battle"]), "other": hi["engine"],
                               "diff": hi["ownWins"] - lo["ownWins"]}})
    sw = v["sweeps"][0] if v["sweeps"] else None
    if sw is not None:
        out.append({"kind": "sweep", "tone": "info", "pri": FINDING_ORDER["sweep"], "target": "sec-prompt", "brand": sw["brand"], "act": {"battle": "notown"},
                    "params": {"rival": sw["brand"], "count": sw["count"]}})
    om = sort_by([m for m in data["modelConversion"] if m["isOurs"] and m["conversionRate"] is not None],
                 lambda a, b: _cmp_num(b["conversionRate"] - a["conversionRate"]))
    if len(om) >= 2:
        best, worst = om[0], om[-1]
        f = {"kind": "model", "tone": "info", "pri": FINDING_ORDER["model"], "target": "sec-model",
             "params": {"model": best["model"], "rate": best["conversionRate"], "worst": worst["model"], "worstRate": worst["conversionRate"]}}
        if best["brand"] is not None:
            f["brand"] = best["brand"]
        out.append(f)
    sheet = data["territory"][0] if data["territory"] else None
    if sheet is not None:
        # prompts of the sheet in which 당사 was never picked, of its prompts (a prompt can hold several cells;
        # 2026-10-29 metric review R5: rows without a 당사 entry, of the cells — 7 of 80 for 43 of 65)
        own_picks: dict[Any, float] = {}
        for r in sheet["rows"]:
            own_picks[r["promptId"]] = _n(own_picks.get(r["promptId"])) + _sum(_n(e["choice"]) for e in r["entries"] if e["isOurs"])
        zero = len([p for p, n in own_picks.items() if n == 0])
        if zero > 0:
            region = "" if sheet["region"] is None else sheet["region"]
            out.append({"kind": "dist", "tone": "info", "pri": FINDING_ORDER["dist"], "target": "sec-dist",
                        "act": {"sheet": sheet_key(sheet["region"], sheet["engine"])},
                        "params": {"region": region, "engine": sheet["engine"], "zero": zero, "rows": len(own_picks)}})
    movers = sort_by([b for b in v["brands"] if b["d"] is not None], lambda a, b: _cmp_num(abs(b["d"]) - abs(a["d"])))
    mover = movers[0] if movers else None
    # a move shown as 0.0 is no move (rounding, not a threshold); a competitor's move is neither good nor bad
    if mover is not None and mover["d"] != 0:
        tone = ("good" if mover["d"] > 0 else "warn") if mover["isOurs"] else "info"
        out.append({"kind": "mover", "tone": tone, "pri": FINDING_ORDER["mover"], "target": "sec-overview", "brand": mover["brand"],
                    "params": {"brand": mover["brand"], "d": mover["d"], "ownD": "" if v["ownDelta"] is None else v["ownDelta"]}})
    return sort_by(out, lambda a, b: _cmp_num(b["pri"] - a["pri"]))[:FINDINGS_MAX]


def sort_brand_rows(rows: list[dict], key: str) -> list[int]:
    """acr-model.ts sortBrandRows as row indices: the metric descending, nulls last, ties by rank."""
    def val(r: dict) -> float:
        return -1e9 if r[key] is None else r[key]
    idx = list(range(len(rows)))
    return sort_by(idx, lambda i, j: _cmp_num(val(rows[j]) - val(rows[i])) or _cmp_num(rows[i]["rank"] - rows[j]["rank"]))


def name_order(rows: list[dict]) -> list[int]:
    """The board by brand name, ascending (localeCompare, the original table's name sort), ties by rank."""
    return sort_by(list(range(len(rows))), lambda i, j: locale_compare(_key(rows[i]["brand"]), _key(rows[j]["brand"]))
                   or _cmp_num(rows[i]["rank"] - rows[j]["rank"]))


#: the board's sorts: the metric ones descending, the name ascending (2026-10-31 renewal audit 11-4 brought back the
#: original table's name, final-pick and mention sorts)
BOARD_SORTS = ("choiceShare", "coverage", "d", "choiceCount", "appearanceCount")


def _sibling(row: dict, own: bool) -> bool:
    """'HMG 계열': Gold's HMG flag on the row (`isHmg`, the value the reader judges that row's 당사 by) and not 당사 for
    this account (2026-10-31 renewal audit 11-2: it was the names Hyundai · Kia · Genesis)."""
    return bool(row.get("isHmg")) and not own


def _battle(data: dict, engines: list[str]) -> dict:
    """acr-detail.tsx AcrBattle: rows pivoted on the engines, the three views, the bar denominator."""
    rows = []
    views: dict[str, list[int]] = {"all": [], "notown": [], "split": []}
    for i, r in enumerate(data["battle"]):
        winners = []
        for e in engines:
            c = next((x for x in r["cells"] if x["engine"] == e), None)
            winners.append(None if c is None else c["winner"])
        not_own = not any(c["winnerIsOurs"] for c in r["cells"])
        rows.append({"promptId": r["promptId"], "label": _label(r), "winners": winners, "notOwn": not_own})
        views["all"].append(i)
        if not_own:
            views["notown"].append(i)
        if len({c["winner"] for c in r["cells"]}) > 1:
            views["split"].append(i)
    n = len(data["battle"])
    return {"rows": rows, "views": views, "hidden": {k: len(v) - min(len(v), BATTLE_VISIBLE) for k, v in views.items()},
            "visible": BATTLE_VISIBLE, "count": n, "total": n or 1}


def _models(data: dict) -> dict:
    """acr-detail.tsx AcrModels: rank, the three sort orders, the bar scale, own / sibling marks."""
    rows = data["modelConversion"]
    rates = [_n(r["conversionRate"]) for r in rows]
    mx = 1
    for v in rates:
        mx = v if v > mx else mx
    out = []
    for i, r in enumerate(rows):
        brand = "—" if r["brand"] is None else r["brand"]
        # 당사 is Gold's isOurs alone (2026-10-31 renewal audit 11-3: or the parent's name among the own brands)
        own = bool(r["isOurs"])
        out.append({**r, "rank": i + 1, "brandLabel": brand, "own": own, "sibling": _sibling(r, own),
                    "bar": (_n(r["conversionRate"]) / mx) * 100})

    def order(key: str) -> list[int]:
        def val(i: int) -> float:
            return -1 if out[i][key] is None else out[i][key]
        return sort_by(list(range(len(out))), lambda i, j: _cmp_num(val(j) - val(i)) or _cmp_num(out[i]["rank"] - out[j]["rank"]))

    return {"rows": out, "orders": {k: order(k) for k in ("conversionRate", "shortlistCount", "top1Count")}}


def _shares(counts: dict, n: int) -> dict:
    return {k: pct1_or_null({"num": counts[k], "den": n}) for k in counts}


def _conversion(data: dict, engines: list[str]) -> dict:
    """후보 → 선택 전환 (2026-10-29, the user's picks): per country, its prompt rows by 당사's state — the 분포 rows'
    states, counted by the reader for every sheet — on every engine summed (all) or on one; the rows by 후보 탈락
    count (the default) or share, each count with its share of the country's rows, rounded once. A row opens the
    country's 분포 sheet with the most 후보 탈락 rows (on one engine, that engine's)."""
    views = {}
    for key in ["all", *engines]:
        by_country: dict = {}
        for s in data["territory"]:
            if key != "all" and s["engine"] != key:
                continue
            r = by_country.setdefault(s["region"], {"region": s["region"], **{st: 0 for st in STATES}, "sheet": None, "most": -1})
            for st in STATES:
                r[st] += s["states"][st]
            if s["states"]["listed"] > r["most"]:
                r["sheet"], r["most"] = sheet_key(s["region"], s["engine"]), s["states"]["listed"]
        rows = []
        for r in by_country.values():
            counts = {st: r[st] for st in STATES}
            n = sum(counts.values())
            rows.append({"region": r["region"], "n": n, "counts": counts, "shares": _shares(counts, n), "sheet": r["sheet"]})
        total = {st: sum(r["counts"][st] for r in rows) for st in STATES}
        n = sum(total.values())
        share = [r["counts"]["listed"] / (r["n"] or 1) for r in rows]
        region = ["" if r["region"] is None else r["region"] for r in rows]
        idx = list(range(len(rows)))
        views[key] = {"n": n, "counts": total, "shares": _shares(total, n), "rows": rows,
                      "orders": {"listed": sorted(idx, key=lambda i: (-rows[i]["counts"]["listed"], -share[i], region[i])),
                                 "share": sorted(idx, key=lambda i: (-share[i], -rows[i]["counts"]["listed"], region[i]))}}
    return {"engines": ["all", *engines], "views": views, "visible": CONVERSION_VISIBLE}


def _duels(data: dict, engines: list[str]) -> dict | None:
    """결선 맞대결 (2026-10-29): per rival, the repetitions whose shortlist held 당사 and the rival (the reader's sample of
    about one repetition per cell), on every engine summed (all) or on one; the DUEL_ROWS rivals met most, then by
    name; 당사's wins, the rival's and the rest (another brand or no pick), each share rounded once. The bars of a view
    share one scale: its largest 당사 or rival share fills its half. A rival is never 당사 (the reader's shortlist rule),
    so its badge is Gold's HMG flag alone."""
    h = data.get("headToHead")
    if h is None:
        return None
    views = {}
    for key in ["all", *engines]:
        by_brand: dict = {}
        hmg: dict = {}
        for r in h["rows"]:
            if key == "all" or r["engine"] == key:
                g = by_brand.setdefault(r["brand"], [0, 0, 0])
                g[0] += r["iterations"]
                g[1] += r["ownWins"]
                g[2] += r["rivalWins"]
                hmg.setdefault(r["brand"], r)
        met = sort_by(list(by_brand), lambda a, b: _cmp_num(by_brand[b][0] - by_brand[a][0]) or locale_compare(a, b))[:DUEL_ROWS]
        top = max((max(by_brand[b][1], by_brand[b][2]) / by_brand[b][0] for b in met), default=0) or 1
        rows = []
        for brand in met:
            n, own, rival = by_brand[brand]
            counts = {"own": own, "rival": rival, "rest": n - own - rival}
            rows.append({"brand": brand, "n": n, "counts": counts, "shares": _shares(counts, n),
                         "bars": {"own": (own / n) / top * 100, "rival": (rival / n) / top * 100}, "sibling": _sibling(hmg[brand], False),
                         "lead": "own" if own > rival else "rival" if rival > own else "even"})
        views[key] = rows
    return {"engines": ["all", *engines], "views": views, "sample": dict(h["sample"])}


def sheet_key(region: Any, engine: Any) -> str:
    """A 분포 sheet's key (view.sheets[].key, acr/renewal-sheet ?sheet=): `${country ?? ""}|${engine}`."""
    return f"{'' if region is None else _key(region)}|{_key(engine)}"


def _sheet(s: dict) -> dict:
    """acr-detail.tsx AcrDistribution, one sheet (2026-10-29 redesign, the user's picks): per row 당사's state —
    picked, listed (a candidate never picked) or absent (not a candidate) — and the bar of the brands picked (the
    candidates never picked are counted, not drawn); the brands picked in the sheet and the CSV pivot; row orders per
    sort (당사 열세 = the most picked rival's share − 당사's, then 당사's share, then the prompt; 당사 몫 low first;
    prompt) and per state, with the state counts."""
    present = list(dict.fromkeys(e["brand"] for r in s["rows"] for e in r["entries"] if _n(e["choice"]) > 0))
    rows = []
    gaps = []
    for r in s["rows"]:
        own_n = 0
        own_listed = 0
        picked = 0
        rival_top = 0
        first: dict = {}
        for e in r["entries"]:
            n = _n(e["choice"])
            picked = picked + n
            if e["isOurs"]:
                own_n = own_n + n
                own_listed = own_listed + _n(e["appearance"])
            elif n > rival_top:
                rival_top = n
            first.setdefault(e["brand"], e)
        den = r["validAcr"] or 1
        gaps.append((rival_top - own_n) / den)
        # 최빈 = the first (most picked) entry; a row nobody was picked in has none (it showed the first candidate, "Audi 0")
        top = r["entries"][0] if r["entries"] and _n(r["entries"][0]["choice"]) > 0 else None
        rows.append({"promptId": r["promptId"], "label": _label(r), "validAcr": r["validAcr"], "cells": r["cells"],
                     "state": "pick" if own_n > 0 else "listed" if own_listed > 0 else "absent",
                     "candidates": len([e for e in r["entries"] if _n(e["appearance"]) > 0]), "ownN": own_n, "picked": picked,
                     "hatch": _n(r["validAcr"]) > picked, "none": _n(r["validAcr"]) - picked,
                     "top": None if top is None else {"brand": top["brand"], "choice": top["choice"]},
                     "entries": [{"brand": e["brand"], "choice": e["choice"], "width": (_n(e["choice"]) / den) * 100}
                                 for e in r["entries"] if _n(e["choice"]) > 0],
                     "pivot": [0 if b not in first or first[b]["choice"] is None else first[b]["choice"] for b in present]})

    def text(i: int, j: int) -> int:
        a, b = s["rows"][i]["promptText"], s["rows"][j]["promptText"]
        return locale_compare("" if a is None else a, "" if b is None else b)

    def ratio(i: int) -> float:
        return rows[i]["ownN"] / (s["rows"][i]["validAcr"] or 1)

    def by_own(i: int, j: int) -> int:
        d = ratio(i) - ratio(j)
        return _cmp_num(d) if d == d and d != 0 else text(i, j)

    def by_gap(i: int, j: int) -> int:
        d = gaps[j] - gaps[i]
        return _cmp_num(d) if d != 0 else by_own(i, j)

    all_idx = list(range(len(rows)))
    states = {"all": all_idx, **{st: [i for i in all_idx if rows[i]["state"] == st] for st in ("pick", "listed", "absent")}}
    return {"key": sheet_key(s["region"], s["engine"]), "region": s["region"], "engine": s["engine"],
            "rows": rows, "present": present, "counts": {st: len(ix) for st, ix in states.items()},
            "orders": {sort: {st: sort_by(ix, cmp) for st, ix in states.items()}
                       for sort, cmp in (("gap", by_gap), ("own", by_own), ("text", text))}}


def renewal_view(data: dict, own: dict | None, round_buckets: bool, period: bool) -> dict:
    """acrView + every value the renewal cards derived from it."""
    v = acr_view(data, own, round_buckets, period)
    own_brands = v["ownBrands"]
    o = v["own"]
    lead = v["leader"]
    max_t1 = _n(None if o is None else o.get("choiceShare"))
    for b in v["brands"]:
        x = _n(b["choiceShare"])
        max_t1 = x if x > max_t1 else max_t1
    max_t1 = max_t1 or 1
    for b in v["brands"]:
        is_own = b["brand"] in own_brands
        # the map's dot: the brand's two Gold values. The 'brand average line' through it (k = ΣTop1 ACR ÷ Σ후보군 포함율
        # of the brands shown) and each brand's distance to it were a baseline the HUB made (2026-10-31 ⛔L, renewal audit 15)
        b.update({"own": is_own, "sibling": _sibling(b, is_own),
                  "canCompare": (not is_own) and b["brand"] in v["rivals"],
                  "top1Bar": (_n(b["choiceShare"]) / max_t1) * 100,
                  "mapX": _n(b["coverage"]), "mapY": _n(b["choiceShare"])})
    gap = None
    if o is not None and o.get("choiceShare") is not None and lead is not None and lead.get("choiceShare") is not None:
        gap = delta1(o["choiceShare"], lead["choiceShare"])
    v.update({
        "defaultCompare": v["rivals"][:1],
        "multiOwn": len(own_brands) > 1,
        "gap": gap,
        "boardOrders": {**{key: sort_brand_rows(v["brands"], key) for key in BOARD_SORTS}, "brand": name_order(v["brands"])},
        "ownTop1Bar": None if o is None else (_n(o.get("choiceShare")) / max_t1) * 100,
        "battle": _battle(data, v["engines"]),
        "models": _models(data),
        # the sheet tabs, and the first sheet's rows (acr/renewal-sheet sends the others when their tab opens)
        "sheets": [{"key": sheet_key(s["region"], s["engine"]), "region": s["region"], "engine": s["engine"], "count": s["rowCount"]}
                   for s in data["territory"]],
        "sheet": _sheet(data["territory"][0]) if data["territory"] else None,
        "distVisible": DIST_VISIBLE,
        "conversion": _conversion(data, v["engines"]),
        "duels": _duels(data, v["engines"]),
    })
    for w in v["engineWins"]:
        # 그 외 브랜드 = prompts another brand won: no pick (no winner, or no cell on that engine) is apart (R5)
        w["restBase"] = len(data["battle"]) - w["ownWins"] - w["noneWins"]
    return v


@screen("acr/renewal-header")
async def renewal_header(q) -> dict:
    """The renewal ACR page header (outside the data Suspense): the period pill. No reads."""
    _, sp = split_context(q)
    st = page_state(sp, read_standard_filters(sp, reader_scope()))
    return {"period": st["period"], "dateFrom": st["dateFrom"], "dateTo": st["dateTo"]}


@screen("acr/renewal")
async def renewal(q) -> dict:
    """The renewal ACR page body: {props: RnOverviewFilters option props (scope added by the page),
    body: the state flags, the round shown (asOf; 2026-10-30, metric review ⚠️ #1: the page named no measurement
    date) and, when measured, the full view model}."""
    _, sp = split_context(q)
    filters = read_standard_filters(sp, reader_scope())
    st = page_state(sp, filters)
    acr, options, dates = await _global_reads(filters, "first", duels=True)
    props = {"stage": "acr", **_panel_props(options, acr["languageOptions"], dates)}
    data = acr["data"]
    own = dict(data["own"]) if data.get("own") is not None else None
    body = {"measured": bool(data["measured"]), "filtered": st["filtered"], "acrPromptCount": acr["acrPromptCount"],
            "roundBuckets": True, "period": st["period"], "asOf": acr["asOf"], "ownLabel": st["ownLabel"], "totals": data["totals"],
            "view": renewal_view(data, own, True, st["period"]) if data["measured"] else None}
    return {"props": props, "body": body}


@screen("acr/renewal-sheet")
async def renewal_sheet(q) -> dict:
    """One 분포 sheet of the renewal ACR page, read when its tab opens: ?sheet=<view.sheets[].key> with the page's
    URL -> {sheet: the sheet as acr/renewal's view.sheet, null when the filters leave it no cell}."""
    _, sp = split_context(q)
    key = sp.get("sheet")
    if not isinstance(key, str) or "|" not in key:
        raise HTTPException(422, "sheet must be <country>|<engine>")
    country, _, engine = key.partition("|")
    filters = read_standard_filters(sp, reader_scope())
    params = to_api_params(analysis_query(filters, {"surface": "global", "scope": reader_scope()}),
                           {"sheet_country": country, "sheet_engine": engine})
    res = await api.get("funnel/acr/territory", params)
    s = res["data"]["sheet"]
    return {"sheet": None if s is None or whole_suppression(res.get("meta")) else _sheet(_territory_sheet(s))}
