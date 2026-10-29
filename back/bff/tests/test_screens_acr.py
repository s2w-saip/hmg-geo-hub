"""ACR screens (back/bff/screens/acr.py): the rules the golden cases do not pin on their own —
JS key order, the language axis rule, the renewal page state, error propagation and the exact
query of each read. The computed payloads themselves are proven by the golden cases (family acr)."""
import asyncio
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from bff.screens import acr
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_acr)") from exc


def run(coro):
    return asyncio.run(coro)


def acr_body(**over) -> dict:
    data = {
        "totals": {"prompt_runs": 8, "prompts": 3, "iterations": 20, "engines": ["chatgpt", "gemini"], "catalog_acr_prompts": 67},
        "brands": [
            {"brand": "Hyundai", "is_ours": True, "choice": 7, "appearance": 11, "cells": 3, "choice_share": {"num": 7, "den": 20}, "coverage": {"num": 3, "den": 8}},
            {"brand": "Toyota", "is_ours": False, "choice": 1, "appearance": 2, "cells": 1, "choice_share": {"num": 1, "den": 20}, "coverage": {"num": 1, "den": 8}},
        ],
        "trend": {"series_brands": ["Hyundai", "Toyota"], "buckets": [
            {"round_date": "2026-09-10", "gap": False, "den": 3, "own": 1, "series": [{"brand": "Hyundai", "num": 1}, {"brand": "Toyota", "num": 2}]},
            {"round_date": "2026-09-03", "gap": False, "den": 16, "own": 1, "series": [{"brand": "Hyundai", "num": 1}]},
            {"round_date": "2026-09-17", "gap": True, "den": 0, "own": 0, "series": []},
        ]},
        "battle": [{"prompt_id": "p1", "prompt_text": "best suv", "cells": [
            {"engine": "chatgpt", "winner_brand": "Hyundai", "winner_is_ours": True, "choice": 4},
            {"engine": "gemini", "winner_brand": None, "winner_is_ours": False, "choice": 0}]}],
        "model_conversion": [{"brand": None, "model": "Tucson", "is_ours": True, "conversion": {"num": 2, "den": 3}, "cells": 2, "top1": 2}],
        "territory": [{"country": None, "engine": "chatgpt", "rows": [
            {"prompt_id": "p1", "prompt_text": None, "valid_acr": 5, "entries": [{"brand": "Hyundai", "choice": 4, "is_ours": True}]}]}],
        "options": {"langs": ["de", "en"], "countries": ["DE", "US"]},
    }
    data.update(over)
    return {"data": data, "meta": {"mode": "snapshot", "as_of": "2026-09-14", "suppressed": {}}}


OPTIONS = {"data": {"geo_matrix": [{"brand": "Kia", "region": "US", "lang": "en"}], "regions": [], "languages": [],
                    "engines": [{"code": "chatgpt", "is_default": True}], "catalog": None, "source_categories": None, "custom_fields": None},
           "meta": {}}
DATES = {"data": {"latest_round_date": None, "first_measured_date": None, "dates": [], "presets": []}, "meta": {}}


def fake_api(acr_answer=None, error=None):
    calls = []

    async def get(path, params=None):
        from bff.api import query
        calls.append((path, sorted(query(params).multi_items())))
        if path == "funnel/acr":
            if error:
                raise error
            return acr_answer or acr_body()
        return OPTIONS if path == "filters/options" else DATES
    return get, calls


class JsRules(unittest.TestCase):
    def test_object_keys_order_puts_array_index_names_first(self):
        obj = {"b": 1, "10": 2, "2": 3, "007": 4, "a": 5, "4294967295": 6, "0": 7, "-1": 8, "１": 9}
        self.assertEqual(acr.js_keys(obj), ["0", "2", "10", "b", "007", "a", "4294967295", "-1", "１"])

    def test_sums_fold_left_like_reduce(self):
        self.assertEqual(acr._sum([0.1] * 10), 0.9999999999999999)  # Python 3.12 sum() would give 1.0

    def test_null_counts_as_zero_in_arithmetic(self):
        self.assertEqual(acr._n(None), 0)
        self.assertEqual(acr._n(3), 3)


