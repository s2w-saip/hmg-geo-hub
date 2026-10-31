"""A Δ or a gap is the exact difference rounded once, never the difference of two rounded values
(2026-10-29 metric review R2). Each case is a mismatch the review found on Gold, with its counts."""
import unittest

try:
    from bff.screens import _competitors, _trend, acr, citation_model, mention_view
    from bff.screens._convert import pct1_or_null, rank_avg
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_exact_deltas)") from exc


def bucket(day, *, answers=100, tracked=50, total_m=1000, own_m=400, sent=100, pos=50, rank=(0, 0), cit=(0, 0)):
    return {"key": day, "round_dates": [day], "measured_days": None}, {
        "visibility": {"num": tracked, "den": answers}, "share_of_voice": {"num": own_m, "den": total_m},
        "sentiment": {"num": pos, "den": sent}, "position": {"sum": rank[0], "count": rank[1]},
        "citation_share": {"num": cit[0], "den": cit[1]}}


def trend_answer(*days):
    buckets, series = [], {}
    for b, values in days:
        buckets.append(b)
        for metric, v in values.items():
            point = {"bucket": b["key"], "rank" if metric == "position" else "ratio": v, "gap": False}
            series.setdefault(metric, []).append(point)
    return {"bucket": "cycle", "buckets": buckets,
            "series": [{"metric": m, "kind": "rank" if m == "position" else "ratio", "key": None, "points": ps} for m, ps in series.items()]}


class Overview(unittest.TestCase):
    # Overview A: AI 우선 노출도 2.286 → 2.345 (both 2.3: "no change"; exact +0.06 → +0.1)
    # Overview B: 점유율 40.65 → 39.41 (40.7 − 39.4 = −1.3; exact −1.24 → −1.2)
    def trend(self):
        return _trend.to_live_trend(trend_answer(
            bucket("2026-09-28", rank=(78304, 34255), own_m=4065, total_m=10000),
            bucket("2026-10-05", rank=(80314, 34255), own_m=3941, total_m=10000)))

    def test_card_deltas(self):
        cards = {k["key"]: k for k in _trend.apply_trend_deltas([{"key": "position"}, {"key": "shareOfVoice"}], self.trend())}
        self.assertEqual((cards["position"]["delta"], cards["position"]["direction"]), (0.1, "up"))
        self.assertEqual(cards["shareOfVoice"]["delta"], -1.2)

    def test_sparkline_wow(self):
        self.assertEqual([p["wow"] for p in _trend.spark_points(self.trend(), "shareOfVoice")], [None, -1.2])

    def test_card_delta_of_slots(self):
        # 공식(HMG) 인용 23.74 → 24.96: 25.0 − 23.7 = 1.3; exact +1.22 → +1.2
        slots = _trend.to_standard_trend_buckets(trend_answer(
            bucket("2026-09-28", cit=(2374, 10000)), bucket("2026-10-05", cit=(2496, 10000))))
        self.assertEqual(_trend.overview_card_delta(slots, "citationShare")["delta"], 1.2)

    def test_competitor_deltas(self):
        # Toyota 노출 27.44 → 27.95: 28.0 − 27.4 = 0.6; exact +0.51 → +0.5; 순위 2.286 → 2.345: 2.3 − 2.3 = 0; exact +0.06 → +0.1
        trend = {"brands": [{"brand": "Toyota"}], "buckets": [
            {"brands": [{"brand": "Toyota", "exposurePct": pct1_or_null({"num": 2744, "den": 10000})}]},
            {"brands": [{"brand": "Toyota", "exposurePct": pct1_or_null({"num": 2795, "den": 10000})}]}]}
        self.assertEqual(_competitors.competitor_trend_deltas(trend, "visibility"), {"Toyota": 0.5})
        first = {"brands": ["Toyota"], "buckets": [{"brands": [{"brand": "Toyota", "avgPosition": rank_avg({"sum": 2286, "count": 1000})}]},
                                                    {"brands": [{"brand": "Toyota", "avgPosition": rank_avg({"sum": 2345, "count": 1000})}]}]}
        self.assertEqual(_competitors.competitor_position_deltas(first), {"Toyota": 0.1})


class Mention(unittest.TestCase):
    def test_delta_pp_and_position(self):
        self.assertEqual(mention_view.delta_pp(pct1_or_null({"num": 3941, "den": 10000}), pct1_or_null({"num": 4065, "den": 10000})), -1.2)
        self.assertEqual(mention_view.delta_position(rank_avg({"sum": 2345, "count": 1000}), rank_avg({"sum": 2286, "count": 1000})), 0.1)


