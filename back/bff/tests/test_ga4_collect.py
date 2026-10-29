"""The GA4 collector (back/analytics/ga4_collect.py) against a GA4 Data API emulator.

The emulator holds synthetic sessions and answers runReport as the API does: rows grouped by the requested
dimensions, dimension filters, distinct users, all-zero rows left out, offset / limit pages. The collector's rows
then go through the real BFF reader (hub_stores/analytics_reader.py conversion()), and every number the screen
shows must equal the truth counted straight from the sessions.

HGH_GA4_TEST_DB_URL (a throwaway database loaded with back/analytics/schema.sql — the test deletes and writes
GA4 rows there) adds the run through PostgreSQL: store() and the reader's own SQL."""
import asyncio
import importlib.util
import io
import json
import os
import random
import unittest
import urllib.error
import urllib.parse
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest import mock

try:
    from starlette.datastructures import QueryParams

    from bff.hub_stores import analytics_reader
    spec = importlib.util.spec_from_file_location("ga4_collect", Path(__file__).resolve().parents[2] / "analytics" / "ga4_collect.py")
    ga4c = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ga4c)
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_ga4_collect)") from exc

TODAY = date(2026, 10, 29)            # in the property's time zone; yesterday = the last collected day
END = TODAY - timedelta(days=1)
START = END - timedelta(days=59)      # 60 days collected
AI = "AI Assistant"
KEY_EVENTS = {"test_drive_request"}   # the property's GA4 key events
PAGES = ["/it/", "/it/modelli/ev3/scopri/", "/it/modelli/sportage/scopri/", "/it/offerte/", "/it/test-drive/", "/it/concessionari/",
         "/it/elettrico/", "/it/modelli/ev9/scopri/", "/it/finanziamenti/", "/it/assistenza/", "/it/modelli/picanto/scopri/", "/it/news/"]
AI_SOURCES = [("chatgpt.com", 60), ("gemini.google.com", 20), ("perplexity.ai", 10), ("copilot.microsoft.com", 5), ("edgeservices.bing.com", 5)]
OTHER = [("Organic Search", "google"), ("Direct", "(direct)"), ("Paid Search", "google"), ("Referral", "hyundai.it"), ("Organic Social", "instagram.com")]


def sessions(seed=7) -> list[dict]:
    """Two months of one property: ~40 sessions a day, ~5 of them from AI assistants, 400 users."""
    rnd, out = random.Random(seed), []
    for i in range((END - START).days + 1):
        d = START + timedelta(days=i)
        for _ in range(rnd.randint(30, 50)):
            ai = rnd.random() < 0.12
            channel, source = (AI, rnd.choices([s for s, _ in AI_SOURCES], [w for _, w in AI_SOURCES])[0]) if ai else rnd.choice(OTHER)
            views = rnd.randint(1, 6)
            events = ["page_view"] * views + ["scroll"] * rnd.randint(0, views)
            if rnd.random() < (0.10 if ai else 0.05):
                events.append("test_drive_request")
            if rnd.random() < 0.04:
                events.append("dealer_contact")
            out.append({"date": d, "user": rnd.randrange(400), "sessionDefaultChannelGroup": channel, "sessionSource": source,
                        "deviceCategory": rnd.choice(["mobile", "mobile", "desktop", "tablet"]), "newVsReturning": rnd.choice(["new", "returning"]),
                        "landingPage": rnd.choice(PAGES), "views": views, "events": events})
    return out


