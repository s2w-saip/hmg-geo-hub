"""GET /v1/mentions/brands 카드 경로 브랜드 상한(현행 프로필 card_brand_cap, WU-12) 통합 시험.

현행(hmg-geo 2670a16): 대시보드 카드 브랜드 목록은 집계층 브랜드 축을 row_number() OVER (ORDER BY mentions DESC, brand_name) <= 200 으로
자른다(summary-trend-aggregates.ts:353·1014-1022, 당사 행 포함). 명부 제외는 그 뒤(withExcludedBrands, 캐시 밖)라 제외 행이 상위 200 안에
있으면 목록은 그만큼 짧아지고 201위가 채우지 않는다. 언급 화면(S2.mention 은 read_screens 14키 밖 = 미러)은 절단이 없다 → card=false 는 그대로.

합성 픽스처(test_mentions_brands_excluded.py 머리 주석): 현대 관점 당사 Hyundai 5, 경쟁 Toyota 3·Kia 2(형제)·smart 1, 답변 3, 언급 11,
brand_count 4. 상한을 3 으로 바꿔(monkeypatch) 경쟁 몫 = 3 − 당사 행 1 = 2 를 만든다.
"""
from __future__ import annotations

import pytest

from app.core.config import set_settings
from app.features.analytics.mentions.brands import service as svc
from app.features.analytics.mentions.brands.tests.test_mentions_brands_excluded import TOYOTA, _rows, excluded
from tests.support import HQ_HYUNDAI, TEST_NAME_KEY, needs_db, staged

pytestmark = needs_db
URL = "/v1/mentions/brands"
# 현행 프로필 NAME 으로 투영된 복제본: 픽스처 'TOYOTA'(1) 가 'Toyota'(2) 와 다른 표시 브랜드 행이다(운영 생성기 = 표기 그대로 묶음).
#   그러면 Toyota 2 가 Kia 2 와 동률이라 이름순(Kia 먼저), 브랜드 수 5. 끔은 Toyota 3 한 행·브랜드 수 4.
NAME = TEST_NAME_KEY
FULL = ([("Hyundai", 1), ("Kia", 2), ("Toyota", 3), ("smart", 4), ("TOYOTA", 5)] if NAME
        else [("Hyundai", 1), ("Toyota", 2), ("Kia", 3), ("smart", 4)])
N_BRANDS = 5 if NAME else 4


async def _get(client_as, params):
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get(URL, params=params)
    assert r.status_code == 200, r.text
    return r.json()["data"]


@pytest.fixture
def cap3(monkeypatch, settings):
    monkeypatch.setattr(svc, "CARD_BRAND_CAP", 3)
    set_settings(settings.model_copy(update={"legacy_profile": "card_brand_cap"}))
    yield
    set_settings(settings)


async def test_card_cap_keeps_top_rows_and_totals(client_as, cap3):
    async with staged():
        card = await _get(client_as, {"surface": "global", "card": "true", "full": "true"})
        screen = await _get(client_as, {"surface": "global", "full": "true"})
        card_engine = await _get(client_as, {"surface": "global", "card": "true", "full": "true", "group_by": "engine"})
    assert _rows(card) == FULL[:3]                                                     # 4위 이하 절단
    assert _rows(screen) == FULL                                                       # 언급 화면(card=false) 은 절단 없음
    assert card["totals"] == screen["totals"] == {"answers": 3, "mentions_total": 11, "brand_count": N_BRANDS}   # 잔여 행 보존 = 합계 그대로
    assert card["own"] == screen["own"]
    for e in card_engine["by_engine"]:                                                  # 엔진 축도 같은 상한(엔진마다 당사 1 + 경쟁 2)
        assert len(e["brands"]) <= 3


async def test_card_cap_applies_before_exclusion(client_as, cap3):
    """제외 행(Toyota)이 상위 200 안이면 목록이 짧아지고 다음 순위(smart)가 채우지 않는다(현행 SQL 절단 → 캐시 밖 제외)."""
    async with staged(*excluded(TOYOTA)):
        card = await _get(client_as, {"surface": "global", "card": "true", "full": "true"})
        screen = await _get(client_as, {"surface": "global", "full": "true"})
    assert _rows(card) == [("Hyundai", 1), ("Kia", 2)]
    assert _rows(screen) == ([("Hyundai", 1), ("Kia", 2), ("smart", 3), ("TOYOTA", 4)] if NAME     # 'TOYOTA' 엔티티는 제외 대상 아님
                             else [("Hyundai", 1), ("Kia", 2), ("smart", 3)])
    assert card["totals"]["brand_count"] == N_BRANDS


async def test_card_cap_off_is_unchanged(client_as, monkeypatch, settings):
    monkeypatch.setattr(svc, "CARD_BRAND_CAP", 3)
    set_settings(settings.model_copy(update={"legacy_profile": "off"}))
    try:
        async with staged():
            card = await _get(client_as, {"surface": "global", "card": "true", "full": "true"})
    finally:
        set_settings(settings)
    assert _rows(card) == FULL
