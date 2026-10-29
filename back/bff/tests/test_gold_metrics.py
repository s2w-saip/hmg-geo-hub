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

D1, D2 = date(2026, 9, 28), date(2026, 10, 5)


def counts_row(**values) -> dict:
    row = dict.fromkeys(metrics.COUNTS, 0)
    row.update(measured_prompts=0, mentioned_prompts=0)
    row.update(values)
    return row


def brand_row(day, key, name, own_bit, mentions, answers) -> dict:
    row = {"round_date": day, "brand_key": key, "name": name, "own_bit": own_bit, "mentions": mentions,
           "answers": answers, "rank_sum": 0, "ranked": 0, "positive": 0, "neutral": 0, "mixed": 0, "negative": 0}
    return row


class Conn:
    """asyncpg stand-in: answers by the table read, applies a brand_key text filter like the database
    would, and records every statement."""

    def __init__(self, *, kpi=(), brands=(), catalog=()):
        self.kpi, self.brands, self.catalog, self.sql = list(kpi), list(brands), list(catalog), []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        if "FROM gold.brand_cell" in sql:
            m = re.search(r"f\.brand_key::text=ANY\(\$(\d+)::text\[\]\)", sql)
            return [r for r in self.brands if not m or str(r["brand_key"]) in args[int(m.group(1)) - 1]]
        if "FROM gold.kpi_cell" in sql:
            return self.kpi
        if "FROM gold.catalog_entry" in sql:
            return self.catalog
        if "gold.dim_engine" in sql:
            return [{"engine_key": 1, "code": "chatgpt"}]
        raise AssertionError(f"unexpected statement: {sql[:120]}")

    def reads(self, table: str) -> int:
        return sum(f"FROM gold.{table}" in s for s in self.sql)


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
    def test_reads_the_mention_cells_once_and_only_the_asked_brands(self):
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
        # the date totals are one scan of the mention cells (no citation cells, no repeat)
        self.assertEqual(conn.reads("kpi_cell"), 1)
        self.assertEqual(conn.reads("brand_cell"), 1)

    def test_without_brand_keys_every_brand_is_a_candidate(self):
        conn = Conn(kpi=[counts_row(round_date=D2, answers=20, total_mentions=40)],
                    brands=[brand_row(D2, 370, "Toyota", 0, 10, 8), brand_row(D2, 9, "Kia", 2, 30, 15)])
        ctx = context(conn, "surface=global&card=true&dimension=brand&metrics=share_of_voice&top_n=5")
        out = asyncio.run(metrics.trend(ctx))["data"]
        self.assertEqual([(s["key"], s["is_own"]) for s in out["series"]], [("HMG", True), ("Toyota", False)])
        self.assertNotIn("brand_key::text", next(s for s in conn.sql if "brand_cell" in s))

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
        self.assertEqual(conn.reads("kpi_cell"), 1)

    def test_the_top_counts_rivals_after_the_own_series(self):
        brands = [brand_row(D2, 9, "Kia", 2, 50, 10), brand_row(D2, 7, "Hyundai", 1, 40, 8)]
        brands += [brand_row(D2, 100 + i, f"R{i}", 0, 30 - i, 5) for i in range(3)]
        conn = Conn(kpi=[counts_row(round_date=D2, answers=20, total_mentions=200, own_mentions=90)], brands=brands)
        ctx = context(conn, "surface=global&card=true&dimension=brand&metrics=share_of_voice&top_n=2")
        out = asyncio.run(metrics.trend(ctx))["data"]
        self.assertEqual([s["key"] for s in out["series"]], ["HMG", "R0", "R1"])

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
        return Conn(kpi=list(rows) or [counts_row(round_date=D1, engine_key=1, answers=10, t_mention=6, t_final_choice=1),
                                       counts_row(round_date=D2, engine_key=1, answers=20, t_mention=9, t_final_choice=4)])

    def test_dims_type_comes_with_the_engine_trend_from_its_cells(self):
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
        self.assertEqual(by["definition"], [{"num": 0, "den": 10}, {"num": 0, "den": 20}])
        self.assertEqual(conn.reads("kpi_cell"), 2)  # the engine trend's mention and citation cells, nothing more

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

    def test_an_unsupported_or_repeated_dims_dimension_is_refused(self):
        for qs in ("dimension=engine&dims=brand", "dimension=engine&dims=engine", "dimension=none&dims=type&dims=type"):
            with self.subTest(qs), self.assertRaises(metrics.HTTPException) as e:
                asyncio.run(metrics.trend(context(self.conn(), f"surface=global&{qs}")))
            self.assertEqual(e.exception.status_code, 422)


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


def geo_row(country, lang, **flags) -> dict:
    return {"bgrp": 1, "country": country, "kind": "market", "area": "EU", "lang": lang, "engine": "chatgpt",
            "is_default": True, "kept": True, "orphan": False, **flags}


