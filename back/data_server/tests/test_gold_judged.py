"""The keys data_server.metrics.gold_judged works out per set of builds: once, however many of a page's reads ask at the same time."""
import asyncio
import unittest
from unittest import mock

try:
    from data_server.metrics import gold_judged
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_gold_judged)") from exc


def ctx(builds=(1, 2)):
    return mock.Mock(sf=2, builds={"fact": list(builds)})


class Once(unittest.TestCase):
    def setUp(self):
        gold_judged._owned.clear()
        gold_judged._building.clear()
        self.addCleanup(gold_judged._owned.clear)
        self.addCleanup(gold_judged._building.clear)
        inputs = gold_judged.Inputs(registered={"site": ["kia.com"]}, registered_digest="d")
        for name, value in (("read_inputs", mock.AsyncMock(return_value=inputs)), ("_project_keys", mock.AsyncMock(return_value={"site": 7}))):
            patcher = mock.patch.object(gold_judged, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_the_reads_of_a_page_share_one_count(self):
        """Regression: a restarted server's first Website page ran the key list once per read at the same time (9 s each alone), every one passed the statement limit and the page failed, again and again."""
        keys = mock.AsyncMock(return_value=[11, 12])

        async def slow(*args):
            await asyncio.sleep(0)
            return await keys(*args)

        async def main():
            with mock.patch.object(gold_judged, "_prefix_keys", slow):
                return await asyncio.gather(*(gold_judged.owned_url_keys(ctx()) for _ in range(5)))
        self.assertEqual(asyncio.run(main()), [[11, 12]] * 5)
        self.assertEqual(keys.await_count, 1)

    def test_a_count_that_failed_is_tried_again_by_the_next_read(self):
        keys = mock.AsyncMock(side_effect=[TimeoutError("statement limit"), [11]])

        async def main():
            with mock.patch.object(gold_judged, "_prefix_keys", keys):
                first = await asyncio.gather(gold_judged.owned_url_keys(ctx()), gold_judged.owned_url_keys(ctx()), return_exceptions=True)
                return first, await gold_judged.owned_url_keys(ctx())
        first, then = asyncio.run(main())
        self.assertIsInstance(first[0], TimeoutError)
        self.assertEqual(first[1], [11])
        self.assertEqual(then, [11])
        self.assertEqual(keys.await_count, 2)

    def test_other_builds_are_another_count(self):
        keys = mock.AsyncMock(side_effect=[[1], [2]])

        async def main():
            with mock.patch.object(gold_judged, "_prefix_keys", keys):
                return await gold_judged.owned_url_keys(ctx((1,))), await gold_judged.owned_url_keys(ctx((2,))), await gold_judged.owned_url_keys(ctx((1,)))
        self.assertEqual(asyncio.run(main()), ([1], [2], [1]))
        self.assertEqual(keys.await_count, 2)


if __name__ == "__main__":
    unittest.main()
