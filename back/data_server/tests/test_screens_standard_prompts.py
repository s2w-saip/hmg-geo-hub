"""/standard/prompts screens: the read-only catalog list (filters, options, order, paging), the header
period, the export rows and the change-history feed."""
import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams
    from data_server.gold_reader import catalog
    from data_server.gold_reader.context import Context
    from data_server.screens import standard_prompts as sp
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_screens_standard_prompts)") from exc


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

    def test_every_row_carries_the_hub_prompt_id(self):
        """Last review (2026-11-02): the detail sheet asked the timeline for the Gold catalog row id, which the HUB
        history does not know, so every prompt showed no change. The HUB id is Gold's dim_prompt.prompt_id, measured or not."""
        self.assertEqual(sp.catalog_row(item("a"))["hubPromptId"], "s-a")
        self.assertEqual(sp.catalog_row(item("a", measured=False))["hubPromptId"], "s-a")
        self.assertIsNone(sp.catalog_row(item("a", scope_prompt_id=None))["hubPromptId"])

    def test_presence_is_gold_s_value_only(self):
        """Renewal audit 13-1: an empty Gold value stays empty (the brand no longer stands in for it: HMG ->
        미포함, another brand -> 포함 was the original API's presence_effective)."""
        presence = lambda **over: sp.catalog_row(item("a", **over))["presence"]
        self.assertEqual(presence(brand_code="Kia", brand_presence="unbranded"), "unbranded")
        self.assertEqual(presence(brand_code="HMG", brand_presence="branded"), "branded")
        self.assertIsNone(presence(brand_code="HMG", brand_presence=None))
        self.assertIsNone(presence(brand_code="Kia", brand_presence=None))
        self.assertIsNone(presence(brand_code=None, brand_presence=None))
        self.assertIsNone(presence(brand_code="Kia", brand_presence="-"))

    def test_kind_is_gold_s_value_only(self):
        """Renewal audit 13-2: an empty Gold kind stays empty (no 'single' default)."""
        self.assertIsNone(sp.catalog_row(item("a", kind=None))["kind"])
        self.assertEqual([sp.catalog_row(item("a", kind=k))["kind"] for k in ("acr", "single")], ["acr", "single"])

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
                         item("c", brand_code="HMG", brand_presence=None, funnel_stage="비교/검증", text="EV Range?"),
                         item("d", brand_code="HMG", brand_presence="unbranded", kind=None))

    def ids(self, **filters):
        f = {**{a: "all" for a in sp.AXES}, **filters}
        return [r["id"] for r in self.rows if sp.matches(r, f, "")]

    def test_each_axis(self):
        self.assertEqual(self.ids(kind="acr"), ["b"])
        self.assertEqual(self.ids(lang="en"), ["b"])
        self.assertEqual(self.ids(funnel="비교/검증"), ["c"])
        self.assertEqual(self.ids(presence="unbranded"), ["d"])
        self.assertEqual(self.ids(status="unmeasured"), ["b"])
        self.assertEqual(self.ids(status="tracked"), ["a", "c", "d"])
        self.assertEqual(self.ids(depth1="B"), [])

    def test_no_value_is_its_own_pick(self):
        """'값 없음' picks the rows Gold left empty (renewal audit 13-1 · 13-2); a value pick never takes them."""
        self.assertEqual(self.ids(presence="none"), ["c"])
        self.assertEqual(self.ids(presence="branded"), ["a", "b"])
        self.assertEqual(self.ids(kind="none"), ["d"])
        self.assertEqual(self.ids(kind="single"), ["a", "c"])

    def test_market_matches_after_normalizing_both_sides(self):
        self.assertEqual(self.ids(market=" x:ww "), ["b"])
        self.assertEqual(self.ids(market="kr"), ["a", "c", "d"])
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

    def test_presence_and_kind_offer_no_value_only_when_a_row_has_none(self):
        """The fixed values always; '값 없음' (none) only when the scope has a row Gold left empty (renewal audit 13-1)."""
        draft = {a: "all" for a in sp.AXES}
        f = sp.facets(self.rows, draft)
        self.assertEqual((f["presence"], f["kind"]), (["branded", "unbranded"], ["acr", "single"]))
        empty = self.rows + rows(item("e", brand_presence=None, kind=None))
        f = sp.facets(empty, draft)
        self.assertEqual((f["presence"], f["kind"]), (["branded", "unbranded", "none"], ["acr", "single", "none"]))


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

    def test_an_empty_kind_sorts_apart_from_single(self):
        rs = rows(item("1", kind=None), item("2", kind="acr"), item("3"))
        self.assertEqual(self.ids(rs, sort="kind", asc=True), ["1", "3", "2"])
        self.assertEqual(self.ids(rs, sort="kind", asc=False), ["2", "3", "1"])

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
        with mock.patch("data_server.api.get", mock.AsyncMock(return_value=gold_page(items))) as get:
            vm = run(sp.prompts_page(QueryParams(qs)))
        return vm, get

    def test_reads_the_whole_global_catalog_once(self):
        _, get = self.page("", [item("a")])
        get.assert_awaited_once_with("prompts", {"surface": "global", "card": "true", "limit": sp.READ_LIMIT, "cursor": "0"})

    def test_follows_next_cursor(self):
        pages = [gold_page([item("a")], next_cursor="1"), gold_page([item("b")])]
        with mock.patch("data_server.api.get", mock.AsyncMock(side_effect=pages)) as get:
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
        with mock.patch("data_server.api.get", mock.AsyncMock(return_value=gold_page(items))):
            vm = run(sp.prompts_export(QueryParams("sort=text&asc=false&limit=50&page=3")))
        self.assertEqual(len(vm["rows"]), 620)
        self.assertEqual(vm["rows"][0]["id"], "619")
        self.assertEqual(vm["columns"], ["listType", "depth1", "depth2"])

    def test_header_period(self):
        dates = {"data": {"first_measured_date": "2026-09-01", "latest_round_date": "2026-10-05", "dates": ["2026-10-05"]}}
        with mock.patch("data_server.api.get", mock.AsyncMock(return_value=dates)):
            self.assertEqual(run(sp.prompts_header(QueryParams(""))), {"period": {"from": "2026-09-01", "to": "2026-10-05"}})
        with mock.patch("data_server.api.get", mock.AsyncMock(return_value={"data": {"latest_round_date": "2026-10-05"}})):
            self.assertEqual(run(sp.prompts_header(QueryParams(""))), {"period": None})


