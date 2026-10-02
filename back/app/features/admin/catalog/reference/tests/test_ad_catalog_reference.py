"""admin.catalog.reference 통합 테스트(로컬 개발 DB 복제본 ad_content). 기대값은 독립 SQL(DISTINCT 집합 비교)."""
from __future__ import annotations

import asyncpg
import pytest

from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_EU, KIA_US, ROOT_PROJECT, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db
KEYS = ("brand_code", "brand_presence", "list_type", "depth1", "depth2", "depth3", "depth4")


async def _fetch(sql: str, *args):
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetch(sql, *args)
    finally:
        await c.close()


@pytest.mark.parametrize("path", ["/v1/admin/catalog/taxonomy", "/v1/admin/catalog/markets"])
@pytest.mark.parametrize("uid,status", [(ADMIN, 200), (HQ_HYUNDAI, 403), (KIA_US, 403), (VENDOR, 403), (KIA_EU, 403),
                                        (SUSPENDED, 401), (None, 401)])
async def test_access(client_as, path, uid, status):
    async with client_as(uid) as c:
        r = await c.get(path)
    assert r.status_code == status


async def test_taxonomy_matches_catalog(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/admin/catalog/taxonomy", params={"brand": "Kia"})
    assert r.status_code == 200
    body = r.json()
    rows = await _fetch("SELECT brand_code, brand_presence, list_type, depth1, depth2, depth3, depth4 FROM app.prompt "
                        "WHERE project_id = $1 AND deleted_at IS NULL", ROOT_PROJECT)
    exp = {tuple(r[k] for k in KEYS) for r in rows}
    got = [tuple(i[k] for k in KEYS) for i in body["data"]["items"]]
    assert set(got) == exp and len(got) == len(exp)                         # DISTINCT(중복 없음)
    assert ("Hyundai", "branded", "L1", "D1", "D2a", None, None) in exp     # 픽스처 04
    fs = await _fetch("SELECT DISTINCT funnel_stage FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL "
                      "AND funnel_stage IS NOT NULL", ROOT_PROJECT)
    assert body["data"]["funnel_stages"] == sorted(r["funnel_stage"] for r in fs)
    assert body["meta"]["ignored_filters"] == ["brand"] and body["meta"]["mode"] == "catalog"


async def test_markets_unbounded_when_root_has_no_regions(client_as):
    """픽스처 루트 rd.dim_project.regions 는 NULL → 어휘 없음(상한 없음, 편집은 형식만 검사)."""
    rv = await _fetch("SELECT regions FROM rd.dim_project WHERE surface = 1 AND is_root")
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/admin/catalog/markets")
    d = r.json()["data"]
    if rv[0]["regions"] is None:
        assert d == {"items": [], "bounded": False}
    assert r.json()["meta"]["source"] == {"regions": "rd.dim_project.regions"}


async def test_markets_bounded(client_as, monkeypatch):
    """어휘가 있으면 정규화(트림·대문자·x: 표기)·정렬해 준다. 테스트는 rd 를 쓰지 않으려고 어휘 조회 문장을 상수 SELECT 로 바꿔 끼운다."""
    from app.features.admin.catalog.prompts import queries as pq

    monkeypatch.setattr(pq, "ROOT_DIM_SQL", "SELECT project_key, ARRAY['gb', ' US', 'x:eu', 'US']::text[] AS regions "
                                            "FROM rd.dim_project WHERE surface = 1 AND is_root ORDER BY project_key LIMIT 1")
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/admin/catalog/markets")
    assert r.json()["data"] == {"items": [{"code": "GB", "pseudo": False}, {"code": "US", "pseudo": False},
                                          {"code": "x:EU", "pseudo": True}], "bounded": True}