class Emulator:
    """runReport over `sessions` (dimension names and metric names of the GA4 Data API; dates as YYYYMMDD)."""

    def __init__(self, data: list[dict], deny: set[str] = frozenset(), fail: dict | None = None):
        self.data, self.deny, self.fail, self.calls, self.tokens = data, deny, fail or {}, [], 0

    def __call__(self, req, timeout=None):
        url, body = req.full_url, req.data
        if url == ga4c.TOKEN_URL:
            form = urllib.parse.parse_qs(body.decode())
            assert form["grant_type"] == ["refresh_token"] and form["refresh_token"] == ["rt"], form
            self.tokens += 1
            return self._answer(200, {"access_token": f"tok{self.tokens}", "expires_in": 3600})
        pid = url.split("/properties/")[1].split(":")[0]
        self.calls.append((pid, json.loads(body)))
        if self.fail.get(len(self.calls)):
            return self._answer(self.fail[len(self.calls)], {"error": {"message": "try again"}})
        if pid in self.deny:
            return self._answer(403, {"error": {"code": 403, "message": "User does not have sufficient permissions", "status": "PERMISSION_DENIED"}})
        return self._answer(200, self.run(json.loads(body)))

    @staticmethod
    def _answer(status, payload):
        raw = json.dumps(payload).encode()
        if status != 200:
            raise urllib.error.HTTPError("https://example.invalid", status, "error", {}, io.BytesIO(raw))
        res = mock.MagicMock(status=200)
        res.__enter__.return_value = res
        res.read.return_value = raw
        return res

    @staticmethod
    def _day(v: str) -> date:
        return {"yesterday": TODAY - timedelta(days=1), "today": TODAY}.get(v) or date.fromisoformat(v)

    def _match(self, expr, s) -> bool:
        if not expr:
            return True
        if "andGroup" in expr:
            return all(self._match(e, s) for e in expr["andGroup"]["expressions"])
        if "notExpression" in expr:
            return not self._match(expr["notExpression"], s)
        f = expr["filter"]
        v = s[f["fieldName"]]
        if "stringFilter" in f:
            assert f["stringFilter"]["matchType"] == "EXACT"
            return v == f["stringFilter"]["value"]
        return v in f["inListFilter"]["values"]

    def run(self, body: dict) -> dict:
        (rng,) = body["dateRanges"]
        lo, hi = self._day(rng["startDate"]), self._day(rng["endDate"])
        dims = [d["name"] for d in body.get("dimensions", [])]
        mets = [m["name"] for m in body["metrics"]]
        groups = defaultdict(lambda: {"sessions": 0, "users": set(), "screenPageViews": 0, "keyEvents": 0, "eventCount": 0})
        for s in self.data:
            if not lo <= s["date"] <= hi or not self._match(body.get("dimensionFilter"), s):
                continue
            view = {**s, "date": s["date"].strftime("%Y%m%d")}
            if "eventName" in dims:
                for e in s["events"]:
                    g = groups[tuple({**view, "eventName": e}[d] for d in dims)]
                    g["eventCount"] += 1
                    g["keyEvents"] += e in KEY_EVENTS
                    g["users"].add(s["user"])
                continue
            g = groups[tuple(view[d] for d in dims)]
            g["sessions"] += 1
            g["users"].add(s["user"])
            g["screenPageViews"] += s["views"]
            g["keyEvents"] += sum(e in KEY_EVENTS for e in s["events"])
            g["eventCount"] += len(s["events"])
        rows = []
        for key, g in sorted(groups.items()):
            values = [len(g["users"]) if m == "activeUsers" else g[m] for m in mets]
            if any(values):  # GA4 leaves out all-zero rows
                rows.append({"dimensionValues": [{"value": v} for v in key], "metricValues": [{"value": str(v)} for v in values]})
        offset, limit = int(body.get("offset", 0)), int(body.get("limit", 10000))
        return {"dimensionHeaders": [{"name": d} for d in dims], "metricHeaders": [{"name": m, "type": "TYPE_INTEGER"} for m in mets],
                "rows": rows[offset:offset + limit], "rowCount": len(rows), "metadata": {"timeZone": "Europe/Rome", "currencyCode": "EUR"}}


ENV = {"GA4_OAUTH_CLIENT_ID": "cid", "GA4_OAUTH_CLIENT_SECRET": "secret", "GA4_OAUTH_REFRESH_TOKEN": "rt"}
KIA_IT = {"property_id": "469542848", "brand_bit": 2, "country": "IT", "basis": 1, "events": frozenset(), "status": "active"}


def client(emu: Emulator):
    return ga4c.Ga4(ga4c.Tokens(ENV, urlopen=emu), urlopen=emu, sleep=lambda s: None)


