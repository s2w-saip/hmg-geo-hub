"""The service week provider (data_server/hub_stores/service_week.py, 2026-11-02): the BFF reads the week the HUB job recorded
(catalog.current_service_week) without ever making a Gold read wait on the data DB, never falls back to no cap while
the data DB is configured, and names the week as the screens do."""
import asyncio
import time
import unittest
from datetime import date, timedelta
from unittest import mock

try:
    import asyncpg
    from fastapi import HTTPException

    from data_server.hub_stores import service_week
    from data_server.tests.service_week_util import HubData, clock, hub, week_row
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Run inside the BFF image (data_server.tests.test_service_week_provider)") from exc

OCT5 = date(2026, 10, 5)


def run(coro):
    return asyncio.run(coro)


class Current(unittest.TestCase):
    def test_no_data_db_is_no_cap(self):
        # tests and offline scripts: HGH_ANALYTICS_DB_URL unset, the pool never opened
        with hub(None):
            self.assertIsNone(run(service_week.current()))

    def test_the_recorded_week(self):
        with hub(HubData(week_row(OCT5, seq=7))) as data:
            week = run(service_week.current())
        self.assertEqual((week.seq, week.start, week.end), (7, OCT5, date(2026, 10, 11)))
        self.assertEqual((week.recorded_at.isoformat(), week.checked_at.isoformat()),
                         ("2026-10-25T01:10:00+00:00", "2026-11-02T01:10:00+00:00"))
        self.assertEqual(data.reads, 1)

    def test_the_week_alone(self):
        # review r4-2 (2026-11-03): the job's cycle sets per surface are its record of what completed the week, kept as
        # they were while it holds a week whose round Gold re-opened; whether the week holds a round of a surface (the
        # screens' '측정 없음') is the reads' calendar's to say (cycles/week-notes), not this record's
        with hub(HubData(week_row(date(2026, 7, 27), website_cycles=0))):
            week = run(service_week.current())
        self.assertEqual((week.start, week.end), (date(2026, 7, 27), date(2026, 8, 2)))
        self.assertNotIn("_cycles", service_week.WEEK_SQL)
        self.assertFalse(hasattr(week, "website_cycles"))

    def test_a_kept_week_is_served_without_a_read(self):
        with hub(HubData(week_row(OCT5))) as data:
            async def go():
                return [await service_week.current() for _ in range(3)]
            weeks = run(go())
        self.assertEqual({w.start for w in weeks}, {OCT5})
        self.assertEqual(data.reads, 1)

    def test_a_down_data_db_is_never_no_cap(self):
        # critic 2026-11-02: asyncpg raises ConnectionRefusedError, a ConnectionError, for a server that is down; read as
        # 'not configured' it would lift the cap from every screen
        for failure in (HubData(refuse=ConnectionRefusedError(61, "Connect call failed")),
                        HubData(error=asyncpg.UndefinedTableError("relation does not exist")),
                        HubData(row=None), HubData(error=TimeoutError())):
            with self.subTest(failure=failure.refuse or failure.error or "no row"), hub(failure), \
                    self.assertRaises(service_week.ServiceWeekUnavailable):
                run(service_week.current())

    def test_a_failed_refresh_keeps_the_last_good_week(self):
        with hub(HubData(week_row(OCT5))) as data, mock.patch.object(service_week, "CACHE_S", 0):
            async def go():
                first = await service_week.current()
                data.refuse = ConnectionRefusedError(61, "Connect call failed")
                stale = await service_week.current()        # served at once, the refresh runs behind it
                await service_week._refresh
                after = await service_week.current()        # the refresh failed: still the last good week
                return first, stale, after
            first, stale, after = run(go())
        self.assertEqual([first.start, stale.start, after.start], [OCT5] * 3)
        self.assertEqual(data.connects, 2)                  # the failed one is not tried again at once

    def test_a_kept_week_is_refreshed_behind_the_read(self):
        with hub(HubData(week_row(OCT5))) as data, mock.patch.object(service_week, "CACHE_S", 0):
            async def go():
                await service_week.current()
                data.row = week_row(OCT5 + timedelta(days=7), seq=2)
                stale = await service_week.current()
                await service_week._refresh
                fresh = await service_week.current()
                return stale, fresh
            stale, fresh = run(go())
        self.assertEqual((stale.seq, fresh.seq), (1, 2))
        self.assertEqual(fresh.start, date(2026, 10, 12))

    def test_a_kept_week_is_not_read_again_before_it_is_due(self):
        with hub(HubData(week_row(OCT5))) as data:
            async def go():
                for _ in range(3):
                    await service_week.current()
            run(go())
        self.assertEqual(data.reads, 1)

    def test_a_hanging_read_never_holds_a_read_back(self):
        # critic 2026-11-02: Context.create awaits the week while it holds one of Gold's 6 connections
        with hub(HubData(week_row(OCT5))) as data, mock.patch.object(service_week, "READ_TIMEOUT_S", 0.05), \
                mock.patch.object(service_week, "CACHE_S", 0):
            async def go():
                await service_week.current()
                data.hang = True
                started = time.monotonic()
                week = await service_week.current()
                took = time.monotonic() - started
                await service_week._refresh             # gives up after READ_TIMEOUT_S
                return week, took
            week, took = run(go())
        self.assertEqual(week.start, OCT5)
        self.assertLess(took, 0.04)
        self.assertEqual(data.reads, 2)

    def test_a_cold_read_waits_bounded(self):
        with hub(HubData(hang=True)), mock.patch.object(service_week, "READ_TIMEOUT_S", 0.05):
            started = time.monotonic()
            with self.assertRaises(service_week.ServiceWeekUnavailable):
                run(service_week.current())
        self.assertLess(time.monotonic() - started, 1)

    def test_a_cold_read_waits_bounded_on_a_server_that_stopped_answering(self):
        # review r1-5 (2026-11-03): a read cut off at READ_TIMEOUT_S still unwinds on the server (asyncpg rolls back and
        # releases the pooled connection), and a stopped server does not answer that either: the first read waited for
        # as long as it stayed stopped, holding one of Gold's 6 connections. Each caller stops at READ_TIMEOUT_S; the
        # read still in flight is waited on again, not started again
        with hub(HubData(stall=1.0)) as data, mock.patch.object(service_week, "READ_TIMEOUT_S", 0.05):
            async def go():
                took = []
                for _ in range(2):
                    started = time.monotonic()
                    with self.assertRaises(service_week.ServiceWeekUnavailable):
                        await service_week.current()
                    took.append(time.monotonic() - started)
                return took
            took = run(go())
        self.assertLess(max(took), 0.5)
        self.assertEqual(data.connects, 1)

    def test_a_peek_never_waits(self):
        # review r2-5 (2026-11-03): the result cache fingerprints every Gold read with the week, the reads of no round
        # too, so it peeks: no week yet, the read starts behind it and the peek says so at once; read, the kept week
        with hub(HubData(week_row(OCT5))) as data:
            async def go():
                with self.assertRaises(service_week.ServiceWeekUnavailable):
                    service_week.peek()
                await service_week._refresh
                return service_week.peek(), service_week.peek()
            weeks = run(go())
        self.assertEqual([w.start for w in weeks], [OCT5] * 2)
        self.assertEqual(data.reads, 1)
        with hub(None):
            self.assertIsNone(service_week.peek())

    def test_one_read_for_callers_at_the_same_time(self):
        with hub(HubData(week_row(OCT5))) as data:
            async def go():
                return await asyncio.gather(*(service_week.current() for _ in range(5)))
            weeks = run(go())
        self.assertEqual({w.seq for w in weeks}, {1})
        self.assertEqual(data.reads, 1)

    def test_a_failed_read_is_not_tried_again_at_once(self):
        # a data DB that is down is asked once per pause, not once per request
        with hub(HubData(refuse=ConnectionRefusedError(61, "Connect call failed"))) as data:
            async def go():
                for _ in range(3):
                    with self.assertRaises(service_week.ServiceWeekUnavailable):
                        await service_week.current()
            run(go())
        self.assertEqual(data.connects, 1)

    def test_a_failed_read_is_tried_again_after_the_pause(self):
        with hub(HubData(refuse=ConnectionRefusedError(61, "Connect call failed"))) as data, \
                mock.patch.object(service_week, "RETRY_S", 0):
            async def go():
                with self.assertRaises(service_week.ServiceWeekUnavailable):
                    await service_week.current()
                data.refuse, data.row = None, week_row(OCT5)
                return await service_week.current()
            week = run(go())
        self.assertEqual(week.start, OCT5)
        self.assertEqual(data.connects, 2)

    def test_a_week_moved_to_moments_ago_is_just_moved(self):
        # review r1-16 (2026-11-03): the reads of one page reach the BFF as separate requests (the shell's week, the
        # body's screens), so a page read as the kept week moves can hold two weeks. For JUST_MOVED_S after a move the
        # week moved to says so (the shell then re-reads its page once); the first read of a process moves nothing
        with hub(HubData(week_row(OCT5))) as data, mock.patch.object(service_week, "CACHE_S", 0):
            async def go():
                first = await service_week.current()
                cold = service_week.just_moved(first)
                data.row = week_row(OCT5 + timedelta(days=7), seq=2)
                await service_week.current()
                await service_week._refresh
                moved = await service_week.current()
                return cold, service_week.just_moved(moved), service_week.just_moved(first)
            self.assertEqual(run(go()), (False, True, False))

    def test_just_moved_lasts_a_moment(self):
        with hub(HubData(week_row(OCT5))) as data, mock.patch.object(service_week, "CACHE_S", 0), \
                mock.patch.object(service_week, "JUST_MOVED_S", 0):
            async def go():
                await service_week.current()
                data.row = week_row(OCT5 + timedelta(days=7), seq=2)
                await service_week.current()
                await service_week._refresh
                return service_week.just_moved(await service_week.current())
            self.assertFalse(run(go()))

    def test_a_week_recorded_again_has_not_moved(self):
        # the job records the same week again when Gold republishes its cycles: the screens' last day is the same
        with hub(HubData(week_row(OCT5))) as data, mock.patch.object(service_week, "CACHE_S", 0):
            async def go():
                await service_week.current()
                data.row = week_row(OCT5, seq=2)
                await service_week.current()
                await service_week._refresh
                week = await service_week.current()
                return week.seq, service_week.just_moved(week)
            self.assertEqual(run(go()), (2, False))

    def test_the_shells_read_reads_the_week_again(self):
        # review r5-2 (2026-11-03): the shell's read of the week (shared/service-week) holds none of Gold's connections,
        # so it reads the week again before it answers while the reads keep the kept week at once; the screens read
        # after it take its week (a Gold read reads it again only CACHE_S after), and the move it found is one
        with hub(HubData(week_row(OCT5))) as data:
            async def go():
                await service_week.current()
                data.row = week_row(OCT5 + timedelta(days=7), seq=2)
                held = await service_week.current()          # not due: the kept week, nothing read
                shell = await service_week.fresh()
                return held, shell, service_week.just_moved(shell), await service_week.current()
            held, shell, moved, after = run(go())
        self.assertEqual([held.seq, shell.seq, after.seq], [1, 2, 2])
        self.assertTrue(moved)
        self.assertEqual(data.reads, 2)

    def test_the_shells_read_waits_for_the_read_in_flight(self):
        # a screen's read started the read again (the kept week due): the shell's read waits for that one, starts no
        # other, and answers what it found
        with hub(HubData(week_row(OCT5))) as data, mock.patch.object(service_week, "CACHE_S", 0):
            async def go():
                await service_week.current()
                data.row, data.gate = week_row(OCT5 + timedelta(days=7), seq=2), asyncio.Event()
                held = await service_week.current()          # due: the kept week at once, the read again behind it
                shell = asyncio.ensure_future(service_week.fresh())
                await asyncio.sleep(0.01)
                data.gate.set()
                return held, await shell
            held, shell = run(go())
        self.assertEqual((held.seq, shell.seq), (1, 2))
        self.assertEqual(data.reads, 2)

    def test_the_shells_read_waits_bounded(self):
        # as a first read does (review r1-5): a server that stopped answering is waited on for READ_TIMEOUT_S, then the
        # kept week is the answer; the read still unwinding is waited on again, not started again; with no week at all
        # it is ServiceWeekUnavailable (the shell's 503)
        with hub(HubData(week_row(OCT5))) as data, mock.patch.object(service_week, "READ_TIMEOUT_S", 0.05):
            async def go():
                await service_week.current()
                data.stall = 1.0
                took = []
                for _ in range(2):
                    started = time.monotonic()
                    week = await service_week.fresh()
                    took.append(time.monotonic() - started)
                return week, took
            week, took = run(go())
        self.assertEqual(week.start, OCT5)
        self.assertLess(max(took), 0.5)
        self.assertEqual(data.connects, 2)
        with hub(HubData(hang=True)), mock.patch.object(service_week, "READ_TIMEOUT_S", 0.05):
            started = time.monotonic()
            with self.assertRaises(service_week.ServiceWeekUnavailable):
                run(service_week.fresh())
        self.assertLess(time.monotonic() - started, 1)

    def test_the_shells_read_after_a_failed_read(self):
        # a data DB that is down is asked once per pause by the shell's reads too: until RETRY_S has passed, the kept
        # week at once (or none: ServiceWeekUnavailable), then a read again
        refused = ConnectionRefusedError(61, "Connect call failed")
        with hub(HubData(refuse=refused)) as data:
            async def go():
                for _ in range(2):
                    with self.assertRaises(service_week.ServiceWeekUnavailable):
                        await service_week.fresh()
            run(go())
        self.assertEqual(data.connects, 1)
        with hub(HubData(week_row(OCT5))) as data:
            async def go():
                await service_week.current()
                data.refuse = refused
                return [await service_week.fresh() for _ in range(2)]
            weeks = run(go())
        self.assertEqual([w.start for w in weeks], [OCT5] * 2)
        self.assertEqual(data.connects, 2)
        with hub(HubData(refuse=refused)) as data, mock.patch.object(service_week, "RETRY_S", 0):
            async def go():
                with self.assertRaises(service_week.ServiceWeekUnavailable):
                    await service_week.fresh()
                data.refuse, data.row = None, week_row(OCT5)
                return await service_week.fresh()
            week = run(go())
        self.assertEqual(week.start, OCT5)
        self.assertEqual(data.connects, 2)

    def test_503_for_the_reads(self):
        with hub(HubData(row=None)), self.assertRaises(HTTPException) as cm:
            run(service_week.current_or_503())
        self.assertEqual(cm.exception.status_code, 503)
        self.assertIn("서비스 기준 주", cm.exception.detail)
        with hub(None):
            self.assertIsNone(run(service_week.current_or_503()))
        # the shell's read (shared/service-week) alike
        with hub(HubData(row=None)), self.assertRaises(HTTPException) as cm:
            run(service_week.current_or_503(shell=True))
        self.assertEqual(cm.exception.status_code, 503)
        with hub(None):
            self.assertIsNone(run(service_week.current_or_503(shell=True)))
            self.assertIsNone(run(service_week.fresh()))


