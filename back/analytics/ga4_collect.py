"""GA4 → HUB data DB collector: the one writer of analytics.ga4_* (2026-10-29).

Reads the GA4 Data API (runReport, v1beta) for every property of the registry and replaces that property's rows
for the collected days, one transaction per property. It writes with the HUB writer role
(HGH_ANALYTICS_WRITER_DB_URL, .env.analytics-ingest.local); the GA4 credentials (.env.ga4.local) reach this
process only. The BFF reads the stored rows (back/bff/hub_stores/analytics_reader.py) and never calls GA4.

What a property gets per collected day — the reader's contract; reports are separate observations, never added
together, and every report carries device × new/returning so the screen's filters cut all of them alike:
  report 1 traffic_total  channel group: sessions, users_day, key_events, page_views (is_ai = the AI channel)
  report 2 traffic_ai     AI sessions by sessionSource (→ engine): the same metrics
  report 3 events         eventName, AI by sessionSource | non-AI channels together: event_count, key_events;
                          is_conv = one of the property's tracked events (basis 2) or a GA4 key event (basis 1)
  report 4 landing        AI landing pages by sessionSource, and the non-AI sessions of the pages with AI landings
                          in the 90 days up to the last collected day (or in the collected days, when longer) — the
                          same-page baseline; a day reads the same rows whichever run collects it: sessions,
                          users_day, key_events, page_views
  report 5 totals         all traffic: sessions, users_day, key_events, page_views
  ga4_users_window        exact activeUsers (GA4 deduplicates) for the cohorts ai · general · total: each day
                          (window_days 1), and 7 · 28 · 90 days ending at the last collected day and at the end of
                          the period before it, so a period can be compared. No filter combinations (masks 0).
"AI" is GA4's default channel group "AI Assistant" (front/lib/ga4/client.ts, the product definition since
2026-06-12). Metrics a report does not ask for stay null. A query that answered without a row is an observed
zero (GA4 leaves out all-zero rows). A property GA4 refuses (403) is stored as pending_grant and keeps its rows; a
property the registry stops is stored as unmapped (the reader leaves it out) and keeps its rows. A collected
property's stored event rows take is_conv from its current basis on every run, so a basis or event change covers
every collected day, not only the days read again. Each property's result goes to analytics.ga4_collect_status.

  python -X utf8 back/analytics/ga4_collect.py                  # the last 3 days up to yesterday (see last_day)
  python -X utf8 back/analytics/ga4_collect.py --backfill 180   # the first load
  python -X utf8 back/analytics/ga4_collect.py --from 2026-10-01 --to 2026-10-20 --property 469542848
  python -X utf8 back/analytics/ga4_collect.py --dry-run        # read GA4, print the counts, write nothing

Registry: analytics.ga4_registry in the same database, kept on the renewal Admin › GA4 연동 screen
(back/bff/hub_stores/ga4_registry.py); --dry-run reads it too."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ENV_FILES = (ROOT / ".env.analytics-ingest.local", ROOT / ".env.ga4.local")

API = "https://analyticsdata.googleapis.com/v1beta"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
AI_CHANNEL = "AI Assistant"
PAGE_LIMIT = 100_000
PAGES_PER_FILTER = 100      # landing pages per in-list filter of the non-AI landing query
WINDOWS = (7, 28, 90)
PAGE_LOOKBACK = 90          # the same-page baseline: pages with AI landings in this many days up to the last day
REFRESH_DAYS = 3            # GA4 keeps settling the last days: every run reads them again
RETRYABLE = {0, 429, 500, 502, 503, 504}   # 0 = no answer
ATTEMPTS = 5
TIMEOUT_S = 60
RUN_LOCK = 617427420        # one collector at a time (session advisory lock on the data connection)
# HUB code tables; tests check them against bff.hub_stores.analytics_reader
BRAND_BITS = {"hyundai": 1, "kia": 2, "genesis": 4}
# sessionSource host → the engine code of ref.dim_engine (the answer engines' codes; the filter panel's values)
ENGINE_HOSTS = (("chatgpt.com", "chatgpt"), ("openai.com", "chatgpt"), ("gemini.google.com", "gemini"), ("bard.google.com", "gemini"),
                ("perplexity.ai", "perplexity"), ("claude.ai", "claude"), ("copilot.microsoft.com", "copilot"), ("copilot.com", "copilot"))
COLUMNS = ("prop_key", "date", "report", "channel_key", "source_key", "device_key", "nvr_key", "page_key", "event_key",
           "is_ai", "engine_key", "is_conv", "sessions", "users_day", "page_views", "key_events", "event_count")
DIMS = ("channel", "source", "device", "nvr", "page", "event")


class Ga4Error(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"GA4 {status}: {message}")
        self.status = status


class AccessDenied(Ga4Error):
    """The credentials may not read this property (403): access not granted yet."""


# ── registry ─────────────────────────────────────────────────────────────────

REGISTRY_SQL = """SELECT property_id,brand,country,conv_basis,conv_events,enabled,now() AS read_at
    FROM analytics.ga4_registry ORDER BY property_id"""


async def load_registry(conn) -> list[dict]:
    """The registered properties (analytics.ga4_registry). Its constraints hold the rules the file registry had:
    property_id digits, brand Hyundai · Kia · Genesis, country ISO-2, conv_basis 1 GA4 key events | 2 the listed
    events (at least one); and one enabled property per market. `read_at` is when this run read it: the collect
    status's checked_at, so a change made during the run still shows as not applied."""
    return [{"property_id": r["property_id"], "brand_bit": BRAND_BITS[r["brand"].lower()], "country": r["country"],
             "basis": r["conv_basis"], "events": frozenset(r["conv_events"] or ()), "enabled": r["enabled"],
             "read_at": r["read_at"]} for r in await conn.fetch(REGISTRY_SQL)]


