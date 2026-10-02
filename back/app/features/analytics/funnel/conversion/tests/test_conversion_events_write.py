"""PUT /v1/funnel/conversion/events(BG-29 쓰기) 통합 테스트.

쓰기는 api_rw 별도 트랜잭션(get_db().write)이라 롤백 전용 준비(staged)로는 준비 행이 보이지 않는다. 그래서 이 모듈은 준비 행을
소유자 접속으로 커밋하고(무작위 숫자 속성 id, 드문 시장), 끝에 지운다(대분류 안 재진입 안전: 이전 실행이 남긴 같은 키도 시작 때 지운다).
프로젝트 맥락은 CUST_PROJECT 의 ga4_property_id 를 잠시 바꾸고 원래 값으로 되돌린다. Owner 는 HQ_HYUNDAI 를 잠시 Owner 로 넣는다.
"""
from __future__ import annotations

import random

import asyncpg
import pytest_asyncio

from tests.support import ADMIN, CUST_PROJECT, DB_URL, HQ_HYUNDAI, KIA_EU, KIA_US, VENDOR, WEBSITE_KIA, needs_db

EV = "/v1/funnel/conversion/events"
pytestmark = [needs_db]


@pytest_asyncio.fixture(loop_scope="session")
async def env(seeded):
    c = await asyncpg.connect(DB_URL)
    base = random.randint(10 ** 13, 10 ** 14 - 1)
    pids = {"kia_nl": str(base), "proj": str(base + 1), "unknown": str(base + 2)}
    orig = await c.fetchval("SELECT ga4_property_id FROM app.project WHERE project_id = $1", CUST_PROJECT)

    async def clean() -> None:
        ids = list(pids.values())
        await c.execute("UPDATE app.project SET ga4_property_id = $2 WHERE project_id = $1", CUST_PROJECT, orig)
        await c.execute("DELETE FROM app.project_member WHERE project_id = $1 AND user_id = $2", CUST_PROJECT, HQ_HYUNDAI)
        await c.execute("DELETE FROM app.ga4_tracked_event WHERE property_id = ANY($1::text[])", ids)
        await c.execute("DELETE FROM app.judgment_change WHERE kind = 'ga4_tracked_event' AND subject_texts && $1::text[]", ids)
        await c.execute("DELETE FROM app.ga4_property WHERE property_id = ANY($1::text[]) OR (brand_code = 'Kia' AND country_code = 'NL')", ids)

    await clean()
    await c.execute("INSERT INTO app.ga4_property (property_id, brand_code, country_code, status) VALUES ($1, 'Kia', 'NL', 'active'), "
                    "($2, NULL, NULL, 'unmapped')", pids["kia_nl"], pids["proj"])
    try:
        yield {"c": c, "pids": pids}
    finally:
        await clean()
        await c.close()


async def _put(client_as, uid, names, **params):
    async with client_as(uid) as cl:
        return await cl.put(EV, params=params, json={"event_names": names})


async def _tracked(c, pid):
    return [r["event_name"] for r in await c.fetch("SELECT event_name FROM app.ga4_tracked_event WHERE property_id = $1 ORDER BY 1", pid)]


async def test_put_scope_role_and_change_queue(client_as, env):
    c, pid = env["c"], env["pids"]["kia_nl"]
    r = await _put(client_as, KIA_EU, [" sign_up", "purchase", "purchase"], property_id=pid)   # 권역 계정(편집 역할), 표면 website
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["event_names"] == ["purchase", "sign_up"] and d["propagation"] == "pending" and d["change_id"] is not None
    assert await _tracked(c, pid) == ["purchase", "sign_up"]
    row = await c.fetchrow("SELECT kind, status, payload FROM app.judgment_change WHERE change_id = $1", d["change_id"])
    assert (row["kind"], row["status"]) == ("ga4_tracked_event", "pending")
    r = await _put(client_as, KIA_EU, ["sign_up", "purchase"], property_id=pid)                 # 같은 집합 = 요청 없음
    assert r.status_code == 200 and r.json()["data"]["propagation"] == "none" and r.json()["data"]["change_id"] is None
    # 조회 전용 역할(website)·스코프 밖·표면 게이트 밖은 쓰지 못한다(행 무변화)
    r = await _put(client_as, WEBSITE_KIA, ["x_only"], property_id=pid)
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    assert (await _put(client_as, KIA_US, ["x_only"], property_id=pid, surface="global")).status_code == 404
    r = await _put(client_as, VENDOR, ["x_only"], property_id=pid, surface="global")
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    assert await _tracked(c, pid) == ["purchase", "sign_up"]


