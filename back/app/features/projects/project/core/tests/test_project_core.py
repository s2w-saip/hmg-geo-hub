"""projects.project.core(PJ-1) API 테스트. 기대값은 소유자 접속 독립 SQL(helpers.fetch)로 확인한다."""
from __future__ import annotations

import uuid

from app.features.projects.project.core.tests.helpers import (
    GLOBAL_KIA,
    add_member,
    create_project,
    ensure_extra_accounts,
    fetch,
    fetchval,
    purge,
    uniq,
)
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, ROOT_PROJECT, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db


# ── 목록 ────────────────────────────────────────────────────────────────────────
async def test_list_shape_membership_and_counts(client_as):
    pr = await create_project(client_as, name=uniq("lst"))
    try:
        async with client_as(ADMIN) as c:
            r = await c.get("/v1/projects", params={"q": pr["name"]})
        assert r.status_code == 200
        body = r.json()
        assert body["meta"]["mode"] == "crud" and body["meta"]["ignored_filters"] == []
        [it] = body["data"]["items"]
        assert it["project_id"] == pr["project_id"] and it["my_role"] == "owner"
        exp_members = await fetchval("SELECT count(*) FROM app.project_member WHERE project_id = $1 AND status = 'active'",
                                     uuid.UUID(pr["project_id"]))
        assert it["active_member_count"] == exp_members == 1 and it["prompt_count"] == 0
        assert it["effective_engines"] == ["chatgpt"] and it["ai_engines"] == ["chatgpt"]
        # 비멤버(스코프 안 HQ)도 목록에는 멤버십만 나온다: 새 프로젝트·고객 프로젝트 모두 없음
        async with client_as(HQ_HYUNDAI) as c:
            ids = {x["project_id"] for x in (await c.get("/v1/projects", params={"limit": 100})).json()["data"]["items"]}
        assert pr["project_id"] not in ids and str(CUST_PROJECT) not in ids
        # 활성 멤버(VENDOR viewer)는 고객 프로젝트가 보이고 역할이 viewer
        async with client_as(VENDOR) as c:
            items = (await c.get("/v1/projects", params={"limit": 100})).json()["data"]["items"]
        cust = [x for x in items if x["project_id"] == str(CUST_PROJECT)]
        assert cust and cust[0]["my_role"] == "viewer"
        assert all(x["project_id"] != str(ROOT_PROJECT) for x in items)
    finally:
        await purge(pr["project_id"])


async def test_list_search_pagination_and_cursor_guard(client_as):
    tag = uniq("pg")
    made = [await create_project(client_as, name=f"{tag}-{i}") for i in range(3)]
    other = await create_project(client_as, name=uniq("zz"))
    try:
        async with client_as(ADMIN) as c:
            r1 = await c.get("/v1/projects", params={"q": tag, "limit": 2})
            d1 = r1.json()
            assert len(d1["data"]["items"]) == 2 and d1["data"]["next_cursor"] and d1["meta"]["page"]["limit"] == 2
            r2 = await c.get("/v1/projects", params={"q": tag, "limit": 2, "cursor": d1["data"]["next_cursor"]})
            d2 = r2.json()
            assert len(d2["data"]["items"]) == 1 and d2["data"]["next_cursor"] is None
            got = [x["project_id"] for x in d1["data"]["items"] + d2["data"]["items"]]
            exp = [str(r["project_id"]) for r in await fetch(
                "SELECT project_id FROM app.project WHERE name LIKE $1 ORDER BY created_at DESC, project_id DESC", f"{tag}-%")]
            assert got == exp and other["project_id"] not in got
            # 다른 필터로 커서 재사용 = 422 cursor_invalid, 변조 = 422
            r3 = await c.get("/v1/projects", params={"q": "x", "cursor": d1["data"]["next_cursor"]})
            assert r3.status_code == 422 and r3.json()["error"]["code"] == "cursor_invalid"
            assert (await c.get("/v1/projects", params={"cursor": "!!bad"})).status_code == 422
            # 검색 결과 없음 = 빈 목록
            r4 = await c.get("/v1/projects", params={"q": uniq("none")})
            assert r4.status_code == 200 and r4.json()["data"] == {"items": [], "next_cursor": None}
            # 잘못된 limit, 지원하지 않는 공통 필터는 meta 에 드러남
            assert (await c.get("/v1/projects", params={"limit": 0})).status_code == 422
            assert (await c.get("/v1/projects", params={"limit": 101})).status_code == 422
            r5 = await c.get("/v1/projects", params={"q": tag, "brand": "Kia", "from": "2026-09-01", "to": "2026-09-30"})
            assert r5.json()["meta"]["ignored_filters"] == ["brand", "period"]
            # LIKE 와일드카드는 문자 그대로
            assert (await c.get("/v1/projects", params={"q": tag.replace("-", "_")})).json()["data"]["items"] == []
    finally:
        await purge(*[m["project_id"] for m in made], other["project_id"])


