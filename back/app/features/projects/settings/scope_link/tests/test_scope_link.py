"""projects.settings.scope_link(PJ-4) API 테스트: admin 전용, rd.cycle·rd.job 진단(독립 SQL 대조), 아웃박스 상태 전이, 가짜 어댑터 주입."""
from __future__ import annotations

import uuid
from typing import Any

from app.features.projects.project.core.tests.helpers import create_project, fetch, owner_db, purge, uniq
from app.features.projects.settings.scope_link.adapter import get_scope_probe
from app.features.projects.settings.scope_link.service import link_state
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, ROOT_PROJECT, VENDOR, needs_db


class FakeProbe:
    name = "fake"

    def __init__(self) -> None:
        self.calls: list[uuid.UUID] = []

    async def probe(self, scope_project_id: uuid.UUID) -> dict[str, Any] | None:
        self.calls.append(scope_project_id)
        return {"status": "ok", "schedules": 1}


def test_link_state_rules():
    ob0 = {"erroring": 0, "pending_create": 0}
    assert link_state(False, ob0, None) == "unlinked"
    assert link_state(False, {**ob0, "pending_create": 1}, None) == "pending_link"
    assert link_state(False, {"erroring": 1, "pending_create": 1}, None) == "link_error"
    assert link_state(True, ob0, None) == "no_data"
    assert link_state(True, ob0, {"total": 0, "served": 0}) == "no_data"
    assert link_state(True, ob0, {"total": 3, "served": 2}) == "partial"
    assert link_state(True, ob0, {"total": 3, "served": 3}) == "healthy"


@needs_db
async def test_linked_project_diagnosis(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(f"/v1/projects/{CUST_PROJECT}/settings/scope-link")
    assert r.status_code == 200, r.text
    d, meta = r.json()["data"], r.json()["meta"]
    exp = (await fetch("""
        SELECT j.round_date, count(*) AS total, count(*) FILTER (WHERE j.served) AS served
          FROM rd.job j JOIN rd.dim_project dp ON dp.project_key = j.project_key
         WHERE dp.project_id = $1 AND j.surface = 3
         GROUP BY j.round_date ORDER BY j.round_date DESC LIMIT 1""", CUST_PROJECT))[0]
    assert d["linked"] and d["latest_round"]["round_date"] == exp["round_date"].isoformat()
    assert d["jobs"]["total"] == exp["total"] and d["jobs"]["served_ratio"] == {"num": exp["served"], "den": exp["total"]}
    assert d["state"] == ("healthy" if exp["served"] == exp["total"] else "partial")
    assert d["live"] is None and meta["source"] == {"live_probe": "disabled"}
    for uid in (VENDOR, HQ_HYUNDAI):
        async with client_as(uid) as c:
            r = await c.get(f"/v1/projects/{CUST_PROJECT}/settings/scope-link")
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", uid
    async with client_as(ADMIN) as c:
        assert (await c.get(f"/v1/projects/{ROOT_PROJECT}/settings/scope-link")).status_code == 404


@needs_db
async def test_unlinked_outbox_states(client_as):
    pr = await create_project(client_as, name=uniq("sl"))
    pid = uuid.UUID(pr["project_id"])
    url = f"/v1/projects/{pid}/settings/scope-link"
    try:
        async with client_as(ADMIN) as c:
            d = (await c.get(url)).json()["data"]
            assert d["state"] == "pending_link" and d["jobs"] is None and d["outbox"]["pending"] == 2
            assert [o["op"] for o in d["outbox"]["recent"]] == ["set_targets", "create"]
            async with owner_db() as db:
                await db.execute("UPDATE app.scope_outbox SET last_error = 'scope 400', attempts = 3 "
                                 "WHERE aggregate = 'project' AND aggregate_id = $1", pid)
            d = (await c.get(url)).json()["data"]
            assert d["state"] == "link_error" and d["outbox"]["erroring"] == 1
            async with owner_db() as db:
                await db.execute("UPDATE app.scope_outbox SET done_at = now() WHERE aggregate_id = $1", pid)
            d = (await c.get(url)).json()["data"]
            assert d["state"] == "unlinked" and d["outbox"]["pending"] == 0
    finally:
        await purge(pid)


@needs_db
async def test_injected_probe(client_as):
    from app.main import app

    fake = FakeProbe()
    app.dependency_overrides[get_scope_probe] = lambda: fake
    pr = await create_project(client_as, name=uniq("sl2"))
    try:
        async with client_as(ADMIN) as c:
            r = await c.get(f"/v1/projects/{CUST_PROJECT}/settings/scope-link")
            r2 = await c.get(f"/v1/projects/{pr['project_id']}/settings/scope-link")       # 미연결 = 어댑터 호출 안 함
        assert r.json()["data"]["live"] == {"status": "ok", "schedules": 1} and r.json()["meta"]["source"] == {"live_probe": "fake"}
        assert r2.json()["data"]["live"] is None
        sp = await fetch("SELECT scope_project_id FROM app.project WHERE project_id = $1", CUST_PROJECT)
        assert fake.calls == [sp[0]["scope_project_id"]]
    finally:
        app.dependency_overrides.pop(get_scope_probe, None)
        await purge(pr["project_id"])


@needs_db
async def test_include_recent_false_skips_recent_rows(client_as):
    """B018: include_recent=false 는 최근 아웃박스 10행 문장을 실행하지 않고 recent = [](상태·건수·회차는 같다).
    scope_project_id 는 접근 판정이 읽은 프로젝트 행 값을 쓴다(프로젝트 재조회 문장 없음)."""
    from tests.core.rcache_calls import Stmts
    pr = await create_project(client_as, name=uniq("sl3"))
    pid = uuid.UUID(pr["project_id"])
    url = f"/v1/projects/{pid}/settings/scope-link"
    try:
        async with client_as(ADMIN) as c:
            full = (await c.get(url)).json()["data"]
            with Stmts() as s:
                r = await c.get(url, params={"include_recent": "false"})
            linked = (await c.get(f"/v1/projects/{CUST_PROJECT}/settings/scope-link", params={"include_recent": "false"})).json()["data"]
        assert r.status_code == 200, r.text
        light = r.json()["data"]
        assert [o["op"] for o in full["outbox"]["recent"]] == ["set_targets", "create"] and light["outbox"]["recent"] == []
        assert {**light, "outbox": {**light["outbox"], "recent": full["outbox"]["recent"]}} == full
        assert not any("ORDER BY o.created_at DESC, o.outbox_id DESC" in x for x in s.seen)
        assert not any("SELECT scope_project_id FROM app.project" in x for x in s.seen)
        sp = await fetch("SELECT scope_project_id FROM app.project WHERE project_id = $1", CUST_PROJECT)
        assert linked["linked"] and linked["scope_project_id"] == str(sp[0]["scope_project_id"])
    finally:
        await purge(pid)
