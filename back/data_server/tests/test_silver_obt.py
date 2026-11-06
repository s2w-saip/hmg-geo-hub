"""Adapter ②: it reads contract columns only, runs the rules of data_server.metrics.judgments, and stays off unless asked. The numbers against gold_db are a live comparison: a fake
connection answers here, and HGH_SILVER_TEST lets the last test read the stand-in."""
import asyncio
import hashlib
import json
import os
import unittest
from contextlib import asynccontextmanager
from datetime import date
from unittest import mock

from starlette.datastructures import QueryParams

from data_server.gold_reader.context import Context
from data_server.metrics import gold_rows, judgments, serving, silver_obt
from data_server.metrics.catalog import MONITORING
from data_server.metrics.silver_obt import Inputs, Scope, SilverObtSource, merge


def inputs() -> Inputs:
    return Inputs(prompt_ids=["p1"], funnel=["f"], branded=[("p1", 1)], in_root=[True], is_korean=[False], regions=["KR"], is_acr=[False], web_reg=[True], brand_group=[1],
                  hidden_markets=["ID"], own_names={"hyundai": 1}, own_entities={"e1": 1}, sites={"s1": ("KR", 1)}, categories={"Other": "other"}, registered={"s1": ["hyundai.co.kr"]},
                  excluded_entities=["x1"])


class Conn:
    def __init__(self) -> None:
        self.sql: list[str] = []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        return []


def run(surface: str, call) -> list[str]:
    conn = Conn()
    source = SilverObtSource(conn, Scope(surface, (date(2026, 10, 5),), 7), inputs())
    asyncio.run(call(source))
    return conn.sql


CALLS = {"answers": lambda s: s.answer_counts(MONITORING), "brands": lambda s: s.brand_counts(MONITORING), "citations": lambda s: s.citation_counts(),
         "categories": lambda s: s.category_counts(), "url": lambda s: s.url_counts(), "funnel": lambda s: s.funnel_prompt_counts(), "stance": lambda s: s.stance_counts(),
         "acr": lambda s: s.acr_totals()}


class ContractOnly(unittest.TestCase):
    def test_no_read_touches_ext_or_a_flag_upstream_worked_out(self):
        for surface in ("global", "website", "project"):
            for name, call in CALLS.items():
                for sql in run(surface, call):
                    with self.subTest(surface=surface, call=name):
                        self.assertNotIn(".ext", sql)
                        self.assertNotIn("v_gold", sql)
                        self.assertNotIn("is_rep", sql)
                        self.assertIn("silver_contract.", sql)
                        self.assertNotIn(" silver.", sql)

    def test_the_rules_are_judgments(self):
        sql = run("global", CALLS["answers"])[0]
        self.assertIn(judgments.REGION_TAGGING_CUTOFF, sql)  # eligible(), not a copy of it
        self.assertIn("x.acr_iter", sql)  # later_iteration()

    def test_website_owned_is_what_the_site_registered(self):
        sql = run("website", CALLS["citations"])[1]
        self.assertIn("r.site=c.project_id::text", sql)
        project = run("project", CALLS["citations"])[1]
        self.assertIn("c.loc_owned", project)

    def test_merge_counts_zero_for_a_group_without_a_row(self):
        rows = merge([{"round": 1}, {"round": 2}], [{"round": 1, "n": 5}], ("round",), ("n",))
        self.assertEqual([r["n"] for r in rows], [5, 0])


