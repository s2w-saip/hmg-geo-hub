"""admin.cycles.jobs 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

rd.job 은 job_id 유니크 등치(사실 표 아님). 사유는 문서형 뷰 rd.v_answer_registry 를 answer_key 등치로만 읽는다(DESIGN-CONTRACT §3).
"""

TODAY_SQL = "SELECT rd.today_kst() AS today"

JOB_SQL = """
SELECT j.answer_key, j.job_id, j.surface, j.round_date, j.measured_at, j.status_code, j.analysis_code, j.dropped, j.served,
       c.cycle_id
  FROM rd.job j
  LEFT JOIN rd.cycle c ON c.cyc_key = j.cyc_key
 WHERE j.job_id = CAST(:jid AS uuid)
"""

REGISTRY_SQL = """
SELECT r.pin_anchor, r.pin_reason, r.pin_source_measured_at, r.drop_reason, r.dropped_at, r.drop_source_measured_at
  FROM rd.v_answer_registry r
 WHERE r.answer_key = CAST(:ak AS int4)
"""

PENDING_SQL = """
SELECT j.change_id, j.kind, j.status, j.requested_by, j.requested_at
  FROM app.judgment_change j
 WHERE j.status IN ('pending', 'running') AND j.kind IN ('anchor_pin', 'answer_drop')
   AND CAST(:jid AS uuid) = ANY(j.subject_uuids)
 ORDER BY j.change_id
"""
