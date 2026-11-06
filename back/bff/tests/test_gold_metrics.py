"""Gold metric readers (bff.gold_reader.metrics) over a recording stand-in connection: which statements a
read issues (the Overview's load) and what it answers from their rows."""
import asyncio
import re
import unittest
from datetime import date

try:
    from starlette.datastructures import QueryParams

    from bff.gold_reader import metrics
    from bff.gold_reader.context import AXES, Context
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_gold_metrics)") from exc


def setUpModule():
    from bff.tests.stand_ins import no_judged_answers
    no_judged_answers()

D1, D2 = date(2026, 9, 28), date(2026, 10, 5)


def counts_row(**values) -> dict:
    """One row that answers each read of the adapter over the answers (bff.metrics.gold_current: answer_counts,
    citation_counts, own_brand_counts), which takes the columns it selects. The names a test gives are counts()'s:
    answers · tracked = the representative answers, answers_mon = the monitoring ones (as many unless given), cit_* ·
    gap_base = the citation read's."""
    given = {**dict.fromkeys(metrics.COUNTS, 0), "measured_prompts": 0, "mentioned_prompts": 0, **values}
    return {**given, "rep_answers": given["answers"], "rep_tracked": given["tracked"],
            "answers": values.get("answers_mon", given["answers"]),
            "base_answers": given["gap_base"], "citations": given["cit_total"], "citations_all": given["cit_total_all"],
            "official": given["cit_m05"], "target": given["cit_target"], "owned": given["cit_owned"], "owned_or_target": 0}


def brand_row(day, key, name, own_bit, mentions, answers, *, positive=0, neutral=0, mixed=0, negative=0, **values) -> dict:
    """One row of the adapter's brand read (brand_counts). `answers` = the brand's representative answers, the sentiments
    are its s_* sums."""
    return {"round_date": day, "brand_key": key, "name": name, "own_bit": own_bit, "mentions": mentions, "answers": answers,
            "rep_answers": answers, "rank_sum": 0, "ranked": 0, "rk_sum": 0, "rk_count": 0, "multi_answers": 0, "multi_mentions": 0,
            "s_pos": positive, "s_neu": neutral, "s_mix": mixed, "s_neg": negative,
            **{f"signals_{t}": 0 for t in metrics.TYPES}, **values}


class Conn:
    """asyncpg stand-in: answers by the table read (url = the URL counts per round, url_engines per round and engine),
    applies a brand_key text filter like the database would, and records every statement."""

    def __init__(self, *, kpi=(), brands=(), catalog=(), url=(), url_engines=()):
        self.kpi, self.brands, self.catalog, self.url, self.url_engines = list(kpi), list(brands), list(catalog), list(url), list(url_engines)
        self.sql = []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        if "FROM gold.catalog_entry" in sql:  # first: it counts its measured prompts on answer_fact
            return self.catalog
        if "FROM gold.answer_brand_fact f" in sql:
            if "WITH a AS" not in sql:  # own_brand_counts: 당사's type answers, per the counts' groups
                return self.kpi
            m = re.search(r"f\.brand_key::text=ANY\(\$(\d+)::text\[\]\)", sql)
            return [r for r in self.brands if not m or str(r["brand_key"]) in args[int(m.group(1)) - 1]]
        if "url_prompts" in sql or "url_own_prompts" in sql:
            return self.url_engines if "f.engine_key AS engine_key" in sql else self.url
        if "FROM gold.answer_fact" in sql or "FROM gold.citation_fact" in sql:
            return self.kpi
        if "FROM gold.dim_owned_base" in sql:
            return []
        if "gold.dim_engine" in sql:
            return [{"engine_key": 1, "code": "chatgpt"}]
        raise AssertionError(f"unexpected statement: {sql[:120]}")

    def reads(self, table: str) -> int:
        return sum(f"FROM gold.{table}" in s for s in self.sql if "f.answer_key AS a_" not in s)

    def url_reads(self) -> int:
        return sum("url_prompts" in s for s in self.sql)


def context(conn: Conn, qs: str) -> Context:
    ctx = Context(conn, QueryParams(qs))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.builds = {"cell": [11], "fact": [12]}
    ctx.dates = [D2, D1]
    ctx.selected_dates = [D2]
    return ctx


def ranged(ctx: Context) -> Context:
    """What Context.create selects for the from/to of the query (the stand-in context does not read them)."""
    lo, hi = date.fromisoformat(ctx.q["from"]), date.fromisoformat(ctx.q["to"])
    ctx.selected_dates = [d for d in ctx.dates if lo <= d <= hi]
    return ctx