def engine_of(source: str) -> str | None:
    host = source.strip().lower().split("/")[0]
    for domain, engine in ENGINE_HOSTS:
        if host == domain or host.endswith("." + domain):
            return engine
    return None


# ── GA4 Data API ─────────────────────────────────────────────────────────────

def _post(urlopen, url: str, data: bytes, headers: dict) -> tuple[int, dict]:
    """(HTTP status, JSON body); 0 when the request did not get an answer (network, timeout)."""
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urlopen(req, timeout=TIMEOUT_S) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read() or b"{}")
        except ValueError:
            body = {}
        return e.code, body
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        return 0, {"error": {"message": f"no answer ({type(e).__name__})"}}


class Tokens:
    """An access token for the analytics.readonly scope, renewed a minute before it expires.
    OAuth: GA4_OAUTH_CLIENT_ID · GA4_OAUTH_CLIENT_SECRET · GA4_OAUTH_REFRESH_TOKEN (the old web's variables).
    Service account: GA4_SERVICE_ACCOUNT_FILE (the JSON key; signing needs the google-auth package)."""

    def __init__(self, env: dict, urlopen=urllib.request.urlopen, clock=time.time):
        self.env, self.urlopen, self.clock = env, urlopen, clock
        self.token, self.expires = None, 0.0
        if not (env.get("GA4_SERVICE_ACCOUNT_FILE") or all(env.get(k) for k in ("GA4_OAUTH_CLIENT_ID", "GA4_OAUTH_CLIENT_SECRET", "GA4_OAUTH_REFRESH_TOKEN"))):
            raise ValueError("GA4 credentials missing: GA4_SERVICE_ACCOUNT_FILE, or GA4_OAUTH_CLIENT_ID + GA4_OAUTH_CLIENT_SECRET + GA4_OAUTH_REFRESH_TOKEN (.env.ga4.local)")

    def get(self, force: bool = False) -> str:
        if force or not self.token or self.clock() > self.expires - 60:
            self.token, ttl = self._fetch()
            self.expires = self.clock() + ttl
        return self.token

    def _fetch(self) -> tuple[str, float]:
        env = self.env
        if env.get("GA4_SERVICE_ACCOUNT_FILE"):
            try:
                from google.auth import crypt, jwt
            except ModuleNotFoundError:
                raise ValueError("a service account key needs the google-auth package (pip install google-auth)") from None
            info = json.loads(Path(env["GA4_SERVICE_ACCOUNT_FILE"]).read_text(encoding="utf-8"))
            now = int(self.clock())
            audience = info.get("token_uri") or TOKEN_URL
            assertion = jwt.encode(crypt.RSASigner.from_service_account_info(info),
                                   {"iss": info["client_email"], "scope": SCOPE, "aud": audience, "iat": now, "exp": now + 3600})
            url, form = audience, {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion.decode()}
        else:
            url, form = TOKEN_URL, {"grant_type": "refresh_token", "client_id": env["GA4_OAUTH_CLIENT_ID"],
                                    "client_secret": env["GA4_OAUTH_CLIENT_SECRET"], "refresh_token": env["GA4_OAUTH_REFRESH_TOKEN"]}
        status, body = _post(self.urlopen, url, urllib.parse.urlencode(form).encode(), {"Content-Type": "application/x-www-form-urlencoded"})
        if status != 200 or not body.get("access_token"):
            # the token endpoint's error code only: never echo the request (it carries the secret)
            raise Ga4Error(status, f"token refused ({body.get('error', 'no access_token')})")
        return body["access_token"], float(body.get("expires_in", 3600))


