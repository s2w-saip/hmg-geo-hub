"""Shared filter + query layer: what the golden cases cannot record (errors, None returns,
the flattened api.get params, the screens' own validation). The ports themselves are proven by
the golden cases in golden/shared (front/test/bff-golden/shared.golden.test.ts)."""
import unittest
from datetime import datetime
from unittest import mock
from zoneinfo import ZoneInfo

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from bff import access
    from bff.api import query
    from bff.screens import build
    from bff.screens._filters import (
        load_project_gate, read_standard_filters, search_params, to_catalog_rows, to_panel_options,
    )
    from bff.screens._query import (
        HghQueryError, READER_SCOPE, analysis_query, common_query, js_trim, resolve_date_range, to_api_params,
        today_kst, with_params,
    )
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_shared)") from exc

PID = "0f8fad5b-d9cb-469f-a165-70867728950e"
FIELD = "7c9e6679-7425-40de-944b-e07fc1f90ae7"


class QueryErrors(unittest.TestCase):
    """HghQueryError cases (lib/hgh/query.test.ts), which the function goldens skip."""

    def test_project_needs_project_id(self):
        with self.assertRaises(HghQueryError) as cm:
            common_query({}, {"surface": "project", "scope": READER_SCOPE})
        self.assertEqual(cm.exception.code, "project_id_required")
        with self.assertRaises(HghQueryError):
            analysis_query({}, {"surface": "project", "projectId": "", "scope": READER_SCOPE})

    def test_one_sided_range_without_bounds(self):
        with self.assertRaises(HghQueryError) as cm:
            common_query({"dateFrom": "2026-09-01"}, {"surface": "global", "scope": READER_SCOPE, "today": "2026-09-28"})
        self.assertEqual(cm.exception.code, "open_ended_range_needs_bounds")
        # an invalid other end makes the range one-sided for resolve_date_range only (TS throws too)
        with self.assertRaises(HghQueryError):
            common_query({"dateFrom": "bad", "dateTo": "2026-09-01"}, {"surface": "global", "scope": None, "today": "2026-09-28"})
        # analysis_query passes a one-sided period through instead
        self.assertEqual(analysis_query({"dateFrom": "2026-09-01"}, {"surface": "global", "scope": None})["query"],
                         {"surface": "global", "from": "2026-09-01"})
        # empty bounds are bounds (TS: `!bounds` is false for {})
        self.assertEqual(resolve_date_range({"dateFrom": "2026-09-01"}, {}, "2026-09-28"), {"from": "2026-09-01", "to": "2026-09-28"})

    def test_with_params_refuses_common_keys(self):
        base = common_query({"engine": ["chatgpt"]}, {"surface": "global", "scope": READER_SCOPE})["query"]
        self.assertEqual(with_params(base, {"cycle_offset": 1, "cursor": None}),
                         {"surface": "global", "engine": ["chatgpt"], "cycle_offset": 1, "cursor": None})
        for key in ("country", "surface", "from", f"cf.{FIELD}"):
            with self.assertRaises(HghQueryError) as cm:
                with_params(base, {key: "x"})
            self.assertEqual(cm.exception.code, "common_key_override")
        self.assertEqual(base, {"surface": "global", "engine": ["chatgpt"]})


class ApiParams(unittest.TestCase):
    """{query, cf} -> api.get params serialize like lib/hgh/query serializeQuery."""

    def test_project_query_with_custom_fields(self):
        params = common_query({"engine": ["gemini", "chatgpt"], "dateFrom": "2026-09-01", "dateTo": "2026-09-10"},
                              {"surface": "project", "projectId": PID, "scope": READER_SCOPE,
                               "customFields": {FIELD.upper(): ["b", "a"], "not-a-uuid": ["x"]}})
        self.assertEqual(params["cf"], {FIELD: ["a", "b"]})
        flat = to_api_params(params, {"parts": ["gap", "measured", "urls"]})
        self.assertEqual(str(query(flat)),
                         f"cf.{FIELD}=a&cf.{FIELD}=b&engine=chatgpt&engine=gemini&from=2026-09-01&parts=gap&parts=measured"
                         f"&parts=urls&project_id={PID}&surface=project&to=2026-09-10")

    def test_global_query_string(self):
        f = read_standard_filters({"geography": "US~GB", "engine": "b~a"}, READER_SCOPE)
        self.assertEqual(str(query(to_api_params(common_query(f, {"surface": "global", "scope": READER_SCOPE})))),
                         "country=GB&country=US&engine=a&engine=b&surface=global")

    def test_invalid_custom_field_id_is_refused(self):
        with self.assertRaises(HghQueryError) as cm:
            to_api_params({"query": {"surface": "project"}, "cf": {"../x": ["a"]}})
        self.assertEqual(cm.exception.code, "invalid_custom_field")


class Readers(unittest.TestCase):
    def test_search_params_like_next(self):
        sp = search_params(QueryParams("brand=Kia&brand=Hyundai&time=2026-09-01..&x="))
        self.assertEqual(sp, {"brand": ["Kia", "Hyundai"], "time": "2026-09-01..", "x": ""})
        self.assertEqual(read_standard_filters(sp, READER_SCOPE), {"dateFrom": "2026-09-01", "brand": ["Kia", "Hyundai"]})

    def test_js_trim_is_not_python_strip(self):
        self.assertEqual(js_trim("﻿ a 　"), "a")
        self.assertEqual(js_trim("\x1ca\x85"), "\x1ca\x85")

    def test_today_kst(self):
        self.assertEqual(today_kst("2026-09-18T15:00:00.000Z"), "2026-09-19")
        self.assertEqual(today_kst("2026-09-18T14:59:59.999Z"), "2026-09-18")
        self.assertIn(today_kst(), {datetime.now(ZoneInfo("Asia/Seoul")).date().isoformat()})

    def test_undefined_results(self):
        self.assertIsNone(to_catalog_rows(None))
        out = to_panel_options({"data": {"geo_matrix": [], "catalog": None, "engines": [], "custom_fields": None}},
                               {"surface": "global", "scope": READER_SCOPE, "filters": {}})
        self.assertEqual(out, {"geographyOptions": [], "languageOptions": [], "optionMatrix": []})  # no catalogRows key