class Builds(unittest.TestCase):
    """One release build = one cycle slice: a date-filtered read binds the builds of its dates only."""

    def ctx(self) -> Context:
        ctx = context(Conn(), "surface=global&card=true")
        ctx.builds = {"cell": [11, 21, 31], "fact": [12, 22]}
        ctx.build_dates = {11: D2, 21: D1, 12: D2, 22: D1}  # 31: no known cycle
        return ctx

    def bound_builds(self, ctx: Context, **kw) -> list:
        from bff.gold_reader.context import SQL
        b = SQL()
        ctx.predicate(b, **kw)
        return b.args[0]

    def test_a_snapshot_binds_the_builds_of_its_date(self):
        ctx = self.ctx()
        self.assertEqual(self.bound_builds(ctx), [11, 31])
        self.assertEqual(self.bound_builds(ctx, family="fact"), [12])
        ctx.selected_dates = [D2, D1]
        self.assertEqual(self.bound_builds(ctx), [11, 21, 31])
        ctx.selected_dates = []
        self.assertEqual(self.bound_builds(ctx), [31])

    def test_an_undated_read_binds_every_build(self):
        self.assertEqual(self.bound_builds(self.ctx(), family="fact", dates=False), [12, 22])


class BrandTrend(unittest.TestCase):
    def test_reads_the_answers_once_and_only_the_asked_brands(self):
        conn = Conn(kpi=[counts_row(round_date=D1, answers=10, total_mentions=20),
                         counts_row(round_date=D2, answers=20, total_mentions=40)],
                    brands=[brand_row(D1, 370, "Toyota", 0, 6, 4), brand_row(D2, 370, "Toyota", 0, 10, 8),
                            brand_row(D2, 1420, "Honda", 0, 4, 2), brand_row(D2, 9, "Kia", 2, 30, 15)])
        ctx = context(conn, "surface=global&card=true&bucket=cycle&dimension=brand&metrics=share_of_voice"
                            "&metrics=visibility&brand_key=370&brand_key=1420")
        out = asyncio.run(metrics.trend(ctx))["data"]
        self.assertEqual([(s["key"], s["metric"]) for s in out["series"]],
                         [("Toyota", "share_of_voice"), ("Toyota", "visibility"),
                          ("Honda", "share_of_voice"), ("Honda", "visibility")])
        toyota_sov, _, honda_sov, honda_vis = out["series"]
        self.assertEqual([p["ratio"] for p in toyota_sov["points"]], [{"num": 6, "den": 20}, {"num": 10, "den": 40}])
        self.assertEqual([(p["ratio"], p["gap"]) for p in honda_vis["points"]],
                         [({"num": 0, "den": 10}, True), ({"num": 2, "den": 20}, False)])
        self.assertEqual((honda_sov["brand_key"], honda_sov["is_own"]), (1420, False))
        # the date totals are one scan of the answers (no citation read, no repeat)
        self.assertEqual(conn.reads("answer_fact"), 1)
        self.assertEqual(conn.reads("answer_brand_fact"), 1)

    def test_without_brand_keys_every_brand_is_a_candidate(self):
        conn = Conn(kpi=[counts_row(round_date=D2, answers=20, total_mentions=40)],
                    brands=[brand_row(D2, 370, "Toyota", 0, 10, 8), brand_row(D2, 9, "Kia", 2, 30, 15)])
        ctx = context(conn, "surface=global&card=true&dimension=brand&metrics=share_of_voice&top_n=5")
        out = asyncio.run(metrics.trend(ctx))["data"]
        self.assertEqual([(s["key"], s["is_own"]) for s in out["series"]], [("HMG", True), ("Toyota", False)])
        self.assertNotIn("brand_key::text", next(s for s in conn.sql if "answer_brand_fact" in s))

    def test_the_own_series_is_the_perspective_not_one_own_brand(self):
        # 2026-10-29 metric review R1: 당사 = Hyundai + Kia + Genesis. The own line came from the first own
        # brand's cells (Kia: rank 3.4, 16.4 %) while the cards read the perspective (2.4, 38.7 %).
        conn = Conn(kpi=[counts_row(round_date=D1, answers=10, tracked=8, own_mentions=12, total_mentions=30,
                                    rank_sum=20, ranked=8, sent_pos=6, sent_all=10),
                         counts_row(round_date=D2, answers=20, tracked=15, own_mentions=25, total_mentions=60,
                                    rank_sum=33, ranked=15, sent_pos=9, sent_all=20)],
                    brands=[brand_row(D2, 9, "Kia", 2, 14, 10), brand_row(D2, 7, "Hyundai", 1, 9, 8),
                            brand_row(D2, 5, "Genesis", 4, 2, 2), brand_row(D2, 370, "Toyota", 0, 10, 8),
                            brand_row(D1, 9, "Kia", 2, 7, 5), brand_row(D1, 370, "Toyota", 0, 6, 4)])
        ctx = context(conn, "surface=global&card=true&dimension=brand&metrics=share_of_voice"
                            "&metrics=visibility&metrics=position&metrics=sentiment")
        out = asyncio.run(metrics.trend(ctx))["data"]
        own = [s for s in out["series"] if s["is_own"]]
        self.assertEqual([(s["key"], s["label"], s["metric"]) for s in own],
                         [("HMG", "HMG", "share_of_voice"), ("HMG", "HMG", "visibility"),
                          ("HMG", "HMG", "position"), ("HMG", "HMG", "sentiment")])
        by = {s["metric"]: [p.get("ratio", p.get("rank")) for p in s["points"]] for s in own}
        self.assertEqual(by["share_of_voice"], [{"num": 12, "den": 30}, {"num": 25, "den": 60}])
        self.assertEqual(by["visibility"], [{"num": 8, "den": 10}, {"num": 15, "den": 20}])
        self.assertEqual(by["position"], [{"sum": 20, "count": 8}, {"sum": 33, "count": 15}])
        self.assertEqual(by["sentiment"], [{"num": 6, "den": 10}, {"num": 9, "den": 20}])
        # own brands are never rivals, and the top counts rivals only
        self.assertEqual(sorted({s["key"] for s in out["series"] if not s["is_own"]}), ["Toyota"])
        self.assertEqual(conn.reads("answer_fact"), 1)

    def test_the_top_counts_rivals_after_the_own_series(self):
        brands = [brand_row(D2, 9, "Kia", 2, 50, 10), brand_row(D2, 7, "Hyundai", 1, 40, 8)]
        brands += [brand_row(D2, 100 + i, f"R{i}", 0, 30 - i, 5) for i in range(3)]
        conn = Conn(kpi=[counts_row(round_date=D2, answers=20, total_mentions=200, own_mentions=90)], brands=brands)
        ctx = context(conn, "surface=global&card=true&dimension=brand&metrics=share_of_voice&top_n=2")
        out = asyncio.run(metrics.trend(ctx))["data"]
        self.assertEqual([s["key"] for s in out["series"]], ["HMG", "R0", "R1"])

    def test_pin_top_rival_adds_the_latest_rounds_top_rival_marked(self):
        # 2026-10-30 legacy compare rule: the auto compare brand is the rival with the largest share on the snapshot
        # (the latest round). R-old leads the 14-round total, R-new leads the latest round but is outside top_n.
        brands = [brand_row(D1, 101, "R-old", 0, 50, 10), brand_row(D2, 101, "R-old", 0, 2, 2),
                  brand_row(D2, 102, "R-new", 0, 9, 6), brand_row(D1, 103, "R-mid", 0, 20, 5), brand_row(D2, 103, "R-mid", 0, 1, 1)]
        kpi = [counts_row(round_date=D1, answers=20, total_mentions=100), counts_row(round_date=D2, answers=20, total_mentions=40)]
        conn = Conn(kpi=kpi, brands=brands)
        out = asyncio.run(metrics.trend(context(conn, "surface=website&dimension=brand&metrics=share_of_voice&top_n=1&pin_top_rival=true")))["data"]
        self.assertEqual([(s["key"], s.get("pinned", False)) for s in out["series"]], [("R-old", False), ("R-new", True)])
        self.assertEqual([p["ratio"] for p in out["series"][1]["points"]], [{"num": 0, "den": 100}, {"num": 9, "den": 40}])
        # already in the top: no second series; without the flag: no pin
        conn = Conn(kpi=kpi, brands=brands)
        out = asyncio.run(metrics.trend(context(conn, "surface=website&dimension=brand&metrics=share_of_voice&top_n=3&pin_top_rival=true")))["data"]
        self.assertEqual([(s["key"], s.get("pinned", False)) for s in out["series"]], [("R-old", False), ("R-mid", False), ("R-new", False)])
        conn = Conn(kpi=kpi, brands=brands)
        out = asyncio.run(metrics.trend(context(conn, "surface=website&dimension=brand&metrics=share_of_voice&top_n=1")))["data"]
        self.assertEqual([s["key"] for s in out["series"]], ["R-old"])
        # a period: the body's rows are the period's, whose top rival leads the top already
        conn = Conn(kpi=kpi, brands=brands)
        ctx = ranged(context(conn, "surface=website&dimension=brand&metrics=share_of_voice&top_n=1&pin_top_rival=true"
                                   "&from=2026-09-28&to=2026-10-05"))
        out = asyncio.run(metrics.trend(ctx))["data"]
        self.assertEqual([s["key"] for s in out["series"]], ["R-old"])

    def test_one_own_brand_perspective_is_labelled_by_the_brand(self):
        conn = Conn(kpi=[counts_row(round_date=D2, answers=20, own_mentions=14, total_mentions=40)],
                    brands=[brand_row(D2, 9, "Kia", 2, 14, 10), brand_row(D2, 370, "Toyota", 0, 10, 8)])
        ctx = context(conn, "surface=global&card=true&brand=kia&dimension=brand&metrics=share_of_voice")
        out = asyncio.run(metrics.trend(ctx))["data"]
        self.assertEqual([(s["key"], s["is_own"], s["brand_key"]) for s in out["series"]],
                         [("Kia", True, 9), ("Toyota", False, 370)])