def _number(v: str) -> int:
    try:
        return int(v)
    except ValueError:
        return round(float(v))


class Ga4:
    """runReport with retries (429 · 5xx back off, 401 renews the token once) and pagination. A report is
    (rows as {dimension: value, metric: int}, notes: what GA4 says about the answer)."""

    def __init__(self, tokens: Tokens, urlopen=urllib.request.urlopen, sleep=time.sleep):
        self.tokens, self.urlopen, self.sleep = tokens, urlopen, sleep

    def run_report(self, property_id: str, body: dict) -> dict:
        renewed = False
        for attempt in range(1, ATTEMPTS + 1):
            headers = {"Authorization": f"Bearer {self.tokens.get()}", "Content-Type": "application/json"}
            status, answer = _post(self.urlopen, f"{API}/properties/{property_id}:runReport", json.dumps(body).encode(), headers)
            if status == 200:
                return answer
            message = (answer.get("error") or {}).get("message") or "no message"
            if status == 401 and not renewed:
                self.tokens.get(force=True)
                renewed = True
                continue
            if status == 403:
                raise AccessDenied(status, message)
            if status in RETRYABLE and attempt < ATTEMPTS:
                self.sleep(min(30.0, 2.0 ** attempt))
                continue
            raise Ga4Error(status, message)
        raise Ga4Error(0, "no answer")

    def report(self, property_id: str, body: dict) -> tuple[list[dict], set[str]]:
        rows, notes, offset = [], set(), 0
        while True:
            answer = self.run_report(property_id, {**body, "limit": PAGE_LIMIT, "offset": offset})
            dims = [h["name"] for h in answer.get("dimensionHeaders") or []]
            mets = [h["name"] for h in answer.get("metricHeaders") or []]
            for r in answer.get("rows") or []:
                row = {d: v.get("value", "") for d, v in zip(dims, r.get("dimensionValues") or [], strict=True)}
                row.update({m: _number(v.get("value", "0")) for m, v in zip(mets, r.get("metricValues") or [], strict=True)})
                rows.append(row)
            meta = answer.get("metadata") or {}
            if meta.get("subjectToThresholding"):
                notes.add("thresholded")
            if meta.get("dataLossFromOtherRow"):
                notes.add("other_row")
            if meta.get("samplingMetadatas"):
                notes.add("sampled")
            offset += PAGE_LIMIT
            if offset >= int(answer.get("rowCount") or 0):
                return rows, notes

    def time_zone(self, property_id: str) -> str | None:
        answer = self.run_report(property_id, {"dateRanges": [{"startDate": "yesterday", "endDate": "yesterday"}], "metrics": [{"name": "sessions"}], "limit": 1})
        return (answer.get("metadata") or {}).get("timeZone")


