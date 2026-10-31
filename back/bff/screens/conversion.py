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
  is of the tracked (전환 집계) events only; a property's share has no total when an active property missed a day.
  The engine rows have no users, so engines compare 세션 100회당 전환 = conversions ÷ sessions × 100.
- 일별 전환율 = the day's conversions ÷ the day's users (1-day windows).
- 7-day blocks count back from the period's last day; a shorter first block is left out (sparklines). A block with a
  day the collector missed for an active property is unknown, not the other days' sum.
- 빠진 날 (renewal audit 12-1, 2026-10-31): when the collector missed a day of the period for an active property, every
  period sum over it is unknown — the totals and their slices (the reader) and the shares, ranks and blocks built on
  them here; `missing` names the properties and days for the summary's note.
- Changes compare with the previous period of the same length: counts in %, rates and shares in pp, landing
  pages in sessions.
- 이 기간 요약 = up to four findings in one fixed order; no threshold decides which show (the sample-size verdict and
  the 50 % landing-page gate left, 2026-10-30 W6 review, the user's go-ahead): the AI users count is shown as it is.

2026-10-30 BI rework (W5): slices of the same GA4 rows the reader now sends, and arithmetic on them only — no estimate,
no fill-in, no significance call.
- 채널 = GA4's default channel groups (report 1). Their conversions are GA4 주요 이벤트 (key events) for every
  property, since a tracked-event property counts its events only as AI vs the other channels together; 채널 합계
  is the channels' own total (the summary's 사이트 전체 is report 5, a separate observation: renewal audit 12-2). Ranks
  are competition ranks (ties share a rank).
- 기기 · 신규/재방문 = the same AI sessions (report 2) and general sessions (report 1) cut by the row's device and
  new/returning value; conversions follow each property's basis on the slice; per 100 sessions (no exact users by slice).
- 같은 입구 페이지 = report 4's general sessions of the pages that had AI landings; per-page conversions are GA4 주요
  이벤트 per 100 sessions.
- 시장 = per property: AI and general 전환율 on its own exact period users, and the gap in pp.
- 이벤트 = the same event counts split AI · general.
- 전환 변화의 두 요인 = the AI sessions and the conversions per 100 sessions of the two periods side by side, each with its
  change, and the AI conversions they make (2026-10-31 ⛔L, renewal audit 15: the split ΔC = (S₁ − S₀) × C₀/S₀ [유입 규모] +
  (C₁ − S₁ × C₀/S₀) [세션당 전환] took the previous period's rate as the baseline, a HUB choice, and is gone); the session
  change by engine = each engine's own change on both periods, the rest (engines without both periods, sessions
  without an engine) kept as one line so the lines add up to the total.
