"""Citation analysis view models: the pure rules the citation screens computed in the front.

Ports, bit for bit (each function names its TS origin):
  front/lib/hgh/adapters/citations.ts                      API answers -> CitationsLive shapes, request params
  (dash)/standard/answer-analysis/_data/citation-view.ts   category shares/bars, type bars, competitor pick, pages
  (dash)/.../_components/citations-standard-view.tsx       status tiles, category Δ, the Δ basis line
  (dash)/.../_components/citations-view.tsx                summary shares, donut centre, engine chart series
  (renewal)/.../citation/_components/citation-model.ts     category rows, lens, matrices, bump, findings
  (renewal)/.../citation/_components/citation-body.tsx / citation-domains.tsx   the cards' scales and lists

JS semantics: `round1` = Math.round(n * 10) / 10 (halves toward +inf), every percent keeps its own
TS expression (mirror Math.round(n/d*1000)/10, round1(100*n/d), Math.round(1000*n/d)/10, the raw
ratio for toFixed), Array#sort is stable, String#localeCompare = ICU ko-KR (locale_compare), the
default string sort = UTF-16 code units, Object.entries lists integer-like keys first.
A key TS left undefined is absent; None is JSON null.
"""
from __future__ import annotations

import math
import re
from typing import Any, Callable

from bff.screens._convert import as_of_date, pct1_or_zero, round1, whole_suppression
from bff.screens._js import is_num, js_round, js_str
from bff.screens._query import CITATION_CATEGORY_SLUGS, js_trim
from bff.screens._sort import code_unit_compare, code_unit_key, locale_compare, sort_by

# ── constants (taxonomy, citations.ts) ───────────────────────────────────────

CITATION_CATEGORIES = list(CITATION_CATEGORY_SLUGS)
LABEL_BY_SLUG = {slug: label for label, slug in CITATION_CATEGORY_SLUGS.items()}
OFFICIAL_HMG_CATEGORY = "Official (HMG)"
OFFICIAL_COMPETITOR_CATEGORY = "Official (Competitor)"
DEALER_CATEGORY = "Dealer & Marketplace"
FALLBACK_CATEGORY = "Other"

DOMAIN_PAGE = 200
STANDARD_TABLE_ROWS = 100
SOURCE_TREND_TOP = 15
CATEGORY_TREND_TOP = 13
SPLIT_CARD_ROWS = 5
SUBPAGE_SIZE = 50
MENTION_TYPES = ("mention", "recommendation", "comparison", "definition", "final_choice")
DOMAIN_SORTS = ("citations", "share", "coverage", "prompts", "skey")
PICKS_MAX = 100
SKEY_MAX_LEN = 512
NO_VALUE_GAP = {"reason": "no_value"}

_PROVIDER_LABEL = {"chatgpt": "ChatGPT", "gemini": "Gemini", "deepseek": "DeepSeek", "perplexity": "Perplexity",
                   "claude": "Claude", "claude-web": "Claude", "claude-sonnet": "Claude", "claude-opus": "Claude"}


# ── JS helpers ───────────────────────────────────────────────────────────────

_INDEX_KEY = re.compile(r"0|[1-9][0-9]*")


def _is_index_key(k: str) -> bool:
    return bool(_INDEX_KEY.fullmatch(k)) and int(k) <= 4294967294


def js_keys(d: dict) -> list:
    """Object.keys order: integer-like keys ascending first, then the rest in insertion order."""
    keys = list(d)
    idx = sorted((k for k in keys if isinstance(k, str) and _is_index_key(k)), key=int)
    return idx + [k for k in keys if not (isinstance(k, str) and _is_index_key(k))]


def js_entries(d: dict) -> list[tuple]:
    return [(k, d[k]) for k in js_keys(d)]


def js_len(s: str) -> int:
    """String#length (UTF-16 code units)."""
    return len(s.encode("utf-16-le")) // 2


def _nn(v: Any, default: Any) -> Any:
    """`v ?? default`."""
    return v if v is not None else default


def _sum(values) -> float:
    total = 0
    for v in values:
        total = total + v
    return total


def provider_label(t: str) -> str:
    """lib/scope/result-adapter providerLabel."""
    return _PROVIDER_LABEL.get(t, t)


def display_citation_url(url: str) -> str:
    """lib/url-display displayCitationUrl: scheme dropped, the #fragment cut."""
    no_scheme = re.sub(r"^https?://", "", url)
    hash_at = no_scheme.find("#")
    return no_scheme if hash_at == -1 else no_scheme[:hash_at]


# ── API answers -> CitationsLive (citations.ts conversions) ─────────────────

def category_label_of(c: dict | None) -> str | None:
    """categoryLabelOf: the legacy category name of a slug; unknown slug -> the API name."""
    if c is None:
        return None
    return _nn(LABEL_BY_SLUG.get(c.get("slug")), c.get("name"))


def category_key_labels(sources: dict) -> Callable[[int], str]:
    """categoryKeyLabels: category_key -> label from the answer's categories, else the seed order."""
    by_key: dict = {}
    for c in sources.get("categories") or []:
        cat = c["category"]
        by_key[cat["category_key"]] = _nn(category_label_of(cat), cat.get("name"))

    def label(key: Any) -> str:
        if key in by_key:
            return by_key[key]
        if isinstance(key, int) and not isinstance(key, bool) and 1 <= key <= len(CITATION_CATEGORIES):
            return CITATION_CATEGORIES[key - 1]
        return js_str(key)
    return label


def mirror_pct_or_zero(r: Any) -> float:
    return pct1_or_zero(r)


def mirror_pct_or_null(r: Any) -> float | None:
    return pct1_or_zero(r) if isinstance(r, dict) and is_num(r.get("den")) and r["den"] > 0 else None


def to_citation_domain(r: dict) -> dict:
    """toCitationDomain: C-1 DomainRow -> CitationDomainLive (+ skey, rank, matchRank)."""
    out = {"domain": r["skey"], "citations": r["citations"], "share": mirror_pct_or_zero(r.get("share")),
           "prompts": _nn(r.get("citing_prompts"), 0), "coverageRate": mirror_pct_or_zero(r.get("coverage")),
           "urls": [], "promptList": []}
    if "is_own" in r:
        out["isOurs"] = r["is_own"]
    out.update({"category": category_label_of(r.get("category")), "subcategory": None, "skey": r["skey"]})
    if isinstance(r.get("rank"), (int, float)) and not isinstance(r.get("rank"), bool):
        out["rank"] = r["rank"]
    if isinstance(r.get("match_rank"), (int, float)) and not isinstance(r.get("match_rank"), bool):
        out["matchRank"] = r["match_rank"]
    return out


