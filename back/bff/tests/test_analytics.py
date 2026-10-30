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
