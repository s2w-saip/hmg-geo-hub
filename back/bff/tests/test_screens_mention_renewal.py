"""Renewal mention screens (bff.screens.mention_renewal): what the golden cases do not cover.

- The compare-pick encoding: a pick is replayed in the user's pick ORDER (the goldens record
  every pick in covered order). Resolving the payload the way Next does (pickKey, the first
  picked of the tied candidates) must give what the old view model gave for that ordered pick.
- Degrade marks and failures through the loaders (the goldens record healthy reads only).
- Request validation and the y ticks of the rank chart outside the recorded range.
"""
from __future__ import annotations

import itertools
import math
import random
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from bff import screens
    from bff.screens import mention_renewal as rn
except ModuleNotFoundError as exc:  # pragma: no cover - outside the API image
    raise unittest.SkipTest("Run inside the BFF image") from exc

TYPES = ("mention", "recommendation", "comparison", "definition", "final_choice")
NAMES = ["Kia", "Hyundai", "Toyota", "Tesla", "BMW", "기아", "Škoda", "lexus", "Lexus", "MINI"]

#: every rn screen of the page, with its route context (the golden bundle keys)
SCREEN_CASES = (("rn-page", {}), ("rn-asof", {}), *(("rn-tab-value", {"ctx.kpi": k}) for k in rn.KPI_TABS), ("rn-tab-deltas", {}),
                ("rn-shell", {}), ("rn-compare", {}), ("rn-summary", {}), ("rn-rate-value", {}), ("rn-rate-hero", {}),
                ("rn-rate-engines", {}), ("rn-rate-types", {}), ("rn-favor-hero", {}), ("rn-favor-dist", {}), ("rn-favor-matrix", {}),
                ("rn-rank", {}), ("rn-bump", {}), ("rn-ranking", {}))


async def screens_with_tape(tape: list[dict], sp: dict) -> dict:
    """Golden bundle target (front/test/bff-golden/mention-renewal.golden.test.ts): every rn screen
    built for the page's URL params, each with its own query, every read answered from the
    request's tape (an unrecorded call fails)."""
    from bff.tests.golden_util import Tape
    t = Tape(tape)
    out = {}
    with mock.patch("bff.api.get", t.get):
        for name, ctx in SCREEN_CASES:
            params = {**sp, **ctx}
            q = QueryParams([(k, v) for k, vs in params.items() for v in (vs if isinstance(vs, list) else [vs])])
            out[f"{name}:{ctx['ctx.kpi']}" if ctx else name] = await screens.build(f"mention/{name}", q)
    return out


def pick_key(compare: list[str], covered: list[str]) -> str:
    """screen-types.ts pickKey."""
    k = 0
    for b in compare:
        if b in covered:
            k += 2 ** covered.index(b)
    return str(k)


def first_picked(compare: list[str], cands: list[str]) -> str | None:
    return next((b for b in compare if b in cands), None)


def type_rows_of(cmp: dict, compare: list[str]) -> list[dict]:
    """mention-rate.tsx typeRowsOf: the compare view resolved for an ordered pick."""
    if not cmp["rows"]:
        return []
    opt = cmp["options"][pick_key(compare, cmp["covered"])]

    def cell(brand: str, t: int):
        return cmp["dots"][cmp["covered"].index(brand)][t] if brand in cmp["covered"] else None

    out = []
    for t, r in enumerate(cmp["rows"]):
        ref = first_picked(compare, opt["refs"][t])
        at = (cell(ref, t) if ref is not None else None) or cmp["avgRef"][t]
        out.append({"type": r["type"], "own": r["own"], "avg": r["avg"],
                    "dots": [{"brand": b, "value": (cell(b, t) or {}).get("value")} for b in compare],
                    "ref": {"brand": ref, "value": at["value"]}, "gap": at["gap"]})
    return out


