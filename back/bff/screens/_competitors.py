"""Competitor rows of the overview cards and the mention screens: brand values, candidates, Δ, citation shares.

Ports, bit for bit:
  front/lib/kpi/competitor-values.ts                 competitorValueOf, index, overlay decision, Δ
  front/lib/scope/competitor-row.ts                  dedupeBrandRows, candidates, value order, mini picks, Δ brands
  front/lib/kpi/first-position-rank.ts               competition ranks of the first-position table
  front/lib/hgh/adapters/dashboard.ts                toCompetitorBrandValue, candidateBrandKeys, toCompetitorCitationDomains
  dashboard/_components/overview-kpi-cards.tsx       competitorCitationShares, competitorMinis, competitorDeltas,
                                                     the competitor row of CompetitorRowLive (competitor_row)

CompetitorBrandValue = {brand, mentions, share, mentionRate, avgPosition, isTracked, sentiment?, brandKey?}.
Name ties sort with localeCompare (ICU ko-KR, the screens' locale); the first-position ranks use the
code-unit order, as the TS does. A TS Map is a dict here (insertion order kept).
"""
from __future__ import annotations

from typing import Any

from bff.screens._convert import delta1, pct1_or_zero, rank_avg
from bff.screens._js import js_round
from bff.screens._sort import code_unit_compare, locale_compare, sort_by

COMPETITOR_DELTA_KEYS = ("visibility", "shareOfVoice", "position")
RANK_TABLE_TOP_BRANDS = 10
OFFICIAL_COMPETITOR_CATEGORY = "Official (Competitor)"

# String.prototype.trim whitespace (WhiteSpace + LineTerminator).
_JS_WS = "\t\n\u000b\u000c\r              " \
         "    　﻿"


def _sign(x: float) -> int:
    return (x > 0) - (x < 0)


def brand_key(b: str) -> str:
    """Name folded for duplicate rows and lookups: trim + lower case."""
    return b.strip(_JS_WS).lower()


# ── lib/kpi/competitor-values.ts ───────────────────────────────────────────

def competitor_value_of(b: dict, key: str) -> float | None:
    if key == "visibility":
        return b["mentionRate"] if b["mentions"] > 0 else None
    if key == "shareOfVoice":
        return b["share"] if b["mentions"] > 0 else None
    if key == "position":
        return b.get("avgPosition")
    if key == "sentiment":
        s = b.get("sentiment")
        if not s:
            return None
        total = s["positive"] + s["neutral"] + s["negative"] + s["mixed"]
        return js_round((1000 * s["positive"]) / total) / 10 if total > 0 else None
    return None


def competitor_value_index(values: list[dict] | None) -> dict:
    """{brand_key: row}; of two rows of one brand the one with more mentions stays."""
    out: dict = {}
    for v in values or []:
        k = brand_key(v["brand"])
        cur = out.get(k)
        if cur is None or v["mentions"] > cur["mentions"]:
            out[k] = v
    return out


def resolve_competitor_overlay(rows: list[dict], index: dict) -> dict:
    """Overlay usable only if some row matched and every tracked row matched."""
    if not index:
        return {"usable": False, "unmatchedTracked": [], "anyMatched": False}
    any_matched = any(brand_key(r["brand"]) in index for r in rows)
    unmatched = [r["brand"] for r in rows if r.get("isTracked") and brand_key(r["brand"]) not in index]
    return {"usable": any_matched and not unmatched, "unmatchedTracked": unmatched, "anyMatched": any_matched}


def last_two_delta(values: list[float | None]) -> float | None:
    """Difference of the last two non-null values (exact, rounded once); None with fewer than two."""
    v = [x for x in values if x is not None]
    if len(v) < 2:
        return None
    return delta1(v[-1], v[-2])


def competitor_trend_deltas(brand_trend: dict | None, key: str) -> dict:
    """{brand: Δ} of exposure (visibility) or share (shareOfVoice) from a BrandTrendResult."""
    out: dict = {}
    if not brand_trend:
        return out
    field = "exposurePct" if key == "visibility" else "sharePct"
    for b in brand_trend["brands"]:
        series = []
        for bk in brand_trend["buckets"]:
            hit = next((x for x in bk["brands"] if x["brand"] == b["brand"]), None)
            series.append(hit.get(field) if hit else None)
        out[b["brand"]] = last_two_delta(series)
    return out


def competitor_position_deltas(first_position: dict | None) -> dict:
    """{brand: Δ} of the average rank from a FirstPositionResult."""
    out: dict = {}
    if not first_position:
        return out
    for brand in first_position["brands"]:
        series = []
        for bk in first_position["buckets"]:
            hit = next((x for x in bk["brands"] if x["brand"] == brand), None)
            series.append(hit.get("avgPosition") if hit else None)
        out[brand] = last_two_delta(series)
    return out


