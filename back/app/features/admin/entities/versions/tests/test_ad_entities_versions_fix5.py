"""엔티티 관리 5차 수정 회귀 시험: 명부 밖이지만 자사로 귀속되는 엔티티('Hyundai India' 류, 접두 교정)의 유효 귀속 표시와 린트.

  표시  목록(GET /v1/admin/entities) own_brand = 활성 버전 기준 RollupRule.entity_own(역할 배지 'competitor' 와 별개), 순수 경쟁사 = null.
        버전 상세 effective_own_brand = 그 버전 기준 같은 판정: 모 브랜드를 경쟁사로 덮어쓰거나 제거하면 null.
        활성 버전의 모 브랜드 덮어쓰기(Kia)·제거는 목록 배지에도 그대로 나온다(검증 5차 CE25: 차원 표시 브랜드만 보던 배지 원천 회귀).
  린트  명부 밖 자사 귀속 엔티티의 제거·병합·모 브랜드 덮어쓰기·엔티티 한정 표면 차단 = L2 OWN_ATTRIBUTED_EDIT(에스컬레이션, 'Hyundai KPI'),
        순수 경쟁사 편집 = 경고 없음.
"""
from __future__ import annotations

import pathlib

import asyncpg

from app.features.admin.entities.versions.tests.test_ad_entities_versions import (  # noqa: F401  (ecat 픽스처 재사용)
    HYUNDAI,
    KIA,
    TOYOTA,
    TOYOTA2,
    Calls,
    V,
    _x,
    ecat,
)
from tests.support import ADMIN, DB_URL, load_named_sql, needs_db

pytestmark = needs_db
SQL = load_named_sql(pathlib.Path(__file__).with_name("fix5.pgsql"))
INDIA = "ad000000-0000-4000-8000-000000000001"
HMI = "ad000000-0000-4000-8000-000000000002"


async def _sql(name: str) -> None:
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute(SQL[name])
    finally:
        await c.close()


def _own(lint: dict, target: str) -> list[dict]:
    return [f for f in lint["findings"] if f["code"] == "OWN_ATTRIBUTED_EDIT" and f["target"] == target]


async def test_list_shows_effective_own_brand_besides_role(ecat, client_as):  # noqa: F811  (ecat 픽스처)
    await _sql("india_dim")
    try:
        async with client_as(ADMIN) as c:
            r = await c.get("/v1/admin/entities", params={"surface": "global", "limit": 500})
        rows = {x["entity_id"]: x for x in r.json()["data"]["items"]}
        assert rows[INDIA]["role"] == "competitor" and rows[INDIA]["own_brand"] == "Hyundai"     # 명부 밖이지만 자사 KPI 에 집계
        assert rows[str(HYUNDAI)]["own_brand"] == "Hyundai" and rows[str(TOYOTA)]["own_brand"] is None
    finally:
        await _sql("india_cleanup")


async def test_lint_and_draft_attribution_for_own_attributed_entity(ecat, client_as):  # noqa: F811  (ecat 픽스처)
    await _sql("india_dim")
    try:
        async with client_as(ADMIN) as c:
            k = Calls(c)
            ver = (await k.w("POST", V, {"title": "자사 귀속 엔티티"})).json()["data"]["version"]["ver"]

            async def lint() -> dict:
                return (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]

            async def eff(eid: str):
                d = (await c.get(f"{V}/{ver}")).json()["data"]
                return next((e["effective_own_brand"] for e in d["entities"] if e["entity_id"] == eid), "absent")

            target = f"entity:{INDIA}"
            for body, what, want_eff in (({"role": "removed"}, "제거", None),
                                         ({"role": "competitor", "merge_into": str(TOYOTA)}, "병합", "Hyundai"),
                                         ({"role": "competitor", "parent_brand_id": str(TOYOTA)}, "모 브랜드", None)):
                await k.w("PUT", f"{V}/{ver}/entities/{INDIA}", body)
                f = _own(await lint(), target)
                assert len(f) == 1 and f[0]["level"] == "L2" and f[0]["escalate"], (what, f)
                assert f"({what})" in f[0]["detail"] and "Hyundai KPI" in f[0]["detail"], f[0]["detail"]
                assert await eff(INDIA) == want_eff, (what, await eff(INDIA))
            await k.w("PUT", f"{V}/{ver}/entities/{INDIA}", {"role": "hidden", "name": "Hyundai India"})
            assert await eff(INDIA) == "Hyundai"                                            # 숨김은 귀속을 바꾸지 않는다
            # 순수 경쟁사 편집 = 경고 없음
            await k.w("PUT", f"{V}/{ver}/entities/{TOYOTA2}", {"role": "removed"})
            assert _own(await lint(), f"entity:{TOYOTA2}") == []
            # 엔티티 한정 표면 차단(자사 귀속 엔티티) = L2
            s = (await k.w("POST", f"{V}/{ver}/surfaces", {"entity_id": INDIA, "surface": "India", "action": "block"})).json()["data"]["surface"]
            f = _own(await lint(), f"surface:{s['surface_id']}")
            assert len(f) == 1 and "Hyundai KPI" in f[0]["detail"] and f[0]["escalate"]
    finally:
        await _sql("india_cleanup")


async def test_list_badge_follows_active_version_override_and_removal(ecat, client_as):  # noqa: F811  (ecat 픽스처)
    """검증 5차 CE25: 목록 배지 원천이 rd.dim_entity.brand_key(덮어쓰기 없는 원본 쌍만, 제거 무시)이면 Kia 로 덮어쓴 엔티티에 배지가 없고
    제거한 엔티티에 자사 배지가 남는다. 목록 = 드로어(활성 버전 상세 effective_own_brand) 전 행 일치까지 본다."""
    await _sql("india_dim")
    await _sql("hmi_dim")
    try:
        async with client_as(ADMIN) as c:
            k = Calls(c)
            ver = (await k.w("POST", V, {"title": "덮어쓰기·제거 배지"})).json()["data"]["version"]["ver"]
            await k.w("PUT", f"{V}/{ver}/entities/{INDIA}", {"role": "competitor", "parent_brand_id": str(KIA)})
            await k.w("PUT", f"{V}/{ver}/entities/{HMI}", {"role": "removed"})
            await _x("SELECT app.ecat_activate($1)", ver)
            r = await c.get("/v1/admin/entities", params={"surface": "global", "limit": 500})
            rows = {x["entity_id"]: x for x in r.json()["data"]["items"]}
            assert rows[INDIA]["own_brand"] == "Kia", rows[INDIA]                     # 덮어쓰기: 엔진은 Kia 로 집계
            assert rows[HMI]["own_brand"] is None, rows[HMI]                     # 제거: 언급 제외
            assert rows[str(HYUNDAI)]["own_brand"] == "Hyundai" and rows[str(TOYOTA)]["own_brand"] is None
            d = (await c.get(f"{V}/{ver}")).json()["data"]
            drawer = {e["entity_id"]: e["effective_own_brand"] for e in d["entities"]}
            bad = {eid: (rows[eid]["own_brand"], v) for eid, v in drawer.items() if eid in rows and rows[eid]["own_brand"] != v}
            assert not bad, bad                                                      # 목록 = 드로어
    finally:
        await _sql("india_cleanup")

