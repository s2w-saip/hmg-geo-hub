"""GET /v1/geo 명부 제외(동기화 S1 BE-5) 통합 시험. 현행 hmg-geo 2670a16: excluded-brands.ts markExcludedGeo(행은 두고 표식),
dashboard/_data/live.ts:140 marketStats·overview-metrics.ts:44 marketMetrics(경쟁사·최대 경쟁사·순위 모수에서만 건너뜀, 분모 total 그대로).

합성 픽스처(test_geo.py 머리 주석): 현대 관점 US 경쟁 = Toyota 3 · smart 1(Kia 는 형제라 경쟁사 아님), 당사 5/11, 순위 1·필드 3,
최대 경쟁사 Toyota. Toyota(Brand, 71…01) 제외 → 최대 경쟁사 smart, 필드 2(당사 + smart), 당사 값·분모 11 그대로.
"""
from __future__ import annotations

import uuid

from tests.support import HQ_HYUNDAI, Update, needs_db, staged

pytestmark = needs_db
TOYOTA = "71000000-0000-4000-8000-000000000001"
SMART = "71000000-0000-4000-8000-000000000006"             # Brand → smart 행
SMART_FORTWO = "71000000-0000-4000-8000-000000000007"      # Product → smart 행(행을 빼지 않는다)


def excluded(*entity_ids: str) -> list[Update]:
    return [Update("rd.dim_entity", {"entity_id": uuid.UUID(e)}, {"registry_role": "excluded"}) for e in entity_ids]


async def get(client_as, params) -> dict:
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get("/v1/geo", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def pair(client_as, params, *entity_ids):
    async with staged():
        base = await get(client_as, params)
    async with staged(*excluded(*entity_ids)):
        got = await get(client_as, params)
    return base, got


def rt(x):
    return (x["num"], x["den"]) if x else None


async def test_excluded_rival_skipped_values_kept(client_as):
    base, got = await pair(client_as, {"surface": "global"}, TOYOTA)
    bna, gna = base["data"]["markets"][0], got["data"]["markets"][0]
    bus, gus = bna["countries"][0], gna["countries"][0]
    assert bus["top_rival"]["brand"] == "Toyota" and bus["rank"] == {"our": 1, "field_size": 3}
    assert gus["top_rival"]["brand"] == "smart" and gus["rank"] == {"our": 1, "field_size": 2}   # 순위 모수에서 빠진다
    assert rt(gus["top_rival"]["metrics"]["share_of_voice"]) == (1, 11)                        # 분모 = 시장 전체 언급(제외 행 포함)
    assert gus["own"] == bus["own"] and rt(gus["own"]["share_of_voice"]) == (5, 11)           # 당사 값·분모 그대로
    assert gus["answers"] == bus["answers"] and gus["top_own_brand"] == bus["top_own_brand"]
    assert gna["own"] == bna["own"] and gna["rank"] == gus["rank"] and gna["top_rival"] == gus["top_rival"]   # 권역 = 국가 합
    assert got["data"]["pending"] == base["data"]["pending"] and got["meta"] == base["meta"]


async def test_rank_moves_when_excluded_was_ahead(client_as):
    """gemini 만: 당사 0, 경쟁 smart 1 → 순위 2·필드 2. smart 계열 Brand 가 제외면 당사 1위·필드 1, 최대 경쟁사 없음."""
    params = {"surface": "global", "engine": "gemini"}
    base, got = await pair(client_as, params, SMART)
    bus, gus = base["data"]["markets"][0]["countries"][0], got["data"]["markets"][0]["countries"][0]
    assert bus["rank"] == {"our": 2, "field_size": 2} and bus["top_rival"]["brand"] == "smart"
    assert gus["rank"] == {"our": 1, "field_size": 1} and gus["top_rival"] is None
    assert gus["own"] == bus["own"] and rt(gus["own"]["share_of_voice"]) == (0, 3)            # 분모 3 = Kia 2 + smart 1 그대로


async def test_product_entity_does_not_drop(client_as):
    base, got = await pair(client_as, {"surface": "global"}, SMART_FORTWO)
    assert got == base
