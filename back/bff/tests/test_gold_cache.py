"""Gold read cache (gold_reader/cache.py): an answer is served while Gold's fingerprint is the one it was read
under, kept only when the fingerprint did not move across the read, and never fails a read."""
from __future__ import annotations

import asyncio
import json
import unittest
from unittest import mock

from bff.gold_reader import cache


class Gold:
    """Gold's fingerprint (`state`) and a read that counts its runs; `move_during` moves the state mid-read."""

    def __init__(self):
        self.state = "s1"
        self.runs = 0
        self.move_during: str | None = None
        self.probe_fails = False

    async def fingerprint(self) -> str:
        if self.probe_fails:
            raise ConnectionError("Gold down")
        return self.state

    def run(self, answer: dict):
        async def text() -> str:
            self.runs += 1
            if self.move_during:
                self.state = self.move_during
            return json.dumps(answer)
        return text


class Cache(unittest.TestCase):
    def setUp(self):
        cache.clear()
        self.gold = Gold()
        patches = [mock.patch.object(cache, "_fingerprint", self.gold.fingerprint),
                   mock.patch.object(cache, "MAX_AGE_S", 600), mock.patch.object(cache, "BUDGET", 10_000)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def reads(self, *calls: tuple[str, dict]) -> list[str]:
        """Each read in turn, its keep check settled before the next (the answers' JSON)."""
        async def go():
            out = []
            for key, answer in calls:
                out.append(await cache.read(key, self.gold.run(answer)))
                await asyncio.gather(*cache._keeping)
            return out
        return asyncio.run(go())

    def test_the_same_read_under_the_same_state_is_served_kept(self):
        out = self.reads(("kpi/summary?surface=global", {"n": 1}), ("kpi/summary?surface=global", {"n": 2}))
        self.assertEqual(self.gold.runs, 1)
        self.assertEqual([json.loads(t) for t in out], [{"n": 1}, {"n": 1}])

    def test_another_query_is_another_read(self):
        self.reads(("trend?dimension=brand", {"n": 1}), ("trend?dimension=engine", {"n": 2}))
        self.assertEqual(self.gold.runs, 2)

    def test_a_new_state_reads_again(self):
        self.reads(("kpi/summary?surface=global", {"n": 1}))
        self.gold.state = "s2"  # a publish, a reload, a dimension write, the next day ...
        out = self.reads(("kpi/summary?surface=global", {"n": 2}), ("kpi/summary?surface=global", {"n": 3}))
        self.assertEqual(self.gold.runs, 2)
        self.assertEqual([json.loads(t) for t in out], [{"n": 2}, {"n": 2}])

    def test_a_read_across_a_state_move_is_answered_not_kept(self):
        self.gold.move_during = "s2"
        first = self.reads(("kpi/summary?surface=global", {"n": 1}))
        self.gold.move_during = None
        self.reads(("kpi/summary?surface=global", {"n": 2}))
        self.assertEqual(json.loads(first[0]), {"n": 1})
        self.assertEqual(self.gold.runs, 2)

    def test_kept_answers_expire(self):
        self.reads(("kpi/summary?surface=global", {"n": 1}))
        with mock.patch.object(cache.time, "monotonic", return_value=cache.time.monotonic() + cache.MAX_AGE_S):
            self.reads(("kpi/summary?surface=global", {"n": 2}))
        self.assertEqual(self.gold.runs, 2)

    def test_off_reads_every_time(self):
        with mock.patch.object(cache, "MAX_AGE_S", 0):
            self.reads(("kpi/summary?surface=global", {"n": 1}), ("kpi/summary?surface=global", {"n": 1}))
        self.assertEqual(self.gold.runs, 2)

    def test_a_failed_probe_reads_uncached(self):
        self.gold.probe_fails = True
        out = self.reads(("kpi/summary?surface=global", {"n": 1}), ("kpi/summary?surface=global", {"n": 2}))
        self.assertEqual([json.loads(t) for t in out], [{"n": 1}, {"n": 2}])
        self.assertEqual(cache._kept, {})

    def test_the_least_recently_used_leave_past_the_budget(self):
        big = {"x": "a" * 900}  # ~0.9 KB each against a 10 KB budget
        self.reads(*((f"q{i}", big) for i in range(12)))
        self.assertLessEqual(cache._size, cache.BUDGET)
        self.assertNotIn("q0", cache._kept)
        self.assertIn("q11", cache._kept)
        self.reads(("q11", {"other": 1}))
        self.assertEqual(self.gold.runs, 12)

    def test_an_answer_over_a_tenth_of_the_budget_is_not_kept(self):
        self.reads(("big", {"x": "a" * 2000}), ("big", {"x": "b"}))
        self.assertEqual(self.gold.runs, 2)

    def test_concurrent_reads_share_one_probe(self):
        probes = []

        async def counted() -> str:
            probes.append(1)
            await asyncio.sleep(0.01)
            return self.gold.state

        async def go():
            with mock.patch.object(cache, "_fingerprint", counted):
                await asyncio.gather(*(cache.read(f"q{i}", self.gold.run({"i": i})) for i in range(5)))
                await asyncio.gather(*cache._keeping)
        asyncio.run(go())
        # one probe before the five reads, one after them (each keep check may share a probe started after its read)
        self.assertLessEqual(len(probes), 2)
        self.assertEqual(len(cache._kept), 5)


if __name__ == "__main__":
    unittest.main()
