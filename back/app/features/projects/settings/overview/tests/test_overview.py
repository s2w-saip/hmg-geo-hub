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
