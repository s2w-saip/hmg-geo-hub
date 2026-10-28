"""Gold metric readers (bff.gold_reader.metrics) over a recording stand-in connection: which statements a
read issues (the Overview's load) and what it answers from their rows."""
import asyncio
import re
import unittest
from datetime import date

try:
    from starlette.datastructures import QueryParams

    from bff.gold_reader import metrics
    from bff.gold_reader.context import Context
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
        self.assertEqual([(s["key"], s["is_own"]) for s in out["series"]], [("Kia", True), ("Toyota", False)])
        self.assertNotIn("brand_key::text", next(s for s in conn.sql if "brand_cell" in s))


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


if __name__ == "__main__":
    unittest.main()