- 측정 원자료 = the reader's period-user windows as they are (the original screen's 기간 사용자 측정값).
Findings are codes + params; the front turns them into text."""
from __future__ import annotations

import asyncio
from typing import Any

from bff import api
from bff.hub_stores.analytics_reader import BRAND_NAMES
from bff.screens import screen, split_context
from bff.screens._days import blocks_of, days_of, period_choice, prev_period, reader_query
from bff.screens._filters import split_filter_values
from bff.screens.visibility import path_of

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
            "siteSessions": m.get("total_sessions"),
            "lift": gap(ai_rate, gen_rate), "perUser": sessions / users if sessions is not None and users else None,
            "per100": share(m.get("ai_conversions"), sessions), "genPer100": share(m.get("human_conversions"), m.get("human_sessions"))}


def _rank(rows: list[dict], key: str, me: dict) -> int | None:
    """Competition rank of `me` among the rows with a value (1 = largest; ties share a rank)."""
    if me.get(key) is None:
        return None
    return 1 + sum(1 for r in rows if r is not me and r.get(key) is not None and r[key] > me[key])


def _channels(cur: dict, prev: dict, prev_ok: bool) -> dict:
    """GA4 channel groups: sessions, share, 주요 이벤트 per 100 sessions, pages per session, the AI channel's ranks."""
    raw = cur.get("channels") or []
    before = {c.get("channel"): c.get("sessions") for c in prev.get("channels") or []}

    def row(c: dict) -> dict:
        s, pv = c.get("sessions"), c.get("page_views")
        return {"channel": c.get("channel"), "ai": bool(c.get("is_ai")), "sessions": s, "keyEvents": c.get("key_events"),
                "per100": share(c.get("key_events"), s), "pps": pv / s if pv is not None and s else None,
                "d": change_pct(s, before.get(c.get("channel"))) if prev_ok else None}
    rows = sorted((row(c) for c in raw), key=lambda r: (r["sessions"] is None, -(r["sessions"] or 0), str(r["channel"])))
    sums = {"sessions": _sum(r["sessions"] for r in rows), "keyEvents": _sum(r["keyEvents"] for r in rows),
            "pageViews": _sum(c.get("page_views") for c in raw)}
    for r in rows:
        r["share"] = share(r["sessions"], sums["sessions"])
    # 채널 합계: the rows' own total (renewal audit 12-2)
    total = {"sessions": sums["sessions"], "keyEvents": sums["keyEvents"], "per100": share(sums["keyEvents"], sums["sessions"]),
             "pps": sums["pageViews"] / sums["sessions"] if sums["pageViews"] is not None and sums["sessions"] else None}
    ai = next((r for r in rows if r["ai"]), None)
    rank = None if ai is None else {"sessions": _rank(rows, "sessions", ai), "per100": _rank(rows, "per100", ai),
                                    "pps": _rank(rows, "pps", ai), "n": len(rows)}
    # no rows under an engine pick: report 1 has no engine (the reader says so)
    return {"rows": rows, "total": total, "aiRank": rank, "reason": cur.get("channels_reason")}


def _segments(raw: list[dict]) -> list[dict]:
    """One cut (device or new/returning) of the AI and general sessions and conversions."""
    ai_total, gen_total = _sum(r.get("ai_sessions") for r in raw), _sum(r.get("human_sessions") for r in raw)
    rows = [{"value": r.get("value"), "aiSessions": r.get("ai_sessions"), "aiShare": share(r.get("ai_sessions"), ai_total),
             "genSessions": r.get("human_sessions"), "genShare": share(r.get("human_sessions"), gen_total),
             "mixGap": gap(share(r.get("ai_sessions"), ai_total), share(r.get("human_sessions"), gen_total)),
             "aiConv": r.get("ai_conversions"), "aiPer100": share(r.get("ai_conversions"), r.get("ai_sessions")),
             "genConv": r.get("human_conversions"), "genPer100": share(r.get("human_conversions"), r.get("human_sessions"))} for r in raw]
    return sorted(rows, key=lambda r: (r["aiSessions"] is None, -(r["aiSessions"] or 0), -(r["genSessions"] or 0), str(r["value"])))