class Citation(unittest.TestCase):
    def test_category_delta(self):
        # the review's rows: 위키 0.0 vs exact ▼0.053, 커뮤니티 ▲0.3 vs exact ▲0.23, 기타 ▼2.0 vs exact ▼1.94
        prev = {"totals": {"total": 100000, "byCategory": {"wiki": 13449}}, "current": {"total": 100000, "byCategory": {"wiki": 13396}}}
        self.assertEqual(citation_model.category_delta(prev, "wiki", None), -0.1)  # 13.449 → 13.396: 13.4 − 13.4 = 0; exact −0.053 → −0.1
        prev = {"totals": {"total": 10000, "byCategory": {"forum": 424}}, "current": {"total": 100000, "byCategory": {"forum": 4470}}}
        self.assertEqual(citation_model.category_delta(prev, "forum", None), 0.2)  # 4.24 → 4.47: 4.5 − 4.2 = 0.3; exact 0.23 → 0.2
        prev = {"totals": {"total": 10000, "byCategory": {"etc": 2246}}, "current": {"total": 100000, "byCategory": {"etc": 20520}}}
        self.assertEqual(citation_model.category_delta(prev, "etc", None), -1.9)  # 22.46 → 20.52: 20.5 − 22.5 = −2.0; exact −1.94 → −1.9

    def test_delta_axis_rounds_the_exact_delta_up(self):
        # 기타 ▼1.944 shows ▼1.9; the axis is ±2.0 (1.944 up to 0.1), as before the Δ was exact
        prev = {"totals": {"total": 10000, "byCategory": {"etc": 2760}}, "current": {"total": 100000, "byCategory": {"etc": 25656}}}
        d = citation_model.category_delta(prev, "etc", None)
        self.assertEqual(d, -1.9)
        self.assertEqual(citation_model.delta_axis([{"delta": d}]), 2.0)
        self.assertEqual(citation_model.delta_axis([{"delta": citation_model.delta_pp(1.9, 0)}]), 1.9)

    def test_opportunity_share_is_rounded_once_to_its_display(self):
        # 미인용 5,758 of 11,404 = 50.49 %: round1 → 50.5 then the page's toFixed(0) → "51"; once → 50
        found = citation_model.findings([], None, [], None, None, {"kind": "ok", "owned": 5646, "uncited": 5758}, None)
        self.assertEqual(next(f for f in found if f["kind"] == "opportunity")["params"]["share"], 50)


class Acr(unittest.TestCase):
    def view(self):
        data = {"measured": True,
                "brands": [{"brand": "Toyota", "isOurs": False, "choiceCount": 6374, "appearanceCount": 1,
                            "choiceShare": pct1_or_null({"num": 6374, "den": 35927}), "coverage": pct1_or_null({"num": 3000, "den": 3761})},
                           {"brand": "BMW", "isOurs": False, "choiceCount": 1000, "appearanceCount": 1,
                            "choiceShare": pct1_or_null({"num": 1000, "den": 35927}), "coverage": pct1_or_null({"num": 1234, "den": 3761})}],
                "own": {"choiceCount": 4441, "appearanceCount": 1, "choiceShare": pct1_or_null({"num": 4441, "den": 35927}),
                        "coverage": pct1_or_null({"num": 3468, "den": 3761})},
                "ownBrands": ["Hyundai"], "ownStanding": {"rank": 2, "of": 3},
                "trend": [], "battle": [], "modelConversion": [], "territory": [],
                "totals": {"promptRuns": 3761, "prompts": 1, "iterations": 35927, "engines": []}}
        return acr.renewal_view(data, data["own"], True, False)

    def test_gap_to_the_leader(self):
        # 당사 12.361 · Toyota 17.741: 12.4 − 17.7 = −5.3; exact −5.38 → −5.4
        v = self.view()
        self.assertEqual(v["gap"], -5.4)
        self.assertEqual(next(f for f in v["findings"] if f["kind"] == "standing")["params"]["gap"], 5.4)

    # the map's average line (k) and the distance to it (dev) are gone (2026-10-31 ⛔L, renewal audit 15)


if __name__ == "__main__":
    unittest.main()


class Other(unittest.TestCase):
    """R6: a domain uncited in a week got a rank (kia.com 13위 in its first, uncited week); a treemap group's share
    divided by the shown brands' mentions (HMG 39.0 for 38.7 of every mention)."""

    def test_an_uncited_week_has_no_rank(self):
        from bff.screens import citation_model
        trend = {"series": ["kia.com", "toyota.com"], "points": [{"week": "2026-09-28", "kia.com": 0, "toyota.com": 4.0},
                                                                 {"week": "2026-10-05", "kia.com": 6.0, "toyota.com": 4.0}]}
        bump = citation_model.domain_bump(trend, [])
        self.assertEqual([s["ranks"] for s in bump["series"]], [[None, 1], [1, 2]])

    def test_a_treemap_group_shares_every_mention(self):
        from bff.screens import mention_renewal
        rows = [{"brand": "HMG", "value": 387, "share": 38.7, "delta": None, "own": True, "sibling": False},
                {"brand": "Toyota", "value": 101, "share": 10.1, "delta": None, "own": False, "sibling": False}]
        groups = {g["key"]: g["share"] for g in mention_renewal.treemap_groups(rows, 1000)}
        self.assertEqual(groups["HMG"], 38.7)
