"""Gold's metric rows as a data source (data_server.metrics.gold_rows): current rounds from the rows, a late round counted as the last resort, what
was never computed counted from the snapshot; the rollup's recording counts only what is not current."""
import asyncio
import json
import unittest
from datetime import date
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from data_server.gold_reader.context import Context
    from data_server.metrics import gold_rows
    from data_server.metrics.catalog import DEFINITION_VERSION, MONITORING
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_metrics_gold_rows)") from exc

D1, D2, D3 = date(2026, 9, 21), date(2026, 9, 28), date(2026, 10, 5)
GROUP = ("round_date", "engine_key")
CALL = "answer_counts|monitoring|round_date,engine_key"


class Live:
    """The snapshot's data source: says what it was asked."""

    surface, snapshot_id = "global", "s"

    def __init__(self, ctx, calls=None, rows=None):
        self.ctx, self.calls, self.rows_ = ctx, calls if calls is not None else [], rows

    def for_rounds(self, rounds):
        ctx = Context(None, ctx_q(self.ctx))
        ctx.build_dates, ctx.selected_dates = self.ctx.build_dates, sorted(rounds)
        return Live(ctx, self.calls, self.rows_)

    async def answer_counts(self, population, group=(), *, prompts=False):
        self.calls.append(("answer_counts", list(self.ctx.selected_dates)))
        return [dict(r) for r in (self.rows_ or []) if r["round_date"] in self.ctx.selected_dates]

    async def applied_prompts(self):
        self.calls.append(("applied_prompts", list(self.ctx.selected_dates)))
        return 7


class Failing(Live):
    """A snapshot that cannot be read."""

    def for_rounds(self, rounds):
        return Failing(self.ctx, self.calls)

    async def answer_counts(self, population, group=(), *, prompts=False):
        self.calls.append(("answer_counts", list(self.ctx.selected_dates)))
        raise OSError("down")


def ctx_q(ctx):
    return ctx.q


def context(qs="surface=global", rounds=(D3,)):
    ctx = Context(None, QueryParams(qs))
    ctx.build_dates = {1: D1, 2: D2, 3: D3}
    ctx.selected_dates = list(rounds)
    return ctx


def state(ctx, day, *, snapshot=None, version=DEFINITION_VERSION, error=None):
    return {"round_date": day, "snapshot_id": snapshot or gold_rows.round_snapshot(ctx, day), "definition_version": version, "error": error}


def stored(day, answers):
    return {"round_date": day, "dims": {"engine_key": 1}, "counts": {"answers": answers}}


def read(ctx, states, rows=(), call=None, live_rows=None, live=None):
    live = live or Live(ctx, rows=live_rows)
    source = gold_rows.GoldRowsSource(live, gold_rows.scope_of(ctx))

    async def main():
        with mock.patch.object(gold_rows.metrics_db, "call_states", mock.AsyncMock(return_value=states)), \
                mock.patch.object(gold_rows.metrics_db, "metric_rows", mock.AsyncMock(return_value=list(rows))) as got:
            return await (call(source) if call else source.answer_counts(MONITORING, GROUP)), got
    answer, got = asyncio.run(main())
    return answer, live, got


class Scope(unittest.TestCase):
    def test_a_filter_is_no_scope(self):
        for qs in ("country=US", "from=2026-10-01", "cf.1=a", "lang=en", "depth1=x", "source=officialHmg", "mention_brand=Kia"):
            with self.subTest(qs=qs):
                self.assertIsNone(gold_rows.scope_of(context(f"surface=global&{qs}")))

    def test_the_first_screens_conditions_are_part_of_it(self):
        self.assertEqual(gold_rows.scope_of(context()), "bits=7")
        self.assertEqual(gold_rows.scope_of(context("surface=global&brand=kia&engine=Gemini&engine=ChatGPT&brand_presence=branded")),
                         "bits=2;engine=chatgpt,gemini;brand_presence=branded")

    def test_a_round_snapshot_moves_only_with_that_rounds_builds(self):
        ctx = context()
        before = gold_rows.round_snapshot(ctx, D3), gold_rows.round_snapshot(ctx, D2)
        ctx.build_dates = {**ctx.build_dates, 4: D3}
        self.assertNotEqual(gold_rows.round_snapshot(ctx, D3), before[0])
        self.assertEqual(gold_rows.round_snapshot(ctx, D2), before[1])


