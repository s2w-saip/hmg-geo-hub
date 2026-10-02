"""projects.prompts.execute: 운영자 게이트(require_operator 'run')·outbox 적재·queued 전이·복구 대상·중복 방지·롤백·접근 감사."""
from __future__ import annotations

import uuid

from app.core import errors
from app.core.write import get_audit_writer
from app.features.projects.prompts.execute.publisher import get_publisher
from app.main import app
from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db


def url(pid):
    return f"/v1/projects/{pid}/prompts/execute"


async def test_execute_queues_drafts_and_recovery(env, client_as):
    pid = await env.mk_project()
    await env.as_actor("UPDATE app.project SET scope_project_id = $2 WHERE project_id = $1", pid, sp_proj := uuid.uuid4())
    d1 = await env.mk_prompt("draft one", project_id=pid)
    await env.as_actor("UPDATE app.prompt SET lang = 'KO', regions = '{KR}', category = 'c' WHERE prompt_id = $1", d1)
    d2 = await env.mk_prompt("draft two", project_id=pid)
    orphan = await env.mk_prompt("queued orphan", project_id=pid, status="queued")          # 복구 대상(발행 요청 없음)
    pending = await env.mk_prompt("queued pending", project_id=pid, status="queued")        # 미완료 create 가 이미 있음
    await env.conn.execute("INSERT INTO app.scope_outbox (aggregate, aggregate_id, op, payload) VALUES ('prompt', $1, 'create', $2)",
                           pending, f'{{"project_id": "{pid}"}}')
    done = await env.mk_prompt("measured", project_id=pid, status="done", scope_prompt_id=uuid.uuid4())
    for uid, code in ((env.owner, 403), (VENDOR, 403), (HQ_HYUNDAI, 403), (KIA_US, 404), (SUSPENDED, 401), (env.nomenu, 403)):
        async with client_as(uid) as c:
            r = await c.post(url(pid))
        assert r.status_code == code, (uid, r.text)
    assert await env.val("SELECT count(*) FROM app.scope_outbox WHERE payload->>'project_id' = $1", str(pid)) == 1   # 거부는 무변경
    async with client_as(env.op) as c:
        r = await c.post(url(pid))
    assert r.status_code == 202, r.text
    assert r.json()["data"] == {"queued": 3, "recovered": 1, "skipped_pending": 1, "propagation": "pending"}
    st = {x["prompt_id"]: x["status"] for x in await env.q("SELECT prompt_id, status FROM app.prompt WHERE project_id = $1", pid)}
    assert st == {d1: "queued", d2: "queued", orphan: "queued", pending: "queued", done: "done"}
    ob = await env.outbox(d1)
    assert [o["op"] for o in ob] == ["create"]
    assert {k: ob[0]["payload"][k] for k in ("text", "lang", "regions", "category", "kind", "project_id", "scope_project_id")} == {
        "text": "draft one", "lang": "KO", "regions": ["KR"], "category": "c", "kind": "single", "project_id": str(pid),
        "scope_project_id": str(sp_proj)}
    assert [o["op"] for o in await env.outbox(orphan)] == ["create"]
    assert len(await env.outbox(pending)) == 1 and await env.outbox(done) == []
    assert [a["event_type"] for a in await env.audits(d2)] == ["created"]          # draft→queued 수명 전이는 감사 행 없음(트리거 규약)
    async with client_as(env.op) as c:                                              # 전부 미완료 발행 요청 보유 → 409
        r = await c.post(url(pid))
    assert r.status_code == 409 and r.json()["error"]["code"] == "nothing_to_execute"
    assert r.json()["error"]["details"] == {"skipped_pending": 4}                  # d1·d2·orphan·pending


