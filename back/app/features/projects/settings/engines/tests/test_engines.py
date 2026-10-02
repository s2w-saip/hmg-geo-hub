"""projects.settings.engines(PJ-4) API 테스트: Owner ∧ 운영자 게이트, 정규화·no-op, 이력·아웃박스·트리거, 키셋."""
from __future__ import annotations

import uuid

from app.features.projects.project.core.tests.helpers import add_member, create_project, fetch, fetchval, owner_db, purge, uniq
from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db
JC = "SELECT count(*) FROM app.judgment_change WHERE kind = 'project_setting' AND $1 = ANY(subject_uuids)"


async def test_put_engines_changes_noop_and_reenable(client_as):
    pr = await create_project(client_as, name=uniq("eng"))
    pid = uuid.UUID(pr["project_id"])
    try:
        jc0 = await fetchval(JC, pid)
        async with client_as(ADMIN) as c:
            r = await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["deepseek", "chatgpt", "deepseek"]})
            d = r.json()["data"]
            assert r.status_code == 200 and d["engines"] == ["chatgpt", "deepseek"] and d["changed"] and not d["reenable"]
            r = await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["chatgpt", "deepseek"]})
            assert r.json()["data"]["changed"] is False and r.json()["data"]["outbox_id"] is None
            assert (await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": []})).json()["data"]["engines"] == []
            r = await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["gemini"]})
            assert r.json()["data"]["reenable"] is True
            r = await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["bing"]})
            assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_engine"
            assert (await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": "gemini"})).status_code == 422
        assert await fetchval("SELECT ai_engines FROM app.project WHERE project_id = $1", pid) == ["gemini"]
        hist = [h["engines"] for h in await fetch("SELECT engines FROM app.project_engine_history WHERE project_id = $1 ORDER BY history_id", pid)]
        assert hist == [["chatgpt"], ["chatgpt", "deepseek"], [], ["gemini"]]          # 생성 1 + 변경 3(no-op·거부 0)
        assert await fetchval(JC, pid) == jc0 + 3                                   # 트리거(ai_engines 변경)만
        ob = await fetch("SELECT payload FROM app.scope_outbox WHERE aggregate = 'schedule' AND aggregate_id = $1 AND done_at IS NULL", pid)
        assert len(ob) == 1                                                          # 미완료 같은 op 는 최신 페이로드로 합쳐진다
        import json
        payload = json.loads(ob[0]["payload"]) if isinstance(ob[0]["payload"], str) else ob[0]["payload"]
        assert payload["engines"] == ["gemini"] and payload["reenable"] is True
    finally:
        await purge(pid)


async def test_legacy_null_first_save_and_gate(client_as):
    pr = await create_project(client_as, name=uniq("eng2"))
    pid = uuid.UUID(pr["project_id"])
    async with owner_db() as db:
        await db.execute("UPDATE app.project SET ai_engines = NULL WHERE project_id = $1", pid)
    await add_member(pid, VENDOR, "owner")          # operator none Owner → 운영자 게이트 거부
    await add_member(pid, HQ_HYUNDAI, "owner")      # operator assigned + 활성 멤버 → 허용
    try:
        async with client_as(VENDOR) as c:
            r = await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["gemini"]})
        assert r.status_code == 403 and r.json()["error"]["code"] == "operator_forbidden"
        async with client_as(KIA_US) as c:            # 비멤버 → 존재 은닉 404(검증 D1: 403 owner_only 는 존재를 흘린다)
            r = await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["gemini"]})
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
        async with client_as(ADMIN) as c:
            assert (await c.put(f"/v1/projects/{uuid.uuid4()}/settings/engines", json={"engines": ["gemini"]})).status_code == 404
        async with client_as(HQ_HYUNDAI) as c:
            r = await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["chatgpt", "gemini"]})    # = 기본값이지만 첫 명시 저장
        assert r.status_code == 200 and r.json()["data"]["changed"] is True
        await add_member(pid, HQ_HYUNDAI, "viewer")
        async with client_as(HQ_HYUNDAI) as c:
            r = await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["gemini"]})
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"
        assert await fetchval("SELECT ai_engines FROM app.project WHERE project_id = $1", pid) == ["chatgpt", "gemini"]
    finally:
        await purge(pid)


async def test_history_keyset_and_visibility(client_as):
    pr = await create_project(client_as, name=uniq("engh"))
    pid = pr["project_id"]
    try:
        async with client_as(ADMIN) as c:
            await c.put(f"/v1/projects/{pid}/settings/engines", json={"engines": ["gemini"]})
            p1 = (await c.get(f"/v1/projects/{pid}/settings/engines/history", params={"limit": 1})).json()
            assert [i["engines"] for i in p1["data"]["items"]] == [["gemini"]] and p1["data"]["next_cursor"]
            assert p1["data"]["items"][0]["changed_by_email"] == "t-admin@example.test"
            p2 = (await c.get(f"/v1/projects/{pid}/settings/engines/history", params={"limit": 1, "cursor": p1["data"]["next_cursor"]})).json()
            assert [i["engines"] for i in p2["data"]["items"]] == [["chatgpt"]] and p2["data"]["next_cursor"] is None
            assert (await c.get(f"/v1/projects/{pid}/settings/engines/history", params={"limit": 0})).status_code == 422
        async with client_as(HQ_HYUNDAI) as c:        # 스코프 안 비멤버: 상세·설정 이력 모두 404(검증 D1)
            assert (await c.get(f"/v1/projects/{pid}")).status_code == 404
            assert (await c.get(f"/v1/projects/{pid}/settings/engines/history")).status_code == 404
        await add_member(pid, VENDOR, "viewer")
        async with client_as(VENDOR) as c:
            assert len((await c.get(f"/v1/projects/{pid}/settings/engines/history")).json()["data"]["items"]) == 2
    finally:
        await purge(pid)
