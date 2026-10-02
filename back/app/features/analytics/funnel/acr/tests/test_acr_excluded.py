"""GET /v1/funnel/acr 명부 제외(동기화 S1 BE-5) 통합 시험. 현행 hmg-geo 2670a16 excluded-brands.ts:258-262 filterAcr 와 같은 동작
(메인 결정 2026-09-30): 캐시된 상위 목록(LIMIT)에서 브랜드 표만 거른다. 다음 순위로 채우지 않고, 추이 시리즈는 거르기 전 목록에서 고른다.

기대값 기준 = conftest(acr_seed) + 공용 셀 501. 관리자 스냅샷: 브랜드 표 Hyundai 5 · Toyota 2(셀 2) · Kia 2(셀 1), 추이 시리즈
Hyundai·Kia·Toyota. Toyota(Brand, 71…01) 제외 → 표 Hyundai·Kia, 시리즈는 그대로 Hyundai·Kia·Toyota. 총량·분모·배틀·차종·점유 맵 그대로.
"""
from __future__ import annotations

import uuid

import pytest

from tests.support import ADMIN, HQ_HYUNDAI, Update, needs_db, savepoint, stage

URL = "/v1/funnel/acr"
TOYOTA = "71000000-0000-4000-8000-000000000001"
SMART_FORTWO = "71000000-0000-4000-8000-000000000007"
pytestmark = [needs_db, pytest.mark.usefixtures("acr_seed")]


def excluded(*entity_ids: str) -> list[Update]:
    return [Update("rd.dim_entity", {"entity_id": uuid.UUID(e)}, {"registry_role": "excluded"}) for e in entity_ids]


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        r = await c.get(URL, params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def _pair(client_as, conn, uid, *entity_ids, **params):
    base = await _get(client_as, uid, **params)
    async with savepoint(conn):
        await stage(conn, *excluded(*entity_ids))
        got = await _get(client_as, uid, **params)
    return base, got


def _names(d):
    return [b["brand"] for b in d["brands"]]


async def test_brand_table_drops_excluded_series_kept(client_as, acr_seed):
    base, got = await _pair(client_as, acr_seed, ADMIN, TOYOTA, surface="global")
    b, g = base["data"], got["data"]
    assert _names(b) == ["Hyundai", "Toyota", "Kia"] and _names(g) == ["Hyundai", "Kia"]
    bb = {x["brand"]: x for x in b["brands"]}
    for x in g["brands"]:
        assert x == bb[x["brand"]]                                            # 남은 행 값(choice_share 분모 9 등) 그대로
    assert g["totals"] == b["totals"]
    # 추이는 현행처럼 거르기 전 목록에서 고른다: 제외 브랜드 선도 남는다(filterAcr 는 brands 만 거른다)
    assert g["trend"] == b["trend"] and g["trend"]["series_brands"] == ["Hyundai", "Kia", "Toyota"]
    # 셀 값 구획(배틀 승자·차종·점유 맵 항목)도 현행처럼 거르지 않는다
    assert g["battle"] == b["battle"] and g["model_conversion"] == b["model_conversion"] and g["territory"] == b["territory"]
    assert g["options"] == b["options"] and got["meta"] == base["meta"]


async def test_top_brands_not_refilled(client_as, acr_seed):
    """현행: 캐시된 상위 목록을 거르므로 표가 제외 수만큼 준다(다음 순위로 채우지 않는다)."""
    base, got = await _pair(client_as, acr_seed, ADMIN, TOYOTA, surface="global", top_brands=2)
    assert _names(base["data"]) == ["Hyundai", "Toyota"]
    assert _names(got["data"]) == ["Hyundai"]
    assert got["data"]["trend"] == base["data"]["trend"]


async def test_ours_kept_and_product_entity_no_op(client_as, acr_seed):
    base, got = await _pair(client_as, acr_seed, HQ_HYUNDAI, SMART_FORTWO, surface="global")
    assert got == base
    base, got = await _pair(client_as, acr_seed, HQ_HYUNDAI, TOYOTA, surface="global")
    assert [b["brand"] for b in got["data"]["brands"] if b["is_ours"]] == [b["brand"] for b in base["data"]["brands"] if b["is_ours"]]
    assert "Toyota" not in _names(got["data"])