async def test_execute_admin_global_and_empty(env, client_as):
    empty = await env.mk_project()
    async with client_as(ADMIN) as c:
        r = await c.post(url(empty))
    assert r.status_code == 409 and r.json()["error"]["details"] == {"skipped_pending": 0}
    pid = await env.mk_project()
    await env.mk_prompt("x", project_id=pid)
    async with client_as(ADMIN) as c:
        assert (await c.post(url(pid))).status_code == 202
    async with client_as(ADMIN) as c:
        assert (await c.post(url(uuid.uuid4()))).status_code == 404
        assert (await c.post("/v1/projects/nope/prompts/execute")).status_code == 422


class _FailSecond:
    def __init__(self):
        self.n = 0

    async def publish(self, conn, op, prompt_id, payload):
        from app.core.write import enqueue_scope
        self.n += 1
        if self.n == 2:
            raise errors.unavailable("가짜 실패", code="publisher_down")
        return await enqueue_scope(conn, "prompt", prompt_id, op, payload)


async def test_execute_rolls_back_on_publisher_failure_and_audits(env, client_as):
    pid = await env.mk_project()
    a = await env.mk_prompt("a", project_id=pid)
    b = await env.mk_prompt("b", project_id=pid)
    fake = _FailSecond()
    app.dependency_overrides[get_publisher] = lambda: fake
    try:
        async with client_as(env.op) as c:
            r = await c.post(url(pid))
        assert r.status_code == 503 and fake.n == 2
    finally:
        app.dependency_overrides.pop(get_publisher, None)
    assert await env.outbox(a) == [] and await env.outbox(b) == []                  # 첫 적재도 되돌려졌다
    assert {x["status"] for x in await env.q("SELECT status FROM app.prompt WHERE project_id = $1", pid)} == {"draft"}
    w = get_audit_writer()
    await w.flush()
    async with client_as(env.op) as c:
        assert (await c.post(url(pid))).status_code == 202
    assert await w.flush() >= 1
    n = await env.val("SELECT count(*) FROM app.access_audit_log WHERE actor_id = $1 AND kind = 'scope_call' "
                      "AND action = 'projects.prompts.execute' AND target = $2", env.op, str(pid))
    assert n == 1


class _Slow:
    """행마다 잠깐 쉬는 publisher: 두 실행이 서로의 트랜잭션 안으로 겹치게 만든다."""

    async def publish(self, conn, op, prompt_id, payload):
        import asyncio

        from app.core.write import enqueue_scope
        await asyncio.sleep(0.05)
        return await enqueue_scope(conn, "prompt", prompt_id, op, payload)


async def test_concurrent_execute_is_serialized(env, client_as):
    """검증 D4 회귀: 동시 실행 2회가 둘 다 202(한쪽 recovered=5 오보고)이던 결함. 이제 한쪽 202, 다른 쪽 409 skipped_pending=5."""
    import asyncio
    pid = await env.mk_project()
    ids = [await env.mk_prompt(f"conc {i}", project_id=pid) for i in range(5)]
    app.dependency_overrides[get_publisher] = lambda: _Slow()
    w = get_audit_writer()
    await w.flush()
    try:
        async with client_as(ADMIN) as c1, client_as(ADMIN) as c2:
            r1, r2 = await asyncio.gather(c1.post(url(pid)), c2.post(url(pid)))
    finally:
        app.dependency_overrides.pop(get_publisher, None)
    res = sorted([r1, r2], key=lambda r: r.status_code)
    assert [r.status_code for r in res] == [202, 409], (r1.text, r2.text)
    assert res[0].json()["data"] == {"queued": 5, "recovered": 0, "skipped_pending": 0, "propagation": "pending"}
    assert res[1].json()["error"]["code"] == "nothing_to_execute" and res[1].json()["error"]["details"] == {"skipped_pending": 5}
    for i in ids:
        assert [o["op"] for o in await env.outbox(i)] == ["create"]
    await w.flush()
    n = await env.val("SELECT count(*) FROM app.access_audit_log WHERE kind = 'scope_call' AND action = 'projects.prompts.execute' "
                      "AND target = $1", str(pid))
    assert n == 1                                                                   # 거부된 두 번째는 scope_call 감사 없음
