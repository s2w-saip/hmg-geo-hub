"""ACR screens (back/bff/screens/acr.py): the rules the golden cases do not pin on their own —
JS key order, the language axis rule, the renewal page state, error propagation and the exact
query of each read. The computed payloads themselves are proven by the golden cases (family acr)."""
import asyncio
import json
import unittest
from pathlib import Path
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from bff.screens import acr
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_acr)") from exc


def run(coro):
    return asyncio.run(coro)


def with_states(sheet: dict) -> dict:
    """A reader sheet with 당사's state counts as the reader makes them: per prompt of its rows (a sheet sent without
    rows counts its rows absent)."""
    if "states" in sheet:
        return sheet
    own: dict = {}
    for r in sheet["rows"]:
        o = own.setdefault(r["prompt_id"], [0, 0])
        for e in r["entries"]:
            if e["is_ours"]:
                o[0] += e["choice"] or 0
                o[1] += e["appearance"] or 0
    states = {"pick": 0, "listed": 0, "absent": 0 if sheet["rows"] else sheet["row_count"]}
    for choice, appearance in own.values():
        states["pick" if choice > 0 else "listed" if appearance > 0 else "absent"] += 1
    return {**sheet, "states": states}


def acr_body(**over) -> dict:
    data = {
        "totals": {"prompt_runs": 8, "prompts": 3, "iterations": 20, "engines": ["chatgpt", "gemini"], "catalog_acr_prompts": 67},
        "brands": [
            {"brand": "Hyundai", "is_ours": True, "is_hmg": True, "choice": 7, "appearance": 11, "cells": 3, "choice_share": {"num": 7, "den": 20}, "coverage": {"num": 3, "den": 8}},
            {"brand": "Toyota", "is_ours": False, "is_hmg": False, "choice": 1, "appearance": 2, "cells": 1, "choice_share": {"num": 1, "den": 20}, "coverage": {"num": 1, "den": 8}},
        ],
        "trend": {"series_brands": ["Hyundai", "Toyota"], "buckets": [
            {"round_date": "2026-09-10", "gap": False, "den": 3, "own": 1, "series": [{"brand": "Hyundai", "num": 1}, {"brand": "Toyota", "num": 2}]},
            {"round_date": "2026-09-03", "gap": False, "den": 16, "own": 1, "series": [{"brand": "Hyundai", "num": 1}]},
            {"round_date": "2026-09-17", "gap": True, "den": 0, "own": 0, "series": []},
        ]},
        "battle": [{"prompt_id": "p1", "prompt_text": "best suv", "cells": [
            {"engine": "chatgpt", "winner_brand": "Hyundai", "winner_is_ours": True, "choice": 4},
            {"engine": "gemini", "winner_brand": None, "winner_is_ours": False, "choice": 0}]}],
        "model_conversion": [{"brand": None, "model": "Tucson", "is_ours": True, "is_hmg": True, "conversion": {"num": 2, "den": 3}, "cells": 2, "top1": 2}],
        "territory": [{"country": None, "engine": "chatgpt", "row_count": 1, "rows": [
            {"prompt_id": "p1", "prompt_text": None, "valid_acr": 5, "cells": 1, "entries": [{"brand": "Hyundai", "choice": 4, "appearance": 4, "is_ours": True}]}]}],
        "options": {"langs": ["de", "en"], "countries": ["DE", "US"]},
    }
    data.update(over)
    data["territory"] = [with_states(t) for t in data["territory"]]
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
        return acr.page_state(sp, acr.read_standard_filters(sp, acr.reader_scope()))

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

    def test_the_renewal_body_names_the_round_it_shows(self):
        """The snapshot's round (the read's as_of) for the header, the summary chip and the footer (2026-10-30, metric
        review ⚠️ #1: the page named no measurement date); a period's last round; none when the read names none."""
        for query, answer, as_of in (("", acr_body(), "2026-09-14"), ("time=2026-09-01..2026-09-30", acr_body(), "2026-09-14"),
                                     ("", {**acr_body(), "meta": {"suppressed": {}}}, None)):
            get, _ = fake_api(answer)
            with mock.patch("bff.api.get", get):
                self.assertEqual(run(acr.renewal(QueryParams(query)))["body"]["asOf"], as_of)


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
            territory=[{"country": "US", "engine": "chatgpt", "row_count": 1, "rows": [
                {"prompt_id": "p1", "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [
                    {"brand": "Toyota", "choice": 5, "appearance": 5, "is_ours": False}, {"brand": "Genesis", "choice": 3, "appearance": 3, "is_ours": True},
                    {"brand": "Kia", "choice": 1, "appearance": 1, "is_ours": True}]}]}],
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
        self.assertEqual(self.view()["sheet"]["rows"][0]["ownN"], 4)