class Gate(unittest.IsolatedAsyncioTestCase):
    async def test_other_errors_are_raised(self):
        async def fail(path, params=None):
            raise HTTPException(503, "down")
        with mock.patch("bff.api.get", fail):
            with self.assertRaises(HTTPException):
                await load_project_gate(PID)

    async def test_non_uuid_reads_nothing(self):
        async def never(path, params=None):
            raise AssertionError("read")
        with mock.patch("bff.api.get", never):
            self.assertIsNone(await load_project_gate("new"))
            self.assertEqual(await build("shared/project-gate", QueryParams("")), {"project": None, "locks": [], "lockedGroups": []})


class PanelScreen(unittest.IsolatedAsyncioTestCase):
    async def test_validation(self):
        for qs in ("surface=nope", "surface=project"):
            with self.assertRaises(HTTPException) as cm:
                await build("shared/panel-options", QueryParams(qs))
            self.assertEqual(cm.exception.status_code, 422)

    async def test_global_never_sends_project_id_or_value_axes(self):
        seen = []

        async def get(path, params=None):
            seen.append((path, str(query(params))))
            return {"data": {"geo_matrix": [], "catalog": None, "engines": [], "custom_fields": None}, "meta": {}}
        with mock.patch("bff.api.get", get):
            await build("shared/panel-options", QueryParams(f"surface=global&project_id={PID}&brand=Kia&engine=x&time=2026-09-01..2026-09-14"))
        self.assertEqual(seen, [("filters/options", "from=2026-09-01&surface=global&to=2026-09-14")])


ME = {"all": False, "brands": ["Genesis"], "regions": ["genesis-middle-east"], "countries": []}
OPTIONS = {"data": {
    "geo_matrix": [{"brand": "Genesis", "region": r, "lang": lang} for r, lang in
                   (("AE", "ar"), ("AE", "en"), ("DE", "de"), ("MIDDLEEAST", "en"), ("SA-Dammam", "ar"), ("US", "en"), ("worldwide", "en"))],
    "regions": [{"code": c, "area": None, "kind": "iso" if len(c) == 2 else "pseudo"}
                for c in ("AE", "DE", "MIDDLEEAST", "SA-Dammam", "US", "worldwide")],
    "languages": ["ar", "de", "en"], "engines": [], "catalog": None, "custom_fields": None}, "meta": {}}


class ScopedOptions(unittest.IsolatedAsyncioTestCase):
    """2026-10-31 (renewal audit step 2): the panel offers the countries the account can read, as the original API's
    options did (its scope intersection: brand, scope countries, region expansion). The Gold options read takes the
    clamp's brand but not its countries (the reader never narrows options by the dimension axes)."""

    async def screen(self, path, qs, scope):
        async def get(p, params=None):
            return OPTIONS if p == "filters/options" else {"data": {"dates": []}, "meta": {}}
        with mock.patch("bff.api.get", get), access.scoped(scope):
            return await build(path, QueryParams(qs))

    async def test_website_panel_offers_the_accounts_sites(self):
        out = await self.screen("shared/panel-options", "surface=website", ME)
        self.assertEqual(out["geographyOptions"], ["AE", "SA-Dammam"])            # city site of SA, no site hub
        self.assertEqual(out["languageOptions"], ["ar", "en"])
        self.assertEqual({r["region"] for r in out["optionMatrix"]}, {"AE", "SA-Dammam"})
        out = await self.screen("website/prompts-options", "", ME)
        self.assertEqual((out["geographyOptions"], out["languageOptions"]), (["AE", "SA-Dammam"], ["ar", "en"]))

    async def test_global_panel_offers_the_accounts_countries(self):
        out = await self.screen("shared/panel-options", "surface=global", ME)
        self.assertEqual(out["geographyOptions"], ["AE"])
        self.assertEqual({r["region"] for r in out["optionMatrix"]}, {"AE"})

    async def test_every_country_for_the_administrator_and_an_hq_account(self):
        every = ["AE", "DE", "MIDDLEEAST", "SA-Dammam", "US", "worldwide"]
        self.assertEqual((await self.screen("shared/panel-options", "surface=website", READER_SCOPE))["geographyOptions"], every)
        hq = {"all": False, "brands": ["Genesis"], "regions": [], "countries": []}
        self.assertEqual((await self.screen("shared/panel-options", "surface=website", hq))["geographyOptions"], every)

    def test_a_city_site_pick_stays_inside_the_scope(self):
        self.assertEqual(read_standard_filters({"geography": "SA-Dammam"}, ME, None, "website")["region"], ["SA-Dammam"])
        self.assertEqual(read_standard_filters({"geography": "SA-Dammam"}, ME)["region"],
                         ["BH", "KW", "OM", "QA", "SA", "AE", "IL"])               # global: not a country of the scope
        self.assertEqual(read_standard_filters({"geography": "worldwide"}, ME, None, "website")["region"],
                         ["BH", "KW", "OM", "QA", "SA", "AE", "IL"])               # the default stays the scope's


if __name__ == "__main__":
    unittest.main()
