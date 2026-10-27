"""/website/prompts screens: the derivation the page and the export share (was readWebsitePromptQuery
+ websitePromptQuery in the front), the keyset page and its labels."""
import asyncio
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from bff.screens import website_prompts as wp
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_website_prompts)") from exc


def run(coro):
    return asyncio.run(coro)


def body(n=50, total=120, next_cursor="50"):
    row = {"website_prompt_id": "w", "prompt_text": "p", "brand_code": "Kia", "country_code": "DE", "lang_code": "de",
           "target_url": "u", "domain": "d", "answers": 1, "last_measured": None, "engines": ["chatgpt"]}
    return {"data": {"items": [dict(row) for _ in range(n)] + [{"prompt_id": "global-row"}]},
            "meta": {"page": {"total": total, "next_cursor": next_cursor}}}


class Export(unittest.TestCase):
    def export_params(self, qs):
        get = mock.AsyncMock(return_value={"data": {"items": []}, "meta": {}})
        with mock.patch("bff.api.get", get):
            run(wp.prompts_export(QueryParams(qs)))
        path, params = get.call_args.args
        self.assertEqual(path, "prompts")
        return params

    def test_admin_filters_sort_search_and_file_columns(self):
        p = self.export_params("geography=US&geography=DE&engine=GEMINI&q=%20ev%20&sort=prompt&dir=asc&page=3&cursor=abc"
                               "&ctx.locale=en&ctx.admin=true")
        self.assertEqual(p["country"], ["DE", "US"])
        self.assertEqual(p["engine"], ["gemini"])
        self.assertEqual((p["search"], p["sort"], p["dir"]), ("ev", "prompt", "asc"))
        self.assertEqual((p["surface"], p["format"], p["columns"], p["locale"]), ("website", "xlsx", "screen", "en"))
        self.assertTrue({"cursor", "page", "limit"}.isdisjoint(p))

    def test_bad_sort_falls_back_and_blank_search_is_not_sent(self):
        p = self.export_params("sort=nope&dir=up&q=%20%20")
        self.assertEqual((p["sort"], p["dir"]), ("last_measured", "desc"))
        self.assertNotIn("search", p)

    def test_brand_axis_is_admin_only(self):
        self.assertNotIn("brand", self.export_params("brand=Hyundai"))
        self.assertEqual(self.export_params("brand=Hyundai&ctx.admin=true")["brand"], ["Hyundai"])

    def test_separator_and_repeated_keys_give_the_same_query(self):
        self.assertEqual(self.export_params("geography=US~DE")["country"], self.export_params("geography=US&geography=DE")["country"])


class ListPage(unittest.TestCase):
    def test_first_page_labels_and_global_rows_dropped(self):
        with mock.patch("bff.api.get", mock.AsyncMock(return_value=body())):
            vm = run(wp.prompts_list(QueryParams("")))
        self.assertEqual(len(vm["rows"]), 50)
        self.assertEqual((vm["page"], vm["pages"], vm["rangeFrom"], vm["rangeTo"], vm["nextPage"]), (1, 3, 1, 50, 2))
        self.assertEqual(vm["cursorPaging"], {"nextCursor": "50"})

    def test_page_label_only_with_a_cursor(self):
        with mock.patch("bff.api.get", mock.AsyncMock(return_value=body(n=20, next_cursor=None))):
            vm = run(wp.prompts_list(QueryParams("cursor=100&page=3")))
            no_cursor = run(wp.prompts_list(QueryParams("page=3")))
        self.assertEqual((vm["page"], vm["rangeFrom"], vm["rangeTo"], vm["cursorPaging"]), (3, 101, 120, {"nextCursor": None}))
        self.assertEqual(no_cursor["page"], 1)

    def test_page_parsing_like_number_parse_int(self):
        for raw, page in (("2abc", 2), (" 4", 4), ("-1", 1), ("x", 1), ("3.9", 3)):
            self.assertEqual(wp.read_query({"page": raw}, wp.READER_SCOPE, False)["page"], page, raw)

    def test_a_cursor_error_is_not_retried_with_gold_codes(self):
        # Gold answers 409/422 with code invalid_value, never cursor_stale/cursor_invalid: no restart.
        with mock.patch("bff.api.get", mock.AsyncMock(side_effect=HTTPException(422, "bad cursor"))):
            with self.assertRaises(HTTPException):
                run(wp.prompts_list(QueryParams("cursor=abc")))

    def test_total_falls_back_to_rows(self):
        res = body(n=3, total=None, next_cursor="")
        with mock.patch("bff.api.get", mock.AsyncMock(return_value=res)):
            vm = run(wp.prompts_list(QueryParams("")))
        self.assertEqual((vm["total"], vm["pages"], vm["cursorPaging"]), (3, 1, {"nextCursor": None}))


class Options(unittest.TestCase):
    def test_list_key_covers_filters_and_paging_params(self):
        key = wp.suspense_key({"q": "ev", "sort": "brand", "page": "2"}, wp.READER_SCOPE, False)
        self.assertTrue(key.endswith("|ev|brand||2|"))
        self.assertNotEqual(key, wp.suspense_key({"q": "ev"}, wp.READER_SCOPE, False))


if __name__ == "__main__":
    unittest.main()
