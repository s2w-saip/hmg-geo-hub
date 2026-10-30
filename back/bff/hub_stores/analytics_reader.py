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
                   "human_users", "human_conversions", "human_conversion_rate", "session_share", "page_views", "total_sessions")
VISIBILITY_KEYS = ("seo_impressions", "ai_crawls", "pages", "both", "seo_only", "crawl_only", "neither")


def percent(n, d):
    return 100 * n / d if n is not None and d is not None and d > 0 else None


def observed_sum(rows, column):
    """No observation is different from an observed zero. Do not hide partially missing sums."""
    if not rows or any(row.get(column) is None for row in rows):
        return None
    return sum(row[column] for row in rows)


def grouped(rows, key):
    """key → its rows, in row order (one pass instead of a scan per key)."""
    out = defaultdict(list)
    for r in rows:
        out[key(r)].append(r)
    return out


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
                  "windows": [], "channels": [], "segments": {"device": [], "visitor_type": []}, "missing": [],
                  "devices": [], "bots": [], "priorities": []}, reason=reason)


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
        ev.value AS event,ch.value AS channel,dv.value AS device,nv.value AS nvr
        FROM analytics.ga4_row r LEFT JOIN ref.dim_engine e USING(engine_key)
        LEFT JOIN analytics.ga4_value v ON v.kind='page' AND v.value_key=r.page_key
        LEFT JOIN ref.dim_url u ON u.url_key=v.url_key
        LEFT JOIN analytics.ga4_value ev ON ev.kind='event' AND ev.value_key=r.event_key
        LEFT JOIN analytics.ga4_value ch ON ch.kind='channel' AND ch.value_key=r.channel_key
        LEFT JOIN analytics.ga4_value dv ON dv.kind='device' AND dv.value_key=r.device_key
        LEFT JOIN analytics.ga4_value nv ON nv.kind='nvr' AND nv.value_key=r.nvr_key
        WHERE {' AND '.join(where)} ORDER BY r.date,r.prop_key,r.report""", *b.args)]
    windows = [dict(r) for r in await conn.fetch("""SELECT w.*,v.value AS page,u.url FROM analytics.ga4_users_window w
        LEFT JOIN analytics.ga4_value v ON v.kind='page' AND v.value_key=w.page_key LEFT JOIN ref.dim_url u ON u.url_key=v.url_key
        WHERE w.prop_key=ANY($1::smallint[]) AND w.window_end BETWEEN $2 AND $3 ORDER BY w.window_end,w.prop_key,w.cohort""", keys, start, end)]
    # The collector (back/analytics/ga4_collect.py) replaces whole days and leaves a daily `total` window for every
    # day it collected, so on such a day a report without a row observed zero (GA4 leaves out all-zero rows).
    collected = collected_days(windows)
    def complete(days):
        return frozenset(k for k in keys if days <= collected[k])
    period_days = {start + timedelta(days=i) for i in range(days)}
    whole = complete(period_days)
    # the collector's daily windows are there to tell a collected day from a missed one (rows from before it wrote them
    # cannot be checked)
    checkable = any(collected.get(k) for k in keys)
    named = {p["prop_key"]: p["property_id"] for p in properties}
    # the active properties the collector missed a day of the period for, and those days (the screen says why the sums
    # are unknown and leaves the 7-day blocks with such a day out)
    data["missing"] = [{"property_id": named[k], "days": sorted(period_days - collected[k])} for k in keys if k not in whole] if checkable else []
    def zero_if_collected(value, done=whole, prop_keys=keys):
        """A sum over the properties' days: an observed zero when every property was collected on them; unknown when the
        windows show one was not (the sum would be the other properties' only and shrink the total, 2026-10-30 W6)."""
        if set(prop_keys) <= done:
            return 0 if value is None else value
        return None if checkable else value
    def whole_only(value, prop_keys=keys):
        """A slice's sum over the period (engine, channel, segment conversions, landing page, event, market): unknown when a
        property it covers missed a day, like the period sums above (renewal audit 12-1, 2026-10-31). A slice without
        rows on a collected day is not listed, so there is no zero to fill in."""
        return value if set(prop_keys) <= whole or not checkable else None
    # Reports are separate observations: traffic, events and landing rows must never be added together.
    traffic = [r for r in rows if r["report"] == 2]
    totals = [r for r in rows if r["report"] == 5]
    events = [r for r in rows if r["report"] == 3]
    ai_traffic = [r for r in traffic if r["is_ai"] is True]
    ai_sessions = zero_if_collected(observed_sum(ai_traffic, "sessions"))
    total_sessions = zero_if_collected(observed_sum(totals, "sessions"))
    ai_events = [r for r in events if r["is_ai"] is True and r["is_conv"] is True]
    general_events = [r for r in events if r["is_ai"] is False and r["is_conv"] is True]
    whole_period = set(keys) <= whole or not checkable
    ai_conv = conversions(rows, properties, complete=whole) if whole_period else None
    general_conv = conversions(rows, properties, ai=False, complete=whole) if whole_period else None
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
    def general_sessions(t1, total, ai):
        """The non-AI channels of report 1 only: reports are separate observations, so report 5's total less report 2's
        AI sessions is no stand-in (2026-10-30 W6 review)."""
        return t1
    human_sessions = general_sessions(zero_if_collected(observed_sum([r for r in rows if r["report"] == 1 and r["is_ai"] is False], "sessions")),
                                      total_sessions, ai_sessions)
    data["metrics"] = {"ai_sessions": ai_sessions, "ai_users": ai_users, "ai_conversions": ai_conv,
        "ai_conversion_rate": percent(ai_conv, ai_users), "human_sessions": human_sessions, "human_users": human_users,
        "human_conversions": general_conv, "human_conversion_rate": percent(general_conv, human_users),
        "session_share": percent(ai_sessions, total_sessions), "page_views": zero_if_collected(observed_sum(totals, "page_views")),
        "total_sessions": total_sessions}
    # 2026-10-30: every series below is a slice of the same stored rows (report 1 channels, device × new/returning on
    # every report, the same-page general sessions of report 4, the AI · general split of report 3); nothing is estimated.
    def day_values(day, mine):
        done = complete({day})
        ai = zero_if_collected(observed_sum([r for r in mine if r["report"] == 2 and r["is_ai"] is True], "sessions"), done)
        total = zero_if_collected(observed_sum([r for r in mine if r["report"] == 5], "sessions"), done)
        general = zero_if_collected(observed_sum([r for r in mine if r["report"] == 1 and r["is_ai"] is False], "sessions"), done)
        whole_day = set(keys) <= done or not checkable
        return {"date": day, "ai_sessions": ai, "ai_conversions": conversions(mine, properties, complete=done) if whole_day else None,
                "ai_users": exact_users("ai", window_end=day, window_days=1), "total_sessions": total,
                "human_sessions": general_sessions(general, total, ai),
                "human_conversions": conversions(mine, properties, ai=False, complete=done) if whole_day else None,
                "human_users": exact_users("general", window_end=day, window_days=1)}
    data["trend"] = [day_values(day, mine) for day, mine in sorted(grouped(rows, lambda r: r["date"]).items())]
    data["engines"] = [{"engine": engine, "sessions": whole_only(observed_sum(mine, "sessions")), "page_views": whole_only(observed_sum(mine, "page_views")),
        "conversions": whole_only(conversions([r for r in rows if r["engine"] == engine], properties, complete=whole))}
        for engine, mine in sorted(grouped([r for r in ai_traffic if r["engine"]], lambda r: r["engine"]).items())]
    # report 1 has no engine: an engine pick would drop the AI channel row and leave the site total without AI sessions
    data["channels_reason"] = "engine" if values(q, "engine") else None
    data["channels"] = [] if values(q, "engine") else [{"channel": channel, "is_ai": any(r["is_ai"] is True for r in mine),
        "sessions": whole_only(observed_sum(mine, "sessions")), "key_events": whole_only(observed_sum(mine, "key_events")),
        "page_views": whole_only(observed_sum(mine, "page_views"))}
        for channel, mine in sorted(grouped([r for r in rows if r["report"] == 1 and r.get("channel")], lambda r: r["channel"]).items())]
    def segments(kind):
        return [{"value": value,
                 "ai_sessions": zero_if_collected(observed_sum([r for r in mine if r["report"] == 2 and r["is_ai"] is True], "sessions")),
                 "human_sessions": zero_if_collected(observed_sum([r for r in mine if r["report"] == 1 and r["is_ai"] is False], "sessions")),
                 "ai_conversions": whole_only(conversions(mine, properties, complete=whole)),
                 "human_conversions": whole_only(conversions(mine, properties, ai=False, complete=whole))}
                for value, mine in sorted(grouped([r for r in rows if r.get(kind)], lambda r: r[kind]).items())]
    data["segments"] = {"device": segments("device"), "visitor_type": segments("nvr")}
    landing = [r for r in rows if r["report"] == 4]
    data["pages"] = []
    for url, mine in sorted(grouped([r for r in landing if r["url"] or r["page"]], lambda r: r["url"] or r["page"]).items()):
        ai, general = [r for r in mine if r["is_ai"] is True], [r for r in mine if r["is_ai"] is False]
        data["pages"].append({"url": url, "sessions": whole_only(observed_sum(ai, "sessions")), "page_views": whole_only(observed_sum(mine, "page_views")),
            "ai_page_views": whole_only(observed_sum(ai, "page_views")), "ai_key_events": whole_only(observed_sum(ai, "key_events")),
            "human_sessions": whole_only(observed_sum(general, "sessions")), "human_key_events": whole_only(observed_sum(general, "key_events"))})
    data["events"] = [{"event": event, "count": whole_only(observed_sum(mine, "event_count")), "tracked": any(r["is_conv"] for r in mine),
        "ai_count": zero_if_collected(observed_sum([r for r in mine if r["is_ai"] is True], "event_count")),
        "human_count": zero_if_collected(observed_sum([r for r in mine if r["is_ai"] is False], "event_count"))}
        for event, mine in sorted(grouped([r for r in events if r["event"]], lambda r: r["event"]).items())]
    data["windows"] = windows
    by_prop = grouped(rows, lambda r: r["prop_key"])
    def market(p):
        mine, k = by_prop.get(p["prop_key"], []), [p["prop_key"]]
        return {"property_id": p["property_id"], "country": p["country"], "brand": BRAND_NAMES.get(p["brand_bit"]),
                "ai_users": exact_users("ai", k),
                "ai_sessions": zero_if_collected(observed_sum([r for r in mine if r["report"] == 2 and r["is_ai"] is True], "sessions"), prop_keys=k),
                "ai_conversions": whole_only(conversions(mine, [p], complete=whole), prop_keys=k),
                "human_users": exact_users("general", k),
                "human_sessions": zero_if_collected(observed_sum([r for r in mine if r["report"] == 1 and r["is_ai"] is False], "sessions"), prop_keys=k),
                "human_conversions": whole_only(conversions(mine, [p], ai=False, complete=whole), prop_keys=k)}
    data["countries"] = [market(p) for p in properties]
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


async def properties(conn, q):
    """The GA4 properties the account can read, every status (the collector's analytics.ga4_property): the AI
    Conversion panel's 국가 options (2026-10-30)."""
    b = SQL()
    parts = filters(q, b)
    rows = [dict(r) for r in await conn.fetch(f"""SELECT p.property_id,p.brand_bit,p.status,c.code AS country FROM analytics.ga4_property p
        LEFT JOIN ref.dim_country c USING(geo_key) WHERE {' AND '.join(parts) or 'true'} ORDER BY c.code,p.property_id""", *b.args)]
    return result("properties", {"properties": rows})


async def read(kind, q):
    try:
        async with analytics_db.connection() as conn:
            return await {"conversion": conversion, "visibility": visibility, "properties": properties}[kind](conn, q)
    except (ConnectionError, OSError, asyncpg.PostgresError, TimeoutError):
        return result(kind, {"properties": []}, reason="source_unavailable") if kind == "properties" else empty(kind, "source_unavailable")
