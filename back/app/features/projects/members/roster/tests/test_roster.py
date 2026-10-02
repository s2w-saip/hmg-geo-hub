"""projects.members.roster(PJ-2) API 테스트: 목록·초대·역할 변경·제거와 감사 1건 불변식, 권한·404 은폐, 롤백."""
from __future__ import annotations

import uuid

from app.features.projects.project.core.tests.helpers import add_member, create_project, fetch, fetchval, purge, uniq
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, ROOT_PROJECT, VENDOR, needs_db

pytestmark = needs_db
AUDIT_SQL = "SELECT actor_id, target_user_id, action, context FROM app.member_audit_log WHERE project_id = $1 ORDER BY audit_id"


async def test_list_shape_order_and_visibility(client_as):
    pr = await create_project(client_as, name=uniq("ros"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "viewer", "active")
    await add_member(pid, KIA_US, "viewer", "pending")
    try:
        async with client_as(VENDOR) as c:
            r = await c.get(f"/v1/projects/{pid}/members", params={"country": "US"})
        assert r.status_code == 200 and r.json()["meta"]["ignored_filters"] == ["country"]
        items = r.json()["data"]["items"]
        exp = await fetch("SELECT user_id, role::text AS role, status::text AS status FROM app.project_member WHERE project_id = $1 "
                          "ORDER BY role, invited_at, user_id", uuid.UUID(pid))
        assert [(uuid.UUID(i["user_id"]), i["role"], i["status"]) for i in items] == [(e["user_id"], e["role"], e["status"]) for e in exp]
        assert items[0]["role"] == "owner" and items[0]["email"] == "t-admin@example.test"
        assert {i["status"] for i in items} == {"active", "pending"}
        # 스코프 안 비멤버(HQ)도 멤버 목록은 404(존재 은닉), 초대 대기자도 404, 스코프 밖 404
        for uid in (HQ_HYUNDAI, KIA_US, KIA_EU):
            async with client_as(uid) as c:
                assert (await c.get(f"/v1/projects/{pid}/members")).status_code == 404, uid
        async with client_as(HQ_HYUNDAI) as c:
            assert (await c.get(f"/v1/projects/{CUST_PROJECT}/members")).status_code == 404
        async with client_as(ADMIN) as c:
            assert (await c.get(f"/v1/projects/{ROOT_PROJECT}/members")).status_code == 404
    finally:
        await purge(pid)


async def test_invite_rules_and_audit(client_as):
    pr = await create_project(client_as, name=uniq("inv"))
    pid = pr["project_id"]
    try:
        async with client_as(ADMIN) as c:
            r = await c.post(f"/v1/projects/{pid}/members", json={"email": "  T-Vendor@Example.test "})
            assert r.status_code == 201, r.text
            d = r.json()["data"]
            assert d["user_id"] == str(VENDOR) and d["role"] == "viewer" and d["status"] == "pending" and d["accepted_at"] is None
            assert d["invited_by_email"] == "t-admin@example.test"
            for email, st, code in (("t-vendor@example.test", 409, "already_invited"), ("t-admin@example.test", 400, "self_invite"),
                                    ("nobody@example.test", 404, "invitee_not_found"), ("t-susp@example.test", 404, "invitee_not_found")):
                r = await c.post(f"/v1/projects/{pid}/members", json={"email": email})
                assert r.status_code == st and r.json()["error"]["code"] == code, email
            assert (await c.post(f"/v1/projects/{pid}/members", json={"email": "not-an-email"})).status_code == 422
        assert await fetch(AUDIT_SQL, uuid.UUID(pid)) == [
            {"actor_id": ADMIN, "target_user_id": VENDOR, "action": "invite", "context": "role=viewer"}]
        # Viewer(비 Owner)는 초대 불가
        await add_member(pid, KIA_US, "viewer", "active")
        async with client_as(KIA_US) as c:
            r = await c.post(f"/v1/projects/{pid}/members", json={"email": "t-kia-eu@example.test"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"
    finally:
        await purge(pid)


async def test_role_change_last_owner_guard(client_as):
    pr = await create_project(client_as, name=uniq("role"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "viewer", "active")
    await add_member(pid, KIA_US, "viewer", "pending")
    try:
        async with client_as(ADMIN) as c:
            r = await c.patch(f"/v1/projects/{pid}/members/{ADMIN}", json={"role": "viewer"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "last_owner_cannot_demote"
            r = await c.patch(f"/v1/projects/{pid}/members/{KIA_US}", json={"role": "owner"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "not_active"
            r = await c.patch(f"/v1/projects/{pid}/members/{VENDOR}", json={"role": "viewer"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "already_that_role"
            r = await c.patch(f"/v1/projects/{pid}/members/{uuid.uuid4()}", json={"role": "owner"})
            assert r.status_code == 404 and r.json()["error"]["code"] == "member_not_found"
            assert (await c.patch(f"/v1/projects/{pid}/members/{VENDOR}", json={"role": "admin"})).status_code == 422
            r = await c.patch(f"/v1/projects/{pid}/members/{VENDOR}", json={"role": "owner"})
            assert r.status_code == 200 and r.json()["data"]["role"] == "owner"
            r = await c.patch(f"/v1/projects/{pid}/members/{ADMIN}", json={"role": "viewer"})     # 이제 Owner 2명 → 강등 가능
            assert r.status_code == 200 and r.json()["data"]["role"] == "viewer"
        roles = await fetch("SELECT user_id, role::text AS role FROM app.project_member WHERE project_id = $1 AND status = 'active' "
                            "ORDER BY user_id", uuid.UUID(pid))
        assert {(x["user_id"], x["role"]) for x in roles} == {(ADMIN, "viewer"), (VENDOR, "owner")}
        acts = [(a["action"], a["context"]) for a in await fetch(AUDIT_SQL, uuid.UUID(pid))]
        assert acts == [("promote", "viewer->owner"), ("demote", "owner->viewer")]      # 실패한 시도는 감사 0건
    finally:
        await purge(pid)


async def test_remove_cancel_and_guards(client_as):
    pr = await create_project(client_as, name=uniq("rm"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "viewer", "active")
    await add_member(pid, KIA_US, "viewer", "pending")
    await add_member(pid, KIA_EU, "owner", "active")
    try:
        async with client_as(KIA_EU) as c:                     # Owner 가 다른 Owner 를 제거하려 하면 409, 본인 제거 409(Owner)
            r = await c.delete(f"/v1/projects/{pid}/members/{ADMIN}")
            assert r.status_code == 409 and r.json()["error"]["code"] == "cannot_remove_owner"
        async with client_as(VENDOR) as c:                     # Viewer 는 제거 권한 없음
            assert (await c.delete(f"/v1/projects/{pid}/members/{KIA_US}")).status_code == 403
        async with client_as(ADMIN) as c:
            assert (await c.delete(f"/v1/projects/{pid}/members/{KIA_US}")).status_code == 204     # pending → 초대 취소
            assert (await c.delete(f"/v1/projects/{pid}/members/{VENDOR}")).status_code == 204     # active viewer → 제거
            r = await c.delete(f"/v1/projects/{pid}/members/{VENDOR}")
            assert r.status_code == 404 and r.json()["error"]["code"] == "member_not_found"
        await add_member(pid, ADMIN, "viewer", "active")       # 자기 자신(Viewer) 제거 금지 확인용
        async with client_as(ADMIN) as c:
            r = await c.delete(f"/v1/projects/{pid}/members/{ADMIN}")
            assert r.status_code == 400 and r.json()["error"]["code"] == "cannot_remove_self"
        left = await fetch("SELECT user_id FROM app.project_member WHERE project_id = $1 ORDER BY user_id", uuid.UUID(pid))
        assert {x["user_id"] for x in left} == {ADMIN, KIA_EU}
        acts = [(a["action"], a["target_user_id"], a["context"]) for a in await fetch(AUDIT_SQL, uuid.UUID(pid))]
        assert acts == [("cancel_invite", KIA_US, None), ("remove", VENDOR, "role=viewer")]
        assert await fetchval("SELECT count(*) FROM app.member_audit_log WHERE project_id = $1", uuid.UUID(pid)) == 2
    finally:
        await purge(pid)


async def test_invite_duplicate_codes_split_active_pending(client_as):
    """U9-1(fe-u9 요청 1): 초대 중복 409 를 코드로 가른다. active = already_member, pending = already_invited. details.status 는 호환용.
    실패한 초대는 감사 0건."""
    pr = await create_project(client_as, name=uniq("dup"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "viewer", "active")
    await add_member(pid, KIA_US, "viewer", "pending")
    try:
        async with client_as(ADMIN) as c:
            r = await c.post(f"/v1/projects/{pid}/members", json={"email": "t-vendor@example.test"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "already_member" and r.json()["error"]["details"] == {"status": "active"}
            r = await c.post(f"/v1/projects/{pid}/members", json={"email": "t-kia-us@example.test"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "already_invited", r.text
            assert r.json()["error"]["details"] == {"status": "pending"}
        assert await fetch(AUDIT_SQL, uuid.UUID(pid)) == []
    finally:
        await purge(pid)


async def test_invite_race_rereads_winner_status(monkeypatch):
    """경합 경로: INSERT … ON CONFLICT DO NOTHING 이 0행이면 먼저 들어간 행을 다시 읽어 코드를 고른다(예전: details 없는 already_member).
    다시 읽어도 없으면(그 사이 취소) 409 retry_conflict."""
    import pytest

    from app.core.errors import ApiError
    from app.features.projects.members.roster import queries as Q
    from app.features.projects.members.roster import service as S

    async def allow(*_a, **_k):
        return None

    monkeypatch.setattr(S, "project_access", allow)

    class P:
        user_id = ADMIN

    for later, code in (({"status": "pending"}, "already_invited"), ({"status": "active"}, "already_member"), (None, "retry_conflict")):
        seq = {Q.INVITEE: [{"user_id": VENDOR}], Q.EXISTING: [None, later], Q.INSERT_INVITE: [None]}

        async def fake_one(conn, sql, params=None, seq=seq):
            return seq[sql].pop(0)

        monkeypatch.setattr(S, "fetch_one", fake_one)
        with pytest.raises(ApiError) as ei:
            await S.invite(None, None, P(), uuid.uuid4(), "t-vendor@example.test")  # type: ignore[arg-type]
        assert (ei.value.status, ei.value.code) == (409, code)
        assert all(v == [] for v in seq.values()), seq


async def test_remove_expect_pending_and_active(client_as):
    """U9-2(fe-u9 요청 2): DELETE …/members/{user_id}?expect=pending 은 대기 초대만 취소(활성이면 409 not_pending, 행·감사 불변),
    expect=active 는 활성 멤버만 제거(대기면 409 not_active). 생략은 예전 동작."""
    pr = await create_project(client_as, name=uniq("exp"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "viewer", "active")
    await add_member(pid, KIA_US, "viewer", "pending")
    try:
        async with client_as(ADMIN) as c:
            r = await c.delete(f"/v1/projects/{pid}/members/{VENDOR}", params={"expect": "pending"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "not_pending", r.text
            r = await c.delete(f"/v1/projects/{pid}/members/{KIA_US}", params={"expect": "active"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "not_active", r.text
            assert (await c.delete(f"/v1/projects/{pid}/members/{KIA_US}", params={"expect": "bogus"})).status_code == 422
            assert await fetch(AUDIT_SQL, uuid.UUID(pid)) == []
            assert (await c.delete(f"/v1/projects/{pid}/members/{KIA_US}", params={"expect": "pending"})).status_code == 204
            assert (await c.delete(f"/v1/projects/{pid}/members/{VENDOR}", params={"expect": "active"})).status_code == 204
            r = await c.delete(f"/v1/projects/{pid}/members/{KIA_US}", params={"expect": "pending"})
            assert r.status_code == 404 and r.json()["error"]["code"] == "member_not_found"
        acts = [(a["action"], a["target_user_id"]) for a in await fetch(AUDIT_SQL, uuid.UUID(pid))]
        assert acts == [("cancel_invite", KIA_US), ("remove", VENDOR)]
    finally:
        await purge(pid)
