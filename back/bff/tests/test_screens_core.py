"""Screen layer basics: JavaScript number semantics and the front-compatible query serializer."""
import unittest

try:
    from bff.api import query
    from bff.screens import REGISTRY, screen
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