class OptionsConn:
    """Stand-in for the filter options' statements; `moves` bumps data_version after that many reads of it."""

    def __init__(self, *, geo=None, taxa=None, combos=None, moves=None):
        self.versions = [{"scope": "dim", "version": 7}, {"scope": "prompt", "version": 3}]
        self.geo = [geo_row("DE", "DE"), geo_row("FR", "FR")] if geo is None else geo
        self.taxa = [{"axis": "funnel", "code": "aware", "parent_code": None, "orphan": False}] if taxa is None else taxa
        self.combos = [{"brand_bit": 1, **dict.fromkeys(AXES), "funnel": "aware", "orphan": False}] if combos is None else combos
        self.moves, self.version_reads, self.sql = moves, 0, []

    async def fetch(self, sql, *args):
        self.sql.append(sql)
        if "FROM gold.data_version" in sql:
            self.version_reads += 1
            if self.moves is not None and self.version_reads > self.moves:
                return [{**v, "version": v["version"] + 1} for v in self.versions]
            return self.versions
        if "FROM gold.answer_fact" in sql:
            return self.geo
        if "FROM gold.dim_taxon t" in sql:
            return self.taxa
        if "FROM gold.catalog_entry" in sql:
            return self.combos
        raise AssertionError(f"unexpected statement: {sql[:120]}")

    def reads(self, table: str) -> int:
        return sum(f"FROM gold.{table}" in s for s in self.sql)


class Options(unittest.TestCase):
    """The filter options are kept per release builds, Gold data_version and query less the period."""

    def setUp(self):
        metrics._options_cache.clear()

    def read(self, conn, qs="surface=global", builds=None) -> dict:
        ctx = context(conn, qs)
        if builds is not None:
            ctx.builds = builds
        return asyncio.run(metrics.options(ctx))

    def test_another_period_is_answered_from_the_kept_options(self):
        first, second = OptionsConn(), OptionsConn()
        out = self.read(first, "surface=global&from=2026-09-01&to=2026-09-14")
        again = self.read(second, "surface=global&to=2026-10-05&from=2026-09-28")
        self.assertEqual(again["data"], out["data"])
        self.assertEqual([r["code"] for r in out["data"]["regions"]], ["DE", "FR"])
        self.assertEqual((first.reads("answer_fact"), second.reads("answer_fact"), second.reads("catalog_entry")), (1, 0, 0))
        # the period's own part, meta, is the request's
        self.assertEqual(again["meta"]["cycles"], ["2026-10-05"])

    def test_builds_versions_and_the_query_are_the_key(self):
        self.read(OptionsConn())
        changed = {"builds": (OptionsConn(), "surface=global", {"cell": [11], "fact": [13]}),
                   "data_version": (OptionsConn(moves=0), "surface=global", None),
                   "geo_only": (OptionsConn(), "surface=global&geo_only=true", None),
                   "brand": (OptionsConn(), "surface=global&brand=kia", None)}
        for name, (conn, qs, builds) in changed.items():
            with self.subTest(name):
                self.read(conn, qs, builds)
                self.assertEqual(conn.reads("answer_fact"), 1)

    def test_an_inconsistent_read_is_answered_but_not_kept(self):
        cases = {"fact key without its country": dict(geo=[geo_row("DE", "DE"), geo_row(None, None, kept=False, orphan=True)]),
                 "nothing to answer from": dict(geo=[]),
                 "taxon without its parent": dict(taxa=[{"axis": "funnel", "code": "aware", "parent_code": None, "orphan": True}]),
                 "no taxonomy": dict(taxa=[]),
                 "catalog key without its taxon": dict(combos=[{"brand_bit": 1, **dict.fromkeys(AXES), "orphan": True}]),
                 "no catalog": dict(combos=[])}
        for name, rows in cases.items():
            with self.subTest(name):
                metrics._options_cache.clear()
                self.read(OptionsConn(**rows))
                conn = OptionsConn(**rows)
                self.read(conn)
                self.assertEqual(conn.reads("answer_fact"), 1)
        # an orphan read answers the inner join's rows, as before
        out = self.read(OptionsConn(**cases["fact key without its country"]))
        self.assertEqual([r["code"] for r in out["data"]["regions"]], ["DE"])

    def test_data_version_moving_during_the_read_is_not_kept(self):
        self.read(OptionsConn(moves=1))
        conn = OptionsConn()
        self.read(conn)
        self.assertEqual(conn.reads("answer_fact"), 1)

    def test_kept_options_expire(self):
        from unittest import mock
        self.read(OptionsConn())
        conn = OptionsConn()
        with mock.patch.object(metrics.time, "monotonic", return_value=metrics.time.monotonic() + metrics.OPTIONS_MAX_AGE_S):
            self.read(conn)
        self.assertEqual(conn.reads("answer_fact"), 1)

    def test_an_answer_does_not_share_the_kept_data(self):
        self.read(OptionsConn())["data"]["regions"].clear()
        self.assertEqual(len(self.read(OptionsConn())["data"]["regions"]), 2)


if __name__ == "__main__":
    unittest.main()