def audit(aid, days_ago, event="updated", batch=None, **over):
    at = (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")
    return {"audit_id": aid, "prompt_id": "p", "actor_id": None, "actor_type": "user", "event_type": event,
            "changes": {"text": {"old": "a", "new": "b"}, "kind": {"old": 1, "new": True}}, "batch_id": batch,
            "created_at": at, "actor_email": "a@x", "prompt_text": "t", "prompt_brand": None, **over}


class History(unittest.TestCase):
    """Global score sheet (2026-11-02): the tab was always empty, it asked Gold, which keeps no history; the HUB catalog
    keeps every revision (catalog.prompt_version)."""

    PID = "00000000-0000-0000-0000-000000000001"

    def history(self, qs, items):
        with mock.patch.object(sp.catalog_editor, "history_rows", mock.AsyncMock(return_value=items)) as get:
            return run(sp.prompts_history(QueryParams(qs))), get

    def test_store_without_history_is_unavailable(self):
        err = HTTPException(503, "HUB data store is not configured")
        with mock.patch.object(sp.catalog_editor, "history_rows", mock.AsyncMock(side_effect=err)):
            self.assertEqual(run(sp.prompts_history(QueryParams(""))), {"available": False, "shown": 0, "groups": []})

    def test_other_errors_propagate(self):
        with mock.patch.object(sp.catalog_editor, "history_rows", mock.AsyncMock(side_effect=HTTPException(500, "x"))):
            with self.assertRaises(HTTPException):
                run(sp.prompts_history(QueryParams("")))

    def test_a_scoped_account_reads_no_feed_of_every_market(self):
        with mock.patch.object(sp, "reader_scope", return_value={"all": False}):
            self.assertEqual(self.history("", [audit(1, 1)])[0], {"available": False, "shown": 0, "groups": []})

    def test_window_event_filter_and_view_rows(self):
        vm, get = self.history("days=30&event=updated", [audit(1, 1), audit(2, 40), audit(3, 2, event="created")])
        self.assertEqual(get.await_args.args, (None, None))
        self.assertEqual(vm["shown"], 1)
        row = vm["groups"][0]["rows"][0]
        self.assertEqual((row["id"], row["changes"]["kind"]), ("1", {"old": "1", "new": "true"}))
        self.assertEqual(self.history("", [audit(1, 1), audit(2, 40)])[0]["shown"], 2)

    def test_window_and_event_apply_before_any_cap(self):
        """Last review (2026-11-02): the tab read the newest 500 revisions and filtered after, so a Gold import of 12,446
        rows hid everything older (the users' own edits) and an event pick found only what sat in those 500. The store
        reads the whole window; every batch keeps its full count and lists its first rows."""
        rows = [audit(f"b{i}", 1, batch="b") for i in range(600)] + [audit("u1", 2, event="text_updated"), audit("u2", 3, event="text_updated"),
                                                                     audit("old", 120, event="text_updated")]

        async def store(pid, limit, since=None):
            out = [r for r in rows if since is None or sp.instant(r["created_at"]) >= since]
            return out[:limit] if limit else out

        with mock.patch.object(sp.catalog_editor, "history_rows", mock.AsyncMock(side_effect=store)):
            vm = run(sp.prompts_history(QueryParams("days=90")))
            picked = run(sp.prompts_history(QueryParams("days=90&event=text_updated")))
        self.assertEqual(vm["shown"], 602)
        self.assertEqual([(g["key"], g["count"], len(g["rows"])) for g in vm["groups"]], [("b0", 600, sp.GROUP_ROWS), ("u1", 1, 1), ("u2", 1, 1)])
        self.assertEqual((picked["shown"], [g["key"] for g in picked["groups"]]), (2, ["u1", "u2"]))

    def test_timeline_reads_one_prompt_without_a_window(self):
        with mock.patch.object(sp.catalog_editor, "history_rows", mock.AsyncMock(return_value=[audit(1, 400), audit(2, 1)])) as get:
            vm = run(sp.prompts_timeline(QueryParams(f"prompt_id={self.PID}")))
        self.assertEqual((str(get.await_args.args[0]), get.await_args.args[1]), (self.PID, 100))
        self.assertEqual((vm["available"], [r["id"] for r in vm["rows"]]), (True, ["1", "2"]))

    def test_timeline_unavailable_and_bad_id(self):
        with mock.patch.object(sp.catalog_editor, "history_rows", mock.AsyncMock(side_effect=HTTPException(503, "x"))):
            self.assertEqual(run(sp.prompts_timeline(QueryParams(f"prompt_id={self.PID}"))), {"available": False, "rows": []})
        for qs in ("", "prompt_id=", "prompt_id=" + "x" * 201):
            with self.assertRaises(HTTPException) as cm:
                run(sp.prompts_timeline(QueryParams(qs)))
            self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(run(sp.prompts_timeline(QueryParams("prompt_id=not-a-uuid"))), {"available": True, "rows": []})

    def test_a_revision_becomes_a_history_row(self):
        from datetime import datetime, timezone
        from data_server.hub_stores import catalog_editor as ed
        at = datetime(2026, 10, 28, tzinfo=timezone.utc)
        row = {"prompt_id": self.PID, "version": 2, "text": "new", "definition": {"kind": "single"}, "recorded_at": at, "recorded_by": None,
               "prev_version": 1, "prev_text": "old", "prev_definition": {"kind": "single"}}
        out = ed.audit_row(row, {})
        self.assertEqual((out["event_type"], out["changes"]["text"], out["batch_id"], out["actor_type"]),
                         ("text_updated", {"old": "old", "new": "new"}, at.isoformat(), "system"))
        first = ed.audit_row({**row, "version": 1, "prev_version": None, "prev_text": None, "prev_definition": None}, {})
        self.assertEqual((first["event_type"], first["changes"]), ("created", {}))

    def test_consecutive_rows_of_one_batch_fold(self):
        vm, _ = self.history("", [audit(1, 1, batch="b"), audit(2, 1, batch="b"), audit(3, 1), audit(4, 1, batch="b")])
        self.assertEqual([(g["key"], len(g["rows"])) for g in vm["groups"]], [("1", 2), ("3", 1), ("4", 1)])



class GlobalListConn:
    def __init__(self):
        self.calls = []

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        return []


def global_list(qs):
    conn = GlobalListConn()
    ctx = Context(conn, QueryParams("surface=global&card=true&" + qs))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.builds = {"fact": [7]}
    run(catalog.prompts(ctx))
    return conn.calls[0]


class GoldGlobalList(unittest.TestCase):
    """Renewal audit 13-3 (2026-10-31): the global catalog read keeps the account's countries (the clamp's `country`)
    as the original API's catalog_market_scope did (B1 2026-09-03): a prompt whose target markets are unset, hold no
    real country, or hold a country of the scope. It used to read every market (Genesis · genesis-middle-east got
    1,208 prompts, 302 of them for its countries)."""

    MARKET = "unnest(p.regions)"

    def test_the_scope_countries_narrow_the_rows(self):
        sql, args = global_list("brand=Genesis&country=ae&country=SA&country=x:WW")
        self.assertIn("p.regions IS NULL", sql)
        self.assertIn("NOT LIKE 'x:%'", sql)
        self.assertIn(["AE", "SA"], args)

    def test_no_country_reads_every_market(self):
        sql, _ = global_list("brand=Kia")
        self.assertNotIn(self.MARKET, sql)
        sql, _ = global_list("country=x:WW")
        self.assertNotIn(self.MARKET, sql)

    def test_the_brand_scope_stays_the_brands_and_the_umbrella(self):
        sql, args = global_list("brand=Kia&country=DE")
        self.assertIn("(ce.brand_bit & $2)<>0", sql)
        self.assertEqual(args[1], 2 | 8)



class CatalogSpelling(unittest.TestCase):
    """Global score sheet (2026-11-02): one catalog value in two cases is one filter option."""

    def test_rows_differing_by_case_fold_into_one(self):
        from data_server.screens._filters import to_catalog_rows
        base = {"brand": "Kia", "brand_presence": "branded", "list_type": "A", "depth1": "x", "depth2": "y", "depth4": None}
        rows = to_catalog_rows({"rows": [{**base, "depth3": "design"}, {**base, "depth3": "Design"}]})
        self.assertEqual([r["depth3"] for r in rows], ["Design"])



class DepthCase(unittest.TestCase):
    def test_a_pick_finds_both_spellings(self):
        f = {k: "all" for k in (*sp.FIELDS, "presence", "status", "market")}
        row = {**dict.fromkeys(sp.FIELDS.values()), "presence": None, "scopePromptId": None, "markets": [], "text": "", "depth3": "design"}
        self.assertTrue(sp.matches(row, {**f, "depth3": "Design"}, ""))
        self.assertFalse(sp.matches({**row, "depth3": "Other"}, {**f, "depth3": "Design"}, ""))

    def test_the_options_list_one_spelling(self):
        self.assertEqual(sp.one_spelling(["design", "Design", "Audio"]), ["Audio", "Design"])



class AdminClassification(unittest.TestCase):
    """Global score sheet (2026-11-02): Admin › Global prompts showed '—' for the classification of 12,446 Gold prompts:
    it read the prompt level (dim_prompt), and Gold keeps these values per brand row (catalog_entry, definition.catalogs)."""

    def test_a_label_falls_back_to_the_first_catalog_row(self):
        from data_server.hub_stores import catalog_editor as ed
        row = {"list_type": "Consumer base Response", "depth1": "1. Car+Features", "brand_presence": "unbranded"}
        snap = ed.snapshot("t", {"kind": "single", "depth1": None, "catalogs": [row, {"depth1": "other"}]})
        self.assertEqual((snap["listType"], snap["depth1"], snap["brandPresence"]), ("Consumer base Response", "1. Car+Features", "unbranded"))
        self.assertEqual(ed.snapshot("t", {"depth1": "own", "catalogs": [row]})["depth1"], "own")
        self.assertIsNone(ed.snapshot("t", {})["depth1"])

    def test_the_list_filters_and_sorts_on_the_same_value(self):
        from data_server.hub_stores import catalog_editor as ed
        self.assertIn("catalogs'->0->>'list_type'", ed.SORTS["listType"])


if __name__ == "__main__":
    unittest.main()
