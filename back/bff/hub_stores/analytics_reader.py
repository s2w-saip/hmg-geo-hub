"""GA4 and SEO metrics. Missing rows/fields remain null; the remote Gold is never a fallback."""
from collections import defaultdict
from datetime import date, timedelta

import asyncpg
from fastapi import HTTPException

from bff.hub_stores import analytics_db
from bff.gold_reader.context import SQL, values

BRAND_BITS = {"hyundai": 1, "kia": 2, "genesis": 4, "hmg": 7}
BRAND_NAMES = {1: "Hyundai", 2: "Kia", 4: "Genesis"}
CONVERSION_KEYS = ("ai_sessions", "ai_users", "ai_conversions", "ai_conversion_rate", "human_sessions",
                   "human_users", "human_conversions", "human_conversion_rate", "session_share", "page_views")
VISIBILITY_KEYS = ("seo_impressions", "ai_crawls", "pages", "both", "seo_only", "crawl_only", "neither")


def percent(n, d):
    return 100 * n / d if n is not None and d is not None and d > 0 else None


def observed_sum(rows, column):
    """No observation is different from an observed zero. Do not hide partially missing sums."""
    if not rows or any(row.get(column) is None for row in rows):
        return None
    return sum(row[column] for row in rows)


def conversions(rows, properties, ai=True, complete=frozenset()):
    """Each property's declared basis chooses one report, never two overlapping reports. Basis 2: GA4 sends no row
    for a tracked event that did not happen, so a slice whose events were collected (report 3 rows of the cohort)
    without a tracked one observed zero conversions. A property in `complete` was collected on every day of the
    slice (collected_days), so a count it has no row for is zero there too; anything else without a row stays unknown."""
    totals = []
    for prop in properties:
        if prop["status"] != "active":
            continue
        mine = [r for r in rows if r["prop_key"] == prop["prop_key"] and r["is_ai"] is ai]
        if prop["conv_basis"] == 1:
            count = observed_sum([r for r in mine if r["report"] == (2 if ai else 1)], "key_events")
        else:
            events = [r for r in mine if r["report"] == 3]
            tracked = [r for r in events if r["is_conv"] is True]
            count = observed_sum(tracked, "event_count") if tracked else 0 if events else None
        totals.append({"count": 0 if count is None and prop["prop_key"] in complete else count})
    return observed_sum(totals, "count")


def collected_days(windows):
    """prop_key → the days the collector wrote: its daily `total` users window (written even with zero users)."""
    out = defaultdict(set)
    for w in windows:
        if w["window_days"] == 1 and w["cohort"] == "total" and w["page_key"] == 0 and w["engine_mask"] == w["device_mask"] == w["nvr_mask"] == 0:
            out[w["prop_key"]].add(w["window_end"])
    return out


def period(q, latest):
    try:
        days = int(q.get("days", "28"))
        if not 1 <= days <= 366:
            raise ValueError()
        end = date.fromisoformat(q["to"]) if q.get("to") else latest
        start = date.fromisoformat(q["from"]) if q.get("from") else end - timedelta(days=days - 1) if end else None
        if start and end and start > end:
            raise ValueError()
        return start, end, (end - start).days + 1 if start and end else days
    except (ValueError, OverflowError):
        raise HTTPException(422, "Invalid analytics period") from None


def result(kind, data, *, reason=None):
    return {"data": {"kind": kind, **data}, "meta": {"source": "hub_analytics", "database": "hmg_analytics",
            "available": reason is None, "reason": reason, "read_only": True}}


def empty(kind, reason):
    keys = CONVERSION_KEYS if kind == "conversion" else VISIBILITY_KEYS
    return result(kind, {"metrics": dict.fromkeys(keys), "period": {"from": None, "to": None, "days": None},
                  "properties": [], "pages": [], "trend": [], "engines": [], "countries": [], "events": [],
                  "windows": [], "devices": [], "bots": [], "priorities": []}, reason=reason)


def filters(q, b, *, project_alias="p", country_alias="c", brand_column="p.brand_bit"):
    parts = []
    bits = 0
    for brand in values(q, "brand"):
        if brand.lower() not in BRAND_BITS:
            raise HTTPException(422, "Unknown analytics brand")
        bits |= BRAND_BITS[brand.lower()]
    if bits:
        parts.append(f"({brand_column} & {b.bind(bits)})<>0")
    if values(q, "country"):
        parts.append(f"{country_alias}.code=ANY({b.bind(values(q, 'country'), 'text[]')})")
    return parts


