"""projects.settings.tracked_targets(PJ-4) API 테스트: 별칭·경쟁사·차종 → 추적 브랜드 재구성·재판정 큐, 비교 기준 지정, 권한."""
from __future__ import annotations

import uuid

from app.features.projects.project.core.tests.helpers import add_member, create_project, fetch, fetchval, purge, uniq
from tests.support import ADMIN, VENDOR, needs_db

pytestmark = needs_db
JC = "SELECT count(*) FROM app.judgment_change WHERE kind = 'project_setting' AND $1 = ANY(subject_uuids)"


async def _brands(pid) -> dict[str, list[str]]:
    return {r["canonical_name"]: r["aliases"] for r in
            await fetch("SELECT canonical_name, aliases FROM app.project_tracked_brand WHERE project_id = $1", pid)}


async def test_aliases_competitors_target_vehicles(client_as):
    pr = await create_project(client_as, name=uniq("tt"), brand_code="Hyundai")
    pid = uuid.UUID(pr["project_id"])
    base = f"/v1/projects/{pid}/settings"
    try:
        jc0 = await fetchval(JC, pid)
        async with client_as(ADMIN) as c:
            r = await c.put(f"{base}/brand-aliases", json={"brand_code": "Hyundai", "aliases": ["현대", " HMC ", "현대", ""]})
            assert r.status_code == 200 and r.json()["data"]["brand_aliases"] == {"brand_code": "Hyundai", "aliases": ["현대", "HMC"]}
            r = await c.put(f"{base}/brand-aliases", json={"brand_code": "Kia", "aliases": ["x"]})
            assert r.status_code == 409 and r.json()["error"]["code"] == "brand_mismatch"
            r = await c.post(f"{base}/competitors", json={"brand_name": "Toyota", "aliases": ["도요타"], "notes": "n"})
            assert r.status_code == 201 and r.json()["data"]["competitor"]["brand_name"] == "Toyota"
            assert sorted(r.json()["data"]["tracked_brands"]) == ["Hyundai", "Toyota"]
            assert (await c.post(f"{base}/competitors", json={"brand_name": "Toyota"})).status_code == 409
            assert (await c.post(f"{base}/competitors", json={"brand_name": "  "})).status_code == 422
            r = await c.put(f"{base}/competitors/target", json={"brand_name": "Toyota"})
            assert r.status_code == 200 and r.json()["data"]["target_brand"] == "Toyota" and r.json()["data"]["change_id"] is None
            r = await c.put(f"{base}/competitors/target", json={"brand_name": "Nope"})
            assert r.status_code == 404
            assert await fetchval("SELECT brand_name FROM app.project_tracked_competitor WHERE project_id = $1 AND is_target", pid) == "Toyota"
            r = await c.post(f"{base}/vehicles", json={"brand": "Honda", "model": "CR-V", "segment": "SUV"})
            assert r.status_code == 201 and r.json()["data"]["vehicle"]["model"] == "CR-V"
            r = await c.post(f"{base}/vehicles", json={"brand": "Hyundai", "model": "Tucson"})
            assert r.status_code == 201
            assert (await c.post(f"{base}/vehicles", json={"brand": "Honda", "model": "CR-V"})).status_code == 409
        comps = [x["brand_name"] for x in await fetch("SELECT brand_name FROM app.project_tracked_competitor WHERE project_id = $1 ORDER BY 1", pid)]
        assert comps == ["Honda", "Toyota"]                              # 차종 브랜드 자동 등록(프로젝트 브랜드 Hyundai 제외)
        assert await _brands(pid) == {"Hyundai": ["Hyundai", "현대", "HMC"], "Toyota": ["Toyota", "도요타"], "Honda": ["Honda"]}
        # 비교 기준(target) 지정은 재판정 없음: 별칭 1 + 경쟁사 1 + 차종 2 = 4
        assert await fetchval(JC, pid) == jc0 + 4
        async with client_as(ADMIN) as c:
            assert (await c.put(f"{base}/competitors/target", json={"brand_name": None})).json()["data"]["target_brand"] is None
            assert (await c.delete(f"{base}/competitors", params={"brand_name": "Toyota"})).status_code == 200
            r = await c.delete(f"{base}/competitors", params={"brand_name": "Toyota"})
            assert r.status_code == 404 and r.json()["error"]["code"] == "competitor_not_found"
            assert (await c.delete(f"{base}/vehicles", params={"brand": "Honda", "model": "CR-V"})).status_code == 200
            r = await c.delete(f"{base}/vehicles", params={"brand": "Honda", "model": "CR-V"})
            assert r.status_code == 404 and r.json()["error"]["code"] == "vehicle_not_found"
            assert (await c.delete(f"{base}/vehicles", params={"brand": "Honda"})).status_code == 422
            r = await c.put(f"{base}/brand-aliases", json={"brand_code": "Hyundai", "aliases": []})
            assert r.json()["data"]["brand_aliases"]["aliases"] == []
        assert await fetchval("SELECT count(*) FROM app.project_tracked_competitor WHERE project_id = $1 AND is_target", pid) == 0
        assert await _brands(pid) == {"Hyundai": ["Hyundai"], "Honda": ["Honda"]}     # Honda 는 경쟁사로 남아 유지
    finally:
        await purge(pid)


async def test_no_brand_and_permissions(client_as):
    pr = await create_project(client_as, name=uniq("tt2"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "viewer")
    try:
        async with client_as(ADMIN) as c:
            r = await c.put(f"/v1/projects/{pid}/settings/brand-aliases", json={"brand_code": "Hyundai", "aliases": ["x"]})
            assert r.status_code == 409 and r.json()["error"]["code"] == "no_project_brand"
        async with client_as(VENDOR) as c:
            for method, path, kw in (("POST", "competitors", {"json": {"brand_name": "BMW"}}),
                                     ("PUT", "competitors/target", {"json": {"brand_name": None}}),
                                     ("POST", "vehicles", {"json": {"brand": "BMW", "model": "X5"}}),
                                     ("DELETE", "competitors", {"params": {"brand_name": "BMW"}})):
                r = await c.request(method, f"/v1/projects/{pid}/settings/{path}", **kw)
                assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", path
        assert await fetchval("SELECT count(*) FROM app.project_tracked_competitor WHERE project_id = $1", uuid.UUID(pid)) == 0
    finally:
        await purge(pid)