class LanguageAxis(unittest.TestCase):
    """acr-live-view.groups.test.ts: the language axis only with measured ACR languages, right after geography."""

    def test_rule(self):
        self.assertIn("language", acr.only_groups(["ko", "en"]))
        self.assertNotIn("language", acr.only_groups([]))
        self.assertNotIn("language", acr.only_groups(None))
        self.assertEqual(acr.only_groups([]), [g for g in acr.only_groups(["ko"]) if g != "language"])
        g = acr.only_groups(["ko"])
        self.assertEqual(g[g.index("geography") + 1], "language")


class RenewalPageState(unittest.TestCase):
    def state(self, sp):
        return acr.page_state(sp, acr.read_standard_filters(sp, acr.READER_SCOPE))

    def test_filtered_ignores_empty_values_and_other_keys(self):
        self.assertFalse(self.state({})["filtered"])
        self.assertFalse(self.state({"brand": "", "tab": "x"})["filtered"])
        self.assertTrue(self.state({"depth3": "x"})["filtered"])
        self.assertTrue(self.state({"engine": ["chatgpt", "gemini"]})["filtered"])

    def test_own_label_drops_the_umbrella(self):
        self.assertEqual(self.state({})["ownLabel"], "HMG")
        self.assertEqual(self.state({"brand": "HMG"})["ownLabel"], "HMG")
        self.assertEqual(self.state({"brand": "HMG~Kia~Genesis"})["ownLabel"], "Kia, Genesis")

    def test_period_is_either_end(self):
        self.assertEqual(self.state({"time": "..2026-10-05"}), {"period": True, "dateFrom": None, "dateTo": "2026-10-05", "filtered": True, "ownLabel": "HMG"})
        self.assertFalse(self.state({"time": "abc"})["period"])

    def test_header_screen_reads_nothing(self):
        get, calls = fake_api()
        with mock.patch("bff.api.get", get):
            out = run(acr.renewal_header(QueryParams("time=2026-10-05..2026-09-01")))
        self.assertEqual(out, {"period": True, "dateFrom": "2026-09-01", "dateTo": "2026-10-05"})
        self.assertEqual(calls, [])


class Reads(unittest.TestCase):
    def test_standard_reads_the_three_calls_with_the_b097_flags(self):
        get, calls = fake_api()
        with mock.patch("bff.api.get", get):
            out = run(acr.standard(QueryParams("engine=Gemini~chatgpt&language=EN&time=2026-09-01..")))
        self.assertIn(("funnel/acr", sorted([("engine", "chatgpt"), ("engine", "gemini"), ("from", "2026-09-01"), ("include_catalog_count", "false"),
                                             ("include_option_countries", "false"), ("lang", "en"), ("surface", "global")])), calls)
        self.assertIn(("filters/options", [("surface", "global")]), calls)
        self.assertIn(("filters/dates", [("family", "all"), ("surface", "global")]), calls)
        self.assertEqual(out["view"]["acrPromptCount"], 67)
        self.assertNotIn("selectableDates", out["panel"])  # no dates -> undefined on the front, not null

    def test_gold_query_is_the_source_query_with_the_surface(self):
        get, calls = fake_api()
        with mock.patch("bff.api.get", get):
            run(acr.gold(QueryParams("brand=Kia&listType=Brand+Message&period=28d&ctx.project_id=p-1")))
            run(acr.gold(QueryParams("geography=US~KR&surface=x")))
        self.assertEqual(calls[0], ("funnel/acr", sorted([("brand", "Kia"), ("days", "28"), ("listType", "Brand Message"), ("period", "28d"),
                                                          ("project_id", "p-1"), ("surface", "project")])))
        self.assertEqual(calls[1], ("funnel/acr", sorted([("country", "KR"), ("country", "US"), ("geography", "US~KR"), ("surface", "website")])))

    def test_gold_keeps_a_null_catalog_count(self):
        body = acr_body(totals={"prompt_runs": 0, "prompts": 0, "iterations": 0, "engines": [], "catalog_acr_prompts": None})
        get, _ = fake_api(body)
        with mock.patch("bff.api.get", get):
            out = run(acr.gold(QueryParams("")))
        self.assertEqual((out["view"]["measured"], out["view"]["acrPromptCount"]), (False, None))
        get, _ = fake_api(body)
        with mock.patch("bff.api.get", get):
            out = run(acr.standard(QueryParams("")))
        self.assertEqual((out["view"]["measured"], out["view"]["acrPromptCount"]), (False, 0))

    def test_api_errors_reach_the_page(self):
        get, _ = fake_api(error=HTTPException(403, "menu_forbidden"))
        for builder in (acr.standard, acr.renewal, acr.gold):
            with mock.patch("bff.api.get", get), self.assertRaises(HTTPException) as ctx:
                run(builder(QueryParams("")))
            self.assertEqual(ctx.exception.status_code, 403)


