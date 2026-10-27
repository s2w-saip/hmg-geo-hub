"""Mention screens (bff.screens.mention, mention_data, mention_view): what the golden cases do not cover.

Run in the Gold API image:
  python -m unittest bff.tests.test_screens_mention
Set MENTION_GOLDEN=1 to also replay only this family's own golden cases (not the drill-/rn- helpers'):
  MENTION_GOLDEN=1 python -m unittest bff.tests.test_screens_mention
"""
from __future__ import annotations

import asyncio
import json
import os
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from bff import screens
    from bff.screens import mention_data as D
    from bff.screens import mention_view as V
    from bff.tests.golden_util import case_files, run_case
except ModuleNotFoundError as exc:  # pragma: no cover
    raise unittest.SkipTest("Run inside the BFF image") from exc


def own_cases() -> list:
    return [p for p in case_files(family="mention") if not p.name.startswith(("drill-", "rn-"))]


@unittest.skipUnless(os.environ.get("MENTION_GOLDEN") == "1", "MENTION_GOLDEN=1 replays the family's goldens")
class MentionGolden(unittest.IsolatedAsyncioTestCase):
    async def test_cases(self):
        files = own_cases()
        self.assertTrue(files)
        failures = {}
        for path in files:
            try:
                problems = await run_case(path)
            except Exception as exc:  # noqa: BLE001
                problems = [f"{type(exc).__name__}: {exc}"]
            if problems:
                failures[path.name.split('.')[0]] = problems[:6]
        if failures:
            self.fail(f"{len(failures)}/{len(files)} differ:\n" + "\n".join(f"{k}: {' | '.join(v)}" for k, v in sorted(failures.items())))


class Responder:
    """bff.api.get stand-in answering by path; `fail` = {path: status}."""

    def __init__(self, bodies: dict, fail: dict | None = None) -> None:
        self.bodies, self.fail, self.calls = bodies, fail or {}, []

    async def get(self, path, params=None):
        from bff.api import query
        self.calls.append((path, str(query(params))))
        if path in self.fail:
            raise HTTPException(self.fail[path], "boom")
        return json.loads(json.dumps(self.bodies[path]))


META = {"surface": "global", "as_of": "2026-10-05", "cycles": ["2026-10-05"], "suppressed": {}}


async def build(name: str, pairs: list[tuple[str, str]], responder: Responder):
    with mock.patch("bff.api.get", responder.get):
        return await screens.build(name, QueryParams(pairs))


class DegradeRegistry(unittest.IsolatedAsyncioTestCase):
    async def test_5xx_degrades_and_marks(self):
        D.begin_degrade_scope()

        async def boom():
            raise HTTPException(503, "x")
        self.assertIsNone(await D.degrade_on_api_failure("lbl", boom))
        self.assertTrue(D.was_degraded("lbl"))
        self.assertFalse(D.was_degraded("other"))

    async def test_4xx_raises(self):
        D.begin_degrade_scope()

        async def bad():
            raise HTTPException(422, "x")
        with self.assertRaises(HTTPException):
            await D.degrade_on_api_failure("lbl", bad)
        self.assertFalse(D.was_degraded("lbl"))

    async def test_timeout_and_db_errors_degrade(self):
        import asyncpg
        D.begin_degrade_scope()
        for exc in (asyncio.TimeoutError(), TimeoutError(), ConnectionError(), asyncpg.PostgresError()):
            async def run(e=exc):
                raise e
            self.assertIsNone(await D.degrade_on_api_failure("db", run))
        self.assertTrue(D.was_degraded("db"))

    async def test_programming_errors_raise(self):
        D.begin_degrade_scope()

        async def bug():
            raise KeyError("x")
        with self.assertRaises(KeyError):
            await D.degrade_on_api_failure("bug", bug)

    async def test_marks_cross_gathered_tasks(self):
        D.begin_degrade_scope()

        async def boom():
            raise HTTPException(500, "x")

        async def child():
            return await D.degrade_on_api_failure("child", boom)
        await asyncio.gather(child())
        self.assertTrue(D.was_degraded("child"))

    async def test_scope_is_per_request(self):
        D.begin_degrade_scope()
        D.mark_degraded("a")

        async def other_request():
            D.begin_degrade_scope()
            return D.was_degraded("a")
        self.assertFalse(await asyncio.create_task(other_request()))
        self.assertTrue(D.was_degraded("a"))


