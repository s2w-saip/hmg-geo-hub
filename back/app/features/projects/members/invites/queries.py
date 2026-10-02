"""projects.members.invites SQL(app 만). 대기 초대 = project_member_user_idx(user_id, status) 진입."""
from __future__ import annotations

ACCEPT = """
UPDATE app.project_member pm SET status = 'active', accepted_at = now()
  FROM app.project p
 WHERE pm.project_id = :pid AND pm.user_id = :uid AND pm.status = 'pending'
   AND p.project_id = pm.project_id AND p.kind = 'customer'
RETURNING pm.user_id
"""

REJECT = """
DELETE FROM app.project_member pm USING app.project p
 WHERE pm.project_id = :pid AND pm.user_id = :uid AND pm.status = 'pending'
   AND p.project_id = pm.project_id AND p.kind = 'customer'
RETURNING pm.user_id
"""

MY_PENDING = """
SELECT pm.project_id, p.name AS project_name, p.brand_code, p.country_code, pm.role::text AS role, pm.invited_by,
       ib.email::text AS invited_by_email, pm.invited_at
  FROM app.project_member pm
  JOIN app.project p ON p.project_id = pm.project_id AND p.kind = 'customer'
  LEFT JOIN app.user_account ib ON ib.user_id = pm.invited_by
 WHERE pm.user_id = :uid AND pm.status = 'pending'
 ORDER BY pm.invited_at DESC, pm.project_id
"""
