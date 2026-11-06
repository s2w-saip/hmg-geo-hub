"""Gold reads capped at the service week (2026-11-02, decisions '발행 시점 판정' · '기준 주 세부'): every global and website
read stops at the week's last day — its calendar, its release builds, an explicit end, the comparison ledger, the
website prompts' country moves, the ACR rounds, an answer's detail and the live snapshot's id — and a surface with no
round in the week has no snapshot ('측정 없음'). The project surface and the reads of no round are not capped."""
import asyncio
import re
import time
import unittest
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from data_server import api
    from data_server.gold_reader import acr, answers, catalog, compare, readers, week_notes
    from data_server.gold_reader.context import SQL, Context
    from data_server.hub_stores import service_week
    from data_server.metrics import serving
    from data_server.tests.service_week_util import HubData, clock, hub, week_row
    from data_server.tests.test_gold_metrics import counts_row as answers_row
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_gold_service_week)") from exc


def setUpModule():
    from data_server.tests.stand_ins import no_judged_answers
    no_judged_answers()

D = date.fromisoformat
OCT5, OCT11 = D("2026-10-05"), D("2026-10-11")
ROUNDS = [D("2026-10-12"), OCT5, D("2026-09-28")]          # newest first: one round after the service week 10-05..10-11
NOV2 = D("2026-11-02")   # the KST day of clock() (2026-11-01T23:30Z, a host in UTC): a naive or UTC day is 11-01


def run(coro):
    return asyncio.run(coro)


def week(start: date, seq: int = 1):
    """The provider's week for a Context built directly (Context.create sets it)."""
    return SimpleNamespace(seq=seq, start=start, end=start + timedelta(days=6))


# The calendar's bound on the service week's last day, as Context.create writes it (review r1-3, 2026-11-03: the fake
# applied the cap to any statement holding '$5', so a '>=' or an 'OR true' there passed)
DATES_BOUND = re.compile(r"AND \(\$5::date IS NULL OR c\.round_date <= \$5::date\)\s*ORDER BY")


class GoldConn:
    """Context.create's reads on a release of one fact build per round of `rounds` (newest first), a website report
    build of no cycle and a fact build per id of `unseen` whose cycle slice has no dim_cycle row in the read (Gold
    mid-reload); `extra` answers any other statement by a marker in its SQL. The calendar stops at the week only under
    DATES_BOUND (a broken bound reads every round), and a release row has a slice key only when the read selects it.
    Every statement is kept in `seen`."""

    def __init__(self, rounds, extra=None, unseen=()):
        self.rounds, self.extra, self.unseen, self.seen = rounds, extra or {}, unseen, []

    async def fetchval(self, sql, *args):
        self.seen.append((sql, args))
        return False   # no gold.silver_load: the release's builds are the snapshot

    async def fetch(self, sql, *args):
        self.seen.append((sql, args))
        if "SELECT * FROM gold.active_release" in sql:
            return [{"release_id": 1, "version": 3, "rule_signature": "test"}]
        if "FROM gold.release_item i" in sql:
            items = [*({"family": "fact", "build_id": 100 + i, "slice_key": f"cyc:{100 + i}", "round_date": d}
                       for i, d in enumerate(self.rounds)),
                     *({"family": "fact", "build_id": b, "slice_key": f"cyc:{b}", "round_date": None} for b in self.unseen),
                     {"family": "report", "build_id": 900, "slice_key": "rpub:all", "round_date": None}]
            keyed = "i.slice_key" in sql.split("FROM gold.release_item i")[0]
            return [{k: v for k, v in item.items() if keyed or k != "slice_key"} for item in items]
        if "SELECT DISTINCT f.answer_key" in sql:   # no ACR cell with several runs
            return []
        if "SELECT DISTINCT c.round_date" in sql:
            cap = args[4] if DATES_BOUND.search(sql) else None   # the service week's last day
            return [{"round_date": d} for d in self.rounds if cap is None or d <= cap]
        for marker, rows in self.extra.items():
            if marker in sql:
                return rows(args) if callable(rows) else rows
        raise AssertionError(sql[:100])

    async def fetchrow(self, sql, *args):
        if "FROM gold.dim_project" in sql:
            return {"project_key": 5}
        rows = await self.fetch(sql, *args)
        return rows[0] if rows else None


SERVICE_WEEK = object()


