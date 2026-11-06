"""The Gold import (back/hub_storage/sync_catalog.py): which values it records, the checks that refuse a
mixed or undecodable read, the guards against mass removal or rewrite, and the HUB code tables matching the
BFF's own constants. Pure functions only; the run itself is exercised by manage.py sync-gold-catalog."""
import asyncio
import importlib.util
import json
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

try:
    from data_server.gold_reader import context, metrics
    spec = importlib.util.spec_from_file_location("sync_catalog", Path(__file__).resolve().parents[2] / "hub_storage" / "sync_catalog.py")
    sync = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sync)
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_hub_sync)") from exc

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
        "catalog": [], "catalog_expected": 0, "custom_fields": [], "custom_values": [], "measured": [],
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


class Recorded:
    """The data connection record() talks to: the current catalog rows it reads, the inserts it would make."""

    def __init__(self, projects, prompts):
        self.rows = {sync.CURRENT_PROJECTS_SQL: projects, sync.CURRENT_PROMPTS_SQL: prompts, sync.CURRENT_SETS_SQL: []}
        self.inserts, self.published = {}, []

    async def execute(self, *args):
        return None

    async def fetch(self, query, *args):
        if "publish_reference_source" in query:
            self.published.append(args[0])
            return []
        return self.rows.get(query, [])

    async def executemany(self, query, rows):
        self.inserts[query.split("(")[0].split()[-1]] = list(rows)


class InputStore(unittest.TestCase):
    """2026-11-06 (input-002): Gold gives the first values of the families the store owns and of a project's settings, once."""

    def test_first_values_come_from_gold_once(self):
        g = gold()
        conn = Recorded({}, {})
        asyncio.run(sync.record(conn, g, None, {"expect_mass_change": True}, NOW))
        families = {row[0] for row in conn.inserts["catalog.reference_source"]}
        self.assertLessEqual(families, set(sync.SOURCE_FAMILIES))
        self.assertEqual(conn.published, list(sync.SOURCE_FAMILIES))
        self.assertTrue(set(r[1] for r in conn.inserts["catalog.reference_set"]).isdisjoint(sync.SOURCE_FAMILIES))
        held = Recorded({}, {})
        held.rows["SELECT DISTINCT family FROM catalog.reference_source"] = [{"family": f} for f in sync.SOURCE_FAMILIES]
        asyncio.run(sync.record(held, g, None, {"expect_mass_change": True}, NOW))
        self.assertEqual((held.inserts["catalog.reference_source"], held.published), ([], []))

    def test_settings_take_what_gold_holds_and_leave_the_rest_empty(self):
        site, project = uuid4(), uuid4()
        g = gold()
        base = {"scope_project_id": uuid4(), "source_project_id": None, "site_id": None, "is_root": False, "site_geo_key": None, "regions": None}
        g["projects"] = [{**base, "id": site, "surface": 2, "site_brand_bit": 2, "country": "KR"}, {**base, "id": project, "surface": 3, "site_brand_bit": 0, "country": None}]
        g["units"] = [{"project_id": site, "file_seq": 7, "lang_codes": ["ko"], "base": "kia.com/kr", "base_src": "decl"},
                      {"project_id": site, "file_seq": 8, "lang_codes": ["en"], "base": "guess.example", "base_src": "heur"}]
        g["measured"] = [{"project_id": site, "engines": ["gemini", "chatgpt"], "countries": ["KR"]}]
        g["reference"]["owned_base"] = [{"kind": "base", "prefix": "kia.com/kr", "host": "kia.com", "brand_code": "Kia", "brand_bit": 2, "geo_code": "KR", "language": "ko"},
                                        {"kind": "base", "prefix": "kia.com/us", "host": "kia.com", "brand_code": "Kia", "brand_bit": 2, "geo_code": "US", "language": "en"}]
        settings = sync.measurement_settings(g)
        self.assertEqual(settings[site]["brands"], ["kia"])
        self.assertEqual(settings[site]["engines"], ["chatgpt", "gemini"])
        self.assertEqual(settings[site]["owned_urls"], ["kia.com/kr"])
        self.assertEqual([u["base"] for u in settings[site]["web_units"]], ["kia.com/kr", None])  # an inferred base is left out
        self.assertEqual((settings[site]["cadence"], settings[site]["acr_repeats"], settings[site]["tracked_urls"], settings[site]["tracked_targets"]), (None, None, [], []))
        self.assertEqual((settings[project]["brands"], settings[project]["countries"], settings[project]["engines"]), ([], [], []))


