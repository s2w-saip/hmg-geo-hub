"""워커 한 틱 단위: cycles_tick(시간 기반 판정·파티션 선생성), 아웃박스 드레인, dfs_fetch 빠른 경로, 스케줄러 한 틱. 일회 DB(fresh_db)."""
from __future__ import annotations

import datetime as dt
import json
import uuid

import asyncpg

from ingest.common.db import LoaderDB
from ingest.cycles.workers.dfs import FakeDfsSource
from ingest.cycles.workers.service import cycles_tick, run_dfs, run_outbox
from ingest.pull.sync.source import FakeScopeSource
from ingest.worker import Scheduler, Task
from tests.support import needs_db

ACTOR = "5eed0000-0000-4000-8000-000000000001"


async def _q(url: str, sql: str, *a):
    c = await asyncpg.connect(url)
    try:
        return await c.fetch(sql, *a)
    finally:
        await c.close()


async def _app(url: str, sql: str, *a) -> None:
    c = await asyncpg.connect(url)
    try:
        async with c.transaction():
            await c.execute(f"SELECT set_config('app.actor_id', '{ACTOR}', true)")
            await c.execute(sql, *a)
    finally:
        await c.close()


@needs_db
async def test_cycles_tick_closes_by_time_and_creates_partitions(fresh_db):
    db = LoaderDB(fresh_db, role="loader")
    now = dt.datetime(2026, 9, 28, 6, 0, tzinfo=dt.UTC)
    before = await _q(fresh_db, "SELECT status FROM ing.cycle WHERE cyc_key = 12")
    assert before[0][0] == "open"
    rep = await cycles_tick(db, now=now, daily=True)
    # 회차 12(앵커 09-21, 멤버 run 5 started 09-21 00:30): 다음 앵커 없음·셀 2/2 완료·정온 36h 밖 → complete 로 닫힘.
    # 결손 비율 0(완료 2 중 결손 2) < 0.95 → 발행 안 함(R08)
    c12 = (await _q(fresh_db, "SELECT status, closed_by, published_at FROM ing.cycle WHERE cyc_key = 12"))[0]
    assert (c12["status"], c12["closed_by"], c12["published_at"]) == ("closed", "complete", None)
    assert (await _q(fresh_db, "SELECT status FROM rd.cycle WHERE cyc_key = 12"))[0][0] == 1
    assert rep.load_id is not None and rep.leaves_created > 0
    ld = (await _q(fresh_db, "SELECT kind, status, scope_ref->>'source' AS src FROM ing.load WHERE load_id = $1", rep.load_id))[0]
    assert tuple(ld) == ("cycle_admin", "committed", "cycles_tick")
    leaves = {r[0] for r in await _q(fresh_db, """SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid""")}
    for name in ("answer_g_202612", "citation_w_202612", "answer_p_202610", "access_audit_log_202612", "dfs_call_202612", "answer_202612",
                 "ga4_row_202612"):
        assert name in leaves, name
    gen = await _q(fresh_db, "SELECT generation FROM rd.surface_generation WHERE surface = 1")
    # 두 번째 틱: 바뀐 것 없음 → ing.load 행을 남기지 않는다, 세대 불변
    n = (await _q(fresh_db, "SELECT count(*) FROM ing.load"))[0][0]
    rep2 = await cycles_tick(db, now=now + dt.timedelta(minutes=20))
    assert rep2.load_id is None and (await _q(fresh_db, "SELECT count(*) FROM ing.load"))[0][0] == n
    assert await _q(fresh_db, "SELECT generation FROM rd.surface_generation WHERE surface = 1") == gen