class DistAndEngines(unittest.TestCase):
    """R5: the distribution finding counted rows without any own entry (7 of 80 cells) for prompts 당사 was never
    picked in (43 of 65); the engine bars put cells nobody was picked in under 그 외 브랜드."""

    def view(self):
        body = acr_body(
            territory=[{"country": "US", "engine": "chatgpt", "row_count": 6, "rows": [
                {"prompt_id": "p1", "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [
                    {"brand": "Toyota", "choice": 6, "appearance": 6, "is_ours": False}, {"brand": "Hyundai", "choice": 0, "appearance": 1, "is_ours": True}]},
                {"prompt_id": "p1", "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [{"brand": "Toyota", "choice": 4, "appearance": 4, "is_ours": False}]},
                {"prompt_id": "p2", "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [{"brand": "BMW", "choice": 3, "appearance": 3, "is_ours": False}]},
                {"prompt_id": "p3", "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [{"brand": "Toyota", "choice": 2, "appearance": 2, "is_ours": False}]},
                {"prompt_id": "p4", "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [
                    {"brand": "Hyundai", "choice": 5, "appearance": 5, "is_ours": True}, {"brand": "Toyota", "choice": 1, "appearance": 1, "is_ours": False}]},
                {"prompt_id": "p5", "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [
                    {"brand": "Toyota", "choice": 7, "appearance": 7, "is_ours": False}, {"brand": "Kia", "choice": 0, "appearance": 1, "is_ours": True}]}]}],
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


class DistTop(unittest.TestCase):
    """2026-10-29: a row nobody was picked in has no 최빈 brand (it showed the alphabetically first candidate, "Audi 0")."""

    def rows(self):
        body = acr_body(territory=[{"country": "US", "engine": "chatgpt", "row_count": 2, "rows": [
            {"prompt_id": "p1", "prompt_text": None, "valid_acr": 7, "cells": 1, "entries": [
                {"brand": "Audi", "choice": 0, "appearance": 1, "is_ours": False}, {"brand": "Hyundai", "choice": 0, "appearance": 1, "is_ours": True}]},
            {"prompt_id": "p2", "prompt_text": None, "valid_acr": 7, "cells": 1, "entries": [
                {"brand": "Tesla", "choice": 3, "appearance": 3, "is_ours": False}, {"brand": "Audi", "choice": 0, "appearance": 1, "is_ours": False}]}]}])["data"]
        std = acr.to_standard_acr(body, {})
        return acr.renewal_view(std, None, True, False)["sheet"]["rows"]

    def test_a_row_without_picks_has_no_top(self):
        self.assertIsNone(self.rows()[0]["top"])

    def test_a_row_with_picks_keeps_the_most_picked(self):
        self.assertEqual(self.rows()[1]["top"], {"brand": "Tesla", "choice": 3})


SHEET_US = {"country": "US", "engine": "gemini", "row_count": 2, "rows": [
    {"prompt_id": "p2", "prompt_text": "b", "valid_acr": 5, "cells": 1, "entries": [{"brand": "Kia", "choice": 2, "appearance": 2, "is_ours": True}]},
    {"prompt_id": "p1", "prompt_text": "a", "valid_acr": 5, "cells": 1, "entries": [{"brand": "BMW", "choice": 1, "appearance": 1, "is_ours": False}]}]}


class SheetLoading(unittest.TestCase):
    """2026-10-29: the renewal page gets the sheet tabs and the first sheet; acr/renewal-sheet sends a sheet when its
    tab opens (every sheet's rows were 94% of the page's 4.4 MB)."""

    def sheet_api(self, sheet):
        calls = []

        async def get(path, params=None):
            from bff.api import query
            calls.append((path, sorted(query(params).multi_items())))
            return {"data": {"sheet": sheet and with_states(sheet)}, "meta": {"suppressed": {}}}
        return get, calls

    def test_the_page_reads_the_first_sheets_rows_only_and_the_head_to_head(self):
        get, calls = fake_api()
        with mock.patch("bff.api.get", get):
            run(acr.renewal(QueryParams("engine=gemini")))
        self.assertIn(("funnel/acr", sorted([("engine", "gemini"), ("include_catalog_count", "false"), ("include_head_to_head", "true"),
                                             ("include_option_countries", "false"), ("surface", "global"), ("territory_rows", "first")])), calls)

    def test_the_view_has_every_tab_and_the_first_sheet(self):
        first = {"country": None, "engine": "chatgpt", "row_count": 1, "rows": acr_body()["data"]["territory"][0]["rows"]}
        std = acr.to_standard_acr(acr_body(territory=[first, {**SHEET_US, "rows": []}])["data"], {})
        view = acr.renewal_view(std, None, True, False)
        self.assertEqual(view["sheets"], [{"key": "|chatgpt", "region": None, "engine": "chatgpt", "count": 1},
                                          {"key": "US|gemini", "region": "US", "engine": "gemini", "count": 2}])
        self.assertEqual(view["sheet"]["key"], "|chatgpt")
        self.assertIsNone(acr.renewal_view(acr.to_standard_acr(acr_body(territory=[])["data"], {}), None, True, False)["sheet"])

    def test_a_sheet_is_read_with_the_page_filters(self):
        get, calls = self.sheet_api(SHEET_US)
        with mock.patch("bff.api.get", get):
            out = run(acr.renewal_sheet(QueryParams("sheet=US|gemini&engine=gemini&time=2026-09-01..2026-10-05&ctx.surface=global")))
            run(acr.renewal_sheet(QueryParams("sheet=|chatgpt")))
        self.assertEqual(calls[0], ("funnel/acr/territory", sorted([("engine", "gemini"), ("from", "2026-09-01"), ("sheet_country", "US"),
                                                                    ("sheet_engine", "gemini"), ("surface", "global"), ("to", "2026-10-05")])))
        self.assertIn(("sheet_country", ""), calls[1][1])
        # the same sheet as the page builds it from funnel/acr
        std = acr.to_standard_acr(acr_body(territory=[SHEET_US])["data"], {})
        self.assertEqual(out["sheet"], acr.renewal_view(std, None, True, False)["sheet"])
        self.assertEqual(out["sheet"]["orders"]["text"]["all"], [1, 0])

    def test_no_cell_is_no_sheet(self):
        get, _ = self.sheet_api(None)
        with mock.patch("bff.api.get", get):
            self.assertEqual(run(acr.renewal_sheet(QueryParams("sheet=US|gemini"))), {"sheet": None})

    def test_a_bad_key_is_refused(self):
        get, calls = self.sheet_api(SHEET_US)
        for qs in ("", "sheet=US", "sheet=a&sheet=b|c"):
            with mock.patch("bff.api.get", get), self.assertRaises(HTTPException) as ctx:
                run(acr.renewal_sheet(QueryParams(qs)))
            self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(calls, [])



class DistStates(unittest.TestCase):
    """2026-10-29 the 분포 card redesign (the user's picks): 당사's state per row (picked / listed but never picked /
    absent), filtered by state, sorted by 당사 열세 first; the bar draws the brands picked only."""

    def sheet(self):
        def row(pid, text, valid, entries):
            return {"prompt_id": pid, "prompt_text": text, "valid_acr": valid, "cells": 1,
                    "entries": [{"brand": b, "choice": c, "appearance": a, "is_ours": o} for b, c, a, o in entries]}
        body = acr_body(territory=[{"country": "US", "engine": "chatgpt", "row_count": 5, "rows": [
            row("p1", "a", 10, [("Hyundai", 6, 9, True), ("Toyota", 2, 8, False)]),               # picked, 당사 leads: gap -0.4
            row("p2", "b", 10, [("Toyota", 9, 10, False), ("Kia", 0, 7, True), ("BMW", 0, 4, False)]),  # listed, gap 0.9
            row("p3", "c", 10, [("Tesla", 5, 6, False), ("Audi", 0, 3, False)]),                  # absent, gap 0.5
            row("p4", "d", 20, [("Toyota", 10, 12, False), ("Genesis", 0, 0, True)]),             # 당사 row with no appearance: absent, gap 0.5
            row("p5", "e", 10, [("Mazda", 0, 5, False), ("Hyundai", 0, 2, True)]),                # nobody picked: listed, gap 0
        ]}])["data"]
        std = acr.to_standard_acr(body, {})
        return acr.renewal_view(std, None, True, False)["sheet"]

    def test_the_state_of_each_row(self):
        self.assertEqual([r["state"] for r in self.sheet()["rows"]], ["pick", "listed", "absent", "absent", "listed"])

    def test_the_counts_and_the_state_filters(self):
        s = self.sheet()
        self.assertEqual(s["counts"], {"all": 5, "pick": 1, "listed": 2, "absent": 2})
        self.assertEqual(s["orders"]["text"], {"all": [0, 1, 2, 3, 4], "pick": [0], "listed": [1, 4], "absent": [2, 3]})

    def test_the_default_sort_puts_the_widest_rival_lead_first(self):
        # gaps 0.9 (p2), 0.5 (p3, p4: tie -> 당사 share 0 both -> prompt text), 0 (p5), -0.4 (p1)
        s = self.sheet()
        self.assertEqual(s["orders"]["gap"]["all"], [1, 2, 3, 4, 0])
        self.assertEqual(s["orders"]["gap"]["absent"], [2, 3])

    def test_the_bar_draws_the_picked_brands_and_counts_the_candidates(self):
        s = self.sheet()
        p2 = s["rows"][1]
        self.assertEqual([e["brand"] for e in p2["entries"]], ["Toyota"])
        self.assertEqual((p2["candidates"], p2["picked"], p2["none"], p2["hatch"]), (3, 9, 1, True))
        self.assertEqual(s["present"], ["Hyundai", "Toyota", "Tesla"])
        self.assertEqual(s["rows"][3]["pivot"], [0, 10, 0])
        self.assertIsNone(s["rows"][4]["top"])


def sheet(country, engine, pick, listed, absent):
    return {"country": country, "engine": engine, "row_count": pick + listed + absent, "rows": [],
            "states": {"pick": pick, "listed": listed, "absent": absent}}


class Conversion(unittest.TestCase):
    """2026-10-29 후보 → 선택 전환 (the user's picks: 후보 탈락 count first, its share shown too): per country the prompt
    rows by 당사's state, every engine summed or one, from the reader's per-sheet counts."""

    def view(self):
        body = acr_body(territory=[sheet("US", "chatgpt", 1, 5, 1), sheet("US", "gemini", 0, 2, 0), sheet("KR", "chatgpt", 6, 2, 0),
                                   sheet("SA", "gemini", 1, 7, 1), sheet(None, "chatgpt", 0, 1, 0)])["data"]
        return acr.renewal_view(acr.to_standard_acr(body, {}), None, True, False)["conversion"]

    def test_every_engine_summed_per_country(self):
        v = self.view()
        self.assertEqual(v["engines"], ["all", "chatgpt", "gemini"])
        us = next(r for r in v["views"]["all"]["rows"] if r["region"] == "US")
        self.assertEqual((us["n"], us["counts"]), (9, {"pick": 1, "listed": 7, "absent": 1}))
        self.assertEqual(us["shares"], {"pick": 11.1, "listed": 77.8, "absent": 11.1})
        self.assertEqual((v["views"]["all"]["n"], v["views"]["all"]["counts"]), (27, {"pick": 8, "listed": 17, "absent": 2}))

    def test_the_most_listed_first_or_the_largest_share(self):
        a = self.view()["views"]["all"]
        regions = lambda order: [a["rows"][i]["region"] for i in a["orders"][order]]
        # listed: SA 7 (77.8 %), US 7 (77.8 %) — tie on count and share, then the code — KR 2, none 1
        self.assertEqual(regions("listed"), ["SA", "US", "KR", None])
        self.assertEqual(regions("share"), [None, "SA", "US", "KR"])

    def test_a_row_opens_the_sheet_with_the_most_listed(self):
        v = self.view()
        self.assertEqual(next(r["sheet"] for r in v["views"]["all"]["rows"] if r["region"] == "US"), "US|chatgpt")
        self.assertEqual([(r["region"], r["sheet"]) for r in v["views"]["gemini"]["rows"]], [("US", "US|gemini"), ("SA", "SA|gemini")])


class Duels(unittest.TestCase):
    """2026-10-29 결선 맞대결: the reader's per-engine rows summed per rival, the rivals met most."""

    def view(self, rows, own=None):
        body = acr_body(head_to_head={"sample": {"iterations": 40, "cells": 39}, "rows": rows})["data"]
        std = acr.to_standard_acr(body, {})
        if own:
            std["ownBrands"] = own
        return acr.renewal_view(std, None, True, False)["duels"]

    def test_summed_over_engines_with_its_sample(self):
        d = self.view([{"engine": "chatgpt", "brand": "Toyota", "iterations": 7, "own_wins": 1, "rival_wins": 4},
                       {"engine": "gemini", "brand": "Toyota", "iterations": 5, "own_wins": 1, "rival_wins": 1}])
        toyota = d["views"]["all"][0]
        self.assertEqual((toyota["n"], toyota["counts"], toyota["lead"]), (12, {"own": 2, "rival": 5, "rest": 5}, "rival"))
        self.assertEqual(toyota["shares"], {"own": 16.7, "rival": 41.7, "rest": 41.7})
        # one scale per view: the largest share (Toyota's 5 of 12) fills its half
        self.assertEqual({k: round(v, 6) for k, v in toyota["bars"].items()}, {"own": 40.0, "rival": 100.0})
        self.assertEqual([r["n"] for r in d["views"]["gemini"]], [5])
        self.assertEqual(d["sample"], {"iterations": 40, "cells": 39})

    def test_the_twelve_rivals_met_most_then_by_name(self):
        rows = [{"engine": "chatgpt", "brand": f"B{i:02d}", "iterations": 20 - i // 2, "own_wins": 0, "rival_wins": 0} for i in range(15)]
        names = [r["brand"] for r in self.view(rows)["views"]["all"]]
        self.assertEqual(names, [f"B{i:02d}" for i in range(12)])

    def test_an_hmg_rival_is_a_sibling(self):
        # Gold's HMG flag on the reader's row (2026-10-31 renewal audit 11-2; it was the name)
        d = self.view([{"engine": "chatgpt", "brand": "Hyundai", "iterations": 3, "own_wins": 1, "rival_wins": 1, "is_hmg": True}], own=["Kia"])
        self.assertEqual((d["views"]["all"][0]["sibling"], d["views"]["all"][0]["lead"]), (True, "even"))

    def test_none_without_the_read(self):
        self.assertIsNone(acr.renewal_view(acr.to_standard_acr(acr_body()["data"], {}), None, True, False)["duels"])


class CrossRoundCompared(unittest.TestCase):
    """2026-10-29 the user's decision: the ACR pages compare and sum rounds whatever each round measured; a change of
    measurement method or of the measured scope is the reader's to take, not a reason to hide a value."""

    def body(self, query="", **over):
        get, _ = fake_api(acr_body(**over))
        with mock.patch("bff.api.get", get):
            return run(acr.renewal(QueryParams(query)))["body"]

    def screen(self, builder, query):
        get, _ = fake_api(acr_body())
        with mock.patch("bff.api.get", get):
            return run(builder(QueryParams(query)))["view"]

    def test_a_snapshot_shows_the_trend_and_the_delta(self):
        v = self.body()["view"]
        self.assertTrue(v["showDelta"])
        self.assertEqual(v["dates"], ["2026-09-03", "2026-09-10"])
        self.assertEqual([(x["trend"], x["d"]) for x in v["brands"]], [([6.3, 33.3], 27.1), ([None, 66.7], None)])
        self.assertIn("mover", [f["kind"] for f in v["findings"]])

    def test_a_period_of_several_rounds_is_summed(self):
        b = self.body("time=2026-09-01..2026-09-30")
        self.assertEqual(b["view"]["dates"], ["2026-09-03", "2026-09-10"])
        self.assertFalse(b["view"]["showDelta"])

    def test_the_standard_and_website_project_pages_show_the_trend(self):
        for builder in (acr.standard, acr.gold):
            for query in ("", "time=2026-09-01..2026-09-30"):
                v = self.screen(builder, query)
                self.assertEqual([r["date"] for r in v["trendRows"]], ["2026-09-03", "2026-09-10"])
                self.assertTrue(v["brands"])


def rival(brand, choice, cells, *, iterations=100, runs=10, hmg=False):
    return {"brand": brand, "is_ours": False, "is_hmg": hmg, "choice": choice, "appearance": cells, "cells": cells,
            "choice_share": {"num": choice, "den": iterations}, "coverage": {"num": cells, "den": runs}}


def ours(brand, choice, cells, *, iterations=100, runs=10):
    return {**rival(brand, choice, cells, iterations=iterations, runs=runs, hmg=True), "is_ours": True}


def own_total(choice, cells, brands, rank=2, of=2, *, iterations=100, runs=10):
    return {"choice": choice, "appearance": cells, "cells": cells, "choice_share": {"num": choice, "den": iterations},
            "coverage": {"num": cells, "den": runs}, "brands": brands, "rank": rank, "ranked_brands": of}


def battle(*rows):
    """(prompt, {engine: (winner, ours)}) rows."""
    return [{"prompt_id": p, "prompt_text": p, "cells": [{"engine": e, "winner_brand": w, "winner_is_ours": o, "choice": 1}
                                                         for e, (w, o) in cells.items()]} for p, cells in rows]


def round_trend(brands_by_round, own_by_round=None, den=1000):
    """Two (or more) rounds: {brand: num} per round over `den` repetitions."""
    days = ["2026-09-28", "2026-10-05", "2026-10-12"]
    return {"series_brands": list(brands_by_round[0]), "buckets": [
        {"round_date": days[i], "gap": False, "den": den, "own": (own_by_round or [0] * len(brands_by_round))[i],
         "series": [{"brand": b, "num": n} for b, n in r.items()]} for i, r in enumerate(brands_by_round)]}


def findings_of(**over) -> list[dict]:
    over.setdefault("territory", [])
    over.setdefault("model_conversion", [])
    over.setdefault("trend", {"series_brands": [], "buckets": []})
    std = acr.to_standard_acr(acr_body(**over)["data"], {})
    return acr.renewal_view(std, std.get("own"), True, False)["findings"]


class FindingsInOneOrder(unittest.TestCase):
    """2026-10-31 renewal audit 11-1 (W6's rule for Mention, Citation and Conversion): the summary findings take one
    fixed order, 당사 first and the brand that moved most last; no threshold or HUB priority decides which show, and
    the colour follows 당사's direction only (a competitor's fact is info)."""

    ALL = dict(
        totals={"prompt_runs": 10, "prompts": 6, "iterations": 100, "engines": ["chatgpt", "gemini"], "catalog_acr_prompts": 6},
        brands=[rival("Toyota", 30, 6), ours("Hyundai", 20, 6)],
        own=own_total(20, 6, ["Hyundai"]),
        battle=battle(("p1", {"chatgpt": ("Hyundai", True), "gemini": ("Toyota", False)}),
                      ("p2", {"chatgpt": ("Hyundai", True), "gemini": ("Toyota", False)}),
                      ("p3", {"chatgpt": ("Hyundai", True), "gemini": ("Toyota", False)}),
                      ("p4", {"chatgpt": ("Toyota", False), "gemini": ("Toyota", False)}),
                      ("p5", {"chatgpt": ("Toyota", False), "gemini": ("Toyota", False)}),
                      ("p6", {"chatgpt": ("Toyota", False), "gemini": ("Toyota", False)})),
        model_conversion=[{"brand": "Hyundai", "model": "Tucson", "is_ours": True, "is_hmg": True, "conversion": {"num": 1, "den": 2}, "cells": 2, "top1": 1},
                          {"brand": "Hyundai", "model": "Kona", "is_ours": True, "is_hmg": True, "conversion": {"num": 1, "den": 5}, "cells": 5, "top1": 1}],
        trend=round_trend([{"Toyota": 200, "Hyundai": 200}, {"Toyota": 300, "Hyundai": 200}], [200, 200]),
        territory=[{"country": "US", "engine": "chatgpt", "row_count": 3, "rows": [
            {"prompt_id": p, "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [{"brand": "Toyota", "choice": 3, "appearance": 3, "is_ours": False}]}
            for p in ("p4", "p5", "p6")]}],
    )

    def test_the_first_four_in_the_fixed_order(self):
        # every finding has a value here (and passed the old cut-offs); the old priorities put the sweep before the engine
        self.assertEqual([f["kind"] for f in findings_of(**self.ALL)], ["standing", "leak", "engine", "sweep"])

    def test_no_cut_off_keeps_an_engine_gap_of_one_or_a_single_sweep(self):
        # no 당사 total or brand row: no standing and no leak; 당사 tops one prompt on chatgpt and none on gemini, and
        # Toyota tops one prompt on both (the old rule needed a gap of 3 and three sweeps)
        f = findings_of(own=None, brands=[rival("Toyota", 30, 6)],
                        battle=battle(("p1", {"chatgpt": ("Hyundai", True), "gemini": ("Toyota", False)}),
                                      ("p2", {"chatgpt": ("Toyota", False), "gemini": ("Toyota", False)})))
        self.assertEqual([(x["kind"], x["tone"]) for x in f], [("engine", "info"), ("sweep", "info")])
        self.assertEqual((f[0]["params"]["engine"], f[0]["params"]["diff"], f[1]["params"]["count"]), ("gemini", 1, 1))

    def test_an_engine_gap_of_none_is_told_as_such(self):
        f = findings_of(own=None, brands=[rival("Toyota", 30, 6)],
                        battle=battle(("p1", {"chatgpt": ("Hyundai", True), "gemini": ("Hyundai", True)})))
        self.assertEqual([(x["kind"], x["params"]["diff"]) for x in f], [("engine", 0)])

    def test_one_prompt_never_picking_us_and_a_small_move_are_facts(self):
        # one engine (no engine finding, no sweep); the old rule needed three such prompts and a move of 0.5pp
        f = findings_of(own=None, brands=[rival("Toyota", 30, 6)],
                        totals={"prompt_runs": 10, "prompts": 2, "iterations": 100, "engines": ["chatgpt"], "catalog_acr_prompts": 2},
                        battle=[],
                        trend=round_trend([{"Toyota": 300}, {"Toyota": 302}]),
                        territory=[{"country": "US", "engine": "chatgpt", "row_count": 2, "rows": [
                            {"prompt_id": "p1", "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [{"brand": "Toyota", "choice": 3, "appearance": 3, "is_ours": False}]},
                            {"prompt_id": "p2", "prompt_text": None, "valid_acr": 10, "cells": 1, "entries": [{"brand": "Hyundai", "choice": 2, "appearance": 2, "is_ours": True}]}]}])
        self.assertEqual([(x["kind"], x["tone"]) for x in f], [("dist", "info"), ("mover", "info")])
        self.assertEqual((f[0]["params"]["zero"], f[0]["params"]["rows"], f[1]["params"]["d"]), (1, 2, 0.2))

    def test_a_move_shown_as_zero_is_none(self):
        f = findings_of(own=None, brands=[rival("Toyota", 30, 6)], battle=[],
                        totals={"prompt_runs": 10, "prompts": 2, "iterations": 100, "engines": ["chatgpt"], "catalog_acr_prompts": 2},
                        trend={"series_brands": ["Toyota"], "buckets": [
                            {"round_date": "2026-09-28", "gap": False, "den": 1000, "own": 0, "series": [{"brand": "Toyota", "num": 300}]},
                            {"round_date": "2026-10-05", "gap": False, "den": 1003, "own": 0, "series": [{"brand": "Toyota", "num": 301}]}]})
        self.assertEqual(f, [])

    def test_a_competitors_move_is_info_and_ours_follows_its_direction(self):
        base = dict(own=None, battle=[], totals={"prompt_runs": 10, "prompts": 2, "iterations": 100, "engines": ["chatgpt"], "catalog_acr_prompts": 2})
        up = findings_of(brands=[rival("Toyota", 30, 6)], trend=round_trend([{"Toyota": 200}, {"Toyota": 300}]), **base)
        self.assertEqual([(x["kind"], x["tone"]) for x in up], [("mover", "info")])
        down = findings_of(brands=[ours("Hyundai", 20, 6)], trend=round_trend([{"Hyundai": 300}, {"Hyundai": 200}]), **base)
        self.assertEqual([(x["kind"], x["tone"], x["params"]["d"]) for x in down], [("mover", "warn", -10.0)])


class LeakIsTheClosestShortlistRival(unittest.TestCase):
    """11-1: '후보군이 비슷한' was a cut-off (6pp apart, then −0.5pp); the finding now names the rival whose 후보군 포함율 is
    closest to an own brand's and their Top1 ACR difference, the smallest of the own brands (a gap shown as 0.0 is the
    same)."""

    def leak(self, brands):
        f = findings_of(brands=brands, own=own_total(20, 5, [b["brand"] for b in brands if b["is_ours"]]), battle=[],
                        totals={"prompt_runs": 10, "prompts": 2, "iterations": 100, "engines": ["chatgpt"], "catalog_acr_prompts": 2})
        return next(x for x in f if x["kind"] == "leak")

    def test_a_rival_ten_points_apart_is_still_the_closest(self):
        f = self.leak([rival("Toyota", 30, 6), ours("Hyundai", 20, 5), rival("BMW", 5, 2)])
        self.assertEqual((f["tone"], f["brand"]), ("warn", "Toyota"))
        self.assertEqual(f["params"], {"own": "Hyundai", "rival": "Toyota", "gap": 10.0, "dir": "less", "ownCov": 50.0,
                                       "rivalCov": 60.0, "ownTop1": 20.0, "rivalTop1": 30.0})

    def test_the_same_top1_and_a_lead_are_facts_too(self):
        same = self.leak([rival("Toyota", 30, 6), ours("Hyundai", 30, 5)])
        self.assertEqual((same["tone"], same["params"]["dir"], same["params"]["gap"]), ("info", "same", 0))
        lead = self.leak([ours("Hyundai", 35, 5), rival("Toyota", 30, 6)])
        self.assertEqual((lead["tone"], lead["params"]["dir"], lead["params"]["gap"]), ("good", "more", 5.0))

    def test_the_own_brand_with_the_smallest_difference(self):
        # Hyundai's closest rival is Toyota (−10pp), Kia's is BMW (+5pp)
        f = self.leak([rival("Toyota", 30, 6), ours("Hyundai", 20, 5), ours("Kia", 10, 2), rival("BMW", 5, 2)])
        self.assertEqual((f["params"]["own"], f["params"]["rival"], f["params"]["dir"]), ("Hyundai", "Toyota", "less"))


class HmgSiblingIsGolds(unittest.TestCase):
    """2026-10-31 renewal audit 11-2 · 11-3: the 'HMG 계열' badge reads Gold's flag the reader sends with each row (the
    flag its 당사 is judged by: the brand rows' registry acr_entity_fact.own_bit, the models' and the head-to-head's
    dim_brand.own_bit), not the names Hyundai · Kia · Genesis; a model is 당사 by Gold's isOurs alone."""

    def view(self, **over):
        std = acr.to_standard_acr(acr_body(**over)["data"], {})
        return acr.renewal_view(std, std.get("own"), True, False)

    def test_a_brand_row_is_a_sibling_by_its_flag(self):
        v = self.view(brands=[ours("Kia", 30, 6), rival("Genesis", 20, 5, hmg=False), rival("제네시스 마그마", 0, 1, hmg=True),
                              rival("Toyota", 10, 4)], own=own_total(30, 6, ["Kia"], rank=1, of=4))
        self.assertEqual({b["brand"]: (b["own"], b["sibling"]) for b in v["brands"]},
                         {"Kia": (True, False), "Genesis": (False, False), "제네시스 마그마": (False, True), "Toyota": (False, False)})

    def test_a_model_is_ours_by_gold_and_a_sibling_by_its_flag(self):
        v = self.view(brands=[ours("Kia", 30, 6)], own=own_total(30, 6, ["Kia"], rank=1, of=1), model_conversion=[
            {"brand": "Kia", "model": "EV9", "is_ours": False, "is_hmg": False, "conversion": {"num": 1, "den": 2}, "cells": 1, "top1": 1},
            {"brand": "Hyundai", "model": "Tucson", "is_ours": False, "is_hmg": False, "conversion": {"num": 1, "den": 3}, "cells": 1, "top1": 1},
            {"brand": "Hyundai Canada", "model": "Kona", "is_ours": False, "is_hmg": True, "conversion": {"num": 1, "den": 4}, "cells": 1, "top1": 1},
            {"brand": "Genesis", "model": "GV70", "is_ours": True, "is_hmg": True, "conversion": {"num": 1, "den": 5}, "cells": 1, "top1": 1}])
        self.assertEqual([(m["model"], m["own"], m["sibling"]) for m in v["models"]["rows"]],
                         [("EV9", False, False), ("Tucson", False, False), ("Kona", False, True), ("GV70", True, False)])

    def test_a_rival_met_in_the_duels_is_a_sibling_by_its_flag(self):
        v = self.view(head_to_head={"sample": {"iterations": 9, "cells": 9}, "rows": [
            {"engine": "chatgpt", "brand": "Hyundai Canada", "iterations": 3, "own_wins": 1, "rival_wins": 1, "is_hmg": True},
            {"engine": "chatgpt", "brand": "Genesis", "iterations": 2, "own_wins": 1, "rival_wins": 1, "is_hmg": False}]})
        self.assertEqual({r["brand"]: r["sibling"] for r in v["duels"]["views"]["all"]}, {"Hyundai Canada": True, "Genesis": False})


class BoardSorts(unittest.TestCase):
    """2026-10-31 renewal audit 11-4: the original brand table's sorts the renewal board lacked — the name (ascending,
    ko collation), the final picks and the mentions (descending, ties by rank)."""

    def test_name_picks_and_mentions(self):
        brands = [rival("Toyota", 30, 4), ours("현대", 20, 6), rival("BMW", 20, 2), rival("Audi", 5, 6)]
        std = acr.to_standard_acr(acr_body(brands=brands, own=own_total(20, 6, ["현대"]))["data"], {})
        orders = acr.renewal_view(std, std["own"], True, False)["boardOrders"]
        self.assertEqual(orders["brand"], [1, 3, 2, 0])  # 현대, Audi, BMW, Toyota (ko: Hangul first)
        self.assertEqual(orders["choiceCount"], [0, 1, 2, 3])
        self.assertEqual(orders["appearanceCount"], [1, 3, 0, 2])


FRONT_FIXTURE = Path(__file__).parents[3] / "front/app/[locale]/(renewal)/renewal/standard/ai-funnel/acr/_components/acr-body.fixture.json"
FIXTURE_OWN = {"choice": 7, "appearance": 11, "cells": 3, "choice_share": {"num": 7, "den": 20}, "coverage": {"num": 3, "den": 8},
               "brands": ["Hyundai"], "rank": 1, "ranked_brands": 2}


FIXTURE_DUELS = {"sample": {"iterations": 8, "cells": 8}, "rows": [
    {"engine": "chatgpt", "brand": "Toyota", "iterations": 6, "own_wins": 1, "rival_wins": 3, "is_hmg": False},
    {"engine": "gemini", "brand": "Toyota", "iterations": 2, "own_wins": 1, "rival_wins": 0, "is_hmg": False}]}


def front_fixture() -> dict:
    """acr/renewal bodies for the page's render test: a snapshot and a period of two rounds."""
    get, _ = fake_api(acr_body(own=FIXTURE_OWN, head_to_head=FIXTURE_DUELS))
    out = {}
    with mock.patch("bff.api.get", get):
        out["snapshot"] = run(acr.renewal(QueryParams("")))["body"]
        out["period"] = run(acr.renewal(QueryParams("time=2026-09-01..2026-09-30")))["body"]
    return json.loads(json.dumps(out))


class FrontFixture(unittest.TestCase):
    """The page's render test draws this screen's own output; regenerate the fixture when the model changes."""

    @unittest.skipUnless(FRONT_FIXTURE.exists(), "front checkout not present (BFF image)")
    def test_front_fixture_is_current(self):
        self.assertEqual(json.loads(FRONT_FIXTURE.read_text(encoding="utf-8")), front_fixture())


if __name__ == "__main__":
    unittest.main()
