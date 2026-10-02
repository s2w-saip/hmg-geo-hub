"""projects.prompts.candidates SQL(SQLAlchemy Core text). app 만(rd·ing·사실 표 없음).

목록: prompt_candidate_project_idx(project_id, created_at DESC) 키셋(created_at DESC, candidate_id DESC).
승격: 후보 → app.prompt(candidate_id 링크, draft). 원본 후보는 풀에 남는다(현행 selectFromCandidates, v22 §3-2 A-④).
"""
from __future__ import annotations

import uuid
from typing import Any

from app.core.pagination import Cursor, keyset_predicate
from app.core.sqlb import Binder

LIST_SORT = "created_at"
LIST_KEY_TYPES = ("timestamptz", "uuid")


def list_sql(project_id: uuid.UUID, cursor: Cursor | None, limit: int) -> tuple[str, dict[str, Any]]:
    b = Binder()
    where = [f"c.project_id = {b.v(project_id)}"]
    ks = keyset_predicate(("c.created_at", "c.candidate_id"), "desc", cursor, b)
    if ks:
        where.append(ks)
    sql = ("SELECT c.candidate_id, c.source, c.source_keyword, c.text, c.created_at FROM app.prompt_candidate c "
           f"WHERE {' AND '.join(where)} ORDER BY c.created_at DESC, c.candidate_id DESC LIMIT {b.v(limit + 1, 'int4')}")
    return sql, b.params


COUNT_SQL = "SELECT count(*) AS n FROM app.prompt_candidate c WHERE c.project_id = :pid"

SELECT_SQL = """
INSERT INTO app.prompt (project_id, candidate_id, text, created_by, updated_by)
SELECT c.project_id, c.candidate_id, c.text, app.actor(), app.actor()
  FROM app.prompt_candidate c
 WHERE c.project_id = :pid AND c.candidate_id = ANY(CAST(:ids AS uuid[]))
 ORDER BY c.created_at, c.candidate_id
RETURNING prompt_id, candidate_id"""

DELETE_ONE_SQL = "DELETE FROM app.prompt_candidate c WHERE c.project_id = :pid AND c.candidate_id = :cid RETURNING c.candidate_id"

DELETE_MANY_SQL = """
DELETE FROM app.prompt_candidate c
 WHERE c.project_id = :pid AND c.candidate_id = ANY(CAST(:ids AS uuid[]))
RETURNING c.candidate_id"""
