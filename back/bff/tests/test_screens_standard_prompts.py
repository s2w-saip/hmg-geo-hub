"""/standard/prompts screens: the read-only catalog list (filters, options, order, paging), the header
period, the export rows and the change-history feed."""
import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from bff.screens import standard_prompts as sp
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_standard_prompts)") from exc


def run(coro):
    return asyncio.run(coro)


def item(pid, **over):
    base = {"prompt_id": pid, "scope_prompt_id": f"s-{pid}", "text": f"prompt {pid}", "kind": "single", "measured": True,
            "brand_code": "Hyundai", "brand_presence": "branded", "list_type": "Brand Message", "depth1": "A",
            "depth2": "A1", "depth3": None, "depth4": None, "funnel_stage": "인지/탐색", "lang": "ko", "regions": ["KR"]}
    return {**base, **over}


def rows(*items):
    return [sp.catalog_row(i) for i in items]


def query(**over):
    return {**sp.read_query({}), **over}


class Rows(unittest.TestCase):
    def test_unmeasured_prompt_has_no_scope_link(self):
        self.assertEqual(sp.catalog_row(item("a"))["scopePromptId"], "s-a")
        self.assertIsNone(sp.catalog_row(item("a", measured=False))["scopePromptId"])

    def test_presence_prefers_the_editorial_value_then_the_umbrella_rule(self):
        self.assertEqual(sp.presence_of("Kia", "unbranded"), "unbranded")
        self.assertEqual(sp.presence_of("HMG", None), "unbranded")
        self.assertEqual(sp.presence_of("Kia", None), "branded")
        self.assertIsNone(sp.presence_of(None, None))
        self.assertIsNone(sp.presence_of(None, "-"))

    def test_common_rows_have_no_brand_or_the_umbrella_brand(self):
        self.assertEqual([r["common"] for r in rows(item("a"), item("b", brand_code="HMG"), item("c", brand_code=None))],
                         [False, True, True])

    def test_markets_normalized_split_and_sorted(self):
        m = sp.split_markets([" us", "KR", "x:ww", "X:eu", "", "  ", "KR", "x:NBRAND"])
        self.assertEqual(m, {"real": ["KR", "US"], "pseudo": ["x:EU", "x:NBRAND", "x:WW"]})
        self.assertEqual(sp.split_markets(None), {"real": [], "pseudo": []})


class Filters(unittest.TestCase):
    def setUp(self):
        self.rows = rows(item("a"), item("b", kind="acr", lang="en", regions=["US", "x:WW"], measured=False),
                         item("c", brand_code="HMG", brand_presence=None, funnel_stage="비교/검증", text="EV Range?"))

    def ids(self, **filters):
        f = {**{a: "all" for a in sp.AXES}, **filters}
        return [r["id"] for r in self.rows if sp.matches(r, f, "")]

    def test_each_axis(self):
        self.assertEqual(self.ids(kind="acr"), ["b"])
        self.assertEqual(self.ids(lang="en"), ["b"])
        self.assertEqual(self.ids(funnel="비교/검증"), ["c"])
        self.assertEqual(self.ids(presence="unbranded"), ["c"])
        self.assertEqual(self.ids(status="unmeasured"), ["b"])
        self.assertEqual(self.ids(status="tracked"), ["a", "c"])
        self.assertEqual(self.ids(depth1="B"), [])

    def test_market_matches_after_normalizing_both_sides(self):
        self.assertEqual(self.ids(market=" x:ww "), ["b"])
        self.assertEqual(self.ids(market="kr"), ["a", "c"])
        self.assertEqual(self.ids(market="  "), [])

    def test_search_is_trimmed_and_case_insensitive(self):
        f = {a: "all" for a in sp.AXES}
        self.assertEqual([r["id"] for r in self.rows if sp.matches(r, f, "  ev range ")], ["c"])