def summary_list(s: dict, compare: list[str]) -> list[dict]:
    """mention-body.tsx Summary: the findings of an ordered pick."""
    opt = s["options"][pick_key(compare, s["covered"])]
    out = []
    for i in opt["order"]:
        if i >= 0:
            out.append(s["fixed"][i])
            continue
        tf = dict(s["typeFindings"][opt["type"]])
        cands = tf.pop("refCands")
        ref = first_picked(compare, cands) if cands else None
        f = {**tf, "params": {**tf["params"], "ref": ref if ref is not None else ""}}
        if ref:
            f["brand"] = ref
        out.append(f)
    return out


def random_types(seed: int) -> tuple[dict, list[dict]]:
    r = random.Random(seed)
    names = r.sample(NAMES, r.randint(3, len(NAMES)))
    tracked = set(names[: r.randint(0, 2)])
    # few distinct values -> many ties at the leading value
    tb = {"totals": {t: r.choice([0, 40, 100, 1000]) for t in TYPES},
          "brands": [{"brand": b, "isTracked": b in tracked, "types": {t: r.choice([0, 0, 4, 4, 10, 25]) for t in TYPES}}
                     for b in names if r.random() > 0.1]}
    brands = [{"brand": b, "isTracked": b in tracked, "mentions": r.choice([5, 5, 50, 100]), "share": r.choice([1.5, 1.5, 3.0, 9.9]),
               "prompts": 1, "mentionRate": 1.0, "avgPosition": None} for b in names]
    return tb, brands


def random_trend(seed: int, brands: list[dict]) -> dict:
    r = random.Random(seed)
    series = [b["brand"] for b in brands if r.random() > 0.2]
    return {"unit": "week", "brands": [{"brand": b, "isTracked": next(x["isTracked"] for x in brands if x["brand"] == b), "mentions": 1}
                                       for b in dict.fromkeys(series)], "buckets": []}


class PickOrder(unittest.TestCase):
    """The precomputed picks give, for every ordered pick, what the old view model gave."""

    def test_type_rows_every_ordered_pick(self):
        for seed in range(40):
            tb, brands = random_types(seed)
            trend = random_trend(seed, brands)
            payload = rn.rate_types_payload(tb, brands, None, None, trend, False)
            covered = payload["cmp"]["covered"]
            for size in range(4):
                for pick in itertools.permutations(covered, size):
                    old = rn.type_compare_rows({"typesByBrand": tb, "brands": brands, "compare": list(pick)})
                    new = type_rows_of(payload["cmp"], list(pick))
                    for o, n in zip(old, new):
                        self.assertEqual({k: o[k] for k in ("type", "own", "avg", "dots", "ref", "gap")}, n, (seed, pick))
                    if old:
                        self.assertEqual(payload["cmp"]["options"][pick_key(list(pick), covered)]["top"], rn.type_dots_top(old))

    def test_summary_every_ordered_pick(self):
        engine = {"unit": "week", "engines": ["chatgpt"], "buckets": [], "latest": [], "latestBrands": [], "typeTrend": [],
                  "trendDegraded": False}
        empty = {"rows": [], "promptsWithoutBrand": None, "measuredPrompts": None}
        subs = {"exposure": empty, "sov": empty, "favorability": empty}
        prevs = {"exposure": None, "sov": None, "favorability": None}
        for seed in range(25):
            tb, brands = random_types(seed)
            trend = random_trend(seed, brands)
            s = rn.summary_payload(None, subs, prevs, engine, trend, tb, None, brands)
            for size in range(4):
                for pick in itertools.permutations(s["covered"], size):
                    rows = rn.type_compare_rows({"typesByBrand": tb, "brands": brands, "compare": list(pick)})
                    old = rn.findings({"exposure": rn.board({"metric": "exposure", "brands": brands, "trend": trend, "values": None,
                                                             "hero": rn.rate_hero("exposure", empty, None, engine, None)}),
                                       "sov": rn.board({"metric": "sov", "brands": brands, "trend": trend, "values": None,
                                                        "hero": rn.rate_hero("sov", empty, None, engine, None)}),
                                       "types": rows, "engines": rn.engine_rows(engine, "exposure")["rows"],
                                       "bump": rn.bump_data(trend), "favor": rn.favor_hero(empty, None, engine, None)})
                    self.assertEqual(old, summary_list(s, list(pick)), (seed, pick))


