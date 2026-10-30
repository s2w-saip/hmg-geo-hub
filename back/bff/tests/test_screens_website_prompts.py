"""/website/prompts screens: the derivation the page and the export share (was readWebsitePromptQuery
+ websitePromptQuery in the front), the keyset page and its labels; the renewal page's numbered page and
export rows; the Gold reader's website list (search, the engine/period lens, the order)."""
import asyncio
import unittest
from datetime import date
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from bff.gold_reader import catalog
    from bff.gold_reader.context import Context
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
            self.assertEqual(wp.read_query({"page": raw}, wp.reader_scope(), False)["page"], page, raw)

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
        key = wp.suspense_key({"q": "ev", "sort": "brand", "page": "2"}, wp.reader_scope(), False)
        self.assertTrue(key.endswith("|ev|brand||2|"))
        self.assertNotEqual(key, wp.suspense_key({"q": "ev"}, wp.reader_scope(), False))



def rows_body(n, start=0, next_cursor=None, over=None):
    rows = [{"website_prompt_id": f"w{i}", "prompt_text": f"p{i}", "brand_code": "Kia", "country_code": "DE", "lang_code": "de",
             "target_url": "u", "domain": "d", "answers": 1, "last_measured": None, "engines": ["chatgpt"],
             **((over or {}).get(i, {}))} for i in range(start, start + n)]
    return {"data": {"items": rows}, "meta": {"page": {"total": n, "next_cursor": next_cursor}}}


DATES = {"selectableDates": ["2026-09-25", "2026-10-02", "2026-10-09"]}


def patched(get):
    return mock.patch("bff.api.get", get), mock.patch.object(wp, "load_filter_dates", mock.AsyncMock(return_value=DATES))


class RenewalPage(unittest.TestCase):
    def page(self, qs, n=120, over=None):
        get = mock.AsyncMock(return_value=rows_body(n, over=over))
        a, b = patched(get)
        with a, b:
            vm = run(wp.prompts_page(QueryParams(qs)))
        return vm, get.call_args.args[1]

    def test_a_numbered_page_cut_from_the_whole_ordered_list(self):
        vm, params = self.page("page=2&size=25&sort=answers&dir=asc&q=ev")
        self.assertEqual([r["id"] for r in vm["rows"]], [f"w{i}" for i in range(25, 50)])
        self.assertEqual((vm["total"], vm["listed"], vm["page"], vm["pages"], vm["pageSize"], vm["rangeFrom"], vm["rangeTo"]), (120, 120, 2, 5, 25, 26, 50))
        self.assertEqual((params["sort"], params["dir"], params["search"], params["limit"]), ("answers", "asc", "ev", wp.READ_LIMIT))
        self.assertNotIn("cursor", params)
        self.assertEqual(vm["roundAxis"], DATES["selectableDates"])

    def test_a_page_past_the_end_shows_the_last_and_odd_sizes_fall_back(self):
        vm, _ = self.page("page=9&size=7")
        self.assertEqual((vm["pageSize"], vm["page"], vm["pages"], vm["rangeFrom"], vm["rangeTo"]), (50, 3, 3, 101, 120))
        empty, _ = self.page("page=4", n=0)
        self.assertEqual((empty["rows"], empty["page"], empty["pages"], empty["rangeFrom"], empty["rangeTo"]), ([], 1, 1, 0, 0))

    def test_the_list_picks_narrow_the_rows_not_the_read(self):
        over = {0: {"answers": 0, "engines": []}, 1: {"answers": 3, "engines": ["chatgpt", "gemini"], "rounds": ["2026-10-02", "2026-10-09"], "last_measured": "2026-10-09"},
                2: {"answers": 2, "engines": ["gemini"], "rounds": ["2026-10-02"], "last_measured": "2026-10-02"}}
        cases = {"m=0": ["w0"], "m=1": ["w1", "w2"], "rd=2026-10-09": ["w1"], "last=2026-10-02": ["w2"], "last=none": ["w0"],
                 "eset=gemini~CHATGPT": ["w1"], "eset=none": ["w0"], "ans=2": ["w2"], "m=1&rd=2026-10-02&eset=gemini": ["w2"],
                 "m=x&rd=yesterday&ans=-1": ["w0", "w1", "w2"]}
        for qs, ids in cases.items():
            vm, params = self.page(qs, n=3, over=over)
            self.assertEqual([r["id"] for r in vm["rows"]], ids, qs)
            self.assertEqual((vm["total"], vm["listed"]), (len(ids), 3), qs)
            self.assertTrue({"m", "rd", "last", "eset", "ans"}.isdisjoint(params), qs)

    def test_the_round_axis_keeps_the_period_and_every_measured_round(self):
        vm, _ = self.page("time=2026-10-01..2026-10-31", n=1, over={0: {"rounds": ["2026-10-02", "2026-07-03"]}})
        self.assertEqual(vm["roundAxis"], ["2026-07-03", "2026-10-02", "2026-10-09"])

    def test_rows_follow_the_reader_cursor_to_the_end(self):
        get = mock.AsyncMock(side_effect=[rows_body(2, next_cursor="2"), rows_body(1, start=2)])
        a, b = patched(get)
        with a, b:
            vm = run(wp.prompts_rows(QueryParams("geography=KR&m=1")))
        self.assertEqual([r["id"] for r in vm["rows"]], ["w0", "w1", "w2"])
        self.assertEqual(get.call_args_list[1].args[1]["cursor"], "2")
        self.assertEqual(get.call_args_list[0].args[1]["country"], ["KR"])


