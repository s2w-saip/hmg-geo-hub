"""The cache DB's key and store (hub_stores/cache_db.py)."""
import asyncio
import os
import unittest
from unittest import mock
from uuid import uuid4

try:
    from data_server.hub_stores import cache_db
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_cache_db)") from exc


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