async def test_auth_required(client_as):
    async with client_as(None) as c:
        assert (await c.get("/v1/projects")).status_code == 401
    async with client_as(SUSPENDED) as c:
        r = await c.get("/v1/projects")
    assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"


# ── 생성 ────────────────────────────────────────────────────────────────────────
async def test_create_writes_all_rows_in_one_transaction(client_as):
    pr = await create_project(client_as, name=uniq("mk"), brand_code="Hyundai", domain="https://www.MyBrand.example.com/us/?utm_source=x",
                              description="  d  ", ai_engines=["gemini", "chatgpt", "gemini"])
    pid = uuid.UUID(pr["project_id"])
    try:
        assert pr["ai_engines"] == ["chatgpt", "gemini"] and pr["domain"] == "mybrand.example.com/us"
        assert pr["description"] == "d" and pr["my_role"] == "owner" and pr["scope_linked"] is False
        mem = await fetch("SELECT user_id, role::text AS role, status::text AS status FROM app.project_member WHERE project_id = $1", pid)
        assert mem == [{"user_id": ADMIN, "role": "owner", "status": "active"}]
        ob = await fetch("SELECT base_url, base_norm FROM app.project_owned_base WHERE project_id = $1", pid)
        # base_url 은 owned_bases 추가와 같은 정규 URL(스킴·호스트 소문자, 검증 D4), base_norm 은 매칭 키
        assert ob == [{"base_url": "https://www.mybrand.example.com/us/?utm_source=x", "base_norm": "mybrand.example.com/us"}]
        hist = await fetch("SELECT engines, changed_by FROM app.project_engine_history WHERE project_id = $1", pid)
        assert hist == [{"engines": ["chatgpt", "gemini"], "changed_by": ADMIN}]
        ob_ops = await fetch("SELECT aggregate, op, payload->>'name' AS name FROM app.scope_outbox WHERE aggregate_id = $1 ORDER BY outbox_id", pid)
        assert [(o["aggregate"], o["op"]) for o in ob_ops] == [("project", "create"), ("schedule", "set_targets")]
        assert ob_ops[0]["name"] == pr["name"]
        tb = await fetch("SELECT canonical_name, aliases FROM app.project_tracked_brand WHERE project_id = $1", pid)
        assert tb == [{"canonical_name": "Hyundai", "aliases": ["Hyundai"]}]
    finally:
        await purge(pid)


async def test_create_permission_and_scope(client_as):
    await ensure_extra_accounts()
    base = {"name": uniq("perm"), "country_code": "US", "ai_engines": ["chatgpt"]}
    for uid in (HQ_HYUNDAI, KIA_US, VENDOR):          # operator assigned·none → 비용 게이트
        async with client_as(uid) as c:
            r = await c.post("/v1/projects", json=base)
        assert r.status_code == 403 and r.json()["error"]["code"] == "operator_forbidden", uid
    async with client_as(GLOBAL_KIA) as c:
        r1 = await c.post("/v1/projects", json={**base, "brand_code": "Hyundai"})
        r2 = await c.post("/v1/projects", json={**base, "country_code": "ZZ"})
        r3 = await c.post("/v1/projects", json={**base, "brand_code": "Kia", "country_code": "kr"})
    assert r1.status_code == 403 and r1.json()["error"]["code"] == "brand_forbidden"
    assert r2.status_code == 403 and r2.json()["error"]["code"] == "country_forbidden"
    assert r3.status_code == 201 and r3.json()["data"]["country_code"] == "KR"
    await purge(r3.json()["data"]["project_id"])
    n = await fetchval("SELECT count(*) FROM app.project WHERE name = $1", base["name"])
    assert n == 0                                       # 거부된 요청은 아무것도 남기지 않는다


async def test_create_validation_422(client_as):
    async with client_as(ADMIN) as c:
        for body, code in (({"name": "x", "country_code": "US", "ai_engines": ["bing"]}, "unknown_engine"),
                           ({"name": "x", "country_code": "US", "ai_engines": []}, "unprocessable"),
                           ({"name": " ", "country_code": "US", "ai_engines": ["chatgpt"]}, "unprocessable"),
                           ({"name": "x", "country_code": "US", "ai_engines": ["chatgpt"], "scope_project_id": str(uuid.uuid4())},
                            "unprocessable")):
            r = await c.post("/v1/projects", json=body)
            assert r.status_code == 422 and r.json()["error"]["code"] == code, body


# ── 상세 ────────────────────────────────────────────────────────────────────────
async def test_detail_visibility(client_as):
    async with client_as(VENDOR) as c:
        r = await c.get(f"/v1/projects/{CUST_PROJECT}")
    d = r.json()["data"]
    assert r.status_code == 200 and d["my_role"] == "viewer" and d["scope_linked"] is True
    assert d["ai_engines"] is None and d["effective_engines"] == ["chatgpt", "gemini"]     # rule_param default_engines
    # 비멤버는 스코프 안이어도 404(명세 PJ-1 auth(3) "활성 멤버 또는 admin", 모듈-프로젝트.md §2 존재 은닉, 검증 D1)
    for uid, pid in ((HQ_HYUNDAI, CUST_PROJECT), (KIA_US, CUST_PROJECT), (ADMIN, ROOT_PROJECT), (ADMIN, uuid.uuid4())):
        async with client_as(uid) as c:
            r = await c.get(f"/v1/projects/{pid}")
        assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    async with client_as(ADMIN) as c:
        assert (await c.get("/v1/projects/not-a-uuid")).status_code == 422


