"""projects.settings.overview(PJ-4) API 테스트: 설정 묶음 1회 조회 형태·값(독립 SQL 대조)·권한."""
from __future__ import annotations

import uuid

from app.features.projects.project.core.tests.helpers import add_member, create_project, fetchval, purge, uniq
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db


async def test_bundle_values_and_permissions(client_as):
    pr = await create_project(client_as, name=uniq("ov"), brand_code="Kia", country_code="DE", domain="https://kia.example.com/de",
                              ai_engines=["gemini"])
    pid = pr["project_id"]
    base = f"/v1/projects/{pid}/settings"
    try:
        async with client_as(ADMIN) as c:
            empty = (await c.get(base)).json()["data"]
            assert empty["competitors"] == [] and empty["vehicles"] == [] and empty["tracked_url_count"] == 0
            assert empty["brand_aliases"] == {"brand_code": "Kia", "aliases": []}
            await c.put(f"{base}/brand-aliases", json={"brand_code": "Kia", "aliases": ["기아"]})
            await c.post(f"{base}/competitors", json={"brand_name": "BMW"})
            await c.post(f"{base}/vehicles", json={"brand": "Kia", "model": "EV9"})
            await c.post(f"{base}/tracked-urls", json={"url": "https://kia.example.com/de/ev9"})
            r = await c.get(base, params={"lang": "de"})
        assert r.status_code == 200 and r.json()["meta"]["ignored_filters"] == ["lang"]
        d = r.json()["data"]
        assert d["domain"] == "kia.example.com/de" and d["can_edit"] and d["my_role"] == "owner"
        assert d["engines"] == {"stored": ["gemini"], "effective": ["gemini"], "allowed": ["chatgpt", "gemini", "deepseek"],
                                "can_edit": True}
        assert [b["base_norm"] for b in d["owned_bases"]] == ["kia.example.com/de"]
        assert d["brand_aliases"] == {"brand_code": "Kia", "aliases": ["기아"]}
        assert [x["brand_name"] for x in d["competitors"]] == ["BMW"] and [x["model"] for x in d["vehicles"]] == ["EV9"]
        assert d["tracked_url_count"] == await fetchval("SELECT count(*) FROM app.project_tracked_url WHERE project_id = $1",
                                                        uuid.UUID(pid)) == 1
        await add_member(pid, VENDOR, "viewer")
        async with client_as(VENDOR) as c:
            v = (await c.get(base)).json()["data"]
        assert v["can_edit"] is False and v["my_role"] == "viewer" and v["engines"]["can_edit"] is False
        for uid in (HQ_HYUNDAI, KIA_US):
            async with client_as(uid) as c:
                assert (await c.get(base)).status_code == 404, uid
    finally:
        await purge(pid)


async def test_legacy_null_engines_effective_default(client_as):
    async with client_as(VENDOR) as c:
        d = (await c.get(f"/v1/projects/{CUST_PROJECT}/settings")).json()["data"]
    assert d["engines"]["stored"] is None and d["engines"]["effective"] == ["chatgpt", "gemini"]
    assert [b["base_norm"] for b in d["owned_bases"]] == ["mybrand.example.com/news"] and d["tracked_url_count"] == 1
    async with client_as(ADMIN) as c:
        assert (await c.get(f"/v1/projects/{uuid.uuid4()}/settings")).status_code == 404


async def test_view_card_and_statements(client_as):
    """B022: 프로젝트 행·추적 URL 건수·별칭 행·기본 엔진은 한 문장(프로젝트 재조회·건수·별칭 문장 따로 없음).
    view=card(홈 KPI 카드) = 카드가 쓰는 값만: domain·owned_bases·tracked_url_count·권한 필드는 full 과 같고, 경쟁사는 지정 비교 브랜드 행만,
    engines·brand_aliases·vehicles 는 null. 차종·경쟁사 전체 목록 문장을 실행하지 않는다."""
    from tests.core.rcache_calls import Stmts
    pr = await create_project(client_as, name=uniq("ovc"), brand_code="Kia", country_code="DE", domain="https://kia.example.com/de")
    pid = pr["project_id"]
    base = f"/v1/projects/{pid}/settings"
    try:
        async with client_as(ADMIN) as c:
            await c.put(f"{base}/brand-aliases", json={"brand_code": "Kia", "aliases": ["기아"]})
            for name in ("BMW", "Audi"):
                await c.post(f"{base}/competitors", json={"brand_name": name})
            await c.put(f"{base}/competitors/target", json={"brand_name": "BMW"})
            await c.post(f"{base}/vehicles", json={"brand": "Kia", "model": "EV9"})
            await c.post(f"{base}/tracked-urls", json={"url": "https://kia.example.com/de/ev9"})
            with Stmts() as full_sql:
                full = (await c.get(base)).json()["data"]
            with Stmts() as card_sql:
                r = await c.get(base, params={"view": "card"})
            assert (await c.get(base, params={"view": "page"})).status_code == 422
        assert r.status_code == 200, r.text
        card = r.json()["data"]
        same = ("project_id", "domain", "my_role", "can_edit", "owned_bases", "tracked_url_count")
        assert {k: card[k] for k in same} == {k: full[k] for k in same} and full["tracked_url_count"] == 1
        assert [x["brand_name"] for x in full["competitors"]] == ["Audi", "BMW"]
        assert card["competitors"] == [x for x in full["competitors"] if x["is_target"]]
        assert card["engines"] is None and card["brand_aliases"] is None and card["vehicles"] is None
        assert full["brand_aliases"] == {"brand_code": "Kia", "aliases": ["기아"]} and [v["model"] for v in full["vehicles"]] == ["EV9"]
        bundle_sql = [x for x in full_sql.seen if "app.project_tracked_url" in x]
        assert len(bundle_sql) == 1 and "app.project_tracked_brand" in bundle_sql[0] and "app.rule_param" in bundle_sql[0]
        assert not any("SELECT domain, brand_code, ai_engines FROM app.project" in x for x in full_sql.seen)
        assert not any("app.project_tracked_vehicle" in x for x in card_sql.seen)
        comp_sql = [x for x in card_sql.seen if "FROM app.project_tracked_competitor c" in x]
        assert len(comp_sql) == 1 and "AND c.is_target ORDER BY" in comp_sql[0]
        for uid in (HQ_HYUNDAI, KIA_US):
            async with client_as(uid) as c:
                assert (await c.get(base, params={"view": "card"})).status_code == 404, uid
    finally:
        await purge(pid)