def to_category_slices(sources: dict) -> list[dict] | None:
    """toCategorySlices: categories in API order; None without citations."""
    if sources["total_citations"] <= 0:
        return None
    return [{"name": _nn(category_label_of(c["category"]), c["category"].get("name")), "value": c["citations"]}
            for c in sources["categories"]]


def to_engine_categories(sources: dict) -> list[dict] | None:
    """toEngineCategories: by_engine merged per display label, total desc; None when empty."""
    label = category_key_labels(sources)
    by_engine: dict[str, dict] = {}
    for e in sources.get("by_engine") or []:
        eng = provider_label(e["engine"])
        m = by_engine.get(eng)
        if m is None:
            m = {}
        for c in e["categories"]:
            name = label(c["category_key"])
            m[name] = _nn(m.get(name), 0) + c["citations"]
        by_engine[eng] = m
    if not by_engine:
        return None
    rows = [{"engine": engine, "total": _sum(cats.values()), "byCategory": dict(cats)} for engine, cats in by_engine.items()]
    return sort_by(rows, lambda a, b: b["total"] - a["total"])


def to_type_category_rows(sources: dict) -> list[dict]:
    """toTypeCategoryRows: the five mention types in the legacy order, zero-filled."""
    label = category_key_labels(sources)
    by_type = {t["type"]: t for t in sources.get("types") or []}
    out = []
    for type_ in MENTION_TYPES:
        t = by_type.get(type_)
        by_category: dict = {}
        for c in (t or {}).get("categories") or []:
            if c["citations"] <= 0:
                continue
            name = label(c["category_key"])
            by_category[name] = _nn(by_category.get(name), 0) + c["citations"]
        out.append({"type": type_, "total": _nn((t or {}).get("total"), 0), "byCategory": by_category})
    return out


def to_tone_summary(sources: dict) -> dict:
    tile = lambda x: {"urls": x["urls"], "citations": x["citations"], "answers": x["answers"]}  # noqa: E731
    return {"positive": tile(sources["tone"]["positive"]), "negative": tile(sources["tone"]["negative"])}


def citation_point_gap(p: dict | None) -> dict | None:
    """citationPointGap: collection_error / hidden (not_published) / other gaps no_value; None when none."""
    if not (p or {}).get("gap") and not (p or {}).get("gap_reason"):
        return None
    if p.get("gap_reason") == "collection_error":
        return {"reason": "collection_error"}
    if p.get("gap_reason") == "hidden":
        return {"reason": "not_published"}
    return dict(NO_VALUE_GAP)


def _trend_name(s: dict, dimension: Any) -> Any:
    if dimension != "category":
        return s.get("key")
    by_slug = LABEL_BY_SLUG.get(s["key"]) if s.get("key") else None
    return _nn(_nn(by_slug, s.get("label")), s.get("key"))


def to_citation_trend(data: dict, series_order: list[str] | None = None) -> dict | None:
    """toCitationTrend: T-1 dimension=source|category -> {series, points}; fewer than two valued buckets -> None."""
    by_name: dict = {}
    for s in data["series"]:
        name = _trend_name(s, data.get("dimension"))
        if name and name not in by_name:
            by_name[name] = s

    def valued_series(s: dict) -> bool:
        return any(not p.get("gap") and _nn((p.get("ratio") or {}).get("num"), 0) > 0 for p in s["points"])

    if series_order is not None:
        names = [n for n in series_order if n in by_name] + \
                [n for n in by_name if n not in series_order and valued_series(by_name[n])]
    else:
        names = list(by_name)
    if not names:
        return None
    idx = [{p.get("bucket"): p for p in by_name[n]["points"]} for n in names]
    valued = 0
    points = []
    for b in data["buckets"]:
        row: dict = {"week": b["key"]}
        gap = None
        any_value = False
        for i, n in enumerate(names):
            p = idx[i].get(b["key"])
            if gap is None:
                gap = citation_point_gap(p)
            if p and p.get("ratio") and not p.get("gap"):
                any_value = True
                row[n] = p["ratio"]["num"]
            else:
                row[n] = 0
        if gap or not any_value:
            for n in names:
                row[n] = None
            row["gap"] = gap or dict(NO_VALUE_GAP)
        else:
            valued += 1
        points.append(row)
    if valued < 2:
        return None
    return {"series": names, "points": points}


def to_prompt_answer(a: dict) -> dict:
    return {"jobId": a["job_id"], "provider": provider_label(a["provider"]), "region": _nn(a.get("region"), None),
            "mentionCount": a["citations_in_answer"], "position": None, "highlights": {"brand": [], "model": []},
            "measuredAt": None, "runs": 1}


def to_citation_prompt(r: dict) -> dict:
    return {"id": r["prompt_id"], "promptText": _nn(r.get("text"), ""), "funnelStage": _nn(r.get("funnel"), None),
            "citations": r["citations"], "providers": [provider_label(p) for p in r["providers"]],
            "answers": [to_prompt_answer(a) for a in r["answers"]]}


def to_prompt_split(owned: dict, uncited: dict | None = None) -> dict | None:
    """toPromptSplit: owned 0 -> None; the uncited rows are the owned answer's other_bucket."""
    if owned["counts"]["owned"] == 0:
        return None
    rows = (uncited or {}).get("items") if uncited is not None else None
    rows = _nn(_nn(rows, owned.get("other_bucket")), [])
    return {"owned": [to_citation_prompt(r) for r in owned["items"]], "uncited": [to_citation_prompt(r) for r in rows],
            "ownedCount": owned["counts"]["owned"], "uncitedCount": owned["counts"]["uncited"]}


def _cut_total(total: Any, shown: int) -> Any:
    return total if is_num(total) and total > shown else None


def to_detail_answer(a: dict) -> dict:
    return {"jobId": a["job_id"], "provider": provider_label(_nn(a.get("engine"), "")), "region": _nn(a.get("country"), None),
            "mentionCount": a["citations"], "position": None, "highlights": {"brand": [], "model": []},
            "measuredAt": None, "runs": 1}


