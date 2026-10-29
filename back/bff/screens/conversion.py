"""Renewal AI Conversion screens (/renewal/standard/ai-funnel/conversion).

The page reads what the original screen reads — GET /v1/analytics/conversion (hub_stores/analytics_reader.py
conversion(): metrics, daily trend, engines, landing pages, properties × country, events) — once for the period
and once for the previous period of the same length, and derives every other number from those answers: shares,
gaps, per-session ratios, 7-day sums and changes. Nothing is estimated or filled in: a value the reader leaves null
stays null (period users under an engine · device · visitor filter or on a period without an exact window, a day
without rows).

Rules:
- 전환율 = the reader's (conversions ÷ exact period users); 격차 = AI − 일반 in pp, only when both rates exist.
- 세션 비중 = the reader's (AI sessions ÷ all sessions).
- 엔진 · 입구 페이지 · 속성 shares are of the rows' own total (rows without a value are left out); an event's share
  is of the tracked (전환 집계) events only. The engine rows have no users, so engines compare 세션 100회당 전환 =
  conversions ÷ sessions × 100.
- 일별 전환율 = the day's conversions ÷ the day's users (1-day windows).
- 7-day blocks count back from the period's last day; a shorter first block is left out (sparklines).
- Changes compare with the previous period of the same length: counts in %, rates and shares in pp, landing
  pages in sessions.
- 표본 작음 = fewer than 50 AI users in the period (the original screen's LOW_SAMPLE_USERS): a rate on so few users
  swings from day to day.
Findings are codes + params; the front turns them into text."""
from __future__ import annotations

from typing import Any

from bff import api
from bff.access import reader_scope
from bff.hub_stores.analytics_reader import BRAND_NAMES
from bff.screens import screen, split_context
from bff.screens._days import blocks_of, days_of, period_choice, prev_period, reader_query
from bff.screens._filters import load_panel_options, read_standard_filters, split_filter_values
from bff.screens.visibility import path_of

LOW_SAMPLE_USERS = 50
TOP_PAGES = 3
STATUS_ORDER = ("active", "pending_grant", "unmapped")
USER_AXES = ("engine", "device", "visitorType")


def share(n: float | None, d: float | None) -> float | None:
    return 100 * n / d if n is not None and d else None


def change_pct(cur: float | None, prev: float | None) -> float | None:
    return 100 * (cur - prev) / prev if cur is not None and prev else None


def gap(a: float | None, b: float | None) -> float | None:
    return a - b if a is not None and b is not None else None


def _sum(values) -> float | None:
    xs = [v for v in values if v is not None]
    return sum(xs) if xs else None


# ── the page model ───────────────────────────────────────────────────────────

def _totals(m: dict) -> dict:
    ai_rate, gen_rate = m.get("ai_conversion_rate"), m.get("human_conversion_rate")
    sessions, users = m.get("ai_sessions"), m.get("ai_users")
    return {"aiSessions": sessions, "aiUsers": users, "aiConv": m.get("ai_conversions"), "aiRate": ai_rate,
            "genSessions": m.get("human_sessions"), "genUsers": m.get("human_users"), "genConv": m.get("human_conversions"),
            "genRate": gen_rate, "share": m.get("session_share"), "pageViews": m.get("page_views"),
            "lift": gap(ai_rate, gen_rate), "perUser": sessions / users if sessions is not None and users else None,
            "per100": share(m.get("ai_conversions"), sessions)}


