"""Execute unmodified worker functions with controlled clock, I/O and transaction fakes.

No production DB, live HTTP, actual external messages, or service startup.
Run: python -X utf8 reports/부록/verify_worker_risks.py
"""
from __future__ import annotations

import ast
import asyncio
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import logging
import sys
import types
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT / "hmg-geo-hub-share"
SOURCES: dict[str, str] = {}
CHECKS: list[dict[str, Any]] = []
logging.disable(logging.CRITICAL)  # Expected injected failures; no external logging handlers.


def read(name: str) -> str:
    raw = (REPO / name).read_bytes()
    SOURCES[name] = hashlib.sha256(raw).hexdigest()
    return raw.decode("utf-8")


def module(name: str, alias: str, *, keep: set[str] | None = None, injected=None):
    text = read(name)
    tree = ast.parse(text, filename=name)
    if keep is not None:
        nodes = [n for n in tree.body if getattr(n, "name", None) in keep]
        assert {n.name for n in nodes} == keep
        tree = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *nodes], type_ignores=[])
        ast.fix_missing_locations(tree)
    m = types.ModuleType(alias)
    sys.modules[alias] = m
    m.__dict__.update(injected or {})
    exec(compile(tree, name, "exec"), m.__dict__)
    return m


scheduler = module("back/ingest/worker.py", "audit_scheduler")
queries = module("back/ingest/cycles/workers/queries.py", "audit_worker_queries")
contracts = module("back/app/core/contracts.py", "audit_contracts")
dfs_helpers = module("back/ingest/cycles/workers/dfs.py", "audit_dfs_helpers",
                     keep={"legacy_dfs", "plan_calls", "request_for"},
                     injected={"Any": Any, "_LEGACY_FETCH": {"search_volume": "volume", "serp_organic": "insight", "keyword_suggestions": "search"},
                               "_LEGACY_SUBJECT": ("search_volume:", "serp_organic:", "keyword_suggestions:")})
workers = module("back/ingest/cycles/workers/service.py", "audit_workers",
                 keep={"QueueOutcome", "OutboxOutcome", "run_dfs", "run_outbox", "_fill_scope_ids"},
                 injected={"dataclass": dataclass, "dt": dt, "uuid": uuid, "json": json, "q": queries,
                           "log": logging.getLogger("audit"), "parse_change": contracts.parse_change,
                           "parse_outbox": contracts.parse_outbox, "legacy_dfs": dfs_helpers.legacy_dfs,
                           "plan_calls": dfs_helpers.plan_calls, "describe_error": lambda exc: type(exc).__name__})


async def check(id: str, title: str, fn):
    evidence = await fn()
    CHECKS.append(dict(id=id, title=title, status="PASS", evidence=evidence))
    print(f"PASS {id}: {title}")


async def daily_failure():
    calls = []

    async def daily(now):
        calls.append(now.isoformat())
        if len(calls) == 1:
            raise RuntimeError("injected transient daily DB failure")

    s = scheduler.Scheduler(daily=daily)
    now = dt.datetime(2026, 10, 8, 0, 0, tzinfo=dt.timezone.utc)
    await s.step(now)
    marked_after_failure = s.last_daily.isoformat()
    await s.step(now + dt.timedelta(minutes=1))
    await s.step(now + dt.timedelta(hours=1))
    assert len(calls) == 1
    await s.step(now + dt.timedelta(days=1))
    assert len(calls) == 2
    return dict(firstRun="failed", lastDailyAfterFailure=marked_after_failure,
                retriesAtOneMinuteAndOneHour=0, nextDayRan=True, sourceCodeUnmodified=True)


async def serial_scheduler():
    started, release = asyncio.Event(), asyncio.Event()
    calls = []
    now = dt.datetime(2026, 10, 8, 0, 0, tzinfo=dt.timezone.utc)

    async def queue(at):
        calls.append(("queue", at.isoformat()))

    async def pull(at):
        calls.append(("pull-start", at.isoformat()))
        started.set()
        await release.wait()
        calls.append(("pull-end", at.isoformat()))

    async def tick(at):
        calls.append(("tick", at.isoformat()))

    s = scheduler.Scheduler(tasks=[scheduler.Task("queue", dt.timedelta(seconds=60), queue),
                                  scheduler.Task("pull", dt.timedelta(minutes=20), pull),
                                  scheduler.Task("cycles_tick", dt.timedelta(minutes=20), tick)])
    task = asyncio.create_task(s.step(now))
    await started.wait()
    assert not task.done()
    assert [name for name, _ in calls] == ["queue", "pull-start"]
    queue_due = s.tasks[0].next_at
    # Simulated clock advance; do not spend 15 minutes sleeping.
    later = now + dt.timedelta(seconds=900)
    assert queue_due < later
    blocked_calls = list(calls)
    release.set()
    await task
    await s.step(later)
    assert sum(name == "queue" for name, _ in calls) == 2
    return dict(callsWhilePullBlocked=blocked_calls, configuredQueueEverySeconds=60,
                simulatedPullDurationSeconds=900, secondQueueOnlyAfterPullReturns=True,
                actualElapsedLatencyMeasured=False)


