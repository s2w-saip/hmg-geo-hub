"""projects.settings.owned_bases SQL(app 만). PK(project_id, base_norm)."""
from __future__ import annotations

OB_COLS = "b.base_url, b.base_norm, b.label, b.created_by, b.created_at"

LIST = f"SELECT {OB_COLS} FROM app.project_owned_base b WHERE b.project_id = :pid ORDER BY b.created_at, b.base_url"

INSERT = f"""
INSERT INTO app.project_owned_base AS b (project_id, base_url, base_norm, label, created_by)
VALUES (:pid, :url, :norm, :label, :uid)
ON CONFLICT (project_id, base_norm) DO NOTHING
RETURNING {OB_COLS}
"""

DELETE = "DELETE FROM app.project_owned_base WHERE project_id = :pid AND base_norm = :norm RETURNING base_norm"

DOMAIN = "SELECT domain FROM app.project WHERE project_id = :pid FOR UPDATE"
