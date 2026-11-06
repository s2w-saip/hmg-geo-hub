"""The query tables' load job (metrics/query_load.py): what it decides on its own. The rows themselves are checked against gold_db, by column, on real rounds (진행 기록)."""
from __future__ import annotations

import asyncio
import unittest
from datetime import date

from data_server.metrics import query_load as q

DAY = date(2026, 10, 5)


class ToLoad(unittest.TestCase):
    PUBLIC = [{"snapshot_id": "s1", "cycle_id": "c1", "round_date": DAY, "rule_version": "r", "surface": "global"},
              {"snapshot_id": "s2", "cycle_id": "c2", "round_date": date(2026, 10, 9), "rule_version": "r", "surface": "website"}]

    def test_a_new_cycle_and_a_moved_snapshot_are_loaded_and_the_rest_stays(self):
        self.assertEqual([s.cycle_id for s in q.to_load(self.PUBLIC, {"c1": ("old", "d"), "c2": ("s2", "d")}, "d")], ["c1"])
        self.assertEqual([s.cycle_id for s in q.to_load(self.PUBLIC, {}, "d")], ["c1", "c2"])
        self.assertEqual(q.to_load(self.PUBLIC, {"c1": ("s1", "d"), "c2": ("s2", "d")}, "d"), [])

    def test_other_inputs_load_a_cycle_again(self):
        self.assertEqual([s.cycle_id for s in q.to_load(self.PUBLIC, {"c1": ("s1", "old"), "c2": ("s2", "d")}, "d")], ["c1"])

    def test_surfaces_and_rounds_narrow_a_trial(self):
        self.assertEqual([s.cycle_id for s in q.to_load(self.PUBLIC, {}, "d", ["website"])], ["c2"])
        self.assertEqual([s.cycle_id for s in q.to_load(self.PUBLIC, {}, "d", None, [DAY])], ["c1"])


class OwnerOf(unittest.TestCase):
    """One address can be the base of several markets."""
    BASES = [(10, "KR"), (20, "US")]

    def test_no_match_is_no_owner(self):
        self.assertEqual(q.owner_of([], 7, "US", "US"), 0)

    def test_the_extractions_country_decides_first(self):
        self.assertEqual(q.owner_of(self.BASES, 10, "US", "KR"), 20)

    def test_then_what_the_url_holds_then_the_market(self):
        self.assertEqual(q.owner_of(self.BASES, 10, None, "US"), 10)
        self.assertEqual(q.owner_of(self.BASES, 99, None, "US"), 20)
        self.assertEqual(q.owner_of(self.BASES, None, None, "JP"), 10)


class Dimensions(unittest.TestCase):
    def dims(self) -> q.Dims:
        d = q.Dims(brands={"Kia": 2}, bares={"kia": 2}, entities={"e1": (5, 2, None, "Sorento")}, sources={"kia.com": 3}, categories={"Rule": 7, "": 13})
        d.next_keys = {"brand": 100, "entity": 200, "source": 300}
        return d

    def test_a_known_brand_is_found_by_name_or_bare_and_the_sentinel_is_key_zero(self):
        d = self.dims()
        self.assertEqual(d.brand("Kia", 2, DAY), 2)
        self.assertEqual(d.brand(" KIA ", 2, DAY), 2)
        self.assertEqual(d.brand("(이름 없음)", 0, DAY), 0)
        self.assertIsNone(d.brand("  ", 0, DAY))
        self.assertEqual(d.new_brands, [])

    def test_a_new_brand_is_judged_by_the_dictionary(self):
        d = self.dims()
        self.assertEqual(d.brand("Apple", 0, DAY), 101)
        self.assertEqual(d.brand("Nio", 0, DAY), 102)
        self.assertEqual([row[3] for row in d.new_brands], [3, 2])

    def test_a_new_entity_takes_a_brands_name_but_no_products(self):
        d = self.dims()
        self.assertEqual(d.entity("e1", "Product", "Kia", None, {}, DAY), 5)
        self.assertEqual(d.entity("e2", "Brand", "Kia", None, {}, DAY), 201)
        self.assertEqual(d.entity("e3", "Product", "Kia", "own", {}, DAY), 202)
        self.assertEqual([(row[4], row[3]) for row in d.new_entities], [("Kia", None), (None, "own")])

    def test_a_new_source_is_social_by_legacys_rule_and_holds_no_marks(self):
        d = self.dims()
        self.assertEqual(d.source("kia.com", "kia.com", "Rule", "rule", "v"), 3)
        self.assertEqual(d.source("", "x.com", "Rule", "rule", "v"), 0)
        self.assertEqual(d.source("youtube.com/@kia", "youtube.com", "Rule", "rule", "v"), 301)
        self.assertEqual(d.source("new.com", "new.com", "Nope", None, "v"), 302)
        rows = d.new_sources
        self.assertEqual((rows[0][3], rows[0][4], rows[0][5], rows[0][6], rows[0][7]), (True, 7, 5, 0, None))
        self.assertEqual((rows[1][3], rows[1][4], rows[1][5]), (False, 13, 6))