# ── what to ask GA4 ──────────────────────────────────────────────────────────

def _eq(field: str, value: str) -> dict:
    return {"filter": {"fieldName": field, "stringFilter": {"matchType": "EXACT", "value": value}}}


AI = _eq("sessionDefaultChannelGroup", AI_CHANNEL)
NOT_AI = {"notExpression": AI}
SPLIT = ("deviceCategory", "newVsReturning")
TRAFFIC = ("sessions", "activeUsers", "keyEvents", "screenPageViews")
EVENTS = ("eventCount", "keyEvents")


def _body(start: date, end: date, dims: tuple, metrics: tuple, where: dict | None = None) -> dict:
    body: dict = {"dateRanges": [{"startDate": start.isoformat(), "endDate": end.isoformat()}], "metrics": [{"name": m} for m in metrics]}
    if dims:
        body["dimensions"] = [{"name": d} for d in dims]
    if where:
        body["dimensionFilter"] = where
    return body


def _day(v: str) -> date:
    return date(int(v[:4]), int(v[4:6]), int(v[6:8]))


def _row(report: int, r: dict, *, channel: str = "", source: str = "", page: str = "", event: str = "", is_ai: bool,
         engine: str | None = None, is_conv: bool | None = None) -> dict:
    return {"report": report, "date": _day(r["date"]), "channel": channel, "source": source, "device": r.get("deviceCategory", ""),
            "nvr": r.get("newVsReturning", ""), "page": page, "event": event, "is_ai": is_ai, "engine": engine, "is_conv": is_conv,
            "sessions": r.get("sessions"), "users_day": r.get("activeUsers"), "page_views": r.get("screenPageViews"),
            "key_events": r.get("keyEvents"), "event_count": r.get("eventCount")}


def collect(ga4: Ga4, prop: dict, start: date, end: date) -> dict:
    """Every row and window of one property for [start, end] (GA4 dates are the property's own days)."""
    pid, notes, rows = prop["property_id"], set(), []

    def ask(dims: tuple, metrics: tuple, where: dict | None = None, frm: date = start, to: date = end) -> list[dict]:
        got, why = ga4.report(pid, _body(frm, to, dims, metrics, where))
        notes.update(why)
        return got

    for r in ask(("date", "sessionDefaultChannelGroup", *SPLIT), TRAFFIC):
        channel = r["sessionDefaultChannelGroup"]
        rows.append(_row(1, r, channel=channel, is_ai=channel == AI_CHANNEL))
    for r in ask(("date", "sessionSource", *SPLIT), TRAFFIC, AI):
        rows.append(_row(2, r, channel=AI_CHANNEL, source=r["sessionSource"], is_ai=True, engine=engine_of(r["sessionSource"])))

    def tracked(r: dict) -> bool:
        return r["eventName"] in prop["events"] if prop["basis"] == 2 else r.get("keyEvents", 0) > 0

    for r in ask(("date", "eventName", "sessionSource", *SPLIT), EVENTS, AI):
        rows.append(_row(3, r, channel=AI_CHANNEL, source=r["sessionSource"], event=r["eventName"], is_ai=True,
                         engine=engine_of(r["sessionSource"]), is_conv=tracked(r)))
    for r in ask(("date", "eventName", *SPLIT), EVENTS, NOT_AI):
        rows.append(_row(3, r, event=r["eventName"], is_ai=False, is_conv=tracked(r)))
    landing = ask(("date", "landingPage", "sessionSource", *SPLIT), TRAFFIC, AI)
    for r in landing:
        rows.append(_row(4, r, channel=AI_CHANNEL, source=r["sessionSource"], page=r["landingPage"], is_ai=True, engine=engine_of(r["sessionSource"])))
    since = min(start, end - timedelta(days=PAGE_LOOKBACK - 1))
    pages = sorted({r["landingPage"] for r in ask(("landingPage",), ("sessions",), AI, since, end)})
    for i in range(0, len(pages), PAGES_PER_FILTER):
        chunk = {"filter": {"fieldName": "landingPage", "inListFilter": {"values": pages[i:i + PAGES_PER_FILTER]}}}
        for r in ask(("date", "landingPage", *SPLIT), TRAFFIC, {"andGroup": {"expressions": [NOT_AI, chunk]}}):
            rows.append(_row(4, r, page=r["landingPage"], is_ai=False))
    for r in ask(("date", *SPLIT), TRAFFIC):
        rows.append(_row(5, r, is_ai=False))
    # exact users: every day, then the 7 · 28 · 90-day windows ending at `end` and at the end of the period before
    windows = []
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    cohorts = (("ai", AI), ("general", NOT_AI), ("total", None))
    for cohort, where in cohorts:
        per_day = {_day(r["date"]): r.get("activeUsers", 0) for r in ask(("date",), ("activeUsers",), where)}
        windows += [{"window_end": d, "window_days": 1, "cohort": cohort, "users": per_day.get(d, 0)} for d in days]
    for n in WINDOWS:
        for w_end in (end, end - timedelta(days=n)):
            for cohort, where in cohorts:
                got = ask((), ("activeUsers",), where, w_end - timedelta(days=n - 1), w_end)
                windows.append({"window_end": w_end, "window_days": n, "cohort": cohort, "users": got[0].get("activeUsers", 0) if got else 0})
    return {"rows": rows, "windows": windows, "notes": sorted(notes)}