def to_domain_drilldown(d: dict) -> dict:
    """toDomainDrilldown: URL list (count desc, then url) + prompt list (citations desc), cap totals when cut."""
    urls = [{"url": u["url"], "title": u.get("title") or display_citation_url(u["url"]), "count": u["citations"],
             "aiProvider": ", ".join(provider_label(e) for e in u["engines"]), "promptText": _nn(u.get("prompt_text"), ""),
             "country": u.get("country")} for u in d["urls"]]
    urls = sort_by(urls, lambda a, b: (b["count"] - a["count"]) or code_unit_compare(a["url"], b["url"]))
    prompts = []
    for p in d["prompts"]:
        row = {"id": p["prompt_id"], "promptText": _nn(p.get("text"), ""), "funnelStage": _nn(p.get("funnel"), None),
               "citations": p["citations"]}
        if "own_citations" in p:
            row["ownedCitations"] = p["own_citations"]
        row.update({"providers": [provider_label(e) for e in p["engines"]], "answers": [to_detail_answer(a) for a in p["answers"]]})
        prompts.append(row)
    prompts = sort_by(prompts, lambda a, b: b["citations"] - a["citations"])
    out: dict = {"urls": urls, "promptList": prompts}
    url_total = _cut_total(d.get("url_total"), len(d["urls"]))
    prompt_total = _cut_total(d.get("prompt_total"), len(d["prompts"]))
    if url_total is not None:
        out["urlTotal"] = url_total
    if prompt_total is not None:
        out["promptTotal"] = prompt_total
    return out


def empty_citations_live() -> dict:
    return {"summary": {"total": 0, "uniqueDomains": 0, "officialOwnShare": None}, "asOf": None, "domains": [],
            "categories": None, "trend": None, "categoryTrend": None, "engineCategories": None, "promptSplit": None}


def to_citations_live(p: dict) -> dict | None:
    """toCitationsLive. p = {domains, sources, sourceTrend, categoryTrend, owned, uncited?} (enveloped answers)."""
    if whole_suppression(p["domains"]["meta"]) is not None:
        return None
    d = p["domains"]["data"]
    if d["summary"]["total_citations"] <= 0:
        return empty_citations_live()
    categories = to_category_slices(p["sources"]["data"])
    source_trend, category_trend, owned = p.get("sourceTrend"), p.get("categoryTrend"), p.get("owned")
    uncited = p.get("uncited")
    return {
        "summary": {"total": d["summary"]["total_citations"], "uniqueDomains": d["summary"]["unique_sources"],
                    "officialOwnShare": mirror_pct_or_null(d["summary"].get("own_share"))},
        "asOf": as_of_date(p["domains"]["meta"]),
        "domains": [to_citation_domain(r) for r in d["items"]],
        "categories": categories,
        "trend": to_citation_trend(source_trend["data"]) if source_trend else None,
        "categoryTrend": (to_citation_trend(category_trend["data"], [c["name"] for c in categories])
                          if category_trend and categories is not None else None),
        "engineCategories": to_engine_categories(p["sources"]["data"]),
        "promptSplit": to_prompt_split(owned["data"], uncited["data"] if uncited else None) if owned else None,
    }


def competitor_options_of(d: dict) -> list[str]:
    """competitorOptionsOf: competitor sources by citations desc, then skey (localeCompare)."""
    rows = sort_by(list(d.get("competitor_sources") or []),
                   lambda a, b: (b["citations"] - a["citations"]) or locale_compare(a["skey"], b["skey"]))
    return [s["skey"] for s in rows]


# ── request params (citations.ts fetchers) ──────────────────────────────────

def pick_list(xs: list[str] | None) -> list[str]:
    """pickList: deduped, empty / over-long dropped, the first 100 in URL order, then sorted."""
    out = [x for x in dict.fromkeys(xs or []) if x and js_len(x) <= SKEY_MAX_LEN][:PICKS_MAX]
    return sorted(out, key=code_unit_key)


def domains_params(req: dict) -> dict:
    """domainsParams: only the C-1 list params that are set."""
    out: dict = {}
    if req.get("limit") is not None:
        out["limit"] = req["limit"]
    if req.get("cursor"):
        out["cursor"] = req["cursor"]
    q = js_trim(req["q"]) if isinstance(req.get("q"), str) else None
    if q:
        out["q"] = q
    if req.get("sort") and req["sort"] != "citations":
        out["sort"] = req["sort"]
    if req.get("dir"):
        out["dir"] = req["dir"]
    competitor = pick_list(req.get("competitor"))
    if competitor:
        out["competitor"] = competitor
    skey = pick_list(req.get("skey"))
    if skey:
        out["skey"] = skey
    if req.get("competitorSources"):
        out["competitor_sources"] = True
    if req.get("competitorTotals") is False:
        out["include_competitor_totals"] = False
    return out


def main_domains_request(surface: str, competitor: list[str] | None = None) -> dict:
    if surface == "global":
        return {"limit": STANDARD_TABLE_ROWS, "competitor": competitor or [], "competitorSources": True, "competitorTotals": False}
    return {"limit": DOMAIN_PAGE, "competitorTotals": False}


def sources_params(req: dict | None = None) -> dict:
    out: dict = {}
    if (req or {}).get("tone") is False:
        out["include_tone"] = False
    if (req or {}).get("types") is False:
        out["include_types"] = False
    return out


def main_sources_request(surface: str) -> dict:
    return {} if surface == "global" else {"tone": False, "types": False}


def prompts_params(req: dict) -> dict:
    out: dict = {"owned": req["owned"], "limit": req["limit"]}
    q = js_trim(req["q"]) if isinstance(req.get("q"), str) else None
    if q:
        out["q"] = q
    if req.get("cursor"):
        out["cursor"] = req["cursor"]
    if req.get("includeRefs") is False:
        out["include_refs"] = False
    if req.get("fields") == "text":
        out["fields"] = "text"
    if req.get("bothBuckets") and not req.get("cursor"):
        out["both_buckets"] = True
    return out


def split_prompts_request(surface: str) -> dict:
    if surface == "global":
        return {"owned": True, "limit": 1, "includeRefs": False, "fields": "text"}
    return {"owned": True, "limit": SPLIT_CARD_ROWS, "bothBuckets": True}


def tone_params(req: dict) -> dict:
    out: dict = {"tone": req["tone"], "group_by": req["groupBy"], "limit": req["limit"]}
    q = js_trim(req["q"]) if isinstance(req.get("q"), str) else None
    if q:
        out["q"] = q
    if req.get("cursor"):
        out["cursor"] = req["cursor"]
    if req.get("withCounts"):
        out["with_counts"] = True
    return out


# ── Δ and the previous round (citations.ts shareDeltas / prevCategoriesOf) ──