class TypeTrend(unittest.TestCase):
    """dims=type and dimension=type (contract P12 B101, M08 type_exposure): per bucket and type, the own answers with
    that type signal over the bucket's answers, i.e. mentions/types own_exposure round by round. The reader answered
    no dims (2026-10-29), so the renewal Mention's type trend and its favourability trend never showed."""

    def conn(self, *rows) -> Conn:
        return Conn(kpi=list(rows) or [counts_row(round_date=D1, engine_key=1, answers=3, answers_mon=10, t_mention=6, t_final_choice=1),
                                       counts_row(round_date=D2, engine_key=1, answers=5, answers_mon=20, t_mention=9, t_final_choice=4)])

    def test_dims_type_comes_with_the_engine_trend_from_its_reads(self):
        conn = self.conn()
        ctx = context(conn, "surface=global&bucket=cycle&dimension=engine&metrics=visibility&dims=type:type_exposure")
        out = asyncio.run(metrics.trend(ctx))["data"]
        self.assertEqual([s["key"] for s in out["series"]], ["chatgpt"])
        (block,) = out["dims"]
        self.assertEqual((block["dimension"], [s["key"] for s in block["series"]]), ("type", list(metrics.TYPES)))
        self.assertEqual({(s["metric"], s["kind"]) for s in block["series"]}, {("type_exposure", "ratio")})
        by = {s["key"]: [p["ratio"] for p in s["points"]] for s in block["series"]}
        self.assertEqual(by["mention"], [{"num": 6, "den": 10}, {"num": 9, "den": 20}])
        self.assertEqual(by["final_choice"], [{"num": 1, "den": 10}, {"num": 4, "den": 20}])
        self.assertEqual(by["definition"], [{"num": 0, "den": 10}, {"num": 0, "den": 20}])  # of the monitoring answers
        self.assertEqual(conn.reads("answer_fact"), 2)  # the engine trend's mention and citation counts, nothing more
        self.assertEqual(conn.reads("answer_brand_fact"), 1)  # the type answers

    def test_dimension_type(self):
        out = asyncio.run(metrics.trend(context(self.conn(), "surface=global&bucket=cycle&dimension=type")))["data"]
        self.assertEqual([(s["key"], s["label"], s["metric"]) for s in out["series"]], [(t, t, "type_exposure") for t in metrics.TYPES])

    def test_a_bucket_without_answers_is_a_gap(self):
        conn = self.conn(counts_row(round_date=D2, engine_key=1, answers=20, t_mention=9))
        out = asyncio.run(metrics.trend(ranged(context(conn, f"surface=global&dimension=engine&dims=type&from={D1}&to={D2}"))))["data"]
        mention = next(s for s in out["dims"][0]["series"] if s["key"] == "mention")
        self.assertEqual([(p["ratio"], p["gap"]) for p in mention["points"]], [(None, True), ({"num": 9, "den": 20}, False)])

    def test_dims_none_is_the_engines_summed(self):
        conn = self.conn(counts_row(round_date=D2, engine_key=1, answers=20, tracked=15),
                         counts_row(round_date=D2, engine_key=2, answers=10, tracked=4))
        out = asyncio.run(metrics.trend(ranged(context(conn, f"surface=global&dimension=engine&metrics=visibility&dims=none:visibility&from={D1}&to={D2}"))))["data"]
        (none,) = out["dims"][0]["series"]
        self.assertEqual([p["ratio"] for p in none["points"]], [None, {"num": 19, "den": 30}])
        self.assertEqual(conn.reads("answer_brand_fact"), 0)  # no type asked: no type read

    def test_an_unsupported_or_repeated_dims_dimension_is_refused(self):
        for qs in ("dimension=engine&dims=brand", "dimension=engine&dims=engine", "dimension=none&dims=type&dims=type"):
            with self.subTest(qs), self.assertRaises(metrics.HTTPException) as e:
                asyncio.run(metrics.trend(context(self.conn(), f"surface=global&{qs}")))
            self.assertEqual(e.exception.status_code, 422)


