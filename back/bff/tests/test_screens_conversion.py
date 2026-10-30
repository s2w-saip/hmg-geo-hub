"""Renewal AI Conversion screen: the derived numbers on reader answers checked by hand.

The answers come from the real reader (hub_stores/analytics_reader.py conversion()) over GA4 rows built here,
so the screen is tested on the shape the reader really sends. Two active properties (Kia IT on key events,
Hyundai DE on tracked events) and one waiting for access (Hyundai FR), 14 days and the 14 days before."""
import asyncio
import json
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

try:
    from fastapi.encoders import jsonable_encoder
    from starlette.datastructures import QueryParams

    from bff.hub_stores.analytics_reader import conversion as read_conversion
    from bff.screens import conversion as conv
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_conversion)") from exc

CUR_END, PREV_END = date(2026, 10, 25), date(2026, 10, 11)
KIA_IT = {"prop_key": 1, "property_id": "469542848", "brand_bit": 2, "geo_key": 70, "status": "active", "source": "registry", "conv_basis": 1, "country": "IT"}
HY_DE = {"prop_key": 2, "property_id": "310000001", "brand_bit": 1, "geo_key": 30, "status": "active", "source": "registry", "conv_basis": 2, "country": "DE"}
HY_FR = {"prop_key": 3, "property_id": "310000002", "brand_bit": 1, "geo_key": 31, "status": "pending_grant", "source": "registry", "conv_basis": 1, "country": "FR"}
PROPS = [KIA_IT, HY_DE, HY_FR]
KIA, HY = "https://www.kia.com/it", "https://www.hyundai.com/de/de"

# One period's GA4 traffic a day per property: AI sessions per engine, AI landing sessions per page, general
# sessions, the AI conversions (Kia IT: key events per engine on the AI traffic rows; Hyundai DE: tracked
# event per engine) as functions of the day index, general conversions, period and daily users.
CUR = {
    "end": CUR_END,
    "ai": {1: {"chatgpt": 14, "gemini": 5, "perplexity": 2}, 2: {"chatgpt": 7, "gemini": 3}},
    "landing": {1: {f"{KIA}/": 8, f"{KIA}/modelli/ev3/scopri/": 6, f"{KIA}/offerte/": 3, f"{KIA}/test-drive/": 2, f"{KIA}/modelli/sportage/scopri/": 2},
                2: {f"{HY}.html": 5, f"{HY}/modelle/ioniq-5.html": 3, f"{HY}/angebote.html": 2}},
    "general": {1: 1200, 2: 800},
    "conv": {1: {"chatgpt": lambda i: 1, "gemini": lambda i: 1 if i % 2 == 0 else 0, "perplexity": lambda i: 0},
             2: {"chatgpt": lambda i: 1 if i % 3 == 0 else 0, "gemini": lambda i: 1 if i == 5 else 0}},
    "general_conv": {1: 30, 2: 20},
    "users": {"ai": {1: 230, 2: 130}, "general": {1: 9000, 2: 6000}}, "daily_users": {1: 20, 2: 9},
    "daily_general_users": {1: 700, 2: 450},
}
PREV = {
    "end": PREV_END,
    "ai": {1: {"chatgpt": 12, "gemini": 4, "perplexity": 2}, 2: {"chatgpt": 6, "gemini": 2}},
    "landing": {1: {f"{KIA}/": 7, f"{KIA}/modelli/ev3/scopri/": 5, f"{KIA}/offerte/": 3, f"{KIA}/test-drive/": 2, f"{KIA}/modelli/sportage/scopri/": 1},
                2: {f"{HY}.html": 4, f"{HY}/modelle/ioniq-5.html": 2, f"{HY}/angebote.html": 2}},
    "general": {1: 1150, 2: 780},
    "conv": {1: {"chatgpt": lambda i: 1 if i % 2 == 0 else 0, "gemini": lambda i: 1 if i % 2 == 0 else 0, "perplexity": lambda i: 0},
             2: {"chatgpt": lambda i: 1 if i % 3 == 0 else 0, "gemini": lambda i: 1 if i == 5 else 0}},
    "general_conv": {1: 28, 2: 19},
    "users": {"ai": {1: 190, 2: 110}, "general": {1: 8400, 2: 5600}}, "daily_users": {1: 18, 2: 8},
    "daily_general_users": {1: 680, 2: 430},
}
# 2026-10-30 (BI rework): every row carries the device × new/returning it was cut by, report 1 the channel group.
# The general sessions and key events split over three channels (the sums are the ones above), the AI channel row
# of report 1 carries the AI totals, the landing rows carry key events.
CHANNELS = (("Organic Search", 0.55, 0.5, "mobile", "new"), ("Direct", 0.30, 0.3, "desktop", "returning"), ("Referral", None, None, "desktop", "new"))
ENGINE_CUT = {"chatgpt": ("mobile", "new"), "gemini": ("desktop", "returning"), "perplexity": ("mobile", "returning")}
ENGINE_PPS = {"chatgpt": 2, "gemini": 3, "perplexity": 1}