def truth(data, lo, hi):
    """What the screen must show for [lo, hi], counted from the sessions."""
    sel = [s for s in data if lo <= s["date"] <= hi]
    ai = [s for s in sel if s["sessionDefaultChannelGroup"] == AI]
    gen = [s for s in sel if s["sessionDefaultChannelGroup"] != AI]
    key = lambda ss: sum(e in KEY_EVENTS for s in ss for e in s["events"])  # noqa: E731
    engines = defaultdict(int)
    for s in ai:
        if ga4c.engine_of(s["sessionSource"]):
            engines[ga4c.engine_of(s["sessionSource"])] += 1
    pages = defaultdict(int)
    for s in ai:
        pages[s["landingPage"]] += 1
    return {"ai_sessions": len(ai), "ai_users": len({s["user"] for s in ai}), "ai_conversions": key(ai), "human_sessions": len(gen),
            "human_users": len({s["user"] for s in gen}), "human_conversions": key(gen), "all_sessions": len(sel),
            "page_views": sum(s["views"] for s in sel), "engines": dict(engines), "pages": dict(pages)}


def reader_rows(collected: dict, prop_key: int = 1) -> tuple[list[dict], list[dict]]:
    """The reader's SELECT r.*, engine code, page value, url, event value — as the joins would give them."""
    rows = [{"prop_key": prop_key, "date": r["date"], "report": r["report"], "is_ai": r["is_ai"], "is_conv": r["is_conv"], "engine": r["engine"],
             "page": r["page"], "url": None, "event": r["event"], **{k: r[k] for k in ("sessions", "users_day", "page_views", "key_events", "event_count")}}
            for r in collected["rows"]]
    windows = [{"prop_key": prop_key, "engine_mask": 0, "device_mask": 0, "nvr_mask": 0, "page_key": 0, "page": None, "url": None, **w}
               for w in collected["windows"]]
    return rows, windows


class Connection:
    def __init__(self, responses, latest):
        self.responses, self.latest = iter(responses), latest

    async def fetch(self, query, *args):
        return next(self.responses)

    async def fetchval(self, query, *args):
        return self.latest


def read(collected, lo=END - timedelta(days=27), hi=END, basis=1):
    """The reader over [lo, hi]; the fake connection returns what the reader's WHERE would (rows and windows in the period)."""
    rows, windows = reader_rows(collected)
    rows = [r for r in rows if lo <= r["date"] <= hi]
    windows = [w for w in windows if lo <= w["window_end"] <= hi]
    query = f"days={(hi - lo).days + 1}" if hi == END else f"from={lo}&to={hi}"
    prop = {"prop_key": 1, "property_id": KIA_IT["property_id"], "brand_bit": 2, "geo_key": 1, "status": "active", "source": "registry",
            "conv_basis": basis, "country": "IT"}
    return asyncio.run(analytics_reader.conversion(Connection([[prop], rows, windows], END), QueryParams(query)))["data"]


class Registry(unittest.TestCase):
    def test_the_example_loads(self):
        props = ga4c.load_registry(Path(ga4c.HERE) / "ga4-properties.example.json")
        self.assertEqual([(p["property_id"], p["brand_bit"], p["country"], p["basis"], p["status"]) for p in props],
                         [("469542848", 2, "IT", 1, "active"), ("000000000", 1, "DE", 2, "unmapped")])
        self.assertEqual(props[1]["events"], {"test_drive_request", "dealer_contact"})

    def test_rejects(self):
        base = {"property_id": "1", "brand": "Kia", "country": "IT"}
        for bad, why in (({**base, "brand": "Toyota"}, "brand"), ({**base, "country": "ITA"}, "country"), ({**base, "property_id": "properties/1"}, "property_id"),
                         ({**base, "conversion": {"basis": "events"}}, "events"), ({**base, "conversion": {"basis": "key_events", "events": ["x"]}}, "events"),
                         ({**base, "status": "pending_grant"}, "status")):
            with self.subTest(why), mock.patch.object(Path, "read_text", return_value=json.dumps({"properties": [bad]})), self.assertRaisesRegex(ValueError, why):
                ga4c.load_registry(Path("x.json"))
        with mock.patch.object(Path, "read_text", return_value=json.dumps({"properties": [base, base]})), self.assertRaisesRegex(ValueError, "twice"):
            ga4c.load_registry(Path("x.json"))

    def test_brand_bits_are_the_readers(self):
        self.assertEqual(ga4c.BRAND_BITS, {k: v for k, v in analytics_reader.BRAND_BITS.items() if k != "hmg"})

    def test_engine_of_source(self):
        self.assertEqual([ga4c.engine_of(s) for s in ("chatgpt.com", "chat.openai.com", "Gemini.Google.com", "www.perplexity.ai", "claude.ai",
                                                       "copilot.microsoft.com", "edgeservices.bing.com", "google")],
                         ["chatgpt", "chatgpt", "gemini", "perplexity", "claude", "copilot", None, None])


