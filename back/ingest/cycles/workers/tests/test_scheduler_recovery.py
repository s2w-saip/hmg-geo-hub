"""Failure, concurrency and shutdown tests against the production scheduler."""
import asyncio
import datetime as dt

from ingest.worker import Scheduler, Task, run_forever

NOW = dt.datetime(2026, 10, 8, 0, 0, tzinfo=dt.UTC)


async def test_daily_failure_retries_same_day_with_backoff():
    calls = 0

    async def daily(_now):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise RuntimeError("temporarily unavailable")

    scheduler = Scheduler(daily=daily)
    assert await scheduler.step(NOW) == ["daily"]
    assert scheduler.last_daily is None
    assert await scheduler.step(NOW + dt.timedelta(seconds=29)) == []
    assert await scheduler.step(NOW + dt.timedelta(seconds=31)) == ["daily"]
    assert await scheduler.step(NOW + dt.timedelta(seconds=90)) == []
    assert await scheduler.step(NOW + dt.timedelta(seconds=92)) == ["daily"]
    assert scheduler.last_daily == NOW.date()
    assert await scheduler.step(NOW + dt.timedelta(hours=3)) == []
    assert await scheduler.step(NOW + dt.timedelta(days=1)) == ["daily"]


async def test_long_pull_does_not_block_queue_and_never_overlaps_itself():
    entered = asyncio.Event()
    release = asyncio.Event()
    queue_calls = []

    async def pull(_now):
        entered.set()
        await release.wait()

    async def queue(now):
        queue_calls.append(now)

    scheduler = Scheduler(tasks=[Task("pull", dt.timedelta(seconds=20), pull), Task("queue", dt.timedelta(seconds=1), queue)])
    assert scheduler.start_due(NOW) == ["pull", "queue"]
    await entered.wait()
    await asyncio.sleep(0)
    assert scheduler.start_due(NOW + dt.timedelta(seconds=60)) == ["queue"]
    await asyncio.sleep(0)
    assert len(queue_calls) == 2
    release.set()
    await scheduler.close()


async def test_timeout_is_reported_and_other_jobs_complete():
    async def stalled(_now):
        await asyncio.Event().wait()

    async def healthy(_now):
        return

    slow = Task("slow", dt.timedelta(seconds=1), stalled, timeout_s=.01)
    fast = Task("fast", dt.timedelta(seconds=1), healthy)
    scheduler = Scheduler(tasks=[slow, fast])
    await scheduler.step(NOW)
    assert (slow.runs, slow.errors, fast.runs, fast.errors) == (1, 1, 1, 0)


async def test_shutdown_cancels_inflight_work_without_recording_daily_success():
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    stop = asyncio.Event()

    async def daily(_now):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    scheduler = Scheduler(daily=daily)
    runner = asyncio.create_task(run_forever(scheduler, stop, clock=lambda: NOW))
    await entered.wait()
    stop.set()
    await asyncio.wait_for(runner, 1)
    assert cancelled.is_set()
    assert scheduler.last_daily is None
    assert not scheduler._running