class Names(unittest.TestCase):
    def test_month_of_the_thursday_and_its_week_of_that_month(self):
        cases = {date(2026, 10, 5): (10, 2), date(2026, 9, 28): (10, 1), date(2026, 10, 12): (10, 3),
                 date(2026, 8, 31): (9, 1), date(2026, 7, 27): (7, 5), date(2026, 6, 29): (7, 1),
                 date(2025, 12, 29): (1, 1), date(2026, 3, 30): (4, 1)}
        for start, expected in cases.items():
            with self.subTest(start=start):
                self.assertEqual(service_week.label(start), expected)

    def test_any_day_names_its_iso_week(self):
        self.assertEqual(service_week.label(date(2026, 10, 11)), (10, 2))

    def test_delay_days(self):
        self.assertEqual(service_week.DELAY_DAYS, 10)
        self.assertEqual(service_week.delay_days(date(2026, 10, 11), date(2026, 11, 2)), 22)
        self.assertEqual(service_week.delay_days(date(2026, 10, 11), date(2026, 10, 21)), 10)

    def test_today_is_the_kst_day(self):
        # Monday 08:30 KST, still Sunday in UTC, on a host in UTC (review r1-6: the fake answered a naive now in the
        # host's zone, so a naive 'today' passed on a Mac in Korea)
        with clock(service_week):
            self.assertEqual(service_week.today(), date(2026, 11, 2))


if __name__ == "__main__":
    unittest.main()
