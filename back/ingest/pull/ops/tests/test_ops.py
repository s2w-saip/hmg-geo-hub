"""ingest.pull.ops(GET /v1/admin/ingest/status·backlog·loads) 테스트.

앱은 일회 DB(fresh_db)를 보게 바꾼다(원장 행을 커밋해야 API 커넥션이 본다). 기대값은 구현이 읽는 rd.v_ingest_* 뷰가 아니라
ing 원장 표를 직접 세는 독립 SQL 과 손계산으로 만든다.
"""
from __future__ import annotations

import contextlib
import datetime as dt

import asyncpg
import pytest_asyncio

from app.core import db as db_mod
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

STATUS = "/v1/admin/ingest/status"
BACKLOG = "/v1/admin/ingest/backlog"
LOADS = "/v1/admin/ingest/loads"
NOW = dt.datetime.now(dt.UTC)

SETUP = """
UPDATE ing.run SET unresolved_jobs = 2, recheck_until = now() - interval '1 day' WHERE run_id = 'e0000000-0000-4000-8000-000000000001';
UPDATE ing.run SET sync_state = 'blocked', attempts = 5, last_error = 'x' WHERE run_id = 'e0000000-0000-4000-8000-000000000002';
UPDATE ing.run SET analysis_pending = 1, analysis_recheck_until = now() - interval '1 hour' WHERE run_id = 'e0000000-0000-4000-8000-000000000003';
UPDATE ing.run SET unresolved_jobs = 1, recheck_until = now() + interval '2 days' WHERE run_id = 'e0000000-0000-4000-8000-000000000005';
INSERT INTO ing.load (kind, rule_ver, status, started_at, jobs_fetched) VALUES
  ('run', 1, 'committed', '2026-09-20 00:00+00', 10), ('recheck', 1, 'committed', '2026-09-21 00:00+00', 3),
  ('judgment', 1, 'failed', '2026-09-22 00:00+00', NULL), ('run', 1, 'failed', '2026-09-23 00:00+00', 1),
  ('run', 1, 'committed', '2026-09-24 00:00+00', 7);
"""


@pytest_asyncio.fixture(loop_scope="session")
async def ops_db(fresh_db, settings, database):
    """앱 DB 를 일회 DB 로 바꾼 뒤 원장 행을 준비한다(끝나면 원래 설정으로)."""
    c = await asyncpg.connect(fresh_db)
    try:
        await c.execute(SETUP)
    finally:
        await c.close()
    from pydantic import SecretStr
    s = settings.model_copy(update={"db_url": SecretStr(fresh_db)})
    await db_mod.close_db()
    db_mod.init_db(s)
    yield fresh_db
    await db_mod.close_db()
    db_mod.init_db(settings)


async def _one(url: str, sql: str, *args):
    c = await asyncpg.connect(url)
    try:
        return await c.fetch(sql, *args)
    finally:
        await c.close()


@contextlib.asynccontextmanager
async def _as(client_as, uid):
    async with client_as(uid) as c:
        yield c


