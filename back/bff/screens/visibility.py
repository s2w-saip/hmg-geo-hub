"""Renewal AI Visibility screens (/renewal/standard/ai-funnel/visibility).

The page reads what the original screen reads — GET /v1/analytics/visibility (hub_stores/
analytics_reader.py visibility(): pages, devices rows, bots rows, priorities, trend, sites) — once for
the period and once for the previous period of the same length, and derives every number from those
rows: sums, ratios, counts, ranks and date differences. Nothing is estimated or filled in.

Rules (first written as the AI Visibility mockup's 검토 메모 '계산'; the mockup was deleted on 2026-10-28 and
this list is now the source):
- AI 크롤 = bots hits (the reader's engine filter applies to it), 검색 노출 = devices impressions (the
  device filter applies to it); a page whose period sum is null (a day without an observation) is
  kept in the table and left out of every sum, share and ratio (`incomplete`).
- 커버리지 = pages with AI 크롤 ≥ 1 ÷ pages; 관심도 = AI 크롤 ÷ 검색 노출 × 10,000.
- 기대 크롤 = page 검색 노출 × (AI 크롤 ÷ 검색 노출 of the whole selection): a comparison baseline,
  not a prediction. 달성률 = actual ÷ expected, 부족분 = expected − actual (positive part).
- 읽힌 날 = observed days with AI 크롤 ≥ 1 ÷ observed days; 마지막 크롤 = last observed day − the
  last day with AI 크롤 ≥ 1.
- 집중도 = the top 10 % pages' share of AI 크롤, Lorenz curve, Gini = 1 − 2 × area under the curve.
- URL 섹션 = the first path segment after the 2-letter country / language segments.
- 7-day blocks count back from the period's last day; a shorter first block is left out.
- The original's quadrant (upper-median rule) stays on every page row so its counts can be compared.
Findings are codes + params; the front turns them into text."""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Any
from urllib.parse import urlsplit

from bff import api
from bff.hub_stores.analytics_reader import BRAND_NAMES
from bff.screens import screen, split_context
from bff.screens._days import blocks_of, days_of, period_choice, period_params, prev_period, reader_query  # noqa: F401 (period_params: tests)
from bff.screens._filters import load_panel_options, read_standard_filters, split_filter_values
from bff.screens._query import READER_SCOPE
from bff.screens._sort import table_orders

STALE_DAYS = 7
WORK_ROWS = 15
CHANGE_ROWS = 5
COMBO_ROWS = 8
LORENZ_POINTS = 120
TIERS = (1, 2, 3, None)
BANDS = ("none", "low", "mid", "high")
FREQS = ("daily", "often", "rare", "none")
QUADS = ("seo_only", "crawl_only", "both", "neither")
LOCALE_SEGMENT = re.compile(r"[a-z]{2}(-[a-z]{2})?", re.IGNORECASE)


# ── row helpers ──────────────────────────────────────────────────────────────

def section_of(url: Any) -> str:
    path = urlsplit(url).path if isinstance(url, str) and "://" in url else str(url or "")
    segs = [s for s in path.split("/") if s]
    i = 0
    while i < len(segs) and i < 2 and LOCALE_SEGMENT.fullmatch(segs[i]):
        i += 1
    return f"/{segs[i]}" if i < len(segs) else "/"


def path_of(url: Any) -> str:
    if not isinstance(url, str):
        return ""
    parts = urlsplit(url)
    return parts.path or "/" if parts.netloc else url


def share(n: float | None, d: float | None) -> float | None:
    return 100 * n / d if n is not None and d else None


def change_pct(cur: float | None, prev: float | None) -> float | None:
    return 100 * (cur - prev) / prev if cur is not None and prev else None


def _sum(values) -> float:
    return sum(v for v in values if v is not None)


def median(values: list[float]) -> float | None:
    if not values:
        return None
    s = sorted(values)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def rank_levels(values: list[float | None], higher_better: bool = True) -> list[int | None]:
    """5 levels by rank inside the column (ties share the average rank); None stays None."""
    xs = [v for v in values if v is not None]
    out: list[int | None] = []
    for v in values:
        if v is None or len(xs) < 2:
            out.append(None)
            continue
        below = sum(1 for x in xs if (x < v if higher_better else x > v))
        same = sum(1 for x in xs if x == v)
        rk = (below + (same - 1) / 2) / (len(xs) - 1)
        out.append(min(4, int(rk * 5)))
    return out


