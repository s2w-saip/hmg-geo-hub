"""The Admin › GA4 연동 event list: what needs gold_db (the collector's rows in `analytics`). The hub server keeps the registry (hub_server/inputs/ga4_registry.py)."""
from __future__ import annotations

import re

from fastapi import HTTPException

from data_server.hub_stores import analytics_db, input_db

PROPERTY = re.compile(r"[0-9]{1,20}")
EXISTS_SQL = "SELECT 1 FROM catalog.ga4_registry WHERE property_id=$1"
EVENT_DAYS = 90


# The property's events in its last EVENT_DAYS collected days (report 3: every event, AI and other sessions).
EVENTS_SQL = """WITH p AS (SELECT prop_key FROM analytics.ga4_property WHERE property_id=$1),
    last AS (SELECT max(r.date) AS day FROM analytics.ga4_row r JOIN p USING(prop_key) WHERE r.report=3)
    SELECT v.value AS name,sum(r.event_count)::bigint AS count,sum(r.key_events)::bigint AS key_events,
        min(last.day) AS last_day
    FROM analytics.ga4_row r JOIN p USING(prop_key) CROSS JOIN last
    JOIN analytics.ga4_value v ON v.kind='event' AND v.value_key=r.event_key
    WHERE r.report=3 AND r.date>last.day-$2::int AND v.value<>''
    GROUP BY v.value ORDER BY count DESC,name"""


async def events(pid: str) -> dict:
    """The event names the collector stored for the property, with their counts, newest EVENT_DAYS days; none
    before its first collection."""
    try:
        async with input_db.connection() as conn:
            known = await conn.fetchval(EXISTS_SQL, pid)
    except ConnectionError:
        raise HTTPException(503, "HUB input store is not configured") from None
    if known is None:
        raise HTTPException(404, "No such GA4 property")
    try:
        async with analytics_db.connection() as conn:
            rows = await conn.fetch(EVENTS_SQL, pid, EVENT_DAYS)
    except ConnectionError:
        raise HTTPException(503, "GA4 data is not configured") from None
    last = rows[0]["last_day"] if rows else None
    return {"days": EVENT_DAYS, "to": last, "events": [{"name": r["name"], "count": r["count"], "keyEvent": r["key_events"] > 0} for r in rows]}
