"""Measurement settings on Project › Setting (hub_stores/measurement.py) and the cache DB's key and purge (hub_stores/cache_db.py). The
roles and CHECKs are asserted against PostgreSQL in back/hub_storage/verify-input.sql and verify-metrics.sql."""
import asyncio
import json
import os
import unittest
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

try:
    from fastapi import HTTPException

    from bff.hub_stores import cache_db, measurement as m
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run with back/ on the path and the API requirements installed") from exc

ACTOR = SimpleNamespace(user_id=uuid4())
OPTIONS = [{"family": "engine", "item_key": "chatgpt", "definition": {"code": "chatgpt"}}, {"family": "country", "item_key": "KR", "definition": {"code": "KR"}},
           {"family": "brand_bit", "item_key": "2", "definition": {"bit": 2, "code": "kia"}}]


class Conn:
    def __init__(self, store):
        self.store = store

    async def fetchrow(self, sql, project):
        if project != self.store["project"]:
            return None
        return self.store["rows"][-1] if self.store["rows"] else {"version": None, "sha256": None}

    async def fetch(self, sql):
        return OPTIONS

    async def execute(self, sql, *a):
        self.store["rows"].append({"version": a[1], "brands": a[2], "countries": a[3], "engines": a[4], "cadence": a[5], "acr_repeats": a[6], "web_units": a[7],
                                   "owned_urls": a[8], "tracked_urls": a[9], "tracked_targets": a[10], "origin": "hub", "sha256": a[11],
                                   "recorded_by": a[12], "recorded_at": datetime(2026, 11, 6, tzinfo=UTC)})


def writing(store):
    @asynccontextmanager
    async def opened():
        yield Conn(store)
    return opened


def body(**over):
    return m.MeasurementWrite(**{"expectedVersion": 0, **over})


class Settings(unittest.TestCase):
    def setUp(self):
        self.project = uuid4()
        self.store = {"project": self.project, "rows": []}

    def write(self, **over):
        with mock.patch.object(m, "writing", writing(self.store)):
            return asyncio.run(m.write(self.project, body(**over), ACTOR))

    def test_a_write_is_one_new_version_in_the_stored_spelling(self):
        out = self.write(brands=["KIA", "kia"], countries=[" kr "], engines=["ChatGPT"], cadence="weekly", acrRepeats=5,
                         ownedUrls=[" kia.com/kr ", "kia.com/kr", ""], trackedTargets=[{"kind": "brand", "name": " Toyota "}, {"kind": "brand", "name": "toyota"}])
        item = out["item"]
        self.assertTrue(out["changed"])
        self.assertEqual((item["version"], item["brands"], item["countries"], item["engines"], item["ownedUrls"]), (1, ["kia"], ["KR"], ["chatgpt"], ["kia.com/kr"]))
        self.assertEqual(item["trackedTargets"], [{"kind": "brand", "name": "Toyota"}])

    def test_the_same_settings_record_nothing(self):
        self.write(brands=["kia"])
        out = self.write(expectedVersion=1, brands=["kia"])
        self.assertEqual((out["changed"], len(self.store["rows"])), (False, 1))

    def test_a_stale_version_is_refused(self):
        self.write(brands=["kia"])
        with self.assertRaises(HTTPException) as caught:
            self.write(expectedVersion=0, brands=[])
        self.assertEqual((caught.exception.status_code, caught.exception.detail["code"]), (409, "version_conflict"))

    def test_codes_outside_the_reference_values_are_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.write(engines=["perplexity"])
        self.assertEqual((caught.exception.status_code, caught.exception.detail["details"]["unknown"]), (422, {"engines": ["perplexity"]}))

    def test_a_url_with_a_space_is_refused(self):
        with self.assertRaises(HTTPException) as caught:
            self.write(trackedUrls=["kia.com/a b"])
        self.assertEqual(caught.exception.status_code, 422)

    def test_an_unknown_project_is_not_found(self):
        self.store["project"] = uuid4()
        with self.assertRaises(HTTPException) as caught:
            self.write()
        self.assertEqual(caught.exception.status_code, 404)

    def test_no_version_yet_reads_as_empty(self):
        self.assertEqual({k: v for k, v in m.view(None).items() if v not in (None, [])}, {"version": 0})


class CacheKey(unittest.TestCase):
    def test_the_same_conditions_are_the_same_key(self):
        one = cache_db.cache_key({"country": ["US", "KR", "US"], "engine": " chatgpt ", "empty": [], "none": None}, "s1", "v1")
        two = cache_db.cache_key({"engine": "chatgpt", "country": ["KR", "US"]}, "s1", "v1")
        self.assertEqual(one, two)

    def test_another_snapshot_query_or_definition_version_is_another_key(self):
        base = cache_db.cache_key({"engine": "chatgpt"}, "s1", "v1")
        self.assertNotEqual(base, cache_db.cache_key({"engine": "chatgpt"}, "s2", "v1"))
        self.assertNotEqual(base, cache_db.cache_key({"engine": "chatgpt"}, "s1", "v2"))
        self.assertNotEqual(base, cache_db.cache_key({"engine": "gemini"}, "s1", "v1"))

    def test_without_a_store_a_read_is_a_miss(self):
        with mock.patch.object(cache_db, "_pool", None):
            self.assertIsNone(asyncio.run(cache_db.get({"a": 1}, "s", "v")))
            self.assertFalse(asyncio.run(cache_db.put({"a": 1}, "s", "v", {"n": 1})))


@unittest.skipUnless(os.environ.get("HGH_CACHE_DB_URL"), "needs the metrics store (HGH_CACHE_DB_URL)")
class CacheStore(unittest.TestCase):
    def test_put_get_and_purge(self):
        async def flow():
            await cache_db.open_pool()
            try:
                query = {"engine": ["chatgpt"], "marker": str(uuid4())}
                old, new = f"test-{uuid4()}", f"test-{uuid4()}"
                self.assertTrue(await cache_db.put(query, old, "v", '{"n": 1}'))
                self.assertTrue(await cache_db.put(query, old, "v", '{"n": 2}'))
                self.assertEqual(await cache_db.get(query, old, "v"), '{"n": 2}')
                self.assertIsNone(await cache_db.get(query, new, "v"))
                await cache_db.put(query, new, "v", '{"n": 3}')
                self.assertGreaterEqual(await cache_db.purge_other_snapshots([new]), 1)
                self.assertIsNone(await cache_db.get(query, old, "v"))
                self.assertEqual(await cache_db.purge_other_snapshots(["none"]), 1)
            finally:
                await cache_db.close_pool()
        asyncio.run(flow())


if __name__ == "__main__":
    unittest.main()