class Helpers(unittest.TestCase):
    def test_rank_axis_ticks_non_finite(self):
        self.assertEqual(rn.rank_axis_ticks(math.inf), [1])
        self.assertEqual(rn.rank_axis_ticks(math.nan), [1])
        self.assertEqual(rn.rank_axis_ticks(12), [1, 5, 10])

    def test_subsets_cover_every_pick_once(self):
        covered = [f"b{i}" for i in range(10)]
        keys = [k for k, _ in rn.compare_subsets(covered)]
        self.assertEqual(len(keys), 1 + 10 + 45 + 120)
        self.assertEqual(len(set(keys)), len(keys))
        for k, pick in rn.compare_subsets(covered):
            self.assertEqual(k, pick_key(list(reversed(pick)), covered))

    def test_js_sum_is_sequential(self):
        # Python's sum() compensates floats; the old reduce did not
        self.assertEqual(rn._js_sum([0.1] * 10), 0.9999999999999999)

    def test_brand_groups(self):
        self.assertEqual(rn.parent_group_of("Škoda"), "VW")
        self.assertEqual(rn.parent_group_of("Range Rover"), "Tata")
        self.assertEqual(rn.parent_group_of("Alexa"), rn.NON_AUTO_GROUP)
        self.assertEqual(rn.parent_group_of("Brand New Motors"), "Brand New Motors")
        self.assertEqual(rn.group_country("HMG"), "KR")


async def _failing_get(status: int):
    async def get(path, params=None):
        raise HTTPException(status, "boom")
    return get


class Screens(unittest.IsolatedAsyncioTestCase):
    """Every read failing transiently: the sections degrade instead of failing; a 4xx raises."""

    async def build(self, name: str, query: str = "") -> dict:
        return await screens.build(name, QueryParams(query))

    async def test_transient_failures_degrade(self):
        with mock.patch("bff.api.get", await _failing_get(503)):
            self.assertEqual(await self.build("mention/rn-shell"), {"measured": False, "degraded": True, "ownBrands": [], "drawer": []})
            value = await self.build("mention/rn-rate-value")
            self.assertTrue(value["degraded"])
            self.assertIsNone(value["exposure"]["pct"])
            self.assertTrue((await self.build("mention/rn-rate-types"))["degraded"])
            self.assertTrue((await self.build("mention/rn-favor-hero"))["degraded"])
            rank = await self.build("mention/rn-rank")
            self.assertFalse(rank["fp"])
            self.assertEqual(rank["rows"][0]["key"], rn.OWN_KEY)
            self.assertEqual(await self.build("mention/rn-asof"), {"asOf": None})
            self.assertEqual(await self.build("mention/rn-bump"), {"trend": False, "data": None, "measured": 0, "maxShare": 1})
            for name in ("rn-tab-deltas", "rn-compare", "rn-summary", "rn-rate-hero", "rn-rate-engines", "rn-favor-dist",
                         "rn-favor-matrix", "rn-ranking"):
                await self.build(f"mention/{name}")
            for kpi in rn.KPI_TABS:
                self.assertEqual(await self.build("mention/rn-tab-value", f"ctx.kpi={kpi}"), {"value": None})

    async def test_client_errors_raise(self):
        with mock.patch("bff.api.get", await _failing_get(403)):
            with self.assertRaises(HTTPException) as cm:
                await self.build("mention/rn-shell")
            self.assertEqual(cm.exception.status_code, 403)

    async def test_tab_value_needs_a_kpi(self):
        with self.assertRaises(HTTPException) as cm:
            await self.build("mention/rn-tab-value", "ctx.kpi=nope")
        self.assertEqual(cm.exception.status_code, 422)

    async def test_page_header(self):
        self.assertEqual(await self.build("mention/rn-page", "brand=HMG~Kia&time=2026-09-01..2026-09-30"),
                         {"ownLabel": "Kia", "period": {"from": "2026-09-01", "to": "2026-09-30"}})
        self.assertEqual(await self.build("mention/rn-page"), {"ownLabel": "HMG", "period": None})


if __name__ == "__main__":
    unittest.main()