async def conversion(conn, q):
    b = SQL()
    parts = filters(q, b)
    if q.get("property_id"):
        parts.append(f"p.property_id={b.bind(q['property_id'])}")
    if q.get("project_id"):
        # A project's GA4 mapping must be explicit and unambiguous, using stable UUIDs.
        parts.append(f"EXISTS(SELECT 1 FROM ref.dim_project dp WHERE (dp.project_id::text={b.bind(q['project_id'])} "
                     f"OR dp.scope_project_id::text={b.bind(q['project_id'])}) AND dp.site_geo_key=p.geo_key "
                     "AND dp.site_brand_bit=p.brand_bit)")
    properties = [dict(r) for r in await conn.fetch(f"""SELECT p.*,c.code AS country FROM analytics.ga4_property p
        LEFT JOIN ref.dim_country c USING(geo_key) WHERE {' AND '.join(parts) or 'true'} ORDER BY p.property_id""", *b.args)]
    if not properties:
        return empty("conversion", "no_properties")
    keys = [r["prop_key"] for r in properties if r["status"] == "active"]
    latest = await conn.fetchval("SELECT max(date) FROM analytics.ga4_row WHERE prop_key=ANY($1::smallint[])", keys)
    start, end, days = period(q, latest)
    data = empty("conversion", "no_measurements")["data"]
    data.update(properties=properties, period={"from": start, "to": end, "days": days})
    if not start or not keys:
        return result("conversion", data, reason="no_measurements")
    b = SQL()
    where = [f"r.prop_key=ANY({b.bind(keys, 'smallint[]')})", f"r.date BETWEEN {b.bind(start)} AND {b.bind(end)}"]
    for axis, table_column, kind in (("device", "device_key", "device"), ("visitor_type", "nvr_key", "nvr")):
        selected = values(q, axis)
        if selected:
            where.append(f"r.{table_column} IN (SELECT value_key FROM analytics.ga4_value WHERE kind='{kind}' AND value=ANY({b.bind(selected, 'text[]')}))")
    if values(q, "engine"):
        where.append(f"(NOT r.is_ai OR r.engine_key IN (SELECT engine_key FROM ref.dim_engine WHERE code=ANY({b.bind(values(q, 'engine'), 'text[]')})))")
    rows = [dict(r) for r in await conn.fetch(f"""SELECT r.*,e.code AS engine,v.value AS page,u.url,
        ev.value AS event FROM analytics.ga4_row r LEFT JOIN ref.dim_engine e USING(engine_key)
        LEFT JOIN analytics.ga4_value v ON v.kind='page' AND v.value_key=r.page_key
        LEFT JOIN ref.dim_url u ON u.url_key=v.url_key
        LEFT JOIN analytics.ga4_value ev ON ev.kind='event' AND ev.value_key=r.event_key
        WHERE {' AND '.join(where)} ORDER BY r.date,r.prop_key,r.report""", *b.args)]
    windows = [dict(r) for r in await conn.fetch("""SELECT w.*,v.value AS page,u.url FROM analytics.ga4_users_window w
        LEFT JOIN analytics.ga4_value v ON v.kind='page' AND v.value_key=w.page_key LEFT JOIN ref.dim_url u ON u.url_key=v.url_key
        WHERE w.prop_key=ANY($1::smallint[]) AND w.window_end BETWEEN $2 AND $3 ORDER BY w.window_end,w.prop_key,w.cohort""", keys, start, end)]
    # The collector (back/analytics/ga4_collect.py) replaces whole days and leaves a daily `total` window for every
    # day it collected, so on such a day a report without a row observed zero (GA4 leaves out all-zero rows).
    collected = collected_days(windows)
    def complete(days):
        return frozenset(k for k in keys if days <= collected[k])
    whole = complete({start + timedelta(days=i) for i in range(days)})
    def zero_if_collected(value, done=whole, prop_keys=keys):
        return 0 if value is None and set(prop_keys) <= done else value
    # Reports are separate observations: traffic, events and landing rows must never be added together.
    traffic = [r for r in rows if r["report"] == 2]
    totals = [r for r in rows if r["report"] == 5]
    events = [r for r in rows if r["report"] == 3]
    ai_traffic = [r for r in traffic if r["is_ai"] is True]
    ai_sessions = zero_if_collected(observed_sum(ai_traffic, "sessions"))
    total_sessions = zero_if_collected(observed_sum(totals, "sessions"))
    ai_events = [r for r in events if r["is_ai"] is True and r["is_conv"] is True]
    general_events = [r for r in events if r["is_ai"] is False and r["is_conv"] is True]
    ai_conv = conversions(rows, properties, complete=whole)
    general_conv = conversions(rows, properties, ai=False, complete=whole)
    # Exact period users are read as a window, not approximated by summing daily users.
    filtered = any(values(q, k) for k in ("engine", "device", "visitor_type"))
    def exact_users(cohort, prop_keys=keys, page_key=0, window_end=end, window_days=days):
        if filtered:
            return None  # A filter-mask registry has not been supplied; do not guess bit assignments.
        selected = [r for r in windows if r["prop_key"] in prop_keys and r["cohort"] == cohort and r["window_end"] == window_end
                    and r["window_days"] == window_days and r["page_key"] == page_key
                    and r["engine_mask"] == r["device_mask"] == r["nvr_mask"] == 0]
        return observed_sum(selected, "users") if len(selected) == len(prop_keys) else None
    ai_users, human_users = exact_users("ai"), exact_users("general")
    human_sessions = zero_if_collected(observed_sum([r for r in rows if r["report"] == 1 and r["is_ai"] is False], "sessions"))
    if human_sessions is None and not values(q,"engine") and total_sessions is not None and ai_sessions is not None and total_sessions >= ai_sessions:
        human_sessions = total_sessions - ai_sessions
    data["metrics"] = {"ai_sessions": ai_sessions, "ai_users": ai_users, "ai_conversions": ai_conv,
        "ai_conversion_rate": percent(ai_conv, ai_users), "human_sessions": human_sessions, "human_users": human_users,
        "human_conversions": general_conv, "human_conversion_rate": percent(general_conv, human_users),
        "session_share": percent(ai_sessions, total_sessions), "page_views": zero_if_collected(observed_sum(totals, "page_views"))}
    data["trend"] = [{"date": day, "ai_sessions": zero_if_collected(observed_sum([r for r in ai_traffic if r["date"] == day], "sessions"), complete({day})),
        "ai_conversions": conversions([r for r in rows if r["date"] == day], properties, complete=complete({day})),
        "ai_users": exact_users("ai", window_end=day, window_days=1)} for day in sorted({r["date"] for r in rows})]
    data["engines"] = [{"engine": engine, "sessions": observed_sum([r for r in ai_traffic if r["engine"] == engine], "sessions"),
        "conversions": conversions([r for r in rows if r["engine"] == engine], properties, complete=whole)}
        for engine in sorted({r["engine"] for r in ai_traffic if r["engine"]})]
    landing = [r for r in rows if r["report"] == 4]
    data["pages"] = [{"url": url, "sessions": observed_sum([r for r in landing if (r["url"] or r["page"]) == url and r["is_ai"] is True], "sessions"),
        "page_views": observed_sum([r for r in landing if (r["url"] or r["page"]) == url], "page_views")}
        for url in sorted({r["url"] or r["page"] for r in landing if r["url"] or r["page"]})]
    data["events"] = [{"event": event, "count": observed_sum([r for r in events if r["event"] == event], "event_count"),
        "tracked": any(r["is_conv"] for r in events if r["event"] == event)} for event in sorted({r["event"] for r in events if r["event"]})]
    data["windows"] = windows
    data["countries"] = [{"property_id": p["property_id"], "country": p["country"], "brand": BRAND_NAMES.get(p["brand_bit"]),
        "ai_users": exact_users("ai", [p["prop_key"]]),
        "ai_sessions": zero_if_collected(observed_sum([r for r in ai_traffic if r["prop_key"] == p["prop_key"]], "sessions"), prop_keys=[p["prop_key"]])}
        for p in properties]
    return result("conversion", data, reason=None if rows or windows else "no_measurements")