class Options(unittest.TestCase):
    def setUp(self):
        self.rows = rows(item("a", list_type="L1", depth1="A", depth2="A1", lang="ko", regions=["KR", "x:CPO"]),
                         item("b", list_type="L1", depth1="B", depth2="B1", lang="en", regions=["US", "x:WW"]),
                         item("c", list_type="L2", depth1="C", depth2="C1", depth3="", funnel_stage="비교/검증", regions=["x:EU", "DE"]))

    def test_depth_options_cascade_on_the_draft_only(self):
        draft = {**{a: "all" for a in sp.AXES}, "listType": "L1", "depth1": "B"}
        f = sp.facets(self.rows, draft)
        self.assertEqual(f["listType"], ["L1", "L2"])
        self.assertEqual(f["depth1"], ["A", "B"])
        self.assertEqual(f["depth2"], ["B1"])
        self.assertEqual(f["funnel"], ["비교/검증", "인지/탐색"])
        self.assertEqual(f["lang"], ["en", "ko"])

    def test_market_options_real_then_geographic_pseudo(self):
        f = sp.facets(self.rows, {a: "all" for a in sp.AXES})
        self.assertEqual(f["market"], ["DE", "KR", "US", "x:EU", "x:WW"])
        self.assertEqual(f["marketSort"], ["DE", "KR", "US", "x:CPO", "x:EU", "x:WW"])

    def test_columns_with_a_value_in_the_scope(self):
        self.assertEqual(sp.columns(self.rows), ["listType", "depth1", "depth2"])


class Order(unittest.TestCase):
    def ids(self, rs, **q):
        return [r["id"] for r in sp.ordered(rs, query(**q))]

    def test_default_order_missing_value_as_tilde_then_ties(self):
        rs = rows(item("1", depth1="Beta"), item("2", depth1=None), item("3", depth1="Alpha", text="b"), item("4", depth1="Alpha", text="a"))
        # ICU puts '~' (a missing value) before letters
        self.assertEqual(self.ids(rs), ["2", "4", "3", "1"])

    def test_descending_keeps_the_tie_order(self):
        rs = rows(item("1", kind="acr", text="b"), item("2", text="z"), item("3", kind="acr", text="a"))
        self.assertEqual(self.ids(rs, sort="kind", asc=True), ["2", "3", "1"])
        self.assertEqual(self.ids(rs, sort="kind", asc=False), ["3", "1", "2"])

    def test_status_puts_unmeasured_first_ascending(self):
        rs = rows(item("1"), item("2", measured=False))
        self.assertEqual(self.ids(rs, sort="status"), ["2", "1"])

    def test_market_orders_by_the_label_of_the_first_real_code(self):
        rs = rows(item("1", regions=["US"]), item("2", regions=["DE", "x:WW"]), item("3", regions=["x:WW"]), item("4", regions=None))
        labels = {"US": "미국", "DE": "독일", "x:WW": "글로벌"}
        self.assertEqual(self.ids(rs, sort="market", collation="ko", labels=labels), ["4", "3", "2", "1"])
        self.assertEqual(self.ids(rs, sort="market", collation="ko", labels={}), ["4", "2", "1", "3"])

    def test_collation_follows_the_viewer_language(self):
        rs = rows(item("1", text="가나"), item("2", text="Zeta"), item("3", text="alpha"))
        self.assertEqual(self.ids(rs, sort="text", collation="en"), ["3", "2", "1"])
        self.assertEqual(self.ids(rs, sort="text", collation="ko"), ["1", "3", "2"])  # ko: Hangul before Latin


