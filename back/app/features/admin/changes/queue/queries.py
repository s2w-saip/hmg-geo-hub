"""admin.changes.queue 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

app.judgment_change 는 사실 표가 아니다(회차 가지치기 대상 아님). 목록은 change_id DESC 키셋(PK)으로 읽는다.
선택 필터는 NULL 이면 꺼지는 정적 술어로 둔다(동적 SQL 조립 없음, 가드가 정적으로 검사한다).
"""

_COLS = """
SELECT c.change_id, c.kind, c.status, c.subject_uuids, c.subject_texts, c.payload, c.requested_by,
       u.email::text AS requested_by_email, c.requested_at, c.claimed_at, c.applied_at, c.applied_load_id, c.error
  FROM app.judgment_change c
  LEFT JOIN app.user_account u ON u.user_id = c.requested_by
"""

LIST_SQL = _COLS + """
 WHERE (CAST(:kinds AS text[]) IS NULL OR c.kind = ANY(CAST(:kinds AS text[])))
   AND (CAST(:statuses AS text[]) IS NULL OR c.status = ANY(CAST(:statuses AS text[])))
   AND (CAST(:requested_by AS uuid) IS NULL OR c.requested_by = CAST(:requested_by AS uuid))
   AND (CAST(:subject_uuid AS uuid) IS NULL OR CAST(:subject_uuid AS uuid) = ANY(c.subject_uuids))
   AND (CAST(:subject_text AS text) IS NULL OR CAST(:subject_text AS text) = ANY(c.subject_texts))
   AND (CAST(:after AS bigint) IS NULL OR c.change_id < CAST(:after AS bigint))
 ORDER BY c.change_id DESC
 LIMIT CAST(:lim AS int4)
"""

ONE_SQL = _COLS + " WHERE c.change_id = CAST(:change_id AS bigint)"