class Screens(unittest.IsolatedAsyncioTestCase):
    async def test_hero_degraded_flag(self):
        r = Responder({}, fail={"kpi/summary": 503})
        out = await build("mention/kpi-hero", [("ctx.metric", "exposure")], r)
        self.assertEqual(out, {"hero": {"pct": None, "numerator": 0, "denominator": 0}, "degraded": True})

    async def test_hero_4xx_raises(self):
        r = Responder({}, fail={"kpi/summary": 422})
        with self.assertRaises(HTTPException) as cm:
            await build("mention/kpi-hero", [("ctx.metric", "sov")], r)
        self.assertEqual(cm.exception.status_code, 422)

    async def test_unknown_metric_is_exposure(self):
        summary = {"data": {"visibility": {"num": 1, "den": 8}, "share_of_voice": {"num": 3, "den": 4},
                            "sentiment": None, "position": None, "citation_share": None,
                            "params": {"measured_prompts": 5}}, "meta": META}
        r = Responder({"kpi/summary": summary})
        out = await build("mention/kpi-hero", [("ctx.metric", "weird")], r)
        self.assertEqual(out["hero"]["pct"], 12.5)

    async def test_period_without_period_makes_no_compare_call(self):
        r = Responder({})
        out = await build("mention/kpi-period", [], r)
        self.assertEqual(out, {"periodCompare": None, "periodSlots": None, "monthLine": None})
        self.assertEqual(r.calls, [])

    async def test_period_closed_window_calls_compare_once(self):
        body = {"data": [{"metric": "visibility", "unit": "pp", "prev": {"num": 1, "den": 4}, "cur": {"num": 3, "den": 4},
                          "reason": None}], "meta": {**META, "suppressed": {}}}
        r = Responder({"kpi/compare": body})
        out = await build("mention/kpi-period", [("time", "2026-09-03..2026-09-20")], r)
        self.assertEqual(len(r.calls), 1)
        self.assertEqual(out["periodDays"], 18)
        self.assertIsNone(out["monthLine"])
        self.assertAlmostEqual(out["periodCompare"][0]["delta"], 50.0)

    async def test_period_month_line_uses_ctx_today(self):
        body = {"data": [], "meta": {**META, "suppressed": {}}}
        r = Responder({"kpi/compare": body})
        out = await build("mention/kpi-period", [("time", "2026-10-01..2026-10-26"), ("ctx.today", "2026-10-26")], r)
        self.assertEqual(out["monthLine"]["presetKey"], "thisMonth")
        out = await build("mention/kpi-period", [("time", "2026-10-01..2026-10-26"), ("ctx.today", "2026-11-03")], r)
        self.assertEqual(out["monthLine"]["presetKey"], "lastMonth")

    async def test_prompts_section_degraded_null(self):
        r = Responder({}, fail={"mentions/brands": 503})
        out = await build("mention/prompts-section", [], r)
        self.assertEqual(out, {"data": None, "degraded": True})