class Request(unittest.TestCase):
    def test_defaults(self):
        q = sp.read_query({})
        self.assertEqual((q["sort"], q["asc"], q["page"], q["limit"], q["collation"], q["search"]), ("depth1", True, 1, 50, "en", ""))
        self.assertEqual(q["filters"], {a: "all" for a in sp.AXES})

    def test_filters_draft_and_labels(self):
        q = sp.read_query({"f.kind": "acr", "d.depth1": "A", "ml.KR": "한국", "ml.x:WW": "글로벌", "asc": "false"})
        self.assertEqual((q["filters"]["kind"], q["draft"]["depth1"], q["asc"]), ("acr", "A", False))
        self.assertEqual(q["labels"], {"KR": "한국", "x:WW": "글로벌"})

    def test_invalid_values_are_422(self):
        for bad in ({"sort": "nope"}, {"limit": "501"}, {"limit": "0"}, {"page": "0"}, {"page": "x"}, {"collation": "de"},
                    {"search": "x" * 5001}, {"f.kind": "x" * 5001}):
            with self.assertRaises(HTTPException) as cm:
                sp.read_query(bad)
            self.assertEqual(cm.exception.status_code, 422, bad)

    def test_export_reads_are_not_paged(self):
        self.assertEqual(sp.read_query({"limit": "9999"}, paged=False)["limit"], 9999)


def gold_page(items, next_cursor=None):
    return {"data": {"items": items}, "meta": {"page": {"total": len(items), "next_cursor": next_cursor}}}


class Screens(unittest.TestCase):
    def page(self, qs, items):
        with mock.patch("bff.api.get", mock.AsyncMock(return_value=gold_page(items))) as get:
            vm = run(sp.prompts_page(QueryParams(qs)))
        return vm, get

    def test_reads_the_whole_global_catalog_once(self):
        _, get = self.page("", [item("a")])
        get.assert_awaited_once_with("prompts", {"surface": "global", "card": "true", "limit": sp.READ_LIMIT, "cursor": "0"})

    def test_follows_next_cursor(self):
        pages = [gold_page([item("a")], next_cursor="1"), gold_page([item("b")])]
        with mock.patch("bff.api.get", mock.AsyncMock(side_effect=pages)) as get:
            vm = run(sp.prompts_page(QueryParams("")))
        self.assertEqual([r["id"] for r in vm["rows"]], ["a", "b"])
        self.assertEqual(get.await_args_list[1].args[1]["cursor"], "1")

    def test_page_labels_and_a_page_past_the_end_falls_back_to_the_last(self):
        items = [item(f"{i:02d}", text=f"t{i:02d}") for i in range(7)]
        vm, _ = self.page("limit=3&page=2&sort=text", items)
        self.assertEqual([r["id"] for r in vm["rows"]], ["03", "04", "05"])
        self.assertEqual((vm["page"], vm["pages"], vm["rangeFrom"], vm["rangeTo"], vm["offset"], vm["total"], vm["count"]), (2, 3, 4, 6, 3, 7, 7))
        vm, _ = self.page("limit=3&page=9&sort=text", items)
        self.assertEqual((vm["page"], vm["rangeFrom"], vm["rangeTo"], [r["id"] for r in vm["rows"]]), (3, 7, 7, ["06"]))

    def test_filtered_total_against_the_scope_count(self):
        vm, _ = self.page("f.kind=acr", [item("a"), item("b", kind="acr")])
        self.assertEqual((vm["total"], vm["count"], [r["id"] for r in vm["rows"]]), (1, 2, ["b"]))
        empty, _ = self.page("search=zzz", [item("a")])
        self.assertEqual((empty["total"], empty["page"], empty["pages"], empty["rangeFrom"], empty["rangeTo"], empty["rows"]), (0, 1, 1, 0, 0, []))

    def test_export_has_every_filtered_row_in_order(self):
        items = [item(f"{i:03d}", text=f"t{i:03d}") for i in range(620)]
        with mock.patch("bff.api.get", mock.AsyncMock(return_value=gold_page(items))):
            vm = run(sp.prompts_export(QueryParams("sort=text&asc=false&limit=50&page=3")))
        self.assertEqual(len(vm["rows"]), 620)
        self.assertEqual(vm["rows"][0]["id"], "619")
        self.assertEqual(vm["columns"], ["listType", "depth1", "depth2"])

    def test_header_period(self):
        dates = {"data": {"first_measured_date": "2026-09-01", "latest_round_date": "2026-10-05", "dates": ["2026-10-05"]}}
        with mock.patch("bff.api.get", mock.AsyncMock(return_value=dates)):
            self.assertEqual(run(sp.prompts_header(QueryParams(""))), {"period": {"from": "2026-09-01", "to": "2026-10-05"}})
        with mock.patch("bff.api.get", mock.AsyncMock(return_value={"data": {"latest_round_date": "2026-10-05"}})):
            self.assertEqual(run(sp.prompts_header(QueryParams(""))), {"period": None})