def prev_categories_of(trend: dict | None) -> dict | None:
    """prevCategoriesOf: the previous and last valued buckets' category totals of the category trend."""
    if not trend:
        return None
    data = trend["data"]
    valued = []
    for b in data["buckets"]:
        by_category: dict = {}
        total = None
        any_value = False
        for s in data["series"]:
            p = next((x for x in s["points"] if x.get("bucket") == b["key"]), None)
            if not p or p.get("gap") or not p.get("ratio"):
                continue
            any_value = True
            by_slug = LABEL_BY_SLUG.get(s["key"]) if s.get("key") else None
            name = _nn(_nn(_nn(by_slug, s.get("label")), s.get("key")), "")
            by_category[name] = _nn(by_category.get(name), 0) + p["ratio"]["num"]
            total = p["ratio"].get("den")
        if any_value and is_num(total) and total > 0:
            valued.append({"key": b["key"], "byCategory": by_category, "total": total})
    if len(valued) < 2:
        return None
    prev, last = valued[-2], valued[-1]
    return {"totals": {"total": prev["total"], "byCategory": prev["byCategory"]}, "asOf": prev["key"],
            "current": {"total": last["total"], "byCategory": last["byCategory"]}}


# ── website cards (citations.ts) ────────────────────────────────────────────

def targets_applicable(filters: dict) -> bool:
    return not filters.get("sourceCategory")


def empty_target_hit_rate() -> dict:
    return {"hitPrompts": 0, "ownedPrompts": 0, "measuredPrompts": 0, "rate": None, "ownedRate": None}


# ── sub pages ───────────────────────────────────────────────────────────────

def to_tone_url_row(r: dict, group_by: str) -> dict:
    return {"url": _nn(r.get("url"), None) if group_by == "url" else None, "domain": r["skey"],
            "title": _nn(r.get("title"), None), "promptText": _nn(r.get("prompt_text"), None),
            "citations": r["citations"], "providers": [provider_label(e) for e in r["engines"]],
            "category": _nn(category_label_of(r.get("category")), FALLBACK_CATEGORY)}


def page_window(total: float, page: float, page_size: float) -> dict:
    """pageWindow: the page (clamped), page count and the shown range."""
    pages = max(1, math.ceil(total / page_size))
    p = min(max(1, page), pages)
    frm = 0 if total == 0 else (p - 1) * page_size + 1
    to = min(total, p * page_size)
    return {"page": p, "pages": pages, "from": frm, "to": to}


# ── _data/citation-view.ts ──────────────────────────────────────────────────

def category_share(categories: list[dict] | None, name: str) -> float | None:
    """categoryShare: round1(100 * v / total); no categories or total 0 -> None."""
    if categories is None:
        return None
    total = _sum(c["value"] for c in categories)
    if total <= 0:
        return None
    v = next((c["value"] for c in categories if c["name"] == name), None)
    return round1((100 * _nn(v, 0)) / total)


def category_bars(categories: list[dict] | None, total_override: float | None = None) -> list[dict]:
    """categoryBars: value desc (then name, localeCompare); pct of the total (or the override)."""
    if categories is None:
        return []
    total = total_override if total_override is not None else _sum(c["value"] for c in categories)
    ordered = sort_by(list(categories), lambda a, b: (b["value"] - a["value"]) or locale_compare(a["name"], b["name"]))
    return [{"name": c["name"], "value": c["value"], "pct": round1((100 * c["value"]) / total) if total > 0 else None}
            for c in ordered]


def largest_remainder_tenths(values: list[float]) -> list[int]:
    """largestRemainderTenths: shares in 0.1 steps summing to exactly 100.0."""
    den = _sum(values)
    if not den > 0:
        return [0 for _ in values]
    out = [math.floor((1000 * v) / den) for v in values]
    rem = [1000 * v - out[i] * den for i, v in enumerate(values)]
    left = 1000 - _sum(out)
    order = sorted(range(len(values)), key=lambda i: (-rem[i], -i))
    for i in order:
        if left <= 0 or rem[i] <= 0:
            break
        out[i] += 1
        left -= 1
    return out


def type_category_bars(rows: list[dict] | None) -> dict:
    """typeCategoryBars: series by total desc (then name), per type 100% segments + the official share."""
    if not rows:
        return {"series": [], "bars": []}
    totals: dict = {}
    for r in rows:
        for c, v in js_entries(r["byCategory"]):
            totals[c] = _nn(totals.get(c), 0) + v
    series = [c for c, _ in sort_by(list(totals.items()), lambda a, b: (b[1] - a[1]) or locale_compare(a[0], b[0]))]
    bars = []
    for r in rows:
        total = r["total"]
        values = [_nn(r["byCategory"].get(name), 0) for name in series]
        tenths = largest_remainder_tenths(values)
        segments = [{"name": name, "value": values[i], "pct": tenths[i] / 10} for i, name in enumerate(series)]
        segments = [s for s in segments if s["value"] > 0 or s["pct"] > 0]
        official = _nn(r["byCategory"].get(OFFICIAL_HMG_CATEGORY), 0)
        bars.append({"type": r["type"], "total": total, "segments": segments,
                     "officialPct": round1((100 * official) / total) if total > 0 else None})
    return {"series": series, "bars": bars}


def apply_competitor_pick(rows: list[dict], picked: list[str]) -> list[dict]:
    """applyCompetitorPick: Official (Competitor) rows only for the picked domains; no pick -> all."""
    if not picked:
        return rows
    chosen = set(picked)
    return [r for r in rows if r.get("category") != OFFICIAL_COMPETITOR_CATEGORY or r["domain"] in chosen]


def apply_competitor_pick_to_categories(categories: list[dict] | None, domains: list[dict], picked: list[str]) -> list[dict] | None:
    """applyCompetitorPickToCategories: the Official (Competitor) value = the picked domains' citations."""
    if categories is None:
        return None
    if not picked:
        return categories
    chosen = set(picked)
    value = _sum(d["citations"] for d in domains if d.get("category") == OFFICIAL_COMPETITOR_CATEGORY and d["domain"] in chosen)
    return [{**c, "value": value} if c["name"] == OFFICIAL_COMPETITOR_CATEGORY else c for c in categories]


def category_included(active: list[str], name: str) -> bool:
    return len(active) == 0 or name in active


