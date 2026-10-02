"""엔티티 관리 4차 수정 회귀 시험(재검증 N7, 반례 CE21): 표시명 접두 교정(J1)으로 자사에 귀속되는 제품 표면의 전역 차단 경고.

픽스처 Creta 언급 = 표시명 'Hyundai Creta', Scope 롤업 Tata. 엔진은 접두 교정(app.ecat_hmg_prefix_id = seed pg_temp.hmg_prefix_id)으로 Hyundai 에
귀속시키므로 전역 차단 'Creta' 는 자사 언급을 줄인다(엔진 동치 표 시험 = ingest/project/apply/tests/test_ecat_lint_parity.py). 린트도 L2 경고.
대조: Fortwo(표시명 'Smart Fortwo', 롤업 smart)는 경고 없음. Creta 모 브랜드를 경쟁사로 덮어쓰면 접두 교정을 건너뛰어 경고가 사라진다.
"""
from __future__ import annotations

import json
import pathlib

import asyncpg

from app.features.admin.entities.versions.tests.test_ad_entities_versions import (  # noqa: F401  (ecat 픽스처 재사용)
    CRETA,
    HYUNDAI,
    TOYOTA,
    Calls,
    V,
    _x,
    ecat,
)
from tests.support import ADMIN, DB_URL, load_named_sql, needs_db

pytestmark = needs_db
SQL = load_named_sql(pathlib.Path(__file__).with_name("fix4.pgsql"))


async def _sql(name: str) -> None:
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute(SQL[name])
    finally:
        await c.close()


def _hit(lint: dict, sid: int) -> dict | None:
    return next((f for f in lint["findings"] if f["target"] == f"surface:{sid}"), None)


async def test_n7_global_block_of_prefix_corrected_product(ecat, client_as):  # noqa: F811 (픽스처 주입, fix2 와 같은 관례)
    await _sql("prefix_surfaces")
    try:
        await _x("INSERT INTO app.rule_param (key, value) VALUES ('ecat_lint', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                 json.dumps({"tracked_entity_ids": [str(HYUNDAI)], "own_surface_lookback_months": 240}))
        async with client_as(ADMIN) as c:
            k = Calls(c)
            ver = (await k.w("POST", V, {"title": "접두 교정 제품"})).json()["data"]["version"]["ver"]
            creta = (await k.w("POST", f"{V}/{ver}/surfaces", {"surface": "Creta", "action": "block"})).json()["data"]["surface"]["surface_id"]
            fortwo = (await k.w("POST", f"{V}/{ver}/surfaces", {"surface": "Fortwo", "action": "block"})).json()["data"]["surface"]["surface_id"]
            l1 = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
            f = _hit(l1, creta)
            assert f and (f["level"], f["code"], f["escalate"]) == ("L2", "TRACKED_ENTITY_EDIT", True) and "롤업" in f["detail"], l1["findings"]
            assert _hit(l1, fortwo) is None
            await k.w("PUT", f"{V}/{ver}/entities/{CRETA}", {"role": "competitor", "parent_brand_id": str(TOYOTA)})
            l2 = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
            assert _hit(l2, creta) is None, l2["findings"]                  # 덮어쓰기가 있으면 접두 교정을 건너뛴다(엔진과 같다)
    finally:
        await _sql("prefix_cleanup")