class Rows(unittest.TestCase):
    def test_current_rounds_come_from_the_rows(self):
        ctx = context(rounds=(D2, D3))
        answer, live, got = read(ctx, {d: state(ctx, d) for d in (D2, D3)}, [stored(D2, 5), stored(D3, 6)])
        self.assertEqual(answer, [{"engine_key": 1, "answers": 5, "round_date": D2}, {"engine_key": 1, "answers": 6, "round_date": D3}])
        self.assertEqual(live.calls, [])
        self.assertEqual(got.call_args.args[2:], (CALL, "bits=7", [D2, D3]))

    def test_never_computed_is_counted_from_the_snapshot_and_marked_live(self):
        ctx = context()
        usage = {"live": False}
        token = gold_rows.track_usage(usage)
        try:
            read(ctx, {})
        finally:
            gold_rows.stop_tracking(token)
        self.assertTrue(usage["live"])

    def test_a_sum_over_rounds_is_counted_from_the_snapshot(self):
        ctx = context(rounds=(D2, D3))
        _, live, _ = read(ctx, {}, call=lambda s: s.answer_counts(MONITORING))
        self.assertEqual(live.calls, [("answer_counts", [D2, D3])])

    def test_a_late_round_of_one_round_read_is_counted_as_the_last_resort(self):
        for late in ({"snapshot": "older"}, {"version": "older"}, {"error": "boom"}):
            with self.subTest(late=late):
                ctx = context()
                usage = {"live": False}
                token = gold_rows.track_usage(usage)
                try:
                    answer, live, got = read(ctx, {D3: state(ctx, D3, **late)}, live_rows=[{"round_date": D3, "engine_key": 1, "answers": 9}])
                finally:
                    gold_rows.stop_tracking(token)
                self.assertEqual(answer, [{"round_date": D3, "engine_key": 1, "answers": 9}])
                self.assertEqual(live.calls, [("answer_counts", [D3])])
                self.assertTrue(usage["live"])   # so serving keeps it in the cache DB
                got.assert_not_called()

    def test_a_round_missing_from_a_computed_call_is_late(self):
        ctx = context()
        _, live, _ = read(ctx, {D2: state(ctx, D2)}, live_rows=[])
        self.assertEqual(live.calls, [("answer_counts", [D3])])

    def test_a_late_round_of_a_trend_is_counted_and_the_others_stay(self):
        ctx = context(rounds=(D1, D2, D3))
        usage = {"live": False}
        token = gold_rows.track_usage(usage)
        try:
            answer, live, got = read(ctx, {D1: state(ctx, D1, snapshot="older"), D2: state(ctx, D2), D3: state(ctx, D3)}, [stored(D2, 5), stored(D3, 6)],
                                     live_rows=[{"round_date": D1, "engine_key": 1, "answers": 4}])
        finally:
            gold_rows.stop_tracking(token)
        self.assertEqual([(r["round_date"], r["answers"]) for r in answer], [(D1, 4), (D2, 5), (D3, 6)])
        self.assertEqual(live.calls, [("answer_counts", [D1])])    # only the late round
        self.assertEqual(got.call_args.args[4], [D2, D3])
        self.assertEqual(ctx.late_rounds, set())
        self.assertTrue(usage["live"])

    def test_a_trend_with_every_round_late_is_counted(self):
        ctx = context(rounds=(D2, D3))
        _, live, got = read(ctx, {D2: state(ctx, D2, version="older"), D3: state(ctx, D3, version="older")}, live_rows=[])
        self.assertEqual(live.calls, [("answer_counts", [D2, D3])])
        got.assert_not_called()

    def test_when_the_last_resort_fails_too_a_round_read_is_not_shown(self):
        ctx = context()
        with self.assertRaises(HTTPException) as caught:
            read(ctx, {D3: state(ctx, D3, snapshot="older")}, live=Failing(ctx))
        self.assertEqual(caught.exception.status_code, 503)

    def test_when_the_last_resort_fails_too_a_trend_keeps_the_gap(self):
        ctx = context(rounds=(D1, D2, D3))
        usage = {"live": False}
        token = gold_rows.track_usage(usage)
        try:
            answer, _, _ = read(ctx, {D1: state(ctx, D1, snapshot="older"), D2: state(ctx, D2), D3: state(ctx, D3)}, [stored(D2, 5), stored(D3, 6)], live=Failing(ctx))
        finally:
            gold_rows.stop_tracking(token)
        self.assertEqual([r["round_date"] for r in answer], [D2, D3])
        self.assertEqual(ctx.late_rounds, {D1})
        self.assertFalse(usage["live"])    # a read with a gap is not cached

    def test_the_last_resort_runs_a_few_at_a_time(self):
        async def main():
            running, peak = 0, 0

            async def one():
                nonlocal running, peak
                async with gold_rows.last_resort():
                    running += 1
                    peak = max(peak, running)
                    await asyncio.sleep(0)
                    running -= 1

            with mock.patch.object(gold_rows, "_LAST_RESORT", asyncio.Semaphore(2)):
                await asyncio.gather(*(one() for _ in range(6)))
            return peak
        self.assertEqual(asyncio.run(main()), 2)

    def test_a_last_resort_inside_another_takes_no_second_place(self):
        async def main():
            with mock.patch.object(gold_rows, "_LAST_RESORT", asyncio.Semaphore(1)):
                async with gold_rows.last_resort():
                    async with gold_rows.last_resort():
                        return True
        self.assertTrue(asyncio.run(asyncio.wait_for(main(), 2)))

    def test_a_single_value_comes_back_as_it_was(self):
        ctx = context()
        answer, _, _ = read(ctx, {D3: state(ctx, D3)}, [{"round_date": D3, "dims": {}, "counts": {gold_rows.SCALAR: 7}}], call=lambda s: s.applied_prompts())
        self.assertEqual(answer, 7)

    def test_brand_keys_are_picked_from_every_brand_kept(self):
        rows = [{"round_date": D3, "dims": {"brand_key": k}, "counts": {"mentions": k}} for k in (1, 2, 3)]
        self.assertEqual([r["brand_key"] for r in gold_rows._assemble(rows, {"brand_keys": ["1", "3"]}, False, False)], [1, 3])
        self.assertEqual(gold_rows.call_key("brand_counts", ("monitoring", ("round_date",)), {"brand_keys": ["1"], "prompts": True}), "brand_counts|monitoring|round_date|prompts=True")


