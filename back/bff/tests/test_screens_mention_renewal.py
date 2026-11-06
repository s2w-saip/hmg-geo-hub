"""Renewal mention screens (bff.screens.mention_renewal): what the golden cases do not cover.

- The compare-pick encoding: a pick is replayed in the user's pick ORDER (the goldens record
  every pick in covered order). Resolving the payload the way Next does (pickKey, the first
  picked of the tied candidates) must give what the old view model gave for that ordered pick.
- Degrade marks and failures through the loaders (the goldens record healthy reads only).
- Request validation and the y ticks of the rank chart outside the recorded range.
"""
from __future__ import annotations

import asyncio
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
    from bff.screens._convert import Exact
    from bff.screens.mention_view import type_sentiment_rows
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
        out.append({"type": r["type"], "own": r["own"],
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
                        self.assertEqual({k: o[k] for k in ("type", "own", "dots", "ref", "gap")}, n, (seed, pick))
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


class FavorTrend(unittest.TestCase):
    """The favourability trend is drawn from the overview slots. A failed sibling read of the same load (the type
    trend, which the reader did not answer until 2026-10-29) marked the load degraded, and the card said the
    aggregation had timed out although its points were there."""

    EMPTY = {"rows": [], "promptsWithoutBrand": None, "measuredPrompts": None}

    def engine(self, **over) -> dict:
        return {"unit": "week", "engines": ["chatgpt"], "buckets": [], "latest": [], "latestBrands": [], "typeTrend": [],
                "trendDegraded": True, **over}

    def test_the_slots_show_though_a_sibling_read_failed(self):
        slots = [{"bucketStart": "2026-10-05", "roundDate": "2026-10-05", "gap": None, "positiveMentions": 6, "sentMentions": 10, "measuredDays": 1}]
        h = rn.favor_hero(self.EMPTY, None, self.engine(overviewSlots=slots), None)
        self.assertFalse(h["trendMissing"])
        self.assertEqual([(p["key"], p["positive"]) for p in h["points"]], [("2026-10-05", 60.0)])

    def test_without_slots_a_degraded_load_is_missing(self):
        self.assertTrue(rn.favor_hero(self.EMPTY, None, self.engine(), None)["trendMissing"])
        self.assertTrue(rn.favor_hero(self.EMPTY, None, None, None)["trendMissing"])


class FavorMatrixTotal(unittest.TestCase):
    """유형별 감정's 전체 row is the type rows summed, as the original Global Mention screen (`mention/favor-matrix`):
    58.1 % on 2026-10-05 on both screens. A mention can carry several types, so it differs from the 감정 분포 card's
    every-mention 54.1 %. The renewal showed that 54.1 % from 2026-10-29 (927bb1f) until the user asked to match the
    original (2026-11-05: renewal values of kept metrics equal the legacy screens')."""

    KPI = {"sentimentMatrix": {"own": [
        {"type": "mention", "rows": 3, "positive": 5, "neutral": 4, "mixed": 0, "negative": 1},
        {"type": "recommendation", "rows": 2, "positive": 4, "neutral": 1, "mixed": 0, "negative": 0}]}}

    def test_the_total_row_is_the_type_rows_summed(self):
        rows = rn.favor_matrix_payload(self.KPI)["rows"]
        self.assertEqual([r["type"] for r in rows], ["all", "recommendation", "mention"])
        self.assertEqual((rows[0]["positive"], rows[0]["total"], rows[0]["positivePct"]), (9, 15, 60.0))

    def test_the_total_row_equals_the_original_screen(self):
        legacy = next(r for r in type_sentiment_rows(self.KPI, "own") if r["type"] == "all")
        self.assertEqual(rn.favor_matrix_payload(self.KPI)["rows"][0], legacy)


class OwnTypeTrend(unittest.TestCase):
    """멘션 유형 card, 당사 view: each type's line is the type trend's own answers over the round's answers. The
    rounds were kept only when the trend slot counted measurement days, which the Gold reader sends as null
    (2026-10-29), so every line was empty; a round with type answers is a measured round."""

    def test_a_round_with_type_answers_draws(self):
        slots = [{"bucketStart": d, "roundDate": d, "gap": None, "trackedAnswers": 6, "answers": 10, "trackedMentions": 8,
                  "totalMentions": 20, "measuredDays": 0} for d in ("2026-09-28", "2026-10-05")]
        engine = {"unit": "week", "engines": [], "buckets": [], "overviewSlots": slots, "trendDegraded": False,
                  "typeTrend": [{"bucketStart": "2026-09-28", "answers": 10, "byType": {**dict.fromkeys(TYPES, 0), "mention": 5}},
                                {"bucketStart": "2026-10-05", "answers": 20, "byType": {**dict.fromkeys(TYPES, 0), "mention": 12}}]}
        kpi = {"rows": [{"type": t, "ownExposurePct": 60.0, "ownMentions": 3} for t in TYPES], "ownMentions": 9}
        mention = next(r for r in rn.type_own_rows(kpi, engine, "exposure") if r["type"] == "mention")
        self.assertEqual((mention["spark"], mention["delta"]), ([50.0, 60.0], 10.0))


class Helpers(unittest.TestCase):
    def test_rank_axis_ticks_non_finite(self):
        self.assertEqual(rn.rank_axis_ticks(math.inf), [1])
        self.assertEqual(rn.rank_axis_ticks(math.nan), [1])
        self.assertEqual(rn.rank_axis_ticks(12), [1, 5, 10])

    def test_subsets_cover_every_pick_once(self):
        covered = [f"b{i}" for i in range(10)]
        keys = [k for k, _ in rn.compare_subsets(covered)]
        self.assertEqual(len(keys), 2 ** 10)  # every pick, any number of brands (no cap, 2026-11-05)
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


def _pinned_trend() -> dict:
    """Two rounds of a brand trend: 당사, Toyota (in the top) and Tata, the snapshot's top rival the reader pinned."""
    def bucket(day: str, toyota: float, tata: float) -> dict:
        return {"bucketStart": day, "answers": 10, "totalMentions": 40, "measuredDays": 0, "firstAt": None, "lastAt": None,
                "brands": [{"brand": "HMG", "isTracked": True, "mentions": 30, "answers": 9, "exposurePct": 90.0, "sharePct": 75.0},
                           {"brand": "Toyota", "isTracked": False, "mentions": 4, "answers": 3, "exposurePct": toyota, "sharePct": 10.0},
                           {"brand": "Tata", "isTracked": False, "mentions": 6, "answers": 2, "exposurePct": tata, "sharePct": 15.0}]}
    return {"unit": "week", "brands": [{"brand": "HMG", "isTracked": True, "mentions": 60}, {"brand": "Toyota", "isTracked": False, "mentions": 8},
                                       {"brand": "Tata", "isTracked": False, "mentions": 12, "pinned": True}],
            "buckets": [bucket("2026-10-02", 30.0, 10.0), bucket("2026-10-09", 40.0, 20.0)],
            "windowStartBucket": "2026-10-02", "windowEndBucket": "2026-10-09", "trendGrid": None}


class TopRivalPin(unittest.TestCase):
    """The original screens' compare rule (2026-10-30, user's go-ahead): with no pick the compare brand is the rival
    with the largest share on the snapshot (mention_surfaces.comparison_of). The renewal brand trend asks the reader
    to add that rival's line (`pinned`) when the round total leaves it outside the top 10, so it is covered and picked
    first; the rank chart keeps the top 10 it always drew (the competitor average line is gone, ⛔L)."""

    def test_the_pinned_rival_is_covered_and_picked_first(self):
        brands = [{"brand": "HMG", "isTracked": True, "share": 75.0}, {"brand": "Tata", "isTracked": False, "share": 15.0},
                  {"brand": "Toyota", "isTracked": False, "share": 10.0}]
        self.assertEqual(rn.covered_brands(brands, _pinned_trend()), ["Tata", "Toyota"])

    def test_the_pinned_rival_draws_its_line_and_the_rank_chart_leaves_it_out(self):
        hero = {"points": [{"key": "2026-10-02", "pct": 90.0}, {"key": "2026-10-09", "pct": 90.0}]}
        self.assertEqual(rn.hero_trend_series(hero, _pinned_trend(), "exposure", ["Tata"])["brands"],
                         [{"key": "Tata", "values": [10.0, 20.0]}])
        self.assertEqual([x["key"] for x in rn.bump_data(_pinned_trend())["series"]], [rn.OWN_KEY, "Toyota"])


def _type_input() -> tuple[dict, list[dict]]:
    """당사 30 · Toyota 20 · BMW 10 · Audi 5 of 100 signals on every type."""
    names = (("HMG", True, 30), ("Toyota", False, 20), ("BMW", False, 10), ("Audi", False, 5))
    tb = {"totals": {t: 100 for t in TYPES}, "brands": [{"brand": b, "isTracked": o, "types": {t: n for t in TYPES}} for b, o, n in names]}
    brands = [{"brand": b, "isTracked": o, "mentions": n, "share": float(n), "prompts": 1, "mentionRate": 1.0, "avgPosition": None}
              for b, o, n in names]
    return tb, brands


class RivalAverage(unittest.TestCase):
    """D-11 (2026-11-06, '추천대로 진행해'; ⛔L had removed them under the old rule that the HUB makes no baseline): the
    hero's 경쟁사 평균 line (the KPI brand trend's top-10 rivals' mean per round, over whichever had a value) and the type
    card's top-5 rivals' average, the reference without a compare brand. Definition: bff.metrics.catalog rival_average."""

    HERO = {"points": [{"key": "2026-10-02", "pct": 90.0}, {"key": "2026-10-09", "pct": 90.0}]}

    def test_the_hero_averages_the_top_rivals_not_the_pinned_one(self):
        s = rn.hero_trend_series(self.HERO, _pinned_trend(), "exposure", [])
        self.assertEqual(s["average"], [30.0, 40.0])  # Toyota alone: Tata is only pinned to compare
        self.assertEqual((s["own"], s["brands"]), ([90.0, 90.0], []))

    def test_a_round_averages_the_rivals_with_a_value_and_keeps_the_exact_mean(self):
        trend = _pinned_trend()
        trend["brands"][2].pop("pinned")
        trend["buckets"][1]["brands"][1]["exposurePct"] = None
        trend["buckets"][0]["brands"][1]["exposurePct"] = 33.34
        trend["buckets"][0]["brands"][2]["exposurePct"] = 33.35
        average = rn.hero_trend_series(self.HERO, trend, "exposure", [])["average"]
        self.assertEqual(average[0], 33.3)
        self.assertAlmostEqual(average[0].exact, 33.345)
        self.assertEqual(average[1], 20.0)

    def test_the_type_rows_fall_back_on_the_average(self):
        tb, brands = _type_input()
        rows = rn.type_compare_rows({"typesByBrand": tb, "brands": brands, "compare": []})
        self.assertEqual(len(rows), len(TYPES))
        for r in rows:
            self.assertEqual((r["own"], r["avg"], r["ref"], r["gap"]), (30.0, 11.7, {"brand": None, "value": 11.7}, 18.3))
        f = rn._type_finding(rows)
        self.assertEqual((f["kind"], f["params"]["ref"], f["params"]["gap"]), ("typeLead", "", 18.3))
        self.assertNotIn("brand", f)
        picked = rn.type_compare_rows({"typesByBrand": tb, "brands": brands, "compare": ["BMW", "Toyota"]})
        self.assertEqual({(r["avg"], r["ref"]["brand"], r["gap"]) for r in picked}, {(11.7, "Toyota", 10.0)})

    def test_the_type_average_takes_the_five_rivals_with_the_most_mentions(self):
        names = [("HMG", True, 30, 30)] + [(f"R{i}", False, 100 - i, 10 + i) for i in range(6)]
        tb = {"totals": {t: 100 for t in TYPES}, "brands": [{"brand": b, "isTracked": o, "types": {t: n for t in TYPES}} for b, o, _, n in names]}
        brands = [{"brand": b, "isTracked": o, "mentions": m, "share": 1.0, "prompts": 1, "mentionRate": 1.0, "avgPosition": None} for b, o, m, _ in names]
        rows = rn.type_compare_rows({"typesByBrand": tb, "brands": brands, "compare": []})
        self.assertEqual(rows[0]["avg"], 12.0)  # R0..R4 = 10..14, R5 with fewer mentions is out

    def test_the_type_card_sends_the_average(self):
        tb, brands = _type_input()
        trend = {"unit": "week", "brands": [{"brand": b["brand"], "isTracked": b["isTracked"], "mentions": 1} for b in brands], "buckets": []}
        cmp = rn.rate_types_payload(tb, brands, None, None, trend, False)["cmp"]
        self.assertEqual(cmp["rows"][0], {"type": "final_choice", "own": 30.0, "avg": 11.7})
        self.assertEqual(cmp["avgRef"][0], {"value": 11.7, "gap": 18.3, "lo": 11.7, "hi": 30.0})
        self.assertEqual(cmp["options"]["0"]["refs"], [[]] * len(TYPES))

    def test_a_type_finding_names_its_compare_brand(self):
        tb, brands = _type_input()
        rows = rn.type_compare_rows({"typesByBrand": tb, "brands": brands, "compare": ["Toyota"]})
        f = rn._type_finding(rows)
        self.assertEqual((f["kind"], f["brand"], f["params"]["ref"], f["params"]["gap"]), ("typeLead", "Toyota", "Toyota", 10.0))
        self.assertNotIn("dir", f["params"])

    def test_a_type_gap_shown_as_zero_is_level(self):
        # the smallest gap 0.0: no type trails, the one closest is level — not 'ahead' (W6: a direction only, info)
        def row(type_, gap):
            return {"type": type_, "own": 30.0, "avg": None, "dots": [], "ref": {"brand": "Toyota", "value": 30.0 - gap}, "gap": gap}
        f = rn._type_finding([row("final_choice", 0.0), row("mention", 2.0)])
        self.assertEqual((f["kind"], f["tone"], f["params"]["type"], f["params"]["dir"]), ("typeLead", "info", "final_choice", "same"))


class StandingGapChange(unittest.TestCase):
    """The standing finding's gap change rounded to 0.0 is no change (W6's rule; renewal audit 15): it read
    '좁혀졌습니다' (narrowed) whenever the change was not a widening."""

    @staticmethod
    def finding(own_delta, rival_delta, lead=False):
        own = {"key": rn.OWN_KEY, "own": True, "pct": 60.0 if lead else 40.0, "delta": own_delta}
        rival = {"key": "Toyota", "own": False, "pct": 50.0, "delta": rival_delta}
        return rn._standing_finding({"rows": [own, rival] if lead else [rival, own]})

    def test_a_change_shown_as_zero_is_no_change(self):
        for lead in (True, False):
            p = self.finding(0.32, 0.30, lead)["params"]
            self.assertEqual((p["move"], p["widened"]), (0, "same"), lead)

    def test_a_change_keeps_its_direction(self):
        self.assertEqual(self.finding(1.0, 0.2)["params"]["widened"], "false")  # trailing, 당사 gained more: narrowed
        self.assertEqual(self.finding(0.2, 1.0)["params"]["widened"], "true")
        self.assertEqual(self.finding(1.0, 0.2, lead=True)["params"]["widened"], "true")


async def _failing_get(status: int):
    async def get(path, params=None):
        raise HTTPException(status, "boom")
    return get


class NoValueNoParts(unittest.IsolatedAsyncioTestCase):
    """A hero without a value (its read failed, was suppressed, or 당사 has no rank) sends no parts either: the
    page showed "—%" over "0 / 0", and "측정 없음" over 순위 답변 "0개" and 앞선 경쟁사 "0개" (2026-10-29 metric
    review, Mention #69). A hero with a value keeps them."""

    async def test_failed_reads_send_null_parts(self):
        with mock.patch("bff.api.get", await _failing_get(503)):
            value = await screens.build("mention/rn-rate-value", QueryParams(""))
            favor = await screens.build("mention/rn-favor-hero", QueryParams(""))
            rank = await screens.build("mention/rn-rank", QueryParams(""))
        for m in rn.RATE_METRICS:
            self.assertEqual(value[m], {"pct": None, "numerator": None, "denominator": None})
        self.assertEqual((favor["positivePct"], favor["positive"], favor["total"]), (None, None, None))
        self.assertEqual((rank["hero"]["avgPosition"], rank["hero"]["rankedAnswers"], rank["ahead"]), (None, None, None))

    def test_a_value_keeps_its_parts(self):
        cards = {"visibility": {"numerator": 3, "denominator": 4}, "shareOfVoice": {"numerator": 0, "denominator": 9}}
        sub = {"rows": [], "promptsWithoutBrand": None, "measuredPrompts": None, "overviewCards": cards}
        value = rn.rate_value_payload({"exposure": sub, "sov": sub}, False)
        self.assertEqual(value["exposure"], {"pct": 75.0, "numerator": 3, "denominator": 4})
        self.assertEqual(value["sov"], {"pct": 0.0, "numerator": 0, "denominator": 9})
        rows = [{"engine": "chatgpt", "sentMentions": 10, "positiveMentions": 6, "negativeMentions": 1}]
        favor = rn.favor_hero_payload({"rows": rows}, None, None, None, False)
        self.assertEqual((favor["positivePct"], favor["positive"], favor["total"]), (60.0, 6, 10))


class Screens(unittest.IsolatedAsyncioTestCase):
    """Every read failing transiently: the sections degrade instead of failing; a 4xx raises."""

    async def build(self, name: str, query: str = "") -> dict:
        return await screens.build(name, QueryParams(query))

    async def test_transient_failures_degrade(self):
        with mock.patch("bff.api.get", await _failing_get(503)):
            self.assertEqual(await self.build("mention/rn-shell"), {"measured": False, "degraded": True, "ownBrands": [], "ownSum": [], "drawer": [], "favStanding": None})
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


class WebsiteSurface(unittest.IsolatedAsyncioTestCase):
    """ctx.surface=website (the renewal Website Mention, 2026-10-30): the screens read the website page's filters on
    the website surface, as mention/as-of does (site country, language, engine, period; the brand axis only for an
    administrator). Its KPI sections draw exposure, share and position lines, so their brand trend asks for the three
    on every surface; the original website / project view keeps its share lines only. Without ctx.surface: global."""

    async def reads(self, name: str, query: str) -> list[tuple[str, dict]]:
        seen: list[tuple[str, dict]] = []

        async def get(path, params=None):
            seen.append((path, dict(params or {})))
            await asyncio.sleep(0)
            raise HTTPException(503, "boom")
        with mock.patch("bff.api.get", get):
            await screens.build(name, QueryParams(query))
            await asyncio.sleep(0)  # the early-started reads nobody waited for
        return seen

    async def brands_read(self, query: str) -> dict:
        return next(p for path, p in await self.reads("mention/rn-shell", query) if path == "mentions/brands")

    async def test_the_website_filters_on_the_website_surface(self):
        url = "geography=US&brand=Kia&listType=ranked&time=2026-09-01..2026-09-30"
        site = await self.brands_read(f"ctx.surface=website&{url}")
        self.assertEqual((site["surface"], site["country"], site["from"], site["to"]), ("website", ["US"], "2026-09-01", "2026-09-30"))
        self.assertNotIn("brand", site)
        self.assertNotIn("list_type", site)
        self.assertEqual((await self.brands_read(f"ctx.surface=website&ctx.admin=true&{url}"))["brand"], ["Kia"])
        glob = await self.brands_read(url)
        self.assertEqual((glob["surface"], glob["brand"], glob["list_type"]), ("global", ["Kia"], ["ranked"]))

    async def test_the_kpi_brand_trend_asks_for_every_metric(self):
        for surface, ctx in (("global", ""), ("website", "ctx.surface=website&")):
            for name in ("mention/rn-bump", "mention/rn-rank"):
                trends = [p for path, p in await self.reads(name, f"{ctx}geography=US") if path == "trend" and p["dimension"] == "brand"]
                self.assertTrue(trends, name)
                for p in trends:
                    self.assertEqual((p["surface"], p["metrics"]), (surface, ["visibility", "share_of_voice", "position"]), name)
                    self.assertNotIn("measured_days", p, name)
        view = [p for path, p in await self.reads("mention/view", "ctx.surface=website") if path == "trend"]
        self.assertEqual([(p["surface"], p["metrics"], p["measured_days"]) for p in view], [("website", ["share_of_voice"], False)])

    async def test_the_renewal_brand_trend_pins_the_snapshots_top_rival(self):
        # TopRivalPin: every renewal read of the KPI brand trend (the KPI one and the first-position one, the same read)
        # asks for the snapshot's top rival; the original pages' reads do not (rn-ranking's Δ read is every brand's
        # share line: TreemapGroupDelta)
        for ctx in ("", "ctx.surface=website&"):
            for name in ("mention/rn-compare", "mention/rn-summary", "mention/rn-rate-hero", "mention/rn-rank"):
                trends = [p for path, p in await self.reads(name, f"{ctx}geography=US")
                          if path == "trend" and p["dimension"] == "brand" and "position" in p["metrics"]]
                self.assertTrue(trends, name)
                self.assertEqual({p.get("pin_top_rival") for p in trends}, {True}, name)
        for name in ("mention/view", "mention/kpi-hero-trend"):
            trends = [p for path, p in await self.reads(name, "ctx.surface=website&ctx.kpi=exposure") if path == "trend" and p["dimension"] == "brand"]
            self.assertNotIn(True, {p.get("pin_top_rival") for p in trends}, name)


class ViewCards(unittest.IsolatedAsyncioTestCase):
    maxDiff = None
    """mention/view-cards: the legacy website page's six summary cards for the renewal Website Mention (2026-10-30,
    the user: a legacy KPI is reshaped, never dropped) — mention/view's summary, Sub KPI and Δ from the same reads."""

    @staticmethod
    def row(ranked: int, answers: int, multi: int, top3: int, mentions: int) -> dict:
        # Top 3's denominator is the monitoring answers that mention 당사 (trackedMon), not the representative ones (tracked)
        return {"tracked": ranked // 2, "trackedMon": ranked, "ranked": ranked, "answers": answers, "sentMentions": 0, "multi": multi, "top3": top3,
                "positiveMentions": 0, "negativeMentions": 0, "totalMentions": mentions}

    def reads(self, data: dict | None, prev: dict | None) -> dict:
        return {"data": data, "sub": {"rows": [self.row(80, 100, 30, 60, 500), self.row(10, 20, 2, 9, 40)],
                                      "promptsWithoutBrand": 7, "measuredPrompts": 50},
                "prev": prev, "dates": None, "options": None, "degraded": {"data": False, "types": False, "subKpis": False}}

    async def build(self, r: dict) -> dict:
        async def surface_reads(ctx, sp, full=True):
            self.assertEqual((ctx, sp), ({"surface": "website"}, {"geography": "US"}))
            return r
        with mock.patch("bff.screens.mention_surfaces._surface_reads", surface_reads):
            return await screens.build("mention/view-cards", QueryParams("ctx.surface=website&geography=US"))

    async def test_the_cards_and_their_deltas(self):
        prev = {"sub": {"rows": [self.row(70, 100, 20, 50, 450)], "promptsWithoutBrand": 9, "measuredPrompts": 48}, "asOf": "2026-10-02"}
        summary = {"total": 540, "uniqueBrands": 12, "totalPrompts": 50, "totalAnswers": 120}
        got = await self.build(self.reads({"summary": summary, "asOf": "2026-10-09", "brands": []}, prev))
        self.assertEqual((got["asOf"], got["summary"]), ("2026-10-09", summary))
        sub = got["subKpis"]
        self.assertEqual((sub["missingPrompts"], sub["multiMentionAnswers"], sub["top3Rate"], sub["top3Count"], sub["top3Base"]),
                         (7, 32, 76.7, 69, 90))
        self.assertEqual(got["deltas"], {
            # 전체 언급 수 counts every brand's mentions: not a 당사 measure, so no better side (renewal audit 5-4)
            "total": {"diff": 90, "unit": "count", "tone": "neutral"}, "totalPrompts": {"diff": 2, "unit": "count", "tone": "neutral"},
            "missingPrompts": {"diff": -2, "unit": "count", "tone": "good"}, "multiMention": {"diff": 12, "unit": "count", "tone": "good"},
            "top3Rate": {"diff": 5.2, "unit": "pp", "tone": "good"}})  # exact values: 76.67 − 71.43, not 76.7 − 71.4
        self.assertEqual(got["prevBasisDate"], "2026-10-02")

    async def test_without_a_previous_round_or_data(self):
        got = await self.build(self.reads({"summary": {"total": 1, "uniqueBrands": 1, "totalPrompts": 1, "totalAnswers": 1}}, None))
        self.assertIsNone(got["prevBasisDate"])
        self.assertIsNone(got["deltas"]["missingPrompts"])
        empty = await self.build(self.reads(None, None))
        self.assertEqual((empty["summary"], empty["deltas"]), (None, None))


if __name__ == "__main__":
    unittest.main()


class ViewWeekly(unittest.IsolatedAsyncioTestCase):
    """mention/view-weekly: the legacy website view's weekly brand mentions (당사 + top 10) as rows for the renewal
    Website Mention's 브랜드 상세 (2026-10-30, a legacy KPI is reshaped, never dropped): weekly counts, a gap week as
    null, the latest measured week and its change from the week before when both were measured."""

    async def build(self, data: dict | None, degraded: bool = False) -> dict:
        async def surface_reads(ctx, sp, full=True):
            return {"data": data, "sub": None, "prev": None, "dates": None, "options": None,
                    "degraded": {"data": degraded, "types": False, "subKpis": False}}
        with mock.patch("bff.screens.mention_surfaces._surface_reads", surface_reads):
            return await screens.build("mention/view-weekly", QueryParams("ctx.surface=website"))

    async def test_rows_per_brand(self):
        trend = {"series": ["HMG", "Toyota", "BMW"], "points": [
            {"week": "2026-09-21", "HMG": 100, "Toyota": 4, "BMW": 0},
            {"week": "2026-09-28", "gap": {"reason": "collection_error"}, "HMG": None, "Toyota": None, "BMW": None},
            {"week": "2026-10-05", "HMG": 120, "Toyota": 6, "BMW": 2},
            {"week": "2026-10-12", "HMG": 90, "Toyota": 6, "BMW": 5}]}
        brands = [{"brand": "HMG", "isTracked": True}, {"brand": "Toyota", "isTracked": False}, {"brand": "BMW", "isTracked": False}]
        got = await self.build({"trend": trend, "brands": brands})
        self.assertEqual(got["weeks"], ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"])
        self.assertEqual(got["gaps"], [False, True, False, False])
        self.assertEqual(got["rows"], [
            {"brand": "HMG", "own": True, "values": [100, None, 120, 90], "latest": 90, "delta": -30},
            {"brand": "Toyota", "own": False, "values": [4, None, 6, 6], "latest": 6, "delta": 0},
            {"brand": "BMW", "own": False, "values": [0, None, 2, 5], "latest": 5, "delta": 3}])
        self.assertFalse(got["degraded"])

    async def test_a_gap_before_the_latest_week_has_no_delta(self):
        trend = {"series": ["HMG"], "points": [{"week": "2026-09-28", "HMG": 3},
                                               {"week": "2026-10-05", "gap": {"reason": "collection_error"}, "HMG": None},
                                               {"week": "2026-10-12", "HMG": 5}]}
        got = await self.build({"trend": trend, "brands": [{"brand": "HMG", "isTracked": True}]})
        self.assertEqual((got["rows"][0]["latest"], got["rows"][0]["delta"]), (5, None))

    async def test_without_a_trend(self):
        self.assertEqual(await self.build({"trend": None, "trendDegraded": True, "brands": []}),
                         {"weeks": [], "gaps": [], "rows": [], "degraded": True})
        self.assertEqual(await self.build(None), {"weeks": [], "gaps": [], "rows": [], "degraded": False})


class WeeklyTrendUnmeasured(unittest.TestCase):
    """The weekly brand mentions (to_mention_trend, the legacy website chart and the renewal 주별 브랜드 언급 수): a round
    the filter has no mention in (share of voice den 0, no gap reason — e.g. US on 07-24 · 08-07 · 08-14) is a gap,
    never a made-up 0 for every brand (2026-10-30 W6 review)."""

    def test_a_round_without_mentions_is_a_gap(self):
        from bff.screens import mention_data
        buckets = [{"key": d, "round_dates": [d]} for d in ("2026-07-17", "2026-07-24", "2026-08-21")]

        def series(label, own, nums, dens):
            return {"metric": "share_of_voice", "is_own": own, "label": label, "key": label,
                    "points": [{"bucket": b["key"], "ratio": {"num": n, "den": d}} for b, n, d in zip(buckets, nums, dens)]}

        data = {"own_label": "HMG", "buckets": buckets,
                "series": [series("HMG", True, [9355, 0, 5352], [9800, 0, 5600]), series("Toyota", False, [74, 0, 58], [9800, 0, 5600])]}
        trend = mention_data.to_mention_trend(data)
        by_week = {p["week"]: p for p in trend["points"]}
        self.assertEqual((by_week["2026-07-13"]["HMG"], by_week["2026-08-17"]["HMG"]), (9355, 5352))
        gap = by_week.get("2026-07-20")
        self.assertIsNotNone(gap)
        self.assertEqual((gap["HMG"], gap["Toyota"]), (None, None))
        self.assertIn("gap", gap)


def _slot(d: str, **over) -> dict:
    """An overview trend slot (to_standard_trend_buckets) of one round."""
    return {"bucketStart": d, "roundDate": d, "gap": None, "answers": 10, "trackedAnswers": 6, "totalMentions": 20,
            "trackedMentions": 8, "sentMentions": 10, "positiveMentions": 6, "avgPosition": None, "measuredDays": 1, **over}


class RoundCounts(unittest.TestCase):
    """Renewal audit 5-1: a KPI trend names each round's numerator and denominator, as the original's tooltips did
    (kpi-trend-chart · favorability-trend-chart: the counts under the rate) and the type chart's answers per round
    (type-kpi-section: the answers bar). The points carried them; the payload sent the rates only. A round without a
    value sends no counts (unknown, not 0, as the heroes). The original's WoW % is HUB-made and not carried."""

    SUB = {"rows": [], "promptsWithoutBrand": None, "measuredPrompts": None}

    def engine(self, slots: list[dict], **over) -> dict:
        return {"unit": "week", "engines": [], "buckets": [], "overviewSlots": slots, "trendDegraded": False, **over}

    def test_the_rate_trend_names_each_rounds_counts(self):
        slots = [_slot("2026-09-28"), _slot("2026-10-05", trackedAnswers=7, answers=0, trackedMentions=9, totalMentions=30)]
        for metric, num, den in (("exposure", [6, None], [10, None]), ("sov", [8, 9], [20, 30])):
            t = rn.rate_hero_payload(metric, self.SUB, None, self.engine(slots), None, [], None)["trend"]
            self.assertEqual((t["x"], t["ownNum"], t["ownDen"]), (["2026-09-28", "2026-10-05"], num, den), metric)

    def test_the_favorability_trend_names_each_rounds_signals(self):
        slots = [_slot("2026-09-28"), _slot("2026-10-05", positiveMentions=0, sentMentions=0)]
        pts = rn.favor_hero_payload(self.SUB, None, self.engine(slots), None, False)["points"]
        self.assertEqual([(p["key"], p["positiveCount"], p["total"]) for p in pts], [("2026-09-28", 6, 10), ("2026-10-05", None, None)])

    def test_the_type_trend_names_each_rounds_answers(self):
        slots = [_slot("2026-09-28"), _slot("2026-10-05")]
        engine = self.engine(slots, typeTrend=[
            {"bucketStart": "2026-09-28", "answers": 10, "byType": {**dict.fromkeys(TYPES, 0), "mention": 5}},
            {"bucketStart": "2026-10-05", "answers": 20, "byType": {**dict.fromkeys(TYPES, 0), "mention": 12}}])
        kpi = {"rows": [{"type": t, "ownExposurePct": 60.0, "ownMentions": 3} for t in TYPES], "ownMentions": 9,
               "sentimentMatrix": {"own": []}}
        own = rn.rate_types_payload(None, [], kpi, engine, None, False)["own"]
        self.assertEqual((own["exposure"]["x"], own["exposure"]["answers"]), (["2026-09-28", "2026-10-05"], [10, 20]))
        mention = next(r for r in own["exposure"]["rows"] if r["type"] == "mention")
        self.assertEqual((mention["spark"], mention["counts"]), ([50.0, 60.0], [5, 12]))
        self.assertEqual((own["sov"]["x"], own["sov"]["answers"]), ([], []))
        self.assertTrue(all(r["counts"] == [] for r in own["sov"]["rows"]))


class PerAnswerMonthLine(unittest.TestCase):
    """Renewal audit 5-2: in a calendar month the original showed the period line under the KPI tabs, its 답변당 언급 수
    Δ among them (kpi-period monthLine). The renewal page asks the reader for it (the reader answers when asked,
    audit U10) but showed none. Like the renewal Citation's month line, the line carries the one compare metric no tab
    shows; a window, a week or no period has none."""

    MPA = {"metric": "mentionsPerAnswer", "unit": "pct", "delta": 4.2, "reason": None, "cur": {"collectedDays": 30}}

    def period(self, months: bool) -> dict:
        shape = {"kind": "calendarMonth", "days": 30, "months": {"cur": {"lo": "2026-09-01"}}} if months else {"kind": "window", "days": 30}
        return {"compare": [{"metric": "visibility", "unit": "pp", "delta": 1.0, "reason": None}, self.MPA],
                "days": 30, "kind": shape["kind"], "shape": shape}

    def test_a_calendar_month_names_the_per_answer_change(self):
        line = rn.per_answer_line(self.period(True), {"dateFrom": "2026-09-01", "dateTo": "2026-09-30"}, "2026-10-31")
        self.assertEqual([c["key"] for c in line["chips"]], ["mentionsPerAnswer"])
        self.assertEqual(line["presetKey"], "lastMonth")
        self.assertFalse(line["chips"][0]["suppressed"])

    def test_no_month_no_line(self):
        self.assertIsNone(rn.per_answer_line(self.period(False), {"dateFrom": "2026-09-01", "dateTo": "2026-09-30"}, "2026-10-31"))
        self.assertIsNone(rn.per_answer_line({"compare": None, "kind": "window", "shape": {"kind": "window"}}, {}, "2026-10-31"))
        self.assertIsNone(rn.per_answer_line(None, {}, "2026-10-31"))


def _body_brand(i: int, name: str | None = None) -> dict:
    """A body brand row (to_mentions_brand_live) at 1-based rank i, mentions falling with the rank."""
    return {"brand": name or f"Brand {i:03d}", "mentions": 1000 - i, "prompts": 50 - i % 50, "share": 0.1, "mentionRate": 0.2,
            "avgPosition": 3.0, "isTracked": i == 1, "sentiment": {"positive": 3, "neutral": 1, "mixed": 0, "negative": 0},
            "multi": {"mentions": 2, "answers": 1, "prompts": 1}}


class RankingEveryBrand(unittest.TestCase):
    """Renewal audit 6-1: the ranking table showed the first 100 body brands only, and searched those 100. The
    original Global searched every brand and showed 100 (brand-rank-table limit), the original website table every
    brand. The reader sends every brand (`full`), so the screen sends every row; the table shows 100 first, searches
    them all and shows more. The shell's drawer rows stay the first 100 (the body waits on the shell): a row past them
    carries its own drawer row (the shell's shape), so its drawer opens with its values. The treemap stays the top
    100 (its own section, unchanged)."""

    N = 150

    def data(self) -> dict:
        brands = [_body_brand(i) for i in range(1, self.N + 1)]
        tb = {"totals": dict.fromkeys(TYPES, 1),
              "brands": [{"brand": b["brand"], "isTracked": b["isTracked"], "types": {**dict.fromkeys(TYPES, 0), "mention": i}}
                         for i, b in enumerate(brands, 1)]}
        return {"brands": brands, "summary": {"total": 100000, "totalAnswers": 500}, "typesByBrand": tb}

    def test_every_brand_is_a_row_and_sorts(self):
        out = rn.ranking_payload(self.data(), None)
        self.assertEqual((len(out["rows"]), out["count"]), (self.N, self.N))
        self.assertEqual([r["rank"] for r in out["rows"]][-2:], [149, 150])
        for mode in ("off", "on"):
            self.assertEqual(sorted(out["orders"][mode]["mentions"]["desc"]), list(range(self.N)), mode)

    def test_a_row_past_the_shells_drawer_carries_its_drawer_row(self):
        data = self.data()
        out = rn.ranking_payload(data, None)
        shell = rn.shell_payload({"brands": data["brands"]}, False, data["typesByBrand"])
        self.assertEqual(len(shell["drawer"]), rn.BRANDS_TOP)
        self.assertTrue(all("drawer" not in r for r in out["rows"][:rn.BRANDS_TOP]))
        past = out["rows"][120]
        self.assertEqual(past["drawer"], rn._drawer_row(data["brands"][120], 121, data["typesByBrand"]["brands"][120]["types"]))
        self.assertEqual((past["drawer"]["rank"], past["drawer"]["types"]["mention"]), (121, 121))

    def test_the_treemap_stays_the_top_rows(self):
        data = self.data()
        top = sorted(b["brand"] for b in data["brands"][:rn.BRANDS_TOP])
        for mode, groups in rn.ranking_payload(data, None)["treemap"].items():
            self.assertEqual(sorted(m["brand"] for g in groups for m in g["members"]), top, mode)


class GoldHmgFlag(unittest.IsolatedAsyncioTestCase):
    """Renewal audit 8-1: the 'HMG 계열' badge (`sibling`: an HMG brand that is not 당사 for this account) came from a HUB
    name list (Hyundai · Kia · Genesis). Gold says which brands are HMG's: `dim_brand.own_bit`, which the reader sends
    as `is_hmg_own` when ?include= asks for `hmg`. The renewal page asks for it on its body brand read (one read, the
    same for every section) and takes the badge from it; the original pages' reads stay as they were. On 2026-10-31
    both rules pick the same brands (renewal audit U1), so no number moves; a brand Gold calls HMG under another name
    gets the badge, a name Gold does not call HMG does not."""

    def brands(self) -> list[dict]:
        return [
            {**_body_brand(1, "Kia"), "hmgOwn": True},
            {**_body_brand(2, "Hyundai Canada"), "hmgOwn": True},
            {**_body_brand(3, "Genesis"), "hmgOwn": False},
            {**_body_brand(4, "Toyota"), "hmgOwn": False},
        ]

    def sibling_of(self, rows: list[dict], key: str = "brand") -> dict:
        return {r[key]: r["sibling"] for r in rows if not r.get("own")}

    def test_the_reader_flag_is_kept(self):
        md = rn._md()
        item = {"name": "Hyundai Canada", "mentions": 2, "share": 0.001, "exposure": 0.001, "is_own": False,
                "sentiment": dict.fromkeys(("positive", "neutral", "mixed", "negative"), 0)}
        self.assertNotIn("hmgOwn", md.to_mentions_brand_live(item))
        self.assertIs(md.to_mentions_brand_live({**item, "is_hmg_own": True})["hmgOwn"], True)
        self.assertIs(md.to_mentions_brand_live({**item, "is_hmg_own": False})["hmgOwn"], False)

    def test_the_badge_is_golds_flag(self):
        brands = self.brands()
        want = {"Hyundai Canada": True, "Genesis": False, "Toyota": False}
        ranking = rn.ranking_payload({"brands": brands, "summary": {"total": 4000, "totalAnswers": 100}}, None)
        self.assertEqual(self.sibling_of(ranking["rows"]), want)
        self.assertEqual({m["brand"]: m["sibling"] for g in ranking["treemap"]["off"] for m in g["members"] if not m["own"]}, want)
        shell = rn.shell_payload({"brands": brands}, False, None)
        self.assertEqual({r["brand"]: r["sibling"] for r in shell["drawer"] if not r["isTracked"]}, want)
        hero = {"pct": 50, "points": [], "delta": {"value": None}}
        board = rn.board({"metric": "exposure", "brands": brands, "trend": None, "values": None, "hero": hero})
        self.assertEqual(self.sibling_of(board["rows"], "key"), want)
        latest = [{"brand": b["brand"], "isTracked": b["isTracked"], "rank": i + 1, "avgPosition": 2.0 + i, "rankedAnswers": 5,
                   "mentions": b["mentions"]} for i, b in enumerate(brands)]
        fp = {"unit": "week", "brands": [b["brand"] for b in brands], "buckets": [], "latest": latest}
        rank = rn.rank_payload(fp, None, brands, None, False)
        self.assertEqual(self.sibling_of(rank["rows"], "key"), want)

    async def brand_reads(self, name: str, query: str) -> list[dict]:
        return [p for path, p in await WebsiteSurface.reads(self, name, query) if path == "mentions/brands"]

    async def test_the_renewal_body_read_asks_for_the_flag(self):
        for ctx in ("", "ctx.surface=website&"):
            for name in ("mention/rn-shell", "mention/rn-compare", "mention/rn-summary", "mention/rn-rate-hero", "mention/rn-rank",
                         "mention/rn-ranking", "mention/rn-favor-dist", "mention/rn-asof"):
                body = [p for p in await self.brand_reads(name, f"{ctx}geography=US") if p.get("include")]
                self.assertTrue(body, name)
                self.assertEqual({tuple(p["include"]) for p in body}, {("multi", "prompts", "types", "hmg")}, name)
        for name, query in (("mention/view", "ctx.surface=website"), ("mention/as-of", "")):
            body = [p for p in await self.brand_reads(name, query) if p.get("include")]
            self.assertTrue(body, name)
            self.assertEqual({tuple(p["include"]) for p in body}, {("multi", "prompts", "types")}, name)


class TreemapNonAuto(unittest.TestCase):
    """Renewal audit 8-2: the treemap folded the '자동차 외' group (Google, Apple, …: `NON_AUTO_GROUP`) into '그 외' always,
    whatever its share, so a large one was hidden. The group keeps its name and folds by the rule every group follows
    (under 1.5 % of mentions, or past the 14th)."""

    def tm(self, brand: str, value: int, own: bool = False) -> dict:
        return {"brand": brand, "value": value, "share": value / 10, "delta": None, "own": own, "sibling": False}

    def test_a_large_non_auto_group_stays(self):
        rows = [self.tm("Kia", 400, True), self.tm("Toyota", 300), self.tm("Google", 80), self.tm("Apple", 40), self.tm("Tesla", 5)]
        groups = rn.treemap_groups(rows, 1000)
        self.assertEqual([g["key"] for g in groups], ["HMG", "Toyota", rn.NON_AUTO_GROUP, rn.TREEMAP_FOLD])
        self.assertEqual([m["brand"] for m in groups[2]["members"]], ["Google", "Apple"])
        self.assertEqual(groups[2]["share"], 12.0)

    def test_a_small_non_auto_group_folds_like_any_other(self):
        rows = [self.tm("Kia", 400, True), self.tm("Toyota", 300), self.tm("Google", 10), self.tm("Tesla", 10)]
        self.assertEqual([g["key"] for g in rn.treemap_groups(rows, 1000)], ["HMG", "Toyota", rn.TREEMAP_FOLD])


class BoardReadsEveryBrandsLine(unittest.TestCase):
    """Global score sheet (2026-11-02): the ranking gives Audi and Mazda a Δ, while the 경쟁 구도 table beside it said
    '추이 미산출': it took the KPI brand trend, which stops at the top rivals."""

    def test_the_board_uses_the_all_brand_lines_and_the_hero_keeps_its_trend(self):
        seen = {}
        def board(inp):
            seen["board"] = inp["trend"]
            return {"rows": [], "ownRank": None}
        with mock.patch.object(rn, "rate_hero", return_value={"pct": 1, "points": [], "delta": {"value": None}}), \
                mock.patch.object(rn, "board", board), mock.patch.object(rn, "hero_trend_series", return_value={"brands": []}) as hero:
            try:
                rn.rate_hero_payload("exposure", None, None, None, None, [], {"brands": [], "top": 10}, None, {"brands": [], "all": True})
            except (KeyError, TypeError):
                pass
        self.assertTrue(seen["board"].get("all"))
        self.assertEqual(hero.call_args.args[1].get("top"), 10)


class TreemapGroupDelta(unittest.IsolatedAsyncioTestCase):
    """2026-11-02 premise review: a group tile's Δ and colour were the sum of the members that had a Δ, and the round Δ
    came from the KPI brand trend, which stops at the top rivals: VW was the sum of 2 of its 8 brands (the Global default
    showed 6 of 12 tiles so), named on hover only. A partial sum is not the group's change (W6 · step 12), so a group
    has a Δ only when every member has one, and the round Δ reads every brand's share line (period mode reads every
    brand's row already)."""

    @staticmethod
    def member(brand: str, delta: float | None) -> dict:
        return {"brand": brand, "value": 10, "share": 1.0, "delta": delta, "own": False, "sibling": False}

    def test_a_group_missing_a_members_delta_has_no_delta(self):
        group = rn._group_of("VW", [self.member("VW", 0.4), self.member("Audi", None)], 1000)
        self.assertEqual((group["delta"], group["partial"]), (None, True))

    def test_a_group_with_every_members_delta_sums_them(self):
        group = rn._group_of("VW", [self.member("VW", 0.4), self.member("Audi", -0.1)], 1000)
        self.assertEqual((group["delta"], group["partial"]), (0.3, False))

    def test_a_groups_delta_is_summed_before_rounding(self):
        # Global score sheet (2026-11-02): BMW group read +0.4 where Gold's change is +0.34, the sum of rounded Δ
        members = [self.member("BMW", Exact(0.2, 0.154)), self.member("MINI", Exact(0.2, 0.19))]
        self.assertEqual(rn._group_of("BMW", members, 1000)["delta"], 0.3)

    def test_every_brand_gets_a_round_delta_from_its_share_line(self):
        names = [f"Brand {i}" for i in range(1500)]
        def bucket(day: str, shares: dict) -> dict:
            return {"bucketStart": day, "answers": 10, "totalMentions": 10, "measuredDays": 1, "firstAt": None, "lastAt": None,
                    "brands": [{"brand": n, "isTracked": False, "mentions": 1, "answers": 1, "exposurePct": 1.0, "sharePct": v} for n, v in shares.items()]}
        trend = {"unit": "cycle", "brands": [{"brand": n, "isTracked": False, "mentions": 2} for n in names],
                 "buckets": [bucket("2026-09-28", dict.fromkeys(names, 1.0)), bucket("2026-10-05", dict.fromkeys(names, 1.5))],
                 "windowStartBucket": "2026-09-28", "windowEndBucket": "2026-10-05", "trendGrid": []}
        with mock.patch.object(rn._mv(), "trend_axis", return_value=[{"bucketStart": b["bucketStart"], "measured": True} for b in trend["buckets"]]):
            out = rn.share_deltas(trend)
        self.assertEqual(len(out), 1500)
        self.assertEqual(out["Brand 1499"], 0.5)

    async def share_lines(self, query: str, screen: str = "mention/rn-ranking") -> list[dict]:
        seen: list[dict] = []

        async def get(path, params=None):
            if path == "trend" and (params or {}).get("top_n"):
                seen.append(dict(params))
            await asyncio.sleep(0)
            raise HTTPException(503, "boom")
        with mock.patch("bff.api.get", get):
            try:
                await screens.build(screen, QueryParams(query))
            except HTTPException:
                pass
            await asyncio.sleep(0)
        return seen

    async def test_the_ranking_reads_every_brands_share_line_on_a_round(self):
        for query in ("", "ctx.surface=website"):
            lines = await self.share_lines(query)
            self.assertEqual([(p["dimension"], p["metrics"], p["top_n"]) for p in lines],
                             [("brand", ["visibility", "share_of_voice"], rn._md().ALL_BRANDS_TOP_N)], query)

    async def test_a_period_compares_rows_and_reads_no_share_lines(self):
        self.assertEqual(await self.share_lines("time=2026-09-01..2026-09-30"), [])

    async def test_the_summary_reads_every_brands_share_line_on_a_round(self):
        """Last review (2026-11-02): the summary's 변화 finding read the KPI brand trend (top rivals only) while the board
        under it reads every brand's line: US with no compare said 'Porsche ▲0.3pp 가장 큰 변화', the board had Mazda ▼0.4."""
        for query in ("", "ctx.surface=website"):
            lines = await self.share_lines(query, "mention/rn-summary")
            self.assertIn(("brand", ["visibility", "share_of_voice"], rn._md().ALL_BRANDS_TOP_N),
                          [(p["dimension"], p["metrics"], p["top_n"]) for p in lines], query)

    def test_the_mover_is_the_largest_move_of_every_brand(self):
        engine = {"unit": "week", "engines": ["chatgpt"], "buckets": [], "latest": [], "latestBrands": [], "typeTrend": [], "trendDegraded": False}
        empty = {"rows": [], "promptsWithoutBrand": None, "measuredPrompts": None}
        subs, prevs = {"exposure": empty, "sov": empty, "favorability": empty}, {"exposure": None, "sov": None, "favorability": None}
        brands = [{"brand": b, "isTracked": b == "HMG", "mentions": 10, "share": 1.0, "prompts": 1, "mentionRate": 1.0, "avgPosition": None}
                  for b in ("HMG", "Porsche", "Mazda")]
        top = {"unit": "week", "brands": [{"brand": "HMG", "isTracked": True, "mentions": 1}, {"brand": "Porsche", "isTracked": False, "mentions": 1}], "buckets": []}
        every = {**top, "brands": [*top["brands"], {"brand": "Mazda", "isTracked": False, "mentions": 1}]}
        moves = {"Porsche": 0.3, "Mazda": -0.4}
        real = rn._mv().competitor_kpi_rows
        with mock.patch.object(rn._mv(), "competitor_kpi_rows",
                               side_effect=lambda inp: [{**r, "wowPp": moves.get(r["brand"]) if any(b["brand"] == r["brand"] for b in inp["trend"]["brands"]) else None}
                                                        for r in real(inp)]):
            s = rn.summary_payload(None, subs, prevs, engine, top, None, None, brands, lines=every)
        mover = next(f for f in s["fixed"] if f["kind"] == "mover")
        self.assertEqual(mover["brand"], "Mazda")


class BoardOrder(unittest.TestCase):
    """Last review (2026-11-02): Website SOV hero said '2위 BMW' where Gold has Tata 0.235 > Toyota 0.222 > BMW 0.217; all
    three show 0.2, and the board broke the rounded tie by name."""

    def test_the_board_ranks_by_exact_values(self):
        row = lambda key, shown, exact_v: {"key": key, "own": False, "pct": Exact(shown, exact_v)}
        rows = rn._sort([row("BMW", 0.2, 0.217), row("Tata", 0.2, 0.235), row("Toyota", 0.2, 0.222)], rn._board_cmp)
        self.assertEqual([r["key"] for r in rows], ["Tata", "Toyota", "BMW"])

    def test_the_competitor_rows_rank_by_exact_values(self):
        def brand(name, exact_v, mentions):
            return {"brand": name, "isTracked": False, "mentions": mentions, "share": Exact(0.2, exact_v), "mentionRate": Exact(1.0, 1.0),
                    "prompts": 1, "avgPosition": None}
        brands = [brand("BMW", 0.217, 609), brand("Tata", 0.235, 658), brand("Toyota", 0.222, 620)]
        rows = rn._mv().competitor_kpi_rows({"brands": brands, "trend": None, "metric": "sov", "ownPct": 50.0})
        self.assertEqual([r["brand"] for r in rows], ["Tata", "Toyota", "BMW"])


class RankRoundCounts(unittest.TestCase):
    """2026-11-02 premise review: the original's 우선 노출도 tooltip named each round's ranked answers and its table marked
    당사 '{n}위 · 상위 {pct}%' (the table's brands the base, a brand without a rank stands after them,
    first-rank-kpi-tab). The renewal kept the latest count only."""

    @staticmethod
    def row(brand: str, own: bool, pos: float | None, ranked: int) -> dict:
        return {"brand": brand, "isTracked": own, "avgPosition": pos, "rank": None if own else 2, "rankedAnswers": ranked, "mentions": ranked}

    def fp(self) -> dict:
        def bucket(day: str, rows: list[dict]) -> dict:
            return {"bucketStart": day, "answers": 100, "brands": rows, "measuredDays": 1}
        latest = [self.row("HMG", True, 2.4, 900), self.row("BMW", False, 1.5, 50), self.row("Audi", False, 3.0, 40), self.row("Ford", False, None, 0)]
        return {"unit": "week", "latest": latest, "brands": ["HMG", "BMW"], "overviewCards": None,
                "buckets": [bucket("2026-09-28", [self.row("HMG", True, 2.1, 800), self.row("BMW", False, 1.4, 60)]),
                            bucket("2026-10-05", [self.row("HMG", True, 2.4, 900), self.row("BMW", False, 1.5, 50)])],
                "windowStartBucket": "2026-09-28", "windowEndBucket": "2026-10-05"}

    def test_every_round_names_its_ranked_answers(self):
        got = rn.rank_payload(self.fp(), None, [], None, False)
        self.assertEqual((got["hero"]["axis"], got["hero"]["rankedSeries"]), (["2026-09-28", "2026-10-05"], [800, 900]))

    def test_a_round_without_a_position_has_no_count(self):
        fp = self.fp()
        fp["buckets"][0]["brands"] = [self.row("BMW", False, 1.4, 60)]
        self.assertEqual(rn.rank_payload(fp, None, [], None, False)["hero"]["rankedSeries"], [None, 900])

    def test_the_standing_is_the_tables_place(self):
        got = rn.rank_payload(self.fp(), None, [], None, False)
        self.assertEqual(got["standing"], {"rank": 2, "total": 4, "topPct": 50})

    def test_no_position_no_standing(self):
        self.assertIsNone(rn.rank_payload(None, None, [], None, False)["standing"])


class ShellOwnSum(unittest.TestCase):
    """2026-11-02 premise review: the '당사 = Hyundai+Kia+Genesis 합산' chip counted the tracked brand rows, and since the
    reader sends the perspective as one row (2026-10-29 R1) there is one: the chip never showed, with or without the
    dense layout. The names come from the reader's `own.brands`; the rows stay what the page highlights."""

    def test_the_shell_names_the_brands_of_the_sum(self):
        row = {"brand": "HMG", "isTracked": True, "mentions": 1, "prompts": 1, "share": 1, "mentionRate": 1, "avgPosition": 1, "sentiment": {}}
        got = rn.shell_payload({"brands": [row]}, False, None, ["Hyundai", "Kia", "Genesis"])
        self.assertEqual((got["ownBrands"], got["ownSum"]), (["HMG"], ["Hyundai", "Kia", "Genesis"]))

    def test_no_measurement_names_no_brands(self):
        self.assertEqual(rn.shell_payload(None, False, None, ["Kia"])["ownSum"], [])


class Markets(unittest.IsolatedAsyncioTestCase):
    """mention/rn-markets (2026-11-02, docs/handoff/website-mention-redesign.md): the Website Mention's market table, the
    page's KPIs per country from the same /v1/geo read as the Overview's, this round beside the one before, a column per
    brand, and the 미언급 counts per country. A brand outside the account's scope is never read: access.clamp would turn it
    into a brand of the scope and the column would show another brand's value."""

    @staticmethod
    def geo_row(code: str, num: int, den: int = 100) -> dict:
        own = {"visibility": {"num": num, "den": den}, "share_of_voice": {"num": 9, "den": 10}, "sentiment": {"num": 1, "den": 4},
               "position": {"sum": 11, "count": 10}}
        return {"code": code, "answers": den, "own": own, "top_rival": {"brand": "BMW", "metrics": {"visibility": {"num": 3, "den": den}}}}

    def api(self, seen: list):
        async def get(path, params=None):
            p = dict(params or {})
            seen.append((path, p))
            await asyncio.sleep(0)
            if path == "geo":
                brand = (p.get("brand") or [None])[0]
                prev = p.get("cycle_offset") == 1 or p.get("from") == "2026-08-01"
                num = {None: 90, "Hyundai": 0, "Kia": 99, "Genesis": 100}[brand] + (5 if prev and brand is None else 0)
                num = 99 if prev and brand == "Hyundai" else num
                return {"data": {"markets": [{"countries": [self.geo_row("US", num)]}]}, "meta": {}}
            if path == "mentions/market-gaps":
                return {"data": {"items": [{"country": "US", "missing": 8, "with_brands": 3, "answers_no_brand": 12}]}, "meta": {}}
            if path == "filters/options":
                return {"data": {"regions": [{"code": "US"}, {"code": "CO"}, {"code": "DE"}], "languages": [],
                                 "geo_matrix": [{"brand": "Kia", "region": "US", "lang": "en"}, {"brand": "Kia", "region": "CO", "lang": "es"},
                                                {"brand": "Hyundai", "region": "DE", "lang": "de"}]}, "meta": {}}
            raise HTTPException(503, "boom")
        return get

    async def build(self, query: str = "", scope: dict | None = None) -> tuple[dict, list]:
        from bff import access
        seen: list = []
        with mock.patch("bff.api.get", self.api(seen)), access.scoped(scope or access.ALL):
            got = await screens.build("mention/rn-markets", QueryParams(f"ctx.surface=website&ctx.admin=true{query}"))
        return got, seen

    async def test_a_row_of_kpis_this_round_and_the_change(self):
        got, _ = await self.build()
        self.assertEqual(got["brands"], ["Hyundai", "Kia", "Genesis"])
        row = got["rows"][0]
        self.assertEqual((row["country"], row["answers"], row["mentioned"], row["mentionedDelta"]), ("US", 100, 90, -5))
        self.assertEqual(row["values"], {"exposure": 90.0, "sov": 90.0, "favorability": 25.0, "first-rank": 1.1})
        self.assertEqual(row["deltas"]["exposure"], -5.0)
        self.assertEqual(row["deltas"]["sov"], 0.0)
        self.assertEqual((row["missing"], row["missingWithBrands"], row["noBrandAnswers"]), (8, 3, 12))
        self.assertEqual(row["rival"], {"brand": "BMW", "exposure": 3.0})

    async def test_each_brand_column_reads_its_own_perspective(self):
        got, seen = await self.build()
        cells = got["rows"][0]["brands"]
        self.assertEqual((cells["Hyundai"]["exposure"], cells["Kia"]["exposure"], cells["Genesis"]["exposure"]), (0.0, 99.0, 100.0))
        self.assertEqual(cells["Hyundai"]["delta"], -99.0)
        self.assertEqual(sorted({(p.get("brand") or [""])[0] for path, p in seen if path == "geo"}), ["", "Genesis", "Hyundai", "Kia"])

    async def test_the_previous_round_is_the_cycle_before(self):
        _, seen = await self.build()
        offsets = [p.get("cycle_offset") for path, p in seen if path == "geo"]
        self.assertEqual((offsets.count(1), offsets.count(None)), (4, 4))

    async def test_a_period_compares_with_the_period_before(self):
        got, seen = await self.build("&time=2026-09-01..2026-09-30")
        self.assertNotIn(1, [p.get("cycle_offset") for path, p in seen if path == "geo"])
        self.assertEqual(sorted({p.get("from") for path, p in seen if path == "geo"}), ["2026-08-01", "2026-09-01"])
        self.assertEqual(got["rows"][0]["deltas"]["exposure"], -5.0)

    async def test_a_scoped_account_reads_its_own_brands_only(self):
        got, seen = await self.build(scope={"brands": ["Kia", "Genesis"]})
        self.assertEqual(got["brands"], ["Kia", "Genesis"])
        self.assertEqual({(p.get("brand") or [None])[0] for path, p in seen if path == "geo"} - {None}, {"Kia", "Genesis"})

    async def test_one_brand_needs_no_columns(self):
        for query, scope in (("&brand=Kia", None), ("", {"brands": ["Kia"]})):
            got, seen = await self.build(query, scope)
            self.assertEqual(got["brands"], [], query)
            self.assertEqual(len([1 for path, _ in seen if path == "geo"]), 2, query)

    async def test_markets_with_no_answers_this_round_are_counted(self):
        got, _ = await self.build()
        self.assertEqual(got["unmeasured"], 2)
        filtered, _ = await self.build("&geography=US")
        self.assertEqual(filtered["unmeasured"], 0)

    async def test_a_brand_pick_counts_only_the_markets_with_its_site(self):
        """Last review (2026-11-02): with Kia picked the note said 34 markets had no answer, 19 of them have no Kia site."""
        for query, scope in (("&brand=Kia", None), ("", {"brands": ["Kia"]})):
            got, _ = await self.build(query, scope)
            self.assertEqual(got["unmeasured"], 1, query)

    async def test_a_failed_read_says_so(self):
        async def get(path, params=None):
            raise HTTPException(503, "boom")
        with mock.patch("bff.api.get", get):
            got = await screens.build("mention/rn-markets", QueryParams("ctx.surface=website"))
        self.assertEqual((got["rows"], got["degraded"]), ([], True))


class BumpZeroIsGold(unittest.TestCase):
    """Renewal audit 8-4 (not reproduced, nothing changed): a brand without a row in a round that has answers is drawn
    at 0 mentions on the bump, ranked after the others. That is Gold's meaning: the cell tables keep no 0 row, so a
    round with answers and no row of the brand is 0 mentions (renewal audit U2). A round without answers is a gap
    (no point), as before."""

    def test_a_brand_missing_from_a_measured_round_is_zero_and_an_unmeasured_round_a_gap(self):
        def row(brand: str, mentions: int, own: bool = False) -> dict:
            return {"brand": brand, "isTracked": own, "mentions": mentions, "answers": mentions, "exposurePct": 1.0, "sharePct": 1.0}
        bucket = lambda day, rows: {"bucketStart": day, "answers": 100, "totalMentions": 300, "measuredDays": 1, "firstAt": None,
                                    "lastAt": None, "brands": rows}
        trend = {"unit": "week", "brands": [{"brand": b, "isTracked": b == "Kia", "mentions": 1} for b in ("Kia", "Toyota", "Tesla")],
                 "buckets": [bucket("2026-09-07", [row("Kia", 50, True), row("Toyota", 40), row("Tesla", 30)]),
                             bucket("2026-09-21", [row("Kia", 50, True), row("Toyota", 40)])],
                 "windowStartBucket": "2026-09-07", "windowEndBucket": "2026-09-21"}
        d = rn.bump_data(trend)
        self.assertEqual(d["x"], ["2026-09-07", "2026-09-14", "2026-09-21"])
        tesla = next(s for s in d["series"] if s["key"] == "Tesla")
        self.assertEqual((tesla["mentions"], tesla["ranks"]), ([30, None, 0], [3, None, 3]))


class RedesignValues(unittest.IsolatedAsyncioTestCase):
    """Global Mention 개편 (2026-11-05, docs/handoff/global-mention-redesign.md): the values the new page adds. Each is the
    page's own definition read again under an existing filter axis, or values the screens already send lined up."""

    def test_gap_series_reads_plus_as_ahead(self):
        self.assertEqual(rn.gap_series([40.0, 38.5, None], [10.0, 40.0, 5.0]), [30.0, -1.5, None])
        # first-rank: smaller is mentioned first, so a rival at 3.9 behind 당사's 2.4 is +1.5
        self.assertEqual(rn.gap_series([2.4, 3.0], [3.9, 2.5], lower_is_better=True), [1.5, -0.5])

    def test_fav_standing_ranks_the_perspective_among_rivals(self):
        def row(brand, pos, tracked=False):
            return {"brand": brand, "isTracked": tracked, "sibling": False, "sentimentPct": None if pos is None else {"positive": pos}}
        drawer = [row("HMG", 54.0, True), row("Toyota", 72.0), row("BMW", 60.0), row("Tesla", 50.0), row("Rivian", None), row("Kia", 53.0, True)]
        self.assertEqual(rn.fav_standing(drawer), {"rank": 3, "n": 4})
        self.assertIsNone(rn.fav_standing([row("Toyota", 70.0)]))

    async def build(self, name: str, query: str = "") -> dict:
        return await screens.build(name, QueryParams(query))

    async def test_presence_split_reads_each_presence(self):
        seen: list = []
        real = rn._md().load_kpi_hero_sub_kpis

        async def spy(filters, ctx, metric):
            seen.append((tuple(filters.get("brandPresence") or ()), metric))
            return await real(filters, ctx, metric)

        with mock.patch("bff.api.get", await _failing_get(503)), mock.patch.object(rn._md(), "load_kpi_hero_sub_kpis", spy):
            out = await self.build("mention/rn-presence-split")
        self.assertFalse(out["applied"])
        self.assertEqual(set(out["presences"]), {"unbranded", "branded"})
        self.assertEqual({p for p, _ in seen}, {("unbranded",), ("branded",)})
        self.assertEqual({m for _, m in seen}, set(rn.HERO_METRICS))
        # a failed read leaves the values empty, not made up
        self.assertIsNone(out["presences"]["unbranded"]["own"]["exposure"])
        self.assertEqual(out["presences"]["branded"]["brands"], {})

    async def test_presence_split_says_when_the_page_picks_a_presence(self):
        self.assertEqual(await self.build("mention/rn-presence-split", "brandPresence=branded"), {"applied": True, "presences": {}})

    async def test_engine_extra_reads_each_engine(self):
        seen: list = []
        real = rn._md().load_first_position

        async def spy(filters, ctx, **kw):
            seen.append(tuple(filters.get("engine") or ()))
            return await real(filters, ctx, **kw)

        with mock.patch("bff.api.get", await _failing_get(503)), mock.patch.object(rn._md(), "load_first_position", spy):
            out = await self.build("mention/rn-engine-extra", "engine=chatgpt&engine=gemini")
        self.assertEqual([e["engine"] for e in out["engines"]], ["chatgpt", "gemini"])
        self.assertEqual(sorted(seen), [("chatgpt",), ("gemini",)])
        # a failed read leaves the values empty (no number made up) and marks the section degraded
        self.assertTrue(out["degraded"])
        self.assertTrue(all((e["favorability"] or {}).get("pct") is None and e["firstRank"] is None for e in out["engines"]))