def create(qs: str, conn=None, data=SERVICE_WEEK):
    """Context.create on `conn` (default: the ROUNDS release) with the HUB data DB holding `data` (default: the week
    10-05..10-11; None = no data DB)."""
    with hub(HubData(week_row(OCT5)) if data is SERVICE_WEEK else data):
        return run(Context.create(conn or GoldConn(ROUNDS), QueryParams(qs)))


class Calendar(unittest.TestCase):
    def test_no_round_after_the_week(self):
        conn = GoldConn(ROUNDS)
        ctx = create("surface=global", conn)
        self.assertEqual(ctx.dates, [OCT5, D("2026-09-28")])
        self.assertEqual(ctx.selected_dates, [OCT5])
        self.assertEqual(ctx.meta()["as_of"], "2026-10-05")
        sql, args = next((s, a) for s, a in conn.seen if "SELECT DISTINCT c.round_date" in s)
        self.assertRegex(sql, DATES_BOUND)
        self.assertEqual(args[4], OCT11)   # the week's last day, not its first

    def test_no_build_of_a_later_round(self):
        ctx = create("surface=website")
        self.assertEqual(ctx.builds["fact"], [101, 102])
        self.assertNotIn(100, ctx.build_dates)
        self.assertEqual(ctx.builds["report"], [900])   # no cycle: kept (rule C4 binds its readers to ctx.dates)
        self.assertEqual(ctx.builds_for("fact", False), [101, 102])

    def test_no_build_of_a_cycle_the_read_does_not_see(self):
        # review r1-2 (2026-11-03): mid-reload, Gold's release can list a cycle slice before its dim_cycle row. Its
        # round is not known, so a capped read leaves the build out as its calendar does (filter options and the
        # catalog read builds with no date); the slices of no cycle stay, and a read with no week is as it was
        ctx = create("surface=website", GoldConn(ROUNDS, unseen=(300,)))
        self.assertEqual(ctx.builds["fact"], [101, 102])
        self.assertEqual(ctx.builds["report"], [900])
        uncapped = create("surface=website", GoldConn(ROUNDS, unseen=(300,)), data=None)
        self.assertEqual(uncapped.builds["fact"], [100, 101, 102, 300])

    def test_an_end_after_the_week_stops_at_it(self):
        ctx = create("surface=global&from=2026-09-01&to=2026-10-31")
        self.assertEqual(ctx.selected_dates, [OCT5, D("2026-09-28")])
        self.assertEqual(ctx.meta()["mode"], "cumulative")
        self.assertEqual(ctx.capped(D("2026-10-31")), OCT11)
        self.assertEqual(ctx.capped(D("2026-10-01")), D("2026-10-01"))

    def test_a_period_after_the_week_selects_nothing(self):
        ctx = create("surface=global&from=2026-10-12&to=2026-10-18")
        self.assertEqual(ctx.selected_dates, [])
        self.assertIsNone(ctx.meta()["as_of"])
        with self.assertRaises(HTTPException) as cm:   # a reversed period is still refused
            create("surface=global&from=2026-10-18&to=2026-10-12")
        self.assertEqual(cm.exception.status_code, 422)

    def test_a_surface_with_no_round_in_the_week_has_no_snapshot(self):
        # critic 2026-11-02: the 07-27 week had a global round and none on the website; the website snapshot fell back
        # to 07-24 under the '7월 5주차' chip. Decision '기준 주 세부': that surface's '측정 없음' is shown as is.
        conn = GoldConn([D("2026-08-07"), D("2026-07-24"), D("2026-07-17")])
        data = HubData(week_row(D("2026-07-27")))
        self.assertEqual(create("surface=website", conn, data).selected_dates, [])
        self.assertEqual(create("surface=website&cycle_offset=1", conn, data).selected_dates, [D("2026-07-17")])
        self.assertEqual(create("surface=website&from=2026-07-01&to=2026-07-31", conn, data).selected_dates,
                         [D("2026-07-24"), D("2026-07-17")])
        self.assertEqual(create("surface=website", conn, data).dates, [D("2026-07-24"), D("2026-07-17")])

    def test_the_predicate_stops_at_the_week(self):
        ctx = create("surface=global")
        b = SQL()
        where = ctx.predicate(b, "f")
        # the last condition of the cycle's EXISTS, on the week's last day (review r1-4: an 'OR true' passed)
        bound = re.search(r" AND cy\.round_date<=\$(\d+)::date\)", where)
        self.assertIsNotNone(bound, where)
        self.assertEqual(b.args[int(bound.group(1)) - 1], OCT11)

    def test_the_project_surface_is_not_capped(self):
        with hub(HubData(week_row(OCT5))) as data:
            ctx = run(Context.create(GoldConn(ROUNDS), QueryParams("surface=project&project_id=p1")))
        self.assertEqual(ctx.dates, ROUNDS)
        self.assertIsNone(ctx.week)
        self.assertEqual(data.connects, 0)

    def test_no_data_db_no_cap(self):
        ctx = create("surface=global", data=None)
        self.assertEqual(ctx.dates, ROUNDS)
        self.assertIsNone(ctx.week)

    def test_no_week_no_read(self):
        with self.assertRaises(HTTPException) as cm:
            create("surface=global", data=HubData(row=None))
        self.assertEqual(cm.exception.status_code, 503)

    def test_reads_of_no_round_do_not_wait_on_the_week(self):
        # keyword and social research and the project list are no Gold round: a data DB that is down leaves them be
        seen = []

        async def keywords(ctx):
            seen.append(ctx.week)
            return {"data": {}, "meta": {}}

        @asynccontextmanager
        async def gold():
            yield GoldConn(ROUNDS)

        with hub(HubData(refuse=ConnectionRefusedError(61, "Connect call failed"))) as data, \
                mock.patch.object(readers, "connection", gold), mock.patch.object(readers.insights, "keywords", keywords):
            run(readers.read("gold/keywords", QueryParams("")))
        self.assertEqual(seen, [None])
        self.assertEqual(data.connects, 0)

    def test_reads_of_no_round_do_not_wait_on_the_week_through_the_snapshot(self):
        # review r2-5 (2026-11-03): the screens read through api.get, which keys every metric read on the live snapshot
        # (data_server.metrics.serving), the service week in it. Before any week was read, a data DB that hangs held each read
        # there for READ_TIMEOUT_S, the project list and the project pages among them. A read of a global or website round
        # still waits for its week (bounded) and answers 503 without one
        @asynccontextmanager
        async def gold():
            yield GoldConn(ROUNDS, {"WITH jobs AS": [], "FROM gold.active_release": [{"release_id": 1, "version": 3}]})

        async def timed(path, params):
            started = time.monotonic()
            try:
                await api.get(path, params)
            except HTTPException as exc:
                return time.monotonic() - started, exc.status_code
            return time.monotonic() - started, 200

        self.addCleanup(serving.forget_snapshots)
        for path, params, waits in (("gold/projects", {}, False),
                                    ("source", {"surface": "project", "project_id": "p1"}, False),
                                    ("source", {"surface": "global"}, True),
                                    ("kpi/summary", {"surface": "global"}, True)):   # its snapshot waits as its read would
            with self.subTest(path=path, params=params):
                serving.forget_snapshots()
                with hub(HubData(hang=True)), mock.patch.object(service_week, "READ_TIMEOUT_S", 0.5), \
                        mock.patch.object(serving, "connection", gold), mock.patch.object(readers, "connection", gold):
                    took, status = run(timed(path, params))
                if waits:
                    self.assertEqual(status, 503)
                    self.assertGreater(took, 0.4)
                else:
                    self.assertEqual(status, 200)
                    self.assertLess(took, 0.25)

    def test_reads_of_no_round_name_no_round(self):
        # review r2-4 (2026-11-03): left uncapped, the project list and keyword and social research still read the
        # global or website round calendar, and their meta named a round after the service week (10-12 under 10-05..10-11)
        def project_list(qs):
            conn = GoldConn(ROUNDS, {"WITH jobs AS": []})

            @asynccontextmanager
            async def gold():
                yield conn

            with hub(HubData(week_row(OCT5))), mock.patch.object(readers, "connection", gold):
                return run(readers.read("gold/projects", QueryParams(qs)))["meta"], conn.seen

        for qs in ("", "surface=website"):
            with self.subTest(qs=qs):
                meta, seen = project_list(qs)
                self.assertEqual((meta["as_of"], meta["cycles"]), (None, []))
                self.assertFalse(any("SELECT DISTINCT c.round_date" in sql for sql, _ in seen))