# ── 수정 ────────────────────────────────────────────────────────────────────────
async def test_patch_brand_rebuilds_tracked_and_enqueues(client_as):
    pr = await create_project(client_as, name=uniq("pt"), brand_code="Hyundai")
    pid = uuid.UUID(pr["project_id"])
    try:
        before_jc = await fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'project_setting' AND $1 = ANY(subject_uuids)", pid)
        async with client_as(ADMIN) as c:
            r = await c.patch(f"/v1/projects/{pid}", json={"name": "renamed " + pr["name"], "brand_code": "Kia", "ga4_property_id": "123"})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["brand_code"] == "Kia" and d["ga4_property_id"] == "123" and d["name"].startswith("renamed ")
        tb = await fetch("SELECT canonical_name FROM app.project_tracked_brand WHERE project_id = $1 ORDER BY 1", pid)
        assert [t["canonical_name"] for t in tb] == ["Kia"]
        after_jc = await fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'project_setting' AND $1 = ANY(subject_uuids)", pid)
        assert after_jc == before_jc + 1                        # 트리거가 1건(앱은 직접 넣지 않는다)
        up = await fetch("SELECT payload->>'name' AS name, payload->>'brand_code' AS brand FROM app.scope_outbox "
                         "WHERE aggregate_id = $1 AND op = 'update' AND done_at IS NULL", pid)
        assert up == [{"name": d["name"], "brand": "Kia"}]
    finally:
        await purge(pid)


async def test_patch_permission_validation_and_rollback(client_as):
    pr = await create_project(client_as, name=uniq("pv"))
    pid = pr["project_id"]
    await add_member(pid, VENDOR, "viewer")
    try:
        async with client_as(VENDOR) as c:
            r = await c.patch(f"/v1/projects/{pid}", json={"name": "x"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"
        async with client_as(ADMIN) as c:
            for body in ({"domain": "a.com"}, {"ai_engines": ["chatgpt"]}, {"country_code": "KR"}):
                assert (await c.patch(f"/v1/projects/{pid}", json=body)).status_code == 422, body
            r = await c.patch(f"/v1/projects/{pid}", json={"name": "should-not-stick", "ga4_property_id": "12a"})
            assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_ga4_property_id"
            r = await c.patch(f"/v1/projects/{pid}", json={"name": "should-not-stick", "brand_code": "HMG"})
            assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_brand"
            assert (await c.patch(f"/v1/projects/{pid}", json={})).status_code == 422
        assert await fetchval("SELECT name FROM app.project WHERE project_id = $1", uuid.UUID(pid)) == pr["name"]
        async with client_as(ADMIN) as c:
            assert (await c.patch(f"/v1/projects/{ROOT_PROJECT}", json={"name": "x"})).status_code == 404
    finally:
        await purge(pid)


# ── 삭제 ────────────────────────────────────────────────────────────────────────
async def test_delete_confirm_cascade_and_outbox(client_as):
    pr = await create_project(client_as, name=uniq("del"), domain="https://del.example.com/")
    pid = uuid.UUID(pr["project_id"])
    await add_member(pid, VENDOR, "viewer")
    try:
        async with client_as(VENDOR) as c:
            r = await c.request("DELETE", f"/v1/projects/{pid}", json={"confirm_name": pr["name"]})
        assert r.status_code == 403
        async with client_as(ADMIN) as c:
            r = await c.request("DELETE", f"/v1/projects/{pid}", json={"confirm_name": "wrong"})
            assert r.status_code == 409 and r.json()["error"]["code"] == "name_mismatch"
            assert await fetchval("SELECT count(*) FROM app.project WHERE project_id = $1", pid) == 1
            r = await c.request("DELETE", f"/v1/projects/{pid}", json={"confirm_name": f"  {pr['name']} "})
            assert r.status_code == 204 and r.content == b""
            assert (await c.request("DELETE", f"/v1/projects/{ROOT_PROJECT}", json={"confirm_name": "root"})).status_code == 404
        assert await fetchval("SELECT count(*) FROM app.project WHERE project_id = $1", pid) == 0
        assert await fetchval("SELECT count(*) FROM app.project_owned_base WHERE project_id = $1", pid) == 0
        assert await fetchval("SELECT count(*) FROM app.project_member WHERE project_id = $1", pid) == 0
        ops = await fetch("SELECT op FROM app.scope_outbox WHERE aggregate = 'project' AND aggregate_id = $1 ORDER BY outbox_id", pid)
        assert [o["op"] for o in ops] == ["create", "delete"]
    finally:
        await purge(pid)
