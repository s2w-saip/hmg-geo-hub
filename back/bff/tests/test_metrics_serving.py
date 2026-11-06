"""Where a /v1 read's answer comes from (bff.metrics.serving): Gold for a first screen's read, counted as the last resort when late or
failed; the cache DB, else a fresh count, for any other read; a read that holds no metric value as it is; a rollup's reads counted once."""
import asyncio
import unittest
from unittest import mock

try:
    from fastapi import HTTPException
    from starlette.datastructures import QueryParams

    from bff.metrics import gold_rows, serving
    from bff.metrics.catalog import DEFINITION_VERSION
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (bff.tests.test_metrics_serving)") from exc


def setUpModule():
    from bff.tests.stand_ins import no_judged_answers
    no_judged_answers()

Q = QueryParams("surface=global")


class Runs:
    def __init__(self, text='{"n":1}', error=None):
        self.text, self.error, self.calls = text, error, 0

    async def __call__(self):
        self.calls += 1
        if self.error:
            raise self.error
        return self.text


def serve(path="filters/options", q=Q, kept=None, cached=None, snapshot="s1", run=None):
    run = run or Runs()
    put = mock.AsyncMock(return_value=True)

    async def main():
        with (mock.patch.object(serving, "snapshot_of", mock.AsyncMock(return_value=snapshot))), \
                mock.patch.object(serving.metrics_db, "first_screen", mock.AsyncMock(return_value=kept)) as first, \
                mock.patch.object(serving.cache_db, "get", mock.AsyncMock(return_value=cached)) as get, \
                mock.patch.object(serving.cache_db, "put", put):
            answer = await serving.read(path, q, run)
            await asyncio.sleep(0)   # the store runs after the answer went out
            return answer, first, get
    answer, first, get = asyncio.run(main())
    return answer, run, first, get, put


def row(snapshot="s1", version=DEFINITION_VERSION, result='{"gold":1}', error=None):
    return {"snapshot_id": snapshot, "definition_version": version, "result": result, "error": error}


class FirstScreen(unittest.TestCase):
    def test_the_current_value_is_served_and_nothing_is_counted(self):
        answer, run, _, get, _ = serve(kept=row())
        self.assertEqual(answer, '{"gold":1}')
        self.assertEqual(run.calls, 0)
        get.assert_not_called()

    def test_late_or_failed_is_counted_as_the_last_resort_and_cached(self):
        for kept in (row(snapshot="s0"), row(version="older"), row(result=None, error="ValueError: x")):
            with self.subTest(kept=kept):
                answer, run, _, _, put = serve(kept=kept)
                self.assertEqual((answer, run.calls), ('{"n":1}', 1))
                self.assertEqual(put.call_args.args[1:], ("s1", DEFINITION_VERSION, '{"n":1}'))

    def test_a_last_resort_already_cached_is_not_counted_again(self):
        answer, run, _, _, put = serve(kept=row(snapshot="s0"), cached='{"cached":1}')
        self.assertEqual((answer, run.calls), ('{"cached":1}', 0))
        put.assert_not_called()

    def test_a_last_resort_that_fails_too_shows_nothing(self):
        with self.assertRaises(HTTPException) as caught:
            serve(kept=row(snapshot="s0"), run=Runs(error=OSError("down")))
        self.assertEqual(caught.exception.status_code, 503)


class Filtered(unittest.TestCase):
    Q = QueryParams("country=US&surface=global")

    def test_a_cached_result_is_served(self):
        answer, run, _, _, put = serve(q=self.Q, cached='{"cached":1}')
        self.assertEqual(answer, '{"cached":1}')
        self.assertEqual(run.calls, 0)
        put.assert_not_called()

    def test_a_miss_counts_and_stores_under_the_snapshot_and_version(self):
        answer, run, _, _, put = serve(q=self.Q)
        self.assertEqual((answer, run.calls), ('{"n":1}', 1))
        query, snapshot, version, text = put.call_args.args
        self.assertEqual(query, {"path": "filters/options", "country": ["US"], "surface": ["global"]})
        self.assertEqual((snapshot, version, text), ("s1", DEFINITION_VERSION, '{"n":1}'))

    def test_an_oversized_result_is_answered_and_not_kept(self):
        with mock.patch.object(serving, "MAX_KEPT_BYTES", 3):
            _, run, _, _, put = serve(q=self.Q)
        self.assertEqual(run.calls, 1)
        put.assert_not_called()