def citation_drilldown_empty_key(row: dict, tab: str) -> str:
    """citationDrilldownEmptyKey: the empty-list message key of a row's drilldown tab."""
    official = row.get("category") == OFFICIAL_HMG_CATEGORY and not row.get("drilldownOmitted")
    api_row = bool(row.get("skey"))
    if tab == "urls":
        return "drilldown.noUrlsOfficial" if official or api_row else "drilldown.noUrls"
    if official and not api_row and len(row.get("urls") or []) > 0:
        return "drilldown.promptsTopOnly"
    return "drilldown.noPrompts"


# ── citations-standard-view.tsx rules ───────────────────────────────────────

def prev_category_share(prev: dict | None, name: str) -> float | None:
    """prevCategoryShare: Math.round(1000 * v / total) / 10 of a round's totals; None without totals."""
    if not prev or prev["totals"]["total"] <= 0:
        return None
    return js_round((1000 * _nn(prev["totals"]["byCategory"].get(name), 0)) / prev["totals"]["total"]) / 10


def delta_pp(current: float | None, previous: float | None) -> float | None:
    """_data/kpi-view deltaPp."""
    if current is None or previous is None:
        return None
    return round1(current - previous)


def category_delta(prev: dict | None, name: str, current: float | None) -> float | None:
    """CategoryDelta (dash) / categoryDelta (renewal): Δpp vs the previous round, both sides one round."""
    previous = prev_category_share(prev, name)
    if previous is None:
        return None
    base = prev_category_share({"totals": prev["current"]}, name) if prev and prev.get("current") else current
    return delta_pp(base, previous)


def official_delta_value(card: dict | None, prev: dict | None, current: float | None) -> float | None:
    """OfficialDelta: the Overview card Δ when there is one, else the category Δ."""
    if card:
        return card["delta"]
    return category_delta(prev, OFFICIAL_HMG_CATEGORY, current)


def delta_basis(card: dict | None, prev: dict | None) -> dict | None:
    """StatusBasis: the dates of the Δ basis line (card: own round + category round; else the category round)."""
    if card:
        return {"kind": "card", "ownDate": card["basisDate"], "categoryDate": _nn((prev or {}).get("asOf"), card["basisDate"])}
    if not prev:
        return None
    return {"kind": "category", "categoryDate": prev["asOf"]}


def engine_chart(data: list[dict] | None) -> dict | None:
    """EngineCategoryChart: series by total desc (stable), one row per engine with every series (0 filled)."""
    if not data:
        return None
    totals: dict = {}
    for e in data:
        for c, v in js_entries(e["byCategory"]):
            totals[c] = _nn(totals.get(c), 0) + v
    series = [c for c, _ in sort_by(list(totals.items()), lambda a, b: b[1] - a[1])]
    rows = [{"engine": e["engine"], **{s: _nn(e["byCategory"].get(s), 0) for s in series}} for e in data]
    return {"series": series, "rows": rows}


def donut_official_pct(categories: list[dict], total_override: float | None = None) -> float | None:
    """CategoryDonut centre: round1(100 * official / total) (the status tile rounding); total 0 -> None."""
    total = total_override if total_override is not None else _sum(c["value"] for c in categories)
    official = _nn(next((c["value"] for c in categories if c["name"] == OFFICIAL_HMG_CATEGORY), None), 0)
    return js_round(((100 * official) / total) * 10) / 10 if total > 0 else None


def category_share_raw(categories: list[dict] | None, name: str) -> float | None:
    """formatCategoryShare (website/project tiles): the unrounded 100 * v / total (toFixed(1) in the front)."""
    if not categories:
        return None
    total = _sum(c["value"] for c in categories)
    if not total:
        return None
    v = _nn(next((c["value"] for c in categories if c["name"] == name), None), 0)
    return (100 * v) / total


def standard_status(live: dict, card: dict | None, prev: dict | None, active: list[str], sections: dict | None) -> dict:
    """StatusBlock: 공식(HMG) and dealer shares with their Δ, the split tiles, the Δ basis."""
    categories = live.get("categories")
    official_own = category_share(categories, OFFICIAL_HMG_CATEGORY)
    dealer = category_share(categories, DEALER_CATEGORY)
    own_included = category_included(active, OFFICIAL_HMG_CATEGORY)
    split = live.get("promptSplit")
    return {
        "officialOwn": official_own,
        "dealer": dealer,
        "officialDelta": official_delta_value(card, prev, official_own),
        "dealerDelta": category_delta(prev, DEALER_CATEGORY, dealer),
        "ownIncluded": own_included,
        "splitDegraded": own_included and not split and bool((sections or {}).get("split")),
        "tilesDisabled": not own_included or not split,
        "ownedCount": split["ownedCount"] if split else None,
        "uncitedCount": split["uncitedCount"] if split else None,
        "basis": delta_basis(card, prev),
    }


def standard_category_block(live: dict, prev: dict | None, picked: list[str], active: list[str]) -> dict:
    """CategoryBlock: picked categories, bars (denominator = all citations before the pick) with their Δ,
    the donut centre, the one-category flag."""
    categories = apply_competitor_pick_to_categories(live.get("categories"), live.get("domains") or [], picked)
    full_total = _sum(c["value"] for c in live.get("categories") or [])
    competitor_picked = len(picked) > 0
    bars = []
    for b in category_bars(categories, full_total):
        hidden = competitor_picked and b["name"] == OFFICIAL_COMPETITOR_CATEGORY
        bars.append({**b, "delta": None if hidden else category_delta(prev, b["name"], b["pct"])})
    return {"competitorPicked": competitor_picked, "bars": bars, "categories": categories,
            "officialPct": donut_official_pct(categories, full_total) if categories is not None else None,
            "single": len(active) == 1}


def numbered_rows(rows: list[dict], rule: str, offset: int = 0) -> list[dict]:
    """The '#' of a domain table row: rank (global; renewal first page: position after the pick),
    else matchRank, else the position in the loaded list (offset + i + 1)."""
    out = []
    for i, r in enumerate(rows):
        if rule == "position":
            no = offset + i + 1
        else:
            key = "rank" if rule == "rank" else "matchRank"
            no = r[key] if is_num(r.get(key)) else offset + i + 1
        out.append({**r, "no": no})
    return out