class Recording(unittest.TestCase):
    class Writer:
        """The rollup's connection: a memory of metric_call and metric_row."""

        def __init__(self, calls):
            self.calls_, self.rows_ = dict(calls), []

        def transaction(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def fetch(self, sql, *args):
            if "FROM gold.metric_call" in sql:
                return [v for v in self.calls_.values()]
            return [{"round_date": r[0], "dims": r[1], "counts": r[2]} for r in sorted(self.rows_, key=lambda r: r[0]) if r[0] in args[4]]

        async def execute(self, sql, *args):
            if sql.startswith("DELETE"):
                self.rows_ = [r for r in self.rows_ if r[0] != args[2]]
            else:
                self.calls_[args[2]] = {"round_date": args[2], "snapshot_id": args[5], "definition_version": args[6], "error": args[8]}

        async def copy_records_to_table(self, table, *, schema_name, columns, records):
            for rec in records:
                self.rows_.append((rec[2], rec[6], rec[7]))

    def record(self, ctx, writer, rows):
        live = Live(ctx, rows=rows)
        recorder = gold_rows.RowRecorder(writer)

        async def main():
            token = gold_rows.start_recording(recorder)
            try:
                return await gold_rows.RecordingSource(live, gold_rows.scope_of(ctx)).answer_counts(MONITORING, GROUP)
            finally:
                gold_rows.stop_recording(token)
        return asyncio.run(main()), live, recorder

    ROW = {"engine_key": 1, "answers": 3, "tracked": 1, "rep_answers": 2, "rep_tracked": 1}

    def test_only_rounds_not_current_are_counted_and_every_round_is_answered(self):
        ctx = context(rounds=(D2, D3))
        writer = self.Writer({D2: state(ctx, D2)})
        writer.rows_.append((D2, json.dumps({"engine_key": 1}), json.dumps({"answers": 9})))
        answer, live, recorder = self.record(ctx, writer, [{**self.ROW, "round_date": D3}])
        self.assertEqual(live.calls, [("answer_counts", [D3])])
        self.assertEqual([(r["round_date"], r["answers"]) for r in answer], [(D2, 9), (D3, 3)])
        self.assertEqual(recorder.written, 1)

    def test_a_kept_row_holds_its_counts_and_metric_values(self):
        ctx = context()
        writer = self.Writer({})
        self.record(ctx, writer, [{**self.ROW, "round_date": D3}])
        self.assertEqual(json.loads(writer.rows_[0][1]), {"engine_key": 1})
        self.assertNotIn("round_date", json.loads(writer.rows_[0][2]))


if __name__ == "__main__":
    unittest.main()
