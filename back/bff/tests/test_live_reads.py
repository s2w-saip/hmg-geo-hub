"""Read-only integration checks against the explicitly selected local Gold API."""
import json
import os
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from jsonschema import Draft202012Validator

BASE = os.environ.get("HGH_GOLD_TEST_BASE_URL")
CONTRACT = json.loads((Path(__file__).parents[1] / "api-contract.json").read_text(encoding="utf-8"))


@unittest.skipUnless(BASE, "Set HGH_GOLD_TEST_BASE_URL to the local read-only API")
class GoldLiveReads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for attempt in range(20):
            try:
                with urlopen(BASE + "/healthz", timeout=2) as response:
                    if response.status == 200:
                        return
            except OSError:
                time.sleep(0.5)
        raise RuntimeError("Gold API did not become ready")

    def read(self, route):
        with urlopen(BASE + route, timeout=35) as response:
            return json.load(response)

    def test_reader_is_read_only(self):
        health = self.read("/healthz")
        self.assertEqual(health["database"], "gold")
        self.assertEqual(health["role"], "geo_readonly")
        self.assertEqual(health["read_only"], "on")

    def test_write_methods_are_rejected(self):
        for method in ("POST", "PATCH", "PUT", "DELETE"):
            with self.subTest(method=method):
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(BASE + "/v1/projects", method=method), timeout=5)
                self.assertEqual(error.exception.code, 405)

    def test_keyword_and_social_families(self):
        for tab in ("volume", "serp", "suggestions"):
            payload = self.read(f"/v1/gold/keywords?tab={tab}&limit=2")
            self.assertEqual(payload["data"]["tab"], tab)
            self.assertEqual(payload["meta"]["gold"]["database"], "gold")
            self.assertGreater(payload["meta"]["page"]["total"], 0)
        social = self.read("/v1/gold/social?limit=2")
        self.assertTrue(social["data"]["snapshot"]["is_active"])
        entity = social["data"]["items"][0]["id"]
        detail = self.read(f"/v1/gold/social?entity={entity}&limit=1")
        self.assertEqual(detail["data"]["detail"]["entity"]["id"],entity)
        for tab in ("requirements", "combinations", "relations", "research"):
            self.assertEqual(self.read(f"/v1/gold/social?tab={tab}&limit=1")["data"]["tab"],tab)

    def test_analytics_has_its_own_read_only_source(self):
        health = self.read("/healthz")["analytics"]
        self.assertTrue(health["ok"])
        self.assertEqual(health["database"],"hmg_analytics")
        self.assertEqual(health["role"],"hmg_analytics_reader")
        self.assertEqual(health["read_only"],"on")
        for kind in ("conversion", "visibility"):
            result = self.read(f"/v1/analytics/{kind}")
            self.assertEqual(result["meta"]["source"],"hub_analytics")
            if not result["meta"]["available"]:
                self.assertTrue(all(v is None for v in result["data"]["metrics"].values()))

    def test_domain_detail_url_country(self):
        # DetailUrl.country: the owned base's country code for an own official URL, else null (Gold dim_owned_base.geo_code)
        urls = self.read("/v1/citations/domains/hyundai.com?surface=global&urls_limit=100")["data"]["urls"]
        self.assertTrue(urls)
        self.assertTrue(all("country" in u for u in urls))
        codes = {u["country"] for u in urls} - {None}
        self.assertTrue(codes)
        self.assertTrue(all(len(c) == 2 and c.isupper() for c in codes), sorted(codes))

    def test_primary_contracts(self):
        paths = ("filters/options", "filters/dates", "kpi/summary", "kpi/engines", "mentions/brands",
                 "trend", "citations/domains", "citations/sources", "funnel/acr", "prompts", "answers",
                 "geo", "mentions/types", "kpi/compare", "mentions/prompts", "citations/prompts", "citations/sources/tone")
        for path in paths:
            for surface in ("global", "website"):
                with self.subTest(path=path, surface=surface):
                    payload = self.read(f"/v1/{path}?surface={surface}&card=true&limit=3")
                    route = next(r for r in CONTRACT["routes"] if r["path"] == "/v1/" + path)
                    schema = {"components": {"schemas": CONTRACT["schemas"]}, **route["response"]}
                    errors = sorted(Draft202012Validator(schema).iter_errors(payload), key=lambda e: str(e.path))
                    self.assertFalse(errors, "\n".join(f"{list(e.path)}: {e.message[:250]}" for e in errors[:8]))
                    self.assertEqual(payload["meta"]["gold"]["database"], "gold")
                    self.assertGreater(payload["meta"]["gold"]["release_id"], 0)


if __name__ == "__main__":
    unittest.main()