class Prompts(unittest.TestCase):
    TAXONS = {("funnel", "F", None): 1, ("presence", "branded", None): 2, ("list_type", "L", None): 3, ("depth1", "A", None): 10, ("depth2", "B", 10): 20, ("depth3", "C", 20): 30, ("depth3", "C", 99): 31}

    def test_a_depth_is_found_under_its_parent(self):
        keys = q.taxon_keys({"funnel": "F", "brand_presence": "branded", "list_type": "L", "depth1": "A", "depth2": "B", "depth3": "C"}, self.TAXONS)
        self.assertEqual((keys["funnel_key"], keys["presence_key"], keys["list_type_key"], keys["depth1_key"], keys["depth2_key"], keys["depth3_key"]), (1, 2, 3, 10, 20, 30))
        self.assertIsNone(q.taxon_keys({"depth3": "C"}, self.TAXONS)["depth3_key"])

    def test_a_prompts_values(self):
        v = q.prompt_values("현대 https", {"kind": "acr", "language": "ko", "target_url": "https://www.Kia.com/a/", "catalogs": [{"brand_bit": 1}, {"brand_bit": 2}, {"brand_bit": 2}], "regions": ["KR"]}, {"ko": 7}, {})
        self.assertEqual((v["lang_key"], v["targets"], v["cat_mask"], v["regions"], v["is_korean"]), (7, ["kia.com/a"], 3, ["KR"], True))
        self.assertEqual(q.prompt_values("x", {}, {}, {})["targets"], None)

    def test_a_builds_catalog_is_every_row_with_a_known_prompt(self):
        prompts = [{"id": "p1", "catalogs": [{"catalog_row_id": "r1", "brand_bit": 2, "kind": "single", "funnel": "F", "brand_presence": "branded", "list_type": "L", "depth1": "A", "depth2": "B", "depth3": "C"}]},
                   {"id": "gone", "catalogs": [{"catalog_row_id": "r2"}]}]
        self.assertEqual(q.catalog_rows(prompts, {"p1": 9}, self.TAXONS), [("r1", 9, 2, "single", 2, 1, 3, 10, 20, 30, None)])

    def test_regions_are_a_set_and_empty_is_none(self):
        self.assertTrue(q.same_value("regions", ["US", "KR"], ["KR", "US"]))
        self.assertTrue(q.same_value("targets", [], None))
        self.assertFalse(q.same_value("text", "a", "b"))


class Digest(unittest.TestCase):
    @staticmethod
    def inputs(order, group=3):
        rows = {"p1": (True, False, "", False, False, group), "p2": (False, True, "KR", True, True, 1)}
        return q.Inputs(order, [None] * 2, [], *([rows[p][i] for p in order] for i in range(6)), ["XX"], {"kia": 2}, {"e": 2}, {"s": ("KR", 1)}, {}, {}, ["x"])

    def test_the_order_rows_come_in_does_not_load_everything_again(self):
        self.assertEqual(q.inputs_digest(self.inputs(["p1", "p2"])), q.inputs_digest(self.inputs(["p2", "p1"])))

    def test_a_change_the_stored_judgments_rest_on_does(self):
        self.assertNotEqual(q.inputs_digest(self.inputs(["p1", "p2"])), q.inputs_digest(self.inputs(["p1", "p2"], group=1)))


class EntityTotals(unittest.TestCase):
    """Admin › 엔티티 lists the entities with totals: legacy counts brands with a display name there, not every product and feature."""

    def test_only_a_named_brand_gets_a_total(self):
        class Conn:
            sql: list[str] = []

            def transaction(self):
                conn = self

                class T:
                    async def __aenter__(self):
                        return conn

                    async def __aexit__(self, *_):
                        return False
                return T()

            async def execute(self, sql, *_):
                self.sql.append(sql)

        asyncio.run(q.refresh_entity_totals(Conn()))
        insert = next(s for s in Conn.sql if "INSERT INTO gold.entity_mention_total" in s)
        self.assertIn("entity_type='Brand'", insert)
        self.assertIn("display_name IS NOT NULL", insert)


class Small(unittest.TestCase):
    def test_a_json_column(self):
        self.assertEqual(q.array('[{"a": 1}]'), [{"a": 1}])
        self.assertEqual(q.array(None), [])
        self.assertEqual(q.array("null"), [])

    def test_a_finished_answer_is_status_zero(self):
        self.assertEqual(q.status_code("completed"), 0)
        self.assertEqual(q.status_code("failed"), 2)

    def test_a_urls_key_is_legacys_hash(self):
        self.assertEqual(q.sha("https://kia.com")[:8], __import__("hashlib").sha256(b"https://kia.com").hexdigest()[:8])


if __name__ == "__main__":
    unittest.main()