class UrlRateTrend(unittest.TestCase):
    """The website (and project) URL rates are the cards' (summary) measure: 자사 · 타겟 URL 인용률 per prompt, AI 타겟 출처 인용률
    per answer. The trend read them from the citation counts instead (cit_target / cit_owned), so on 2026-10-30 the website
    타겟 출처 인용률 card said 65.3 % (9,832 / 15,065 answers) while its trend point for the same round said 22.8 %, and the
    card's Δ came from that other measure. A trend point now reads the same measure as the card, per round and per engine;
    a distinct prompt count does not add up, so the round's value is its own read."""

    def conn(self) -> Conn:
        kpi = [counts_row(round_date=D1, engine_key=1, answers=10, cit_total=40, cit_target=2, cit_owned=20),
               counts_row(round_date=D2, engine_key=1, answers=10, cit_total=40, cit_target=3, cit_owned=20),
               counts_row(round_date=D2, engine_key=2, answers=10, cit_total=40, cit_target=1, cit_owned=10)]
        def row(day, prompts, own_prompts, target_prompts, own_answers, target_answers, **keys):
            return {"round_date": day, "url_prompts": prompts, "url_own_prompts": own_prompts, "url_target_prompts": target_prompts,
                    "url_own_answers": own_answers, "url_target_answers": target_answers, **keys}
        # 2 of D2's prompts are measured on both engines: 12 prompts, not 15
        url = [row(D1, 10, 8, 6, 8, 5), row(D2, 12, 10, 7, 12, 7)]
        url_engines = [row(D1, 10, 8, 6, 8, 5, engine_key=1), row(D2, 10, 9, 7, 9, 6, engine_key=1), row(D2, 5, 3, 1, 3, 1, engine_key=2)]
        return Conn(kpi=kpi, url=url, url_engines=url_engines)

    def series(self, qs: str, conn: Conn | None = None) -> tuple[dict, Conn]:
        conn = conn or self.conn()
        out = asyncio.run(metrics.trend(ranged(context(conn, f"{qs}&from={D1}&to={D2}"))))["data"]
        return out, conn

    def test_a_website_trend_point_is_the_cards_measure(self):
        out, conn = self.series("surface=website&metrics=citation_accuracy,target_url_rate,owned_url_rate")
        by = {s["metric"]: [p["ratio"] for p in s["points"]] for s in out["series"]}
        self.assertEqual(by["citation_accuracy"], [{"num": 5, "den": 8}, {"num": 7, "den": 12}])
        self.assertEqual(by["target_url_rate"], [{"num": 6, "den": 10}, {"num": 7, "den": 12}])
        self.assertEqual(by["owned_url_rate"], [{"num": 8, "den": 10}, {"num": 10, "den": 12}])
        self.assertEqual(conn.url_reads(), 1)

    def test_per_engine_and_summed(self):
        out, conn = self.series("surface=website&dimension=engine&metrics=citation_accuracy&dims=none:citation_accuracy")
        by = {s["key"]: [p["ratio"] for p in s["points"]] for s in out["series"]}
        self.assertEqual(by["chatgpt"], [{"num": 5, "den": 8}, {"num": 6, "den": 9}])
        (none,) = out["dims"][0]["series"]
        self.assertEqual([p["ratio"] for p in none["points"]], [{"num": 5, "den": 8}, {"num": 7, "den": 12}])
        self.assertEqual(conn.url_reads(), 2)

    def test_the_other_metrics_and_the_global_surface_do_not_read_the_url_counts(self):
        out, conn = self.series("surface=website&metrics=visibility,citation_share")
        self.assertEqual(conn.url_reads(), 0)
        _, conn = self.series("surface=global&metrics=citation_accuracy")
        self.assertEqual(conn.url_reads(), 0)

    def test_a_round_with_answers_but_no_url_counts_has_no_url_value(self):
        conn = self.conn()
        conn.url = [r for r in conn.url if r["round_date"] == D2]
        out, _ = self.series("surface=website&metrics=citation_accuracy", conn)
        self.assertEqual([(p["ratio"], p["gap"]) for p in out["series"][0]["points"]], [(None, False), ({"num": 7, "den": 12}, False)])


