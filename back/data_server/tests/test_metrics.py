"""The metric layer without a database: the catalog against SSOT's list, and the pure calculation."""
import asyncio
import unittest
from datetime import date, datetime

try:
    from starlette.datastructures import QueryParams

    from data_server.gold_reader.context import SQL, Context
    from data_server.metrics import gold_judged, judgments
    from data_server.metrics import formulas as f
    from data_server.metrics.catalog import BASE_COUNTS, COMMON_CONDITIONS, DEFINITION_VERSION, METRICS, POPULATIONS
    from data_server.metrics.gold_current import GoldCurrentSource
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_metrics)") from exc


class Catalog(unittest.TestCase):
    def test_ssot_lists_19_metrics_and_7_conditions(self):
        names = {m.name.split(" · ")[0] for m in METRICS if m.ssot}
        self.assertEqual(len(names), 19, sorted(names))
        self.assertEqual(len(COMMON_CONDITIONS), 7)
        self.assertTrue(DEFINITION_VERSION)

    def test_every_formula_names_defined_counts(self):
        for m in METRICS:
            if m.kind != "derived":
                self.assertIn(m.num, BASE_COUNTS, m.key)
                self.assertIn(m.population, POPULATIONS, m.key)
                if m.kind != "count":
                    self.assertIn(m.den, BASE_COUNTS, m.key)


class Formulas(unittest.TestCase):
    def test_values_keep_the_shapes_the_screens_read(self):
        self.assertEqual(f.metric_value("exposure", {"tracked": 34255, "answers": 44740}), {"num": 34255, "den": 44740})
        self.assertEqual(f.metric_value("priority", {"rank_sum": 76687, "ranked": 34254}), {"sum": 76687, "count": 34254})
        self.assertIsNone(f.metric_value("priority", {"rank_sum": 0, "ranked": 0}))

    def test_delta_subtracts_exact_values_and_skips_rounds_without_one(self):
        points = [("09-21", f.rate(1, 4)), ("09-28", f.rate(1, 2)), ("10-05", f.rate(0, 0)), ("10-12", f.rate(3, 4))]
        self.assertEqual(f.last_delta(points), {"round": "10-12", "previous_round": "09-28", "delta": 25.0})
        self.assertIsNone(f.last_delta(points[2:]))
        self.assertEqual(f.previous_window(date(2026, 9, 1), date(2026, 9, 30)), (date(2026, 8, 2), date(2026, 8, 31)))

    def test_region_value_adds_counts_before_the_rate(self):
        region = f.rollup([{"tracked": 1, "answers": 2}, {"tracked": 90, "answers": 100}], ("tracked", "answers"))
        self.assertEqual(f.metric_value("exposure", region), {"num": 91, "den": 102})

    def test_representative_is_the_legacy_rule(self):
        combo = {"cycle": 1, "prompt": 1, "engine": 1, "country": 1, "lang": 1, "eligible": True}
        early, late = {**combo, "answer_key": 9, "measured_at": datetime(2026, 10, 5)}, {**combo, "answer_key": 3, "measured_at": datetime(2026, 10, 6)}
        self.assertEqual(f.representative([early, late]), [late])
        # a cycle has its own: one date can hold several cycles
        other = {**early, "cycle": 2}
        self.assertEqual(f.representative([early, late, other]), [late, other])
        # the lowest answer key on a tie
        tied = {**late, "answer_key": 2}
        self.assertEqual(f.representative([late, tied]), [tied])
        # the last answer not eligible: no representative, not the one before it
        self.assertEqual(f.representative([early, {**late, "eligible": False}]), [])

    def test_acr_states_and_winners(self):
        pairs = [{"prompt": 1, "engine": "e", "country": "US", "brand": "Kia", "is_own": True, "choice": 0, "appearance": 2},
                 {"prompt": 1, "engine": "e", "country": "US", "brand": "BMW", "is_own": False, "choice": 3, "appearance": 3},
                 {"prompt": 2, "engine": "e", "country": "US", "brand": "BMW", "is_own": False, "choice": 0, "appearance": 1}]
        self.assertEqual(f.own_states(pairs), {None: {"pick": 0, "listed": 1, "absent": 1}})
        self.assertEqual(f.prompt_winners(pairs), {(1, "e"): {"brand": "BMW", "choice": 3, "is_own": False}})


class Baselines(unittest.TestCase):
    """D-11 (2026-11-06): 경쟁사 평균 and the ACR brand average line. Both are references the data server defines, marked
    '분석팀 리뷰 필요'."""

    def test_the_average_is_over_the_values_there_are(self):
        self.assertEqual(f.rival_average([10, None, 20]), 15)
        self.assertEqual(f.rival_average([{"num": 1, "den": 4}, {"num": 0, "den": 0}]), 25)
        self.assertIsNone(f.rival_average([None]))

    def test_the_top_rivals_are_by_mentions_ties_as_given(self):
        rows = [{"brand": "a", "mentions": 1}, {"brand": "b", "mentions": 3}, {"brand": "c", "mentions": 3}, {"brand": "d", "mentions": 2}]
        self.assertEqual([r["brand"] for r in f.top_rivals(rows, 3)], ["b", "c", "d"])

    def test_the_line_runs_through_the_shortlisted_brands(self):
        self.assertEqual(f.average_line([(50, 30), (50, 10), (0, 40), (None, 40)]), 0.4)
        self.assertIsNone(f.average_line([(0, 40)]))

    def test_the_distance_is_from_the_line(self):
        self.assertEqual(f.line_distance(50, 30, 0.4), 10)
        self.assertIsNone(f.line_distance(50, 30, None))


