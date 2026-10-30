"""Aggregation rules: absence is not zero, and overlapping reports/users are not additive."""
import unittest
from datetime import date

try:
    from starlette.datastructures import QueryParams
    from bff.hub_stores.analytics_reader import conversion, conversions, empty, observed_sum, period, properties, visibility
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run aggregation tests inside the BFF image (bff.tests.test_analytics)") from exc


class Connection:
    def __init__(self, responses, latest=date(2026, 10, 25)):
        self.responses = iter(responses)
        self.latest = latest

    async def fetch(self, query, *args):
        return next(self.responses)

    async def fetchval(self, query, *args):
        return self.latest


def row(report, ai, **kw):
    return dict(prop_key=1, date=date(2026,10,25), report=report, is_ai=ai, is_conv=False,
                engine="chatgpt" if ai else None, page=None, url=None, event=None,
                sessions=0, users_day=999, page_views=0, key_events=0, event_count=0, **kw)


PROP = dict(prop_key=1, property_id="test", status="active", conv_basis=1, country="KR", brand_bit=1)


class AnalyticsRules(unittest.IsolatedAsyncioTestCase):
    def test_missing_and_observed_zero_are_distinct(self):
        self.assertIsNone(observed_sum([], "n"))
        self.assertIsNone(observed_sum([{"n":2},{"n":None}], "n"))
        self.assertEqual(observed_sum([{"n":0}], "n"), 0)
        self.assertTrue(all(v is None for v in empty("conversion","no_properties")["data"]["metrics"].values()))

    def test_basis_does_not_add_duplicate_reports(self):
        rows = [dict(prop_key=1,report=2,is_ai=True,key_events=2),
                dict(prop_key=1,report=3,is_ai=True,is_conv=True,event_count=90)]
        self.assertEqual(conversions(rows,[PROP]),2)
        self.assertEqual(conversions(rows,[{**PROP,"conv_basis":2}]),90)
        self.assertIsNone(conversions([], [PROP]))

    def test_tracked_events_collected_without_a_tracked_one_are_zero(self):
        """Basis 2 (2026-10-29): GA4 sends no row for a tracked event that did not happen, so a slice whose events
        were collected (report 3 rows of that cohort) but holds no tracked event observed zero conversions."""
        tracked = {**PROP, "conv_basis": 2}
        seen = [dict(prop_key=1, report=3, is_ai=True, is_conv=False, event_count=40)]
        self.assertEqual(conversions(seen, [tracked]), 0)
        self.assertEqual(conversions(seen + [dict(prop_key=1, report=3, is_ai=True, is_conv=True, event_count=3)], [tracked]), 3)
        self.assertIsNone(conversions([], [tracked]))  # no event collected for the slice: unknown
        self.assertIsNone(conversions(seen, [tracked], ai=False))  # the other cohort's events were not collected

    async def test_a_collected_day_without_rows_is_zero(self):
        """2026-10-29: the collector replaces whole days and leaves a daily `total` window for every collected day, so
        a report without a row on such a day observed zero (GA4 leaves out all-zero rows). A day without that window
        was not collected and stays unknown."""
        d1, d2, d3 = date(2026, 10, 23), date(2026, 10, 24), date(2026, 10, 25)
        de = dict(PROP, prop_key=2, property_id="de", country="DE")
        def at(day, report, ai, **kw):
            return {**row(report, ai), "date": day, **kw}
        rows = [at(d1, 2, True, sessions=4, key_events=1), at(d1, 5, False, sessions=50),
                at(d2, 5, False, sessions=40),  # a day without AI sessions
                at(d3, 5, False, sessions=45), at(d3, 2, True, sessions=2),
                at(d1, 2, True, sessions=3, key_events=1, prop_key=2, engine="perplexity"), at(d1, 5, False, sessions=30, prop_key=2)]

        def daily(prop_key, day):
            return dict(prop_key=prop_key, window_end=day, window_days=1, cohort="total", page_key=0, engine_mask=0, device_mask=0, nvr_mask=0, users=9)
        windows = [daily(1, d) for d in (d1, d2, d3)] + [daily(2, d) for d in (d1, d2, d3)]
        data = (await conversion(Connection([[PROP, de], rows, windows]), QueryParams("from=2026-10-23&to=2026-10-25")))["data"]
        trend = {t["date"]: t for t in data["trend"]}
        self.assertEqual((trend[d2]["ai_sessions"], trend[d2]["ai_conversions"]), (0, 0))
        self.assertEqual((trend[d3]["ai_sessions"], trend[d3]["ai_conversions"]), (2, 0))
        # Perplexity came to DE only: KR converted zero times from it, the engine's total is DE's
        self.assertEqual({e["engine"]: e["conversions"] for e in data["engines"]}, {"chatgpt": 1, "perplexity": 1})
        self.assertEqual(data["metrics"]["ai_conversions"], 2)
        # without the daily window the day was not collected: unknown, as before
        gap = (await conversion(Connection([[PROP], rows[:5], [daily(1, d1), daily(1, d3)]]), QueryParams("from=2026-10-23&to=2026-10-25")))["data"]
        self.assertIsNone({t["date"]: t for t in gap["trend"]}[d2]["ai_sessions"])

    async def test_a_property_missing_days_leaves_the_sums_unknown(self):
        """2026-10-30 W6 review: when an active property was not collected on some day of the period (no daily `total`
        window), the period sums and that day's sums would be partial (the other properties only), so they are
        unknown, not a smaller total that inflates the change."""
        d1, d3 = date(2026, 10, 23), date(2026, 10, 25)
        de = dict(PROP, prop_key=2, property_id="de", country="DE")
        def at(day, report, ai, **kw):
            return {**row(report, ai), "date": day, **kw}
        rows = [at(d1, 2, True, sessions=4, key_events=1), at(d1, 5, False, sessions=50), at(d3, 2, True, sessions=2), at(d3, 5, False, sessions=45),
                at(d1, 2, True, sessions=3, key_events=1, prop_key=2), at(d1, 5, False, sessions=30, prop_key=2)]
        def daily(prop_key, day):
            return dict(prop_key=prop_key, window_end=day, window_days=1, cohort="total", page_key=0, engine_mask=0, device_mask=0, nvr_mask=0, users=9)
        windows = [daily(1, d) for d in (d1, date(2026, 10, 24), d3)] + [daily(2, d1)]  # DE collected on 10-23 only
        data = (await conversion(Connection([[PROP, de], rows, windows]), QueryParams("from=2026-10-23&to=2026-10-25")))["data"]
        m = data["metrics"]
        self.assertEqual((m["ai_sessions"], m["total_sessions"], m["page_views"]), (None, None, None))
        day = {t["date"]: t for t in data["trend"]}
        self.assertEqual((day[d1]["ai_sessions"], day[d1]["total_sessions"]), (7, 80))  # both collected that day
        self.assertEqual((day[d3]["ai_sessions"], day[d3]["total_sessions"]), (None, None))  # DE not collected

    async def test_a_property_missing_days_leaves_the_slices_unknown(self):
        """Renewal audit 12-1 (2026-10-31): the W6 rule for the period sums holds for every slice of them too. When an
        active property missed a day of the period (no daily `total` window), the engines, channels, segment
        conversions, landing pages, event counts are the other properties' only, so they are unknown, not a partial
        sum; a market is unknown only when its own property missed a day. The reader names the missed days."""
        d1, d2 = date(2026, 10, 24), date(2026, 10, 25)
        de = dict(PROP, prop_key=2, property_id="de", country="DE")
        def at(day, report, ai, prop_key=1, **kw):
            return {**row(report, ai), "date": day, "prop_key": prop_key, "channel": None, "device": None, "nvr": None, **kw}
        rows = []
        for prop_key in (1, 2):
            for day in (d1, d2):
                rows += [at(day, 2, True, prop_key, sessions=4, key_events=1, page_views=8, device="mobile", nvr="new"),
                         at(day, 1, True, prop_key, sessions=4, key_events=1, page_views=8, channel="AI Assistant", device="mobile", nvr="new"),
                         at(day, 1, False, prop_key, sessions=90, key_events=3, page_views=200, channel="Organic Search", device="desktop", nvr="new"),
                         at(day, 5, False, prop_key, sessions=94, page_views=208),
                         at(day, 4, True, prop_key, url=f"https://site/{prop_key}", sessions=3, page_views=5, key_events=1),
                         at(day, 3, False, prop_key, event="page_view", event_count=300)]
        def daily(prop_key, day):
            return dict(prop_key=prop_key, window_end=day, window_days=1, cohort="total", page_key=0, engine_mask=0, device_mask=0, nvr_mask=0, users=9)
        q = QueryParams("from=2026-10-24&to=2026-10-25")
        both = (await conversion(Connection([[PROP, de], rows, [daily(k, d) for k in (1, 2) for d in (d1, d2)]]), q))["data"]
        self.assertEqual(both["missing"], [])
        self.assertEqual([(e["engine"], e["sessions"], e["conversions"]) for e in both["engines"]], [("chatgpt", 16, 4)])
        self.assertEqual({c["channel"]: c["sessions"] for c in both["channels"]}, {"AI Assistant": 16, "Organic Search": 360})
        self.assertEqual({s["value"]: s["ai_conversions"] for s in both["segments"]["device"]}, {"mobile": 4, "desktop": 0})
        self.assertEqual([p["sessions"] for p in both["pages"]], [6, 6])
        self.assertEqual([e["count"] for e in both["events"]], [1200])
        # DE missed 10-25: the slices would be Korea's and DE's 10-24 only (chatgpt 12 of 16 sessions)
        partial = [r for r in rows if (r["prop_key"], r["date"]) != (2, d2)]
        gap = (await conversion(Connection([[PROP, de], partial, [daily(1, d1), daily(1, d2), daily(2, d1)]]), q))["data"]
        self.assertEqual(gap["missing"], [{"property_id": "de", "days": [d2]}])
        self.assertEqual([(e["engine"], e["sessions"], e["page_views"], e["conversions"]) for e in gap["engines"]], [("chatgpt", None, None, None)])
        self.assertEqual({c["channel"]: (c["sessions"], c["key_events"], c["page_views"]) for c in gap["channels"]},
                         {"AI Assistant": (None, None, None), "Organic Search": (None, None, None)})
        self.assertEqual({s["value"]: (s["ai_conversions"], s["human_conversions"]) for s in gap["segments"]["device"]},
                         {"mobile": (None, None), "desktop": (None, None)})
        self.assertTrue(all(v is None for p in gap["pages"] for k, v in p.items() if k != "url"))
        self.assertEqual([e["count"] for e in gap["events"]], [None])
        # the markets: Korea collected every day keeps its own values, DE is unknown
        market = {m["property_id"]: m for m in gap["countries"]}
        self.assertEqual((market["test"]["ai_sessions"], market["test"]["ai_conversions"], market["test"]["human_conversions"]), (8, 2, 6))
        self.assertEqual((market["de"]["ai_sessions"], market["de"]["ai_conversions"], market["de"]["human_conversions"]), (None, None, None))
        # rows from before the collector wrote its daily windows cannot be checked: as before
        legacy = (await conversion(Connection([[PROP, de], rows, []]), q))["data"]
        self.assertEqual((legacy["missing"], legacy["engines"][0]["sessions"]), ([], 16))

    async def test_channels_are_not_cut_by_an_engine(self):
        """Report 1 (channels) has no engine: an engine pick would drop the AI channel row and leave the site total
        without AI sessions, so the channels are not given under an engine filter (2026-10-30 W6 review)."""
        rows = [{**row(1, True), "sessions": 10, "key_events": 1, "channel": "AI Assistant"},
                {**row(1, False), "sessions": 90, "key_events": 7, "channel": "Organic Search"},
                {**row(2, True), "sessions": 10, "key_events": 1}, {**row(5, False), "sessions": 100}]
        plain = (await conversion(Connection([[PROP], rows, []]), QueryParams()))["data"]
        self.assertEqual({c["channel"] for c in plain["channels"]}, {"AI Assistant", "Organic Search"})
        picked = (await conversion(Connection([[PROP], rows, []]), QueryParams("engine=chatgpt")))["data"]
        self.assertEqual((picked["channels"], picked["channels_reason"]), ([], "engine"))

    async def test_general_sessions_come_from_report_1_only(self):
        """No mix of reports (report 5 total − report 2 AI) when report 1 is missing: the general sessions are unknown."""
        rows = [{**row(2, True), "sessions": 10, "key_events": 2}, {**row(5, False), "sessions": 100, "page_views": 150}]
        m = (await conversion(Connection([[PROP], rows, []]), QueryParams()))["data"]["metrics"]
        self.assertIsNone(m["human_sessions"])

    async def test_period_users_are_exact_windows_not_daily_sums(self):
        rows = [row(2,True),row(5,False),row(1,False),row(3,True)]
        rows[0].update(sessions=10,key_events=2)
        rows[1].update(sessions=100,page_views=150)
        rows[2].update(sessions=90,key_events=7)
        rows[3].update(is_conv=True,event_count=90)
        windows = [dict(prop_key=1,window_end=date(2026,10,25),window_days=28,cohort=c,
                        page_key=0,engine_mask=0,device_mask=0,nvr_mask=0,users=n) for c,n in (("ai",4),("general",20))]
        result = await conversion(Connection([[PROP],rows,windows]), QueryParams())
        m = result["data"]["metrics"]
        self.assertEqual((m["ai_users"],m["ai_sessions"],m["ai_conversions"],m["ai_conversion_rate"]),(4,10,2,50))
        self.assertEqual((m["human_users"],m["human_sessions"],m["human_conversions"]),(20,90,7))
        self.assertIsNone(result["data"]["trend"][0]["ai_users"])
        filtered = await conversion(Connection([[PROP],rows,windows]), QueryParams("engine=chatgpt"))
        self.assertIsNone(filtered["data"]["metrics"]["ai_users"])
        self.assertIsNone(filtered["data"]["metrics"]["ai_conversion_rate"])
        self.assertEqual(filtered["data"]["metrics"]["ai_conversions"],2)

    async def test_empty_local_source_does_not_fall_back(self):
        for fn,kind in ((conversion,"conversion"),(visibility,"visibility")):
            result = await fn(Connection([[]]),QueryParams())
            self.assertEqual(result["meta"]["source"],"hub_analytics")
            self.assertFalse(result["meta"]["available"])
            self.assertTrue(all(v is None for v in result["data"]["metrics"].values()))

    async def test_properties_are_every_registered_property_with_its_country(self):
        # the AI Conversion panel's 국가 options (2026-10-30): the GA4 properties the account can read, every status
        rows = [dict(property_id="1", brand_bit=2, status="active", country="IT"),
                dict(property_id="2", brand_bit=1, status="unmapped", country="JP")]
        result = await properties(Connection([rows]), QueryParams("brand=Kia"))
        self.assertEqual(result["data"], {"kind": "properties", "properties": rows})
        self.assertTrue(result["meta"]["available"])

    def test_period_ends_at_observed_date(self):
        self.assertEqual(period(QueryParams("days=7"),date(2026,10,25)),(date(2026,10,19),date(2026,10,25),7))


if __name__ == "__main__":
    unittest.main()
