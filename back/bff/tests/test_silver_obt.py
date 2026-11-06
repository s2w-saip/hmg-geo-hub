"""Adapter ②: it reads contract columns only, runs the rules of bff.metrics.judgments, and stays off unless asked. The numbers against geohub_gold_db are a live comparison: a fake
connection answers here, and HGH_SILVER_TEST lets the last test read the stand-in."""
import asyncio
import os
import unittest
from datetime import date
from unittest import mock

from bff.metrics import judgments, silver_obt
from bff.metrics.catalog import MONITORING
from bff.metrics.silver_obt import Inputs, Scope, SilverObtSource, merge


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


class Switch(unittest.TestCase):
    def test_off_unless_asked(self):
        with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": ""}):
            self.assertFalse(silver_obt.enabled())
        with mock.patch.dict(os.environ, {"HGH_METRIC_SOURCE": "Silver "}):
            self.assertTrue(silver_obt.enabled())

    def test_what_the_contract_cannot_answer_stays_on_geohub_gold_db(self):
        ctx = mock.Mock(card=False, surface="global", q={}, release={"release_id": 1, "version": 1})
        ctx.mention = None
        source = silver_obt.ObtForContext(ctx)
        source.gold = mock.Mock()
        source.gold.acr_duel_counts = mock.AsyncMock(return_value={"rows": []})
        self.assertEqual(asyncio.run(source.acr_duel_counts()), {"rows": []})
        source.gold.acr_duel_counts.assert_awaited_once()

    def test_a_drill_it_has_no_scope_for_stays_on_geohub_gold_db(self):
        ctx = mock.Mock(card=False, surface="global", q={"cf.x": "1"}, release={"release_id": 1, "version": 1})
        ctx.mention = None
        source = silver_obt.ObtForContext(ctx)
        source.gold = mock.Mock()
        source.gold.tone_counts = mock.AsyncMock(return_value={})
        asyncio.run(source.tone_counts())
        source.gold.tone_counts.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
