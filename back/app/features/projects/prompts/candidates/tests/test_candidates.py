"""projects.prompts.candidates: 후보 목록·승격·삭제(단건·선택), 권한·IDOR·검증."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db
T0 = datetime(2026, 9, 1, tzinfo=UTC)


def url(pid, suffix=""):
    return f"/v1/projects/{pid}/prompt-candidates{suffix}"


async def test_list_shape_order_pagination(env, client_as):
    pid = await env.mk_project()
    made = [await env.mk_candidate(f"c{i}", project_id=pid, source="google_keyword", keyword="kw", created_at=T0 + timedelta(minutes=i))
            for i in range(5)]
    other = await env.mk_project()
    await env.mk_candidate("not mine", project_id=other)
    async with client_as(VENDOR) as c:                                      # 활성 viewer 도 읽기 가능
        r = await c.get(url(pid))
        assert r.status_code == 200, r.text
        items = r.json()["data"]["items"]
        assert [i["candidate_id"] for i in items] == [str(x) for x in reversed(made)]
        assert items[0] == {"candidate_id": str(made[-1]), "source": "google_keyword", "source_keyword": "kw", "text": "c4",
                            "created_at": items[0]["created_at"]}
        assert r.json()["meta"]["page"] == {"next_cursor": None, "limit": 200, "total": 5}
        p1 = await c.get(url(pid), params={"limit": 2})
        p2 = await c.get(url(pid), params={"limit": 2, "cursor": p1.json()["data"]["next_cursor"]})
        p3 = await c.get(url(pid), params={"limit": 2, "cursor": p2.json()["data"]["next_cursor"]})
        got = [i["candidate_id"] for p in (p1, p2, p3) for i in p.json()["data"]["items"]]
        assert got == [str(x) for x in reversed(made)] and p3.json()["data"]["next_cursor"] is None
        r = await c.get(url(pid), params={"engine": "chatgpt"})
        assert r.json()["meta"]["ignored_filters"] == ["engine"]
        assert (await c.get(url(pid), params={"limit": 0})).status_code == 422
        assert (await c.get(url(pid), params={"cursor": "x"})).status_code == 422
    empty = await env.mk_project()
    async with client_as(env.owner) as c:
        r = await c.get(url(empty))
        assert r.status_code == 200 and r.json()["data"]["items"] == [] and r.json()["meta"]["page"]["total"] == 0
    for uid, code in ((KIA_US, 404), (SUSPENDED, 401), (env.nomenu, 403), (HQ_HYUNDAI, 404)):   # 메인 정정 2026-09-28: 비멤버(스코프 안) 읽기 404(front prompt/page.tsx:43 notFound)
        async with client_as(uid) as c:
            assert (await c.get(url(pid))).status_code == code, uid


async def test_select_promotes_and_keeps_pool(env, client_as):
    pid = await env.mk_project()
    c1 = await env.mk_candidate("cand one", project_id=pid, created_at=T0)
    c2 = await env.mk_candidate("cand two", project_id=pid, created_at=T0 + timedelta(minutes=1))
    other = await env.mk_project()
    foreign = await env.mk_candidate("foreign", project_id=other)
    async with client_as(env.owner) as c:
        r = await c.post(url(pid, "/select"), json={"candidate_ids": [str(c1), str(c2), str(foreign), str(c1)]})
    assert r.status_code == 201, r.text
    d = r.json()["data"]
    assert d["created"] == 2 and d["not_found"] == [str(foreign)]
    rows = await env.q("SELECT prompt_id::text, candidate_id, text, status, created_by FROM app.prompt WHERE project_id = $1 ORDER BY text", pid)
    assert [(x["candidate_id"], x["text"], x["status"], x["created_by"]) for x in rows] == [
        (c1, "cand one", "draft", env.owner), (c2, "cand two", "draft", env.owner)]
    assert {x["prompt_id"] for x in rows} == set(d["prompt_ids"])
    assert await env.val("SELECT count(*) FROM app.prompt_candidate WHERE project_id = $1", pid) == 2      # 후보 유지
    assert await env.val("SELECT count(*) FROM app.prompt WHERE project_id = $1", other) == 0              # 다른 프로젝트 무변경
    assert [a["event_type"] for a in await env.audits(uuid.UUID(d["prompt_ids"][0]))] == ["created"]
    async with client_as(env.owner) as c:
        r = await c.post(url(pid, "/select"), json={"candidate_ids": [str(foreign)]})
        assert r.status_code == 404 and r.json()["error"]["code"] == "candidate_not_found"
        for body in ({"candidate_ids": []}, {}, {"candidate_ids": ["nope"]}, {"candidate_ids": [str(c1)] * 501}):
            assert (await c.post(url(pid, "/select"), json=body)).status_code == 422, body
    for uid, code in ((VENDOR, 403), (HQ_HYUNDAI, 403), (KIA_US, 404)):
        async with client_as(uid) as c:
            assert (await c.post(url(pid, "/select"), json={"candidate_ids": [str(c1)]})).status_code == code, uid
    assert await env.val("SELECT count(*) FROM app.prompt WHERE project_id = $1", pid) == 2


async def test_delete_one_and_bulk(env, client_as):
    pid = await env.mk_project()
    c1, c2, c3 = [await env.mk_candidate(f"d{i}", project_id=pid) for i in range(3)]
    other = await env.mk_project()
    foreign = await env.mk_candidate("f", project_id=other)
    async with client_as(VENDOR) as c:
        assert (await c.delete(url(pid, f"/{c1}"))).status_code == 403
    async with client_as(env.owner) as c:
        assert (await c.delete(url(pid, f"/{c1}"))).status_code == 204
        assert (await c.delete(url(pid, f"/{c1}"))).status_code == 404
        assert (await c.delete(url(pid, f"/{foreign}"))).status_code == 404                  # IDOR: 다른 프로젝트 후보
        r = await c.post(url(pid, "/bulk-delete"), json={"candidate_ids": [str(c2), str(foreign)]})
        assert r.status_code == 200 and r.json()["data"] == {"deleted": 1, "not_found": [str(foreign)]}
        r = await c.post(url(pid, "/bulk-delete"), json={"candidate_ids": [str(foreign)]})
        assert r.status_code == 404
        assert (await c.post(url(pid, "/bulk-delete"), json={"candidate_ids": []})).status_code == 422
    async with client_as(ADMIN) as c:
        assert (await c.post(url(pid, "/bulk-delete"), json={"candidate_ids": [str(c3)]})).status_code == 200
    assert await env.val("SELECT count(*) FROM app.prompt_candidate WHERE project_id = $1", pid) == 0
    assert await env.val("SELECT count(*) FROM app.prompt_candidate WHERE candidate_id = $1", foreign) == 1