# ── HUB data DB ──────────────────────────────────────────────────────────────

async def _geo_key(conn, code: str) -> int:
    key = await conn.fetchval("SELECT geo_key FROM ref.dim_country WHERE lower(code)=lower($1)", code)
    return key if key is not None else await conn.fetchval("INSERT INTO ref.dim_country(code) VALUES($1) RETURNING geo_key", code)


async def save_property(conn, prop: dict, status: str) -> int:
    return await conn.fetchval("""INSERT INTO analytics.ga4_property(property_id,brand_bit,geo_key,status,source,conv_basis)
        VALUES($1,$2,$3,$4,'registry',$5) ON CONFLICT(property_id) DO UPDATE SET brand_bit=EXCLUDED.brand_bit,geo_key=EXCLUDED.geo_key,
        status=EXCLUDED.status,source=EXCLUDED.source,conv_basis=EXCLUDED.conv_basis RETURNING prop_key""",
                               prop["property_id"], prop["brand_bit"], await _geo_key(conn, prop["country"]), status, prop["basis"])


# The property's stored event rows (report 3) follow its current basis: the listed events (2) or GA4 key events (1).
CONVERSION_SQL = """UPDATE analytics.ga4_row r SET is_conv=CASE WHEN $2=2 THEN v.value=ANY($3::text[]) ELSE coalesce(r.key_events,0)>0 END
    FROM analytics.ga4_value v WHERE r.prop_key=$1 AND r.report=3 AND v.kind='event' AND v.value_key=r.event_key
    AND r.is_conv IS DISTINCT FROM (CASE WHEN $2=2 THEN v.value=ANY($3::text[]) ELSE coalesce(r.key_events,0)>0 END)"""
# One row per property, replaced each run; a failed or refused run keeps the last successful collection.
STATUS_SQL = """INSERT INTO analytics.ga4_collect_status AS s(property_id,checked_at,status,error,collected_at,collected_to)
    VALUES($1,$2,$3,$4,CASE WHEN $5::date IS NULL THEN NULL ELSE now() END,$5)
    ON CONFLICT(property_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,status=EXCLUDED.status,error=EXCLUDED.error,
        collected_at=coalesce(EXCLUDED.collected_at,s.collected_at),collected_to=coalesce(EXCLUDED.collected_to,s.collected_to)"""


async def note(conn, prop: dict, status: str, error: str | None = None, collected_to: date | None = None) -> None:
    """The run's result for the property, for the Admin › GA4 연동 screen."""
    await conn.execute(STATUS_SQL, prop["property_id"], prop["read_at"], status, error[:500] if error else None, collected_to)


