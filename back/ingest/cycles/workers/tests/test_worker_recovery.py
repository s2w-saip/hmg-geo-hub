"""Real PostgreSQL regression tests: ambiguous writes must not become success or automatic retries."""
import asyncio
import datetime as dt
import uuid

import httpx
import pytest

from ingest.common.db import LoaderDB
from ingest.cycles.watch.service import QUEUE
from ingest.cycles.workers import service
from ingest.cycles.workers.dfs import FakeDfsSource
from ingest.cycles.workers.tests.test_workers import ACTOR, _app, _q
from ingest.pull.sync.source import HttpScopeSource, ScopeError
from tests.support import needs_db


async def project_outbox(url):
    pid = uuid.uuid4()
    await _app(url, "UPDATE app.scope_outbox SET done_at = now() WHERE done_at IS NULL")
    await _app(url, "INSERT INTO app.project (project_id, kind, name, country_code, created_by) VALUES ($1, 'customer', 'test', 'US', app.actor())", pid)
    await _app(url, """INSERT INTO app.scope_outbox (aggregate, aggregate_id, op, payload)
      VALUES ('project', $1::uuid, 'create', jsonb_build_object('project_id', $1::uuid::text, 'body', jsonb_build_object('name', 'test')))""", pid)
    return pid


@needs_db
@pytest.mark.parametrize("response", [None, {}, {"project_id": "invalid"}, {"project_id": str(uuid.UUID(int=0))}])
async def test_missing_create_id_stays_failed_without_automatic_duplicate(fresh_db, response):
    pid = await project_outbox(fresh_db)

    class Source:
        calls = 0

        async def write(self, *_args):
            self.calls += 1
            return response

    source = Source()
    db = LoaderDB(fresh_db, role="loader")
    first = await service.run_outbox(db, source, system_actor=uuid.UUID(ACTOR))
    assert [r.status for r in first] == ["failed"]
    assert "scope_outcome_unknown" in first[0].error
    assert (await _q(fresh_db, "SELECT scope_project_id FROM app.project WHERE project_id=$1", pid))[0][0] is None
    assert (await _q(fresh_db, "SELECT done_at FROM app.scope_outbox WHERE aggregate_id=$1", pid))[0][0] is None
    assert await service.run_outbox(db, source, system_actor=uuid.UUID(ACTOR), now=dt.datetime.now(dt.UTC) + dt.timedelta(days=2)) == []
    assert source.calls == 1


@needs_db
async def test_create_cancellation_is_durably_marked_before_dispatch(fresh_db):
    pid = await project_outbox(fresh_db)

    class Source:
        async def write(self, *_args):
            raise asyncio.CancelledError

    db = LoaderDB(fresh_db, role="loader")
    with pytest.raises(asyncio.CancelledError):
        await service.run_outbox(db, Source(), system_actor=uuid.UUID(ACTOR))
    row = (await _q(fresh_db, "SELECT done_at, last_error FROM app.scope_outbox WHERE aggregate_id=$1", pid))[0]
    assert row["done_at"] is None and row["last_error"].startswith("scope_outcome_unknown:")
    assert await service.run_outbox(db, Source(), system_actor=uuid.UUID(ACTOR), now=dt.datetime.now(dt.UTC) + dt.timedelta(days=2)) == []


@needs_db
async def test_missing_actor_prevents_remote_creation(fresh_db, monkeypatch):
    await project_outbox(fresh_db)
    from types import SimpleNamespace
    monkeypatch.setattr(service, "get_ingest_settings", lambda: SimpleNamespace(system_actor=None))

    class Source:
        async def write(self, *_args):
            pytest.fail("must validate actor before remote create")

    result = await service.run_outbox(LoaderDB(fresh_db, role="loader"), Source())
    assert [r.status for r in result] == ["failed"]
    assert "HGH_INGEST_SYSTEM_ACTOR" in result[0].error


async def enqueue_dfs(url):
    await _app(url, """INSERT INTO app.judgment_change (kind, subject_texts, payload, requested_by)
      VALUES ('dfs_fetch', ARRAY['recovery test'], '{"fetch":"volume","terms":["recovery test"],"location_code":2840,"language_code":"en"}', app.actor())""")
    return (await _q(url, "SELECT change_id FROM app.judgment_change WHERE kind='dfs_fetch' ORDER BY change_id DESC LIMIT 1"))[0][0]


@needs_db
async def test_crashed_dfs_is_visible_to_watch_and_recovers_without_paid_retry(fresh_db):
    cid = await enqueue_dfs(fresh_db)
    await _app(fresh_db, "UPDATE app.judgment_change SET status='running', claimed_at=now()-interval '16 minutes', requested_at=now()-interval '2 days' WHERE change_id=$1", cid)
    before = (await _q(fresh_db, QUEUE, dt.datetime.now(dt.UTC)))[0]
    assert before["stale"] >= 1
    source = FakeDfsSource()
    result = await service.run_dfs(LoaderDB(fresh_db, role="loader"), source)
    assert any(r.change_id == cid and r.status == "failed" for r in result)
    assert source.calls == []
    after = (await _q(fresh_db, QUEUE, dt.datetime.now(dt.UTC)))[0]
    assert after["bad"] >= 1
    assert (await _q(fresh_db, "SELECT status, error FROM app.judgment_change WHERE change_id=$1", cid))[0]["error"].startswith("dfs_outcome_unknown:")


@needs_db
async def test_expired_owner_cannot_write_data_or_overwrite_new_status(fresh_db):
    cid = await enqueue_dfs(fresh_db)

    class Source:
        async def call(self, *_args):
            await _app(fresh_db, "UPDATE app.judgment_change SET status='failed', error='dfs_outcome_unknown: recovered' WHERE change_id=$1", cid)
            return 200, {"status_code": 20000, "tasks": []}, None

    result = await service.run_dfs(LoaderDB(fresh_db, role="loader"), Source())
    assert result[0].status == "failed"
    assert (await _q(fresh_db, "SELECT error FROM app.judgment_change WHERE change_id=$1", cid))[0][0] == "dfs_outcome_unknown: recovered"
    assert (await _q(fresh_db, "SELECT count(*) FROM ext.dfs_call"))[0][0] == 0


@needs_db
async def test_dfs_timeout_leaves_failed_not_running(fresh_db, monkeypatch):
    cid = await enqueue_dfs(fresh_db)
    monkeypatch.setattr(service, "DFS_TIMEOUT_S", .01)

    class Source:
        async def call(self, *_args):
            await asyncio.Event().wait()

    await service.run_dfs(LoaderDB(fresh_db, role="loader"), Source())
    assert (await _q(fresh_db, "SELECT status FROM app.judgment_change WHERE change_id=$1", cid))[0][0] == "failed"
    assert (await _q(fresh_db, "SELECT error FROM app.judgment_change WHERE change_id=$1", cid))[0][0].startswith("dfs_outcome_unknown:")


async def test_scope_post_503_is_not_retried_by_transport():
    calls = []

    async def reply(request):
        calls.append(request)
        return httpx.Response(503, json={"error": {"code": "unavailable"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(reply)) as client:
        source = HttpScopeSource("https://scope.example", "test-only", client=client)
        with pytest.raises(ScopeError):
            await source.write("project", "create", str(uuid.uuid4()), {"name": "test"})
    assert len(calls) == 1
