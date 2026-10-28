"""Overview dashboards (bff.screens.overview): rules the golden cases do not reach — 4xx paths (raised,
so the page keeps its error route), failure classification, call parameters, master-data helpers.

The two module functions below are function-golden targets (front/test/bff-golden/overview.golden.test.ts)."""
import asyncio
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from bff.screens import build
    from bff.screens import overview as ov
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_overview)") from exc


def numeric_table() -> dict:
    """Golden target: the ISO alpha-2 -> world-atlas numeric table (lib/geo-catalog/country-numeric.ts)."""
    return dict(ov.GEO_COUNTRY_NUMERIC)


def pending_of(brand: str) -> list:
    """Golden target: buildGeo with no rows -> the active brand's RHQ regions (lib/rhq)."""
    return ov.empty_geo(brand or None)["pending"]


def run(coro):
    return asyncio.run(coro)


META = {"surface": "global", "mode": "snapshot", "as_of": "2026-10-05", "cycles": ["2026-10-05"], "ignored_filters": [],
        "dropped_filters": {}, "suppressed": {}, "source": {"url_rates": "live"}}


def summary(answers: int = 100) -> dict:
    return {"data": {"visibility": {"num": 50, "den": answers}, "share_of_voice": {"num": 30, "den": 100},
                     "sentiment": {"num": 10, "den": 30}, "position": {"sum": 60, "count": 50},
                     "citation_share": {"num": 5, "den": 50},
                     "params": {"answers": answers, "measured_prompts": 1, "applied_prompts": 1,
                                "prompts_without_brand": 0, "measured_by_funnel": None}, "analysis_gap": None},
            "meta": META}


GEO = {"data": {"markets": [], "pending": [], "own_label": "HMG"}, "meta": META}


class Router:
    """bff.api.get stand-in: answers by path, raises the configured HTTP status, records the calls."""

    def __init__(self, bodies: dict, fail: dict | None = None):
        self.bodies, self.fail, self.calls = bodies, fail or {}, []

    async def get(self, path, params=None):
        from bff.api import query
        self.calls.append((path, list(query(params).multi_items())))
        key = "brand-trend" if path == "trend" and dict(query(params)).get("dimension") == "brand" else path
        if key in self.fail:
            raise HTTPException(self.fail[key], "boom")
        body = self.bodies.get(key)
        if body is None:
            raise AssertionError(f"unexpected call {path}")
        return body


def screen(name: str, qs: str, router: Router):
    with mock.patch("bff.api.get", router.get):
        return run(build(name, QueryParams(qs)))