async def visibility(conn, q):
    b = SQL()
    parts = filters(q, b, brand_column="p.site_brand_bit")
    parts.append("p.surface IN (2,3)")
    if q.get("project_id"):
        parts.append(f"(p.project_id::text={b.bind(q['project_id'])} OR p.scope_project_id::text={b.bind(q['project_id'])})")
    else:
        parts.append("p.surface=2")
    sites = [dict(r) for r in await conn.fetch(f"""SELECT p.*,c.code AS country FROM ref.dim_project p
        LEFT JOIN ref.dim_country c ON c.geo_key=p.site_geo_key WHERE {' AND '.join(parts)}""", *b.args)]
    if not sites:
        return empty("visibility", "no_sites")
    keys = [r["project_key"] for r in sites]
    latest = await conn.fetchval("SELECT max(date) FROM analytics.current_page_visibility_daily WHERE project_key=ANY($1::smallint[])", keys)
    start, end, days = period(q, latest)
    data = empty("visibility", "no_measurements")["data"]
    data.update(properties=sites, period={"from": start, "to": end, "days": days})
    if not start:
        return result("visibility", data, reason="no_measurements")
    params = (keys, start, end)
    rows = [dict(r) for r in await conn.fetch("""SELECT f.*,u.url,u.title,c.code AS country FROM analytics.current_page_visibility_daily f
        JOIN ref.dim_url u USING(url_key) LEFT JOIN ref.dim_country c ON c.geo_key=f.geo_key
        WHERE f.project_key=ANY($1::smallint[]) AND f.date BETWEEN $2 AND $3 ORDER BY f.date,f.project_key,f.url_key""", *params)]
    devices = [dict(r) for r in await conn.fetch("""SELECT f.*,v.value AS device,u.url FROM analytics.current_page_seo_device_daily f
        JOIN ref.dim_url u USING(url_key)
        LEFT JOIN analytics.ga4_value v ON v.kind='device' AND v.value_key=f.device_key
        WHERE f.project_key=ANY($1::smallint[]) AND f.date BETWEEN $2 AND $3""", *params)]
    bots = [dict(r) for r in await conn.fetch("""SELECT f.*,b.code AS bot,e.code AS engine,u.url FROM analytics.current_page_crawl_daily f
        JOIN ref.dim_url u USING(url_key)
        LEFT JOIN analytics.dim_crawl_bot b USING(bot_key) LEFT JOIN ref.dim_engine e ON e.engine_key=b.engine_key
        WHERE f.project_key=ANY($1::smallint[]) AND f.date BETWEEN $2 AND $3""", *params)]
    if values(q, "device"):
        selected = values(q, "device")
        for r in rows:
            r["seo_impressions"] = observed_sum([d for d in devices if (d["project_key"], d["url_key"], d["date"]) == (r["project_key"], r["url_key"], r["date"]) and d["device"] in selected], "seo_impressions")
    if values(q, "engine"):
        selected = values(q, "engine")
        for r in rows:
            r["ai_crawls"] = observed_sum([d for d in bots if (d["project_key"], d["url_key"], d["date"]) == (r["project_key"], r["url_key"], r["date"]) and d["engine"] in selected], "hits")
    groups = defaultdict(list)
    for r in rows:
        groups[(r["project_key"], r["url_key"], r["url"], r["title"], r["country"])].append(r)
    pages = [{"project_key": k[0], "url_key": k[1], "url": k[2], "title": k[3], "country": k[4],
              "seo_impressions": observed_sum(v, "seo_impressions"), "ai_crawls": observed_sum(v, "ai_crawls")} for k, v in groups.items()]
    seo = sorted(p["seo_impressions"] for p in pages if p["seo_impressions"] is not None)
    crawl = sorted(p["ai_crawls"] for p in pages if p["ai_crawls"] is not None)
    counts = dict.fromkeys(("both", "seo_only", "crawl_only", "neither"), 0)
    seo_mid, crawl_mid = (seo[len(seo)//2] if seo else None), (crawl[len(crawl)//2] if crawl else None)
    for p in pages:
        a, s = p["ai_crawls"], p["seo_impressions"]
        if None not in (a, s, seo_mid, crawl_mid):
            quadrant = "both" if s >= seo_mid and a >= crawl_mid else "seo_only" if s >= seo_mid else "crawl_only" if a >= crawl_mid else "neither"
            p["quadrant"] = quadrant
            counts[quadrant] += 1
        else:
            p["quadrant"] = None
    data.update(metrics={"seo_impressions": observed_sum(rows, "seo_impressions"), "ai_crawls": observed_sum(rows, "ai_crawls"),
                "pages": len(pages) if pages else None, **{k: v if pages and len(seo) == len(crawl) == len(pages) else None for k, v in counts.items()}},
                pages=pages, devices=devices, bots=bots, trend=[{"date": day,
                "seo_impressions": observed_sum([r for r in rows if r["date"] == day], "seo_impressions"),
                "ai_crawls": observed_sum([r for r in rows if r["date"] == day], "ai_crawls")} for day in sorted({r["date"] for r in rows})])
    data["priorities"] = [dict(r) for r in await conn.fetch("""SELECT f.*,u.url FROM analytics.current_page_priority f
        JOIN ref.dim_url u USING(url_key) WHERE f.project_key=ANY($1::smallint[])
        AND EXISTS(SELECT 1 FROM analytics.current_page_visibility_daily d
            WHERE (d.project_key,d.url_key,d.build_id)=(f.project_key,f.url_key,f.build_id) AND d.date BETWEEN $2 AND $3)
        ORDER BY f.priority NULLS LAST,f.url_key""", *params)]
    return result("visibility", data, reason=None if rows else "no_measurements")


async def read(kind, q):
    try:
        async with analytics_db.connection() as conn:
            return await (conversion(conn, q) if kind == "conversion" else visibility(conn, q))
    except (ConnectionError, OSError, asyncpg.PostgresError, TimeoutError):
        return empty(kind, "source_unavailable")
