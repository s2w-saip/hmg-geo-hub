"""Aggregation rules: absence is not zero, and overlapping reports/users are not additive."""
import unittest
from datetime import date

try:
    from starlette.datastructures import QueryParams
    from bff.hub_stores.analytics_reader import conversion, conversions, empty, observed_sum, period, visibility
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

    def test_period_ends_at_observed_date(self):
        self.assertEqual(period(QueryParams("days=7"),date(2026,10,25)),(date(2026,10,19),date(2026,10,25),7))


if __name__ == "__main__":
    unittest.main()