def split(total, parts):
    """`total` over the channels by their fractions, the last one taking the rest (integers that add up)."""
    out, left = [], total
    for frac in parts:
        n = left if frac is None else round(total * frac)
        out.append(n)
        left -= n
    return out


def ga4(p, days=14):
    """The reader's rows (ga4_row joined to engine · page · url · event) and windows for one period."""
    dates = [p["end"] - timedelta(days=days - 1 - i) for i in range(days)]
    rows, windows = [], []

    def row(prop, d, report, ai, **kw):
        base = {"prop_key": prop, "date": d, "report": report, "is_ai": ai, "is_conv": False, "engine": None, "page": None, "url": None,
                "event": None, "channel": None, "device": None, "nvr": None,
                "sessions": 0, "users_day": 0, "page_views": 0, "key_events": 0, "event_count": 0}
        rows.append({**base, **kw})

    for i, d in enumerate(dates):
        for prop in (1, 2):
            ai = p["ai"][prop]
            for engine, sessions in ai.items():
                key_events = p["conv"][prop][engine](i) if prop == 1 else 0
                device, nvr = ENGINE_CUT[engine]
                row(prop, d, 2, True, engine=engine, sessions=sessions, key_events=key_events, page_views=ENGINE_PPS[engine] * sessions,
                    device=device, nvr=nvr)
                if prop == 2:
                    row(prop, d, 3, True, engine=engine, is_conv=True, event="book_a_test_drive", event_count=p["conv"][prop][engine](i),
                        device=device, nvr=nvr)
            ai_key_events = sum(p["conv"][1][e](i) for e in ai) if prop == 1 else 0
            row(prop, d, 1, True, channel="AI Assistant", sessions=sum(ai.values()), key_events=ai_key_events,
                page_views=sum(ENGINE_PPS[e] * n for e, n in ai.items()), device="mobile", nvr="new")
            general_ke = p["general_conv"][prop] if prop == 1 else 0
            for (channel, frac, ke_frac, device, nvr), sessions, ke in zip(CHANNELS, split(p["general"][prop], [c[1] for c in CHANNELS]),
                                                                          split(general_ke, [c[2] for c in CHANNELS]), strict=True):
                row(prop, d, 1, False, channel=channel, sessions=sessions, key_events=ke, page_views=(4 if channel == "Direct" else 2) * sessions,
                    device=device, nvr=nvr)
            row(prop, d, 5, False, sessions=p["general"][prop] + sum(ai.values()), page_views=3 * p["general"][prop])
            for j, (url, sessions) in enumerate(p["landing"][prop].items()):
                row(prop, d, 4, True, engine="chatgpt", url=url, sessions=sessions, page_views=2 * sessions,
                    key_events=(1 if prop == 1 else i % 2) if j == 0 else 0)
            row(prop, d, 4, False, url=next(iter(p["landing"][prop])), sessions=p["general"][prop], page_views=p["general"][prop],
                key_events=6 if prop == 1 else 3)
            row(prop, d, 3, False, event="page_view", event_count=3 * p["general"][prop], device="mobile", nvr="new")
            if prop == 1:
                row(prop, d, 3, False, is_conv=True, event="test_drive_request", event_count=12, device="desktop", nvr="returning")
            else:
                row(prop, d, 3, False, is_conv=True, event="book_a_test_drive", event_count=p["general_conv"][prop], device="desktop", nvr="returning")
            windows.append({"prop_key": prop, "window_end": d, "window_days": 1, "cohort": "ai", "engine_mask": 0, "device_mask": 0, "nvr_mask": 0,
                            "page_key": 0, "users": p["daily_users"][prop], "page": None, "url": None})
            windows.append({"prop_key": prop, "window_end": d, "window_days": 1, "cohort": "general", "engine_mask": 0, "device_mask": 0, "nvr_mask": 0,
                            "page_key": 0, "users": p["daily_general_users"][prop], "page": None, "url": None})
    for cohort, users in p["users"].items():
        for prop, n in users.items():
            windows.append({"prop_key": prop, "window_end": p["end"], "window_days": days, "cohort": cohort, "engine_mask": 0, "device_mask": 0,
                            "nvr_mask": 0, "page_key": 0, "users": n, "page": None, "url": None})
    return rows, windows


