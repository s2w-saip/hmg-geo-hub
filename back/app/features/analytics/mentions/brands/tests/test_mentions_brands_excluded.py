"""GET /v1/mentions/brands 명부 제외(동기화 S1 BE-5, 현행 hmg-geo 2670a16 excluded-brands.ts, 키 = core.entities) 통합 시험.

합성 픽스처(test_mentions_brands_bg.py 머리 주석과 같은 답변셋): 글로벌 스냅샷 현대 관점 경쟁 행 = Toyota 3·Kia 2(형제)·smart 1,
당사 Hyundai 5, 답변 3, 전체 언급 11, brand_count 4. rd.dim_entity: Toyota(Brand, 71…01) → Toyota 행, 'Smart Fortwo'(Product, 71…07)
→ smart 행, 'Hyundai Creta'(Product, 71…04) → Hyundai 행, '기아'(Brand 별칭, ed4b8012…) → Kia 행(HMG).
제외 상태는 rd.dim_entity.registry_role 를 롤백 전용 준비로 바꿔 만든다(적재 재판정 REGISTRY_ROLE_REFRESH 가 만드는 상태와 같다).
기대값 = 제외 없는 같은 요청(기준)에서 제외 행만 빠지고 순위가 다시 매겨진 것(현행 규칙). 값·분모·brand_count 는 기준과 같다.
"""
from __future__ import annotations

import uuid

from tests.support import ADMIN, HQ_HYUNDAI, Rows, Update, needs_db, staged

pytestmark = needs_db
URL = "/v1/mentions/brands"
TOYOTA = "71000000-0000-4000-8000-000000000001"
SMART_FORTWO = "71000000-0000-4000-8000-000000000007"       # Product → smart 행
HYUNDAI_CRETA = "71000000-0000-4000-8000-000000000004"      # Product → Hyundai 행
KIA_ALIAS = "ed4b8012-4a73-4174-9b43-4cb696934b25"          # Brand '기아' → Kia 행(HMG, 형제 경쟁 행)


def excluded(*entity_ids: str) -> list[Update]:
    return [Update("rd.dim_entity", {"entity_id": uuid.UUID(e)}, {"registry_role": "excluded"}) for e in entity_ids]


async def _get(client_as, uid, params):
    async with client_as(uid) as c:
        r = await c.get(URL, params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def _pair(client_as, uid, params, *entity_ids):
    """(기준 = 제외 없음, 제외 상태) 응답 두 개. 기준도 같은 롤백 준비 경로(빈 준비)로 부른다."""
    async with staged():
        base = await _get(client_as, uid, params)
    async with staged(*excluded(*entity_ids)):
        got = await _get(client_as, uid, params)
    return base, got


def _rows(d):
    return [(b["name"], b["rank"]) for b in d["brands"]]


def _without_rank(b):
    return {k: v for k, v in b.items() if k != "rank"}


async def test_excluded_competitor_leaves_list_values_kept(client_as):
    params = {"surface": "global", "include": ["prompts", "multi", "types", "hmg"]}
    base, got = await _pair(client_as, HQ_HYUNDAI, params, TOYOTA)
    b, g = base["data"], got["data"]
    assert _rows(b) == [("Hyundai", 1), ("Toyota", 2), ("Kia", 3), ("smart", 4)]
    assert _rows(g) == [("Hyundai", 1), ("Kia", 2), ("smart", 3)]            # 제외 행만 빠지고 순위는 남은 행으로
    assert g["totals"] == b["totals"] == {"answers": 3, "mentions_total": 11, "brand_count": 4}   # 분모·고유 브랜드 수 불변
    assert g["own"] == b["own"]                                               # 당사 블록 값·순위(1위) 그대로
    assert g["types_total"] == b["types_total"] and g["types_total"]["mention"] == 11             # 유형 총계 = 전 경쟁 행 합
    bb = {x["name"]: _without_rank(x) for x in b["brands"]}
    for x in g["brands"]:
        assert _without_rank(x) == bb[x["name"]]                              # 남은 행 값(점유율 분모 11 포함) 그대로
    assert got["meta"] == base["meta"]


async def test_top_n_refills_next_rank(client_as):
    """경쟁사 선정(Overview 경쟁사·KPI #16 SOV 1위 경쟁사)은 제외 뒤 다음 순위가 채운다(현행 filterCompetitorValues·filterAggregatesBrands)."""
    base, got = await _pair(client_as, HQ_HYUNDAI, {"surface": "global", "top_n": 1}, TOYOTA)
    assert _rows(base["data"]) == [("Hyundai", 1), ("Toyota", 2)]
    assert _rows(got["data"]) == [("Hyundai", 1), ("Kia", 2)]
    assert got["data"]["totals"] == base["data"]["totals"]
    # q·brand_key 로 제외 행을 찾아도 나오지 않는다
    async with staged(*excluded(TOYOTA)):
        q = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "q": "toyo"})
    assert _rows(q["data"]) == [("Hyundai", 1)]


