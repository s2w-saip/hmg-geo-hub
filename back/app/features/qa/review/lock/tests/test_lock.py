"""qa.review.lock: 락 획득·동시 경합·TTL 탈취·heartbeat·해제."""
from __future__ import annotations

import asyncio
import uuid

import pytest

from app.features.qa.answers.list.tests.qa_support import db_exec, db_rows, db_val, job_id_of, new_session, qa_client
from tests.support import needs_db

pytestmark = [needs_db, pytest.mark.usefixtures("qa_clean")]


async def test_acquire_reacquire_and_conflict(client_as):
    a, b = await new_session("갑"), await new_session("을")
    jid = await job_id_of(1)
    await db_exec("UPDATE app.qa_review_session SET last_seen_at = now() - interval '1 hour'")
    async with qa_client(client_as, a) as ca, qa_client(client_as, b) as cb:
        r = await ca.post(f"/v1/qa/answers/{jid}/lock")
        assert r.status_code == 200 and r.json()["data"]["reviewer_name"] == "갑" and r.json()["data"]["session_id"] == a.session_id
        assert (await ca.post(f"/v1/qa/answers/{jid}/lock")).status_code == 200            # 내 세션 재획득(새로고침)
        r = await cb.post(f"/v1/qa/answers/{jid}/lock")
        assert r.status_code == 409 and r.json()["error"]["code"] == "lock_held"
        assert r.json()["error"]["details"]["held_by"]["reviewer_name"] == "갑"
    rows = await db_rows("SELECT session_id, reviewer_name FROM app.qa_answer_lock WHERE job_id = $1", jid)
    assert [(str(x["session_id"]), x["reviewer_name"]) for x in rows] == [(a.session_id, "갑")]
    # 부수 효과: 획득한 세션의 last_seen 갱신, 진 세션은 그대로
    assert await db_val("SELECT last_seen_at > now() - interval '1 minute' FROM app.qa_review_session WHERE session_id = $1",
                        uuid.UUID(a.session_id))
    assert not await db_val("SELECT last_seen_at > now() - interval '1 minute' FROM app.qa_review_session WHERE session_id = $1",
                            uuid.UUID(b.session_id))


async def test_concurrent_acquire_exactly_one_wins(client_as):
    """같은 답변을 여러 세션이 동시에 잡으면 정확히 하나만 성공한다(단일 upsert, 현행 acquireLock 경합 창 제거)."""
    sessions = [await new_session(f"검수자{i}") for i in range(5)]
    for k in (1, 2, 3):
        jid = await job_id_of(k)
        clients = [qa_client(client_as, s) for s in sessions]
        cs = [await cm.__aenter__() for cm in clients]
        try:
            rs = await asyncio.gather(*(c.post(f"/v1/qa/answers/{jid}/lock") for c in cs))
        finally:
            for cm in clients:
                await cm.__aexit__(None, None, None)
        codes = sorted(r.status_code for r in rs)
        assert codes == [200] + [409] * 4, codes
        winner = next(r for r in rs if r.status_code == 200).json()["data"]["session_id"]
        assert await db_val("SELECT count(*) FROM app.qa_answer_lock WHERE job_id = $1", jid) == 1
        assert str(await db_val("SELECT session_id FROM app.qa_answer_lock WHERE job_id = $1", jid)) == winner
        assert all(r.json()["error"]["details"]["held_by"]["reviewer_name"] for r in rs if r.status_code == 409)


async def test_ttl_takeover(client_as):
    a, b = await new_session("갑"), await new_session("을")
    jid = await job_id_of(2)
    async with qa_client(client_as, a) as ca, qa_client(client_as, b) as cb:
        assert (await ca.post(f"/v1/qa/answers/{jid}/lock")).status_code == 200
        await db_exec("UPDATE app.qa_answer_lock SET heartbeat_at = now() - interval '179 seconds' WHERE job_id = $1", jid)
        assert (await cb.post(f"/v1/qa/answers/{jid}/lock")).status_code == 409           # TTL 180초 안
        await db_exec("UPDATE app.qa_answer_lock SET heartbeat_at = now() - interval '181 seconds' WHERE job_id = $1", jid)
        r = await cb.post(f"/v1/qa/answers/{jid}/lock")                                   # 만료 탈취
        assert r.status_code == 200 and r.json()["data"]["reviewer_name"] == "을"
        r = await ca.patch(f"/v1/qa/answers/{jid}/lock")                                  # 원래 주인의 heartbeat 는 잃었다
        assert r.json()["data"] == {"held": False, "lock": None}


