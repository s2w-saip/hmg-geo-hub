"""qa.review.lock SQL(SQLAlchemy Core text). app.qa_answer_lock 만.

획득은 단일 문(INSERT … ON CONFLICT … DO UPDATE … WHERE)이다. 읽고 쓰는 두 문으로 나누면 두 검수자가 같은 답변을 동시에 열 때 둘 다
통과하는 창이 생긴다(현행 acquireLock 계승). 성공 = 신규 · 내 세션 재획득 · 만료(TTL) 탈취, 실패 = 남의 살아 있는 락.
"""
LOCK_UPSERT_SQL = """
INSERT INTO app.qa_answer_lock (job_id, session_id, reviewer_name) VALUES (:job_id, :sid, :name)
ON CONFLICT (job_id) DO UPDATE SET session_id = EXCLUDED.session_id, reviewer_name = EXCLUDED.reviewer_name,
                                   acquired_at = now(), heartbeat_at = now()
 WHERE app.qa_answer_lock.session_id = EXCLUDED.session_id
    OR app.qa_answer_lock.heartbeat_at < now() - CAST(:ttl AS int4) * interval '1 second'
RETURNING job_id, session_id, reviewer_name, acquired_at, heartbeat_at"""

LOCK_HOLDER_SQL = "SELECT job_id, session_id, reviewer_name, acquired_at, heartbeat_at FROM app.qa_answer_lock WHERE job_id = :job_id"

HEARTBEAT_SQL = """
UPDATE app.qa_answer_lock SET heartbeat_at = now() WHERE job_id = :job_id AND session_id = :sid
RETURNING job_id, session_id, reviewer_name, acquired_at, heartbeat_at"""

RELEASE_SQL = "DELETE FROM app.qa_answer_lock WHERE job_id = :job_id AND session_id = :sid RETURNING job_id"