# ── lib/scope/competitor-row.ts ────────────────────────────────────────────

def dedupe_brand_rows(rows: list[dict]) -> list[dict]:
    """One row per brand_key: the one with more mentions (first kept on ties), first-seen order."""
    out: dict = {}
    for r in rows:
        k = brand_key(r["brand"])
        cur = out.get(k)
        if cur is None or _nn0(r.get("mentions")) > _nn0(cur.get("mentions")):
            out[k] = r
    return list(out.values())


def _nn0(v: Any) -> float:
    return v if v is not None else 0


def _by_mentions_then_name(a: dict, b: dict) -> int:
    return _sign(b["mentions"] - a["mentions"]) or locale_compare(a["brand"], b["brand"])


def competitor_candidates(brands: list[dict], key: str, limit: int | None = 4) -> list[dict]:
    """Top-N competitors of a metric: by mentions (position: rank order inside the top-10 mention pool)."""
    limit = 4 if limit is None else limit
    if key == "position":
        return _position_candidates(brands, limit)
    rows = [{"brand": b["brand"], "value": competitor_value_of(b, key), "mentions": b["mentions"]}
            for b in brands if not b.get("isTracked")]
    rows = sort_by([r for r in rows if r["value"] is not None], _by_mentions_then_name)
    return dedupe_brand_rows(rows)[:limit]


def _position_candidates(brands: list[dict], limit: int) -> list[dict]:
    pool = dedupe_brand_rows(sort_by(list(brands), _by_mentions_then_name))[:RANK_TABLE_TOP_BRANDS]
    rows = [{"brand": b["brand"], "value": competitor_value_of(b, "position"), "mentions": b["mentions"]}
            for b in pool if not b.get("isTracked")]
    return sort_minis_by_value([r for r in rows if r["value"] is not None], "position")[:limit]


def sort_minis_by_value(minis: list[dict], key: str) -> list[dict]:
    """Value order: position ascending, the rest descending; None last; ties by name."""
    asc = key == "position"

    def cmp(a: dict, b: dict) -> int:
        av, bv = a.get("value"), b.get("value")
        if av is None and bv is None:
            return locale_compare(a["brand"], b["brand"])
        if av is None:
            return 1
        if bv is None:
            return -1
        return _sign(av - bv if asc else bv - av) or locale_compare(a["brand"], b["brand"])

    return sort_by(list(minis), cmp)


def competitor_mini_picks(brands: list[dict], key: str, limit: int | None = 4) -> list[dict]:
    """Candidates (competitor_candidates) shown in value order (sort_minis_by_value)."""
    return sort_minis_by_value(competitor_candidates(brands, key, limit), key)


def competitor_delta_brands(brands: list[dict], limit: int | None = 4) -> list[str]:
    """Union of the three Δ metrics' candidates, by mentions desc then name."""
    by_name: dict = {}
    for key in COMPETITOR_DELTA_KEYS:
        for c in competitor_candidates(brands, key, limit):
            by_name[c["brand"]] = max(_nn0(by_name.get(c["brand"])), c["mentions"])
    entries = sort_by(list(by_name.items()), lambda a, b: _sign(b[1] - a[1]) or locale_compare(a[0], b[0]))
    return [name for name, _ in entries]


# ── lib/kpi/first-position-rank.ts ─────────────────────────────────────────

def rank_first_position_rows(rows: list[dict]) -> list[dict]:
    """Competition ranks by avgPosition (ties share, next skipped), None ranks last by mentions;
    name ties in code-unit order. New rows, input untouched."""
    rankable = sort_by([r for r in rows if r.get("avgPosition") is not None],
                       lambda a, b: _sign(a["avgPosition"] - b["avgPosition"]) or code_unit_compare(a["brand"], b["brand"]))
    rank_of: dict = {}
    for i, r in enumerate(rankable):
        prev = rankable[i - 1] if i > 0 else None
        prev_rank = rank_of.get(prev["brand"]) if prev else None
        rank_of[r["brand"]] = (prev_rank if prev and prev_rank is not None and prev["avgPosition"] == r["avgPosition"]
                               else i + 1)

    def cmp(a: dict, b: dict) -> int:
        if a["rank"] is None and b["rank"] is None:
            return _sign(b["mentions"] - a["mentions"]) or code_unit_compare(a["brand"], b["brand"])
        if a["rank"] is None:
            return 1
        if b["rank"] is None:
            return -1
        return _sign(a["rank"] - b["rank"]) or code_unit_compare(a["brand"], b["brand"])

    return sort_by([{**r, "rank": rank_of.get(r["brand"])} for r in rows], cmp)


# ── lib/hgh/adapters/dashboard.ts ──────────────────────────────────────────

