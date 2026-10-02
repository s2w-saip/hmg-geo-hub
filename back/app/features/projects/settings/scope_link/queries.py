"""projects.settings.scope_link 읽기 SQL. rd.cycle·rd.job(비파티션 색인 표, 사실 표 아님)과 app.scope_outbox 만.

- 최신 회차: cycle_project_idx(project_key, round_date DESC) 1행.
- job 수: job_round_idx(surface, round_date, prompt_key) 접두 범위 안 project_key 필터(최신 회차 1개 한정 = 10배에도 회차당 행 수).
- 아웃박스: scope_outbox_aggregate_idx(aggregate, aggregate_id, created_at DESC).
"""
from __future__ import annotations

PROJECT = "SELECT scope_project_id FROM app.project WHERE project_id = :pid"

LATEST_ROUND = """
SELECT c.round_date, c.status, c.servable, c.view_date
  FROM rd.cycle c
 WHERE c.surface = 3 AND c.project_key = ANY(CAST(:keys AS int2[]))
 ORDER BY c.round_date DESC LIMIT 1
"""

JOBS = """
SELECT count(*) AS total, count(*) FILTER (WHERE j.served) AS served,
       count(*) FILTER (WHERE j.status_code = 1) AS in_progress, count(*) FILTER (WHERE j.status_code = 2) AS failed,
       max(j.measured_at) AS last_measured_at
  FROM rd.job j
 WHERE j.surface = 3 AND j.round_date = :rd AND j.project_key = ANY(CAST(:keys AS int2[]))
"""

OUTBOX_COUNTS = """
SELECT count(*) FILTER (WHERE o.done_at IS NULL) AS pending,
       count(*) FILTER (WHERE o.done_at IS NULL AND o.last_error IS NOT NULL) AS erroring,
       count(*) FILTER (WHERE o.done_at IS NULL AND o.aggregate = 'project' AND o.op = 'create') AS pending_create
  FROM app.scope_outbox o
 WHERE o.aggregate IN ('project', 'schedule') AND o.aggregate_id = :pid
"""

PROMPT_OUTBOX_PENDING = """
SELECT count(*) AS n
  FROM app.prompt q JOIN app.scope_outbox o ON o.aggregate = 'prompt' AND o.aggregate_id = q.prompt_id AND o.done_at IS NULL
 WHERE q.project_id = :pid
"""

OUTBOX_RECENT = """
SELECT o.outbox_id, o.aggregate, o.op, o.attempts, o.created_at, o.next_attempt_at, o.done_at, o.last_error
  FROM app.scope_outbox o
 WHERE o.aggregate IN ('project', 'schedule') AND o.aggregate_id = :pid
 ORDER BY o.created_at DESC, o.outbox_id DESC LIMIT 10
"""