class Insights(unittest.TestCase):
    ROWS = [
        {"brand_code": "Kia", "country_code": "DE", "lang_code": "de", "domain": "kia.com", "answers": 5, "last_measured": "2026-10-09",
         "engines": ["chatgpt", "gemini"], "rounds": ["2026-10-02", "2026-10-09"], "engine_answers": {"chatgpt": 3, "gemini": 2}},
        {"brand_code": "Hyundai", "country_code": "DE", "lang_code": "de", "domain": "hyundai.com", "answers": 1, "last_measured": "2026-10-02",
         "engines": ["gemini"], "rounds": ["2026-10-02"], "engine_answers": {"gemini": 1}},
        {"brand_code": "Kia", "country_code": "KR", "lang_code": "ko", "domain": "kia.com", "answers": 0, "last_measured": None,
         "engines": [], "rounds": [], "engine_answers": {}},
    ]

    def insights(self, qs=""):
        items = [{"website_prompt_id": f"w{i}", "prompt_text": "p", "target_url": "u", **r} for i, r in enumerate(self.ROWS)]
        get = mock.AsyncMock(return_value={"data": {"items": items}, "meta": {"page": {"total": 3, "next_cursor": None}}})
        a, b = patched(get)
        with a, b:
            return run(wp.prompts_insights(QueryParams(qs)))

    def test_counts_of_the_listed_rows(self):
        v = self.insights()
        self.assertEqual((v["prompts"], v["measured"], v["answers"]), (3, 2, 6))
        self.assertEqual(v["engines"], [{"engine": "chatgpt", "prompts": 1, "answers": 3}, {"engine": "gemini", "prompts": 2, "answers": 3}])
        self.assertEqual(v["rounds"], [{"date": "2026-09-25", "prompts": 0}, {"date": "2026-10-02", "prompts": 2}, {"date": "2026-10-09", "prompts": 1}])
        self.assertEqual(v["lastMeasured"], [{"date": "2026-10-09", "prompts": 1}, {"date": "2026-10-02", "prompts": 1}, {"date": None, "prompts": 1}])
        self.assertEqual(v["depth"], [{"answers": 0, "prompts": 1}, {"answers": 1, "prompts": 1}, {"answers": 5, "prompts": 1}])
        self.assertEqual(v["engineSets"], [{"engines": [], "prompts": 1}, {"engines": ["chatgpt", "gemini"], "prompts": 1}, {"engines": ["gemini"], "prompts": 1}])
        self.assertEqual(v["markets"], [{"country": "DE", "prompts": 2, "brands": {"Kia": 1, "Hyundai": 1}}, {"country": "KR", "prompts": 1, "brands": {"Kia": 1}}])
        self.assertEqual(v["brands"][0], {"brand": "Kia", "prompts": 2, "measured": 1, "answers": 5})
        self.assertEqual(v["langs"], [{"lang": "de", "prompts": 2, "measured": 2, "answers": 6}, {"lang": "ko", "prompts": 1, "measured": 0, "answers": 0}])
        self.assertEqual(v["sites"][0], {"domain": "kia.com", "prompts": 2, "measured": 1, "answers": 5})

    def test_the_list_picks_do_not_narrow_the_insights(self):
        self.assertEqual(self.insights("m=0&eset=none")["prompts"], 3)


D1, D2 = date(2026, 10, 2), date(2026, 10, 9)


class ListConn:
    def __init__(self):
        self.calls = []

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        return [{"prompt_id": "a", "text": "t", "targets": ["kia.com/de/models"], "site_brand_bit": 2, "country": "DE",
                 "lang": "DE", "answers": 3, "last_measured": D2, "first_measured": D1, "rounds": [D2, D1],
                 "engines": ["gemini", "chatgpt"], "engine_answers": [1, 2]}]