class TrendWindow(unittest.TestCase):
    """Without from/to a trend starts at the scope's first measured round (the contract's first_measured_date). The
    published calendar holds rounds the scope never measured (2026-06-08..06-29 on the global surface: servable, with
    ready facts, no standard-scope cells), and every trend drew four empty rounds first, its chip counting 18 rounds
    where 14 were measured. A gap after the first measured round stays."""

    D0, D3 = date(2026, 9, 21), date(2026, 10, 12)

    def conn(self) -> Conn:
        # D0 unmeasured, D1 measured, D2 a gap, D3 measured
        return Conn(kpi=[counts_row(round_date=D1, engine_key=1, answers=10, tracked=6),
                         counts_row(round_date=self.D3, engine_key=1, answers=20, tracked=9)])

    def ctx(self, qs: str) -> Context:
        ctx = context(self.conn(), qs)
        ctx.dates = [self.D3, D2, D1, self.D0]
        return ctx

    def test_the_leading_unmeasured_rounds_are_left_out(self):
        for dimension in ("none", "engine", "type"):
            out = asyncio.run(metrics.trend(self.ctx(f"surface=global&dimension={dimension}&metrics=visibility&dims=none:visibility"
                                                     if dimension != "none" else "surface=global&metrics=visibility")))["data"]
            self.assertEqual([b["key"] for b in out["buckets"]], [D1.isoformat(), D2.isoformat(), self.D3.isoformat()], dimension)
            for s in out["series"] + [s for d in out["dims"] or [] for s in d["series"]]:
                self.assertEqual([(p["bucket"], p["gap"]) for p in s["points"]],
                                 [(D1.isoformat(), False), (D2.isoformat(), True), (self.D3.isoformat(), False)], dimension)

    def test_an_explicit_range_keeps_its_rounds(self):
        out = asyncio.run(metrics.trend(ranged(self.ctx(f"surface=global&metrics=visibility&from={self.D0}&to={self.D3}"))))["data"]
        self.assertEqual(len(out["buckets"]), 4)


