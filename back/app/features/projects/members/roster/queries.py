"""projects.members.roster SQL(app 만). 멤버 목록은 PK(project_id, user_id) 스캔 + user_account PK 조인 2회."""
from __future__ import annotations

MEMBER_COLS = ("pm.user_id, ua.email::text AS email, ua.display_name, pm.role::text AS role, pm.status::text AS status, "
               "pm.invited_by, ib.email::text AS invited_by_email, pm.invited_at, pm.accepted_at")
MEMBER_FROM = ("FROM app.project_member pm JOIN app.user_account ua ON ua.user_id = pm.user_id "
               "LEFT JOIN app.user_account ib ON ib.user_id = pm.invited_by")

LIST = f"""
SELECT {MEMBER_COLS} {MEMBER_FROM}
 WHERE pm.project_id = :pid
 ORDER BY pm.role, pm.invited_at, pm.user_id
"""

ONE = f"SELECT {MEMBER_COLS} {MEMBER_FROM} WHERE pm.project_id = :pid AND pm.user_id = :uid"

INVITEE = "SELECT user_id FROM app.user_account WHERE email = :email AND status = 'active'"

EXISTING = "SELECT status::text AS status FROM app.project_member WHERE project_id = :pid AND user_id = :uid"

INSERT_INVITE = """
INSERT INTO app.project_member (project_id, user_id, role, status, invited_by)
VALUES (:pid, :uid, 'viewer', 'pending', :actor)
ON CONFLICT (project_id, user_id) DO NOTHING
RETURNING user_id
"""

LOCK_TARGET = """
SELECT role::text AS role, status::text AS status FROM app.project_member
 WHERE project_id = :pid AND user_id = :uid FOR UPDATE
"""

LOCK_ACTIVE_OWNERS = """
SELECT user_id FROM app.project_member
 WHERE project_id = :pid AND role = 'owner' AND status = 'active' ORDER BY user_id FOR UPDATE
"""

SET_ROLE = "UPDATE app.project_member SET role = CAST(:role AS app.member_role) WHERE project_id = :pid AND user_id = :uid"

DELETE_MEMBER = "DELETE FROM app.project_member WHERE project_id = :pid AND user_id = :uid"

AUDIT = """
INSERT INTO app.member_audit_log (project_id, actor_id, target_user_id, action, context)
VALUES (:pid, :actor, :target, :action, :context)
"""
