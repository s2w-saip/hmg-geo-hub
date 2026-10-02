"""qa.review.verdict: 판정 조회·저장(락 재확인, 잃으면 409 lock_lost 로 미저장)."""
from __future__ import annotations

import uuid

import pytest

from app.features.qa.answers.list.tests.qa_support import db_exec, db_rows, db_val, job_id_of, new_session, qa_client
from tests.support import needs_db

pytestmark = [needs_db, pytest.mark.usefixtures("qa_clean")]


async def test_get_put_roundtrip_status_generated(client_as):
    a = await new_session("갑")
    jid = await job_id_of(1)
    queue_before = await db_val("SELECT count(*) FROM app.judgment_change")
    async with qa_client(client_as, a) as c:
        r = await c.get(f"/v1/qa/answers/{jid}/review")
        assert r.status_code == 200 and r.json()["data"] is None
        r = await c.put(f"/v1/qa/answers/{jid}/review", json={"section_flags": {"answer": "ok", "citations": "issue"}})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["status"] == "issue" and d["reviewer_name"] == "갑" and d["session_id"] == a.session_id
        assert d["section_flags"] == {"answer": "ok", "prompt": None, "mentions": None, "citations": "issue", "acr": None, "meta": None}
        r = await c.put(f"/v1/qa/answers/{jid}/review", json={"section_flags": {"answer": "ok"}})     # 전체 교체: citations → NULL
        assert r.json()["data"]["status"] == "ok" and r.json()["data"]["section_flags"]["citations"] is None
        assert (await c.get(f"/v1/qa/answers/{jid}/review")).json()["data"]["status"] == "ok"
    rows = await db_rows("SELECT status, flag_answer, flag_citations, reviewer_name, reviewer_id, session_id FROM app.qa_answer_review")
    assert len(rows) == 1 and rows[0]["status"] == "ok" and rows[0]["flag_citations"] is None
    assert rows[0]["reviewer_id"] is None and str(rows[0]["session_id"]) == a.session_id          # 감사 = 행의 검수자·세션·시각(Q17)
    # 저장이 락을 (재)획득한다
    assert str(await db_val("SELECT session_id FROM app.qa_answer_lock WHERE job_id = $1", jid)) == a.session_id
    assert await db_val("SELECT count(*) FROM app.judgment_change") == queue_before              # QA 판정은 재판정 큐 대상 아님(A17)


async def test_lock_lost_rolls_back(client_as):
    a, b = await new_session("갑"), await new_session("을")
    jid = await job_id_of(2)
    async with qa_client(client_as, a) as ca, qa_client(client_as, b) as cb:
        assert (await ca.put(f"/v1/qa/answers/{jid}/review", json={"section_flags": {"answer": "ok"}})).status_code == 200
        await db_exec("UPDATE app.qa_answer_lock SET heartbeat_at = now() - interval '200 seconds' WHERE job_id = $1", jid)
        assert (await cb.post(f"/v1/qa/answers/{jid}/lock")).status_code == 200            # 을이 만료 락을 탈취
        r = await ca.put(f"/v1/qa/answers/{jid}/review", json={"section_flags": {"answer": "issue"}})
        assert r.status_code == 409 and r.json()["error"]["code"] == "lock_lost"
        assert r.json()["error"]["details"]["held_by"]["reviewer_name"] == "을"
    rows = await db_rows("SELECT status, reviewer_name FROM app.qa_answer_review WHERE job_id = $1", jid)
    assert [(x["status"], x["reviewer_name"]) for x in rows] == [("ok", "갑")]                  # 덮어쓰지 않았다
    assert str(await db_val("SELECT session_id FROM app.qa_answer_lock WHERE job_id = $1", jid)) == b.session_id


async def test_revoked_session_writes_nothing(client_as):
    a = await new_session("갑")
    jid = await job_id_of(3)
    await db_exec("DELETE FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(a.session_id))
    async with qa_client(client_as, a) as c:
        r = await c.put(f"/v1/qa/answers/{jid}/review", json={"section_flags": {"answer": "ok"}})
    assert r.status_code == 401
    assert await db_val("SELECT count(*) FROM app.qa_answer_review") == 0 and await db_val("SELECT count(*) FROM app.qa_answer_lock") == 0


@pytest.mark.parametrize("body", [{"section_flags": {"bogus": "ok"}}, {"section_flags": {"answer": "maybe"}}, {}, {"section_flags": {}, "x": 1}])
async def test_invalid_body_422(client_as, body):
    a = await new_session("갑")
    async with qa_client(client_as, a) as c:
        r = await c.put(f"/v1/qa/answers/{await job_id_of(1)}/review", json=body)
    assert r.status_code == 422


async def test_unknown_job_and_no_cookie(client_as):
    a = await new_session("갑")
    async with qa_client(client_as, a) as c:
        assert (await c.get(f"/v1/qa/answers/{uuid.uuid4()}/review")).status_code == 404
        assert (await c.put(f"/v1/qa/answers/{uuid.uuid4()}/review", json={"section_flags": {}})).status_code == 404
    async with qa_client(client_as, None) as c:
        assert (await c.get(f"/v1/qa/answers/{await job_id_of(1)}/review")).status_code == 401