def fixed_level(v: float | None) -> int | None:
    """Fixed % bands for coverage-like columns (95 · 85 · 70 · 50)."""
    if v is None:
        return None
    return 4 if v >= 95 else 3 if v >= 85 else 2 if v >= 70 else 1 if v >= 50 else 0


def _engines_of(bots: list[dict]) -> list[str]:
    return list(dict.fromkeys(r.get("engine") or "unknown" for r in bots))


# ── the page model ───────────────────────────────────────────────────────────

def _page_rows(data: dict, sel_engines: list[str], sel_devices: list[str]) -> tuple[list[dict], list[str], list[str], dict[str, int]]:
    """Every page of the reader's answer with its daily AI 크롤 (by engine) and 검색 노출."""
    period = data.get("period") or {}
    days = days_of(period["from"], period["to"]) if period.get("from") and period.get("to") else []
    di = {d: i for i, d in enumerate(days)}
    engines = _engines_of(data.get("bots") or [])
    sites = {r.get("project_key"): r for r in data.get("properties") or []}
    prio = {(r.get("project_key"), r.get("url_key")): r.get("priority") for r in data.get("priorities") or []}
    daily_ai: dict[tuple, dict[str, list[int]]] = defaultdict(lambda: {e: [0] * len(days) for e in engines})
    for r in data.get("bots") or []:
        i = di.get(str(r.get("date"))[:10])
        if i is not None and r.get("hits") is not None:
            daily_ai[(r.get("project_key"), r.get("url_key"))][r.get("engine") or "unknown"][i] += r["hits"]
    daily_seo: dict[tuple, list[int]] = defaultdict(lambda: [0] * len(days))
    devices: dict[str, int] = defaultdict(int)
    for r in data.get("devices") or []:
        v = r.get("seo_impressions")
        if v is None:
            continue
        devices[r.get("device") or "unknown"] += v
        i = di.get(str(r.get("date"))[:10])
        if i is not None and (not sel_devices or r.get("device") in sel_devices):
            daily_seo[(r.get("project_key"), r.get("url_key"))][i] += v
    observed = sorted({str(t["date"])[:10] for t in data.get("trend") or [] if t.get("date")})
    obs_idx = [di[d] for d in observed if d in di]
    on = [e for e in engines if not sel_engines or e in sel_engines]
    pages = []
    for p in data.get("pages") or []:
        key = (p.get("project_key"), p.get("url_key"))
        eng = daily_ai[key]
        ai_day = [sum(eng[e][i] for e in on) for i in range(len(days))]
        read = [i for i in obs_idx if ai_day[i] > 0]
        site = sites.get(p.get("project_key")) or {}
        pages.append({
            "key": key, "url": p.get("url"), "title": p.get("title"), "path": path_of(p.get("url")), "section": section_of(p.get("url")),
            "brand": BRAND_NAMES.get(site.get("site_brand_bit")), "country": site.get("country") or p.get("country"),
            "prio": prio.get(key), "seo": p.get("seo_impressions"), "ai": p.get("ai_crawls"), "q": p.get("quadrant"),
            "eng": {e: sum(eng[e]) for e in engines}, "aiDay": ai_day, "seoDay": daily_seo[key],
            "readDays": len(read), "observed": len(obs_idx), "lastAgo": (obs_idx[-1] - read[-1]) if read and obs_idx else None,
        })
    return pages, engines, days, dict(devices)


