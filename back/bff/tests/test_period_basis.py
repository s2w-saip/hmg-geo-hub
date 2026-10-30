"""Period mode (a closed URL period): a Δ compares the period with the period before it, on the values the page
shows (2026-10-29 metric review R3)."""
import asyncio
import re
import unittest
from datetime import date
from unittest import mock

try:
    from starlette.datastructures import QueryParams

    from bff.gold_reader import compare
    from bff.gold_reader.context import Context
    from bff.gold_reader.metrics import COUNTS
    from bff.screens import _compare, citation, citation_model, mention_data, mention_renewal, overview
    from bff.screens._convert import pct1_or_zero, rank_avg
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_period_basis)") from exc

D1, D2 = date(2026, 10, 4), date(2026, 10, 5)  # a one-day window and the day before it


def counts_row(day, **values):
    row = dict.fromkeys(COUNTS, 0)
    row.update(round_date=day, measured_prompts=0, mentioned_prompts=0, **values)
    return row


class Conn:
    """Answers the cycle ledger and the kpi cells of each population (bound as population_key)."""

    def __init__(self, by_population):
        self.by_population = by_population

    async def fetch(self, sql, *args):
        if "FROM gold.kpi_cell" in sql:
            m = re.search(r"population_key=\$(\d+)", sql)
            return self.by_population[args[int(m.group(1)) - 1]]
        if "FROM gold.dim_cycle" in sql:
            return [{"round_date": d, "hidden_scope": 0, "servable": True, "in_release": True, "expected_units": 1, "status": 1}
                    for d in (D1, D2)]
        raise AssertionError(sql[:100])


class CompareReader(unittest.TestCase):
    def test_citations_per_answer_counts_the_answers_of_the_citation_population(self):
        # Citation 월 비교 줄 ▲70.0% vs Gold +52.9%: the answers came from the mention population
        conn = Conn({1: [counts_row(D1, answers=100, gap_base=100), counts_row(D2, answers=100, gap_base=100)],
                     2: [counts_row(D1, cit_total=300, gap_base=60), counts_row(D2, cit_total=500, gap_base=50)]})
        ctx = Context(conn, QueryParams("surface=global&kind=window&from=2026-10-05&to=2026-10-05&metrics=citations_per_answer"))
        ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
        ctx.builds = {"cell": [1]}
        ctx.dates = [D2, D1]
        ctx.selected_dates = [D2]
        item = asyncio.run(compare.read(ctx))["data"][0]
        self.assertEqual((item["prev"], item["cur"]), ({"num": 300, "den": 60}, {"num": 500, "den": 50}))


def cycle(day, *, published=True, expected=1):
    return {"round_date": day, "hidden_scope": 0, "servable": published, "in_release": published,
            "expected_units": expected, "status": 1}


class LedgerConn:
    """The cycle ledger `cycles` and one kpi row per measured day (answers 100, tracked `tracked[day]`)."""

    def __init__(self, cycles, tracked):
        self.cycles, self.tracked = cycles, tracked

    async def fetch(self, sql, *args):
        if "FROM gold.kpi_cell" in sql:
            return [counts_row(d, answers=100, tracked=n, cit_total=10, gap_base=100) for d, n in self.tracked.items()]
        if "FROM gold.dim_cycle" in sql:
            return self.cycles
        raise AssertionError(sql[:100])


def compare_item(query, cycles, tracked):
    """The visibility item of one kpi/compare read over `cycles` (selectable dates = the measured days)."""
    ctx = Context(LedgerConn(cycles, tracked), QueryParams(f"surface=global&metrics=visibility&{query}"))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.builds = {"cell": [1]}
    ctx.dates = sorted(tracked, reverse=True)
    ctx.selected_dates = ctx.dates[:1]
    return asyncio.run(compare.read(ctx))["data"][0]


