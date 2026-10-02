"""projects.members.audit(PJ-2) API 테스트: 키셋 페이지, 권한(활성 멤버·admin), 404 은폐, 빈 결과."""
from __future__ import annotations

import uuid

from app.features.projects.project.core.tests.helpers import add_member, create_project, fetch, purge, uniq
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, KIA_US, VENDOR, needs_db

pytestmark = needs_db


async def test_audit_keyset_and_permissions(client_as):
    pr = await create_project(client_as, name=uniq("aud"))
    pid = pr["project_id"]
    try:
        async with client_as(ADMIN) as c:
            r0 = await c.get(f"/v1/projects/{pid}/member-audit")
            assert r0.status_code == 200 and r0.json()["data"] == {"items": [], "next_cursor": None}
            for email in ("t-vendor@example.test", "t-kia-us@example.test", "t-kia-eu@example.test"):
                assert (await c.post(f"/v1/projects/{pid}/members", json={"email": email})).status_code == 201
            assert (await c.delete(f"/v1/projects/{pid}/members/{KIA_EU}")).status_code == 204
            p1 = (await c.get(f"/v1/projects/{pid}/member-audit", params={"limit": 3})).json()
            assert len(p1["data"]["items"]) == 3 and p1["data"]["next_cursor"] and p1["meta"]["page"]["limit"] == 3
            p2 = (await c.get(f"/v1/projects/{pid}/member-audit", params={"limit": 3, "cursor": p1["data"]["next_cursor"]})).json()
            assert len(p2["data"]["items"]) == 1 and p2["data"]["next_cursor"] is None
            got = [(i["action"], i["target_email"]) for i in p1["data"]["items"] + p2["data"]["items"]]
            exp = await fetch("SELECT l.action, u.email::text AS email FROM app.member_audit_log l JOIN app.user_account u "
                              "ON u.user_id = l.target_user_id WHERE l.project_id = $1 ORDER BY l.created_at DESC, l.audit_id DESC",
                              uuid.UUID(pid))
            assert got == [(e["action"], e["email"]) for e in exp] and got[0] == ("cancel_invite", "t-kia-eu@example.test")
            assert p1["data"]["items"][0]["actor_email"] == "t-admin@example.test"
            assert isinstance(p1["data"]["items"][0]["audit_id"], str)
            # 다른 프로젝트 커서 재사용·잘못된 limit
            other = await create_project(client_as, name=uniq("aud2"))
            try:
                r = await c.get(f"/v1/projects/{other['project_id']}/member-audit", params={"cursor": p1["data"]["next_cursor"]})
                assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
            finally:
                await purge(other["project_id"])
            assert (await c.get(f"/v1/projects/{pid}/member-audit", params={"limit": 201})).status_code == 422
        await add_member(pid, VENDOR, "viewer", "active")
        async with client_as(VENDOR) as c:                       # 활성 Viewer 는 열람 가능
            assert (await c.get(f"/v1/projects/{pid}/member-audit")).status_code == 200
        for uid in (KIA_US, HQ_HYUNDAI):                         # 대기 초대자·스코프 안 비멤버 = 404
            async with client_as(uid) as c:
                assert (await c.get(f"/v1/projects/{pid}/member-audit")).status_code == 404, uid
    finally:
        await purge(pid)