def audit(aid, days_ago, event="updated", batch=None, **over):
    at = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")
    return {"audit_id": aid, "prompt_id": "p", "actor_id": None, "actor_type": "user", "event_type": event,
            "changes": {"text": {"old": "a", "new": "b"}, "kind": {"old": 1, "new": True}}, "batch_id": batch,
            "created_at": at, "actor_email": "a@x", "prompt_text": "t", "prompt_brand": None, **over}


class History(unittest.TestCase):
    def history(self, qs, items):
        with mock.patch("bff.api.get", mock.AsyncMock(return_value={"data": {"items": items}})) as get:
            return run(sp.prompts_history(QueryParams(qs))), get

    def test_source_without_history_is_unavailable(self):
        err = HTTPException(503, "This capability is not supplied by the Gold source")
        with mock.patch("bff.api.get", mock.AsyncMock(side_effect=err)):
            self.assertEqual(run(sp.prompts_history(QueryParams(""))), {"available": False, "shown": 0, "groups": []})

    def test_other_errors_propagate(self):
        with mock.patch("bff.api.get", mock.AsyncMock(side_effect=HTTPException(500, "x"))):
            with self.assertRaises(HTTPException):
                run(sp.prompts_history(QueryParams("")))

    def test_window_event_filter_and_view_rows(self):
        vm, get = self.history("days=30&event=updated", [audit(1, 1), audit(2, 40), audit(3, 2, event="created")])
        get.assert_awaited_once_with("prompts/history", {"surface": "global", "limit": 500})
        self.assertEqual(vm["shown"], 1)
        row = vm["groups"][0]["rows"][0]
        self.assertEqual((row["id"], row["changes"]["kind"]), ("1", {"old": "1", "new": "true"}))
        self.assertEqual(self.history("", [audit(1, 1), audit(2, 40)])[0]["shown"], 2)

    def test_timeline_reads_one_prompt_without_a_window(self):
        with mock.patch("bff.api.get", mock.AsyncMock(return_value={"data": {"items": [audit(1, 400), audit(2, 1)]}})) as get:
            vm = run(sp.prompts_timeline(QueryParams("prompt_id=p-1")))
        path, params = get.await_args.args
        self.assertEqual((path, params["prompt_id"], params["from"], params["limit"], params["surface"]),
                         ("prompts/history", "p-1", "2000-01-01", 100, "global"))
        self.assertEqual((vm["available"], [r["id"] for r in vm["rows"]]), (True, ["1", "2"]))

    def test_timeline_unavailable_and_bad_id(self):
        with mock.patch("bff.api.get", mock.AsyncMock(side_effect=HTTPException(503, "x"))):
            self.assertEqual(run(sp.prompts_timeline(QueryParams("prompt_id=p"))), {"available": False, "rows": []})
        for qs in ("", "prompt_id=", "prompt_id=" + "x" * 201):
            with self.assertRaises(HTTPException) as cm:
                run(sp.prompts_timeline(QueryParams(qs)))
            self.assertEqual(cm.exception.status_code, 422)

    def test_consecutive_rows_of_one_batch_fold(self):
        vm, _ = self.history("", [audit(1, 1, batch="b"), audit(2, 1, batch="b"), audit(3, 1), audit(4, 1, batch="b")])
        self.assertEqual([(g["key"], len(g["rows"])) for g in vm["groups"]], [("1", 2), ("3", 1), ("4", 1)])


if __name__ == "__main__":
    unittest.main()