async def test_put_project_owner_only(client_as, env):
    c, pid = env["c"], env["pids"]["proj"]
    await c.execute("UPDATE app.project SET ga4_property_id = $2 WHERE project_id = $1", CUST_PROJECT, pid)
    r = await _put(client_as, VENDOR, ["purchase"], property_id=pid, project_id=str(CUST_PROJECT))          # 활성 viewer
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"
    assert (await _put(client_as, HQ_HYUNDAI, ["purchase"], property_id=pid, project_id=str(CUST_PROJECT))).status_code == 404
    assert (await _put(client_as, VENDOR, ["purchase"], property_id=env["pids"]["kia_nl"],                 # IDOR: 다른 속성
                       project_id=str(CUST_PROJECT))).status_code == 404
    await c.execute("INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at) "
                    "VALUES ($1, $2, 'owner', 'active', $3, now())", CUST_PROJECT, HQ_HYUNDAI, ADMIN)
    r = await _put(client_as, HQ_HYUNDAI, ["purchase"], property_id=pid, project_id=str(CUST_PROJECT))       # 활성 Owner
    assert r.status_code == 200, r.text
    assert r.json()["data"]["propagation"] == "pending" and await _tracked(c, pid) == ["purchase"]
    async with client_as(HQ_HYUNDAI) as cl:                                                                  # 읽기 경로도 편집 가능 표시
        g = await cl.get(EV, params={"property_id": pid, "project_id": str(CUST_PROJECT)})
    assert g.status_code == 200 and g.json()["data"]["can_edit"] is True
    assert [(i["event_name"], i["tracked"]) for i in g.json()["data"]["items"]] == [("purchase", True)]


async def test_put_unregistered_and_bad_body(client_as, env):
    c, pid = env["c"], env["pids"]["unknown"]
    assert (await _put(client_as, ADMIN, ["purchase"], property_id=pid, surface="global")).status_code == 404   # 모르는 속성
    # 프로젝트 직접 지정이지만 레지스트리 밖: 소속 검증은 통과해도 추적 이벤트 FK 가 없어 404(admin 경로와 같다)
    await c.execute("UPDATE app.project SET ga4_property_id = $2 WHERE project_id = $1", CUST_PROJECT, pid)
    r = await _put(client_as, ADMIN, ["purchase"], property_id=pid, project_id=str(CUST_PROJECT))
    assert r.status_code == 404 and await _tracked(c, pid) == []
    kia = env["pids"]["kia_nl"]
    for body in (["1bad"], ["x" * 41], [f"e{i}" for i in range(101)]):             # 이름 형식·40자·100개 상한
        async with client_as(KIA_EU) as cl:
            r = await cl.put(EV, params={"property_id": kia}, json={"event_names": body})
        assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", body
    async with client_as(KIA_EU) as cl:
        r = await cl.put(EV, params={"property_id": kia}, json={"event_names": [], "extra": 1})
    assert r.status_code == 422
    assert (await _put(client_as, None, ["purchase"], property_id=kia)).status_code == 401