def _factors(t: dict, p: dict, engines: list[dict], prev_engines: dict) -> dict | None:
    """The AI conversion change's two factors — AI sessions and conversions per 100 sessions — and the conversions, each
    as the previous period's value, this period's and the change (counts also in %); and the AI session change as each
    engine's own change plus one remainder (see the module rules). None without both periods' totals."""
    s1, c1, s0, c0 = t["aiSessions"], t["aiConv"], p["aiSessions"], p["aiConv"]
    if None in (s1, c1, s0, c0):
        return None
    p0, p1 = share(c0, s0), share(c1, s1)
    parts, known = [], 0
    for e in engines:
        before = prev_engines.get(e["engine"])
        if e["sessions"] is not None and before is not None:
            parts.append({"engine": e["engine"], "d": e["sessions"] - before})
            known += e["sessions"] - before
    parts.sort(key=lambda x: (-abs(x["d"]), x["engine"]))
    return {"sessions": {"prev": s0, "cur": s1, "d": s1 - s0, "pct": change_pct(s1, s0)},
            "per100": {"prev": p0, "cur": p1, "d": gap(p1, p0)},
            "conv": {"prev": c0, "cur": c1, "d": c1 - c0, "pct": change_pct(c1, c0)},
            "engines": parts, "rest": (s1 - s0) - known}


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
                       "dLift": gap(totals["lift"], p["lift"]), "dShare": gap(totals["share"], p["share"]),
                       "dSite": change_pct(totals["siteSessions"], p["siteSessions"]), "dPageViews": change_pct(totals["pageViews"], p["pageViews"])})
    # the daily series on every day of the period (a day without rows stays null) and 7-day blocks
    by_day = {str(t.get("date"))[:10]: t for t in cur.get("trend") or []}
    series = {k: [by_day.get(d, {}).get(col) for d in days] for k, col in (
        ("sessions", "ai_sessions"), ("conv", "ai_conversions"), ("users", "ai_users"), ("site", "total_sessions"),
        ("genSessions", "human_sessions"), ("genConv", "human_conversions"), ("genUsers", "human_users"))}
    series["rate"] = [share(c, u) for c, u in zip(series["conv"], series["users"], strict=True)]
    series["genRate"] = [share(c, u) for c, u in zip(series["genConv"], series["genUsers"], strict=True)]
    series["share"] = [share(a, s) for a, s in zip(series["sessions"], series["site"], strict=True)]
    # the active properties the collector missed a day of the period for (the reader), named as the windows are
    names = {p.get("prop_key"): p for p in cur.get("properties") or []}
    by_id = {p.get("property_id"): p for p in cur.get("properties") or []}
    missing = [{"id": m.get("property_id"), "country": (by_id.get(m.get("property_id")) or {}).get("country"),
                "brand": BRAND_NAMES.get((by_id.get(m.get("property_id")) or {}).get("brand_bit")),
                "days": [str(d)[:10] for d in m.get("days") or []]} for m in cur.get("missing") or []]
    missed = {d for m in missing for d in m["days"]}
    blocks = blocks_of(days)
    # a 7-day block with a missed day would be the other properties' days only (12-1)
    spark = {k: [None if missed.intersection(days[a:b + 1]) else _sum(series[k][a:b + 1]) for a, b in blocks] for k in ("sessions", "conv")}
    # engines
    prev_eng = {e.get("engine"): e.get("sessions") for e in prev.get("engines") or []}
    eng = cur.get("engines") or []
    e_sessions, e_conv = _sum(e.get("sessions") for e in eng), _sum(e.get("conversions") for e in eng)
    engines = sorted(({"engine": e.get("engine"), "sessions": e.get("sessions"), "share": share(e.get("sessions"), e_sessions),
                       "conv": e.get("conversions"), "convShare": share(e.get("conversions"), e_conv),
                       "per100": share(e.get("conversions"), e.get("sessions")),
                       "pps": e["page_views"] / e["sessions"] if e.get("page_views") is not None and e.get("sessions") else None,
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
        g = p.get("human_sessions")
        pages.append({"id": i, "url": p.get("url"), "path": path_of(p.get("url")), "sessions": s, "share": share(s, p_total),
                      "cum": share(acc, p_total) if s is not None else None, "views": p.get("page_views"),
                      "prev": before if prev_ok else None, "d": gap(s, before) if prev_ok else None,
                      "genSessions": g, "aiOfPage": share(s, s + g) if s is not None and g is not None else None,
                      "aiKe": p.get("ai_key_events"), "aiKe100": share(p.get("ai_key_events"), s),
                      "genKe": p.get("human_key_events"), "genKe100": share(p.get("human_key_events"), g)})
    # GA4 properties (with the reader's per-property AI values); a stopped one (unmapped) is outside the measured scope
    # and is not listed (12-3, the W6 rule of the coverage finding)
    per = {c.get("property_id"): c for c in cur.get("countries") or []}
    prev_per = {c.get("property_id"): c.get("ai_sessions") for c in prev.get("countries") or []}
    s_total = None if missing else _sum(c.get("ai_sessions") for c in per.values())
    props = []
    for p in cur.get("properties") or []:
        if p.get("status") == "unmapped":
            continue
        c = per.get(p.get("property_id")) or {}
        s = c.get("ai_sessions")
        rate, gen_rate = share(c.get("ai_conversions"), c.get("ai_users")), share(c.get("human_conversions"), c.get("human_users"))
        props.append({"id": p.get("property_id"), "country": p.get("country"), "brand": BRAND_NAMES.get(p.get("brand_bit")),
                      "status": p.get("status"), "basis": p.get("conv_basis"), "sessions": s, "users": c.get("ai_users"),
                      "share": share(s, s_total), "d": change_pct(s, prev_per.get(p.get("property_id"))) if prev_ok else None,
                      "conv": c.get("ai_conversions"), "rate": rate, "genSessions": c.get("human_sessions"),
                      "genConv": c.get("human_conversions"), "genRate": gen_rate, "lift": gap(rate, gen_rate)})
    rank = {s: i for i, s in enumerate(STATUS_ORDER)}
    props.sort(key=lambda r: (rank.get(r["status"], len(rank)), r["sessions"] is None, -(r["sessions"] or 0), str(r["country"]), str(r["id"])))
    stopped = sum(1 for p in cur.get("properties") or [] if p.get("status") == "unmapped")
    coverage = {"total": len(props), **{s: sum(1 for r in props if r["status"] == s) for s in STATUS_ORDER}, "unmapped": stopped}
    # events
    ev = cur.get("events") or []
    tracked = _sum(e.get("count") for e in ev if e.get("tracked"))
    events = sorted(({"event": e.get("event"), "count": e.get("count"), "tracked": bool(e.get("tracked")),
                      "share": share(e.get("count"), tracked) if e.get("tracked") else None,
                      "aiCount": e.get("ai_count"), "genCount": e.get("human_count"),
                      "aiShare": share(e.get("ai_count"), e["ai_count"] + e["human_count"])
                      if e.get("ai_count") is not None and e.get("human_count") is not None else None} for e in ev),
                    key=lambda r: (not r["tracked"], r["count"] is None, -(r["count"] or 0), str(r["event"])))
    # period-user windows as the reader sends them (the original screen's 기간 사용자 측정값), named by property
    windows = sorted(({"end": str(w.get("window_end"))[:10], "days": w.get("window_days"), "id": (names.get(w.get("prop_key")) or {}).get("property_id"),
                       "country": (names.get(w.get("prop_key")) or {}).get("country"), "brand": BRAND_NAMES.get((names.get(w.get("prop_key")) or {}).get("brand_bit")),
                       "cohort": w.get("cohort"), "page": w.get("url") or w.get("page"), "users": w.get("users"),
                       "all": w.get("engine_mask") == w.get("device_mask") == w.get("nvr_mask") == 0} for w in cur.get("windows") or []),
                     key=lambda w: (w["days"] or 0, w["end"], str(w["id"]), str(w["cohort"])), reverse=True)
    segs = cur.get("segments") or {}
    view = {
        "days": days, "observed": sum(1 for d in days if d in by_day), "blocks": [[days[a], days[b]] for a, b in blocks],
        "prevOk": prev_ok, "filtered": filtered, "totals": totals, "spark": spark, "trend": series,
        "engines": engines, "engineRest": rest if rest is not None and rest > 0 else None, "pages": pages, "props": props,
        "coverage": coverage, "multiBrand": len({r["brand"] for r in props}) > 1, "events": events,
        "tracked": tracked, "channels": _channels(cur, prev, prev_ok),
        "segments": {"device": _segments(segs.get("device") or []), "visitorType": _segments(segs.get("visitor_type") or [])},
        "factors": _factors(totals, _totals(prev.get("metrics") or {}), engines, prev_eng) if prev_ok else None,
        "windows": windows, "missing": missing,
    }
    view["findings"] = findings(view)
    return view


def findings(v: dict) -> list[dict]:
    """이 기간 요약: up to four findings as codes + params, in one fixed order (the number before each is its place)."""
    t, out = v["totals"], []
    if t["lift"] is not None:
        tone = "good" if t["lift"] > 0 else "warn" if t["lift"] < 0 else "info"
        out.append((9, {"code": "lift", "tone": tone, "ai": t["aiRate"], "gen": t["genRate"], "lift": t["lift"]}))
    # a stopped property (unmapped) is the administrator's choice, not a gap in what is measured: coverage counts without it
    cov = v["coverage"]
    if cov["active"] < cov["total"]:
        out.append((8, {"code": "coverage", "tone": "warn", "active": cov["active"], "total": cov["total"]}))
    if v["prevOk"] and t.get("dAiSessions") is not None:
        d, fc = t["dAiSessions"], v.get("factors")
        change = {"code": "change", "tone": "good" if d > 0 else "warn" if d < 0 else "info", "sessions": d, "conv": t.get("dAiConv")}
        if fc is not None and fc["per100"]["d"] is not None:
            change.update(per100Prev=fc["per100"]["prev"], per100=fc["per100"]["cur"])
        out.append((7, change))
    ch = v.get("channels") or {}
    rank = ch.get("aiRank")
    if rank and rank["n"] > 1 and rank["sessions"] is not None:
        ai = next(r for r in ch["rows"] if r["ai"])
        out.append((6.5, {"code": "channel", "tone": "info", "rank": rank["sessions"], "n": rank["n"], "share": ai["share"],
                          "per100": ai["per100"], "per100Rank": rank["per100"], "total": ch["total"]["per100"]}))
    measured = [e for e in v["engines"] if e["sessions"]]
    if len(measured) > 1:
        top = measured[0]
        best = max((e for e in measured if e["per100"] is not None), key=lambda e: e["per100"], default=top)
        out.append((6, {"code": "engine", "tone": "info", "engine": top["engine"], "share": top["share"], "per100": top["per100"],
                        "best": best["engine"], "bestPer100": best["per100"]}))
    pages = [p for p in v["pages"] if p["sessions"]]
    if pages and pages[0]["aiKe100"] is not None and pages[0]["genKe100"] is not None:
        out.append((5.5, {"code": "samePage", "tone": "info", "page": pages[0]["id"], "ai": pages[0]["aiKe100"], "gen": pages[0]["genKe100"]}))
    if len(pages) > TOP_PAGES and pages[TOP_PAGES - 1]["cum"] is not None:
        out.append((5, {"code": "pages", "tone": "info", "n": TOP_PAGES, "share": pages[TOP_PAGES - 1]["cum"], "page": pages[0]["id"]}))
    devices = [r for r in (v.get("segments") or {}).get("device") or [] if r["aiShare"] is not None and r["genShare"] is not None]
    if len(devices) > 1:
        top = devices[0]
        out.append((4.5, {"code": "device", "tone": "info", "device": top["value"], "ai": top["aiShare"], "gen": top["genShare"]}))
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


def property_options(properties: list[dict]) -> dict:
    """국가 = the markets with a GA4 property the account can read (2026-10-30, the user's go-ahead): the GA4 rows are
    per property, and the original page had no country axis (Gold's answer countries named markets without one). A
    stopped property (unmapped) is not offered; a brand pick narrows the list (optionMatrix)."""
    pairs = sorted({(BRAND_NAMES.get(p.get("brand_bit")) or "", p["country"]) for p in properties
                    if p.get("country") and p.get("status") != "unmapped"})
    return {"geographyOptions": sorted({c for _, c in pairs}),
            "optionMatrix": [{"brand": b or None, "region": c, "lang": None} for b, c in pairs]}


@screen("conversion/renewal-header")
async def renewal_header(q) -> dict:
    """The page header's period pill (outside the data Suspense): what the URL asks for. No reads."""
    _, sp = split_context(q)
    return period_choice(sp)


@screen("conversion/renewal")
async def renewal(q) -> dict:
    """{props: RnOverviewFilters option props (scope added by the page), body: the state and, when measured,
    the whole view model}. Reads: the registered properties and the period, then the previous period of the same length."""
    _, sp = split_context(q)
    query = reader_query(sp)
    listed, res = await asyncio.gather(api.get("analytics/properties", {}), api.get("analytics/conversion", query))
    props = {"stage": "conversion", **property_options(listed["data"].get("properties") or [])}
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
