"""projects.prompts.io SQL(SQLAlchemy Core text). app 만(rd·ing·사실 표 없음). 가져오기는 한 트랜잭션에서 배치 문장으로 쓴다."""
from __future__ import annotations

EXPORT_PROMPTS_SQL = """
SELECT p.prompt_id, p.text FROM app.prompt p
 WHERE p.project_id = :pid AND p.deleted_at IS NULL
 ORDER BY p.created_at, p.prompt_id"""

FIELDS_SQL = """
SELECT f.field_id, f.label, f.archived FROM app.project_custom_field f WHERE f.project_id = :pid ORDER BY f.created_at, f.field_id"""

VALUES_SQL = """
SELECT v.prompt_id, v.field_id, v.value FROM app.prompt_custom_field_value v WHERE v.project_id = :pid"""

EXISTING_SQL = """
SELECT p.prompt_id, p.text, p.status FROM app.prompt p
 WHERE p.project_id = :pid AND p.deleted_at IS NULL
   FOR UPDATE"""

INSERT_FIELD_SQL = """
INSERT INTO app.project_custom_field (project_id, label, created_by) VALUES (:pid, :label, app.actor())
ON CONFLICT (project_id, label) DO NOTHING
RETURNING field_id"""

FIELD_BY_LABEL_SQL = """
SELECT f.field_id FROM app.project_custom_field f WHERE f.project_id = :pid AND lower(f.label) = lower(:label)
 ORDER BY f.archived, f.created_at LIMIT 1"""

INSERT_PROMPTS_SQL = """
INSERT INTO app.prompt (project_id, text, created_by, updated_by)
SELECT CAST(:pid AS uuid), t.text, app.actor(), app.actor()
  FROM unnest(CAST(:texts AS text[])) WITH ORDINALITY AS t(text, ord)
 ORDER BY t.ord
RETURNING prompt_id, text"""

UPDATE_TEXTS_SQL = """
UPDATE app.prompt p SET text = x.t, updated_by = app.actor(), updated_at = now()
  FROM unnest(CAST(:ids AS uuid[]), CAST(:texts AS text[])) AS x(id, t)
 WHERE p.project_id = :pid AND p.prompt_id = x.id AND p.status = 'draft' AND p.deleted_at IS NULL"""

UPSERT_VALUES_SQL = """
INSERT INTO app.prompt_custom_field_value (project_id, prompt_id, field_id, value)
SELECT CAST(:pid AS uuid), x.p, x.f, x.v FROM unnest(CAST(:ps AS uuid[]), CAST(:fs AS uuid[]), CAST(:vs AS text[])) AS x(p, f, v)
ON CONFLICT (prompt_id, field_id) DO UPDATE SET value = EXCLUDED.value"""

CLEAR_VALUES_SQL = """
DELETE FROM app.prompt_custom_field_value v
 USING unnest(CAST(:ps AS uuid[]), CAST(:fs AS uuid[])) AS x(p, f)
 WHERE v.project_id = :pid AND v.prompt_id = x.p AND v.field_id = x.f"""