class Adapter(unittest.TestCase):
    def test_refuses_the_card_release(self):
        class Card:
            card = True
        with self.assertRaises(ValueError):
            GoldCurrentSource(Card())


class OneAnswerPerAcrCell(unittest.TestCase):
    """SSOT 공통 조건: 'ACR 측정은 셀마다 최신 반복 1회만'. Upstream's std_in keeps each run's latest iteration (global 2026-10-05: 3,796
    answers on 3,576 cells), so the other ACR answers leave every fact read, whichever table it scans."""

    def context(self, older):
        ctx = Context(None, QueryParams("surface=global"))
        ctx.selected_dates, ctx.older_acr = [date(2026, 10, 5)], older
        return ctx

    def test_every_fact_read_leaves_them_out(self):
        b = SQL()
        where = self.context([7, 8]).predicate(b, "f", family="fact")
        self.assertIn("f.answer_key NOT IN (SELECT unnest(", where)   # hashed: <>ALL over a bound array took ten times as long
        self.assertIn([7, 8], b.args)

    def test_nothing_changes_without_such_answers_or_on_other_tables(self):
        self.assertNotIn("answer_key", self.context([]).predicate(SQL(), "f", family="fact"))
        self.assertNotIn("answer_key", self.context([7]).predicate(SQL(), "f", family="acr"))

    def test_the_keys_of_a_build_set_are_read_once(self):
        class Conn:
            reads = []

            async def fetchrow(self, sql, *args):
                self.reads.append(sql)
                return {"not_eligible": [1], "not_citation_monitoring": [1, 2], "not_monitoring": [1, 2, 3], "older_acr": [7]}

            async def fetch(self, sql, *args):
                return [{"brand_key": 5, "name": "apple"}, {"brand_key": 6, "name": "smart"}, {"brand_key": 9, "name": "bmw"}]
        gold_judged._memo.clear()
        self.addCleanup(gold_judged._memo.clear)

        async def main():
            conn = Conn()
            first = await gold_judged.populations(conn, 1, [2, 1])
            self.assertEqual(await gold_judged.populations(conn, 1, [1, 2]), first)
            self.assertEqual(len(conn.reads), 1)
            self.assertEqual((first.older_acr, first.not_monitoring, first.non_competitor, first.bare_only), ([7], [1, 2, 3], [5], [6]))
        asyncio.run(main())


class Judgments(unittest.TestCase):
    """The rules (data_server.metrics.judgments): legacy's, each equal to upstream's flag on every round of the Gold copy (test_metrics_live)."""

    C = judgments.AnswerColumns(run_finished="r", region="g", measured_at="t", in_standard_catalog="c", is_korean="k", prompt_regions="pr",
                                market_hidden="h", is_acr="a", acr_iteration="i", analysis_state="s", representative="rep")

    def test_own_url_is_every_url_of_a_registered_origin(self):
        # decision 2026-11-06 (D-25): '등록한 URL을 오리진으로 하는 모든 URL은 자사'. A subdomain is another origin.
        registered = judgments.registered_urls(["https://www.Genesis.com/kr/ko/"], [{"base": "kia.com/us/en"}, {"base": None}])
        self.assertEqual(registered, {"genesis.com", "kia.com"})
        for url in ("genesis.com", "https://www.genesis.com/ae/en/models", "kia.com/kr", "http://kia.com/us/en/x"):
            self.assertTrue(judgments.is_registered(url, registered), url)
        for url in ("eu-www.kia.com/de", "dealers.kia.com", "kia.com.cn/zh", "notkia.com/us/en", None):
            self.assertFalse(judgments.is_registered(url, registered), url)

    def test_only_global_asks_more_than_a_finished_run(self):
        self.assertEqual(judgments.eligible(self.C, is_global=False), "(r)")
        rule = judgments.eligible(self.C, is_global=True)
        for part in ("r AND c AND NOT h", "g<>'KR' AND k", judgments.REGION_TAGGING_CUTOFF, "g=ANY(pr)"):
            self.assertIn(part, rule)

    def test_the_populations_nest(self):
        citation = judgments.citation_monitoring(self.C, is_global=False)
        self.assertIn("NOT (a AND coalesce(i,0)>1)", citation)
        self.assertEqual(judgments.monitoring(self.C, is_global=False), f"({citation} AND s<2)")

    def test_an_answer_with_nothing_found_has_an_analysis(self):
        self.assertEqual([judgments.analysis_gap(s) for s in (0, 1, 2, None)], [False, False, True, False])

    def test_the_bare_only_names_are_in_the_dictionary(self):
        self.assertLessEqual(judgments.BARE_ONLY_NON_COMPETITORS, judgments.NON_COMPETITOR_BRANDS)
        self.assertIn("apple", judgments.NON_COMPETITOR_BRANDS)
        self.assertNotIn("hyundai", judgments.NON_COMPETITOR_BRANDS)

    def test_a_competitive_row_leaves_the_dictionary_out_and_keeps_a_bare_only_split(self):
        ctx = Context(None, QueryParams("surface=global"))
        ctx.populations = gold_judged.Populations(non_competitor=[5], bare_only=[6])
        rule = ctx.competitive(SQL(), "x")
        self.assertIn("x.brand_key NOT IN", rule)
        self.assertIn("x.competitive OR x.brand_key NOT IN", rule)


if __name__ == "__main__":
    unittest.main()
