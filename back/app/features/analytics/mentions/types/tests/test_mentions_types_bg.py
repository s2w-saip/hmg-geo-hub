"""GET /v1/mentions/types split_own(D13, 검증 결함 D-2) 테스트. 기대값은 합성 픽스처 손 계산(back/tests/fixtures/fixture-10-data.sql).

글로벌 스냅샷(회차 11) admin 관점(비트 1·2·4): 답변 3(k1·k2·k12). 경쟁·std_in answer_brand 행(유형은 전부 t_mention):
  Hyundai(비트 1) k1 t4(pos 3·neu 1)·k12 t1(pos 1) · Kia(비트 2) k2 t2(pos 1·mix 1) · Toyota k1 t3(neu 1·neg 1) · smart k2 t1.
합친 관점 mention: 당사 7(답변 3)·비교 4(답변 2).
split_own(그 비트만 당사로 둔 스코프, 비교 = 그 밖 경쟁 행 전부):
  Hyundai: 당사 5·답변 2, 비교 6(Toyota 3 + Kia 2 + smart 1)·답변 2(k1·k2), 매트릭스 own 행 2·pos 4·neu 1.
  Kia:     당사 2·답변 1, 비교 9·답변 3, 매트릭스 own 행 1·pos 1·mix 1.
  Genesis: 당사 0, 비교 11·답변 3.
스탠스: 현대 관점 {positive 1, pairs 1}, admin 합친 관점 {positive 1, mixed 1, pairs 2}(types README 손 계산) → Kia {mixed 1, pairs 1}.
"""
from __future__ import annotations

import pytest

from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, VENDOR, needs_db

pytestmark = needs_db
URL = "/v1/mentions/types"
STANCE_KEYS = ("positive", "neutral", "mixed", "negative", "pairs")


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _mention(block):
    return next(x for x in block["by_type"] if x["type"] == "mention")


async def test_split_own_admin_blocks(client_as):
    r = await _get(client_as, ADMIN, surface="global", split_own="true")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    base = (await _get(client_as, ADMIN, surface="global")).json()["data"]
    assert {k: v for k, v in d.items() if k != "by_own_brand"} == base                  # 합친 값은 split_own 과 무관
    assert "by_own_brand" not in base                                                    # 요청하지 않으면 키가 없다
    blocks = {b["own_brand_code"]: b for b in d["by_own_brand"]}
    assert [b["own_brand_code"] for b in d["by_own_brand"]] == ["Hyundai", "Kia", "Genesis"]   # 비트 오름차순, 행 키 = mentions/brands·trend
    h, k, g = _mention(blocks["Hyundai"]), _mention(blocks["Kia"]), _mention(blocks["Genesis"])
    assert (h["own_mentions"], h["own_answers"], h["other_mentions"], h["other_answers"], h["own_exposure"], h["own_share"]) == (
        5, 2, 6, 2, {"num": 2, "den": 3}, {"num": 5, "den": 11})
    assert (k["own_mentions"], k["own_answers"], k["other_mentions"], k["other_answers"]) == (2, 1, 9, 3)
    assert (g["own_mentions"], g["own_answers"], g["other_mentions"], g["other_answers"]) == (0, 0, 11, 3)
    hm = next(c for c in blocks["Hyundai"]["sentiment_matrix"] if c["type"] == "mention" and c["scope"] == "own")
    km = next(c for c in blocks["Kia"]["sentiment_matrix"] if c["type"] == "mention" and c["scope"] == "own")
    assert (hm["rows"], hm["positive"], hm["neutral"]) == (2, 4, 1) and (km["rows"], km["positive"], km["mixed"]) == (1, 1, 1)
    assert blocks["Hyundai"]["stance"] == {"positive": 1, "neutral": 0, "mixed": 0, "negative": 0, "pairs": 1}
    assert blocks["Kia"]["stance"] == {"positive": 0, "neutral": 0, "mixed": 1, "negative": 0, "pairs": 1}
    # 행 가산 불변식: 가른 당사 언급·스탠스 합 = 합친 관점
    for t in range(5):
        assert sum(b["by_type"][t]["own_mentions"] for b in d["by_own_brand"]) == d["by_type"][t]["own_mentions"]
    assert {s: sum(b["stance"][s] for b in d["by_own_brand"]) for s in STANCE_KEYS} == d["stance"]


async def test_split_own_matches_brands_split_types(client_as):
    """다른 경로 대조: 가른 블록의 유형별 당사 언급 = /v1/mentions/brands?split_own&include=types 의 같은 own_brand_code 행 types."""
    d = (await _get(client_as, ADMIN, surface="global", split_own="true")).json()["data"]
    async with client_as(ADMIN) as c:
        m1 = (await c.get("/v1/mentions/brands", params={"surface": "global", "split_own": "true", "include": ["types"]})).json()["data"]
    rows = {b["own_brand_code"]: b["types"] for b in m1["brands"] if b["is_own"]}
    assert {b["own_brand_code"]: {x["type"]: x["own_mentions"] for x in b["by_type"]} for b in d["by_own_brand"]} == rows


async def test_split_own_single_viewpoint_empty(client_as):
    """관점 비트가 하나면 가르지 않는다(core.measure.split_own_scopes → ()): by_own_brand = [], 나머지 값은 그대로."""
    for uid, params in ((HQ_HYUNDAI, {"surface": "global"}), (KIA_EU, {"surface": "website"}),
                        (VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT)}), (ADMIN, {"surface": "global", "brand": ["Kia"]})):
        base = (await _get(client_as, uid, **params)).json()["data"]
        r = await _get(client_as, uid, **params, split_own="true")
        assert r.status_code == 200, (uid, r.text)
        d = r.json()["data"]
        assert d["by_own_brand"] == [] and {k: v for k, v in d.items() if k != "by_own_brand"} == base, (uid, params)


async def test_split_own_empty_window(client_as):
    d = (await _get(client_as, ADMIN, surface="global", split_own="true", **{"from": "2025-01-01", "to": "2025-01-31"})).json()["data"]
    assert [b["own_brand_code"] for b in d["by_own_brand"]] == ["Hyundai", "Kia", "Genesis"]
    assert all(b["stance"]["pairs"] == 0 and all(x["own_mentions"] == 0 and x["own_exposure"]["den"] == 0 for x in b["by_type"])
               for b in d["by_own_brand"])


@pytest.mark.parametrize("value", ["maybe", "2"])
async def test_split_own_bad_value_422(client_as, value):
    r = await _get(client_as, HQ_HYUNDAI, surface="global", split_own=value)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", r.text