class Failures(unittest.TestCase):
    def test_transient_classification(self):
        self.assertTrue(ov.is_transient(HTTPException(503)))
        self.assertTrue(ov.is_transient(HTTPException(500)))
        self.assertTrue(ov.is_transient(TimeoutError()))
        self.assertTrue(ov.is_transient(ConnectionResetError()))
        self.assertFalse(ov.is_transient(HTTPException(422)))
        self.assertFalse(ov.is_transient(HTTPException(404)))
        self.assertFalse(ov.is_transient(KeyError("x")))

    def test_4xx_is_raised_by_every_section(self):
        cases = [
            ("overview/as-of", "", {"kpi/summary": 422}),
            ("overview/cards", "", {"kpi/summary": 403}),
            ("overview/cards", "time=2026-09-01..2026-10-05", {"kpi/compare": 422}),
            ("overview/card-trend", "", {"trend": 422}),
            ("overview/card-competitors", "", {"mentions/brands": 422}),
            ("overview/card-competitors", "", {"brand-trend": 422}),
            ("overview/geo", "", {"geo": 403}),
            ("website/summary", "", {"kpi/summary": 401}),
            ("website/summary-deferred", "", {"kpi/engines": 403}),
            ("website/trend", "", {"trend": 422}),
            ("website/composition", "", {"citations/domains": 422}),
        ]
        bodies = {"kpi/summary": summary(), "mentions/brands": {"data": {"brands": []}, "meta": META},
                  "trend": {"data": {"bucket": "cycle", "dimension": "none", "own_label": "HMG", "buckets": [], "series": []},
                            "meta": META},
                  "brand-trend": {"data": {"bucket": "cycle", "dimension": "brand", "own_label": "HMG", "buckets": [],
                                           "series": []}, "meta": META},
                  "citations/domains": {"data": {"summary": {"own_share": {"num": 0, "den": 0}}, "items": [],
                                                 "competitor_sources": []}, "meta": META},
                  "kpi/engines": {"data": {"rows": []}, "meta": META}, "geo": {"data": {}, "meta": META},
                  "kpi/compare": {"data": [], "meta": META}}
        for name, qs, fail in cases:
            with self.subTest(name=name, fail=fail), self.assertRaises(HTTPException) as cm:
                screen(name, qs, Router(bodies, fail))
            self.assertLess(cm.exception.status_code, 500)

    def test_website_trend_failure_is_raised_but_the_deferred_tiles_keep_going(self):
        bodies = {"kpi/summary": summary(), "mentions/brands": {"data": {"brands": []}, "meta": META},
                  "kpi/engines": {"data": {"rows": []}, "meta": META}}
        with self.assertRaises(HTTPException):
            screen("website/trend", "", Router(bodies, {"trend": 503}))
        out = screen("website/summary-deferred", "", Router(bodies, {"trend": 503}))
        self.assertEqual(out["state"], "ok")


class Calls(unittest.TestCase):
    def test_card_reads_send_the_front_parameters(self):
        router = Router({"kpi/summary": summary(), "mentions/brands": {"data": {"brands": []}, "meta": META}})
        screen("overview/cards", "brand=Kia&engine=ChatGPT", router)
        calls = dict(router.calls)
        self.assertEqual(calls["kpi/summary"], [("brand", "Kia"), ("card", "true"), ("engine", "chatgpt"),
                                                ("parts", "urls"), ("surface", "global")])
        self.assertEqual(calls["mentions/brands"], [("brand", "Kia"), ("card", "true"), ("engine", "chatgpt"),
                                                    ("include", "hmg"), ("sort", "mentions"), ("surface", "global"),
                                                    ("top_n", "20")])

    def test_open_period_sends_one_end_and_no_compare(self):
        router = Router({"kpi/summary": summary(), "mentions/brands": {"data": {"brands": []}, "meta": META}})
        out = screen("overview/cards", "time=2026-09-20..", router)
        self.assertEqual([p for p, _ in router.calls].count("kpi/compare"), 0)
        self.assertIn(("from", "2026-09-20"), dict(router.calls)["kpi/summary"])
        self.assertIsNone(out["compareTitle"])

    def test_website_without_one_active_brand_never_reads_geo(self):
        router = Router({"kpi/summary": {**summary(), "meta": {**META, "surface": "website"}},
                         "mentions/brands": {"data": {"brands": []}, "meta": META}})
        out = screen("website/geo", "ctx.admin=true&brand=Kia~Genesis", router)
        self.assertNotIn("geo", [p for p, _ in router.calls])
        self.assertEqual(out["geo"]["markets"], [])
        # a non-admin page ignores ?brand= (the website brand axis is admin only)
        router = Router(router.bodies)
        screen("website/geo", "ctx.admin=false&brand=Kia", router)
        self.assertNotIn("geo", [p for p, _ in router.calls])

    def test_geo_reads_its_markets_with_the_summary(self):
        # the markets read leaves with the summary, not after it (the summary only decides whether they show)
        geo_started = asyncio.Event()

        class Gate(Router):
            async def get(self, path, params=None):
                if path == "geo":
                    geo_started.set()
                elif path == "kpi/summary":
                    await asyncio.wait_for(geo_started.wait(), 2)
                return await super().get(path, params)

        out = screen("overview/geo", "", Gate({"kpi/summary": summary(), "geo": GEO}))
        self.assertIsNotNone(out["geo"], "the summary waited for nothing: the markets read never left")
        self.assertEqual((out["geo"]["ourLabel"], out["degraded"]), ("HMG", False))

    def test_geo_markets_count_only_when_the_summary_has_answers(self):
        for fail in (403, 503):
            with self.subTest(fail=fail):
                out = screen("overview/geo", "", Router({"kpi/summary": summary(answers=0), "geo": GEO}, {"geo": fail}))
                self.assertEqual(out, {"geo": None, "degraded": False})
        out = screen("overview/geo", "", Router({"kpi/summary": summary(), "geo": GEO}, {"geo": 503}))
        self.assertEqual(out, {"geo": None, "degraded": True})
        out = screen("overview/geo", "", Router({"kpi/summary": summary(), "geo": GEO}, {"kpi/summary": 503}))
        self.assertEqual(out, {"geo": None, "degraded": False})

    def test_unknown_surface_is_refused(self):
        with self.assertRaises(HTTPException) as cm:
            screen("overview/as-of", "ctx.surface=project", Router({}))
        self.assertEqual(cm.exception.status_code, 422)


