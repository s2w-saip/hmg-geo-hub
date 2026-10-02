"""qa.review.sessions SQL(SQLAlchemy Core text). qa_gate 쓰기 허용 4표(app.qa_review_session·qa_answer_lock·qa_answer_review·qa_review_note)."""
INSERT_SESSION_SQL = """
INSERT INTO app.qa_review_session (reviewer_name, user_agent, ip_hash) VALUES (:name, :ua, :ip)
RETURNING session_id, reviewer_name, started_at, last_seen_at"""

# 세션 확인은 core.auth.assert_qa_session(쓰기 전·QaLiveConn 읽기)이 한다: FOR KEY SHARE 로 트랜잭션 끝까지 행을 잡아 로그아웃의
# FOR UPDATE 와 직렬화된다. 로그아웃이 먼저면 확인은 지워진 행을 못 찾아 401, 확인이 먼저면 로그아웃이 그 요청의 판정·노트까지 끊고 지운다(N2).

TOUCH_SESSION_SQL = """
UPDATE app.qa_review_session SET last_seen_at = now() WHERE session_id = :sid
RETURNING session_id, reviewer_name, started_at, last_seen_at"""

# 로그아웃(D2·N2): 세션 행 잠금(FOR UPDATE) → 이 세션의 락 해제 → 판정·노트의 session_id 를 NULL 로 끊음 → 세션 행 삭제.
# 판정·노트의 session_id FK 는 ON DELETE 가 없지만 NULL 을 허용하고(DB-v2.4 app.qa_answer_review·qa_review_note), qa_gate 는 두 표에
# UPDATE 권한이 있다(DB-v2.4.sql GRANT … TO qa_gate). 작성자는 reviewer_name 스냅샷으로 남아 이력·노트 수정 권한(이름 기준)은 그대로다.
# 잠금 순서: 세션 행을 가장 먼저 잠근다. 쓰기 경로도 세션 행(assert_qa_session FOR KEY SHARE·FK 확인)을 락 행보다 먼저 잡으므로
# 순서가 같아 교착이 없다(예전 순서 = 락 행 삭제 → 세션 행 잠금은 락 재획득 upsert 와 교착할 수 있었다).
# sqlguard G5·G6(SAVEPOINT·데이터 변경 CTE 금지)에 따라 문장을 나눈다.
LOCK_SESSION_SQL = "SELECT session_id FROM app.qa_review_session WHERE session_id = :sid FOR UPDATE"
RELEASE_SESSION_LOCKS_SQL = "DELETE FROM app.qa_answer_lock WHERE session_id = :sid RETURNING job_id"
DETACH_REVIEWS_SQL = "UPDATE app.qa_answer_review SET session_id = NULL WHERE session_id = :sid RETURNING job_id"
DETACH_NOTES_SQL = "UPDATE app.qa_review_note SET session_id = NULL WHERE session_id = :sid RETURNING note_id"

# 끊은 뒤라 참조가 없어야 한다. NOT EXISTS 는 방어선(참조가 남으면 FK 500 대신 행을 남기고 session_kept_reason 으로 알린다).
DELETE_SESSION_SQL = """
DELETE FROM app.qa_review_session s WHERE s.session_id = :sid
  AND NOT EXISTS (SELECT 1 FROM app.qa_answer_review r WHERE r.session_id = s.session_id)
  AND NOT EXISTS (SELECT 1 FROM app.qa_review_note n WHERE n.session_id = s.session_id)
RETURNING s.session_id"""