def visibility_view(cur: dict, prev: dict | None, sel_engines: list[str], sel_devices: list[str]) -> dict:
    """The whole renewal view model from the reader's answers for the period and the previous period."""
    pages, engines, days, device_totals = _page_rows(cur, sel_engines, sel_devices)
    prev_by = {}
    prev_ok = False
    if prev is not None:
        prev_pages, _, prev_days, _ = _page_rows(prev, sel_engines, sel_devices)
        prev_ok = len(prev_days) == len(days) and bool(prev_pages)
        prev_by = {p["key"]: p for p in prev_pages}
    complete = [p for p in pages if p["seo"] is not None and p["ai"] is not None]
    n = len(complete)
    p1 = [p for p in complete if p["prio"] == 1]
    t_seo, t_ai = _sum(p["seo"] for p in complete), _sum(p["ai"] for p in complete)
    r = t_ai / t_seo if t_seo else 0
    # the original's quadrant medians are the reader's; derived values per page
    for p in pages:
        ok = p["seo"] is not None and p["ai"] is not None
        p["int"] = p["ai"] / p["seo"] * 1e4 if ok and p["seo"] else None
        p["exp"] = p["seo"] * r if ok else None
        p["ach"] = p["ai"] / p["exp"] if ok and p["exp"] else None
        p["short"] = max(0.0, p["exp"] - p["ai"]) if ok else None
        p["band"] = None if not ok else "none" if p["ai"] == 0 else "low" if p["ach"] is not None and p["ach"] < 0.5 else "mid" if p["ach"] is not None and p["ach"] < 1 else "high"
        p["read"] = p["readDays"] / p["observed"] if p["observed"] else None
        p["freq"] = None if p["read"] is None else "none" if p["readDays"] == 0 else "daily" if p["read"] >= 0.9 else "often" if p["read"] >= 0.5 else "rare"
        pv = prev_by.get(p["key"]) if prev_ok else None
        p["prevAi"] = pv["ai"] if pv else None
        p["d"] = p["ai"] - pv["ai"] if pv and p["ai"] is not None and pv["ai"] is not None else None
    stale1 = [p for p in p1 if p["lastAgo"] is None or p["lastAgo"] >= STALE_DAYS]
    totals: dict[str, Any] = {
        "seo": t_seo if complete else None, "ai": t_ai if complete else None, "pages": len(pages), "complete": n, "incomplete": len(pages) - n,
        "sites": len({p["key"][0] for p in pages}), "days": len(days), "observed": pages[0]["observed"] if pages else 0, "p1": len(p1),
        "int": t_ai / t_seo * 1e4 if t_seo else None, "cov": share(sum(1 for p in complete if p["ai"] > 0), n),
        "cov1": share(sum(1 for p in p1 if p["ai"] > 0), len(p1)), "stale1": len(stale1),
    }
    # 집중도
    asc = sorted(p["ai"] for p in complete)
    top_n = max(1, round(n / 10)) if n else 0
    lor, acc, area = [[0.0, 0.0]], 0.0, 0.0
    step = max(1, n // LORENZ_POINTS)
    for i, v in enumerate(asc):
        x0, y0 = i / n, acc / t_ai if t_ai else 0
        acc += v
        x1, y1 = (i + 1) / n, acc / t_ai if t_ai else 0
        area += (x1 - x0) * (y0 + y1) / 2
        if i % step == 0 or i == n - 1:
            lor.append([x1, y1])
    top = lambda q: share(_sum(asc[-max(1, round(n * q)):]), t_ai) if n else None  # noqa: E731
    totals.update({"top10": top(0.1), "topN": top_n, "gini": 1 - 2 * area if n and t_ai else None})
    # previous period
    if prev_ok:
        pc = [p for p in prev_by.values() if p["seo"] is not None and p["ai"] is not None]
        p_seo, p_ai = _sum(p["seo"] for p in pc), _sum(p["ai"] for p in pc)
        p1_prev = [prev_by[p["key"]] for p in p1 if p["key"] in prev_by and prev_by[p["key"]]["ai"] is not None]
        totals.update({"dAi": change_pct(t_ai, p_ai), "dSeo": change_pct(t_seo, p_seo),
                       "dInt": change_pct(totals["int"], p_ai / p_seo * 1e4 if p_seo else None),
                       "dCov1": totals["cov1"] - share(sum(1 for p in p1_prev if p["ai"] > 0), len(p1_prev)) if totals["cov1"] is not None and p1_prev else None})
    # daily series and 7-day blocks
    on = [e for e in engines if not sel_engines or e in sel_engines]
    eng_day = {e: [0] * len(days) for e in engines}
    ai_day = [sum(p["aiDay"][i] for p in complete) for i in range(len(days))]
    seo_day = [sum(p["seoDay"][i] for p in complete) for i in range(len(days))]
    eng_rows = cur.get("bots") or []
    di = {d: i for i, d in enumerate(days)}
    for row in eng_rows:
        i = di.get(str(row.get("date"))[:10])
        if i is not None and row.get("hits") is not None:
            eng_day[row.get("engine") or "unknown"][i] += row["hits"]
    blocks = blocks_of(days)
    blk = lambda arr, b: sum(arr[b[0]:b[1] + 1])  # noqa: E731
    spark = {"ai": [blk(ai_day, b) for b in blocks],
             "int": [blk(ai_day, b) / blk(seo_day, b) * 1e4 if blk(seo_day, b) else None for b in blocks],
             "cov1": [share(sum(1 for p in p1 if blk(p["aiDay"], b) > 0), len(p1)) for b in blocks],
             "stale1": [sum(1 for p in p1 if blk(p["aiDay"], b) == 0) for b in blocks]}
    # engines
    all_hits = sum(sum(v) for v in eng_day.values())
    prev_eng = {e: _sum(p["eng"].get(e) for p in prev_by.values()) for e in engines} if prev_ok else {}
    bots_by = defaultdict(lambda: defaultdict(int))
    for row in eng_rows:
        if row.get("hits") is not None:
            bots_by[row.get("engine") or "unknown"][row.get("bot") or "unknown"] += row["hits"]
    engine_rows = []
    for e in engines:
        hits = sum(eng_day[e])
        engine_rows.append({"engine": e, "on": e in on, "hits": hits, "share": share(hits, all_hits),
                            "cov": share(sum(1 for p in complete if p["eng"].get(e)), n), "cov1": share(sum(1 for p in p1 if p["eng"].get(e)), len(p1)),
                            "d": change_pct(hits, prev_eng.get(e)) if prev_ok else None, "spark": [blk(eng_day[e], b) for b in blocks],
                            "bots": [{"code": c, "hits": h, "share": share(h, all_hits)} for c, h in sorted(bots_by[e].items(), key=lambda kv: -kv[1])]})
    engine_rows.sort(key=lambda x: -x["hits"])
    engines = [x["engine"] for x in engine_rows]
    eng_share = []
    for b in blocks:
        tot = sum(blk(eng_day[e], b) for e in engines)
        eng_share.append([share(blk(eng_day[e], b), tot) or 0 for e in engines])
    combos: dict[tuple, int] = defaultdict(int)
    for p in complete:
        combos[tuple(e for e in engines if p["eng"].get(e))] += 1
    combo_rows = sorted(({"set": list(k), "n": c, "share": share(c, n)} for k, c in combos.items()), key=lambda x: (-x["n"], -len(x["set"])))
    # URL 섹션
    by_sec: dict[str, list[dict]] = defaultdict(list)
    for p in complete:
        by_sec[p["section"]].append(p)
    dev_all = _sum(device_totals.values())
    sections = []
    for sec, ps in by_sec.items():
        s_seo, s_ai = _sum(p["seo"] for p in ps), _sum(p["ai"] for p in ps)
        sections.append({"sec": sec, "pages": len(ps), "seo": s_seo, "ai": s_ai, "seoShare": share(s_seo, t_seo), "aiShare": share(s_ai, t_ai),
                         "gap": (share(s_ai, t_ai) or 0) - (share(s_seo, t_seo) or 0), "cov": share(sum(1 for p in ps if p["ai"] > 0), len(ps)),
                         "int": s_ai / s_seo * 1e4 if s_seo else None, "engCov": [share(sum(1 for p in ps if p["eng"].get(e)), len(ps)) for e in engines]})
    sections.sort(key=lambda s: -s["seo"])
    # 우선순위별 몫 · 읽힌 날
    tiers = []
    for k in TIERS:
        ps = [p for p in complete if p["prio"] == k]
        if ps:
            tiers.append({"prio": k, "pages": len(ps), "pageShare": share(len(ps), n), "seoShare": share(_sum(p["seo"] for p in ps), t_seo),
                          "aiShare": share(_sum(p["ai"] for p in ps), t_ai), "freq": [sum(1 for p in ps if p["freq"] == f) for f in FREQS]})
    # 사이트
    by_site: dict[Any, list[dict]] = defaultdict(list)
    for p in complete:
        by_site[p["key"][0]].append(p)
    sites = []
    for pk, ps in by_site.items():
        s_seo, s_ai = _sum(p["seo"] for p in ps), _sum(p["ai"] for p in ps)
        s_p1 = [p for p in ps if p["prio"] == 1]
        desc = sorted((p["ai"] for p in ps), reverse=True)
        prev_ai = _sum(prev_by[p["key"]]["ai"] for p in ps if p["key"] in prev_by and prev_by[p["key"]]["ai"] is not None) if prev_ok else None
        sites.append({"key": pk, "brand": ps[0]["brand"], "country": ps[0]["country"], "pages": len(ps), "seo": s_seo, "ai": s_ai,
                      "d": change_pct(s_ai, prev_ai), "int": s_ai / s_seo * 1e4 if s_seo else None,
                      "cov1": share(sum(1 for p in s_p1 if p["ai"] > 0), len(s_p1)), "read": median([p["read"] * 100 for p in ps if p["read"] is not None]),
                      "top10": share(sum(desc[:max(1, round(len(ps) / 10))]), s_ai),
                      "short": sum(1 for p in ps if p["prio"] in (1, 2) and p["band"] in ("none", "low")),
                      "stale1": sum(1 for p in s_p1 if p["lastAgo"] is None or p["lastAgo"] >= STALE_DAYS)})
    sites.sort(key=lambda s: -s["ai"])
    heat = {"ai": rank_levels([s["ai"] for s in sites]), "d": rank_levels([s["d"] for s in sites]), "int": rank_levels([s["int"] for s in sites]),
            "top10": rank_levels([s["top10"] for s in sites], higher_better=False), "short": rank_levels([s["short"] for s in sites], higher_better=False),
            "cov1": [fixed_level(s["cov1"]) for s in sites], "read": [fixed_level(s["read"]) for s in sites]}
    for i, s in enumerate(sites):
        s["heat"] = {k: v[i] for k, v in heat.items()}
    # page rows (the table, the scatter, the work list, the changes) — ids index into `rows`
    rows = [{"id": i, "url": p["url"], "title": p["title"], "path": p["path"], "section": p["section"], "brand": p["brand"], "country": p["country"],
             "prio": p["prio"], "seo": p["seo"], "ai": p["ai"], "exp": p["exp"], "ach": p["ach"], "short": p["short"], "band": p["band"],
             "int": p["int"], "read": p["read"], "ago": p["lastAgo"], "q": p["q"], "d": p["d"], "prevAi": p["prevAi"],
             "eng": [p["eng"].get(e, 0) for e in engines]} for i, p in enumerate(pages)]
    never = len(days) + 1  # never read in the period sorts as the stalest
    orders = table_orders(rows, {"prio": lambda x: x["prio"], "seo": lambda x: x["seo"], "ai": lambda x: x["ai"], "short": lambda x: x["short"],
                                 "int": lambda x: x["int"], "read": lambda x: x["read"],
                                 "ago": lambda x: (never if x["ago"] is None else x["ago"]) if x["ai"] is not None else None})
    weak = sorted((x for x in rows if x["band"] in ("none", "low")), key=lambda x: -x["short"])
    work = {"p12": [x["id"] for x in weak if x["prio"] in (1, 2)], "all": [x["id"] for x in weak]}
    bands = [{"band": b, "n": sum(1 for x in rows if x["band"] == b), "p1": sum(1 for x in rows if x["band"] == b and x["prio"] == 1),
              "seoShare": share(_sum(x["seo"] for x in rows if x["band"] == b), t_seo), "aiShare": share(_sum(x["ai"] for x in rows if x["band"] == b), t_ai)} for b in BANDS]
    changes = None
    if prev_ok:
        fresh = [x for x in rows if x["prevAi"] == 0 and (x["ai"] or 0) > 0]
        lost = [x for x in rows if (x["prevAi"] or 0) > 0 and x["ai"] == 0]
        up = sorted((x for x in rows if (x["d"] or 0) > 0), key=lambda x: -x["d"])
        down = sorted((x for x in rows if (x["d"] or 0) < 0), key=lambda x: x["d"])
        changes = {"fresh": [x["id"] for x in fresh], "lost": [x["id"] for x in lost], "up": [x["id"] for x in up[:CHANGE_ROWS]], "down": [x["id"] for x in down[:CHANGE_ROWS]]}
    view = {
        "days": days, "observed": totals["observed"], "blocks": [[days[a], days[b]] for a, b in blocks],
        "prevOk": prev_ok, "staleDays": STALE_DAYS, "expectedRate": r * 1e4 if t_seo else None, "totals": totals, "spark": spark,
        "trend": {"seo": seo_day, "ai": ai_day, "engines": [eng_day[e] for e in engines]},
        "engines": engine_rows, "engineShare": eng_share, "combos": combo_rows, "sections": sections, "tiers": tiers,
        "lorenz": {"points": lor, "top1": top(0.01), "top10": totals["top10"], "top50": top(0.5)},
        "devices": [{"device": d, "imp": v, "share": share(v, dev_all), "on": not sel_devices or d in sel_devices} for d, v in sorted(device_totals.items(), key=lambda kv: -kv[1])],
        "sites": sites, "multiBrand": len({s["brand"] for s in sites}) > 1, "rows": rows, "orders": orders, "work": work, "bands": bands, "changes": changes,
        "quads": [{"q": q, "n": sum(1 for x in rows if x["q"] == q)} for q in QUADS],
    }
    view["findings"] = findings(view)
    return view


def findings(v: dict) -> list[dict]:
    """이 기간 요약: up to four findings as codes + params (rows by id), most important first."""
    t, rows, out = v["totals"], v["rows"], []
    stale = [x for x in rows if x["prio"] == 1 and x["ai"] is not None and (x["ago"] is None or x["ago"] >= v["staleDays"])]
    if stale:
        out.append((9, {"code": "stale", "tone": "warn", "n": len(stale), "rows": [x["id"] for x in stale[:2]], "days": v["staleDays"]}))
    worst = min((s for s in v["sections"] if s["pages"] >= 3), key=lambda s: s["gap"], default=None)
    if worst and worst["gap"] <= -5:
        out.append((8, {"code": "section", "tone": "warn", "sec": worst["sec"], "seoShare": worst["seoShare"], "aiShare": worst["aiShare"],
                        "int": worst["int"], "totalInt": t["int"], "cov": worst["cov"]}))
    if v["work"]["p12"]:
        ids = v["work"]["p12"]
        out.append((7, {"code": "shortfall", "tone": "warn", "n": len(ids), "sum": _sum(rows[i]["short"] for i in ids), "row": ids[0]}))
    on = sorted((e for e in v["engines"] if e["on"] and e["hits"] and e["cov"] is not None), key=lambda e: e["cov"])
    if len(on) > 1 and on[-1]["cov"] - on[0]["cov"] >= 15:
        out.append((6, {"code": "engineCoverage", "tone": "info", "low": on[0]["engine"], "lowCov": on[0]["cov"], "lowCov1": on[0]["cov1"],
                        "high": on[-1]["engine"], "highCov": on[-1]["cov"], "highCov1": on[-1]["cov1"]}))
    if v["changes"] is not None and t.get("dAi") is not None:
        c = v["changes"]
        tone = "warn" if len(c["lost"]) > len(c["fresh"]) or t["dAi"] < 0 else "good"
        out.append((5, {"code": "change", "tone": tone, "dAi": t["dAi"], "fresh": len(c["fresh"]), "lost": len(c["lost"])}))
    if t.get("top10") is not None and t["top10"] >= 35:
        out.append((4, {"code": "concentration", "tone": "info", "top10": t["top10"], "topN": t["topN"], "gini": t["gini"]}))
    out.sort(key=lambda x: -x[0])
    return [f for _, f in out[:4]]


# ── screens ──────────────────────────────────────────────────────────────────

def _state(meta: dict, filtered: bool) -> str:
    reason = (meta or {}).get("reason")
    if reason == "source_unavailable":
        return "down"
    if reason == "no_sites":
        return "nomatch" if filtered else "nosite"
    if reason == "no_measurements":
        return "empty"
    return "ok"


@screen("visibility/renewal-header")
async def renewal_header(q) -> dict:
    """The page header's period pill (outside the data Suspense): what the URL asks for. No reads."""
    _, sp = split_context(q)
    return period_choice(sp)


@screen("visibility/renewal")
async def renewal(q) -> dict:
    """{props: RnOverviewFilters option props (scope added by the page), body: the state and, when measured,
    the whole view model}. Reads: filter options, the period, then the previous period of the same length."""
    _, sp = split_context(q)
    filters = read_standard_filters(sp, READER_SCOPE)
    options = await load_panel_options({"surface": "global", "scope": READER_SCOPE, "filters": filters})
    props = {"stage": "visibility", **({"geographyOptions": options["geographyOptions"]} if options.get("geographyOptions") is not None else {})}
    query = reader_query(sp)
    res = await api.get("analytics/visibility", query)
    data, meta = res["data"], res.get("meta") or {}
    filtered = bool(split_filter_values(sp.get("geography")) or split_filter_values(sp.get("brand")))
    state = _state(meta, filtered)
    period = data.get("period") or {}
    body: dict[str, Any] = {"state": state if data.get("pages") or state != "ok" else "empty", "choice": period_choice(sp),
                            "period": {"from": period.get("from"), "to": period.get("to"), "days": period.get("days")},
                            "sites": len(data.get("properties") or []), "view": None}
    if body["state"] == "ok":
        prev_q = prev_period(period)
        prev = None
        if prev_q:
            prev_res = await api.get("analytics/visibility", {**{k: v for k, v in query.items() if k != "days"}, **prev_q})
            prev = prev_res["data"] if not (prev_res.get("meta") or {}).get("reason") else None
        body["prev"] = prev_q
        body["view"] = visibility_view(data, prev, split_filter_values(sp.get("engine")), split_filter_values(sp.get("device")))
    return {"props": props, "body": body}