class Summary(unittest.TestCase):
    CATALOG = [{"catalog_row_id": i, "prompt_id": i, "text": "p", "kind": "std", "measured": True, "brand_bit": 1,
                "brand_presence": None, "list_type": None, "depth1": None, "depth2": None, "depth3": None,
                "depth4": None, "funnel": None, "lang": "EN", "regions": None} for i in (1, 2, 3)]

    def summary(self, qs: str) -> tuple[dict, Conn]:
        conn = Conn(kpi=[counts_row(answers=10, tracked=5)], catalog=self.CATALOG)
        return asyncio.run(metrics.summary(context(conn, qs)))["data"], conn

    def test_applied_prompts_only_when_asked(self):
        # the Overview cards ask for urls only: the catalog (12k rows on Gold) is not read (B089: null)
        data, conn = self.summary("surface=global&card=true&parts=urls")
        self.assertIsNone(data["params"]["applied_prompts"])
        self.assertEqual(conn.reads("catalog_entry"), 0)
        self.assertEqual(data["visibility"], {"num": 5, "den": 10})
        for qs in ("surface=global&card=true", "surface=global&parts=applied&parts=urls"):
            with self.subTest(qs=qs):
                data, conn = self.summary(qs)
                self.assertEqual(data["params"]["applied_prompts"], 3)
                self.assertEqual(conn.reads("catalog_entry"), 1)

    def test_the_url_rates_are_per_prompt_on_website_and_project(self):
        # the citation accuracy per answer; global has none (suppressed)
        url = [{"url_prompts": 20, "url_own_prompts": 10, "url_target_prompts": 5, "url_own_answers": 8, "url_target_answers": 6}]
        for qs in ("surface=website&parts=urls", "surface=project&project_id=p1&parts=urls"):
            with self.subTest(qs=qs):
                conn = Conn(kpi=[counts_row(answers=10, tracked=5, cit_total=40, cit_target=2, cit_owned=30)], url=url)
                data = asyncio.run(metrics.summary(context(conn, qs)))["data"]
                self.assertEqual(data["owned_url_rate"], {"num": 10, "den": 20})
                self.assertEqual(data["target_url_rate"], {"num": 5, "den": 20})
                self.assertEqual(data["citation_accuracy"], {"num": 6, "den": 8})
                self.assertEqual(data["url_prompts"], {"measured_prompts": 20, "target_prompts": 5, "owned_prompts": 10})
                self.assertEqual(data["citation_share"], {"num": 30, "den": 40})  # 자사 URL citations off global
        data, conn = self.summary("surface=global&parts=urls")
        self.assertIsNone(data["url_prompts"])
        self.assertIsNone(data["owned_url_rate"])
        self.assertEqual(conn.url_reads(), 0)


