"""The Gold import (back/hub_storage/sync_catalog.py): which values it records, the checks that refuse a
mixed or undecodable read, the guards against mass removal or rewrite, and the HUB code tables matching the
BFF's own constants. Pure functions only; the run itself is exercised by manage.py sync-gold-catalog."""
import importlib.util
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

try:
    from bff.gold_reader import context, metrics
    spec = importlib.util.spec_from_file_location("sync_catalog", Path(__file__).resolve().parents[2] / "hub_storage" / "sync_catalog.py")
    sync = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sync)
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_hub_sync)") from exc

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)
TAXA = {name: None for name, _ in sync.TAXON_COLUMNS} | {f"{name}_key": None for name, _ in sync.TAXON_COLUMNS}


def gold(**over):
    """A minimal consistent Gold read: one Global and one website project with a prompt each."""
    g_project, w_project = uuid4(), uuid4()
    g = {
        "versions": {"dim": 10, "prompt": 3},
        "projects": [{"id": g_project, "scope_project_id": None, "source_project_id": g_project, "site_id": None, "surface": 1,
                      "is_root": True, "site_brand_bit": 0, "site_geo_key": None, "country": None, "regions": None},
                     {"id": w_project, "scope_project_id": None, "source_project_id": None, "site_id": uuid4(), "surface": 2,
                      "is_root": False, "site_brand_bit": 2, "site_geo_key": 5, "country": "KR", "regions": ["KR"]}],
        "prompts": [{"id": uuid4(), "project_id": g_project, "text": "SUV 추천", "surface": 1, "kind": "acr", "lang_key": 1,
                     "language": "ko", "regions": ["US", "KR"], "targets": None, "in_root_catalog": True, "in_project_catalog": False,
                     "web_reg": False, "unit_file_seq": None, "unit_key": None, **TAXA, "funnel": "인지", "funnel_key": 3},
                    {"id": uuid4(), "project_id": w_project, "text": "EV 충전", "surface": 2, "kind": "single", "lang_key": 1,
                     "language": "ko", "regions": None, "targets": ["kia.com/kr/ev"], "in_root_catalog": False, "in_project_catalog": False,
                     "web_reg": True, "unit_file_seq": 7, "unit_key": 70, **TAXA}],
        "catalog": [], "catalog_expected": 0, "custom_fields": [], "custom_values": [],
        "units": [{"project_id": w_project, "file_seq": 7, "lang_codes": ["ko"], "base": "kia.com/kr", "base_src": "decl"}],
        "targets": [{"project_id": w_project, "lang_key": 1, "url_norm": "kia.com/kr/ev", "url": "https://www.kia.com/kr/ev/"}],
        "release": {"release_id": 1},
        "reference": {"engine": [], "region": [], "country": [{"code": "KR", "region": "AS", "kind": "real", "hidden_standard": False,
                      "virtual_brand_bit": 0}], "language": [], "taxon": [], "brand": [{"name": "Kia", "bare": "kia", "own_bit": 2}],
                      "entity": [], "source_category": [], "source": [], "owned_base": [], "crawl_bot": [], "keyword": [],
                      "perspective": [{"own_bits": 3, "label": "HMG"}], "population": []},
    }
    g.update(over)
    return g


class CodeTables(unittest.TestCase):
    def test_the_hub_code_tables_match_the_bff(self):
        self.assertEqual({v: k for k, v in context.SURFACES.items()}, sync.SURFACES)
        for name, bit in context.BRANDS.items():
            if bit in context.BRAND_NAMES:
                self.assertEqual(sync.BRAND_BITS[bit], name)
        self.assertEqual(tuple(metrics.TYPES), sync.MENTION_TYPES)