async def value_keys(conn, rows: list[dict]) -> dict[tuple[str, str], int]:
    """The ga4_value dictionary: existing keys stay, '' is 0 (not split), a new value takes its kind's next key."""
    wanted = {(k, r[k]) for r in rows for k in DIMS} | {(k, "") for k in DIMS}
    have = {(r["kind"], r["value"]): r["value_key"] for r in await conn.fetch("SELECT kind,value,value_key FROM analytics.ga4_value")}
    top = defaultdict(int)
    for (kind, _), key in have.items():
        top[kind] = max(top[kind], key)
    new = []
    for kind, value in sorted(wanted - have.keys()):
        key = 0 if value == "" else top[kind] + 1
        top[kind] = max(top[kind], key)
        have[(kind, value)] = key
        new.append((kind, key, value))
    if new:
        await conn.executemany("INSERT INTO analytics.ga4_value(kind,value_key,value) VALUES($1,$2,$3)", new)
    return have


async def engine_keys(conn, codes: set[str]) -> dict[str, int]:
    if codes:
        await conn.executemany("INSERT INTO ref.dim_engine(code) VALUES($1) ON CONFLICT(code) DO NOTHING", [(c,) for c in sorted(codes)])
    return {r["code"]: r["engine_key"] for r in await conn.fetch("SELECT code,engine_key FROM ref.dim_engine WHERE code=ANY($1::text[])", sorted(codes))}


async def store(conn, prop: dict, data: dict, start: date, end: date) -> int:
    """Replace the property's rows and day windows for [start, end] and its period windows, and set is_conv of
    its other days' event rows from its current basis; one transaction."""
    async with conn.transaction():
        prop_key = await save_property(conn, prop, "active")
        keys = await value_keys(conn, data["rows"])
        engines = await engine_keys(conn, {r["engine"] for r in data["rows"] if r["engine"]})
        records = [(prop_key, r["date"], r["report"], *(keys[(k, r[k])] for k in DIMS), r["is_ai"], engines.get(r["engine"]), r["is_conv"],
                    r["sessions"], r["users_day"], r["page_views"], r["key_events"], r["event_count"]) for r in data["rows"]]
        await conn.execute("DELETE FROM analytics.ga4_row WHERE prop_key=$1 AND date BETWEEN $2 AND $3", prop_key, start, end)
        if records:
            await conn.copy_records_to_table("ga4_row", schema_name="analytics", columns=list(COLUMNS), records=records)
        await conn.executemany("""INSERT INTO analytics.ga4_users_window(prop_key,window_end,window_days,cohort,engine_mask,device_mask,nvr_mask,page_key,users)
            VALUES($1,$2,$3,$4,0,0,0,0,$5) ON CONFLICT(prop_key,window_end,window_days,cohort,engine_mask,device_mask,nvr_mask,page_key)
            DO UPDATE SET users=EXCLUDED.users""", [(prop_key, w["window_end"], w["window_days"], w["cohort"], w["users"]) for w in data["windows"]])
        await conn.execute(CONVERSION_SQL, prop_key, prop["basis"], sorted(prop["events"]))
    return len(records)


# ── run ──────────────────────────────────────────────────────────────────────

def env_values() -> dict:
    """The process environment over the git-ignored env files (KEY=value lines)."""
    out: dict[str, str] = {}
    for path in ENV_FILES:
        if path.exists():
            out.update(line.split("=", 1) for line in path.read_text(encoding="utf-8-sig").splitlines() if "=" in line and not line.startswith("#"))
    return {**out, **{k: v for k, v in os.environ.items() if k.startswith(("GA4_", "HGH_"))}}


def yesterday(time_zone: str | None, now: datetime | None = None) -> date:
    now = now or datetime.now(UTC)
    try:
        zone = ZoneInfo(time_zone) if time_zone else UTC
    except (KeyError, ValueError):
        zone = UTC
    return now.astimezone(zone).date() - timedelta(days=1)