def counts_row(day, **values):
    return answers_row(round_date=day, **values)


class LedgerConn:
    """The comparison's cycle ledger (one published cycle per round of `rounds`, `units` planned each, honouring a
    bound on round_date the read binds) and one row of counts per selected round."""

    def __init__(self, rounds, units=100):
        self.rounds, self.units, self.ledger = rounds, units, []

    async def fetch(self, sql, *args):
        if "FROM gold.answer_fact" in sql or "FROM gold.citation_fact" in sql or "f.answer_key AS a_" in sql:
            selected = next((a for a in args if isinstance(a, list) and a and all(isinstance(x, date) for x in a)), [])
            return [counts_row(d, answers=100, tracked=40, cit_total=10, gap_base=100) for d in self.rounds if d in selected]
        if "FROM gold.dim_cycle" in sql:
            self.ledger.append((sql, args))
            bound = re.search(r"round_date<=\$(\d+)", sql)
            cap = args[int(bound.group(1)) - 1] if bound else None
            return [{"round_date": d, "hidden_scope": 0, "servable": True, "in_release": True, "expected_units": self.units, "status": 2}
                    for d in self.rounds if cap is None or d <= cap]
        raise AssertionError(sql[:100])


def compare_read(qs: str, rounds, dates, start: date = OCT5):
    """kpi/compare (visibility) on a Context capped at `start`'s week, the calendar `dates`."""
    ctx = Context(LedgerConn(rounds), QueryParams(f"surface=global&metrics=visibility&{qs}"))
    ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
    ctx.builds = {"fact": [1]}
    ctx.week = week(start)
    ctx.dates = dates
    ctx.selected_dates = dates[:1]
    out = run(compare.read(ctx))
    return out["data"][0], out["meta"]["compare"]