class BrandsSplitOwn(unittest.TestCase):
    """mentions/brands ?split_own (contract D13): with two or more perspective brands, 당사 becomes one row per brand,
    counted from its brand cell as a rival row is (Gold has one brand per own bit); the own block stays the
    perspective's. The reader ignored the parameter (2026-11-05), so no screen could show Hyundai · Kia · Genesis."""

    def conn(self) -> Conn:
        return Conn(kpi=[counts_row(answers=20, tracked=16, own_mentions=50, total_mentions=100, rank_sum=24, ranked=16)],
                    brands=[brand_row(D2, 2, "Kia", 2, 25, 12, rank_sum=30, ranked=12, positive=6, negative=2),
                            brand_row(D2, 1, "Hyundai", 1, 20, 10, rank_sum=25, ranked=10, positive=5),
                            brand_row(D2, 370, "Toyota", 0, 10, 8),
                            brand_row(D2, 3, "Genesis", 4, 5, 3)])

    def brands(self, qs: str) -> dict:
        return asyncio.run(metrics.brands(context(self.conn(), qs)))["data"]

    def test_split_own_gives_each_perspective_brand_its_row(self):
        data = self.brands("surface=global&card=true&top_n=10&split_own=true&include=hmg")
        rows = [(r["name"], r.get("own_brand_code"), r["is_own"], r["rank"], r["mentions"]) for r in data["brands"]]
        self.assertEqual(rows, [("Kia", "Kia", True, 1, 25), ("Hyundai", "Hyundai", True, 2, 20),
                                ("Toyota", None, False, 3, 10), ("Genesis", "Genesis", True, 4, 5)])
        kia = data["brands"][0]
        self.assertEqual((kia["brand_key"], kia["exposure"], kia["share"], kia["avg_rank"]),
                         (2, {"num": 12, "den": 20}, {"num": 25, "den": 100}, {"sum": 30, "count": 12}))
        self.assertEqual(kia["sentiment"], {"positive": 6, "neutral": 0, "mixed": 0, "negative": 2})
        self.assertTrue(kia["is_hmg_own"])
        # the own block is still the perspective's (the cards' 당사)
        own = data["own"]
        self.assertEqual((own["vp_label"], own["rank"], own["mentions"], own["exposure"]), ("HMG", 1, 50, {"num": 16, "den": 20}))

    def test_without_split_own_or_with_one_brand_the_own_row_is_merged(self):
        for qs, label in (("surface=global&card=true&top_n=10", "HMG"),
                          ("surface=global&card=true&top_n=10&split_own=true&brand=kia", "Kia")):
            with self.subTest(qs=qs):
                rows = self.brands(qs)["brands"]
                own = [r for r in rows if r["is_own"]]
                self.assertEqual(len(own), 1)
                self.assertEqual(own[0]["name"], label)
                self.assertNotIn("own_brand_code", own[0])


