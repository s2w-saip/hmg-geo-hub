"""qa.review.deltas: 10초 폴링(유효 락·판정 상태)."""
from __future__ import annotations

import uuid

import pytest

from app.features.qa.answers.list.tests.qa_support import db_exec, job_id_of, new_session, qa_client, use_qa_scope
from tests.support import needs_db

pytestmark = [needs_db, pytest.mark.usefixtures("qa_clean")]


async def test_deltas_locks_and_reviews(client_as):
    a = await new_session("갑")
    j1, j2, j21 = await job_id_of(1), await job_id_of(2), await job_id_of(21)
    await db_exec("INSERT INTO app.qa_answer_lock (job_id, session_id, reviewer_name) VALUES ($1, $3, '갑'), ($2, $3, '갑')",
                  j1, j2, uuid.UUID(a.session_id))
    await db_exec("UPDATE app.qa_answer_lock SET heartbeat_at = now() - interval '181 seconds' WHERE job_id = $1", j2)   # 만료
    await db_exec("INSERT INTO app.qa_answer_review (job_id, flag_answer, reviewer_name) VALUES ($1, 'issue', '을'), ($2, 'ok', '병')", j2, j21)
    async with qa_client(client_as, a) as c:
        r = await c.get("/v1/qa/deltas", params={"job_ids": [f"{j1},{j2}", str(j21)]})     # 반복·쉼표 혼용
        assert r.status_code == 200
        d = r.json()["data"]
        assert [x["job_id"] for x in d["locks"]] == [str(j1)]                               # TTL 밖 락 제외
        assert {(x["job_id"], x["status"], x["reviewer_name"]) for x in d["reviews"]} == {(str(j2), "issue", "을"), (str(j21), "ok", "병")}
        assert (await c.get("/v1/qa/deltas")).json()["data"] == {"locks": [], "reviews": []}
        use_qa_scope(surfaces=("global",))                                                  # 범위 밖 job 은 싣지 않는다(qa R3: core.config)
        d = (await c.get("/v1/qa/deltas", params={"job_ids": [str(j2), str(j21)]})).json()["data"]
        assert [x["job_id"] for x in d["reviews"]] == [str(j2)]


async def test_deltas_cap_and_validation(client_as):
    a = await new_session("갑")
    many = [str(uuid.uuid4()) for _ in range(205)]
    async with qa_client(client_as, a) as c:
        r = await c.get("/v1/qa/deltas", params={"job_ids": ",".join(many)})
        assert r.status_code == 200 and r.json()["meta"]["dropped_filters"] == {"job_ids": many[200:]}   # 200 초과분 무시(현행)
        r = await c.get("/v1/qa/deltas", params={"job_ids": "nope"})
        assert r.status_code == 422
    async with qa_client(client_as, None) as c:
        assert (await c.get("/v1/qa/deltas")).status_code == 401