@needs_db
async def test_status_shape_and_values(ops_db, client_as):
    exp = await _one(ops_db, """SELECT c.scope_project_id, c.surface,
        (SELECT count(*) FROM ing.run r WHERE r.scope_project_id = c.scope_project_id AND (r.unresolved_jobs > 0 OR r.analysis_pending > 0)) AS o,
        (SELECT count(*) FROM ing.run r WHERE r.scope_project_id = c.scope_project_id AND r.sync_state = 'blocked') AS b
        FROM ing.sync_cursor c ORDER BY c.surface, c.scope_project_id""")
    async with client_as(ADMIN) as c:
        r = await c.get(STATUS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["mode"] == "admin" and body["meta"]["ignored_filters"] == []
    got = [(i["scope_project_id"], i["surface"], i["open_runs"], i["blocked_runs"]) for i in body["data"]["items"]]
    assert got == [(str(e[0]), e[1], e[2], e[3]) for e in exp]
    # 손계산: 루트(global) run 1·3·5 미해소/분석 대기 → 3, run 2 blocked → 1
    root = next(i for i in body["data"]["items"] if i["surface"] == "global")
    assert (root["open_runs"], root["blocked_runs"]) == (3, 1)
    assert set(root) >= {"last_attempt_at", "last_success_at", "last_error", "prompts_updated_to", "regions"}


@needs_db
async def test_status_surface_filter_and_ignored_common_filters(ops_db, client_as):
    async with client_as(ADMIN) as c:
        a = await c.get(STATUS, params={"surface": "website"})
        b = await c.get(STATUS, params={"brand": "Kia", "country": "US", "from": "2026-09-01", "to": "2026-09-30", "cf.00000000-0000-0000-0000-000000000000": "x"})
        e = await c.get(STATUS, params={"surface": "nope"})
    assert [i["surface"] for i in a.json()["data"]["items"]] == ["website"]
    assert a.json()["meta"]["surface"] == "website"
    assert len(b.json()["data"]["items"]) == 3                                    # 무시된 필터는 결과를 바꾸지 않는다
    assert b.json()["meta"]["ignored_filters"] == ["brand", "country", "custom", "period"]
    assert e.status_code == 422


@needs_db
async def test_non_admin_denied_and_unauthenticated(ops_db, client_as):
    for uid in (HQ_HYUNDAI, KIA_US, VENDOR, KIA_EU):
        async with client_as(uid) as c:
            for path in (STATUS, BACKLOG, LOADS):
                r = await c.get(path)
                assert r.status_code == 403, (uid, path, r.text)
                assert r.json()["error"]["code"] == "admin_only"
                assert "data" not in r.json()                                    # 누출 0
    async with client_as(SUSPENDED) as c:
        assert (await c.get(STATUS)).status_code == 401
    async with client_as(None) as c:
        assert (await c.get(LOADS)).status_code == 401


@needs_db
async def test_backlog_values_pagination_and_empty(ops_db, client_as):
    exp = await _one(ops_db, """SELECT run_id FROM ing.run
        WHERE sync_state = 'blocked' OR (unresolved_jobs > 0 AND recheck_until <= now()) OR (analysis_pending > 0 AND analysis_recheck_until <= now())
        ORDER BY coalesce(started_at, '1970-01-01'::timestamptz), run_id""")
    assert len(exp) == 3                                                        # run 5 는 창이 열려 있어 제외
    async with client_as(ADMIN) as c:
        full = await c.get(BACKLOG)
        p1 = await c.get(BACKLOG, params={"limit": 2})
        cur = p1.json()["meta"]["page"]["next_cursor"]
        p2 = await c.get(BACKLOG, params={"limit": 2, "cursor": cur})
        other = await c.get(BACKLOG, params={"limit": 2, "cursor": cur, "surface": "global"})
        empty = await c.get(BACKLOG, params={"surface": "project"})
        bad_cur = await c.get(BACKLOG, params={"cursor": "not-a-cursor"})
        bad_lim = await c.get(BACKLOG, params={"limit": 0})
        big_lim = await c.get(BACKLOG, params={"limit": 201})
    ids = [i["run_id"] for i in full.json()["data"]["items"]]
    assert ids == [str(e[0]) for e in exp]
    assert [i["run_id"] for i in p1.json()["data"]["items"] + p2.json()["data"]["items"]] == ids
    assert p2.json()["meta"]["page"]["next_cursor"] is None
    assert other.status_code == 422 and other.json()["error"]["code"] == "cursor_invalid"   # 다른 필터로 커서 재사용 금지
    assert empty.status_code == 200 and empty.json()["data"]["items"] == []
    assert bad_cur.status_code == 422 and bad_lim.status_code == 422 and big_lim.status_code == 422
    blocked = next(i for i in full.json()["data"]["items"] if i["sync_state"] == "blocked")
    assert blocked["attempts"] == 5 and blocked["surface"] == "global"


@needs_db
async def test_loads_filters_pagination_and_validation(ops_db, client_as):
    all_ids = [r[0] for r in await _one(ops_db, "SELECT load_id FROM ing.load ORDER BY load_id DESC")]
    failed_runs = [r[0] for r in await _one(ops_db, "SELECT load_id FROM ing.load WHERE kind = 'run' AND status = 'failed' ORDER BY load_id DESC")]
    in_range = [r[0] for r in await _one(ops_db, """SELECT load_id FROM ing.load WHERE started_at >= '2026-09-21' AND started_at <= '2026-09-23 12:00+00'
                                                    ORDER BY load_id DESC""")]
    async with client_as(ADMIN) as c:
        full = await c.get(LOADS, params={"limit": 200})
        f = await c.get(LOADS, params={"kind": "run", "status": "failed", "surface": "global"})
        rng = await c.get(LOADS, params={"started_from": "2026-09-21T00:00:00Z", "started_to": "2026-09-23T12:00:00Z"})
        pages, cur = [], None
        for _ in range(10):
            r = await c.get(LOADS, params={"limit": 3, **({"cursor": cur} if cur else {})})
            pages += [i["load_id"] for i in r.json()["data"]["items"]]
            cur = r.json()["meta"]["page"]["next_cursor"]
            if not cur:
                break
        bad_kind = await c.get(LOADS, params={"kind": "nope"})
        bad_rng = await c.get(LOADS, params={"started_from": "2026-09-25T00:00:00Z", "started_to": "2026-09-20T00:00:00Z"})
        none = await c.get(LOADS, params={"kind": "ga4"})
    assert [i["load_id"] for i in full.json()["data"]["items"]] == all_ids
    assert [i["load_id"] for i in f.json()["data"]["items"]] == failed_runs and len(failed_runs) == 1
    assert f.json()["meta"]["ignored_filters"] == ["surface"]
    assert [i["load_id"] for i in rng.json()["data"]["items"]] == in_range and len(in_range) == 3
    assert pages == all_ids
    assert bad_kind.status_code == 422 and bad_rng.status_code == 422
    assert none.status_code == 200 and none.json()["data"]["items"] == []


@needs_db
async def test_ops_queries_explain(ops_db):
    """api_ro 로 운영 조회 뷰 계획이 돈다(로컬 합성 DB. 원장 소형이라 순차 스캔이 정상, 10배 판정은 stg 실측 게이트)."""
    from ingest.pull.ops import queries as qs
    c = await asyncpg.connect(ops_db)
    try:
        async with c.transaction():
            await c.execute("SET LOCAL ROLE api_ro")
            for sql in (qs.STATUS.format(where="true"), qs.BACKLOG.format(where="true", limit=51), qs.LOADS.format(where="true", limit=51)):
                plan = "\n".join(r[0] for r in await c.fetch("EXPLAIN (ANALYZE, COSTS OFF) " + sql))
                assert "Execution Time" in plan
    finally:
        await c.close()


def test_ignored_filter_params_follow_core_filters():
    """결함 D8 방어: 무시 필터 파라미터 목록은 core(query_axes, CommonFilters 선언에서 파생) 한 벌이다(ingest R13 반영)."""
    from app.core.filters import CommonFilters, query_axes
    from ingest.pull.ops.service import ignored_filters
    params = {(f.alias or n) for n, f in CommonFilters.model_fields.items()}
    assert params <= set(query_axes())
    assert ignored_filters({"from": "2026-09-01", "to": "2026-09-02", "cf.x": "1", "depth3": "a"}, surface_supported=True) == [
        "custom", "depth3", "period"]
    assert ignored_filters({"surface": "global", "project_id": "x"}, surface_supported=True) == ["project_id"]
    assert ignored_filters({"surface": "global"}, surface_supported=False) == ["surface"]
