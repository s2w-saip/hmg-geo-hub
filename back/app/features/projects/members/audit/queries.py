"""projects.members.audit SQL(app 만). member_audit_project_idx(project_id, created_at DESC) 키셋."""
from __future__ import annotations

SORT_COLS = ("l.created_at", "l.audit_id")


def list_sql(keyset: str | None) -> str:
    where = "l.project_id = :pid" + (f" AND {keyset}" if keyset else "")
    return ("SELECT l.audit_id, l.actor_id, a.email::text AS actor_email, l.target_user_id, t.email::text AS target_email, "
            "l.action, l.context, l.created_at FROM app.member_audit_log l "
            "LEFT JOIN app.user_account a ON a.user_id = l.actor_id LEFT JOIN app.user_account t ON t.user_id = l.target_user_id "
            f"WHERE {where} ORDER BY l.created_at DESC, l.audit_id DESC LIMIT :lim")
