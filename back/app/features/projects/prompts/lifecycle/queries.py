"""projects.prompts.lifecycle SQL(SQLAlchemy Core text).

영향 미리보기(api_ro, 모듈-프로젝트 §6): 프로젝트 표면(surface 3) 한정.
  ① 프롬프트 키: rd.dim_prompt(prompt_id UNIQUE) = app.prompt.scope_prompt_id, 이 프로젝트의 rd.dim_project 키로 한정(다른 프로젝트 키 누출 0).
  ② 창: 이 프로젝트의 전 회차(rd.cycle cycle_project_idx) → core.cycles.Window.where 로 사실 표 3술어(surface·round_date·cyc_key).
     숨김·노출일과 무관하게 전부 센다(삭제·중지 영향 = 저장된 전 이력).
  ③ 카운트 한 문장: rd.answer(answer_prompt_idx) · rd.answer_brand_p(ab_p_proj_idx) · rd.citation_p(cit_p_proj_idx).
라이프사이클 쓰기: app.prompt UPDATE(status·deleted_at) + outbox. 감사·judgment_change 는 트리거(Q3).
"""
from __future__ import annotations

from typing import Any

from app.core.cycles import Window
from app.core.sqlb import Binder

CYCLES_SQL = """
SELECT c.cyc_key, c.project_key, c.round_date FROM rd.cycle c
 WHERE c.surface = CAST(:sf AS int2) AND c.project_key = ANY(CAST(:pks AS int2[]))"""

PROMPT_KEY_SQL = """
SELECT d.prompt_key FROM rd.dim_prompt d
 WHERE d.prompt_id = :sp AND d.surface = CAST(:sf AS int2) AND d.project_key = ANY(CAST(:pks AS int2[]))"""


def impact_sql(w: Window, prompt_key: int, project_keys: tuple[int, ...]) -> tuple[str, dict[str, Any]]:
    b = Binder()
    keys = tuple(sorted({c.cyc_key for c in w.cycles}))          # 숨김 무관 전 회차(영향 = 저장된 전 이력)
    pk = b.v(prompt_key, "int4")
    pks = b.ints(project_keys, "int2")
    wa = " AND ".join(w.where("a", "row", b, keys=keys))
    wb = " AND ".join(w.where("ab", "row", b, keys=keys))
    wc = " AND ".join(w.where("c", "row", b, keys=keys))
    sql = (f"SELECT (SELECT count(*) FROM rd.answer a WHERE {wa} AND a.prompt_key = {pk} AND a.project_key = ANY({pks})) AS answers, "
           f"(SELECT count(*) FROM rd.answer_brand ab WHERE {wb} AND ab.prompt_key = {pk} AND ab.project_key = ANY({pks})) AS mentions, "
           f"(SELECT count(*) FROM rd.citation c WHERE {wc} AND c.prompt_key = {pk} AND c.project_key = ANY({pks})) AS citations")
    return sql, b.params


PAUSE_SQL = """
UPDATE app.prompt p SET status = 'paused', updated_by = app.actor(), updated_at = now()
 WHERE p.project_id = :pid AND p.prompt_id = :id"""

RESUME_SQL = """
UPDATE app.prompt p SET status = :st, updated_by = app.actor(), updated_at = now()
 WHERE p.project_id = :pid AND p.prompt_id = :id"""

SOFT_DELETE_SQL = """
UPDATE app.prompt p SET deleted_at = now(), updated_by = app.actor(), updated_at = now()
 WHERE p.project_id = :pid AND p.prompt_id = :id"""