def prompt_drilldown(detail: dict) -> dict:
    """CitationPromptsDrilldown: each prompt's share of the source's citations (the row total) and the
    precomputed orders of its sort headers (prompt = localeCompare, citations and share = citations)."""
    total = detail.get("citations")
    with_share = is_num(total) and total > 0
    prompts = detail["promptList"]
    for p in prompts:
        p["share"] = (100 * p["citations"]) / total if with_share else None
    by_text = sort_by(list(range(len(prompts))), lambda a, b: locale_compare(prompts[a]["promptText"], prompts[b]["promptText"]))
    by_text_desc = sort_by(list(range(len(prompts))), lambda a, b: -locale_compare(prompts[a]["promptText"], prompts[b]["promptText"]))
    by_cit = sort_by(list(range(len(prompts))), lambda a, b: prompts[a]["citations"] - prompts[b]["citations"])
    by_cit_desc = sort_by(list(range(len(prompts))), lambda a, b: -(prompts[a]["citations"] - prompts[b]["citations"]))
    cit = {"asc": by_cit, "desc": by_cit_desc}
    return {"prompt": {"asc": by_text, "desc": by_text_desc}, "citations": cit, "share": dict(cit)}


# ── renewal citation-model.ts ───────────────────────────────────────────────

DELTA_AXIS_MIN = 0.5
MATRIX_MIN_N = 30
BUMP_MOVERS = 3
FINDINGS_MAX = 4
TYPE_STRENGTH = ("final_choice", "recommendation", "comparison", "definition", "mention")
MOVED_MIN = 0.05
TABLE_LIMIT = 100


def category_share_series(trend: dict | None) -> dict | None:
    """categoryShareSeries: weekly share (%) of every category; a gap or empty week is None."""
    if not trend or not trend["points"]:
        return None
    weeks = [js_str(_nn(p.get("week"), "")) for p in trend["points"]]
    by_category: dict = {s: [] for s in trend["series"]}
    for p in trend["points"]:
        vals = [p.get(s) if is_num(p.get(s)) else None for s in trend["series"]]
        total = _sum(_nn(v, 0) for v in vals)
        gap = bool(p.get("gap")) or all(v is None for v in vals)
        for i, s in enumerate(trend["series"]):
            by_category[s].append(None if gap or total <= 0 else (100 * _nn(vals[i], 0)) / total)
    return {"weeks": weeks, "byCategory": by_category}


def rn_official_delta(card: dict | None, prev: dict | None, current: float | None) -> dict:
    if card:
        return {"value": card["delta"], "basis": "card", "date": card["basisDate"]}
    value = category_delta(prev, OFFICIAL_HMG_CATEGORY, current)
    return {"value": value, "basis": None if value is None else "category", "date": (prev or {}).get("asOf")}


def category_rows(live: dict, prev: dict | None, card: dict | None, picked: list[str]) -> list[dict]:
    """categoryRows: one ranked list of the categories with share, previous share, Δ, trend, top domains."""
    categories = apply_competitor_pick_to_categories(live.get("categories"), live.get("domains") or [], picked)
    full_total = _sum(c["value"] for c in live.get("categories") or [])
    shares = category_share_series(live.get("categoryTrend"))
    domains = apply_competitor_pick(live.get("domains") or [], picked)
    out = []
    for b in category_bars(categories, full_total):
        hidden = len(picked) > 0 and b["name"] == OFFICIAL_COMPETITOR_CATEGORY
        if hidden:
            delta = None
        elif b["name"] == OFFICIAL_HMG_CATEGORY:
            delta = rn_official_delta(card, prev, category_share(live.get("categories"), OFFICIAL_HMG_CATEGORY))["value"]
        else:
            delta = category_delta(prev, b["name"], b["pct"])
        own = [d for d in domains if d.get("category") == b["name"]][:3]
        out.append({"name": b["name"], "value": b["value"], "pct": b["pct"],
                    "prevPct": None if hidden else prev_category_share(prev, b["name"]), "delta": delta,
                    "deltaHidden": hidden, "trend": shares["byCategory"].get(b["name"]) if shares else None,
                    "top": [{"domain": d["domain"], "pct": round1((100 * d["citations"]) / b["value"])} for d in own] if b["value"] > 0 else []})
    return out


def delta_axis(rows: list[dict]) -> float:
    m = max([0, *(abs(_nn(r.get("delta"), 0)) for r in rows)])
    return max(DELTA_AXIS_MIN, math.ceil(m * 10) / 10)


def lens(live: dict, prev: dict | None, card: dict | None, active: list[str], sections: dict | None) -> dict:
    """lens: the 공식(HMG) / dealer tiles and the prompt split state."""
    shares = category_share_series(live.get("categoryTrend"))
    hmg = category_share(live.get("categories"), OFFICIAL_HMG_CATEGORY) if category_included(active, OFFICIAL_HMG_CATEGORY) else None
    dealer = category_share(live.get("categories"), DEALER_CATEGORY) if category_included(active, DEALER_CATEGORY) else None
    dealer_d = category_delta(prev, DEALER_CATEGORY, dealer)
    split = live.get("promptSplit", "__missing__")
    if not category_included(active, OFFICIAL_HMG_CATEGORY):
        state = {"kind": "noOwnCategory"}
    elif split and split != "__missing__":
        state = {"kind": "ok", "owned": split["ownedCount"], "uncited": split["uncitedCount"]}
    elif (sections or {}).get("split"):
        state = {"kind": "degraded"}
    elif split == "__missing__":
        state = {"kind": "notComputed"}
    else:
        state = {"kind": "noOwned"}
    hmg_spark = shares["byCategory"].get(OFFICIAL_HMG_CATEGORY) if shares else None
    dealer_spark = shares["byCategory"].get(DEALER_CATEGORY) if shares else None
    return {
        "hmg": {"value": hmg, "delta": rn_official_delta(card, prev, hmg), "spark": _nn(hmg_spark, [])},
        "dealer": {"value": dealer, "delta": {"value": dealer_d, "basis": None if dealer_d is None else "category",
                                              "date": (prev or {}).get("asOf")}, "spark": _nn(dealer_spark, [])},
        "split": state,
    }


def lens_view(lens_: dict) -> dict:
    """ShareTile / PromptTile: + whether a tile draws its sparkline, each prompt tile's share of both."""
    out = {k: dict(v) for k, v in lens_.items()}
    for k in ("hmg", "dealer"):
        out[k]["sparkOn"] = out[k]["value"] is not None and any(v is not None for v in out[k]["spark"])
    s = out["split"]
    if s["kind"] == "ok":
        n = s["owned"] + s["uncited"]
        s["ownedPct"] = js_round((100 * s["owned"]) / n) if n > 0 else None
        s["uncitedPct"] = js_round((100 * s["uncited"]) / n) if n > 0 else None
    return out


