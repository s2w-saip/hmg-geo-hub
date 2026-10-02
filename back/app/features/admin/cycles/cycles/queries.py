"""admin.cycles.cycles 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

rd.cycle·rd.job 은 사실 표 파티션이 아니지만 surface·round_date 로 인덱스(cycle_pick_idx·job_round_idx) 범위를 좁힌다.
rd.answer(사실 표)는 core.cycles.Window.where 조각({where})으로만 읽는다.
"""

TODAY_SQL = "SELECT rd.today_kst() AS today"

_CYCLE_COLS = """
SELECT c.cyc_key, c.cycle_id, c.surface, c.project_key, dp.project_id, dp.site_id, c.ledger_backed, c.round_date, c.anchor_date,
       c.status, c.servable, c.view_date, c.hidden_scope, c.hidden_reason, c.generation,
       c.expected_units, c.completed_units, c.completed_answers, c.gap_answers
  FROM rd.cycle c
  LEFT JOIN rd.dim_project dp ON dp.project_key = c.project_key
"""

# 목록: (round_date, cycle_id) DESC 키셋. {keyset} = core.pagination.keyset_predicate 조각 또는 true
LIST_SQL = _CYCLE_COLS + """
 WHERE c.surface = CAST(:sf AS int2) AND c.round_date BETWEEN CAST(:lo AS date) AND CAST(:hi AS date)
   AND (CAST(:pks AS int2[]) IS NULL OR c.project_key = ANY(CAST(:pks AS int2[])))
   AND {keyset}
 ORDER BY c.round_date DESC, c.cycle_id DESC
 LIMIT CAST(:lim AS int4)
"""

BY_ID_SQL = _CYCLE_COLS + " WHERE c.cycle_id = CAST(:cid AS uuid)"
BY_KEY_SQL = _CYCLE_COLS + " WHERE c.cyc_key = CAST(:ck AS int4)"

PROJECT_KEYS_SQL = """
SELECT project_key FROM rd.dim_project
 WHERE surface = CAST(:sf AS int2) AND (project_id = CAST(:pid AS uuid) OR site_id = CAST(:pid AS uuid))
"""

# 대기·진행 중 운영 요청(부분 인덱스 judgment_change_open_idx 범위)
PENDING_SQL = """
SELECT j.change_id, j.payload->>'op' AS op, j.status, j.requested_by, j.requested_at, j.subject_uuids
  FROM app.judgment_change j
 WHERE j.status IN ('pending', 'running') AND j.kind = 'cycle_admin' AND j.subject_uuids && CAST(:ids AS uuid[])
 ORDER BY j.change_id
"""

# 진행률(조회 시 계산): rd.job 은 (surface, round_date) 범위 → cyc_key 등치
JOB_DIST_SQL = """
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE j.status_code = 0)::int AS completed,
       count(*) FILTER (WHERE j.status_code = 1)::int AS running,
       count(*) FILTER (WHERE j.status_code = 2)::int AS failed,
       count(*) FILTER (WHERE j.status_code = 3)::int AS other,
       count(*) FILTER (WHERE j.dropped)::int AS dropped,
       count(*) FILTER (WHERE j.served)::int AS served
  FROM rd.job j
 WHERE j.surface = CAST(:sf AS int2) AND j.round_date = CAST(:rd AS date) AND j.cyc_key = CAST(:ck AS int4)
"""

# {where} = Window.where("a", "row", b) 조각(회차 1개)
ANSWER_DIST_SQL = """
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE a.gap)::int AS gap,
       count(*) FILTER (WHERE a.analysis_state = 0)::int AS analyzed_mentions,
       count(*) FILTER (WHERE a.analysis_state = 1)::int AS analyzed_empty,
       count(*) FILTER (WHERE a.analysis_state = 2)::int AS pending,
       count(*) FILTER (WHERE a.analysis_state = 3)::int AS failed
  FROM rd.answer a
 WHERE {where}
"""

# 숨김 경고(hideCycleWarnings 이식 입력): 같은 표면·프로젝트의 숨기지 않은 회차 중 같은 주(월요일 시작)·더 최신
HIDE_CONTEXT_SQL = """
SELECT count(*) FILTER (WHERE c.round_date >= CAST(date_trunc('week', CAST(:rd AS date)) AS date)
                          AND c.round_date < CAST(date_trunc('week', CAST(:rd AS date)) AS date) + 7)::int AS rest,
       count(*) FILTER (WHERE c.round_date > CAST(:rd AS date))::int AS newer,
       CAST(date_trunc('week', CAST(:rd AS date)) AS date) AS week
  FROM rd.cycle c
 WHERE c.surface = CAST(:sf AS int2) AND c.project_key = CAST(:pk AS int2) AND c.hidden_scope = 0
   AND c.cyc_key <> CAST(:ck AS int4)
"""