class Compare(unittest.TestCase):
    def test_the_ledger_and_the_window_stop_at_the_week(self):
        # the window 10-05..10-18 is 10-05..10-11 under the week: a cycle of 10-12 counts in no window
        item, meta = compare_read("kind=window&from=2026-10-05&to=2026-10-18", ROUNDS, [OCT5, D("2026-09-28")])
        self.assertEqual(meta["windows"]["cur"], {"lo": OCT5, "hi": OCT11})
        self.assertEqual(meta["windows"]["prev"], {"lo": D("2026-09-28"), "hi": D("2026-10-04")})
        self.assertEqual((item["cycles_cur"], item["planned_cur"]), (1, 100))
        self.assertEqual((item["cycles_prev"], item["planned_prev"]), (1, 100))

    def test_a_period_after_the_week_compares_nothing(self):
        item, meta = compare_read("kind=window&from=2026-10-12&to=2026-10-18", ROUNDS, [OCT5, D("2026-09-28")])
        self.assertEqual((item["suppressed"], item["reason"], item["delta"]), (True, "no_data", None))
        self.assertIsNone(meta["windows"])

    def test_no_round_in_the_week_no_round_comparison(self):
        item, _ = compare_read("kind=cycle", [D("2026-07-24"), D("2026-07-17")], [D("2026-07-24"), D("2026-07-17")],
                               start=D("2026-07-27"))
        self.assertEqual((item["suppressed"], item["reason"]), (True, "no_data"))