@needs_db
async def test_outbox_create_writes_back_scope_ids_and_retries(fresh_db):
    pid = uuid.uuid4()
    prid = uuid.uuid4()
    new_scope_project = uuid.uuid4()
    new_scope_prompt = uuid.uuid4()
    await _app(fresh_db, """
      INSERT INTO app.project (project_id, kind, name, country_code, created_by) VALUES ($1, 'customer', 'p', 'US', '5eed0000-0000-4000-8000-000000000001');
      INSERT INTO app.prompt (prompt_id, project_id, text, status, created_by) VALUES ($2, $1, 'hello', 'draft', '5eed0000-0000-4000-8000-000000000001');
    """.replace("$1", f"'{pid}'").replace("$2", f"'{prid}'"))
    # 복제본에 다른 테스트가 남긴 아웃박스 행이 있을 수 있다: 이 테스트 행만 본다
    await _app(fresh_db, "UPDATE app.scope_outbox SET done_at = now() WHERE done_at IS NULL")
    # payload 는 core.contracts 계약(생산자와 같은 id 필드 + Scope 요청 본문 body)
    ids_p = f'"project_id": "{pid}"'
    ids_q = f'"prompt_id": "{prid}", "project_id": "{pid}"'
    await _app(fresh_db, f"""INSERT INTO app.scope_outbox (aggregate, aggregate_id, op, payload) VALUES
        ('project', $1, 'create', '{{{ids_p}, "body": {{"name": "p"}}}}'), ('prompt', $2, 'create', '{{{ids_q}, "body": {{"text": "hello"}}}}'),
        ('prompt', $2, 'update', '{{{ids_q}, "body": {{"text": "hello2"}}}}')""", pid, prid)
    src = FakeScopeSource(write_result={str(pid): {"project_id": str(new_scope_project)}, str(prid): {"prompt_id": str(new_scope_prompt)}})
    src.fail_on[("write", "prompt", str(prid))] = 1
    db = LoaderDB(fresh_db, role="loader")
    out = await run_outbox(db, src, system_actor=uuid.UUID(ACTOR))
    assert [o.status for o in out] == ["done", "failed", "failed"], out       # 프롬프트 생성 503 → 뒤 갱신은 Scope id 대기
    assert (await _q(fresh_db, "SELECT scope_project_id FROM app.project WHERE project_id = $1", pid))[0][0] == new_scope_project
    fail = (await _q(fresh_db, "SELECT attempts, last_error, next_attempt_at > now() AS later, done_at FROM app.scope_outbox WHERE op = 'create' AND aggregate = 'prompt'"))[0]
    assert fail["attempts"] == 1 and "503" in fail["last_error"] and fail["later"] and fail["done_at"] is None
    assert not [w for w in src.writes if w[1] == "update"]                   # id 없이 Scope 에 보내지 않는다
    # 503 생성 결과는 불명확: 운영자가 원격 생성 여부를 확인하기 전에는 자동 재전송하지 않는다.
    assert "scope_outcome_unknown:" in fail["last_error"]
    await _app(fresh_db, "UPDATE app.scope_outbox SET last_error = NULL WHERE aggregate = 'prompt' AND op = 'create'")
    # 이 가짜 원천에서는 생성되지 않았음을 확인한 후 재시도: 생성 → 되쓰기 → 후속 갱신.
    out = await run_outbox(db, src, system_actor=uuid.UUID(ACTOR), now=dt.datetime.now(dt.UTC) + dt.timedelta(days=2))
    assert [o.status for o in out] == ["done", "done"]                        # 생성 → 되쓰기 → 같은 틱의 갱신이 그 id 로 나간다
    upd = [w for w in src.writes if w[1] == "update"][0]
    assert (upd[3]["scope_project_id"], upd[3]["scope_prompt_id"]) == (str(new_scope_project), str(new_scope_prompt))
    assert (await _q(fresh_db, "SELECT scope_prompt_id FROM app.prompt WHERE prompt_id = $1", prid))[0][0] == new_scope_prompt
    audit = (await _q(fresh_db, "SELECT actor_type FROM app.prompt_audit_log WHERE prompt_id = $1 ORDER BY audit_id DESC LIMIT 1", prid))[0]
    assert audit["actor_type"] == "system"
    assert (await _q(fresh_db, "SELECT count(*) FROM app.judgment_change WHERE kind = 'catalog' AND $1 = ANY(subject_uuids)", new_scope_prompt))[0][0] == 1
    assert (await _q(fresh_db, "SELECT count(*) FROM app.scope_outbox WHERE done_at IS NULL"))[0][0] == 0