class Shapes(unittest.TestCase):
    def test_measured_rule_and_own_block(self):
        self.assertFalse(acr.to_standard_acr(acr_body(totals={"prompt_runs": None, "prompts": 0, "iterations": 0, "engines": []})["data"], {})["measured"])
        self.assertEqual(acr.to_standard_acr(acr_body()["data"], {"suppressed": {"*": "hidden"}}), acr._empty_acr())
        self.assertNotIn("own", acr.to_standard_acr(acr_body(own=None)["data"], {}))
        own = acr.to_standard_acr(acr_body(own={"choice": 0, "appearance": 0, "cells": 0, "choice_share": {"num": 0, "den": 20}, "coverage": {"num": 0, "den": 8},
                                                  "brands": [], "rank": 2, "ranked_brands": 2})["data"], {})["own"]
        self.assertEqual(own, {"choiceCount": 0, "appearanceCount": 0, "choiceShare": 0, "coverage": 0})

    def test_sheet_key_and_battle_pivot(self):
        std = acr.to_standard_acr(acr_body()["data"], {})
        live = acr.live_vm(std, 0)
        self.assertEqual(live["battle"][0]["cells"], [{"winner": "Hyundai", "winnerIsOurs": True}, {"winner": None, "winnerIsOurs": False}])
        self.assertEqual(live["territory"][0]["rows"][0]["label"], "p1")
        view = acr.renewal_view(std, None, True, False)
        self.assertEqual(view["sheets"][0]["key"], "|chatgpt")
        self.assertEqual(view["battle"]["views"]["split"], [0])


class OwnTotal(unittest.TestCase):
    """2026-10-29 metric review R1: 당사 = every own brand (Genesis outside the brand table too), on the trend,
    the "당사 = … 합산" chip, the standing and the distribution's 당사 column."""

    def view(self):
        body = acr_body(
            totals={"prompt_runs": 8, "prompts": 3, "iterations": 300, "engines": ["chatgpt"], "catalog_acr_prompts": 67},
            brands=[
                {"brand": "Toyota", "is_ours": False, "choice": 53, "appearance": 60, "cells": 5, "choice_share": {"num": 53, "den": 300}, "coverage": {"num": 5, "den": 8}},
                {"brand": "Hyundai", "is_ours": True, "choice": 20, "appearance": 40, "cells": 5, "choice_share": {"num": 20, "den": 300}, "coverage": {"num": 5, "den": 8}},
                {"brand": "Kia", "is_ours": True, "choice": 14, "appearance": 30, "cells": 4, "choice_share": {"num": 14, "den": 300}, "coverage": {"num": 4, "den": 8}},
                {"brand": "Lexus", "is_ours": False, "choice": 0, "appearance": 9, "cells": 3, "choice_share": {"num": 0, "den": 300}, "coverage": {"num": 3, "den": 8}},
            ],
            own={"choice": 37, "appearance": 75, "cells": 6, "choice_share": {"num": 37, "den": 300}, "coverage": {"num": 6, "den": 8},
                 "brands": ["Hyundai", "Kia", "Genesis"], "rank": 2, "ranked_brands": 5},
            trend={"series_brands": ["Toyota", "Hyundai", "Kia", "Lexus"], "buckets": [
                {"round_date": "2026-10-05", "gap": False, "den": 300, "own": 37,
                 "series": [{"brand": "Toyota", "num": 53}, {"brand": "Hyundai", "num": 20}, {"brand": "Kia", "num": 14}, {"brand": "Lexus", "num": 0}]}]},
            territory=[{"country": "US", "engine": "chatgpt", "rows": [
                {"prompt_id": "p1", "prompt_text": None, "valid_acr": 10, "entries": [
                    {"brand": "Toyota", "choice": 5, "is_ours": False}, {"brand": "Genesis", "choice": 3, "is_ours": True},
                    {"brand": "Kia", "choice": 1, "is_ours": True}]}]}],
        )["data"]
        std = acr.to_standard_acr(body, {})
        return acr.renewal_view(std, std["own"], True, False)

    def test_the_own_trend_is_the_own_total_rounded_once(self):
        # 37 / 300 = 12.33 -> 12.3; the rounded brand series summed: 6.7 + 4.7 = 11.4 (Genesis missing)
        self.assertEqual(self.view()["ownTrend"], [12.3])

    def test_the_chip_names_every_own_brand_of_the_total(self):
        self.assertEqual(self.view()["ownBrands"], ["Hyundai", "Kia", "Genesis"])

    def test_the_standing_is_the_readers(self):
        v = self.view()
        self.assertEqual((v["rank"], v["standingN"]), (2, 5))

    def test_the_distribution_counts_every_own_pick(self):
        self.assertEqual(self.view()["sheets"][0]["rows"][0]["ownN"], 4)


