"""Source screens (GA4/SEO, projects, keywords, social, Gold prompts): the rules moved from the front."""
import unittest
from unittest import mock

try:
    from starlette.datastructures import QueryParams
    from bff.screens import sources
    from bff.screens.sources import day_of, parse_time_range, prev_cursor, source_query, split_filter_values
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_sources)") from exc


class UrlRules(unittest.TestCase):
    def test_split_filter_values(self):
        self.assertEqual(split_filter_values("KR~ US ~all~"), ["KR", "US"])
        self.assertEqual(split_filter_values("﻿KR~US"), ["KR", "US"])  # JS trim, not str.strip
        self.assertEqual(split_filter_values(["KR", "US~JP"]), ["KR", "US", "JP"])
        self.assertEqual(split_filter_values(None), [])

    def test_parse_time_range(self):
        self.assertEqual(parse_time_range("2026-10-05..2026-09-01"), {"from": "2026-09-01", "to": "2026-10-05"})
        self.assertEqual(parse_time_range("2026-09-01.."), {"from": "2026-09-01"})
        self.assertEqual(parse_time_range("..2026-09-01..x"), {"to": "2026-09-01"})
        self.assertIsNone(parse_time_range("2026-09-01"))
        self.assertIsNone(parse_time_range("x..y"))
        self.assertEqual(parse_time_range(["2026-09-01..2026-09-02", "x"]), {"from": "2026-09-01", "to": "2026-09-02"})

    def test_source_query_renames_ui_axes_and_keeps_raw_params(self):
        q = source_query({"geography": "KR~US", "visitorType": "new", "period": "7d", "time": "2026-09-05..2026-09-01", "tab": "x", "brand": ""})
        self.assertEqual(q, {"geography": "KR~US", "visitorType": "new", "period": "7d", "time": "2026-09-05..2026-09-01", "tab": "x", "brand": "",
                             "country": ["KR", "US"], "visitor_type": ["new"], "days": "7", "from": "2026-09-01", "to": "2026-09-05"})
        self.assertEqual(source_query({"period": ["7d", "28d"]})["days"], "7d,28")

    def test_prev_cursor_is_number_of_cursor_minus_one_page(self):
        cases = {None: None, "0": None, "": None, "abc": None, "75": "25", "50": "0", "12.5": "0", "125.5": "75.5", ("60",): "10", ("1", "2"): None}
        for raw, expected in cases.items():
            sp = {} if raw is None else {"cursor": list(raw) if isinstance(raw, tuple) else raw}
            self.assertEqual(prev_cursor(sp), expected, raw)

    def test_day_of_takes_the_leading_date_as_sent(self):
        self.assertEqual(day_of("2026-10-11T23:34:45.438000+00:00"), "2026-10-11")
        self.assertIsNone(day_of(None))


def run(coro):
    import asyncio
    return asyncio.run(coro)


class Builders(unittest.TestCase):
    def test_keywords_options_and_refs(self):
        body = {"data": {"tab": "volume", "markets": [{"location_code": 2840, "language_code": "en"}, {"location_code": None, "language_code": None},
                                                       {"location_code": 2840, "language_code": "ko"}],
                         "items": [{"kw_key": 1, "seed_kw_key": 9}, {"kw_key": 2, "seed_kw_key": None}, {"kw_key": None}, {}]},
                "meta": {"page": {"total": 120, "next_cursor": "50"}}}
        with mock.patch("bff.api.get", mock.AsyncMock(return_value=body)):
            data = run(sources.keywords(QueryParams("cursor=100")))
        self.assertEqual(data["location_options"], ["2840", "0"])
        self.assertEqual(data["language_options"], ["en", "null", "ko"])
        self.assertEqual([r["keyword_ref"] for r in data["items"]], ["9", "2", "null", "undefined"])
        self.assertEqual(data["pager"], {"total": 120, "next": "50", "prev": "50"})

    def test_social_labels_merges_and_zero_stats(self):
        body = {"data": {"tab": "combinations", "stats": {"research_runs": 0, "claims": 3},
                         "items": [{"combo_id": "a", "description": None, "condition_a": "x", "condition_b": ""},
                                   {"combo_id": "b", "description": "d", "condition_a": "x", "condition_b": "y"},
                                   {"combo_id": "c", "description": None, "condition_a": 1.0, "condition_b": "y"}],
                         "detail": {"evidence": [{"source_title": None, "source_host": "h", "source_url": "u"}],
                                    "combination_evidence": [{"source_url": None}]}},
                "meta": {"page": {"total": 3, "next_cursor": None}}}
        with mock.patch("bff.api.get", mock.AsyncMock(return_value=body)):
            data = run(sources.social(QueryParams("tab=combinations")))
        self.assertEqual([r["label"] for r in data["items"]], ["x", "d", "1 · y"])
        self.assertEqual((data["research_runs_shown"], data["claims_shown"]), (None, 3))
        self.assertEqual([r["source_label"] for r in data["evidence_rows"]], ["h", None])
        self.assertEqual(data["pager"], {"total": 3, "next": None, "prev": None})

    def test_analytics_window_filter_flag(self):
        body = {"data": {"windows": [{"engine_mask": 0, "device_mask": 0, "nvr_mask": 0}, {"engine_mask": 0, "device_mask": 2, "nvr_mask": 0},
                                     {"engine_mask": False, "device_mask": 0, "nvr_mask": 0}]}, "meta": {}}
        get = mock.AsyncMock(return_value=body)
        with mock.patch("bff.api.get", get):
            res = run(sources.analytics(QueryParams("ctx.kind=conversion&ctx.project_id=p1&geography=KR&period=7d")))
        self.assertEqual([w["filter_all"] for w in res["data"]["windows"]], [True, False, False])
        path, query = get.call_args.args
        self.assertEqual(path, "analytics/conversion")
        self.assertEqual(query, {"geography": "KR", "period": "7d", "country": ["KR"], "days": "7", "project_id": "p1"})

    def test_project_kpis_are_percent_values_or_null(self):
        detail = {"data": {"project": {}, "prompts": [{"last_measured": "2026-10-01T00:00:00+00:00"}]}}
        summary = {"data": {"visibility": {"num": 1, "den": 3}, "share_of_voice": {"num": 0, "den": 0}, "sentiment": None}}
        with mock.patch("bff.api.get", mock.AsyncMock(side_effect=[detail, summary])):
            data = run(sources.project_detail(QueryParams("ctx.project_id=p1&ctx.kpis=true")))
        self.assertEqual(data["kpis"], {"visibility": 100 * 1 / 3, "share_of_voice": None, "sentiment": None, "citation_share": None})
        self.assertEqual(data["prompts"][0]["last_measured_day"], "2026-10-01")


if __name__ == "__main__":
    unittest.main()