class MetricReads(unittest.TestCase):
    """The reads whose counts come from a data source: never kept whole; cached only when a call was counted from the snapshot."""

    def test_answered_from_the_rows_nothing_is_stored_and_gold_is_not_asked(self):
        answer, run, first, _, put = serve(path="kpi/summary")
        self.assertEqual((answer, run.calls), ('{"n":1}', 1))
        first.assert_not_called()
        put.assert_not_called()

    def test_counted_from_the_snapshot_it_is_stored(self):
        class Live(Runs):
            async def __call__(self):
                gold_rows._mark_live()
                return await super().__call__()
        _, _, _, _, put = serve(path="kpi/summary", q=QueryParams("country=US&surface=global"), run=Live())
        put.assert_called_once()

    def test_a_rollup_does_not_keep_them_whole(self):
        kept = []

        async def keep(*args):
            kept.append(args)

        async def main():
            token = serving.start_recording(serving.Recording(keep))
            try:
                return await serving.read("trend", Q, Runs())
            finally:
                serving.stop_recording(token)
        self.assertEqual(asyncio.run(main()), '{"n":1}')
        self.assertEqual(kept, [])


class Plain(unittest.TestCase):
    def test_a_read_without_metric_values_is_read_as_it_is(self):
        for path in ("answers", "answers/abc", "gold/keywords", "gold/social", "source"):
            with self.subTest(path=path):
                answer, run, first, get, put = serve(path=path)
                self.assertEqual((answer, run.calls), ('{"n":1}', 1))
                first.assert_not_called()
                get.assert_not_called()
                put.assert_not_called()

    def test_no_snapshot_to_key_on_reads_as_it_is(self):
        run = Runs()

        async def main():
            with mock.patch.object(serving, "snapshot_of", mock.AsyncMock(side_effect=OSError("gold down"))):
                return await serving.read("filters/options", Q, run)
        self.assertEqual(asyncio.run(main()), '{"n":1}')


class Recording(unittest.TestCase):
    def run_recording(self, *reads):
        kept = []

        async def keep(*args):
            kept.append(args)

        async def main():
            recording = serving.Recording(keep)
            token = serving.start_recording(recording)
            results = []
            try:
                for path, q, run in reads:
                    try:
                        results.append(await serving.read(path, q, run))
                    except ValueError as error:
                        results.append(error)
            finally:
                serving.stop_recording(token)
            return recording, results
        recording, results = asyncio.run(main())
        return recording, results, kept

    def test_a_read_is_counted_once_and_kept_with_its_surface(self):
        run = Runs()
        _, results, kept = self.run_recording(("filters/options", Q, run), ("filters/options", Q, run))
        self.assertEqual(results, ['{"n":1}', '{"n":1}'])
        self.assertEqual(run.calls, 1)
        self.assertEqual(kept, [("global", "filters/options", "surface=global", '{"n":1}', None)])

    def test_a_failed_read_is_kept_as_failed_and_still_raises(self):
        run = Runs(error=ValueError("broken"))
        recording, results, kept = self.run_recording(("filters/options", Q, run))
        self.assertIsInstance(results[0], ValueError)
        self.assertEqual(recording.failed, 1)
        self.assertEqual(kept[0][3], None)
        self.assertIn("broken", kept[0][4])

    def test_a_read_without_metric_values_is_not_kept(self):
        _, results, kept = self.run_recording(("gold/keywords", QueryParams(""), Runs()))
        self.assertEqual((results, kept), (['{"n":1}'], []))

    def test_the_project_list_keeps_on_the_project_surface(self):
        _, _, kept = self.run_recording(("gold/projects", QueryParams(""), Runs()))
        self.assertEqual(kept[0][0], "project")


class Key(unittest.TestCase):
    def test_a_read_key_is_a_hash_of_the_path_and_query(self):
        self.assertRegex(serving.read_key("kpi/summary?surface=global"), r"^[a-f0-9]{64}$")
        self.assertNotEqual(serving.read_key("kpi/summary?surface=global"), serving.read_key("kpi/summary?surface=website"))


if __name__ == "__main__":
    unittest.main()
