"""엔티티 관리 3차 수정 회귀 시험(재검증 N4 잔여, 기준 d44acc68): 전역 차단을 자사로 롤업되는 엔티티의 관측 표면·이름과도 대조.

  롤업 규칙 = lint.RollupRule(투영 오버레이 seed _ecat_x·_meff 와 같다): 덮어쓰기(자기 → 병합 대상 parent_brand_id) 우선, 없으면 Scope
  brand_rollup_entity_id, 2단, 제거·별칭 접기. 관측 원천 = rd.v_entity_mention_surface(entity_id 또는 brand_rollup_entity_id 등치).
  1) 'Creta'(Scope 롤업 = Hyundai) 전역 차단 → L2 에스컬레이션, 'Fortwo'(롤업 smart) → 경고 없음
  2) 덮어쓰기 반영 뒤 대상 변화: Fortwo → 모 브랜드 Hyundai 면 경고, Creta → 모 브랜드 Toyota 면 경고 사라짐
  3) 병합: Creta 모 브랜드 Hyundai + Fortwo → Creta 병합이면 Fortwo 도 자사 롤업(2단), 초안 이름 'Smart Fortwo' 도 경고
  4) 이름 경로: 'Tata'(대표 표기, 언급에 표면 없음, Scope 롤업 Hyundai) 전역 차단 → 경고
"""
from __future__ import annotations

import json
import pathlib

import asyncpg

from app.features.admin.entities.versions.tests.test_ad_entities_versions import (  # noqa: F401  (ecat 픽스처 재사용)
    CRETA,
    HYUNDAI,
    TATA,
    TOYOTA,
    Calls,
    V,
    _x,
    ecat,
)
from tests.support import ADMIN, DB_URL, load_named_sql, needs_db

pytestmark = needs_db
SQL = load_named_sql(pathlib.Path(__file__).with_name("fix3.pgsql"))
FORTWO = "71000000-0000-4000-8000-000000000007"


async def _sql(name: str) -> None:
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute(SQL[name])
    finally:
        await c.close()


def _hit(lint: dict, sid: int) -> dict | None:
    return next((f for f in lint["findings"] if f["target"] == f"surface:{sid}"), None)


async def test_n4_global_block_of_entities_rolling_up_to_own(ecat, client_as):  # noqa: F811 (픽스처 주입, fix2 와 같은 관례)
    await _sql("rollup_mentions")
    try:
        await _x("INSERT INTO app.rule_param (key, value) VALUES ('ecat_lint', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                 json.dumps({"tracked_entity_ids": [str(HYUNDAI)], "own_surface_lookback_months": 240}))
        async with client_as(ADMIN) as c:
            k = Calls(c)
            ver = (await k.w("POST", V, {"title": "제품 전역 차단"})).json()["data"]["version"]["ver"]
            sid = {}
            for s in ("Creta", "Fortwo", "Smart Fortwo", "Tata"):
                sid[s] = (await k.w("POST", f"{V}/{ver}/surfaces", {"surface": s, "action": "block"})).json()["data"]["surface"]["surface_id"]

            async def lint() -> dict:
                return (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]

            l1 = await lint()
            f = _hit(l1, sid["Creta"])
            assert f and (f["level"], f["code"], f["escalate"]) == ("L2", "TRACKED_ENTITY_EDIT", True) and "롤업" in f["detail"], l1["findings"]
            assert _hit(l1, sid["Fortwo"]) is None and _hit(l1, sid["Smart Fortwo"]) is None
            assert _hit(l1, sid["Tata"]) is not None                                        # 이름 경로(표면 없는 언급의 Scope 롤업)
            assert "자사·자사 롤업 엔티티" in l1["observed_source"]

            await k.w("PUT", f"{V}/{ver}/entities/{FORTWO}", {"role": "competitor", "parent_brand_id": str(HYUNDAI)})
            await k.w("PUT", f"{V}/{ver}/entities/{CRETA}", {"role": "competitor", "parent_brand_id": str(TOYOTA)})
            l2 = await lint()
            assert _hit(l2, sid["Fortwo"]) is not None and _hit(l2, sid["Smart Fortwo"]) is not None   # 덮어쓰기로 자사 롤업(관측 + 초안 이름)
            assert _hit(l2, sid["Creta"]) is None                                           # 덮어쓰기로 자사에서 빠짐

            await k.w("PUT", f"{V}/{ver}/entities/{CRETA}", {"role": "competitor", "parent_brand_id": str(HYUNDAI)})
            await k.w("PUT", f"{V}/{ver}/entities/{FORTWO}", {"role": "competitor", "merge_into": str(CRETA)})
            l3 = await lint()
            assert _hit(l3, sid["Creta"]) is not None and _hit(l3, sid["Fortwo"]) is not None   # 병합 원본은 대상의 관계를 따른다(2단)

            await k.w("PUT", f"{V}/{ver}/entities/{TATA}", {"role": "removed"})
            l4 = await lint()
            assert _hit(l4, sid["Tata"]) is None                                            # 제거된 엔티티의 언급은 자사 KPI 와 무관
    finally:
        await _sql("rollup_cleanup")