class MemoryDB:
    """Small fake modeling the SQL operations reached by these source functions.

    Transaction snapshots model commit/rollback. This is not PostgreSQL execution.
    """
    def __init__(self, row, *, kind):
        self.row = row
        self.kind = kind
        self.events = []
        self.scope_id = None

    @asynccontextmanager
    async def session(self):
        yield self

    @asynccontextmanager
    async def tx(self, conn):
        snapshot = copy.deepcopy(self.row), self.scope_id
        try:
            yield
        except BaseException:
            self.row, self.scope_id = snapshot
            self.events.append("rollback")
            raise
        else:
            self.events.append("commit")

    async def fetchrow(self, sql, *args):
        assert sql == queries.CLAIM
        assert "WHERE status = 'pending'" in sql
        return copy.deepcopy(self.row) if self.row["status"] == "pending" else None

    async def fetch(self, sql, *args):
        assert sql == queries.OUTBOX_CLAIM
        return [copy.deepcopy(self.row)] if not self.row.get("done") else []

    async def fetchval(self, sql, *args):
        assert sql == queries.PROJECT_SCOPE_ID
        return self.scope_id

    async def execute(self, sql, *args):
        if sql == queries.RUNNING:
            self.row["status"] = "running"
        elif sql == queries.FAILED:
            self.row["status"] = "failed"
        elif sql == queries.SYSTEM_ACTOR:
            pass
        elif sql == queries.SET_PROJECT_SCOPE:
            self.scope_id = str(args[1])
        elif sql == queries.OUTBOX_DONE:
            self.row["done"] = True
        elif sql == queries.OUTBOX_FAIL:
            self.row["failed"] = True
        else:
            raise AssertionError(f"Unexpected mock SQL: {sql[:70]}")
        self.events.append(sql.strip().splitlines()[0])


async def dfs_interruption():
    db = MemoryDB(dict(change_id=42, kind="dfs_fetch", status="pending", subject_texts=["fixture"],
                       payload={"fetch": "volume", "terms": ["fixture"], "location_code": 2840, "language_code": "en"},
                       requested_by=None), kind="dfs")

    class InterruptedDfs:
        calls = 0

        async def call(self, endpoint, request):
            self.calls += 1
            assert db.row["status"] == "running" and "commit" in db.events
            raise asyncio.CancelledError("injected task interruption after claim commit")

    dfs = InterruptedDfs()
    try:
        await workers.run_dfs(db, dfs)
        raise AssertionError("Expected cancellation")
    except asyncio.CancelledError:
        pass
    assert db.row["status"] == "running"
    retry = await workers.run_dfs(db, dfs)
    assert retry == [] and dfs.calls == 1
    watch = ast.parse(read("back/ingest/cycles/watch/service.py"))
    queue_sql = next(ast.literal_eval(n.value) for n in watch.body if isinstance(n, ast.Assign)
                     and any(isinstance(t, ast.Name) and t.id == "QUEUE" for t in n.targets))
    assert "WHERE status IN ('failed', 'escalated_rebuild', 'pending')" in queue_sql
    assert "running" not in queue_sql
    return dict(statusAfterCancellation=db.row["status"], subsequentWorkerSelectedRows=len(retry),
                externalCallAttempts=dfs.calls, queueWatchQueryIncludesRunning=False,
                transactionEvidence=db.events, realDatabaseUsed=False)


async def outbox_missing_id():
    actor = uuid.UUID("00000000-0000-4000-8000-000000000001")
    project_id = uuid.UUID("00000000-0000-4000-8000-000000000002")
    db = MemoryDB(dict(outbox_id=77, aggregate="project", aggregate_id=project_id, op="create",
                       payload={"project_id": str(project_id)}, attempts=0, done=False), kind="outbox")

    class MissingIdSource:
        calls = 0

        async def write(self, *args):
            self.calls += 1
            return {}  # A successful HTTP JSON response without the required generated ID.

    source = MissingIdSource()
    result = await workers.run_outbox(db, source, system_actor=actor)
    assert result[0].status == "done"
    assert db.row["done"] and db.scope_id is None
    second = await workers.run_outbox(db, source, system_actor=actor)
    assert second == [] and source.calls == 1
    return dict(response={}, outcome=result[0].status, localScopeId=db.scope_id, markedDone=db.row["done"],
                nextRunPicked=len(second), outgoingCalls=source.calls, realDatabaseUsed=False)


async def main():
    await check("R12", "일일 작업: 실패해도 당일 완료로 기록하여 같은 날 재시도하지 않음", daily_failure)
    await check("R13", "60초 큐 작업: 긴 pull이 끝날 때까지 다음 실행과 회차 처리가 막힘", serial_scheduler)
    await check("R14", "DataForSEO 작업: claim 커밋 뒤 중단되면 running에 남고 다음 소비에서 제외", dfs_interruption)
    await check("R15", "Scope 생성 응답: ID가 없어도 outbox done 처리", outbox_missing_id)
    output = dict(createdAt=dt.datetime.now(dt.timezone.utc).isoformat(), pythonVersion=sys.version.split()[0],
                  method="Unmodified Python worker functions/AST plus actual request contracts; mock DB transactions and external I/O, simulated scheduler clock. Not PostgreSQL integration, ECS shutdown, or production testing.",
                  summary=dict(total=len(CHECKS), passed=len(CHECKS)), checks=CHECKS, sourceSha256=SOURCES)
    path = ROOT / "reports/부록/GEO 백그라운드 작업 점검 재현.json"
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(CHECKS)} passing reproductions.")


if __name__ == "__main__":
    asyncio.run(main())
