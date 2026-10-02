"""core.entities(명부 제외 키, 동기화 S1 BE-5) 시험. 합성 픽스처 rd.dim_entity(tests/README §4):
Toyota(Brand)·TOYOTA(Brand, 같은 Toyota 행)·Apple(Brand, 비경쟁 kind 3)·smart(Brand)·'Smart Fortwo'(Product → smart 행)·
'Hyundai Creta'(Product → Hyundai 행)·safety(Feature, 행 없음)·'기아'(Brand 별칭 → Kia 행, HMG).
"""
from __future__ import annotations

import uuid

import pytest

from app.core.db import fetch_all
from app.core.entities import drop_excluded, excluded_brand_keys, keep
from tests.support import TEST_NAME_KEY, Rows, Update, needs_db, staged

TOYOTA = "71000000-0000-4000-8000-000000000001"
TOYOTA_UPPER = "71000000-0000-4000-8000-000000000002"
APPLE = "71000000-0000-4000-8000-000000000003"
HYUNDAI_CRETA = "71000000-0000-4000-8000-000000000004"
SMART = "71000000-0000-4000-8000-000000000006"
SMART_FORTWO = "71000000-0000-4000-8000-000000000007"
SAFETY = "71000000-0000-4000-8000-000000000008"
KIA_ALIAS = "ed4b8012-4a73-4174-9b43-4cb696934b25"


def role(entity_id: str, value: str | None = "excluded") -> Update:
    return Update("rd.dim_entity", {"entity_id": uuid.UUID(entity_id)}, {"registry_role": value})


async def _keys_by_name(conn) -> dict[str, int]:
    return {r["name"]: int(r["brand_key"]) for r in await fetch_all(conn, "SELECT n.brand_key, n.name FROM rd.dim_brand_name n")}


def test_keep_and_drop_units():
    ex = frozenset({61})
    assert keep(61, is_own=False, excluded=ex) is False
    assert keep(61, is_own=True, excluded=ex) is True                          # 자사(관점) 행은 언제나 남긴다
    assert keep(5, is_own=False, excluded=ex) is True
    assert keep(None, is_own=False, excluded=ex) is True
    assert keep(61, is_own=False, excluded=frozenset()) is True
    rows = [{"brand_key": 61, "o": False}, {"brand_key": 61, "o": True}, {"brand_key": 5, "o": False}]
    assert drop_excluded(rows, ex, own="o") == rows[1:]
    assert drop_excluded(rows, ex) == rows[2:]
    assert drop_excluded(rows, frozenset()) == rows


@needs_db
async def test_no_excluded_entities_empty():
    async with staged() as conn:
        assert await excluded_brand_keys(conn) == frozenset()


@needs_db
@pytest.mark.parametrize(("entities", "names"), [
    ((TOYOTA,), {"Toyota"}),
    ((TOYOTA, TOYOTA_UPPER), {"Toyota", "TOYOTA"} if TEST_NAME_KEY else {"Toyota"}),   # 끔: 같은 행으로 접히는 두 엔티티 = 키 하나.
                                                                               # NAME: 대소문자 표기별 행(운영 생성기)이라 키 둘
    ((TOYOTA, SMART, APPLE), {"Toyota", "smart", "Apple"}),
    ((SMART_FORTWO,), set()),                                                  # Product: 롤업 = 모 브랜드 행이라 키가 아니다
    ((HYUNDAI_CRETA,), set()),
    ((SAFETY,), set()),                                                        # brand_key 없음
    ((KIA_ALIAS,), set()),                                                     # HMG 별칭: 현행 대표 표기('기아')는 'Kia' 행과 다르다
])
async def test_excluded_brand_keys(entities, names):
    async with staged(*(role(e) for e in entities)) as conn:
        by_name = await _keys_by_name(conn)
        assert await excluded_brand_keys(conn) == frozenset(by_name[n] for n in names)


@needs_db
async def test_own_role_and_registry_only_are_not_excluded():
    """registry_role 'own' 은 제외가 아니고, app 명부만 바뀐 상태(재판정 전)는 rd 에 없으므로 키가 없다(Q5 반영 지연)."""
    reg = Rows("app.entity_registry", [{"entity_id": uuid.UUID(SMART), "name": "smart", "role": "excluded"}])
    async with staged(role(TOYOTA, "own"), reg) as conn:
        assert await excluded_brand_keys(conn) == frozenset()