class HubOwned(unittest.TestCase):
    """2026-11-03 (data-012): a HUB-edited or HUB-made item keeps its HUB keys; Gold's own keys still follow Gold."""

    def test_owned_keeps_the_hub_keys_and_takes_golds_others(self):
        gold_def = {"surface": 3, "kind": "single", "status": "active", "in_project_catalog": False, "custom_values": {"f": "AI"}}
        hub_def = {"surface": 3, "kind": "acr", "status": "paused", "in_project_catalog": True}
        merged = sync.owned(gold_def, hub_def, sync.PROMPT_HUB_KEYS)
        self.assertEqual(merged, {"surface": 3, "kind": "acr", "status": "paused", "in_project_catalog": False})  # cleared tags stay cleared

    def test_hub_owned_prompts_are_never_removal_candidates(self):
        current = {uuid4(): {"origin": "gold", "status": "active", "hub_owned": True}, uuid4(): {"origin": "gold", "status": "active"}}
        plain = sorted(str(i) for i, r in current.items() if not r.get("hub_owned"))
        self.assertEqual(sync.removals(current, set(), None, None, NOW, hub_status=True)[0], plain)
        self.assertEqual(len(sync.removals(current, set(), None, None, NOW)[0]), 2)   # projects: Gold's status

    def test_the_import_records_golds_keys_under_the_hubs(self):
        project, prompt = uuid4(), uuid4()
        g = gold()
        g["projects"].append({"id": project, "scope_project_id": uuid4(), "source_project_id": project, "site_id": None, "surface": 3,
                              "is_root": False, "site_brand_bit": 0, "site_geo_key": None, "country": None, "regions": None})
        g["prompts"].append({"id": prompt, "project_id": project, "text": "Gold text", "surface": 3, "kind": "single", "lang_key": None,
                             "language": "", "regions": None, "targets": None, "in_root_catalog": False, "in_project_catalog": False,
                             "web_reg": False, "unit_file_seq": None, "unit_key": None, **TAXA})
        projects = sync.project_definitions(g)
        prompts = sync.prompt_definitions(g)
        hub_fields = [{"field_id": "h", "label": "HUB tag", "archived": False, "created_at": "2026-11-03"}]
        project_row = {"id": project, "origin": "gold", "source_id": project, "version": 2, "sha256": "x", "hub_owned": True,
                       "definition": {**projects[project], "custom_fields": hub_fields, "regions": ["stale"]}}
        prompt_row = {"id": prompt, "project_id": project, "origin": "gold", "source_id": prompt, "version": 4, "sha256": "x",
                      "hub_owned": True, "text": "HUB text",
                      "definition": {**prompts[prompt][1], "status": "paused", "in_project_catalog": True, "custom_values": {"h": "AI"}}}
        others = [{"id": p["id"], "origin": "gold", "source_id": p["id"], "version": 1, "hub_owned": False,
                   "sha256": sync.digest(projects[p["id"]]), "definition": projects[p["id"]]} for p in g["projects"] if p["id"] != project]
        conn = Recorded([*others, project_row], [prompt_row])
        counts, _ = asyncio.run(sync.record(conn, g, None, {}, NOW))
        (pid, version, definition, _), = [r for r in conn.inserts["catalog.project_version"] if r[0] == project]
        definition = json.loads(definition)
        self.assertEqual((version, definition["custom_fields"], definition["regions"]), (3, hub_fields, None))
        (qid, version, text, definition, _), = [r for r in conn.inserts["catalog.prompt_version"] if r[0] == prompt]
        definition = json.loads(definition)
        self.assertEqual((version, text, definition["status"], definition["in_project_catalog"], definition["custom_values"]),
                         (5, "HUB text", "paused", False, {"h": "AI"}))
        self.assertEqual(counts["prompt_candidates"], 0)

    def test_a_hub_prompt_gold_measured_is_kept_and_another_projects_refuses(self):
        g = gold()
        hub_id = g["prompts"][1]["id"]
        row = {"id": hub_id, "project_id": g["prompts"][1]["project_id"], "origin": "hub", "source_id": None, "version": 1,
               "sha256": "x", "hub_owned": True, "text": "HUB", "definition": {"status": "active", "kind": "acr"}}
        conn = Recorded([], [row])
        asyncio.run(sync.record(conn, g, None, {}, NOW))
        (_, _, text, definition, _), = [r for r in conn.inserts["catalog.prompt_version"] if r[0] == hub_id]
        self.assertEqual((text, json.loads(definition)["kind"], json.loads(definition)["web_reg"]), ("HUB", "acr", True))
        with self.assertRaises(sync.Refused):
            asyncio.run(sync.record(Recorded([], [{**row, "project_id": uuid4()}]), g, None, {}, NOW))


if __name__ == "__main__":
    unittest.main()