def to_competitor_brand_value(b: dict) -> dict:
    """BrandItem (GET /v1/mentions/brands) -> CompetitorBrandValue."""
    s = b["sentiment"]
    out = {"brand": b["name"], "mentions": b["mentions"], "share": pct1_or_zero(b.get("share")),
           "mentionRate": pct1_or_zero(b.get("exposure")), "avgPosition": rank_avg(b.get("avg_rank")),
           "isTracked": b.get("is_own") if b.get("is_own") else b.get("is_hmg_own") is True,
           "sentiment": {"positive": s["positive"], "neutral": s["neutral"], "negative": s["negative"],
                         "mixed": s["mixed"]}}
    bk = b.get("brand_key")
    if isinstance(bk, (int, float)) and not isinstance(bk, bool):
        out["brandKey"] = bk
    return out


def to_competitor_brand_values(items: list[dict]) -> list[dict]:
    return [to_competitor_brand_value(b) for b in items]


def candidate_brand_keys(brands: list[dict]) -> list[int]:
    """brand_key of the competitor Δ candidates (competitor_delta_brands), first-seen, no repeats."""
    by_name = {b["brand"]: b.get("brandKey") for b in brands}
    keys: list = []
    for name in competitor_delta_brands(list(brands)):
        k = by_name.get(name)
        if isinstance(k, (int, float)) and not isinstance(k, bool) and k not in keys:
            keys.append(k)
    return keys


def to_competitor_citation_domains(data: dict) -> list[dict] | None:
    """competitor_sources (GET /v1/citations/domains) -> competitor domain rows with Gold's brand and category;
    None = no rows."""
    sources = data.get("competitor_sources")
    if sources is None:
        return None
    total = data["summary"]["own_share"]["den"]
    out = []
    for s in sources:
        row = {"domain": s["domain"], "citations": s["citations"],
               "share": pct1_or_zero({"num": s["citations"], "den": total}), "prompts": 0, "coverageRate": 0,
               "urls": [], "promptList": [], "isOurs": False, "category": (s["category"] or {}).get("name"),
               "subcategory": None, "brand": s["competitor_brand"]}
        if "skey" in s:
            row["skey"] = s["skey"]
        out.append(row)
    return out


# ── dashboard/_components/overview-kpi-cards.tsx ───────────────────────────

def competitor_citation_shares(domains: list[dict] | None, limit: int | None = 4,
                               total: float | None = None) -> list[dict]:
    """Citation-share competitor minis: the domains Gold files as official competitor, folded to the brand Gold
    gives them, share summed (or brand citations / total x 100 when total > 0), top N by share then name, one
    decimal."""
    limit = 4 if limit is None else limit
    if domains is None:
        return []
    acc: dict = {}
    for d in domains:
        if d.get("category") != OFFICIAL_COMPETITOR_CATEGORY:
            continue
        cur = acc.get(d["brand"])
        if cur:
            cur["share"] = cur["share"] + d["share"]
            cur["citations"] = cur["citations"] + d["citations"]
        else:
            acc[d["brand"]] = {"brand": d["brand"], "share": d["share"], "citations": d["citations"]}
    if total is not None and total > 0:
        for v in acc.values():
            v["share"] = (100 * v["citations"]) / total
    ranked = sort_by(list(acc.values()), lambda a, b: _sign(b["share"] - a["share"]) or locale_compare(a["brand"], b["brand"]))
    return [{"brand": v["brand"], "value": js_round(v["share"] * 10) / 10} for v in ranked[:limit]]


def competitor_minis(brands: list[dict], key: str, limit: int | None = 4) -> list[dict]:
    return [{"brand": m["brand"], "value": m["value"]} for m in competitor_mini_picks(brands, key, limit)]


def competitor_deltas(extras: dict | None, key: str) -> dict:
    """{brand: Δ}: visibility / shareOfVoice from brandTrend, position from firstPosition, else empty."""
    if not extras:
        return {}
    if key in ("visibility", "shareOfVoice"):
        return competitor_trend_deltas(extras.get("brandTrend"), key)
    if key == "position":
        return competitor_position_deltas(extras.get("firstPosition"))
    return {}


def competitor_row(src: dict | None, kpi_key: str) -> list[dict]:
    """The competitor row of one overview card (CompetitorRowLive): citationShare -> citation minis;
    else value-ordered minis with their Δ (None when the brand has none). src = OverviewCompetitorSources
    {brands, brandTrend, firstPosition, citationDomains, citationTotal?} or None."""
    src_d = src or {}
    if kpi_key == "citationShare":
        return competitor_citation_shares(src_d.get("citationDomains"), None, src_d.get("citationTotal"))
    deltas = competitor_deltas(src, kpi_key)
    return [{**m, "delta": deltas.get(m["brand"])} for m in competitor_minis(src_d.get("brands") or [], kpi_key)]
