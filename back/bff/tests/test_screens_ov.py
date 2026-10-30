"""Shared overview libraries (bff.screens._summary/_trend/_compare/_period/_competitors): what the
function goldens (golden/ov, recorded from the front) do not cover, plus the two golden helpers.

Golden helpers (targets of golden/ov/*.json, see front/test/bff-golden/ov.golden.test.ts):
  outcome(target, *args)          the function's result, or "__throws__" when it raises
  with_tape(target, tape, *args)  runs an async fetcher with bff.api.get answered from the
                                  recorded calls; every recorded call must be made
"""
import asyncio
import importlib
import unittest
from datetime import datetime, timezone
from unittest import mock

try:
    from bff.api import query
    from bff.screens import _compare, _competitors, _period, _summary, _trend
    from bff.tests.golden_util import Tape
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_ov)") from exc

THROWS = "__throws__"


def _resolve(target: str):
    module, name = target.split(":")
    return getattr(importlib.import_module(module), name)


def outcome(target: str, *args):
    try:
        return _resolve(target)(*args)
    except (ValueError, KeyError, TypeError, IndexError, AttributeError):
        return THROWS


async def with_tape(target: str, tape: list, *args):
    t = Tape(tape)
    with mock.patch("bff.api.get", t.get):
        out = await _resolve(target)(*args)
    unused = set(t.entries) - t.used
    if unused:
        raise AssertionError(f"recorded calls not made: {sorted(unused)}")
    return out


def pairs(params: dict) -> list:
    return [list(p) for p in query(params).multi_items()]


class Period(unittest.TestCase):
    def test_kst_today_is_injectable_and_defaults_to_now_in_seoul(self):
        self.assertEqual(_period.kst_today("2026-09-18T15:00:00Z"), "2026-09-19")
        self.assertEqual(_period.kst_today("2026-09-18T14:59:59Z"), "2026-09-18")
        self.assertEqual(_period.kst_today(datetime(2026, 12, 31, 15, tzinfo=timezone.utc)), "2027-01-01")
        self.assertEqual(_period.kst_today(1789743600000), "2026-09-19")  # epoch ms of 2026-09-18T15:00Z
        with mock.patch("bff.screens._period.datetime") as dt:
            dt.now.return_value = datetime(2026, 10, 26, 23, 30)
            self.assertEqual(_period.kst_today(), "2026-10-26")
            self.assertEqual(str(dt.now.call_args.args[0]), "Asia/Seoul")

    def test_js_calendars(self):
        # Date.UTC: years 0..99 are 1900..; ISO parse keeps the year and rolls the day over
        self.assertEqual(_period.add_days("0050-01-01", 0), "1950-01-01")
        self.assertEqual(_period.iso_dow_of("2026-02-31"), 2)  # = 2026-03-03, a Tuesday
        self.assertEqual(_period.month_window(2024, 2), {"lo": "2024-02-01", "hi": "2024-02-29"})
        self.assertEqual(_period.month_window(2027, 0), {"lo": "2026-12-01", "hi": "2026-12-31"})
        self.assertEqual(_period.iso_of_days(_period.date_utc_days(12000, 0, 1)), "+012000-01")

    def test_throws_where_the_ts_threw(self):
        for call in (lambda: _period.add_days("2026-13-01", 1), lambda: _period.resolve_windows("2026-09-10", 0),
                     lambda: _period.resolve_windows("2026-09-10", 2.5), lambda: _period.windows_from_range("2026-09-10", "2026-09-01"),
                     lambda: _period.iso_dow_of("nope"), lambda: _trend.monday_of("2026-13-01")):
            with self.assertRaises(ValueError):
                call()

    def test_no_suppression_rule_is_left_in_the_screens(self):
        """⛔K 2026-10-31: the screens word the reader's reasons and decide none (the TS suppression port is gone)."""
        for name in ("compute_compare", "compare_suppression_of", "applies_missing_share", "judge_start_window",
                     "judge_start_month", "grace_days", "period_compare_applies", "missing_share", "MISSING_SHARE_MAX",
                     "PERIOD_COMPARE_EPOCH", "SUPPRESSION_PRECEDENCE"):
            self.assertFalse(hasattr(_period, name), name)
        self.assertFalse(hasattr(_compare, "COMPARE_EPOCH_GATED"))
        # a reason the reader no longer sends is not worded as a suppression: the caption names the round counts
        r = {"metric": "visibility", "suppressed": True, "reason": "missing_share", "cyclesPrev": 4, "cyclesCur": 5}
        self.assertEqual(_period.period_caption(r, {"days": 30, "kind": "window"}),
                         {"key": "window", "params": {"prevCycles": 4, "curCycles": 5}})

    def test_request_shape_axis(self):
        self.assertEqual(_period.resolve_request_compare_period_shape("2026-09-07", "2026-09-13")["kind"], "calendarWeek")
        self.assertEqual(_period.resolve_request_compare_period_shape("2026-09-07", "2026-09-13", False)["kind"], "window")


