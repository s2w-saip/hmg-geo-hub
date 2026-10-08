"""워커 프로세스 진입점: python -m ingest.worker (loader 롤 직접 연결, ECS 서비스 1개).

루프(모듈-적재-파이프라인.md §2)
  pull         20분   ingest.pull.sync.run_pass(프로젝트 로테이션 1개씩, 패스 예산 15분)
  queue        60초   judgment_change 소비(IG-2 재판정·IG-3 운영 요청) + dfs_fetch 빠른 경로 + 아웃박스 드레인
  cycles_tick  20분   시간 기반 회차 판정(R01·R08·노출일), 하루 1회(KST 날짜가 바뀐 첫 틱) 파티션 선생성
감시(watch)는 이 프로세스가 아니라 별도 스케줄(python -m ingest.cli watch, 6시간)이다(워커가 죽어도 감시는 돈다).

Scheduler.step(now) 가 한 틱이다: 기한이 된 작업만 돌리고 다음 기한을 잡는다(로컬에서 한 틱씩 시험 가능, 시계 주입).
작업 하나의 예외는 기록하고 다른 작업을 막지 않는다.
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import logging
import signal
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("hgh.ingest.worker")

Job = Callable[[dt.datetime], Awaitable[Any]]


@dataclass
class Task:
    name: str
    every: dt.timedelta
    fn: Job
    next_at: dt.datetime | None = None
    runs: int = 0
    errors: int = 0
    last_error: str | None = None
    timeout_s: float = 1800


@dataclass
class Scheduler:
    tasks: list[Task] = field(default_factory=list)
    daily: Job | None = None
    last_daily: dt.date | None = None
    daily_retry_at: dt.datetime | None = None
    daily_errors: int = 0
    _running: dict[str, asyncio.Task] = field(default_factory=dict, init=False, repr=False)

    async def step(self, now: dt.datetime) -> list[str]:
        """시험·단발 실행: 기한이 된 작업을 동시에 시작하고 이번 틱의 완료를 기다린다."""
        ran = self.start_due(now)
        await asyncio.gather(*(self._running[name] for name in ran))
        return ran

    def start_due(self, now: dt.datetime) -> list[str]:
        """실행 루프는 완료를 기다리지 않는다. 같은 작업은 한 번에 하나만 실행한다."""
        ran: list[str] = []
        kst_day = (now + dt.timedelta(hours=9)).date()
        if (self.daily is not None and self.last_daily != kst_day and not self._busy("daily")
                and (self.daily_retry_at is None or now >= self.daily_retry_at)):
            self._running["daily"] = asyncio.create_task(self._daily(now, kst_day), name="ingest-daily")
            ran.append("daily")
        for t in self.tasks:
            if not self._busy(t.name) and (t.next_at is None or now >= t.next_at):
                t.next_at = now + t.every
                self._running[t.name] = asyncio.create_task(self._periodic(t, now), name=f"ingest-{t.name}")
                ran.append(t.name)
        return ran

    def _busy(self, name: str) -> bool:
        task = self._running.get(name)
        return task is not None and not task.done()

    async def _daily(self, now: dt.datetime, day: dt.date) -> None:
        started = asyncio.get_running_loop().time()
        if await self._run("daily", self.daily, now, 300):
            self.last_daily = day
            self.daily_errors = 0
            self.daily_retry_at = None
        else:
            self.daily_errors += 1
            delay = min(30 * 2 ** min(self.daily_errors - 1, 5), 900)
            elapsed = asyncio.get_running_loop().time() - started
            self.daily_retry_at = now + dt.timedelta(seconds=elapsed + delay)

    async def _periodic(self, task: Task, now: dt.datetime) -> None:
        ok = await self._run(task.name, task.fn, now, task.timeout_s)
        task.runs += 1
        if not ok:
            task.errors += 1
        else:
            task.last_error = None

    async def close(self) -> None:
        for task in self._running.values():
            task.cancel()
        await asyncio.gather(*self._running.values(), return_exceptions=True)
        self._running.clear()

    async def _run(self, name: str, fn: Job, now: dt.datetime, timeout_s: float) -> bool:
        try:
            async with asyncio.timeout(timeout_s):
                await fn(now)
            return True
        except Exception as e:  # noqa: BLE001  한 작업의 실패가 루프를 멈추지 않는다
            log.exception("워커 작업 %s 실패", name)
            for t in self.tasks:
                if t.name == name:
                    t.last_error = str(e)[:500]
            return False

    def next_due(self, now: dt.datetime) -> dt.datetime:
        dues = [t.next_at for t in self.tasks if t.next_at is not None and not self._busy(t.name)]
        if self.daily_retry_at is not None and not self._busy("daily"):
            dues.append(self.daily_retry_at)
        return min(dues) if dues else now


def build_scheduler(db: Any, source: Any, dfs: Any | None) -> Scheduler:
    from ingest.cycles.workers.service import cycles_tick, run_dfs, run_outbox, run_queue
    from ingest.pull.sync.service import run_pass

    tick_lock = asyncio.Lock()

    async def pull(now: dt.datetime) -> None:
        await run_pass(db, source, now=now)

    async def queue(now: dt.datetime) -> None:
        await run_queue(db)
        if dfs is not None:
            await run_dfs(db, dfs, now=now)
        await run_outbox(db, source, now=now)

    async def tick(now: dt.datetime) -> None:
        async with tick_lock:
            await cycles_tick(db, now=now)

    async def daily(now: dt.datetime) -> None:
        async with tick_lock:
            await cycles_tick(db, now=now, daily=True)

    return Scheduler(tasks=[Task("queue", dt.timedelta(seconds=60), queue), Task("pull", dt.timedelta(minutes=20), pull),
                            Task("cycles_tick", dt.timedelta(minutes=20), tick)], daily=daily)


async def run_forever(sched: Scheduler, stop: asyncio.Event, *, clock: Callable[[], dt.datetime] | None = None) -> None:
    clock = clock or (lambda: dt.datetime.now(dt.UTC))
    try:
        while not stop.is_set():
            sched.start_due(clock())
            wait = max(1.0, (sched.next_due(clock()) - clock()).total_seconds())
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=min(wait, 1.0))
    finally:
        await sched.close()


async def _main() -> None:
    from ingest.common.config import get_ingest_settings, install_worker_settings
    from ingest.common.db import LoaderDB
    from ingest.cycles.workers.dfs import HttpDfsSource
    from ingest.pull.sync.source import source_from_settings

    install_worker_settings()
    s = get_ingest_settings()
    log.info("워커 기동 %s", s)
    db = LoaderDB.from_settings(s)
    source = source_from_settings()
    dfs = None
    if s.dfs_api_url and s.dfs_login and s.dfs_password:
        dfs = HttpDfsSource(s.dfs_api_url, s.dfs_login.get_secret_value(), s.dfs_password.get_secret_value())
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await run_forever(build_scheduler(db, source, dfs), stop)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    asyncio.run(_main())
