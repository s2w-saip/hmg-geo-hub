"""projects.members.invites(PJ-2) API 테스트: 본인 대기 초대 수락·거절, 대기 목록, 404 은폐, 감사."""
from __future__ import annotations

import uuid

from app.features.projects.project.core.tests.helpers import add_member, create_project, fetch, purge, uniq
from tests.support import ADMIN, KIA_EU, KIA_US, VENDOR, needs_db

pytestmark = needs_db


async def test_accept_reject_and_pending_list(client_as):
    a = await create_project(client_as, name=uniq("inva"), brand_code="Kia", country_code="DE")
    b = await create_project(client_as, name=uniq("invb"))
    await add_member(a["project_id"], KIA_US, "viewer", "pending")
    await add_member(b["project_id"], KIA_US, "viewer", "pending")
    await add_member(b["project_id"], VENDOR, "viewer", "active")
    try:
        async with client_as(KIA_US) as c:
            r = await c.get("/v1/me/project-invites", params={"surface": "global"})
            assert r.status_code == 200 and r.json()["meta"]["ignored_filters"] == ["surface"]
            mine = {i["project_id"]: i for i in r.json()["data"]["items"]}
            assert {a["project_id"], b["project_id"]} <= set(mine)
            assert mine[a["project_id"]]["project_name"] == a["name"] and mine[a["project_id"]]["invited_by_email"] == "t-admin@example.test"
            exp = await fetch("SELECT project_id FROM app.project_member WHERE user_id = $1 AND status = 'pending'", KIA_US)
            assert {str(e["project_id"]) for e in exp} == set(mine)
            assert (await c.post(f"/v1/projects/{a['project_id']}/members/me/accept")).status_code == 204
            assert (await c.post(f"/v1/projects/{b['project_id']}/members/me/reject")).status_code == 204
            # 두 번째 시도·없는 프로젝트는 404 no_pending_invite
            for pid, act in ((a["project_id"], "accept"), (b["project_id"], "reject"), (uuid.uuid4(), "accept")):
                r = await c.post(f"/v1/projects/{pid}/members/me/{act}")
                assert r.status_code == 404 and r.json()["error"]["code"] == "no_pending_invite"
            left = {i["project_id"] for i in (await c.get("/v1/me/project-invites")).json()["data"]["items"]}
            assert a["project_id"] not in left and b["project_id"] not in left
        st = await fetch("SELECT status::text AS status, accepted_at IS NOT NULL AS acc FROM app.project_member "
                         "WHERE project_id = $1 AND user_id = $2", uuid.UUID(a["project_id"]), KIA_US)
        assert st == [{"status": "active", "acc": True}]
        assert await fetch("SELECT 1 FROM app.project_member WHERE project_id = $1 AND user_id = $2", uuid.UUID(b["project_id"]), KIA_US) == []
        for pr, act in ((a, "accept"), (b, "reject")):
            aud = await fetch("SELECT actor_id, target_user_id, action FROM app.member_audit_log WHERE project_id = $1",
                              uuid.UUID(pr["project_id"]))
            assert aud == [{"actor_id": KIA_US, "target_user_id": KIA_US, "action": act}]
        # 활성 멤버(VENDOR)는 수락할 대기 초대가 없다, 남의 초대를 대신 수락할 수 없다
        await add_member(a["project_id"], KIA_EU, "viewer", "pending")
        async with client_as(VENDOR) as c:
            assert (await c.post(f"/v1/projects/{b['project_id']}/members/me/accept")).status_code == 404
            assert (await c.post(f"/v1/projects/{a['project_id']}/members/me/accept")).status_code == 404
        still = await fetch("SELECT status::text AS s FROM app.project_member WHERE project_id = $1 AND user_id = $2",
                            uuid.UUID(a["project_id"]), KIA_EU)
        assert still == [{"s": "pending"}]
    finally:
        await purge(a["project_id"], b["project_id"])


async def test_empty_and_auth(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/me/project-invites")
    exp = await fetch("SELECT 1 FROM app.project_member WHERE user_id = $1 AND status = 'pending'", ADMIN)
    assert r.status_code == 200 and len(r.json()["data"]["items"]) == len(exp)
    async with client_as(None) as c:
        assert (await c.get("/v1/me/project-invites")).status_code == 401
        assert (await c.post(f"/v1/projects/{uuid.uuid4()}/members/me/accept")).status_code == 401