class Queries(unittest.TestCase):
    COMMON = {"surface": "global", "brand": ["Hyundai", "Kia"]}

    def test_summary_parts_and_card(self):
        self.assertEqual(pairs(_summary.summary_query(self.COMMON, {"surface": "global"})),
                         [["brand", "Hyundai"], ["brand", "Kia"], ["parts", "gap"], ["parts", "measured"], ["parts", "urls"],
                          ["surface", "global"]])
        self.assertEqual(pairs(_summary.summary_query({"surface": "global"}, {"surface": "global", "card": True})),
                         [["card", "true"], ["surface", "global"]])
        q = _summary.summary_query({"surface": "project"}, {"surface": "project", "card": True, "cycleOffset": 1, "byFunnel": True})
        self.assertEqual(pairs(q), [["by_funnel", "true"], ["cycle_offset", "1"], ["surface", "project"]])

    def test_trend_brand_keys_sorted_split_own_default(self):
        q = _trend.trend_query({"surface": "global"}, {"surface": "global", "bucket": "cycle", "dimension": "brand",
                                                       "brandKeys": [40, 11, 40, 3], "measuredDays": False,
                                                       "dims": [{"dimension": "category", "top": 13}]})
        self.assertEqual(q["brand_key"], [3, 11, 40])
        self.assertIs(q["split_own"], True)
        self.assertEqual(q["dims"], ["category@13"])
        self.assertIs(q["measured_days"], False)

    def test_compare_no_call_without_closed_period_and_no_epoch_gate(self):
        """No call without a closed period. A period before 2026-09-08 compares too (⛔K 2026-10-31): an answer naming
        the original API's cut-off is read like any other, not turned into "no comparison"."""
        async def run():
            item = {"metric": "visibility", "unit": "pp", "prev": {"num": 4, "den": 10}, "cur": {"num": 5, "den": 10},
                    "suppressed": False, "reason": None}
            get = mock.AsyncMock(return_value={"data": [item], "meta": {"suppressed": {"*": "before_epoch"}}})
            with mock.patch("bff.api.get", get):
                req = {"surface": "global", "kind": "window", "metrics": ["visibility"]}
                self.assertIsNone(await _compare.fetch_period_compare_view({"dateFrom": "2026-09-01"}, {}, req))
                get.assert_not_called()
                results = await _compare.fetch_period_compare_api(
                    {"dateFrom": "2026-08-01", "dateTo": "2026-08-14"}, {"surface": "global"}, req)
                self.assertEqual(len(results), 1)
                self.assertAlmostEqual(results[0]["delta"], 10.0)
                get.assert_awaited_once()
                self.assertEqual(pairs(get.await_args.args[1]),
                                 [["card", "true"], ["kind", "window"], ["metrics", "visibility"], ["surface", "global"]])
        asyncio.run(run())


class Values(unittest.TestCase):
    def test_no_nan_or_infinity_on_empty_denominators(self):
        data = {"visibility": {"num": 0, "den": 0}, "share_of_voice": {"num": 0, "den": 0}, "sentiment": {"num": 0, "den": 0},
                "position": {"sum": 0, "count": 0}, "citation_share": {"num": 0, "den": 0}, "params": {"answers": 0}}
        kpis = _summary.to_mirror_kpis(data, {})
        self.assertEqual([k["value"] for k in kpis], [0, 0, None, None, None])
        self.assertIsNone(_summary.consistency([0, 0]))
        self.assertIsNone(_competitors.competitor_value_of(
            {"mentions": 1, "sentiment": {"positive": 0, "neutral": 0, "negative": 0, "mixed": 0}}, "sentiment"))

    def test_missing_keys_stay_missing(self):
        card = _summary.card("sentiment", None)
        self.assertNotIn("ratio", card)
        b = {"key": "2026-09-14", "round_dates": ["2026-09-14"], "measured_days": None}
        out = _trend.to_standard_trend_buckets({"bucket": "week", "buckets": [b], "series": []})[0]
        self.assertNotIn("cycleAnchorAt", out)
        self.assertNotIn("gap", out)


if __name__ == "__main__":
    unittest.main()