class Checks(unittest.TestCase):
    def refused(self, g, previous=None):
        with self.assertRaises(sync.Refused) as cm:
            sync.check_read(g, previous)
        return str(cm.exception)

    def test_a_consistent_read_passes(self):
        sync.check_read(gold(), {"dim": 10, "prompt": 2})

    def test_signs_of_a_reload_in_progress_refuse(self):
        self.assertIn("went back", self.refused(gold(), {"dim": 11}))
        g = gold()
        g["prompts"][0]["depth1_key"] = 99            # a key whose taxon row is from another generation
        self.assertIn("no code", self.refused(g))
        g = gold()
        g["prompts"][1]["unit_file_seq"] = None
        self.assertIn("unit", self.refused(g))
        self.assertIn("catalog_entry", self.refused(gold(catalog_expected=5)))
        g = gold()
        g["projects"][1]["country"] = None
        self.assertIn("Country", self.refused(g))

    def test_codes_the_hub_cannot_decode_refuse(self):
        g = gold()
        g["projects"][0]["surface"] = 4
        self.assertIn("surface", self.refused(g))
        g = gold()
        g["reference"]["country"][0]["virtual_brand_bit"] = 32
        self.assertIn("brand bit", self.refused(g))
        g = gold()
        g["projects"][1]["site_brand_bit"] = 16 | 2   # Hyundai N is known
        sync.check_read(g, None)


class Definitions(unittest.TestCase):
    def test_projects_keep_inputs_only(self):
        g = gold(units=[{"project_id": None, "file_seq": 1, "lang_codes": [], "base": None, "base_src": None}])
        w = g["projects"][1]["id"]
        g["units"] = [{"project_id": w, "file_seq": 8, "lang_codes": ["en", "ar"], "base": "guessed.com", "base_src": "heur"},
                      {"project_id": w, "file_seq": 7, "lang_codes": ["ko"], "base": "kia.com/kr", "base_src": "decl"}]
        g["custom_fields"] = [{"field_id": uuid4(), "project_id": None, "label": "leftover", "archived": False, "created_at": NOW},
                              {"field_id": uuid4(), "project_id": w, "label": "차종", "archived": False, "created_at": NOW}]
        d = sync.project_definitions(g)[w]
        self.assertEqual(d["web"]["units"], [{"file_seq": 7, "lang_codes": ["ko"], "base": "kia.com/kr", "base_src": "decl"},
                                             {"file_seq": 8, "lang_codes": ["ar", "en"], "base": None, "base_src": "heur"}])
        self.assertEqual([f["label"] for f in d["custom_fields"]], ["차종"])
        self.assertEqual((d["status"], d["brands"], d["domain"]), ("active", None, None))
        self.assertNotIn("custom_fields", sync.project_definitions(g)[g["projects"][0]["id"]])

    def test_prompts_carry_catalogs_units_target_urls_and_custom_values(self):
        g = gold()
        gp, wp = g["prompts"][0]["id"], g["prompts"][1]["id"]
        g["catalog"] = [{"catalog_row_id": "b", "prompt_id": gp, "brand_bit": 2, "kind": "acr", **TAXA, "depth1": "SUV"},
                        {"catalog_row_id": "a", "prompt_id": gp, "brand_bit": 1, "kind": "acr", **TAXA}]
        field = uuid4()
        g["custom_values"] = [{"prompt_id": wp, "field_id": field, "value": "EV"}]
        out = sync.prompt_definitions(g)
        text, d = out[gp]
        self.assertEqual((text, [c["catalog_row_id"] for c in d["catalogs"]], d["regions"]), ("SUV 추천", ["a", "b"], ["KR", "US"]))
        self.assertNotIn("rule_ver", d)
        _, w = out[wp]
        self.assertEqual((w["unit_file_seq"], w["target_url"], w["custom_values"]), (7, "https://www.kia.com/kr/ev/", {str(field): "EV"}))
        self.assertNotIn("targets", w)
        self.assertNotIn("catalogs", w)

    def test_a_target_that_is_not_one_registered_url_refuses(self):
        g = gold()
        g["targets"] = []
        with self.assertRaises(sync.Refused):
            sync.prompt_definitions(g)
        g = gold()
        g["targets"].append({**g["targets"][0], "url": "https://kia.com/kr/ev"})   # two spellings, one url_norm
        with self.assertRaises(sync.Refused):
            sync.prompt_definitions(g)

    def test_taxon_keys_are_paths(self):
        rows = [{"taxon_key": 1, "axis": "depth1", "code": "SUV", "parent_key": None},
                {"taxon_key": 2, "axis": "depth1", "code": "Sedan", "parent_key": None},
                {"taxon_key": 3, "axis": "depth2", "code": "RAV4", "parent_key": 1},
                {"taxon_key": 4, "axis": "depth2", "code": "RAV4", "parent_key": 2}]
        items = sync.taxon_items(rows)
        self.assertEqual(len(items), 4)
        self.assertEqual(items['["depth2","SUV","RAV4"]'], {"axis": "depth2", "code": "RAV4", "path": ["SUV"]})

    def test_reference_values_are_inputs_and_hash_the_same_in_any_order(self):
        g = gold()
        g["reference"]["source"] = [{"skey": "x.com", "domain": "x.com", "is_social": False, "category": "news", "category_src": 4}]
        g["reference"]["keyword"] = [{"term": "EV", "term_norm": "ev", "location_code": 2410, "language_code": "ko"},
                                     {"term": "EV", "term_norm": "ev", "location_code": 2840, "language_code": "en"},
                                     {"term": "EV", "term_norm": "ev", "location_code": 2410, "language_code": "ko"}]
        items = sync.reference_items(g)
        self.assertEqual(items["source"]["x.com"]["category_src"], "seed")
        self.assertEqual(items["keyword"]["ev"]["conditions"], [{"location_code": 2410, "language_code": "ko"},
                                                                {"location_code": 2840, "language_code": "en"}])
        self.assertEqual(items["brand_bit"]["16"], {"bit": 16, "code": "hyundai-n"})
        g["reference"]["keyword"].reverse()
        self.assertEqual(sync.family_digest(items["keyword"]), sync.family_digest(sync.reference_items(g)["keyword"]))