class Connection:
    def __init__(self, props, rows, windows, latest):
        self.responses = iter([props, rows, windows])
        self.latest = latest

    async def fetch(self, query, *args):
        return next(self.responses)

    async def fetchval(self, query, *args):
        return self.latest


def answer(p, query):
    """The reader's answer for one period, after the JSON round trip (dates as strings)."""
    rows, windows = ga4(p)
    res = asyncio.run(read_conversion(Connection(PROPS, rows, windows, p["end"]), QueryParams(query)))
    return json.loads(json.dumps(jsonable_encoder(res)))


CUR_Q, PREV_Q = "days=14", "from=2026-09-28&to=2026-10-11"


def run(coro):
    return asyncio.run(coro)


class View(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cur, cls.prev = answer(CUR, CUR_Q)["data"], answer(PREV, PREV_Q)["data"]
        cls.v = conv.conversion_view(cls.cur, cls.prev, False)

    def test_totals_are_the_readers_and_the_gap(self):
        t = self.v["totals"]
        self.assertEqual((t["aiSessions"], t["aiUsers"], t["aiConv"], t["aiRate"]), (434, 360, 27, 7.5))
        self.assertEqual((t["genSessions"], t["genUsers"], t["genConv"]), (28000, 15000, 700))
        self.assertAlmostEqual(t["genRate"], 700 / 15000 * 100)
        self.assertAlmostEqual(t["lift"], 7.5 - 700 / 15000 * 100)
        self.assertAlmostEqual(t["share"], 434 / (2031 * 14) * 100)
        self.assertAlmostEqual(t["perUser"], 434 / 360)
        self.assertAlmostEqual(t["per100"], 27 / 434 * 100)

    def test_previous_period(self):
        t = self.v["totals"]
        self.assertTrue(self.v["prevOk"])
        self.assertAlmostEqual(t["dAiSessions"], (434 - 364) / 364 * 100)
        self.assertAlmostEqual(t["dAiConv"], (27 - 20) / 20 * 100)
        self.assertAlmostEqual(t["dAiRate"], 7.5 - 20 / 300 * 100)
        self.assertAlmostEqual(t["dGenRate"], 700 / 15000 * 100 - 658 / 14000 * 100)
        self.assertAlmostEqual(t["dShare"], 434 / 28434 * 100 - 364 / 27384 * 100)

    def test_daily_series_and_blocks(self):
        v = self.v
        self.assertEqual((len(v["days"]), v["observed"]), (14, 14))
        self.assertEqual(v["blocks"], [["2026-10-12", "2026-10-18"], ["2026-10-19", "2026-10-25"]])
        self.assertEqual(v["trend"]["sessions"], [31] * 14)
        self.assertEqual(v["trend"]["users"], [29] * 14)
        # day 0: Kia chatgpt 1 + gemini 1, Hyundai chatgpt 1 (i % 3 == 0)
        self.assertEqual(v["trend"]["conv"][:6], [3, 1, 2, 2, 2, 2])
        self.assertAlmostEqual(v["trend"]["rate"][0], 3 / 29 * 100)
        self.assertEqual(v["spark"]["sessions"], [217, 217])
        self.assertEqual(sum(v["spark"]["conv"]), 27)

    def test_engines(self):
        e = {x["engine"]: x for x in self.v["engines"]}
        self.assertEqual([x["engine"] for x in self.v["engines"]], ["chatgpt", "gemini", "perplexity"])
        self.assertEqual((e["chatgpt"]["sessions"], e["gemini"]["sessions"], e["perplexity"]["sessions"]), (294, 112, 28))
        self.assertAlmostEqual(e["chatgpt"]["share"], 294 / 434 * 100)
        self.assertEqual((e["chatgpt"]["conv"], e["gemini"]["conv"]), (19, 8))
        # Hyundai DE has no Perplexity rows: the reader's conversions stay null, so does the ratio
        self.assertIsNone(e["perplexity"]["conv"])
        self.assertIsNone(e["perplexity"]["per100"])
        self.assertAlmostEqual(e["gemini"]["per100"], 8 / 112 * 100)
        self.assertAlmostEqual(e["chatgpt"]["d"], (294 - 252) / 252 * 100)
        self.assertIsNone(self.v["engineRest"])

    def test_landing_pages(self):
        pages = self.v["pages"]
        self.assertEqual([p["sessions"] for p in pages], [112, 84, 70, 42, 42, 28, 28, 28])
        self.assertEqual(pages[0]["path"], "/it/")
        self.assertAlmostEqual(pages[2]["cum"], 266 / 434 * 100)
        self.assertEqual(pages[0]["views"], 112 * 2 + 1200 * 14)
        self.assertEqual((pages[0]["prev"], pages[0]["d"]), (98, 14))

    def test_properties_and_coverage(self):
        props = self.v["props"]
        self.assertEqual([(p["country"], p["status"]) for p in props], [("IT", "active"), ("DE", "active"), ("FR", "pending_grant")])
        self.assertEqual((props[0]["brand"], props[0]["basis"], props[0]["sessions"], props[0]["users"]), ("Kia", 1, 294, 230))
        self.assertAlmostEqual(props[1]["share"], 140 / 434 * 100)
        self.assertEqual((props[2]["sessions"], props[2]["users"], props[2]["share"]), (None, None, None))
        self.assertEqual(self.v["coverage"], {"total": 3, "active": 2, "pending_grant": 1, "unmapped": 0})
        self.assertTrue(self.v["multiBrand"])

    def test_events(self):
        ev = self.v["events"]
        self.assertEqual([(e["event"], e["tracked"], e["count"]) for e in ev],
                         [("book_a_test_drive", True, 286), ("test_drive_request", True, 168), ("page_view", False, 3 * 2000 * 14)])
        self.assertEqual(self.v["tracked"], 286 + 168)
        self.assertAlmostEqual(ev[0]["share"], 286 / 454 * 100)
        self.assertIsNone(ev[2]["share"])  # not a conversion event: no share of the conversion events

    def test_findings(self):
        codes = [f["code"] for f in self.v["findings"]]
        self.assertEqual(codes, ["lift", "coverage", "change", "channel"])
        change = next(f for f in self.v["findings"] if f["code"] == "change")
        self.assertEqual(change["dConv"], 7)
        self.assertAlmostEqual(change["volume"] + change["rate"], 7)
        channel = next(f for f in self.v["findings"] if f["code"] == "channel")
        self.assertEqual((channel["rank"], channel["n"], channel["per100Rank"]), (4, 4, 1))
        # with fewer findings above it the engine one shows: the largest engine and the one with most conversions per session
        cur = json.loads(json.dumps(self.cur))
        cur["channels"], cur["properties"] = [], [p for p in cur["properties"] if p["status"] == "active"]
        v = conv.conversion_view(cur, self.prev, False)
        engine = next(f for f in v["findings"] if f["code"] == "engine")
        self.assertEqual((engine["engine"], engine["best"]), ("chatgpt", "gemini"))

    def test_channels(self):
        ch = self.v["channels"]
        self.assertEqual([(r["channel"], r["ai"], r["sessions"]) for r in ch["rows"]],
                         [("Organic Search", False, 15400), ("Direct", False, 8400), ("Referral", False, 4200), ("AI Assistant", True, 434)])
        ai = ch["rows"][3]
        self.assertEqual(ai["keyEvents"], 21)  # Kia IT's AI key events (14 ChatGPT + 7 Gemini); Hyundai DE sends none
        self.assertAlmostEqual(ai["per100"], 21 / 434 * 100)
        self.assertAlmostEqual(ai["share"], 434 / 28434 * 100)
        self.assertAlmostEqual(ai["pps"], (14 * (2 * 21 + 3 * 8 + 2)) / 434)
        self.assertAlmostEqual(ch["rows"][0]["per100"], 210 / 15400 * 100)
        self.assertEqual(ch["site"]["sessions"], 28434)
        self.assertAlmostEqual(ch["site"]["per100"], (21 + 420) / 28434 * 100)
        self.assertEqual(ch["aiRank"], {"sessions": 4, "per100": 1, "pps": 2, "n": 4})  # Direct 4 pages a session > AI 2.19 > the others 2
        self.assertAlmostEqual(ai["d"], (434 - 364) / 364 * 100)

    def test_segments(self):
        dev = {r["value"]: r for r in self.v["segments"]["device"]}
        self.assertEqual([r["value"] for r in self.v["segments"]["device"]], ["mobile", "desktop"])
        self.assertEqual((dev["mobile"]["aiSessions"], dev["desktop"]["aiSessions"]), (322, 112))
        self.assertEqual((dev["mobile"]["genSessions"], dev["desktop"]["genSessions"]), (15400, 12600))
        self.assertAlmostEqual(dev["mobile"]["aiShare"], 322 / 434 * 100)
        self.assertAlmostEqual(dev["mobile"]["genShare"], 15400 / 28000 * 100)
        self.assertAlmostEqual(dev["mobile"]["mixGap"], 322 / 434 * 100 - 15400 / 28000 * 100)
        # AI: Kia ChatGPT key events 14 + Hyundai ChatGPT tracked 5 on mobile; Gemini 7 + 1 on desktop
        self.assertEqual((dev["mobile"]["aiConv"], dev["desktop"]["aiConv"]), (19, 8))
        # general: Kia's organic key events on mobile; Direct · Referral and Hyundai's tracked events on desktop
        self.assertEqual((dev["mobile"]["genConv"], dev["desktop"]["genConv"]), (210, 490))
        self.assertAlmostEqual(dev["desktop"]["genPer100"], 490 / 12600 * 100)
        nvr = {r["value"]: r for r in self.v["segments"]["visitorType"]}
        self.assertEqual((nvr["new"]["aiSessions"], nvr["returning"]["aiSessions"]), (294, 140))
        self.assertEqual((nvr["new"]["genSessions"], nvr["returning"]["genSessions"]), (19600, 8400))

    def test_decomposition(self):
        dc = self.v["decomp"]
        self.assertEqual((dc["prevConv"], dc["conv"], dc["d"], dc["prevSessions"], dc["sessions"], dc["dSessions"]), (20, 27, 7, 364, 434, 70))
        self.assertAlmostEqual(dc["volume"], 70 * 20 / 364)
        self.assertAlmostEqual(dc["rate"], 27 - 434 * 20 / 364)
        self.assertAlmostEqual(dc["volume"] + dc["rate"], dc["d"])
        self.assertEqual(dc["engines"], [{"engine": "chatgpt", "d": 42}, {"engine": "gemini", "d": 28}, {"engine": "perplexity", "d": 0}])
        self.assertEqual(dc["rest"], 0)
        self.assertIsNone(conv.conversion_view(self.cur, None, False)["decomp"])

    def test_daily_general_and_site(self):
        tr = self.v["trend"]
        self.assertEqual(tr["site"], [2031] * 14)
        self.assertEqual(tr["genSessions"], [2000] * 14)
        self.assertEqual(tr["genConv"], [50] * 14)
        self.assertEqual(tr["genUsers"], [1150] * 14)
        self.assertAlmostEqual(tr["genRate"][0], 50 / 1150 * 100)
        self.assertAlmostEqual(tr["share"][0], 31 / 2031 * 100)
        t = self.v["totals"]
        self.assertEqual((t["siteSessions"], t["pageViews"]), (28434, 3 * 2000 * 14))
        self.assertAlmostEqual(t["dSite"], (28434 - 27384) / 27384 * 100)

    def test_same_page_and_markets_and_events(self):
        page = self.v["pages"][0]
        self.assertEqual((page["path"], page["sessions"], page["genSessions"], page["aiKe"], page["genKe"]), ("/it/", 112, 16800, 14, 84))
        self.assertAlmostEqual(page["aiOfPage"], 112 / 16912 * 100)
        self.assertAlmostEqual(page["aiKe100"], 12.5)
        self.assertAlmostEqual(page["genKe100"], 0.5)
        self.assertIsNone(self.v["pages"][1]["genSessions"])  # no general row for that page: unknown, not zero
        kia = self.v["props"][0]
        self.assertEqual((kia["conv"], kia["genConv"], kia["genSessions"]), (21, 420, 16800))
        self.assertAlmostEqual(kia["rate"], 21 / 230 * 100)
        self.assertAlmostEqual(kia["genRate"], 420 / 9000 * 100)
        self.assertAlmostEqual(kia["lift"], 21 / 230 * 100 - 420 / 9000 * 100)
        self.assertEqual((self.v["props"][2]["conv"], self.v["props"][2]["rate"]), (None, None))  # waiting for access
        book = next(e for e in self.v["events"] if e["event"] == "book_a_test_drive")
        self.assertEqual((book["aiCount"], book["genCount"]), (6, 280))
        self.assertAlmostEqual(book["aiShare"], 6 / 286 * 100)

    def test_raw_windows(self):
        w = self.v["windows"]
        self.assertEqual(len(w), 2 * 14 * 2 + 2 * 2)  # daily AI · general per property, the period AI · general
        self.assertEqual(w[0]["days"], 14)  # the period windows first, then the days, newest first
        self.assertEqual({(x["id"], x["cohort"], x["users"]) for x in w if x["days"] == 14},
                         {("469542848", "ai", 230), ("310000001", "ai", 130), ("469542848", "general", 9000), ("310000001", "general", 6000)})
        day = next(x for x in w if x["days"] == 1)
        self.assertEqual((day["end"], day["country"], day["brand"], day["all"]), ("2026-10-25", "IT", "Kia", True))

    def test_few_users(self):
        cur = json.loads(json.dumps(self.cur))
        cur["metrics"].update(ai_users=40, ai_conversion_rate=27 / 40 * 100)
        v = conv.conversion_view(cur, None, False)
        # no sample-size verdict (a HUB threshold, 2026-10-30 W6 review): the users count is shown as it is
        self.assertNotIn("sample", [f["code"] for f in v["findings"]])
        self.assertNotIn("lowSample", v)
        self.assertEqual(v["totals"]["aiUsers"], 40)
        self.assertFalse(v["prevOk"])
        self.assertNotIn("dAiSessions", v["totals"])
        self.assertIsNone(v["pages"][0]["d"])

    def test_findings_have_no_thresholds(self):
        """2026-10-30 W6 review: a stopped property (unmapped) is not a coverage gap, and the top landing pages' share
        is stated as it is (it showed only from 50 %)."""
        base = {"totals": {"aiUsers": None, "lift": None, "share": None}, "prevOk": False, "channels": {}, "engines": [],
                "segments": {}, "coverage": {"total": 3, "active": 2, "pending_grant": 0, "unmapped": 1},
                "pages": [{"id": f"/p{i}", "sessions": 10, "cum": c, "aiKe100": None, "genKe100": None} for i, c in enumerate((10, 20, 30, 40, 100))]}
        got = conv.findings(base)
        self.assertNotIn("coverage", [f["code"] for f in got])
        pages = next(f for f in got if f["code"] == "pages")
        self.assertEqual(pages["share"], 30)
        pending = {**base, "coverage": {"total": 3, "active": 1, "pending_grant": 1, "unmapped": 1}}
        cov = next(f for f in conv.findings(pending) if f["code"] == "coverage")
        self.assertEqual((cov["active"], cov["total"]), (1, 2))

    def test_a_user_filter_leaves_the_rates_out(self):
        cur = answer(CUR, "days=14&engine=chatgpt")["data"]
        v = conv.conversion_view(cur, None, True)
        t = v["totals"]
        self.assertTrue(v["filtered"])
        self.assertEqual((t["aiUsers"], t["aiRate"], t["lift"], t["perUser"]), (None, None, None, None))
        self.assertEqual(t["aiConv"], 27)  # the fake connection ignores the SQL filter; only the users rule shows here
        self.assertEqual(v["trend"]["rate"], [None] * 14)
        self.assertNotIn("lift", [f["code"] for f in v["findings"]])


def routed(conversion_answers, props=PROPS):
    """bff.api.get stand-in: analytics/properties answers the registered properties, analytics/conversion the given
    answers in turn. `get` keeps the conversion reads only (await_count, await_args_list)."""
    get = mock.AsyncMock(side_effect=list(conversion_answers))

    async def route(path, params=None):
        if path == "analytics/properties":
            return {"data": {"kind": "properties", "properties": [dict(p) for p in props]}, "meta": {"reason": None}}
        return await get(path, params)
    return route, get


class Screens(unittest.TestCase):
    def call(self, query, *answers, props=PROPS):
        route, get = routed(answers, props)
        with mock.patch("bff.api.get", route):
            out = run(conv.renewal(QueryParams(query)))
        return out, get

    def test_the_country_options_are_the_registered_ga4_properties(self):
        # 2026-10-30 (the user's go-ahead): 국가 lists the markets with a GA4 property the account can read — the
        # original page had no country axis, and Gold's answer countries named markets without one. A stopped
        # property (unmapped, the reader leaves it out) is not offered; brand picks narrow the list (optionMatrix).
        stopped = {**HY_FR, "prop_key": 4, "property_id": "310000003", "status": "unmapped", "country": "JP"}
        out, get = self.call(CUR_Q, answer(CUR, CUR_Q), answer(PREV, PREV_Q), props=[*PROPS, stopped])
        self.assertEqual([c.args[0] for c in get.await_args_list], ["analytics/conversion", "analytics/conversion"])  # no Gold read
        self.assertEqual(out["props"], {"stage": "conversion", "geographyOptions": ["DE", "FR", "IT"],
                                        "optionMatrix": [{"brand": "Hyundai", "region": "DE", "lang": None},
                                                         {"brand": "Hyundai", "region": "FR", "lang": None},
                                                         {"brand": "Kia", "region": "IT", "lang": None}]})
        out, _ = self.call("", {"data": {"kind": "conversion", "metrics": {}, "period": {}, "properties": []}, "meta": {"reason": "no_properties"}}, props=[])
        self.assertEqual(out["props"], {"stage": "conversion", "geographyOptions": [], "optionMatrix": []})

    def test_ok_reads_the_previous_period_of_the_same_length(self):
        out, get = self.call(CUR_Q, answer(CUR, CUR_Q), answer(PREV, PREV_Q))
        self.assertEqual(out["props"]["geographyOptions"], ["DE", "FR", "IT"])
        body = out["body"]
        self.assertEqual(body["state"], "ok")
        self.assertEqual(body["period"], {"from": "2026-10-12", "to": "2026-10-25", "days": 14})
        self.assertEqual(body["prev"], {"from": "2026-09-28", "to": "2026-10-11"})
        prev_query = get.await_args_list[1].args[1]
        self.assertEqual((prev_query["from"], prev_query["to"]), ("2026-09-28", "2026-10-11"))
        self.assertNotIn("days", prev_query)
        self.assertTrue(body["view"]["prevOk"])
        self.assertFalse(body["view"]["filtered"])

    def test_the_users_axes_mark_the_view_filtered(self):
        out, get = self.call("days=14&visitorType=new", answer(CUR, CUR_Q), answer(PREV, PREV_Q))
        self.assertEqual(get.await_args_list[0].args[1]["visitor_type"], ["new"])
        self.assertTrue(out["body"]["view"]["filtered"])

    def test_states(self):
        def reader(reason, props):
            return {"data": {"kind": "conversion", "metrics": {}, "period": {"from": None, "to": None, "days": None}, "properties": props},
                    "meta": {"reason": reason}}
        pending = [{**HY_FR, "property_id": "p"}]
        for query, reason, props, state in (("", "source_unavailable", [], "down"), ("", "no_properties", [], "noprop"),
                                            ("geography=JP", "no_properties", [], "nomatch"), ("", "no_measurements", pending, "pending"),
                                            ("", "no_measurements", [KIA_IT, HY_FR], "empty")):
            out, get = self.call(query, reader(reason, props))
            self.assertEqual(out["body"]["state"], state, reason)
            self.assertIsNone(out["body"]["view"])
            self.assertEqual(get.await_count, 1)
        self.assertEqual(out["body"]["properties"], [{"id": "469542848", "country": "IT", "brand": "Kia", "status": "active"},
                                                     {"id": "310000002", "country": "FR", "brand": "Hyundai", "status": "pending_grant"}])

    def test_windows_without_rows_are_not_measured(self):
        """The reader answers without a reason when only period-user windows match (a visitor type without rows)."""
        def windows_only():
            res = answer(CUR, CUR_Q)
            res["data"].update(trend=[], engines=[], pages=[], events=[])
            return res
        for query, state in (("visitorType=new", "nomatch"), ("geography=IT", "nomatch"), ("", "empty")):
            out, get = self.call(query, windows_only())
            self.assertEqual(out["body"]["state"], state, query)
            self.assertIsNone(out["body"]["view"])
            self.assertEqual(get.await_count, 1)

    def test_header_is_the_url_only(self):
        self.assertEqual(run(conv.renewal_header(QueryParams("days=7"))), {"preset": 7, "days": 7, "from": None, "to": None})


FRONT_FIXTURE = Path(__file__).parents[3] / "front/app/[locale]/(renewal)/renewal/standard/ai-funnel/conversion/_components/conv-body.fixture.json"


def front_body() -> dict:
    """The body the page's render test draws: this screen's own output on the answers above."""
    route, _ = routed([answer(CUR, CUR_Q), answer(PREV, PREV_Q)])
    with mock.patch("bff.api.get", route):
        return json.loads(json.dumps(run(conv.renewal(QueryParams(CUR_Q)))["body"]))


class FrontFixture(unittest.TestCase):
    """The page's render test draws this screen's own output; regenerate the fixture when the model changes
    (python -X utf8 -m bff.tests.test_screens_conversion --write-fixture, from back/)."""

    @unittest.skipUnless(FRONT_FIXTURE.exists(), "front checkout not present (BFF image)")
    def test_front_fixture_is_current(self):
        self.assertEqual(json.loads(FRONT_FIXTURE.read_text(encoding="utf-8")), front_body())


if __name__ == "__main__":
    import sys
    if "--write-fixture" in sys.argv:
        FRONT_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FRONT_FIXTURE.write_text(json.dumps(front_body(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    else:
        unittest.main()