class CompareSuppression(unittest.TestCase):
    """⛔K (2026-10-31, admin-todo rule 5: a value that jumps because the measured range changed is shown, not hidden or
    warned about): only a comparison without a value to compare is suppressed (unsupported · no_prev · no_data). A thin
    collection (missing_share), a previous period at the start of measurement (start_window · start_month) and a period
    before the 2026-09-08 cut-off still compare."""

    def assert_compared(self, item, delta):
        self.assertEqual([item["suppressed"], item["reason"], item["delta"]], [False, None, delta])

    def test_a_thin_collection_still_compares(self):
        # the previous round collected 1 of 2 planned units (50 % missing ≥ 30 %): was missing_share
        d1, d2 = date(2026, 9, 28), date(2026, 10, 5)
        item = compare_item("kind=cycle", [cycle(d1), cycle(d1, published=False), cycle(d2)], {d1: 40, d2: 50})
        self.assertEqual(item["missing_share_prev"], 0.5)
        self.assert_compared(item, 10.0)

    def test_a_previous_window_at_the_start_of_measurement_still_compares(self):
        # 8 days: prev 09-20..09-27, the first published round 09-24 > 09-20 + grace 2: was start_window
        first, d2 = date(2026, 9, 24), date(2026, 10, 1)
        item = compare_item("kind=window&from=2026-09-28&to=2026-10-05", [cycle(first), cycle(d2)], {first: 40, d2: 50})
        self.assert_compared(item, 10.0)

    def test_a_previous_month_at_the_start_of_measurement_still_compares(self):
        # 2026-10 vs 2026-09, measurement started 09-14 (> day 7) with no August data: was start_month
        first, d2 = date(2026, 9, 14), date(2026, 10, 5)
        item = compare_item("kind=calendarMonth&from=2026-10-01&to=2026-10-05", [cycle(first), cycle(d2)], {first: 40, d2: 50})
        self.assert_compared(item, 10.0)

    def test_a_period_before_the_cut_off_compares(self):
        # cur ends 2026-08-31 < 2026-09-08 (the original API's PERIOD_COMPARE_EPOCH gate)
        d1, d2 = date(2026, 8, 24), date(2026, 8, 31)
        self.assert_compared(compare_item("kind=cycle", [cycle(d1), cycle(d2)], {d1: 40, d2: 50}), 10.0)

    def test_without_a_value_to_compare_it_is_still_suppressed(self):
        d2 = date(2026, 10, 5)
        no_prev = compare_item("kind=cycle", [cycle(d2)], {d2: 50})
        self.assertEqual([no_prev["suppressed"], no_prev["reason"], no_prev["delta"]], [True, "no_prev", None])
        # the previous day's round was published but this filter has no answer in it
        no_data = compare_item("kind=window&from=2026-10-05&to=2026-10-05", [cycle(date(2026, 10, 4)), cycle(d2)], {d2: 50})
        self.assertEqual([no_data["suppressed"], no_data["reason"], no_data["delta"]], [True, "no_data", None])


class CompareQuery(unittest.TestCase):
    def test_the_card_basis_follows_the_values_the_page_shows(self):
        req = {"surface": "global", "kind": "window", "metrics": ["share"]}
        self.assertTrue(_compare.compare_query({}, req)["card"])  # the Overview cards are card values
        self.assertNotIn("card", _compare.compare_query({}, {**req, "card": False}))

    def test_mention_compares_its_live_values(self):
        # Mention C: 점유율 Δ ▲0.3 (card) next to a live 40.0 % (live Δ +0.4)
        calls = []

        async def get(path, params=None):
            calls.append((path, dict(params)))
            return {"data": [], "meta": {}}

        with mock.patch("bff.api.get", get):
            asyncio.run(mention_data.load_period_compare({"dateFrom": "2026-09-21", "dateTo": "2026-10-05"}, {"surface": "global"}))
        self.assertEqual([p for p, _ in calls], ["kpi/compare"])
        self.assertNotIn("card", calls[0][1])


def brand(name, *, own=False, mentions=10, rate=(0, 1), share=(0, 1), rank=(0, 0)):
    return {"brand": name, "isTracked": own, "mentions": mentions, "prompts": 1, "sentiment": {},
            "mentionRate": pct1_or_zero({"num": rate[0], "den": rate[1]}), "share": pct1_or_zero({"num": share[0], "den": share[1]}),
            "avgPosition": rank_avg({"sum": rank[0], "count": rank[1]})}