class Others(unittest.TestCase):
    def test_a_prompts_country_move_stops_at_the_week(self):
        moved = []

        def record(args):
            moved.append(args)
            return []

        conn = GoldConn(ROUNDS, {"DISTINCT ON(j.prompt_key)": record, "WITH r AS MATERIALIZED": []})
        ctx = Context(conn, QueryParams("surface=website"))
        ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
        ctx.week, ctx.dates, ctx.selected_dates = week(OCT5), [OCT5], [OCT5]
        run(catalog.prompts(ctx))
        sql = next(s for s, _ in conn.seen if "DISTINCT ON(j.prompt_key)" in s)
        self.assertRegex(sql, r"AND \(\$1::date IS NULL OR j\.round_date<=\$1::date\)\s+ORDER BY j\.prompt_key,j\.round_date DESC")
        self.assertEqual(moved, [(OCT11,)])

    def test_acr_coverage_offers_the_calendar_rounds_only(self):
        conn = GoldConn(ROUNDS, {"SELECT DISTINCT f.round_date": [{"round_date": d} for d in ROUNDS],
                                 "SELECT DISTINCT c.code": [], "WITH p AS": []})
        ctx = Context(conn, QueryParams("surface=global"))
        ctx.release, ctx.builds = {"release_id": 1, "version": 1, "rule_signature": "test"}, {"acr": [1], "fact": [2]}
        ctx.week, ctx.dates, ctx.selected_dates = week(OCT5), [OCT5, D("2026-09-21")], [OCT5]   # 09-28: not servable
        self.assertEqual(run(acr.coverage(ctx))["data"]["rounds"], ["2026-10-05"])

    def answer_conn(self, round_date):
        job = {"job_id": "j1", "surface": 1, "project_key": 1, "answer_key": 9, "round_date": round_date}
        answer = {"answer_key": 9, "build_id": 101, "round_date": round_date, "anchor_date": round_date, "measured_at": None,
                  "engine": "chatgpt", "country": "DE", "lang": "de", "prompt_id": "p", "text": "t", "kind": None, "cycle_id": None,
                  "analysis_state": 1, "gap": False, "is_acr": False, "is_rep": True, "acr_iter_rank": None, "model_slug": None,
                  "answer_text": "a"}
        return GoldConn(ROUNDS, {"FROM gold.job_index": [job], "FROM gold.answer_fact f": [answer], "answer_mention_raw": [],
                                 "answer_stance_raw": [], "FROM gold.citation_fact": [], "answer_occurrence": []})

    def test_an_answer_after_the_week_is_not_found(self):
        conn = self.answer_conn(D("2026-10-12"))
        ctx = Context(conn, QueryParams("surface=global"))
        ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
        ctx.week, ctx.builds = week(OCT5), {"fact": [100, 101]}
        with self.assertRaises(HTTPException) as cm:
            run(answers.detail(ctx, "j1"))
        self.assertEqual(cm.exception.status_code, 404)

    def test_an_answer_is_read_through_the_lists_gates(self):
        # the lists show a cycle that is servable, not hidden and visible today in Korea: so does the detail (review
        # r1-6: on the real clock a naive or UTC day passed on a Mac in Korea)
        conn = self.answer_conn(OCT5)
        ctx = Context(conn, QueryParams("surface=global"))
        ctx.release = {"release_id": 1, "version": 1, "rule_signature": "test"}
        ctx.week, ctx.builds = week(OCT5), {"fact": [101]}
        with clock(answers):
            run(answers.detail(ctx, "j1"))
        sql, args = next((s, a) for s, a in conn.seen if "FROM gold.answer_fact f" in s)
        self.assertIn("cy.servable", sql)
        self.assertRegex(sql, r"coalesce\(cy\.hidden_scope,0\)<>1")
        self.assertRegex(sql, r"cy\.view_date IS NULL OR cy\.view_date<=\$\d+")
        self.assertIn(NOV2, args)


class SnapshotId(unittest.TestCase):
    """The live snapshot a metric read is kept under (data_server.metrics.serving.current_snapshot) holds the service week."""

    def snapshot(self, data, surface="global"):
        @asynccontextmanager
        async def gold():
            yield GoldConn(ROUNDS, {"FROM gold.active_release": [{"release_id": 1, "version": 3}]})

        with hub(data), mock.patch.object(serving, "connection", gold):
            return run(serving.current_snapshot(surface))

    def test_another_week_is_another_snapshot(self):
        # an advance writes the HUB data DB, not Gold: without the week, answers read under the old week were served
        # on, and one page could mix two weeks
        first = self.snapshot(HubData(week_row(OCT5, seq=1)))
        second = self.snapshot(HubData(week_row(D("2026-10-12"), seq=2)))
        republished = self.snapshot(HubData(week_row(OCT5, seq=3)))
        uncapped = self.snapshot(None)
        self.assertEqual(len({first, second, republished, uncapped}), 4)
        self.assertTrue(first.startswith("gold-release:1:3:"))

    def test_a_week_that_cannot_be_read_is_the_503_of_the_capped_reads(self):
        with self.assertRaises(HTTPException) as cm:
            self.snapshot(HubData(row=None))
        self.assertEqual(cm.exception.status_code, 503)

    def test_the_project_surface_holds_no_week(self):
        self.assertTrue(self.snapshot(HubData(week_row(OCT5, seq=7)), "project").endswith(":-"))


