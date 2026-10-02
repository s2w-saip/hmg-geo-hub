"""projects.settings.engines SQL(app 만). 이력은 history_id(IDENTITY, 단조) 역순 키셋."""
from __future__ import annotations

LOCK = "SELECT ai_engines FROM app.project WHERE project_id = :pid AND kind = 'customer' FOR UPDATE"
SET_ENGINES = "UPDATE app.project SET ai_engines = CAST(:engines AS text[]), updated_at = now() WHERE project_id = :pid"
INSERT_HISTORY = """
INSERT INTO app.project_engine_history (project_id, engines, changed_by) VALUES (:pid, CAST(:engines AS text[]), :uid)
"""
SORT_COLS = ("h.history_id",)


def history_sql(keyset: str | None) -> str:
    where = "h.project_id = :pid" + (f" AND {keyset}" if keyset else "")
    return ("SELECT h.history_id, h.engines, h.changed_by, u.email::text AS changed_by_email, h.changed_at "
            "FROM app.project_engine_history h LEFT JOIN app.user_account u ON u.user_id = h.changed_by "
            f"WHERE {where} ORDER BY h.history_id DESC LIMIT :lim")