class DistAndEngines(unittest.TestCase):
    """R5: the distribution finding counted rows without any own entry (7 of 80 cells) for prompts 당사 was never
    picked in (43 of 65); the engine bars put cells nobody was picked in under 그 외 브랜드."""

    def view(self):
        body = acr_body(
            territory=[{"country": "US", "engine": "chatgpt", "rows": [
                {"prompt_id": "p1", "prompt_text": None, "valid_acr": 10, "entries": [
                    {"brand": "Toyota", "choice": 6, "is_ours": False}, {"brand": "Hyundai", "choice": 0, "is_ours": True}]},
                {"prompt_id": "p1", "prompt_text": None, "valid_acr": 10, "entries": [{"brand": "Toyota", "choice": 4, "is_ours": False}]},
                {"prompt_id": "p2", "prompt_text": None, "valid_acr": 10, "entries": [{"brand": "BMW", "choice": 3, "is_ours": False}]},
                {"prompt_id": "p3", "prompt_text": None, "valid_acr": 10, "entries": [{"brand": "Toyota", "choice": 2, "is_ours": False}]},
                {"prompt_id": "p4", "prompt_text": None, "valid_acr": 10, "entries": [
                    {"brand": "Hyundai", "choice": 5, "is_ours": True}, {"brand": "Toyota", "choice": 1, "is_ours": False}]},
                {"prompt_id": "p5", "prompt_text": None, "valid_acr": 10, "entries": [
                    {"brand": "Toyota", "choice": 7, "is_ours": False}, {"brand": "Kia", "choice": 0, "is_ours": True}]}]}],
            battle=[{"prompt_id": "p1", "prompt_text": "a", "cells": [{"engine": "chatgpt", "winner_brand": "Hyundai", "winner_is_ours": True, "choice": 4}]},
                    {"prompt_id": "p2", "prompt_text": "b", "cells": [{"engine": "chatgpt", "winner_brand": None, "winner_is_ours": False, "choice": 0}]},
                    {"prompt_id": "p3", "prompt_text": "c", "cells": [{"engine": "chatgpt", "winner_brand": "Toyota", "winner_is_ours": False, "choice": 3}]}],
            totals={"prompt_runs": 5, "prompts": 4, "iterations": 50, "engines": ["chatgpt"], "catalog_acr_prompts": 67},
            own={"choice": 5, "appearance": 2, "cells": 2, "choice_share": {"num": 5, "den": 50}, "coverage": {"num": 2, "den": 5},
                 "brands": ["Hyundai", "Kia"], "rank": 2, "ranked_brands": 3})["data"]
        std = acr.to_standard_acr(body, {})
        return acr.renewal_view(std, std["own"], True, False)

    def test_the_distribution_finding_counts_prompts_never_picking_own(self):
        f = next(x for x in self.view()["findings"] if x["kind"] == "dist")
        # p1 (two cells, 당사 0), p2, p3 and p5 (당사 listed, 0 picks) of the 5 prompts; rows without a 당사 entry: 3 of 6 cells
        self.assertEqual((f["params"]["zero"], f["params"]["rows"]), (4, 5))

    def test_no_pick_is_not_another_brand(self):
        w = self.view()["engineWins"][0]
        self.assertEqual((w["ownWins"], w["noneWins"], w["restBase"]), (1, 1, 1))


if __name__ == "__main__":
    unittest.main()