class WeekNotes(unittest.TestCase):
    # live Gold (2026-11-03): the 07-20 week shows 24 sites on 07-24 and leaves out Kia Italy, whose one cycle is of 07-20;
    # the 09-14 week's rounds, the hidden one's too, are all of 09-18
    ROWS = [{"surface": 2, "week_start": D("2026-07-20"), "sites": 25, "shown": 24, "unpublished": 1, "hidden": 0, "other": 0,
             "days": [D("2026-07-20"), D("2026-07-24")]},
            {"surface": 2, "week_start": D("2026-09-14"), "sites": 95, "shown": 94, "unpublished": 0, "hidden": 1, "other": 0,
             "days": [D("2026-09-18")]}]

    def notes(self, qs=""):
        conn = GoldConn(ROUNDS, {"site_week": self.ROWS, "AS holds": []})

        @asynccontextmanager
        async def gold():
            yield conn

        with hub(HubData(week_row(OCT5))), mock.patch.object(readers, "connection", gold), clock(week_notes):
            out = run(readers.read("cycles/week-notes", QueryParams(qs)))
        sql, args = next((s, a) for s, a in conn.seen if "site_week" in s)
        return out, sql, args

    def test_the_sites_each_week_shows_nothing_of(self):
        out, sql, args = self.notes()
        # with the round days each note is about, for the screens to match a page's period by (review r2-10)
        self.assertEqual(out["data"]["items"], [
            {"surface": "website", "week_start": D("2026-07-20"), "sites": 25, "shown": 24, "unpublished": 1, "hidden": 0, "other": 0,
             "days": [D("2026-07-20"), D("2026-07-24")]},
            {"surface": "website", "week_start": D("2026-09-14"), "sites": 95, "shown": 94, "unpublished": 0, "hidden": 1, "other": 0,
             "days": [D("2026-09-18")]}])
        # Gold's completion rule over the weeks up to the service week, on the KST day
        self.assertIn(NOV2, args)
        self.assertIn(OCT11, args)
        self.assertIn("release_item", sql)
        for gone in ("gold.publication", "gold.cycle_pick_basis", "fleet_visible"):
            self.assertNotIn(gone, sql)

    def test_a_scoped_read_counts_its_own_sites(self):
        _, _, args = self.notes("brand=Kia&country=DE")
        self.assertIn(2, args)
        self.assertIn(["de"], args)

    # a website site is the page's when one of its jobs up to the service week is on every axis the page picks, as the
    # reads take its cells (Context.predicate: the job's country, language and engine); one with no job yet, by its own
    # country (data_server.tests.test_hub_service_week.GoldSchema runs it on PostgreSQL)
    SITES_CLAUSES = (
        "measured AS MATERIALIZED ( SELECT j.project_key,"
        "bool_or(($5::text[] IS NULL OR j.geo_key IN (SELECT geo_key FROM gold.dim_country WHERE lower(code)=ANY($5::text[]))) "
        "AND ($6::text[] IS NULL OR j.lang_key IN (SELECT lang_key FROM gold.dim_lang WHERE lower(code)=ANY($6::text[]))) "
        "AND ($7::text[] IS NULL OR j.engine_key IN (SELECT engine_key FROM gold.dim_engine WHERE lower(code)=ANY($7::text[])))) AS on_axes "
        "FROM gold.job_index j WHERE ($5::text[] IS NOT NULL OR $6::text[] IS NOT NULL OR $7::text[] IS NOT NULL) "
        "AND j.surface=2 AND ($3::date IS NULL OR j.round_date<=$3::date) GROUP BY 1),",
        "LEFT JOIN gold.dim_country dc ON dc.geo_key=dp.site_geo_key LEFT JOIN measured m ON m.project_key=d.project_key "
        "WHERE d.surface IN (1,2) AND ($3::date IS NULL OR d.round_date<=$3::date) "
        "AND (d.surface=1 OR (($4::int IS NULL OR (dp.site_brand_bit & $4::int)<>0) "
        "AND (m.on_axes OR (m.project_key IS NULL AND ($5::text[] IS NULL OR lower(dc.code)=ANY($5::text[])))))))")

    def test_the_pages_sites_are_those_its_reads_take(self):
        """Review r5-1 (2026-11-03): the notes took a website site by its own country (dim_project.site_geo_key) and by no
        language or engine, while the reads take its cells by the country each prompt is measured in, the language and
        the engine. A German page was told of Kia Italy's July site (Italian prompts only) and of a hidden US site
        (English only); a SA-Jeddah page or an AE account would not be told of Genesis Saudi Arabia (site SA-Dammam,
        measured in Jeddah and Riyadh) or of the Middle East site (measured in AE). The picks go to the read as the
        reads take them (lower case), and a site is matched on its jobs."""
        _, sql, args = self.notes("country=SA-Jeddah&lang=AR&engine=DeepSeek&engine=gemini")
        self.assertEqual(args[3:], (None, ["sa-jeddah"], ["ar"], ["deepseek", "gemini"]))
        flat = " ".join(sql.split())
        for clause in self.SITES_CLAUSES:
            self.assertIn(clause, flat)
        self.assertEqual(self.notes()[2][3:], (None, None, None, None))   # no pick: every site, no job read (gated off)

    def read_rounds(self, holds):
        """cycles/week-notes under the week 10-05..10-11 with the rounds statement answering `holds` (scope, read mode,
        holds): its data and that statement with its arguments."""
        conn = GoldConn(ROUNDS, {"site_week": self.ROWS, "AS holds": holds})

        @asynccontextmanager
        async def gold():
            yield conn

        with hub(HubData(week_row(OCT5))), mock.patch.object(readers, "connection", gold), clock(week_notes):
            out = run(readers.read("cycles/week-notes", QueryParams("surface=website")))
        sql, args = next(((s, a) for s, a in conn.seen if "AS holds" in s), (None, None))
        return out["data"], sql, args

    def test_the_rounds_are_the_reads_calendar(self):
        """Review r4-2 (2026-11-03): whether the service week holds a round of a surface (shared/service-week `rounds`,
        the shell's '측정 없음') came from the HUB job's record of the week's complete cycles, which a held week keeps
        while Gold re-opens its round; Context.create follows Gold live and took no snapshot under it. The notes' read
        asks the reads' own calendar of the week: per release the reads pick from (a page reads its snapshot in its own
        mode: Overview card, Mention live), a round of the surface in the week. None in any = False."""
        def holds(*website):
            return [*({"scope": "global", "read_mode": m, "holds": True} for m in ("card", "grid", "live")),
                    *({"scope": "website", "read_mode": m, "holds": h} for m, h in zip(("card", "grid", "live"), website))]

        data, sql, args = self.read_rounds(holds(False, False, False))
        self.assertEqual((data["week_start"], data["rounds"]), (OCT5, {"global": True, "website": False}))
        self.assertEqual(args, (NOV2, None, OCT5, OCT11))   # the calendar's day in Korea, the rule signature, the week
        self.assertEqual(self.read_rounds(holds(False, True, False))[0]["rounds"], {"global": True, "website": True})
        self.assertEqual(self.read_rounds(holds())[0]["rounds"], {"global": True, "website": False})   # no release: no round

    def test_the_rounds_ask_what_the_calendar_asks(self):
        """The rounds' test of a cycle is the text Context.create's calendar asks it by (context.calendar_round), bounded
        by the week's first and last day, over the release the reads take (scope, live, the one rule
        signature)."""
        from data_server.gold_reader import context as context_module

        def flat(sql):
            return " ".join(sql.split())

        conn = GoldConn(ROUNDS)
        create("surface=global", conn)
        self.assertEqual(next(s for s, _ in conn.seen if "SELECT DISTINCT c.round_date" in s), context_module.CALENDAR_SQL)
        self.assertIn(flat(f"WHERE c.surface=$1 AND ($2::smallint IS NULL OR c.project_key=$2) AND {context_module.calendar_round('$4', '$3::date')} "
                           "AND ($5::date IS NULL OR c.round_date <= $5::date)"), flat(context_module.CALENDAR_SQL))
        sql = flat(week_notes.ROUNDS_SQL)
        self.assertIn(flat(f"WHERE c.surface=CASE a.scope WHEN 'global' THEN 1 ELSE 2 END AND "
                           f"{context_module.calendar_round('a.release_id', '$1::date')} AND c.round_date BETWEEN $3::date AND $4::date"), sql)
        self.assertIn("FROM gold.active_release a WHERE a.scope IN ('global','website') AND a.read_mode='live' "
                      "AND ($2::text IS NULL OR a.rule_signature=$2)", sql)

    def test_only_on_the_global_and_website_surfaces(self):
        # review r2-6 (2026-11-03): the notes are of the global and website weeks, and Context.create holds only those
        # surfaces to the service week. Read on the project surface they took no week and listed the weeks after it
        # (07-20 and 09-14 under the week 07-13..07-19)
        with self.assertRaises(HTTPException) as cm:
            self.notes("surface=project&project_id=p1")
        self.assertEqual(cm.exception.status_code, 422)

    def test_the_rule_is_the_jobs(self):
        """Review r1-4 (2026-11-03): the fake answers any SQL, so the notes' rule is pinned clause by clause (whitespace
        aside): the HUB job's complete(), blocking(), hidden() and fleet_visible() (hub_storage/service_week.py, its
        twin: change the two together), the weeks up to the service week only, an account's and a page's own sites
        (review r5-1) and the round days each note is about (review r2-10)."""
        _, sql, args = self.notes("brand=Kia&country=DE&lang=de&engine=gemini")
        sql = " ".join(sql.split())
        self.assertEqual((args[0], args[2], args[3], args[4], args[5], args[6]), (NOV2, OCT11, 2, ["de"], ["de"], ["gemini"]))
        for clause in (
                # the active releases the screens pick from
                "WHERE a.scope IN ('global','website') AND a.read_mode='live' "
                "AND ($2::text IS NULL OR a.rule_signature=$2)",
                # the cycles of surfaces 1 and 2 up to the week's last day, in the ISO week of their round; of the website,
                # the sites of an account's or a page's brands with a job on its countries, languages and engines (the
                # reads' own sites, SITES_CLAUSES); the global surface is everyone's
                "SELECT d.cyc_key,d.surface,d.project_key,d.round_date,date_trunc('week',d.round_date)::date AS wk,",
                "coalesce(d.hidden_scope,0) AS hidden_scope, CASE d.surface WHEN 1 THEN 'global' ELSE 'website' END AS scope "
                "FROM gold.dim_cycle d LEFT JOIN gold.dim_project dp ON dp.project_key=d.project_key ",
                *self.SITES_CLAUSES,
                # complete(): the operating snapshot is loaded (the load job keeps dim_cycle to the manifest), in the live release
                "(c.status=2 AND c.servable AND (c.view_date IS NULL OR c.view_date<=$1::date) "
                "AND EXISTS (SELECT 1 FROM rel r WHERE r.scope=c.scope) "
                "AND NOT EXISTS (SELECT 1 FROM rel r WHERE r.scope=c.scope AND NOT EXISTS ( "
                "SELECT 1 FROM gold.release_item ri JOIN gold.build bu ON bu.build_id=ri.build_id AND bu.status='validated' "
                "WHERE ri.release_id=r.release_id AND ri.family='fact' AND ri.state='ready' "
                "AND ri.slice_key='cyc:'||c.cyc_key::text)) ) AS complete",
                # blocking(): not hidden, not complete, and on its way
                "(j.hidden_scope<>1 AND NOT j.complete "
                "AND (j.status=0 OR (j.status=2 AND j.servable))) AS blocking",
                # per site and week: shown = complete and not hidden; else held back, else hidden, else Gold's own setting aside
                "SELECT surface,wk,project_key,bool_or(complete AND hidden_scope<>1) AS shown,bool_or(blocking) AS waiting, "
                "bool_or(hidden_scope=1) AS hidden FROM verdict GROUP BY 1,2,3",
                # the round days of a note: the rounds its week's sites show and every round of a site it shows nothing of
                "SELECT v.surface,v.wk,array_agg(DISTINCT v.round_date ORDER BY v.round_date) AS days "
                "FROM verdict v JOIN site_week s ON s.surface=v.surface AND s.wk=v.wk AND s.project_key=v.project_key "
                "WHERE (v.complete AND v.hidden_scope<>1) OR NOT s.shown GROUP BY 1,2)",
                "count(*)::int AS sites,(count(*) FILTER (WHERE s.shown))::int AS shown, "
                "(count(*) FILTER (WHERE NOT s.shown AND s.waiting))::int AS unpublished, "
                "(count(*) FILTER (WHERE NOT s.shown AND NOT s.waiting AND s.hidden))::int AS hidden, "
                "(count(*) FILTER (WHERE NOT s.shown AND NOT s.waiting AND NOT s.hidden))::int AS other,w.days "
                "FROM site_week s JOIN week_day w ON w.surface=s.surface AND w.wk=s.wk "
                "GROUP BY 1,2,w.days HAVING bool_or(NOT s.shown)"):
            self.assertIn(clause, sql)


class RuleC4(unittest.TestCase):
    """Rule C4 (critic 2026-11-02): the publication tables are no release items, so neither the calendar nor the
    builds cap reaches them. A read of one binds the capped rounds (round_date=ANY(ctx.dates)) or the cyc_keys of
    those rounds; a module that reads one is listed here once it does."""

    ALLOWED = {"gold_reader/week_notes.py"}   # Gold's completion rule over cycles up to the week's last day

    def test_no_unbound_read_of_a_publication_table(self):
        root = Path(__file__).resolve().parents[1]
        found = set()
        for path in root.rglob("*.py"):
            if "tests" in path.parts:
                continue
            if re.search(r"gold\.(report_value|publication|pub_cell|pub_cell_web)\b", path.read_text(encoding="utf-8")):
                found.add(path.relative_to(root).as_posix())
        self.assertEqual(found - self.ALLOWED, set(), "a read of gold.report_value / publication / pub_cell / pub_cell_web "
                                                      "must bind the capped rounds (Context docstring, rule C4)")


if __name__ == "__main__":
    unittest.main()
