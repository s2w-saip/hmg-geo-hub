"""GET /v1/trend dimension=brand 명부 제외(동기화 S1 BE-5, 현행 hmg-geo 2670a16 excluded-brands.ts filterBrandTrend·filterFirstPosition,
lib/scope/server.ts:3364·:3484-3490 캡 + 제외 수 → recapBrands) 통합 시험. 키 = core.entities(rd.dim_entity registry_role).

합성 픽스처 현대 관점 글로벌: 경쟁 계열 창 언급 순 Toyota 3 · Kia 2(형제) · smart 1. Toyota(Brand, 71…01)를 제외 상태로 두면
top 선정에서 빠지고 다음 순위가 채운다. 당사 계열·분모(버킷 답변·전체 언급)·남은 계열 값은 기준(제외 없음)과 같다.
"""
from __future__ import annotations

import uuid

from app.core.db import fetch_all
from tests.support import HQ_HYUNDAI, Update, needs_db, staged

pytestmark = needs_db
TOYOTA = "71000000-0000-4000-8000-000000000001"
SMART_FORTWO = "71000000-0000-4000-8000-000000000007"       # Product → smart 행(행을 빼지 않는다)


def excluded(*entity_ids: str) -> list[Update]:
    return [Update("rd.dim_entity", {"entity_id": uuid.UUID(e)}, {"registry_role": "excluded"}) for e in entity_ids]


async def get(client_as, uid, params) -> dict:
    async with client_as(uid) as c:
        r = await c.get("/v1/trend", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def pair(client_as, params, *entity_ids):
    async with staged():
        base = await get(client_as, HQ_HYUNDAI, params)
    async with staged(*excluded(*entity_ids)):
        got = await get(client_as, HQ_HYUNDAI, params)
    return base, got


def keys(body, metric="share_of_voice"):
    return [s["key"] for s in body["data"]["series"] if s["metric"] == metric]


def by_key(body):
    return {(s["metric"], s["key"]): s for s in body["data"]["series"]}


async def test_top_refills_after_excluded(client_as):
    params = {"surface": "global", "dimension": "brand", "top": 1, "metrics": "M01,M02,M03,M04"}
    base, got = await pair(client_as, params, TOYOTA)
    assert keys(base) == ["own", "Toyota"]
    assert keys(got) == ["own", "Kia"]                                        # 다음 순위(Kia)가 top 자리를 채운다
    wide = by_key((await pair(client_as, {**params, "top": 2}))[0])          # 기준 top 2 의 Kia 계열 = 제외 뒤 top 1 의 Kia 계열
    g = by_key(got)
    for m in ("visibility", "share_of_voice", "sentiment", "position"):
        assert g[(m, "Kia")] == wide[(m, "Kia")]
        assert g[(m, "own")] == by_key(base)[(m, "own")]                      # 당사 계열(분모 포함) 그대로
    assert got["data"]["buckets"] == base["data"]["buckets"] and got["meta"] == base["meta"]


async def test_default_top_drops_only_excluded(client_as):
    params = {"surface": "global", "dimension": "brand"}
    base, got = await pair(client_as, params, TOYOTA)
    assert keys(base) == ["own", "Toyota", "Kia", "smart"]
    assert keys(got) == ["own", "Kia", "smart"]
    b = by_key(base)
    for k, s in by_key(got).items():
        assert s == b[k]


async def test_requested_excluded_key_is_dropped(client_as):
    async with staged() as conn:
        toyota_key = int((await fetch_all(conn, "SELECT n.brand_key FROM rd.dim_brand_name n WHERE n.name = 'Toyota'"))[0]["brand_key"])
    params = {"surface": "global", "dimension": "brand", "top": 1, "brand_key": str(toyota_key)}
    base, got = await pair(client_as, params, TOYOTA)
    assert keys(base) == ["own", "Toyota"] and base["meta"]["dropped_filters"] == {}
    assert keys(got) == ["own", "Kia"]
    assert got["meta"]["dropped_filters"] == {"brand_key": [str(toyota_key)]}   # 경쟁 목록에 나올 수 없는 키: 조용히 무시하지 않는다


async def test_product_entity_does_not_drop(client_as):
    base, got = await pair(client_as, {"surface": "global", "dimension": "brand"}, SMART_FORTWO)
    assert got == base