def conversion_view(cur: dict, prev: dict | None, filtered: bool) -> dict:
    """The whole renewal view model from the reader's answers for the period and the previous period."""
    period = cur.get("period") or {}
    days = days_of(period["from"], period["to"]) if period.get("from") and period.get("to") else []
    prev_ok = prev is not None
    prev = prev or {}
    # totals and their changes
    totals = _totals(cur.get("metrics") or {})
    if prev_ok:
        p = _totals(prev.get("metrics") or {})
        totals.update({"dAiSessions": change_pct(totals["aiSessions"], p["aiSessions"]), "dAiConv": change_pct(totals["aiConv"], p["aiConv"]),
                       "dAiRate": gap(totals["aiRate"], p["aiRate"]), "dGenRate": gap(totals["genRate"], p["genRate"]),
                       "dLift": gap(totals["lift"], p["lift"]), "dShare": gap(totals["share"], p["share"])})
    # the daily series on every day of the period (a day without rows stays null) and 7-day blocks
    by_day = {str(t.get("date"))[:10]: t for t in cur.get("trend") or []}
    series = {k: [by_day.get(d, {}).get(col) for d in days] for k, col in (("sessions", "ai_sessions"), ("conv", "ai_conversions"), ("users", "ai_users"))}
    series["rate"] = [share(c, u) for c, u in zip(series["conv"], series["users"], strict=True)]
    blocks = blocks_of(days)
    spark = {k: [_sum(series[k][a:b + 1]) for a, b in blocks] for k in ("sessions", "conv")}
    # engines
    prev_eng = {e.get("engine"): e.get("sessions") for e in prev.get("engines") or []}
    eng = cur.get("engines") or []
    e_sessions, e_conv = _sum(e.get("sessions") for e in eng), _sum(e.get("conversions") for e in eng)
    engines = sorted(({"engine": e.get("engine"), "sessions": e.get("sessions"), "share": share(e.get("sessions"), e_sessions),
                       "conv": e.get("conversions"), "convShare": share(e.get("conversions"), e_conv),
                       "per100": share(e.get("conversions"), e.get("sessions")),
                       "d": change_pct(e.get("sessions"), prev_eng.get(e.get("engine"))) if prev_ok else None} for e in eng),
                     key=lambda r: (r["sessions"] is None, -(r["sessions"] or 0), str(r["engine"])))
    rest = totals["aiSessions"] - e_sessions if totals["aiSessions"] is not None and e_sessions is not None else None
    # landing pages
    prev_pages = {p.get("url"): p.get("sessions") for p in prev.get("pages") or []}
    raw = sorted(cur.get("pages") or [], key=lambda p: (p.get("sessions") is None, -(p.get("sessions") or 0), str(p.get("url"))))
    p_total = _sum(p.get("sessions") for p in raw)
    pages, acc = [], 0
    for i, p in enumerate(raw):
        s, before = p.get("sessions"), prev_pages.get(p.get("url"))
        acc += s or 0
        pages.append({"id": i, "url": p.get("url"), "path": path_of(p.get("url")), "sessions": s, "share": share(s, p_total),
                      "cum": share(acc, p_total) if s is not None else None, "views": p.get("page_views"),
                      "prev": before if prev_ok else None, "d": gap(s, before) if prev_ok else None})
    # GA4 properties (with the reader's per-property AI values)
    per = {c.get("property_id"): c for c in cur.get("countries") or []}
    prev_per = {c.get("property_id"): c.get("ai_sessions") for c in prev.get("countries") or []}
    s_total = _sum(c.get("ai_sessions") for c in per.values())
    props = []
    for p in cur.get("properties") or []:
        c = per.get(p.get("property_id")) or {}
        s = c.get("ai_sessions")
        props.append({"id": p.get("property_id"), "country": p.get("country"), "brand": BRAND_NAMES.get(p.get("brand_bit")),
                      "status": p.get("status"), "basis": p.get("conv_basis"), "sessions": s, "users": c.get("ai_users"),
                      "share": share(s, s_total), "d": change_pct(s, prev_per.get(p.get("property_id"))) if prev_ok else None})
    rank = {s: i for i, s in enumerate(STATUS_ORDER)}
    props.sort(key=lambda r: (rank.get(r["status"], len(rank)), r["sessions"] is None, -(r["sessions"] or 0), str(r["country"]), str(r["id"])))
    coverage = {"total": len(props), **{s: sum(1 for r in props if r["status"] == s) for s in STATUS_ORDER}}
    # events
    ev = cur.get("events") or []
    tracked = _sum(e.get("count") for e in ev if e.get("tracked"))
    events = sorted(({"event": e.get("event"), "count": e.get("count"), "tracked": bool(e.get("tracked")),
                      "share": share(e.get("count"), tracked) if e.get("tracked") else None} for e in ev),
                    key=lambda r: (not r["tracked"], r["count"] is None, -(r["count"] or 0), str(r["event"])))
    view = {
        "days": days, "observed": sum(1 for d in days if d in by_day), "blocks": [[days[a], days[b]] for a, b in blocks],
        "prevOk": prev_ok, "filtered": filtered, "lowSample": LOW_SAMPLE_USERS, "totals": totals, "spark": spark, "trend": series,
        "engines": engines, "engineRest": rest if rest is not None and rest > 0 else None, "pages": pages, "props": props,
        "coverage": coverage, "multiBrand": len({r["brand"] for r in props}) > 1, "events": events,
        "tracked": tracked,
    }
    view["findings"] = findings(view)
    return view