class MentionPeriod(unittest.TestCase):
    """C: the 경쟁 구도 column held 당사's period Δ next to the rivals' last-round Δ, and the summary called the
    period Δ "직전 회차 대비". A rival's Δ next to its period total compares it with the period before."""

    def test_the_previous_period_is_the_compare_window(self):
        prev = mention_data.prev_period_filters({"dateFrom": "2026-09-21", "dateTo": "2026-10-05", "geography": ["US"]})
        self.assertEqual(prev, {"dateFrom": "2026-09-06", "dateTo": "2026-09-20", "geography": ["US"]})
        self.assertIsNone(mention_data.prev_period_filters({"dateFrom": None, "dateTo": None}))

    def hero(self):
        return {"pct": 76.6, "delta": {"value": 1.4}, "points": []}

    def test_the_board_compares_each_rival_with_its_previous_period(self):
        cur = [brand("HMG", own=True, rate=(766, 1000)), brand("BMW", rate=(3020, 10000)), brand("Tesla", rate=(2500, 10000))]
        prev = [brand("HMG", own=True, rate=(752, 1000)), brand("BMW", rate=(2880, 10000))]
        b = mention_renewal.board({"metric": "exposure", "brands": cur, "trend": None, "values": None, "hero": self.hero(),
                                   "prevBrands": prev})
        self.assertEqual({r["key"]: r["delta"] for r in b["rows"]}, {"__own": 1.4, "BMW": 1.4, "Tesla": None})

    def test_the_ranking_compares_shares_with_the_previous_period(self):
        cur = [brand("HMG", own=True, share=(4004, 10000)), brand("Toyota", share=(705, 10000))]
        prev = [brand("HMG", own=True, share=(3963, 10000)), brand("Toyota", share=(668, 10000))]
        self.assertEqual(mention_renewal.period_share_deltas(cur, prev), {"HMG": 0.4, "Toyota": 0.4})

    def test_the_rank_board_compares_positions_with_the_previous_period(self):
        prev = [brand("Tesla", rank=(3900, 1000))]
        fp = {"unit": "week", "brands": ["Tesla"], "buckets": [], "latest": [
            {"brand": "Tesla", "isTracked": False, "avgPosition": rank_avg({"sum": 3700, "count": 1000}), "rank": 2,
             "rankedAnswers": 1000, "mentions": 50}]}
        hero = {"avgPosition": 2.3, "series": [], "delta": {"value": 0.0}}
        rows = mention_renewal.rank_board(fp, None, hero, prev)["rows"]
        self.assertEqual({r["key"]: r["delta"] for r in rows}, {"__own": 0.0, "Tesla": -0.2})

    def test_the_engine_cards_compare_with_the_previous_period(self):
        engine = {"unit": "week", "engines": ["chatgpt"], "buckets": [],
                  "latest": [{"engine": "chatgpt", "answers": 1000, "totalMentions": 1000,
                              "exposurePct": pct1_or_zero({"num": 774, "den": 1000}), "sovPct": pct1_or_zero({"num": 4, "den": 10})}],
                  "latestBrands": [], "typeTrend": [], "overviewSlots": [], "trendGrid": []}
        prev = {"chatgpt": {"exposurePct": pct1_or_zero({"num": 7605, "den": 10000}), "sovPct": None}}
        rows = mention_renewal.engine_rows(engine, "exposure", prev)["rows"]
        self.assertEqual([(r["engine"], r["delta"]) for r in rows], [("chatgpt", 1.4)])


def sources(total, **by_slug):
    return {"data": {"total_citations": total, "categories": [
        {"category": {"slug": slug, "name": slug}, "citations": n, "top_sources": []} for slug, n in by_slug.items()], "by_engine": []}, "meta": {}}


class CitationPeriod(unittest.TestCase):
    """C: the tiles and the category list showed a period total with the last round's Δ and previous share
    (공식(HMG) 24.7 % ▲1.3pp; 24.7 − 23.7 = 1.0)."""

    def deltas(self):
        calls = []

        async def get(path, params=None):
            calls.append((path, dict(params)))
            assert path == "citations/sources", path
            return sources(1000, official=247, other=266) if params["from"] == "2026-09-21" else sources(800, official=160, other=240)

        filters = {"dateFrom": "2026-09-21", "dateTo": "2026-10-05"}
        with mock.patch("bff.api.get", get):
            out = asyncio.run(citation.load_deltas(citation.Reads(filters, {"surface": "global"})))
        return out, calls

    def test_the_previous_values_are_the_period_before(self):
        out, calls = self.deltas()
        self.assertEqual(sorted((c["from"], c["to"]) for _, c in calls), [("2026-09-06", "2026-09-20"), ("2026-09-21", "2026-10-05")])
        prev = out["prevCategories"]
        self.assertEqual(prev["period"], {"from": "2026-09-06", "to": "2026-09-20"})
        self.assertIsNone(out["officialDelta"])
        name = citation_model.category_label_of({"slug": "official", "name": "official"}) or "official"
        # 24.7 % now, 20.0 % before: +4.7 (the last round's Δ was +1.3)
        self.assertEqual(citation_model.category_delta(prev, name, None), 4.7)
        self.assertEqual(citation_model.prev_category_share(prev, name), 20.0)


class OverviewPeriod(unittest.TestCase):
    """C: the AI 인용 점유율 card alone showed the round Δ (▲1.3) under the period comparison header (Gold +4.9)."""

    def test_the_citation_share_card_compares_the_periods(self):
        q = _compare.compare_query({}, {"surface": "global", "kind": "window", "metrics": overview.OVERVIEW_COMPARE_METRICS})
        self.assertIn("citation_share", q["metrics"])
        compare = _compare.to_compare_results(
            [{"metric": "citation_share", "unit": "pp", "prev": {"num": 198, "den": 1000}, "cur": {"num": 247, "den": 1000},
              "suppressed": False, "reason": None}], ["citationShare"])
        cards = {c["key"]: c for c in overview.overview_cards(
            [{"key": "citationShare", "value": 24.7, "pending": False}], compare, 15, {"todayKst": "2026-10-29"})}
        chip = cards["citationShare"]["period"]["chip"]
        self.assertEqual((chip["key"], chip["unit"], chip["value"], chip["direction"]), ("citationShare", "pp", 4.9, "up"))


if __name__ == "__main__":
    unittest.main()