@needs_db
async def test_dfs_fetch_fast_path(fresh_db):
    """dfs_fetch 계약(core.contracts.DfsFetch, 운영자 키워드 도구·고객 관심 공용): fetch → 엔드포인트, 주체 = term_norm."""
    loc = '"location_code": 2840, "language_code": "en"'
    await _app(fresh_db, f"""INSERT INTO app.judgment_change (kind, subject_texts, payload, requested_by) VALUES
      ('dfs_fetch', ARRAY['best suv'], '{{"fetch": "volume", "terms": ["Best SUV"], {loc}}}', app.actor()),
      ('dfs_fetch', ARRAY['best suv'], '{{"fetch": "insight", "terms": ["best suv"], "depth": 20, {loc}}}', app.actor()),
      ('dfs_fetch', ARRAY['best suv'], '{{"fetch": "search", "terms": ["best suv"], {loc}}}', app.actor()),
      ('dfs_fetch', ARRAY['best suv'], '{{"fetch": "related", "terms": ["best suv"], {loc}}}', app.actor()),
      ('dfs_fetch', ARRAY['search_volume:2840:en', 'best suv'], '{{"endpoint": "keyword_suggestions", {loc}}}', app.actor()),
      ('dfs_fetch', NULL, '{{"endpoint": "search_volume", "keywords": ["x"]}}', app.actor())""")
    dfs = FakeDfsSource(responses={
        "search_volume": {"status_code": 20000, "tasks": [{"status_code": 20000, "result": [
            {"keyword": "Best SUV", "competition_index": 40, "cpc": 1.5, "competition": "MEDIUM",
             "monthly_searches": [{"year": 2026, "month": 8, "search_volume": 1000}, {"year": 2026, "month": 7, "search_volume": 900}]}]}]},
        "serp_organic": {"status_code": 20000, "tasks": [{"status_code": 20000, "result": [{"items": [
            {"type": "organic", "rank_group": 1, "url": "https://a.example/x", "domain": "a.example", "title": "A", "description": "d"},
            {"type": "paid", "rank_group": 2, "url": "https://ad.example"},
            {"type": "organic", "rank_group": 2, "url": "https://b.example/y", "domain": "b.example", "title": "B"}]}]}]},
        "keyword_suggestions": {"status_code": 20000, "tasks": [{"status_code": 20000, "result": [{"total_count": 5432, "items": [
            {"keyword": "best suv", "keyword_info": {"search_volume": 1000}, "search_intent_info": {"main_intent": "commercial"}},
            {"keyword": "best suv 2026", "keyword_info": {"search_volume": 300}}]}]}]}})
    at = dt.datetime(2026, 9, 28, tzinfo=dt.UTC)
    out = await run_dfs(LoaderDB(fresh_db, role="loader"), dfs, limit=10, now=at)
    assert [o.status for o in out] == ["applied", "applied", "applied", "applied", "applied", "failed"]
    assert "dfs_fetch payload 계약 위반" in out[-1].error                    # 옛 형식이라도 지역·언어가 없으면 계약 위반(호출 전 거부)
    assert [c[0] for c in dfs.calls] == ["search_volume", "search_volume", "serp_organic", "keyword_suggestions", "keyword_suggestions",
                                         "keyword_suggestions"]
    assert dfs.calls[2][1][0]["depth"] == 20                                   # insight 의 serp 깊이
    assert [c[1][0]["include_seed_keyword"] for c in dfs.calls[3:]] == [True, False, True]   # search = seed 포함, related = 제외
    # 검증 m-6: 옛 payload(endpoint, 키워드는 옛 접두 주체를 뺀 subject_texts)는 1회 변환해 그 엔드포인트 하나만 호출한다
    assert dfs.calls[5][1][0]["keyword"] == "best suv"
    kw = await _q(fresh_db, "SELECT kw_key, term_norm FROM rd.dim_keyword ORDER BY kw_key")
    assert [r["term_norm"] for r in kw] == ["best suv", "best suv 2026"]
    vol = await _q(fresh_db, "SELECT month, search_volume, competition FROM rd.kw_volume_monthly ORDER BY month")
    assert [tuple(r) for r in vol] == [(dt.date(2026, 7, 1), 900, "MEDIUM"), (dt.date(2026, 8, 1), 1000, "MEDIUM")]   # BG-40 라벨
    assert [r[0] for r in await _q(fresh_db, "SELECT url FROM rd.kw_serp ORDER BY rank")] == ["https://a.example/x", "https://b.example/y"]
    sug = await _q(fresh_db, "SELECT pos, is_seed, intent, observed_at, total_count FROM rd.kw_suggestion ORDER BY call_id, pos")
    assert [tuple(r)[:3] for r in sug] == [(1, True, "commercial"), (2, False, None)] * 3
    assert {r["total_count"] for r in sug} == {5432}                            # BG-39: 호출 단위 total_count 를 행마다
    assert {r["observed_at"] for r in sug} == {at}                              # DB-v2.6 P43: 관측 시각 = 호출 시각
    calls = await _q(fresh_db, "SELECT endpoint, status_code, keywords FROM ext.dfs_call ORDER BY call_id")
    assert [(r[0], r[1]) for r in calls] == [("search_volume", 200), ("search_volume", 200), ("serp_organic", 200),
                                             ("keyword_suggestions", 200), ("keyword_suggestions", 200), ("keyword_suggestions", 200)]
    st = await _q(fresh_db, "SELECT status, applied_load_id IS NOT NULL AS l FROM app.judgment_change WHERE kind = 'dfs_fetch' ORDER BY change_id")
    assert [(r[0], r[1]) for r in st] == [("applied", True)] * 5 + [("failed", False)]
    loads = await _q(fresh_db, "SELECT kind FROM ing.load WHERE load_id IN (SELECT applied_load_id FROM app.judgment_change WHERE kind = 'dfs_fetch')")
    assert {r[0] for r in loads} == {"dfs"}
    # 같은 키워드 재수집은 월 행을 갱신(중복 없음)
    await _app(fresh_db, f"""INSERT INTO app.judgment_change (kind, subject_texts, payload, requested_by) VALUES
      ('dfs_fetch', ARRAY['best suv'], '{{"fetch": "volume", "terms": ["best suv"], {loc}}}', app.actor())""")
    await run_dfs(LoaderDB(fresh_db, role="loader"), dfs, now=dt.datetime(2026, 9, 29, tzinfo=dt.UTC))
    assert (await _q(fresh_db, "SELECT count(*) FROM rd.kw_volume_monthly"))[0][0] == 2