async def test_put_project_foreign_override_d1(client_as, env):
    """검증 D1 회귀: 프로젝트 Owner 가 직접 지정 속성을 다른 시장(Kia NL) 레지스트리 속성으로 바꿔도, 프로젝트 맥락에서 그 속성의 추적
    이벤트(전역 판정)를 읽거나 바꾸지 못한다(404, 행·재판정 큐 무변화). 프로젝트 화면도 그 시장 속성을 싣지 않는다."""
    c, kia = env["c"], env["pids"]["kia_nl"]
    await c.execute("INSERT INTO app.ga4_tracked_event (property_id, event_name) VALUES ($1, 'purchase')", kia)
    await c.execute("UPDATE app.project SET ga4_property_id = $2 WHERE project_id = $1", CUST_PROJECT, kia)
    await c.execute("INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at) "
                    "VALUES ($1, $2, 'owner', 'active', $3, now())", CUST_PROJECT, HQ_HYUNDAI, ADMIN)
    before = await c.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'ga4_tracked_event' AND $1 = ANY(subject_texts)", kia)
    r = await _put(client_as, HQ_HYUNDAI, ["page_view"], property_id=kia, project_id=str(CUST_PROJECT))    # 활성 Owner
    assert r.status_code == 404, r.text
    async with client_as(HQ_HYUNDAI) as cl:
        g = await cl.get(EV, params={"property_id": kia, "project_id": str(CUST_PROJECT)})
        v = await cl.get("/v1/funnel/conversion", params={"surface": "project", "project_id": str(CUST_PROJECT)})
    assert g.status_code == 404
    assert v.status_code == 200 and v.json()["data"]["coverage"]["markets"][0]["status"] == "unmapped" and kia not in v.text
    assert await _tracked(c, kia) == ["purchase"]
    assert await c.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'ga4_tracked_event' AND $1 = ANY(subject_texts)",
                            kia) == before
    # 그 시장 스코프 계정(KIA_EU, 비프로젝트 맥락)은 그대로 쓸 수 있다(정상 경로 보존)
    async with client_as(KIA_EU) as cl:
        g = await cl.get(EV, params={"property_id": kia})
    assert g.status_code == 200 and g.json()["data"]["can_edit"] is True


async def test_put_project_foreign_override_via_patch_d1(client_as, env):
    """검증 D1 재현 경로 그대로(e9c64db 판정): 활성 Owner 가 PATCH /v1/projects/{id} 로 다른 시장(Kia NL) 레지스트리 속성 id 를 직접
    지정한다(projects 는 현행처럼 받는다: 원천 차단은 CORE-REQUESTS/bg-funnel.md 3절). 그 뒤 프로젝트 맥락 GET·PUT 이벤트는 404 이고,
    추적 이벤트·재판정 큐는 그대로다. 같은 Owner 가 자기 시장 속성으로 되돌리면 project 표면은 다시 그 시장 속성을 싣는다."""
    c, kia = env["c"], env["pids"]["kia_nl"]
    await c.execute("INSERT INTO app.ga4_tracked_event (property_id, event_name) VALUES ($1, 'purchase')", kia)
    await c.execute("INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at) "
                    "VALUES ($1, $2, 'owner', 'active', $3, now())", CUST_PROJECT, HQ_HYUNDAI, ADMIN)
    before = await c.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'ga4_tracked_event' AND $1 = ANY(subject_texts)", kia)
    async with client_as(HQ_HYUNDAI) as cl:
        pr = await cl.patch(f"/v1/projects/{CUST_PROJECT}", json={"ga4_property_id": kia})
        assert pr.status_code == 200, pr.text
        g = await cl.get(EV, params={"property_id": kia, "project_id": str(CUST_PROJECT)})
        w = await cl.put(EV, params={"property_id": kia, "project_id": str(CUST_PROJECT)}, json={"event_names": ["page_view"]})
        v = await cl.get("/v1/funnel/conversion", params={"surface": "project", "project_id": str(CUST_PROJECT)})
        s = await cl.get(EV, params={"property_id": kia, "surface": "global"})         # 비프로젝트 맥락: 스코프(Hyundai) 밖
    assert (g.status_code, w.status_code, s.status_code) == (404, 404, 404), (g.text, w.text, s.text)
    assert v.status_code == 200 and v.json()["data"]["coverage"]["markets"] == [
        {"brand": "Hyundai", "country": "US", "status": "unmapped", "as_of": None, "property_id": None}]
    assert await _tracked(c, kia) == ["purchase"]
    assert await c.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'ga4_tracked_event' AND $1 = ANY(subject_texts)",
                            kia) == before