async def test_heartbeat_and_release_owner_only(client_as):
    a, b = await new_session("갑"), await new_session("을")
    jid = await job_id_of(3)
    async with qa_client(client_as, a) as ca, qa_client(client_as, b) as cb:
        await ca.post(f"/v1/qa/answers/{jid}/lock")
        await db_exec("UPDATE app.qa_answer_lock SET heartbeat_at = now() - interval '100 seconds' WHERE job_id = $1", jid)
        r = await ca.patch(f"/v1/qa/answers/{jid}/lock")
        assert r.json()["data"]["held"] is True
        assert await db_val("SELECT heartbeat_at > now() - interval '5 seconds' FROM app.qa_answer_lock WHERE job_id = $1", jid)
        assert (await cb.patch(f"/v1/qa/answers/{jid}/lock")).json()["data"]["held"] is False
        r = await cb.delete(f"/v1/qa/answers/{jid}/lock")                                 # 남의 락은 지우지 못한다
        assert r.status_code == 200 and r.json()["data"] == {"released": False}
        assert await db_val("SELECT count(*) FROM app.qa_answer_lock WHERE job_id = $1", jid) == 1
        r = await ca.delete(f"/v1/qa/answers/{jid}/lock")
        assert r.json()["data"] == {"released": True}
        assert await db_val("SELECT count(*) FROM app.qa_answer_lock WHERE job_id = $1", jid) == 0


async def test_lock_rejects_unknown_job_revoked_session_and_no_cookie(client_as):
    a = await new_session("갑")
    async with qa_client(client_as, a) as ca:
        r = await ca.post(f"/v1/qa/answers/{uuid.uuid4()}/lock")
        assert r.status_code == 404
        await db_exec("DELETE FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(a.session_id))
        r = await ca.post(f"/v1/qa/answers/{await job_id_of(1)}/lock")
        assert r.status_code == 401 and r.json()["error"]["code"] == "qa_unauthorized"
    assert await db_val("SELECT count(*) FROM app.qa_answer_lock") == 0
    async with qa_client(client_as, None) as c:
        assert (await c.post(f"/v1/qa/answers/{await job_id_of(1)}/lock")).status_code == 401


async def test_upsert_blocks_and_loses_while_first_uncommitted(database):
    """경합 창을 DB 수준에서 직접 연다: 첫 트랜잭션이 커밋 전일 때 두 번째 upsert 는 기다렸다가(유니크 충돌) 행 없이 끝난다."""
    from app.core.db import fetch_one
    from app.features.qa.answers.list.scope import LOCK_TTL_SECONDS
    from app.features.qa.review.lock.queries import LOCK_UPSERT_SQL

    a, b = await new_session("갑"), await new_session("을")
    jid = await job_id_of(4)

    def params(s):
        return {"job_id": jid, "sid": uuid.UUID(s.session_id), "name": s.name, "ttl": LOCK_TTL_SECONDS}

    async def second():
        async with database.transaction("qa_gate") as c2:
            return await fetch_one(c2, LOCK_UPSERT_SQL, params(b))

    async with database.transaction("qa_gate") as c1:
        assert await fetch_one(c1, LOCK_UPSERT_SQL, params(a)) is not None
        task = asyncio.create_task(second())
        await asyncio.sleep(0.5)
        assert not task.done()                                   # 커밋 전 첫 트랜잭션의 유니크 키에서 대기
    assert await task is None                                    # 첫 락이 살아 있으므로 두 번째는 얻지 못한다
    assert str(await db_val("SELECT session_id FROM app.qa_answer_lock WHERE job_id = $1", jid)) == a.session_id
