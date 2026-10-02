"""projects.project.core 읽기·쓰기 SQL(SQLAlchemy Core text). app 만 읽는다(rd 사실 표 없음).

목록: 비관리자는 project_member_user_idx(user_id, status) 로 진입, admin 은 전체. 정렬 (created_at DESC, project_id DESC) 키셋.
카드 수치(활성 멤버 수·프롬프트 수)는 페이지 행 project_id = ANY(:ids) 한 번씩(현행 projects/page.tsx 배치 계승).
"""
from __future__ import annotations

from app.features.projects.project.core.shared import PROJECT_COLS

LIST_SORT_COLS = ("p.created_at", "p.project_id")


def list_sql(*, admin: bool, has_q: bool, keyset: str | None) -> str:
    join = "" if admin else ("JOIN app.project_member pm ON pm.project_id = p.project_id AND pm.user_id = :uid "
                             "AND pm.status = 'active'")
    where = ["p.kind = 'customer'"]
    if has_q:
        where.append("p.name ILIKE :q ESCAPE '\\'")
    if keyset:
        where.append(keyset)
    return (f"SELECT {PROJECT_COLS}, me.role::text AS my_role FROM app.project p {join} "
            "LEFT JOIN app.project_member me ON me.project_id = p.project_id AND me.user_id = :uid AND me.status = 'active' "
            f"WHERE {' AND '.join(where)} ORDER BY p.created_at DESC, p.project_id DESC LIMIT :lim")


CARD_COUNTS = """
SELECT x.pid AS project_id,
       (SELECT count(*) FROM app.project_member m WHERE m.project_id = x.pid AND m.status = 'active') AS active_members,
       (SELECT count(*) FROM app.prompt q WHERE q.project_id = x.pid AND q.deleted_at IS NULL) AS prompts,
       (SELECT count(*) FROM app.prompt q WHERE q.project_id = x.pid AND q.deleted_at IS NULL
                                           AND q.status IN ('queued', 'running')) AS in_flight
  FROM unnest(CAST(:ids AS uuid[])) AS x(pid)
"""

DETAIL = f"""
SELECT {PROJECT_COLS}, me.role::text AS my_role
  FROM app.project p
  LEFT JOIN app.project_member me ON me.project_id = p.project_id AND me.user_id = :uid AND me.status = 'active'
 WHERE p.project_id = :pid AND p.kind = 'customer'
"""

# 상세 요약(BG-38). 프로젝트 1건 기준 상관 서브쿼리: prompt_project_live_idx(project_id, created_at) WHERE deleted_at IS NULL,
# project_member PK(project_id, user_id), tracked_competitor_one_target(project_id) WHERE is_target 로 진입한다.
DETAIL_SUMMARY = """
SELECT q.n_draft, q.n_queued, q.n_running, q.n_done, q.n_failed, q.n_paused, q.last_run_at,
       (SELECT count(*) FROM app.prompt_candidate c WHERE c.project_id = :pid) AS candidate_count,
       (SELECT count(*) FROM app.project_member m WHERE m.project_id = :pid AND m.status = 'active') AS active_member_count,
       (SELECT t.brand_name FROM app.project_tracked_competitor t WHERE t.project_id = :pid AND t.is_target LIMIT 1) AS target_brand
  FROM (SELECT count(*) FILTER (WHERE p.status = 'draft')   AS n_draft,
               count(*) FILTER (WHERE p.status = 'queued')  AS n_queued,
               count(*) FILTER (WHERE p.status = 'running') AS n_running,
               count(*) FILTER (WHERE p.status = 'done')    AS n_done,
               count(*) FILTER (WHERE p.status = 'failed')  AS n_failed,
               count(*) FILTER (WHERE p.status = 'paused')  AS n_paused,
               max(p.updated_at) FILTER (WHERE p.status IN ('running', 'done')) AS last_run_at
          FROM app.prompt p WHERE p.project_id = :pid AND p.deleted_at IS NULL) q
"""

# 최근 수정 프롬프트(검증 D4, 현행 recentPrompts: 삭제 제외 프롬프트를 updatedAt 내림차순 상위 5). 목록 API 는 created_at 순만
# 주므로 이 필드가 없으면 어댑터가 전량 순회해야 한다. 동률은 prompt_id 내림차순(결정적 순서, 현행은 목록 순 안정 정렬).
RECENT_PROMPTS = """
SELECT p.prompt_id, p.text, p.status, p.updated_at
  FROM app.prompt p
 WHERE p.project_id = :pid AND p.deleted_at IS NULL
 ORDER BY p.updated_at DESC, p.prompt_id DESC
 LIMIT :lim
"""

# Scope 프로젝트 id 해석(BG-36). 둘 다 scope_project_id UNIQUE 인덱스 1행 조회.
PROJECT_BY_SCOPE = "SELECT p.project_id, p.kind FROM app.project p WHERE p.scope_project_id = :spid"
SITE_BY_SCOPE = "SELECT s.brand_code, s.country_code FROM app.website_site s WHERE s.scope_project_id = :spid"

INSERT_PROJECT = f"""
INSERT INTO app.project AS p (kind, name, description, domain, brand_code, country_code, ai_engines, created_by)
VALUES ('customer', :name, :description, :domain, :brand, :country, CAST(:engines AS text[]), :uid)
RETURNING {PROJECT_COLS}
"""

INSERT_OWNER = """
INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at)
VALUES (:pid, :uid, 'owner', 'active', :uid, now())
"""

INSERT_OWNED_BASE = """
INSERT INTO app.project_owned_base (project_id, base_url, base_norm, created_by) VALUES (:pid, :url, :norm, :uid)
"""

INSERT_ENGINE_HISTORY = """
INSERT INTO app.project_engine_history (project_id, engines, changed_by) VALUES (:pid, CAST(:engines AS text[]), :uid)
"""

LOCK_PROJECT = f"SELECT {PROJECT_COLS} FROM app.project p WHERE p.project_id = :pid AND p.kind = 'customer' FOR UPDATE"

DELETE_TRACKED_BRAND = "DELETE FROM app.project_tracked_brand WHERE project_id = :pid AND canonical_name = :name"

DELETE_PROJECT = "DELETE FROM app.project WHERE project_id = :pid AND kind = 'customer'"


def update_sql(sets: list[str]) -> str:
    """sets 는 코드 상수 열 조각만(사용자 입력 금지)."""
    return (f"UPDATE app.project p SET {', '.join(sets)}, updated_at = now() WHERE p.project_id = :pid AND p.kind = 'customer' "
            f"RETURNING {PROJECT_COLS}")
