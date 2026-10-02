"""ingest.pull.ops 읽기 SQL. api_ro 가 읽을 수 있는 rd 운영 조회 뷰(DB-v2.1 P09-d, 소유 loader_ro)만 쓴다(A17: ing 직접 조회 금지).
사실 표를 읽지 않아 surface·round_date·cyc_key 가지치기 대상이 아니다. 행 규모 = 적재 원장(10배에서도 수십만 이하, 인덱스 스캔)."""

STATUS = """
SELECT scope_project_id, surface, last_attempt_at, last_success_at, last_error, prompts_updated_to, regions,
       open_runs::int AS open_runs, blocked_runs::int AS blocked_runs
  FROM rd.v_ingest_status
 WHERE {where}
 ORDER BY surface, scope_project_id
"""
# 키셋(started_at 오름차순, NULL 은 센티넬 1970-01-01 로 맨 앞, run_id). 원장 run_open_idx·run_project_idx 가 받친다.
BACKLOG = """
SELECT run_id, scope_project_id, surface, sync_state, status, total_jobs, unresolved_jobs, analysis_pending, recheck_until,
       analysis_recheck_until, attempts::int AS attempts, next_attempt_at, last_error, started_at,
       coalesce(started_at, '1970-01-01 00:00+00'::timestamptz) AS k_started
  FROM rd.v_ingest_backlog
 WHERE {where}
 ORDER BY coalesce(started_at, '1970-01-01 00:00+00'::timestamptz), run_id
 LIMIT {limit}
"""
BACKLOG_KEY = ("coalesce(started_at, '1970-01-01 00:00+00'::timestamptz)", "run_id")
# 키셋 load_id 내림차순(ing.load PK)
LOADS = """
SELECT load_id, kind, run_id, status, rule_ver, jobs_fetched, jobs_changed, jobs_removed, rd_answers_upserted, rd_gate_propagated,
       rd_rep_flips, rd_children_rows, started_at, finished_at, error
  FROM rd.v_ingest_load
 WHERE {where}
 ORDER BY load_id DESC
 LIMIT {limit}
"""
