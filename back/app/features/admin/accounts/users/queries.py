"""admin.accounts.users 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

계정·권한 표(app.user_account 수백 행)만 읽고 쓴다. 사실 표·rd 는 읽지 않는다. 권한 감사(app.permission_audit_log)는 DB 트리거
app.tg_user_account_audit 가 유일한 쓰기 주체다(DB-v2.3 P31): 앱은 행위자 GUC 가 심긴 api_rw 트랜잭션에서 user_account 만 쓴다.
"""

_USER_COLS = """
SELECT u.user_id, u.email::text AS email, u.display_name, u.role::text AS role, u.operator::text AS operator, u.scope_all,
       u.scope_brands, u.scope_regions, u.scope_countries, u.menu_groups::text[] AS menu_groups, u.is_qa_reviewer, u.status,
       u.row_version, u.created_at, u.updated_at
  FROM app.user_account u
"""

# 목록: (created_at, user_id) DESC 키셋. {keyset} = core.pagination.keyset_predicate 조각 또는 true
LIST_SQL = _USER_COLS + """
 WHERE (CAST(:role AS text) IS NULL OR u.role::text = CAST(:role AS text))
   AND (CAST(:operator AS text) IS NULL OR u.operator::text = CAST(:operator AS text))
   AND (CAST(:status AS text) IS NULL OR u.status = CAST(:status AS text))
   AND (CAST(:menu_group AS text) IS NULL OR CAST(:menu_group AS text) = ANY(u.menu_groups::text[]))
   AND (CAST(:pat AS text) IS NULL OR u.email::text ILIKE CAST(:pat AS text) ESCAPE '\\'
        OR u.display_name ILIKE CAST(:pat AS text) ESCAPE '\\')
   AND {keyset}
 ORDER BY u.created_at DESC, u.user_id DESC
 LIMIT CAST(:lim AS int4)
"""

ONE_SQL = _USER_COLS + " WHERE u.user_id = CAST(:uid AS uuid)"
LOCK_SQL = _USER_COLS + " WHERE u.user_id = CAST(:uid AS uuid) FOR UPDATE"
EMAIL_TAKEN_SQL = "SELECT 1 AS x FROM app.user_account WHERE email = CAST(:email AS citext)"

# 실효 admin = role admin ∧ status active ∧ (menu_groups 제한 없음 ∨ 'admin' ∈ menu_groups). admin 메뉴가 빠지면
# require_menu_group('admin') 에 막혀 관리 화면에 못 들어오므로 사실상 강등이다(검증 D1).
_EFFECTIVE_ADMIN = "u.role = 'admin' AND u.status = 'active' AND (u.menu_groups IS NULL OR 'admin' = ANY(u.menu_groups::text[]))"

# 마지막 admin 보호: 실효 admin 을 잠그고(동시 강등 경합 방지) 대상 밖 수를 센다
OTHER_ADMINS_SQL = f"""
SELECT count(*)::int AS n FROM (
  SELECT u.user_id FROM app.user_account u WHERE {_EFFECTIVE_ADMIN} FOR UPDATE) a
 WHERE a.user_id <> CAST(:uid AS uuid)
"""

OTHER_ADMINS_RO_SQL = f"""
SELECT count(*)::int AS n FROM app.user_account u
 WHERE {_EFFECTIVE_ADMIN} AND u.user_id <> CAST(:uid AS uuid)
"""

INSERT_SQL = """
INSERT INTO app.user_account (user_id, email, display_name, role, operator, scope_all, scope_brands, scope_regions, scope_countries,
                              menu_groups, is_qa_reviewer, status)
VALUES (CAST(:uid AS uuid), CAST(:email AS citext), :display_name, CAST(:role AS app.user_role), CAST(:operator AS app.operator_scope),
        :scope_all, CAST(:scope_brands AS text[]), CAST(:scope_regions AS text[]), CAST(:scope_countries AS text[]),
        CAST(:menu_groups AS app.menu_group[]), :is_qa_reviewer, 'active')
"""

