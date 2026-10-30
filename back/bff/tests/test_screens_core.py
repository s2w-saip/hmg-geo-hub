"""Screen layer basics: JavaScript number semantics, the front-compatible query serializer and the
shared in-process reads."""
import asyncio
import json
import unittest
from collections import Counter
from datetime import date
from decimal import Decimal
from unittest import mock
from uuid import UUID

try:
    from fastapi import HTTPException
    from fastapi.encoders import jsonable_encoder

    from bff import api
    from bff.api import query
    from bff.gold_reader import cache as gold_cache
    from bff.screens import REGISTRY, screen
    from bff.screens._convert import Exact
    from bff.screens._js import js_round, js_str, rank_value, ratio_value, to_fixed
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_screens_core)") from exc


class JsNumbers(unittest.TestCase):
    def test_math_round_halves_go_up(self):
        self.assertEqual([js_round(x) for x in (2.5, -2.5, 0.5, -0.5, 1.49, 0.49999999999999994)], [3, -2, 1, 0, 1, 0])

    def test_to_fixed_uses_the_exact_binary_value(self):
        self.assertEqual(to_fixed(1.005, 2), "1.00")  # 1.005 is 1.00499999... in binary
        self.assertEqual(to_fixed(2.5, 0), "3")
        self.assertEqual(to_fixed(0.125, 2), "0.13")
        self.assertEqual(to_fixed(-1.5, 0), "-2")
        self.assertEqual(to_fixed(12.0, 1), "12.0")

    def test_string_of_number(self):
        self.assertEqual([js_str(1.0), js_str(0.1), js_str(3), js_str(1e21), js_str(1.5e-7)], ["1", "0.1", "3", "1e+21", "1.5e-7"])

    def test_ratio_and_rank(self):
        self.assertEqual(ratio_value({"num": 1, "den": 4}), 0.25)
        self.assertIsNone(ratio_value({"num": 1, "den": 0}))
        self.assertIsNone(ratio_value(None))
        self.assertEqual(rank_value({"sum": 9, "count": 3}), 3)
        self.assertIsNone(rank_value({"sum": 0, "count": 0}))


class QuerySerializer(unittest.TestCase):
    def test_matches_front_serialization(self):
        q = query({"surface": "global", "brand": ["kia", "hyundai"], "card": True, "full": False, "x": None, "empty": [], "n": 3})
        self.assertEqual(str(q), "brand=kia&brand=hyundai&card=true&full=false&n=3&surface=global")


class SharedReads(unittest.TestCase):
    def test_a_read_that_never_returns_is_dropped_after_the_timeout(self):
        calls = []

        async def read_json(path, q):
            calls.append(path)
            if len(calls) == 1:
                await asyncio.Event().wait()  # hangs, like a read on a lost connection
            return '{"ok": true}'

        async def run():
            with mock.patch.object(api, "_read_json", read_json), mock.patch.object(api, "READ_TIMEOUT_S", 0.05):
                with self.assertRaises(HTTPException) as hung:
                    await api.get("kpi/summary", {"surface": "global"})
                self.assertEqual(hung.exception.status_code, 504)
                await asyncio.sleep(0.05)  # the timed-out shared read leaves the table
                self.assertEqual(api._inflight, {})
                self.assertEqual(await api.get("kpi/summary", {"surface": "global"}), {"ok": True})
            self.assertEqual(len(calls), 2)

        asyncio.run(run())

    def test_a_read_is_encoded_once_and_parsed_once_per_caller(self):
        """2026-10-30 (ACR P5): the shared read keeps the answer's JSON text and every caller parses its own copy; it was
        encoded twice and parsed twice more per caller (jsonable_encoder, dumps, loads, then dumps + loads for a copy)."""
        answer = {"data": {"n": 1, "round": date(2026, 10, 5)}, "meta": {}}
        counts = Counter()
        real_dumps, real_loads = json.dumps, json.loads

        def dumps(*a, **k):
            counts["dumps"] += 1
            return real_dumps(*a, **k)

        def loads(*a, **k):
            counts["loads"] += 1
            return real_loads(*a, **k)

        async def read(path, q):
            await asyncio.sleep(0.01)  # both callers join the one read
            return answer

        async def run():
            with mock.patch.object(api, "read", read), mock.patch.object(gold_cache, "MAX_AGE_S", 0),                     mock.patch.object(api.json, "dumps", dumps), mock.patch.object(api.json, "loads", loads):
                return await asyncio.gather(api.get("kpi/summary", {"surface": "global"}), api.get("kpi/summary", {"surface": "global"}))

        a, b = asyncio.run(run())
        self.assertEqual(counts, {"dumps": 1, "loads": 2})
        self.assertEqual(a, {"data": {"n": 1, "round": "2026-10-05"}, "meta": {}})
        a["data"]["n"] = 2  # a caller's copy is its own
        self.assertEqual(b["data"]["n"], 1)

    def test_the_answer_text_is_what_the_encoder_gave(self):
        """One pass gives the text of json.dumps(jsonable_encoder(answer)), a key json cannot take (a date) included."""
        answers = [{"a": [1, 2.5, -0.0, 10 ** 20, None, True, "한글  "], "t": (1, "x"), "e": Exact(12.4, 12.36), "d": Decimal("1.50"),
                    "i": Decimal("7"), "day": date(2026, 10, 5), "u": UUID(int=1), "nested": [{"k": {"n": float("nan")}}]},
                   {"by_day": {date(2026, 10, 5): 3}}, [], "s", 3]
        for answer in answers:
            self.assertEqual(api._encode(answer), json.dumps(jsonable_encoder(answer)))


class Registry(unittest.TestCase):
    def test_duplicate_names_are_refused(self):
        @screen("test/only-once")
        async def first(q):
            return 1
        with self.assertRaises(RuntimeError):
            @screen("test/only-once")
            async def second(q):
                return 2
        REGISTRY.pop("test/only-once")


if __name__ == "__main__":
    unittest.main()