class Helpers(unittest.TestCase):
    def test_rhq_regions_and_empty_geo(self):
        self.assertEqual(ov.rhq_region_ids_for_brand("Genesis"),
                         ["genesis-asia-pacific", "genesis-middle-east", "genesis-north-america", "genesis-europe",
                          "genesis-africa"])
        self.assertEqual(ov.empty_geo(None), {"markets": [], "pending": [], "ourLabel": "HMG"})

    def test_own_label(self):
        self.assertEqual(ov.own_label_of({"brand": ["Kia", "HMG", "Genesis"]}), "Kia, Genesis")
        self.assertEqual(ov.own_label_of({"brand": ["HMG"]}), "HMG")
        self.assertEqual(ov.own_label_of({}), "HMG")

    def test_delta_mark(self):
        self.assertIsNone(ov.delta_mark("visibility", None))
        self.assertEqual(ov.delta_mark("visibility", 0.04), {"r": 0, "tone": "flat"})
        self.assertEqual(ov.delta_mark("visibility", -0.05), {"r": 0, "tone": "flat"})  # Math.round(-0.5) = -0
        self.assertEqual(ov.delta_mark("visibility", 0.05), {"r": 0.1, "tone": "good"})
        self.assertEqual(ov.delta_mark("position", 0.25), {"r": 0.3, "tone": "bad"})
        self.assertEqual(ov.delta_mark("position", -1.25), {"r": -1.2, "tone": "good"})

    def test_tile_goodness(self):
        self.assertEqual([ov.goodness(d, b) for d in ("up", "down", "flat") for b in ("higher", "lower")],
                         ["good", "bad", "bad", "good", "flat", "flat"])

    def test_geo_view_sorts_countries_by_the_localized_name(self):
        live = {"ourLabel": "HMG", "pending": [], "markets": [
            {"region": "", "hmgSov": 1, "metrics": None, "topBrand": {"name": "HMG", "sov": 1}, "topRival": None,
             "countries": [{"code": c, "hmgSov": 1, "metrics": None, "topBrand": None, "topRival": None}
                           for c in ("US", "KR", "DE", "SA-Dammam")]}]}
        ko = ov.geo_view(__import__("copy").deepcopy(live), "ko")
        en = ov.geo_view(__import__("copy").deepcopy(live), "en")
        self.assertEqual(ko["countryOrder"], ["KR", "DE", "US", "SA-Dammam"])  # 대한민국 독일 미국 사우디 아라비아 - 담맘
        self.assertEqual(en["countryOrder"], ["DE", "SA-Dammam", "KR", "US"])  # Germany, Saudi Arabia - Dammam, South Korea, United States
        self.assertFalse(ko["markets"][0]["showLead"])
        self.assertEqual(ko["markets"][0]["numerics"], ["840", "410", "276"])


if __name__ == "__main__":
    unittest.main()