UPDATE_SQL = """
UPDATE app.user_account SET display_name = :display_name, role = CAST(:role AS app.user_role),
       operator = CAST(:operator AS app.operator_scope), scope_all = :scope_all, scope_brands = CAST(:scope_brands AS text[]),
       scope_regions = CAST(:scope_regions AS text[]), scope_countries = CAST(:scope_countries AS text[]),
       menu_groups = CAST(:menu_groups AS app.menu_group[]), is_qa_reviewer = :is_qa_reviewer, status = :status,
       row_version = row_version + 1, updated_at = now()
 WHERE user_id = CAST(:uid AS uuid) AND row_version = CAST(:rv AS int4)
RETURNING user_id
"""

# 삭제 전 참조 확인(ON DELETE 없는 FK: project.created_by, project_member.invited_by, qa_* 검수 기록). 있으면 정지로 안내한다.
REFS_SQL = """
SELECT (SELECT count(*) FROM app.project p WHERE p.created_by = CAST(:uid AS uuid))::int AS projects_created,
       (SELECT count(*) FROM app.project_member m WHERE m.invited_by = CAST(:uid AS uuid) AND m.user_id <> CAST(:uid AS uuid))::int AS invites_sent,
       (SELECT count(*) FROM app.qa_review_session s WHERE s.user_id = CAST(:uid AS uuid))::int AS qa_sessions,
       (SELECT count(*) FROM app.qa_answer_review r WHERE r.reviewer_id = CAST(:uid AS uuid))::int AS qa_reviews,
       (SELECT count(*) FROM app.qa_review_note n WHERE n.reviewer_id = CAST(:uid AS uuid))::int AS qa_notes
"""

OWNED_PROJECTS_SQL = """
SELECT m.project_id FROM app.project_member m
 WHERE m.user_id = CAST(:uid AS uuid) AND m.role = 'owner' AND m.status = 'active'
"""
DELETE_SQL = "DELETE FROM app.user_account WHERE user_id = CAST(:uid AS uuid) RETURNING user_id"
ORPHANS_SQL = """
SELECT p FROM unnest(CAST(:pids AS uuid[])) p
 WHERE NOT EXISTS (SELECT 1 FROM app.project_member m WHERE m.project_id = p AND m.role = 'owner' AND m.status = 'active')
"""
SUCCEED_SQL = """
INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at)
VALUES (CAST(:pid AS uuid), CAST(:actor AS uuid), 'owner', 'active', CAST(:actor AS uuid), now())
ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner', status = 'active', accepted_at = coalesce(app.project_member.accepted_at, now())
"""
MEMBER_AUDIT_SQL = """
INSERT INTO app.member_audit_log (project_id, actor_id, target_user_id, action, context)
VALUES (CAST(:pid AS uuid), CAST(:actor AS uuid), CAST(:actor AS uuid), 'promote', :ctx)
"""

AUDIT_EXISTS_SQL = """
SELECT EXISTS (SELECT 1 FROM app.user_account WHERE user_id = CAST(:uid AS uuid))
    OR EXISTS (SELECT 1 FROM app.permission_audit_log WHERE target_user_id = CAST(:uid AS uuid)) AS found
"""
# 권한 이력: permission_audit_target_idx (target_user_id, created_at DESC) 범위. {keyset} = (created_at, audit_id) DESC
AUDIT_SQL = """
SELECT l.audit_id, l.change_type, l.before, l.after, l.actor_id, a.email::text AS actor_email, l.created_at
  FROM app.permission_audit_log l
  LEFT JOIN app.user_account a ON a.user_id = l.actor_id
 WHERE l.target_user_id = CAST(:uid AS uuid) AND {keyset}
 ORDER BY l.created_at DESC, l.audit_id DESC
 LIMIT CAST(:lim AS int4)
"""
