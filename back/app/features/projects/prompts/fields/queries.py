"""projects.prompts.fields SQL(SQLAlchemy Core text). app 만(rd·ing·사실 표 없음).

IDOR: 태그값 쓰기는 FK (project_id, field_id)·(project_id, prompt_id) 가 같은 프로젝트를 강제하고, 앞단에서 소속을 먼저 확인해 404 로 은폐한다.
커스텀 필드는 판정 입력이 아니다(프로젝트 표면 필터가 조회 시 app 을 직접 읽는다) → judgment_change 없음.
"""
from __future__ import annotations

LIST_SQL = """
SELECT f.field_id, f.label, f.archived, f.created_at,
       (SELECT count(*) FROM app.prompt_custom_field_value v WHERE v.project_id = f.project_id AND v.field_id = f.field_id) AS value_count
  FROM app.project_custom_field f
 WHERE f.project_id = :pid
 ORDER BY f.created_at, f.field_id"""

GET_SQL = """
SELECT f.field_id, f.label, f.archived, f.created_at,
       (SELECT count(*) FROM app.prompt_custom_field_value v WHERE v.project_id = f.project_id AND v.field_id = f.field_id) AS value_count
  FROM app.project_custom_field f
 WHERE f.project_id = :pid AND f.field_id = :fid"""

LOCK_FIELD_SQL = "SELECT f.field_id FROM app.project_custom_field f WHERE f.project_id = :pid AND f.field_id = :fid FOR UPDATE"

SAME_LABEL_SQL = "SELECT f.field_id FROM app.project_custom_field f WHERE f.project_id = :pid AND lower(f.label) = lower(:label) LIMIT 1"

INSERT_SQL = """
INSERT INTO app.project_custom_field (project_id, label, created_by) VALUES (:pid, :label, app.actor())
ON CONFLICT (project_id, label) DO NOTHING
RETURNING field_id"""

SET_ARCHIVED_SQL = """
UPDATE app.project_custom_field f SET archived = :a WHERE f.project_id = :pid AND f.field_id = :fid RETURNING f.field_id"""

DELETE_SQL = "DELETE FROM app.project_custom_field f WHERE f.project_id = :pid AND f.field_id = :fid RETURNING f.field_id"

LIVE_PROMPTS_SQL = """
SELECT p.prompt_id FROM app.prompt p
 WHERE p.project_id = :pid AND p.prompt_id = ANY(CAST(:ids AS uuid[])) AND p.deleted_at IS NULL
   FOR SHARE"""

UPSERT_SQL = """
INSERT INTO app.prompt_custom_field_value (project_id, prompt_id, field_id, value)
SELECT CAST(:pid AS uuid), x.id, CAST(:fid AS uuid), CAST(:v AS text) FROM unnest(CAST(:ids AS uuid[])) AS x(id)
ON CONFLICT (prompt_id, field_id) DO UPDATE SET value = EXCLUDED.value"""

CLEAR_SQL = """
DELETE FROM app.prompt_custom_field_value v WHERE v.project_id = :pid AND v.prompt_id = :id AND v.field_id = :fid"""