def matrix(source: list[dict], order: list[str]) -> dict:
    """matrix: category share per column vs the columns' own total, the coloured columns and the gap cap."""
    extra: dict = {}
    for s in source:
        for k in js_keys(s["byCategory"]):
            if k not in order:
                extra[k] = None
    rows = [*order, *sorted(extra, key=code_unit_key)]
    total = _sum(s["total"] for s in source)
    base = {k: (100 * _sum(_nn(s["byCategory"].get(k), 0) for s in source)) / total if total > 0 else 0 for k in rows}
    cols = [{"key": s["key"], "n": s["total"],
             "counts": {k: _nn(s["byCategory"].get(k), 0) for k in rows},
             "shares": {k: (100 * _nn(s["byCategory"].get(k), 0)) / s["total"] if s["total"] > 0 else 0 for k in rows},
             "thin": s["total"] < MATRIX_MIN_N} for s in source]
    live_cols = [c["key"] for c in cols if not c["thin"]] if len(cols) > 1 else []
    gaps = [abs(c["shares"][k] - base[k]) for c in cols if c["key"] in live_cols for k in rows]
    return {"cols": cols, "rows": rows, "base": base, "total": total, "live": live_cols,
            "cap": max(3, math.ceil(max([0, *gaps])))}


def engine_matrix(slices: list[dict] | None, order: list[str]) -> dict | None:
    if not slices:
        return None
    return matrix([{"key": s["engine"], "total": s["total"], "byCategory": s["byCategory"]} for s in slices], order)


def type_matrix(rows: list[dict] | None, order: list[str]) -> dict | None:
    if not rows:
        return None
    by = {r["type"]: r for r in rows}
    cols = [by[t] for t in TYPE_STRENGTH if by.get(t)]
    if not cols:
        return None
    return matrix([{"key": r["type"], "total": r["total"], "byCategory": r["byCategory"]} for r in cols], order)


def matrix_view(m: dict | None, one_source: bool) -> dict | None:
    """MatrixBody / MatrixActions: + each cell's gap to 전체, the 전체 counts (one source picked), any thin column."""
    if m is None:
        return None
    return {**m, "gaps": {c["key"]: {k: c["shares"][k] - m["base"][k] for k in m["rows"]} for c in m["cols"]},
            "baseCounts": {k: js_round((m["base"][k] * m["total"]) / 100) for k in m["rows"]},
            "anyThin": any(c["thin"] for c in m["cols"]), "oneSource": one_source}


def strongest_skew(engine: dict | None, type_: dict | None) -> dict | None:
    best = None
    for axis, m in (("engine", engine), ("type", type_)):
        if not m:
            continue
        for c in m["cols"]:
            if c["key"] not in m["live"]:
                continue
            for k in m["rows"]:
                if k == OFFICIAL_HMG_CATEGORY:
                    continue
                gap = c["shares"][k] - m["base"][k]
                if not best or abs(gap) > abs(best["gap"]):
                    best = {"axis": axis, "col": c["key"], "category": k, "share": c["shares"][k], "base": m["base"][k], "gap": gap}
    return best


def domain_bump(trend: dict | None, domains: list[dict]) -> dict | None:
    """domainBump: the weekly rank of every trend domain (ties keep the series order) and the movers."""
    if not trend or not trend["series"] or not trend["points"]:
        return None
    x = [js_str(_nn(p.get("week"), "")) for p in trend["points"]]
    values = [[p.get(s) if not p.get("gap") and is_num(p.get(s)) else None for p in trend["points"]] for s in trend["series"]]
    ranks: list[list] = [[None for _ in x] for _ in trend["series"]]
    for i in range(len(x)):
        present = [(j, values[j][i]) for j in range(len(trend["series"])) if values[j][i] is not None]
        present = sort_by(present, lambda a, b: (b[1] - a[1]) or (a[0] - b[0]))
        for r, (j, _) in enumerate(present):
            ranks[j][i] = r + 1
    measured = [any(rk[i] is not None for rk in ranks) for i in range(len(x))]
    first = measured.index(True) if True in measured else -1
    last = len(measured) - 1 - measured[::-1].index(True) if True in measured else -1
    own = {d["domain"] for d in domains if d.get("isOurs")}
    series = [{"key": key, "own": key in own, "values": values[j], "ranks": ranks[j]} for j, key in enumerate(trend["series"])]
    movers = []
    if first >= 0 and last > first:
        cands = [{"key": s["key"], "own": s["own"], "r0": s["ranks"][first], "r1": s["ranks"][last]} for s in series]
        cands = [m for m in cands if not m["own"] and m["r0"] is not None and m["r1"] is not None and m["r0"] != m["r1"]]
        cands = sort_by(cands, lambda a, b: (abs(b["r0"] - b["r1"]) - abs(a["r0"] - a["r1"])) or (a["r1"] - b["r1"]))
        movers = [{"key": m["key"], "move": m["r0"] - m["r1"]} for m in cands[:BUMP_MOVERS]]
    return {"x": x, "series": series, "first": first, "last": last, "movers": movers}


def bump_view(d: dict | None, domains: list[dict]) -> dict | None:
    """DomainBumpCard / BumpChart: + measured weeks, the draw order (context, movers, own last), each
    series' rank move first -> last and its row in the domain list (the drawer)."""
    if d is None:
        return None
    movers = {m["key"] for m in d["movers"]}
    emph = lambda s: s["own"] or s["key"] in movers  # noqa: E731
    order = sort_by(list(range(len(d["series"]))),
                    lambda a, b: (int(emph(d["series"][a])) - int(emph(d["series"][b])))
                    or (int(d["series"][a]["own"]) - int(d["series"][b]["own"])))
    measured = sum(1 for i in range(len(d["x"])) if any(s["ranks"][i] is not None for s in d["series"]))
    index = {}
    for i, r in enumerate(domains):
        index.setdefault(r["domain"], i)
    series = []
    for s in d["series"]:
        r1 = s["ranks"][d["last"]] if d["last"] >= 0 else None
        r0 = s["ranks"][d["first"]] if d["first"] >= 0 else None
        series.append({**s, "move": (r0 - r1) if r1 is not None and r0 is not None else None,
                       "domainIndex": index.get(s["key"], -1)})
    return {**d, "series": series, "drawOrder": order, "measured": measured}


