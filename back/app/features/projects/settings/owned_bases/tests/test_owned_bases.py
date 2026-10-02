"""projects.settings.owned_bases(PJ-4) API 테스트: 정규화·대표 도메인 재동기화·재판정 큐·아웃박스·권한·롤백."""
from __future__ import annotations

import uuid

from app.features.projects.project.core.tests.helpers import add_member, create_project, fetch, fetchval, purge, uniq
from tests.support import ADMIN, VENDOR, needs_db

pytestmark = needs_db
JC_OB = "SELECT count(*) FROM app.judgment_change WHERE kind = 'project_owned_base' AND $1 = ANY(subject_uuids)"
JC_PS = "SELECT count(*) FROM app.judgment_change WHERE kind = 'project_setting' AND $1 = ANY(subject_uuids)"
UPD = "SELECT count(*) FROM app.scope_outbox WHERE aggregate = 'project' AND op = 'update' AND aggregate_id = $1"


async def test_add_remove_resync_and_queues(client_as):
    pr = await create_project(client_as, name=uniq("ob"))
    pid = uuid.UUID(pr["project_id"])
    try:
        async with client_as(ADMIN) as c:
            r = await c.post(f"/v1/projects/{pid}/settings/owned-bases", json={"base_url": "https://WWW.Example.com/kr/?gclid=1", "label": " KR "})
            assert r.status_code == 201, r.text
            d = r.json()["data"]
            assert d["base_norm"] == "example.com/kr" and d["domain"] == "example.com/kr" and d["change_id"] > 0
            assert d["owned_base"]["base_url"] == "https://www.example.com/kr/?gclid=1" and d["owned_base"]["label"] == "KR"
            r = await c.post(f"/v1/projects/{pid}/settings/owned-bases", json={"base_url": "https://example.com/us"})
            assert r.json()["data"]["domain"] == "example.com/kr"                    # 대표 = 먼저 등록된 것
            r = await c.post(f"/v1/projects/{pid}/settings/owned-bases", json={"base_url": "http://example.com/kr#x"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_owned_base"
            for bad in ("ftp://example.com", "example.com/kr", "https://", "https://u:p@example.com/"):
                r = await c.post(f"/v1/projects/{pid}/settings/owned-bases", json={"base_url": bad})
                assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_url", bad
        assert await fetchval(JC_OB, pid) == 2 and await fetchval(JC_PS, pid) == 1 and await fetchval(UPD, pid) == 1
        async with client_as(ADMIN) as c:
            r = await c.delete(f"/v1/projects/{pid}/settings/owned-bases", params={"base_norm": "example.com/kr"})
            assert r.status_code == 200 and r.json()["data"]["domain"] == "example.com/us"
            r = await c.delete(f"/v1/projects/{pid}/settings/owned-bases", params={"base_norm": "example.com/kr"})
            assert r.status_code == 404 and r.json()["error"]["code"] == "owned_base_not_found"
            assert (await c.delete(f"/v1/projects/{pid}/settings/owned-bases")).status_code == 422
        rows = await fetch("SELECT base_norm FROM app.project_owned_base WHERE project_id = $1", pid)
        assert rows == [{"base_norm": "example.com/us"}]
        assert await fetchval("SELECT domain FROM app.project WHERE project_id = $1", pid) == "example.com/us"
        assert await fetchval(JC_OB, pid) == 3 and await fetchval(JC_PS, pid) == 2
        payload = await fetchval("SELECT payload->>'domain' FROM app.scope_outbox WHERE aggregate = 'project' AND op = 'update' "
                                 "AND aggregate_id = $1 AND done_at IS NULL", pid)
        assert payload == "example.com/us"
    finally:
        await purge(pid)


async def test_owner_only(client_as):
    pr = await create_project(client_as, name=uniq("ob2"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "viewer")
    try:
        async with client_as(VENDOR) as c:
            r = await c.post(f"/v1/projects/{pid}/settings/owned-bases", json={"base_url": "https://v.example.com"})
            assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"
            assert (await c.delete(f"/v1/projects/{pid}/settings/owned-bases", params={"base_norm": "x"})).status_code == 403
        assert await fetchval("SELECT count(*) FROM app.project_owned_base WHERE project_id = $1", uuid.UUID(pid)) == 0
        assert await fetchval(JC_OB, uuid.UUID(pid)) == 0
    finally:
        await purge(pid)