def website_list(qs):
    conn = ListConn()
    ctx = Context(conn, QueryParams("surface=website&" + qs))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.dates = [D2, D1]
    ctx.selected_dates = [D2]
    if "from=" in qs or "to=" in qs:
        ctx.selected_dates = [D1]
    res = run(catalog.prompts(ctx))
    sql, args = conn.calls[0]
    return res, sql, args


class GoldWebsiteList(unittest.TestCase):
    def test_search_matches_text_or_target_url_literally(self):
        _, sql, args = website_list("search=50%25_off")
        self.assertIn("(p.text ILIKE $1 OR coalesce(p.targets[1],'') ILIKE $1)", sql)
        self.assertEqual(args[0], "%50\\%\\_off%")
        _, sql_q, args_q = website_list("q=%20ev%20")
        self.assertEqual(args_q[0], "%ev%")

    def test_engine_and_period_choose_the_counted_answers_only(self):
        _, sql, args = website_list("engine=GEMINI&from=2026-10-01&to=2026-10-03&country=DE")
        stats, rows = sql.split("SELECT p.*,")
        self.assertIn("lower(e.code)=ANY(", stats)
        self.assertIn("j.round_date=ANY(", stats)
        self.assertNotIn("e.code", rows)
        self.assertNotIn("round_date", rows)
        # the answers are counted for the listed prompts only
        self.assertIn("j.prompt_key IN (SELECT p.prompt_key FROM gold.dim_prompt p", stats)
        self.assertIn("c.code=ANY(", stats)
        self.assertIn(["gemini"], args)
        self.assertIn([D1], args)

    def test_without_a_period_every_served_round_counts(self):
        _, sql, args = website_list("")
        self.assertIn([D2, D1], args)
        self.assertIn("cy.servable", sql)
        self.assertIn("coalesce(cy.hidden_scope,0)<>1", sql)
        # each aggregate computed once: under a nested loop a country + language pick ran past the 15 s statement timeout
        self.assertIn("WITH r AS MATERIALIZED (", sql)
        self.assertIn("x AS MATERIALIZED (", sql)

    def test_a_row_carries_its_rounds_and_answers_by_engine_in_order(self):
        item = website_list("")[0]["data"]["items"][0]
        self.assertEqual((item["rounds"], item["first_measured"]), ([D1, D2], D1))
        self.assertEqual((item["engines"], item["engine_answers"], item["answers"]), (["chatgpt", "gemini"], {"chatgpt": 2, "gemini": 1}, 3))

    def test_the_order_with_empty_values_last_and_ties_by_id(self):
        for qs, order in (("sort=answers&dir=asc", "ORDER BY coalesce(stats.answers,0) ASC NULLS LAST,p.prompt_id"),
                          ("sort=last_measured", "ORDER BY stats.last_measured DESC NULLS LAST,p.prompt_id"),
                          ("sort=prompt&dir=asc", 'ORDER BY p.text COLLATE "und-x-icu" ASC NULLS LAST,p.prompt_id'),
                          ("sort=rounds", "ORDER BY coalesce(cardinality(stats.rounds),0) DESC NULLS LAST,p.prompt_id"),
                          ("sort=first_measured&dir=asc", "ORDER BY stats.first_measured ASC NULLS LAST,p.prompt_id"),
                          ("sort=brand&dir=asc", "WHEN 2 THEN 'Kia'"),
                          ("sort=p.text;drop", "ORDER BY p.prompt_id"), ("", "ORDER BY p.prompt_id")):
            self.assertIn(order, website_list(qs)[1], qs)

    def test_the_domain_of_a_target_without_scheme(self):
        res, _, _ = website_list("")
        item = res["data"]["items"][0]
        self.assertEqual((item["domain"], item["target_url"], item["lang_code"], item["brand_code"]), ("kia.com", "kia.com/de/models", "de", "Kia"))


if __name__ == "__main__":
    unittest.main()


class TargetHost(unittest.TestCase):
    """The domain of a website target (Gold's normalized targets carry no scheme): a doubled slash in the path must not
    empty it (Gold has 2 targets like "kia.ro//informatii-legale/…", 2026-10-30 W6 review)."""

    def test_host_of_a_target(self):
        from bff.gold_reader import catalog
        self.assertEqual([catalog.target_host(t) for t in ("kia.com/de/models", "kia.ro//informatii-legale/x", "https://hyundai.com/kr", "genesis.com", "")],
                         ["kia.com", "kia.ro", "hyundai.com", "genesis.com", ""])