def findings(rows: list[dict], hmg_delta: float | None, picked: list[str], engine: dict | None, type_: dict | None,
             split: dict, bump: dict | None) -> list[dict]:
    """findings: the round summary items (kind, tone, priority, jump target and message params), top 4."""
    out = []
    hi = next((i for i, r in enumerate(rows) if r["name"] == OFFICIAL_HMG_CATEGORY), -1)
    if hi >= 0 and len(rows) > 1 and rows[hi]["pct"] is not None:
        o = rows[hi]
        other = rows[1] if hi == 0 else rows[0]
        delta = hmg_delta if hmg_delta is not None else ""
        if hi == 0:
            out.append({"kind": "standingLead", "tone": "good", "pri": 3, "target": "sec-comp", "key": o["name"],
                        "params": {"rival": other["name"], "gap": round1(_nn(o["pct"], 0) - _nn(other["pct"], 0)), "delta": delta}})
        else:
            out.append({"kind": "standingTrail", "tone": "warn", "pri": 8, "target": "sec-comp", "key": o["name"],
                        "params": {"rank": hi + 1, "share": _nn(o["pct"], 0), "leader": other["name"],
                                   "leaderShare": _nn(other["pct"], 0), "delta": delta}})
    cands = [r for r in rows if r["delta"] is not None and r["name"] != OFFICIAL_HMG_CATEGORY
             and not (r["name"] == OFFICIAL_COMPETITOR_CATEGORY and len(picked) > 0)]
    cands = sort_by(cands, lambda a, b: abs(b["delta"]) - abs(a["delta"]))
    mover = cands[0] if cands else None
    if mover and abs(mover["delta"]) >= 0.05:
        rival = mover["name"] == OFFICIAL_COMPETITOR_CATEGORY and mover["delta"] > 0
        out.append({"kind": "mover", "tone": "warn" if rival else "info", "pri": 7 if rival else 4, "target": "sec-comp",
                    "key": mover["name"], "params": {"category": mover["name"], "delta": mover["delta"], "share": _nn(mover["pct"], 0)}})
    if engine and len(engine["live"]) > 1 and OFFICIAL_HMG_CATEGORY in engine["rows"]:
        vals = [{"key": c["key"], "v": c["shares"][OFFICIAL_HMG_CATEGORY]} for c in engine["cols"] if c["key"] in engine["live"]]
        vals = sort_by(vals, lambda a, b: a["v"] - b["v"])
        lo, top = vals[0], vals[-1]
        gap = round1(top["v"] - lo["v"])
        out.append({"kind": "engineGap", "tone": "warn" if gap >= 4 else "info", "pri": 6 if gap >= 4 else 1, "target": "sec-mix",
                    "key": OFFICIAL_HMG_CATEGORY, "axis": "engine",
                    "params": {"low": lo["key"], "lowShare": lo["v"], "high": top["key"], "gap": gap}})
    if type_ and OFFICIAL_HMG_CATEGORY in type_["rows"]:
        def col(k: str):
            return next((c for c in type_["cols"] if c["key"] == k and k in type_["live"]), None)
        rec, men = col("recommendation"), col("mention")
        if rec and men:
            gap = round1(rec["shares"][OFFICIAL_HMG_CATEGORY] - men["shares"][OFFICIAL_HMG_CATEGORY])
            out.append({"kind": "typeGap", "tone": "warn" if gap < -1.5 else "good", "pri": 7 if gap < -1.5 else 2,
                        "target": "sec-mix", "key": OFFICIAL_HMG_CATEGORY, "axis": "type",
                        "params": {"rec": rec["shares"][OFFICIAL_HMG_CATEGORY], "gap": gap}})
    if split.get("kind") == "ok" and split["owned"] + split["uncited"] > 0 and split["uncited"] > 0:
        sh = round1((100 * split["uncited"]) / (split["owned"] + split["uncited"]))
        out.append({"kind": "opportunity", "tone": "warn", "pri": 6 if sh >= 40 else 3, "target": "sec-overview", "href": "uncited",
                    "params": {"n": split["uncited"], "share": sh}})
    sk = strongest_skew(engine, type_)
    if sk and abs(sk["gap"]) >= 1:
        out.append({"kind": "skew", "tone": "info", "pri": 5 if abs(sk["gap"]) >= 5 else 1, "target": "sec-mix", "key": sk["category"],
                    "axis": sk["axis"], "params": {"col": sk["col"], "category": sk["category"], "gap": round1(sk["gap"]),
                                                   "share": sk["share"], "base": sk["base"]}})
    if bump and bump["last"] > bump["first"]:
        climbs = [{"s": s, "r0": s["ranks"][bump["first"]], "r1": s["ranks"][bump["last"]]} for s in bump["series"]]
        climbs = [c for c in climbs if c["r0"] is not None and c["r1"] is not None and c["r0"] > c["r1"]]
        climbs = sort_by(climbs, lambda a, b: b["r0"] - b["r1"] - (a["r0"] - a["r1"]))
        if climbs:
            c = climbs[0]
            out.append({"kind": "climb", "tone": "good" if c["s"]["own"] else "info", "pri": 5 if c["r0"] - c["r1"] >= 3 else 2,
                        "target": "sec-dom", "key": c["s"]["key"],
                        "params": {"domain": c["s"]["key"], "from": c["r0"], "to": c["r1"], "weeks": bump["last"] - bump["first"] + 1,
                                   "n": len(bump["series"])}})
    return sort_by(out, lambda a, b: b["pri"] - a["pri"])[:FINDINGS_MAX]


def ranked_domains(domains: list[dict], picked: list[str]) -> list[dict]:
    """rankedDomains: the rows after the competitor pick, numbered before any search (rank = i + 1)."""
    return [{**r, "rank": i + 1} for i, r in enumerate(apply_competitor_pick(list(domains), picked))]


def table_views(rows: list[dict]) -> dict:
    """DomainTableCard over the first 100 rows of a list: per category picked in its select ("" = all)
    the row indices and the bar scales (Math.max(1, ...citations / coverage))."""
    base = rows[:TABLE_LIMIT]
    keys = [""] + list(dict.fromkeys(r.get("category") for r in base if r.get("category")))
    out = {}
    for key in keys:
        idx = [i for i, r in enumerate(base) if not key or r.get("category") == key]
        out[key] = {"idx": idx, "maxCit": max([1, *(base[i]["citations"] for i in idx)]),
                    "maxCov": max([1, *(base[i]["coverageRate"] for i in idx)])}
    return out


def category_options(categories: list[dict] | None) -> list[str]:
    """The table's category select: live.categories by value desc (stable)."""
    return [c["name"] for c in sort_by(list(categories or []), lambda a, b: b["value"] - a["value"])]