class GeoBrandedAnswers(unittest.TestCase):
    """advanced.branded_answers (?branded_share, 2026-11-05 D-12): the answers of branded prompts per country, the
    prompts the brand_presence=branded pick selects (a catalog row of the perspective's brands or the shared rows),
    the representative answers of the read's own filters."""

    class Conn:
        def __init__(self):
            self.sql = []

        async def fetch(self, sql, *args):
            self.sql.append((sql, args))
            if "FROM gold.catalog_entry" in sql:
                return [{"prompt_key": 7}, {"prompt_key": 9}]
            if "FROM gold.answer_fact" in sql or "f.answer_key AS a_" in sql:
                return [{"geo_key": 1, "answers": 298}, {"geo_key": 2, "answers": 742}]
            raise AssertionError(sql[:80])

    def test_branded_prompts_of_the_perspective_then_their_answers_per_country(self):
        from bff.gold_reader import advanced
        conn = self.Conn()
        ctx = context(conn, "surface=global&card=true")
        self.assertEqual(asyncio.run(advanced.branded_answers(ctx)), {1: 298, 2: 742})
        (catalog, cargs), (facts, kargs) = conn.sql
        self.assertIn("lower(code)='branded'", catalog)
        self.assertIn("ce.brand_bit &", catalog)
        self.assertIn(15, cargs)  # the perspective's bits (HMG 7) | the shared rows (8)
        self.assertIn("f.prompt_key=ANY(", facts)
        self.assertIn([7, 9], kargs)
        self.assertIn("AND f.is_rep", facts)


def geo_row(country, lang, **flags) -> dict:
    return {"bgrp": 1, "country": country, "kind": "market", "area": "EU", "lang": lang, "engine": "chatgpt",
            "is_default": True, "kept": True, "orphan": False, **flags}


class OptionsConn:
    """Stand-in for the filter options' statements."""

    def __init__(self, *, geo=None, taxa=None, combos=None):
        self.geo = [geo_row("DE", "DE"), geo_row("FR", "FR")] if geo is None else geo
        self.taxa = [{"axis": "funnel", "code": "aware", "parent_code": None, "orphan": False}] if taxa is None else taxa
        self.combos = [{"brand_bit": 1, **dict.fromkeys(AXES), "funnel": "aware", "orphan": False}] if combos is None else combos
        self.sql = []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        if "FROM gold.answer_fact" in sql or "f.answer_key AS a_" in sql:
            return self.geo
        if "FROM gold.dim_taxon t" in sql:
            return self.taxa
        if "FROM gold.catalog_entry" in sql:
            return self.combos
        raise AssertionError(f"unexpected statement: {sql[:120]}")

    def reads(self, table: str) -> int:
        return sum(f"FROM gold.{table}" in s for s in self.sql if "f.answer_key AS a_" not in s)


class Options(unittest.TestCase):
    """The filter options and whether their read was consistent (metrics.options_data)."""

    def read(self, conn, qs="surface=global") -> dict:
        return asyncio.run(metrics.options(context(conn, qs)))

    def test_the_options_of_the_read(self):
        conn = OptionsConn()
        out = self.read(conn)
        self.assertEqual([r["code"] for r in out["data"]["regions"]], ["DE", "FR"])
        self.assertEqual(out["data"]["languages"], ["de", "fr"])
        self.assertEqual(out["data"]["catalog"]["funnel"], [{"code": "aware", "parent_code": None}])
        self.assertEqual((conn.reads("answer_fact"), conn.reads("catalog_entry")), (1, 1))
        self.assertEqual(out["meta"]["cycles"], ["2026-10-05"])

    def test_geo_only_reads_no_catalog(self):
        conn = OptionsConn()
        self.assertIsNone(self.read(conn, "surface=global&geo_only=true")["data"]["catalog"])
        self.assertEqual((conn.reads("answer_fact"), conn.reads("catalog_entry")), (1, 0))

    def test_an_inconsistent_read_is_answered_and_told_apart(self):
        def consistent(conn) -> bool:
            return asyncio.run(metrics.options_data(context(conn, "surface=global")))[1]

        self.assertTrue(consistent(OptionsConn()))
        cases = {"fact key without its country": dict(geo=[geo_row("DE", "DE"), geo_row(None, None, kept=False, orphan=True)]),
                 "nothing to answer from": dict(geo=[]),
                 "taxon without its parent": dict(taxa=[{"axis": "funnel", "code": "aware", "parent_code": None, "orphan": True}]),
                 "no taxonomy": dict(taxa=[]),
                 "catalog key without its taxon": dict(combos=[{"brand_bit": 1, **dict.fromkeys(AXES), "orphan": True}]),
                 "no catalog": dict(combos=[])}
        for name, rows in cases.items():
            with self.subTest(name):
                self.assertFalse(consistent(OptionsConn(**rows)))
        # an orphan read answers the inner join's rows, as before
        out = self.read(OptionsConn(**cases["fact key without its country"]))
        self.assertEqual([r["code"] for r in out["data"]["regions"]], ["DE"])


if __name__ == "__main__":
    unittest.main()