def findings(v: dict) -> list[dict]:
    """이 기간 요약: up to four findings as codes + params, most important first."""
    t, out = v["totals"], []
    if t["aiUsers"] is not None and t["aiUsers"] < v["lowSample"]:
        out.append((10, {"code": "sample", "tone": "warn", "users": t["aiUsers"], "min": v["lowSample"]}))
    if t["lift"] is not None:
        tone = "good" if t["lift"] > 0 else "warn" if t["lift"] < 0 else "info"
        out.append((9, {"code": "lift", "tone": tone, "ai": t["aiRate"], "gen": t["genRate"], "lift": t["lift"]}))
    cov = v["coverage"]
    if cov["active"] < cov["total"]:
        out.append((8, {"code": "coverage", "tone": "warn", "active": cov["active"], "total": cov["total"]}))
    if v["prevOk"] and t.get("dAiSessions") is not None:
        d = t["dAiSessions"]
        out.append((7, {"code": "change", "tone": "good" if d > 0 else "warn" if d < 0 else "info", "sessions": d, "conv": t.get("dAiConv")}))
    measured = [e for e in v["engines"] if e["sessions"]]
    if len(measured) > 1:
        top = measured[0]
        best = max((e for e in measured if e["per100"] is not None), key=lambda e: e["per100"], default=top)
        out.append((6, {"code": "engine", "tone": "info", "engine": top["engine"], "share": top["share"], "per100": top["per100"],
                        "best": best["engine"], "bestPer100": best["per100"]}))
    pages = [p for p in v["pages"] if p["sessions"]]
    if len(pages) > TOP_PAGES and (pages[TOP_PAGES - 1]["cum"] or 0) >= 50:
        out.append((5, {"code": "pages", "tone": "info", "n": TOP_PAGES, "share": pages[TOP_PAGES - 1]["cum"], "page": pages[0]["id"]}))
    if t["share"] is not None:
        out.append((4, {"code": "share", "tone": "info", "share": t["share"], "d": t.get("dShare")}))
    out.sort(key=lambda x: -x[0])
    return [f for _, f in out[:4]]


# ── screens ──────────────────────────────────────────────────────────────────

def _state(meta: dict, data: dict, narrowed: bool, filtered: bool) -> str:
    """The body state. The reader answers without a reason when only period-user windows are there, so a period
    without a single GA4 row is not measured either: no match under a filter, else nothing measured yet."""
    reason = (meta or {}).get("reason")
    if reason == "source_unavailable":
        return "down"
    if reason == "no_properties":
        return "nomatch" if narrowed else "noprop"
    if reason == "no_measurements":
        return "empty" if any(p.get("status") == "active" for p in data.get("properties") or []) else "pending"
    if not data.get("trend"):
        return "nomatch" if narrowed or filtered else "empty"
    return "ok"


@screen("conversion/renewal-header")
async def renewal_header(q) -> dict:
    """The page header's period pill (outside the data Suspense): what the URL asks for. No reads."""
    _, sp = split_context(q)
    return period_choice(sp)


@screen("conversion/renewal")
async def renewal(q) -> dict:
    """{props: RnOverviewFilters option props (scope added by the page), body: the state and, when measured,
    the whole view model}. Reads: filter options, the period, then the previous period of the same length."""
    _, sp = split_context(q)
    filters = read_standard_filters(sp, reader_scope())
    options = await load_panel_options({"surface": "global", "scope": reader_scope(), "filters": filters})
    props = {"stage": "conversion", **({"geographyOptions": options["geographyOptions"]} if options.get("geographyOptions") is not None else {})}
    query = reader_query(sp)
    res = await api.get("analytics/conversion", query)
    data, meta = res["data"], res.get("meta") or {}
    properties = data.get("properties") or []
    narrowed = bool(split_filter_values(sp.get("geography")) or split_filter_values(sp.get("brand")))
    filtered = any(split_filter_values(sp.get(k)) for k in USER_AXES)
    period = data.get("period") or {}
    body: dict[str, Any] = {
        "state": _state(meta, data, narrowed, filtered), "choice": period_choice(sp),
        "period": {"from": period.get("from"), "to": period.get("to"), "days": period.get("days")},
        "properties": [{"id": p.get("property_id"), "country": p.get("country"), "brand": BRAND_NAMES.get(p.get("brand_bit")), "status": p.get("status")}
                       for p in properties],
        "view": None,
    }
    if body["state"] == "ok":
        prev_q = prev_period(period)
        prev = None
        if prev_q:
            prev_res = await api.get("analytics/conversion", {**{k: v for k, v in query.items() if k != "days"}, **prev_q})
            prev = prev_res["data"] if not (prev_res.get("meta") or {}).get("reason") else None
        body["prev"] = prev_q
        body["view"] = conversion_view(data, prev, filtered)
    return {"props": props, "body": body}