async def test_scheduler_one_tick_at_a_time():
    calls: list[tuple[str, dt.datetime]] = []

    def mk(name: str, fail: bool = False):
        async def f(now: dt.datetime) -> None:
            calls.append((name, now))
            if fail:
                raise RuntimeError("boom")
        return f

    s = Scheduler(tasks=[Task("queue", dt.timedelta(seconds=60), mk("queue", fail=True)), Task("pull", dt.timedelta(minutes=20), mk("pull")),
                         Task("cycles_tick", dt.timedelta(minutes=20), mk("tick"))], daily=mk("daily"))
    t0 = dt.datetime(2026, 9, 28, 14, 59, tzinfo=dt.UTC)                       # KST 23:59
    assert await s.step(t0) == ["daily", "queue", "pull", "cycles_tick"]       # 실패한 작업(queue)이 다른 작업을 막지 않는다
    assert await s.step(t0 + dt.timedelta(seconds=30)) == []
    assert await s.step(t0 + dt.timedelta(seconds=61)) == ["daily", "queue"]   # KST 날짜가 바뀐 첫 틱에 일 1회 작업
    assert await s.step(t0 + dt.timedelta(minutes=20, seconds=1)) == ["queue", "pull", "cycles_tick"]
    assert s.tasks[0].errors == 3 and s.tasks[0].last_error == "boom" and s.tasks[1].errors == 0
    assert s.next_due(t0) == t0 + dt.timedelta(minutes=21, seconds=1)
    assert json.dumps([c[0] for c in calls])


def test_legacy_dfs_payload_upgrade():
    """검증 m-6: 옛 dfs_fetch payload 는 새 계약 + 엔드포인트 고정으로 1회 변환(새 형식·모르는 endpoint 는 None)."""
    from app.core.contracts import parse_change
    from ingest.cycles.workers.dfs import legacy_dfs, plan_calls

    p, only = legacy_dfs({"endpoint": "serp_organic", "keywords": ["a"], "location_code": 2410, "language_code": "ko"}, None)
    d = parse_change("dfs_fetch", p)
    assert (d.fetch, only) == ("insight", ("serp_organic",))
    assert [c[0] for c in plan_calls(d, only)] == ["serp_organic"]                # 검색량 호출을 더하지 않는다
    p, only = legacy_dfs({"endpoint": "search_volume", "terms": ["x"], "location_code": 2840, "language_code": "en",
                          "requested_via": "admin.keyword_tools.volume"}, ["search_volume:2840:en", "x"])
    assert p["fetch"] == "volume" and p["terms"] == ["x"] and p["requested_via"] == "admin.keyword_tools.volume"
    assert legacy_dfs({"fetch": "volume", "terms": ["x"]}, None) is None
    assert legacy_dfs({"endpoint": "nope"}, None) is None


def test_dfs_value_guards_bg39_bg40():
    """세 값 밖 competition·정수 아닌 total_count 는 NULL(DB CHECK 를 적재가 깨지 않게)."""
    from ingest.cycles.workers.dfs import _competition, _total_count
    assert [_competition(v) for v in ("LOW", "MEDIUM", "HIGH", "low", "UNSPECIFIED", None, 3)] == ["LOW", "MEDIUM", "HIGH", None, None, None, None]
    assert [_total_count(v) for v in (0, 12, -1, True, 1.5, "7", None, 2 ** 31)] == [0, 12, None, None, None, None, None, None]