async def test_by_engine_blocks(client_as):
    base, got = await _pair(client_as, HQ_HYUNDAI, {"surface": "global", "group_by": "engine"}, TOYOTA)
    be = {e["engine"]: e for e in base["data"]["by_engine"]}
    ge = {e["engine"]: e for e in got["data"]["by_engine"]}
    assert [x["name"] for x in be["chatgpt"]["brands"]] == ["Hyundai", "Toyota"]
    assert [(x["name"], x["rank"]) for x in ge["chatgpt"]["brands"]] == [("Hyundai", 1)]
    assert ge["chatgpt"]["totals"] == be["chatgpt"]["totals"] == {"answers": 2, "mentions_total": 8, "brand_count": 2}
    assert ge["gemini"] == be["gemini"]                                       # Toyota 없는 엔진 블록은 그대로


async def test_split_own_admin(client_as):
    base, got = await _pair(client_as, ADMIN, {"surface": "global", "split_own": "true"}, TOYOTA)
    assert _rows(base["data"]) == [("Hyundai", 1), ("Toyota", 2), ("Kia", 3), ("smart", 4), ("Genesis", 5)]
    assert _rows(got["data"]) == [("Hyundai", 1), ("Kia", 2), ("smart", 3), ("Genesis", 4)]
    assert got["data"]["totals"] == base["data"]["totals"] and got["data"]["totals"]["brand_count"] == 5
    assert got["data"]["own"] == base["data"]["own"]


async def test_non_brand_and_hmg_alias_entities_do_not_drop_rows(client_as):
    """Product 엔티티(롤업 = 모 브랜드 행)·HMG 별칭 엔티티('기아' → Kia 행)는 현행처럼 어느 행도 빼지 않는다(core.entities 머리 주석)."""
    params = {"surface": "global", "include": ["types", "hmg"]}
    base, got = await _pair(client_as, HQ_HYUNDAI, params, SMART_FORTWO, HYUNDAI_CRETA, KIA_ALIAS)
    assert got == base
    base_a, got_a = await _pair(client_as, ADMIN, {"surface": "global", "split_own": "true"}, KIA_ALIAS, HYUNDAI_CRETA)
    assert got_a == base_a                                                    # 관점 당사 행은 언제나 남는다


async def test_registry_only_change_waits_for_rejudge(client_as):
    """Q5 반영 지연: app 명부만 바뀌고 재판정(rd.dim_entity 투영) 전이면 목록은 그대로다(조회는 app 명부를 읽지 않는다)."""
    reg = Rows("app.entity_registry", [{"entity_id": uuid.UUID(TOYOTA), "name": "Toyota", "role": "excluded"}])
    async with staged():
        base = await _get(client_as, HQ_HYUNDAI, {"surface": "global"})
    async with staged(reg):
        got = await _get(client_as, HQ_HYUNDAI, {"surface": "global"})
    assert got == base and "Toyota" in [x["name"] for x in got["data"]["brands"]]