def last_day(ga4: Ga4, props: list[dict]) -> tuple[date | None, dict[str, Ga4Error]]:
    """One last day for every property: the reader ends a period at a single day for all of them and finds the
    period users' windows by that day, so the collector takes the earliest "yesterday" over the properties' time
    zones (a day complete everywhere). Properties GA4 refuses here come back as errors."""
    ends, errors = [], {}
    for p in props:
        try:
            ends.append(yesterday(ga4.time_zone(p["property_id"])))
        except Ga4Error as e:
            errors[p["property_id"]] = e
    return (min(ends) if ends else None), errors


def span(args, end: date) -> tuple[date, date]:
    end = date.fromisoformat(args.to) if args.to else end
    start = date.fromisoformat(args.frm) if args.frm else end - timedelta(days=(args.backfill or REFRESH_DAYS) - 1)
    if start > end:
        raise ValueError("--from is after --to")
    return start, end


async def run(args, env: dict, ga4: Ga4) -> list[dict]:
    """Every registered property: a stopped one is marked, the others collected. A dry run reads the registry and
    GA4 and writes nothing."""
    import asyncpg
    write = not args.dry_run
    conn = await asyncpg.connect(env["HGH_ANALYTICS_WRITER_DB_URL"], command_timeout=300)
    results = []
    try:
        if write and not await conn.fetchval("SELECT pg_try_advisory_lock($1)", RUN_LOCK):
            raise RuntimeError("another GA4 collector is running")
        props = await load_registry(conn)
        if args.property:
            props = [p for p in props if p["property_id"] in args.property]
            if not props:
                raise ValueError("--property: not in the registry")
        end, refused = (None, {}) if args.to else last_day(ga4, [p for p in props if p["enabled"]])
        for prop in props:
            result = {"property": prop["property_id"], "country": prop["country"]}
            try:
                if not prop["enabled"]:
                    if write:
                        await save_property(conn, prop, "unmapped")
                        await note(conn, prop, "stopped")
                    results.append({**result, "status": "stopped"})
                    continue
                if prop["property_id"] in refused:
                    raise refused[prop["property_id"]]
                if end is None and not args.to:
                    raise Ga4Error(0, "no property answered: no last day")
                start, end_ = span(args, end)
                data = collect(ga4, prop, start, end_)
                result.update({"from": start.isoformat(), "to": end_.isoformat(), "rows": len(data["rows"]), "windows": len(data["windows"]), "notes": data["notes"]})
                if write:
                    await store(conn, prop, data, start, end_)
                    await note(conn, prop, "collected", collected_to=end_)
                results.append({**result, "status": "active"})
            except AccessDenied as e:
                if write:
                    await save_property(conn, prop, "pending_grant")
                    await note(conn, prop, "pending_grant", str(e))
                results.append({**result, "status": "pending_grant", "error": str(e)})
            except Ga4Error as e:
                if write:
                    await note(conn, prop, "failed", str(e))
                results.append({**result, "status": "failed", "error": str(e)})
    finally:
        await conn.close()
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="frm", help=f"first day (YYYY-MM-DD); default: the last {REFRESH_DAYS} days")
    parser.add_argument("--to", help="last day (YYYY-MM-DD); default: the earliest yesterday over the properties' time zones")
    parser.add_argument("--backfill", type=int, help="collect the last N days (the first load: 180)")
    parser.add_argument("--property", action="append", help="only this property id (repeatable)")
    parser.add_argument("--dry-run", action="store_true", help="read GA4 and print the counts; write nothing")
    args = parser.parse_args(argv)
    if args.backfill is not None and not 1 <= args.backfill <= 1000:
        parser.error("--backfill must be 1..1000")
    env = env_values()
    if not env.get("HGH_ANALYTICS_WRITER_DB_URL"):
        parser.error("HGH_ANALYTICS_WRITER_DB_URL missing (.env.analytics-ingest.local): the registry and the rows live in the HUB data DB")
    results = asyncio.run(run(args, env, Ga4(Tokens(env))))
    print(json.dumps({"at": datetime.now(UTC).isoformat(timespec="seconds"), "dry_run": args.dry_run, "properties": results}, ensure_ascii=False, indent=1))
    return 1 if any(r["status"] == "failed" for r in results) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print(f"ga4_collect: {error}", file=sys.stderr)
        sys.exit(1)