class OwnCompareRow(unittest.TestCase):
    """The head-to-head own row (ported from mentions-view.own-compare.test.ts). Hyundai 2.0 (500 mentions)
    + Kia 4.0 (100): mention-weighted (2*500 + 4*100) / 600 = 2.3; shares 20.0 + 20.1."""

    def setUp(self):
        from bff.screens.mention_surfaces import own_compare_row
        self.f = own_compare_row

        def row(brand, mentions, share, pos):
            return {"brand": brand, "mentions": mentions, "prompts": 3, "share": share, "mentionRate": 25,
                    "avgPosition": pos, "isTracked": True}
        self.own = [row("Hyundai", 500, 20.0, 2.0), row("Kia", 100, 20.1, 4.0)]

    def test_server_own_values(self):
        r = self.f(self.own, {"share": 40.2, "avgPosition": 3.1}, 31.5, "__own")
        self.assertEqual(r, {"brand": "__own", "mentions": 600, "prompts": 6, "share": 40.2, "mentionRate": 31.5,
                             "avgPosition": 3.1, "isTracked": True})

    def test_brand_row_merge_without_server_own(self):
        r = self.f(self.own, None, None, "__own")
        self.assertEqual(r["avgPosition"], 2.3)
        self.assertAlmostEqual(r["share"], 40.1, 10)
        self.assertEqual(r["mentionRate"], 25)

    def test_mention_rate_precedence(self):
        own = {"share": 40.2, "avgPosition": 3.1, "mentionRate": 31.5}
        self.assertEqual(self.f(self.own, own, None, "x")["mentionRate"], 31.5)
        self.assertEqual(self.f(self.own, own, 30.9, "x")["mentionRate"], 30.9)
        self.assertEqual(self.f(self.own, {"share": 40.2, "avgPosition": 3.1}, None, "x")["mentionRate"], 25)

    def test_no_position(self):
        self.assertIsNone(self.f(self.own, {"share": 40.2, "avgPosition": None}, None, "x")["avgPosition"])


class ViewRules(unittest.TestCase):
    def test_js_truthiness_of_empty_slots(self):
        # `if (trend.overviewSlots)` is true for [] in JS: the slot path, empty points.
        trend = {"unit": "week", "engines": [], "buckets": [{"bucketStart": "2026-09-07", "measuredDays": 1, "firstAt": None,
                                                              "lastAt": None, "engines": []}],
                 "overviewSlots": [], "trendDegraded": True}
        self.assertEqual(V.kpi_trend_points(trend, "exposure"), [])
        self.assertTrue(V.hero_trend_available(trend))
        self.assertFalse(V.engine_series_uses_slots(trend))

    def test_empty_grid_is_an_empty_axis(self):
        self.assertEqual(V.trend_axis([{"bucketStart": "2026-09-07"}], "week", {"trendGrid": []}), [])

    def test_brand_table_avg_position_nulls(self):
        from bff.screens.mention import brand_table_view
        brands = [{"brand": b, "mentions": m, "prompts": 1, "share": 1.0, "mentionRate": 1.0, "avgPosition": p}
                  for b, m, p in (("a", 3, None), ("b", 2, 2.0), ("c", 1, None), ("d", 4, 1.0))]
        orders = brand_table_view(brands, 10)["orders"]["avgPosition"]
        # dir * ((a ?? Infinity) - (b ?? Infinity)): nulls last ascending, first descending, tied in input order.
        self.assertEqual(orders["asc"], [3, 1, 0, 2])
        self.assertEqual(orders["desc"], [0, 2, 1, 3])

    def test_no_nan_in_payloads(self):
        out = V.engine_competitor_bars({"latest": [{"engine": "e", "answers": 0, "totalMentions": 0, "exposurePct": None,
                                                    "sovPct": None}], "latestBrands": []}, "exposure")
        self.assertEqual(json.dumps(out, allow_nan=False),
                         '[{"engine": "e", "ownPct": null, "competitorAvgPct": null, "competitorCount": 0}]')


if __name__ == "__main__":
    unittest.main()


class PeriodSlots(unittest.TestCase):
    """mention/kpi-period periodSlots: what PeriodDeltaSlot draws (it used to pick the result and build
    the chip/caption in the browser)."""

    def test_first_result_per_metric_window_caption_and_null_without_compare(self):
        from bff.screens.mention import period_slots
        from bff.screens._period import period_caption, period_chip
        a = {"metric": "visibility", "delta": 0.0123, "reason": None}
        b = {"metric": "visibility", "delta": -5, "reason": None}
        c = {"metric": "position", "reason": "no_prev"}
        out = period_slots([a, b, c], None)
        self.assertEqual(out["visibility"]["chip"], period_chip({"metric": "visibility", "delta": 0.0123}))
        self.assertEqual(out["position"]["chip"], period_chip({"metric": "position"}))
        self.assertEqual(out["position"]["caption"], period_caption(c, {"days": 0, "kind": "window"}))
        self.assertEqual(period_slots([a], 28)["visibility"]["caption"], period_caption(a, {"days": 28, "kind": "window"}))
        self.assertIsNone(period_slots(None, 7))
