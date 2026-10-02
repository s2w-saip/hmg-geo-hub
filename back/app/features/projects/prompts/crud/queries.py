"""projects.prompts.crud SQL(SQLAlchemy Core text). app 만 읽고 쓴다(rd·ing 없음, 사실 표 없음).

목록: prompt_project_live_idx(project_id, created_at) WHERE deleted_at IS NULL 키셋. 정렬 = created_at DESC, prompt_id DESC.
쓰기: app.prompt INSERT·UPDATE·DELETE 는 AFTER 트리거 tg_catalog_change 가 prompt_audit_log·judgment_change 를 남긴다(Q3, 앱 INSERT 금지).
"""
from __future__ import annotations

import uuid
from typing import Any

from app.core.pagination import Cursor, keyset_predicate
from app.core.sqlb import Binder

from .common import PROMPT_COLS

LIST_SORT = "created_at"
LIST_KEY_COLS = ("p.created_at", "p.prompt_id")
LIST_KEY_TYPES = ("timestamptz", "uuid")


def _filters(b: Binder, project_id: uuid.UUID, statuses: list[str], kind: str | None, q: str | None,
             custom: dict[str, list[str]]) -> list[str]:
    where = [f"p.project_id = {b.v(project_id)}", "p.deleted_at IS NULL"]
    if statuses:
        where.append(f"p.status = ANY({b.v(sorted(set(statuses)), 'text[]')})")
    if kind:
        where.append(f"p.kind = {b.v(kind)}")
    if q:
        # ILIKE 대신 strpos(lower): 사용자 입력의 % _ \ 를 패턴으로 해석하지 않는다(프로젝트 스코프 순차 검색, 저위험)
        where.append(f"strpos(lower(p.text), lower({b.v(q)})) > 0")
    for fid, vals in sorted(custom.items()):
        where.append("EXISTS (SELECT 1 FROM app.prompt_custom_field_value v WHERE v.project_id = p.project_id "
                     f"AND v.prompt_id = p.prompt_id AND v.field_id = {b.v(fid, 'uuid')} AND v.value = ANY({b.v(vals, 'text[]')}))")
    return where


def list_sql(project_id: uuid.UUID, *, statuses: list[str], kind: str | None, q: str | None, custom: dict[str, list[str]],
             cursor: Cursor | None, limit: int) -> tuple[str, dict[str, Any]]:
    b = Binder()
    where = _filters(b, project_id, statuses, kind, q, custom)
    ks = keyset_predicate(LIST_KEY_COLS, "desc", cursor, b)
    if ks:
        where.append(ks)
    sql = (f"SELECT {PROMPT_COLS} FROM app.prompt p WHERE {' AND '.join(where)} "
           f"ORDER BY p.created_at DESC, p.prompt_id DESC LIMIT {b.v(limit + 1, 'int4')}")
    return sql, b.params


def count_sql(project_id: uuid.UUID, *, statuses: list[str], kind: str | None, q: str | None,
              custom: dict[str, list[str]]) -> tuple[str, dict[str, Any]]:
    b = Binder()
    where = _filters(b, project_id, statuses, kind, q, custom)
    return f"SELECT count(*) AS n FROM app.prompt p WHERE {' AND '.join(where)}", b.params


PROJECT_FIELD_IDS_SQL = """
SELECT f.field_id FROM app.project_custom_field f WHERE f.project_id = :pid AND f.field_id = ANY(CAST(:ids AS uuid[]))"""

INSERT_SQL = """
INSERT INTO app.prompt (project_id, text, created_by, updated_by)
SELECT CAST(:pid AS uuid), t.text, app.actor(), app.actor()
  FROM unnest(CAST(:texts AS text[])) WITH ORDINALITY AS t(text, ord)
 ORDER BY t.ord
RETURNING prompt_id"""

DELETE_SQL = "DELETE FROM app.prompt p WHERE p.project_id = :pid AND p.prompt_id = :id"

# PATCH 가능 열(화이트리스트). 값은 바인드로만 넣는다.
PATCH_COLUMNS = ("text", "kind", "brand_code", "category", "prompt_type", "lang", "regions")


def patch_sql(project_id: uuid.UUID, prompt_id: uuid.UUID, changes: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    b = Binder()
    sets = []
    for col in PATCH_COLUMNS:
        if col in changes:
            cast = "text[]" if col == "regions" else None
            sets.append(f"{col} = {b.v(changes[col], cast)}")
    sets += ["updated_by = app.actor()", "updated_at = now()"]
    sql = (f"UPDATE app.prompt p SET {', '.join(sets)} WHERE p.project_id = {b.v(project_id)} AND p.prompt_id = {b.v(prompt_id)} "
           f"RETURNING {PROMPT_COLS}")
    return sql, b.params