class Signals(unittest.TestCase):
    """T9.3: on the OBT the rollup writes the rows from it, and the manifest says when a kept value is late."""

    def context(self, q: str = "surface=global") -> Context:
        ctx = Context(None, QueryParams(q))
        ctx.build_dates = {1: date(2026, 10, 5)}
        return ctx

    def test_a_round_is_late_only_when_its_own_operating_snapshot_moves(self):
        day, other = date(2026, 10, 5), date(2026, 9, 28)
        ctx = self.context()
        off = gold_rows.round_snapshot(ctx, day)
        self.assertTrue(off.startswith("gold-builds:"))
        ctx.public_snapshots = {day: "run-1", other: "run-2"}
        before = gold_rows.round_snapshot(ctx, day), gold_rows.round_snapshot(ctx, other)
        self.assertTrue(before[0].startswith("silver:"))
        ctx.public_snapshots = {day: "run-9", other: "run-2"}
        self.assertNotEqual(gold_rows.round_snapshot(ctx, day), before[0])
        self.assertEqual(gold_rows.round_snapshot(ctx, other), before[1])

    def test_first_screens_keep_coming_from_the_rows_and_filtered_reads_count_on_the_obt(self):
        with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": "silver"}), mock.patch.object(gold_rows.metrics_db, "configured", return_value=True), \
                mock.patch.object(silver_obt.ObtForContext, "__init__", lambda self, ctx: setattr(self, "ctx", ctx) or setattr(self, "surface", "global") or setattr(self, "snapshot_id", "silver")):
            first = gold_rows.metric_source(self.context())
            filtered = gold_rows.metric_source(self.context("surface=global&country=KR"))
        self.assertIsInstance(first, gold_rows.GoldRowsSource)
        self.assertIsInstance(first.live, silver_obt.ObtForContext)
        self.assertIsInstance(filtered, silver_obt.ObtForContext)

    def snapshot_id(self, public: dict) -> str:
        @asynccontextmanager
        async def connection():
            conn = mock.Mock()
            conn.fetchrow = mock.AsyncMock(return_value={"release_id": 7, "version": 2})
            conn.fetch = mock.AsyncMock(return_value=[{"round_date": date(2026, 10, 5)}])
            yield conn

        async def main():
            with mock.patch.object(serving, "connection", connection), mock.patch.object(serving, "read_inputs", mock.AsyncMock(return_value=mock.Mock(inputs_digest="d"))), \
                    mock.patch.object(silver_obt, "public_snapshots", mock.AsyncMock(return_value=public)):
                return await serving.current_snapshot("project")
        return asyncio.run(main())

    def test_a_new_operating_snapshot_is_a_new_snapshot_id(self):
        day = date(2026, 10, 5)
        with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": "silver"}):
            one, same, moved = self.snapshot_id({day: "run-1"}), self.snapshot_id({day: "run-1"}), self.snapshot_id({day: "run-2"})
        self.assertTrue(one.startswith("silver:"))
        self.assertEqual(one, same)
        self.assertNotEqual(one, moved)

    def test_off_the_snapshot_id_stays_as_it_was(self):
        with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": ""}), mock.patch.object(silver_obt, "loaded_snapshots", mock.AsyncMock(return_value={})):
            off = self.snapshot_id({})
        self.assertEqual(off, "gold-release:7:2:" + hashlib.sha256(b"2026-10-05:d").hexdigest()[:12] + ":-")

    def test_on_the_query_tables_the_snapshot_id_follows_what_is_loaded(self):
        with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": ""}), mock.patch.object(silver_obt, "loaded_snapshots", mock.AsyncMock(return_value={date(2026, 10, 5): "s1"})):
            one = self.snapshot_id({})
        with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": ""}), mock.patch.object(silver_obt, "loaded_snapshots", mock.AsyncMock(return_value={date(2026, 10, 5): "s2"})):
            moved = self.snapshot_id({})
        self.assertTrue(one.startswith("silver:7:2:"))
        self.assertNotEqual(one, moved)

    def test_a_call_by_round_is_counted_round_by_round_and_others_at_once(self):
        d1, d2 = date(2026, 9, 28), date(2026, 10, 5)
        ctx = mock.Mock(card=False, surface="global", q={}, release={"release_id": 1, "version": 1})
        ctx.mention = None
        source = silver_obt.ObtForContext(ctx)
        seen = []

        async def answer_counts(self, population, group=()):
            seen.append(self.scope.rounds)
            return [{"round": day, "answers": 1} for day in self.scope.rounds] if "round" in group else [{"answers": len(self.scope.rounds)}]

        @asynccontextmanager
        async def connection():
            yield mock.Mock()

        async def main():
            with mock.patch.object(source, "_scope", mock.AsyncMock(return_value=Scope("global", (d1, d2), 7))), mock.patch.object(silver_obt, "current_inputs", mock.AsyncMock(return_value=inputs())), \
                    mock.patch.object(silver_obt.silver_db, "connection", connection), mock.patch.object(SilverObtSource, "answer_counts", answer_counts):
                return await source.answer_counts(MONITORING, ("round_date",)), await source.answer_counts(MONITORING)
        by_round, whole = asyncio.run(main())
        self.assertEqual([r["round_date"] for r in by_round], [d1, d2])
        self.assertEqual(whole, [{"answers": 2}])
        self.assertEqual(seen, [(d1,), (d2,), (d1, d2)])

    def test_on_the_obt_a_filtered_read_uses_the_cache_db(self):
        run = mock.AsyncMock(return_value="{}")

        async def main():
            with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": "silver"}), mock.patch.object(serving, "snapshot_of", mock.AsyncMock(return_value="s1")), \
                    mock.patch.object(serving.metrics_db, "first_screen", mock.AsyncMock(return_value=None)), mock.patch.object(serving.cache_db, "get", mock.AsyncMock(return_value='{"cached":1}')):
                return await serving.read("filters/options", QueryParams("surface=global&country=KR"), run)
        self.assertEqual(asyncio.run(main()), '{"cached":1}')
        run.assert_not_awaited()