class Api(unittest.TestCase):
    def test_credentials_are_required(self):
        with self.assertRaisesRegex(ValueError, "credentials missing"):
            ga4c.Tokens({"GA4_OAUTH_CLIENT_ID": "x"})

    def test_retries_pages_and_renews(self):
        emu = Emulator(sessions(), fail={1: 503, 2: 429})
        g = client(emu)
        with mock.patch.object(ga4c, "PAGE_LIMIT", 50):
            rows, _ = g.report("1", ga4c._body(START, END, ("date", "landingPage"), ("sessions",)))
        self.assertEqual(sum(r["sessions"] for r in rows), len(sessions()))
        self.assertGreater(len(emu.calls), 3)  # two retries and more than one page
        self.assertEqual(emu.tokens, 1)
        g.tokens.expires = 0  # an expired token is renewed before the call
        g.report("1", ga4c._body(START, END, (), ("sessions",)))
        self.assertEqual(emu.tokens, 2)

    def test_refused_property(self):
        with self.assertRaises(ga4c.AccessDenied):
            client(Emulator([], deny={"9"})).report("9", ga4c._body(START, END, (), ("sessions",)))

    def test_one_last_day_for_every_property(self):
        """Rome is past midnight, New York is not: both properties end at New York's yesterday."""
        g = client(Emulator([]))
        zones = {"1": "Europe/Rome", "2": "America/New_York"}
        at = datetime.fromisoformat("2026-10-28T23:30:00+00:00")
        real = ga4c.yesterday
        with mock.patch.object(g, "time_zone", lambda pid: zones[pid]), mock.patch.object(ga4c, "yesterday", lambda tz, now=None: real(tz, at)):
            end, refused = ga4c.last_day(g, [{"property_id": "1"}, {"property_id": "2"}])
        self.assertEqual((end, refused), (date(2026, 10, 27), {}))
        end, refused = ga4c.last_day(client(Emulator([], deny={"9"})), [{"property_id": "9"}])
        self.assertIsNone(end)
        self.assertIsInstance(refused["9"], ga4c.AccessDenied)

    def test_time_zone_and_yesterday(self):
        self.assertEqual(client(Emulator([])).time_zone("1"), "Europe/Rome")
        at = datetime.fromisoformat("2026-10-28T23:30:00+00:00")
        self.assertEqual(ga4c.yesterday("Europe/Rome", at), date(2026, 10, 28))  # 00:30 in Rome on the 29th
        self.assertEqual(ga4c.yesterday("America/New_York", at), date(2026, 10, 27))
        self.assertEqual(ga4c.yesterday("Not/AZone", at), date(2026, 10, 27))