class Guards(unittest.TestCase):
    def rows(self, n, origin="gold", status="active"):
        return {uuid4(): {"origin": origin, "status": status} for _ in range(n)}

    def test_removal_needs_two_runs_far_enough_apart(self):
        current = self.rows(3)
        missing = sorted(str(i) for i in current)
        present = set()
        candidates, now_removed = sync.removals(current, present, None, None, NOW)
        self.assertEqual((candidates, now_removed), (missing, []))
        too_soon = NOW - timedelta(minutes=sync.CONFIRM_MINUTES - 1)
        self.assertEqual(sync.removals(current, present, missing, too_soon, NOW)[1], [])
        earlier = NOW - timedelta(minutes=sync.CONFIRM_MINUTES)
        self.assertEqual(sync.removals(current, present, missing[:2], earlier, NOW)[1], missing[:2])

    def test_hub_items_and_already_removed_ones_are_never_candidates(self):
        current = {**self.rows(2, origin="hub"), **self.rows(2, status="removed")}
        self.assertEqual(sync.removals(current, set(), None, None, NOW), ([], []))

    def test_mass_removal_and_mass_rewrite_refuse_unless_allowed(self):
        totals = {"gold_items": 10_000, "project_prompts": {}}
        base = {"project_candidates": 0, "prompt_candidates": 0, "new_project_versions": 0, "new_prompt_versions": 0}
        sync.guard({**base, "prompt_candidates": 100}, [], {}, totals, 0, False)            # max(20, 1%) = 100
        with self.assertRaises(sync.Refused):
            sync.guard({**base, "prompt_candidates": 101}, [], {}, totals, 0, False)
        sync.guard({**base, "prompt_candidates": 101}, [], {}, totals, 101, False)
        project = uuid4()
        small = {"gold_items": 10_000, "project_prompts": {project: 40}}
        ids = [str(uuid4()) for _ in range(5)]
        with self.assertRaises(sync.Refused):
            sync.guard({**base, "prompt_candidates": 5}, ids, dict.fromkeys(ids, project), small, 0, False)
        with self.assertRaises(sync.Refused):
            sync.guard({**base, "new_prompt_versions": 501}, [], {}, totals, 0, False)
        sync.guard({**base, "new_prompt_versions": 501}, [], {}, totals, 0, True)


if __name__ == "__main__":
    unittest.main()