class Inputs_(unittest.TestCase):
    """Three differences a whole-history comparison with gold_db found (2026-11-06)."""

    def test_a_prompt_taken_out_of_the_catalog_still_counts_in_its_rounds(self):
        before = inputs()._replace(prompt_ids=["p1", "p2"], in_root=[True, False], brand_group=[1, 0])
        after = silver_obt.with_past_catalogs(before, [{"id": "p2", "in_root_catalog_all": True, "cat_mask_all": 4}])
        self.assertEqual(after.in_root, [True, True])
        self.assertEqual(after.brand_group, [1, 4])

    def test_the_past_catalogs_are_read_on_the_reads_own_connection(self):
        """Asking the pool for another connection while six reads each hold one never returns (2026-11-06)."""
        gold = mock.Mock()
        gold.fetch = mock.AsyncMock(return_value=[])

        @asynccontextmanager
        async def connection():
            yield mock.Mock()

        async def main():
            with mock.patch.object(silver_obt, "_cached", None), mock.patch.object(silver_obt.input_db, "connection", connection), \
                    mock.patch.object(silver_obt, "read_inputs", mock.AsyncMock(return_value=inputs())):
                return await silver_obt.current_inputs(gold)
        asyncio.run(main())
        gold.fetch.assert_awaited_once()

    def test_a_korean_prompt_is_one_with_hangul_in_its_text(self):
        class Bm:
            async def fetch(self, sql, *args):
                if "target_url" in sql:
                    return []
                if "current_prompt" in sql:
                    return [{"id": "p1", "text": "현대차 추천", "d": "{\"language\": \"\"}"}, {"id": "p2", "text": "best SUV", "d": "{\"language\": \"ko\"}"}]
                return []
        self.assertEqual(asyncio.run(silver_obt.read_inputs(Bm())).is_korean, [True, False])

    def test_a_projects_registered_urls_are_keyed_as_the_obt_names_it(self):
        """The OBT names a project by its scope id (ObtForContext._scope), the input store by its project id: a registration keyed by the latter counted 0 (2026-11-07)."""
        class Bm:
            async def fetch(self, sql, *args):
                if "current_measurement" in sql:
                    return [{"id": "scope-of-p", "surface": "3", "owned_urls": ["kia.com/kr"], "tracked_urls": ["kia.com/kr/ev"], "units": "[]"},
                            {"id": "site-1", "surface": "2", "owned_urls": ["hyundai.com/kr"], "tracked_urls": [], "units": "[]"}]
                if "'surface'='2'" in sql:
                    return [{"id": "site-1", "country": "KR", "bit": 1}]
                return []
        inputs = asyncio.run(silver_obt.read_inputs(Bm()))
        self.assertEqual(inputs.registered, {"scope-of-p": ["kia.com"], "site-1": ["hyundai.com"]})
        self.assertEqual(inputs.tracked, {"scope-of-p": ["kia.com/kr/ev"]})

    def test_a_project_pick_narrows_to_that_projects_prompts(self):
        seen = []

        class Gold:
            async def fetchval(self, sql, *args):
                return "project-id"

            async def fetch(self, sql, *args):
                seen.append(sql)
                return []
        ctx = Context(Gold(), QueryParams("surface=project&brand_presence=unbranded"))
        ctx.project_key = 125
        ctx.release = {"release_id": 1, "version": 1}
        ctx.selected_dates = [date(2026, 10, 9)]
        scope = asyncio.run(silver_obt.ObtForContext(ctx)._scope())
        self.assertEqual(scope.prompts, ())   # no prompt carries the pick: nothing is counted
        self.assertIn("presence_key", seen[-1])
        self.assertIn("p.project_key", seen[-1])

    def test_the_stand_in_marks_only_served_cycles_public(self):
        from hub_storage.build_virtual_obt import manifest_status
        status = lambda **v: manifest_status(json.dumps({"v_gold": {"servable": True, "hidden_scope": 0, "view_date": None, **v}}))  # noqa: E731
        self.assertEqual(status(), "public")
        self.assertEqual(status(servable=False), "ready")
        self.assertEqual(status(hidden_scope=1), "ready")
        self.assertEqual(status(hidden_scope=2), "public")   # citations only: a snapshot is public as a whole
        self.assertEqual(status(view_date="2999-01-01"), "ready")


class Switch(unittest.TestCase):
    def test_off_unless_asked(self):
        with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": ""}):
            self.assertFalse(silver_obt.enabled())
        with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": "Silver "}):
            self.assertTrue(silver_obt.enabled())

    def test_what_the_contract_cannot_answer_stays_on_gold_db(self):
        ctx = mock.Mock(card=False, surface="global", q={}, release={"release_id": 1, "version": 1})
        ctx.mention = None
        source = silver_obt.ObtForContext(ctx)
        source.gold = mock.Mock()
        source.gold.acr_duel_counts = mock.AsyncMock(return_value={"rows": []})
        self.assertEqual(asyncio.run(source.acr_duel_counts()), {"rows": []})
        source.gold.acr_duel_counts.assert_awaited_once()

    def test_a_drill_it_has_no_scope_for_stays_on_gold_db(self):
        ctx = mock.Mock(card=False, surface="global", q={"cf.x": "1"}, release={"release_id": 1, "version": 1})
        ctx.mention = None
        source = silver_obt.ObtForContext(ctx)
        source.gold = mock.Mock()
        source.gold.tone_counts = mock.AsyncMock(return_value={})
        asyncio.run(source.tone_counts())
        source.gold.tone_counts.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