class Collected(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = sessions()
        cls.c = ga4c.collect(client(Emulator(cls.data)), KIA_IT, START, END)

    def by(self, report, **kw):
        return [r for r in self.c["rows"] if r["report"] == report and all(r[k] == v for k, v in kw.items())]

    def test_reports_partition_the_sessions(self):
        t = truth(self.data, START, END)
        total = lambda rows, k="sessions": sum(r[k] or 0 for r in rows)  # noqa: E731
        self.assertEqual(total(self.by(1)), t["all_sessions"])
        self.assertEqual(total(self.by(1, is_ai=True)), t["ai_sessions"])
        self.assertEqual(total(self.by(2)), t["ai_sessions"])
        self.assertEqual(total(self.by(4, is_ai=True)), t["ai_sessions"])
        self.assertEqual(total(self.by(5)), t["all_sessions"])
        self.assertEqual(total(self.by(5), "page_views"), t["page_views"])
        # the non-AI landing rows are the AI landing pages only (the same-page baseline)
        self.assertEqual({r["page"] for r in self.by(4, is_ai=False)}, {r["page"] for r in self.by(4, is_ai=True)})
        # the page list does not depend on the collected days: a refresh reads the same rows for its days
        late = ga4c.collect(client(Emulator(self.data)), KIA_IT, END - timedelta(days=2), END)
        same = lambda rows: sorted((r["date"], r["report"], *(r[k] for k in ga4c.DIMS), r["sessions"]) for r in rows if r["date"] >= END - timedelta(days=2))  # noqa: E731
        self.assertEqual(same(late["rows"]), same(self.c["rows"]))
        # one row per primary key
        keys = [(r["date"], r["report"], *(r[k] for k in ga4c.DIMS)) for r in self.c["rows"]]
        self.assertEqual(len(keys), len(set(keys)))
        # metrics a report does not ask for stay null
        self.assertTrue(all(r["event_count"] is None for r in self.by(1)))
        self.assertTrue(all(r["sessions"] is None for r in self.by(3)))

    def test_conversion_events(self):
        ev = defaultdict(set)
        for r in self.by(3):
            ev[r["event"]].add(r["is_conv"])
        self.assertEqual(dict(ev), {"page_view": {False}, "scroll": {False}, "test_drive_request": {True}, "dealer_contact": {False}})
        tracked = ga4c.collect(client(Emulator(self.data)), {**KIA_IT, "basis": 2, "events": frozenset({"dealer_contact"})}, START, END)
        self.assertEqual({r["event"] for r in tracked["rows"] if r["report"] == 3 and r["is_conv"]} & {"dealer_contact", "test_drive_request"}, {"dealer_contact"})

    def test_windows_are_exact_users(self):
        w = {(x["window_end"], x["window_days"], x["cohort"]): x["users"] for x in self.c["windows"]}
        self.assertEqual(len([k for k in w if k[1] == 1]), 60 * 3)
        day = START + timedelta(days=10)
        self.assertEqual(w[(day, 1, "ai")], len({s["user"] for s in self.data if s["date"] == day and s["sessionDefaultChannelGroup"] == AI}))
        for n in ga4c.WINDOWS:
            for end in (END, END - timedelta(days=n)):
                lo = end - timedelta(days=n - 1)
                sel = [s for s in self.data if lo <= s["date"] <= end]
                self.assertEqual(w[(end, n, "total")], len({s["user"] for s in sel}))
                self.assertEqual(w[(end, n, "ai")], len({s["user"] for s in sel if s["sessionDefaultChannelGroup"] == AI}))

    def test_the_reader_shows_the_truth(self):
        """28 days through the BFF reader: the screen's numbers equal the sessions' own counts."""
        t = truth(self.data, END - timedelta(days=27), END)
        d = read(self.c)
        m = d["metrics"]
        for k in ("ai_sessions", "ai_users", "ai_conversions", "human_sessions", "human_users", "human_conversions"):
            self.assertEqual(m[k], t[k], k)
        self.assertAlmostEqual(m["ai_conversion_rate"], 100 * t["ai_conversions"] / t["ai_users"])
        self.assertAlmostEqual(m["session_share"], 100 * t["ai_sessions"] / t["all_sessions"])
        self.assertEqual(m["page_views"], t["page_views"])
        self.assertEqual({e["engine"]: e["sessions"] for e in d["engines"]}, t["engines"])
        # a page with AI landings only outside these 28 days still shows its same-page non-AI rows, without AI sessions
        self.assertEqual({p["url"]: p["sessions"] for p in d["pages"] if p["sessions"] is not None}, t["pages"])
        self.assertEqual(d["period"], {"from": END - timedelta(days=27), "to": END, "days": 28})
        # the previous 28 days have their own exact window, so the rate can be compared
        prev = read(self.c, END - timedelta(days=55), END - timedelta(days=28))
        self.assertEqual(prev["metrics"]["ai_users"], truth(self.data, END - timedelta(days=55), END - timedelta(days=28))["ai_users"])

    def test_tracked_events_basis_through_the_reader(self):
        tracked = ga4c.collect(client(Emulator(self.data)), {**KIA_IT, "basis": 2, "events": frozenset({"test_drive_request", "dealer_contact"})}, START, END)
        d = read(tracked, basis=2)
        m = d["metrics"]
        # a day without a tracked event converted zero times; it is not a gap in the trend
        self.assertTrue(all(day["ai_conversions"] is not None for day in d["trend"]))
        lo = END - timedelta(days=27)
        ai = [s for s in self.data if lo <= s["date"] <= END and s["sessionDefaultChannelGroup"] == AI]
        self.assertEqual(m["ai_conversions"], sum(e in ("test_drive_request", "dealer_contact") for s in ai for e in s["events"]))


class Run(unittest.TestCase):
    def test_dry_run_reads_every_property_and_marks_the_refused(self):
        registry = {"properties": [{"property_id": "469542848", "brand": "Kia", "country": "IT"}, {"property_id": "9", "brand": "Hyundai", "country": "DE"},
                                   {"property_id": "8", "brand": "Hyundai", "country": "FR", "status": "unmapped"}]}
        args = ga4c.argparse.Namespace(frm=None, to=None, backfill=None, property=None, dry_run=True)
        with mock.patch.object(Path, "read_text", return_value=json.dumps(registry)), mock.patch.object(ga4c, "yesterday", lambda tz, now=None: END):
            out = asyncio.run(ga4c.run(args, {**ENV, "HGH_GA4_PROPERTIES": "x.json"}, client(Emulator(sessions(), deny={"9"}))))
        self.assertEqual([(r["property"], r["status"]) for r in out], [("469542848", "active"), ("9", "pending_grant"), ("8", "unmapped")])
        self.assertEqual((out[0]["from"], out[0]["to"]), ((TODAY - timedelta(days=3)).isoformat(), END.isoformat()))


@unittest.skipUnless(os.environ.get("HGH_GA4_TEST_DB_URL"), "HGH_GA4_TEST_DB_URL (a throwaway database with back/analytics/schema.sql) not set")
class Database(unittest.TestCase):
    """store() into PostgreSQL, a refresh that replaces its days, then the reader's own SQL."""

    def test_store_and_read_back(self):
        import asyncpg
        data = sessions()

        async def go():
            conn = await asyncpg.connect(os.environ["HGH_GA4_TEST_DB_URL"])
            try:
                await conn.execute("DELETE FROM analytics.ga4_users_window; DELETE FROM analytics.ga4_row; DELETE FROM analytics.ga4_property")
                g = client(Emulator(data))
                await ga4c.store(conn, KIA_IT, ga4c.collect(g, KIA_IT, START, END), START, END)
                n = await conn.fetchval("SELECT count(*) FROM analytics.ga4_row")
                # a refresh of the last 3 days replaces them, nothing is added twice
                await ga4c.store(conn, KIA_IT, ga4c.collect(g, KIA_IT, END - timedelta(days=2), END), END - timedelta(days=2), END)
                self.assertEqual(await conn.fetchval("SELECT count(*) FROM analytics.ga4_row"), n)
                return await analytics_reader.conversion(conn, QueryParams("days=28"))
            finally:
                await conn.close()

        res = asyncio.run(go())
        t = truth(data, END - timedelta(days=27), END)
        m = res["data"]["metrics"]
        self.assertIsNone(res["meta"]["reason"])
        self.assertEqual((m["ai_sessions"], m["ai_users"], m["ai_conversions"], m["human_users"]), (t["ai_sessions"], t["ai_users"], t["ai_conversions"], t["human_users"]))
        self.assertEqual({e["engine"]: e["sessions"] for e in res["data"]["engines"]}, t["engines"])


if __name__ == "__main__":
    unittest.main()
