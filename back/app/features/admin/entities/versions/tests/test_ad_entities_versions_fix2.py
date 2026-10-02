"""엔티티 관리 2차 수정 회귀 시험(재검증 N2·N4, 기준 0c7444e0).

  N2  포기(abandon)의 회차 고정 고지: 반영 상세(GET)·포기 응답의 abandon_pins
      - failed(포기 전) = 예정(planned): pins_before 규칙(적재기 _abandon 과 같다)으로 고정 버전 계산, 반영 전에도 새 버전인 회차는 고정 없음
      - 포기 중(abandoning)·포기로 닫힘(abandoned) = rd.cycle.ecat_ver 실측
      - 고정 회차 목록·노출 전 회차 수·이후 승인 필요, 그 밖 상태 = None
  N4  새 전역 차단 표면이 자사(추적) 엔티티의 Scope 관측 표면 변형(ing.mention.surfaces, 뷰 rd.v_entity_mention_surface)과 정규형이
      같으면 L2 에스컬레이션. 관측 안 된 표면·추적 밖 엔티티 표면은 경고 없음. 조회 원천은 observed_source 에 남는다
"""
from __future__ import annotations

import json
import pathlib

import asyncpg

from app.features.admin.entities.versions.tests.test_ad_entities_versions import (  # noqa: F401  (ecat 픽스처 재사용)
    HYUNDAI,
    PRODUCT_OWNER,
    A,
    Calls,
    V,
    _draft_with_apply,
    _force_status,
    _set_approvers,
    _simulate_preview,
    _v,
    _x,
    ecat,
)
from tests.support import ADMIN, DB_URL, load_named_sql, needs_db

pytestmark = needs_db
SQL = load_named_sql(pathlib.Path(__file__).with_name("fix2.pgsql"))
KIA = "00000000-0000-0000-0000-000000000302"


async def _sql(name: str, *args) -> None:
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute(SQL[name], *args)
    finally:
        await c.close()


async def _failed_apply(c, k: Calls) -> tuple[int, int]:
    """v2(Apple 제거) unexposed 반영을 failed 로 만들고 범위 회차·pins_before 를 적재기처럼 남긴다.
    범위 = 11(노출)·12(노출 전)·10(반영 전에도 새 버전 = 범위 확장 흉내, 고정 없음)."""
    ver, aid = await _draft_with_apply(c, k, scope="unexposed")
    await _simulate_preview(aid, requires_approval=False)
    assert (await c.get(f"{A}/{aid}")).json()["data"]["abandon_pins"] is None          # 포기와 무관한 상태(previewed) = None
    await _force_status(aid, ["approved", "running", "failed"])
    pins = {"11": {"pin": None, "ver": 1}, "12": {"pin": None, "ver": 1}, "10": {"pin": None, "ver": ver}}
    await _x("UPDATE app.ecat_apply SET cycle_keys = '{10,11,12}', preview = preview || jsonb_build_object('pins_before', $2::jsonb) "
             "WHERE apply_id = $1", aid, json.dumps(pins))
    return ver, aid


async def test_n2_abandon_pins_planned_abandoning_abandoned(ecat, client_as):  # noqa: F811 (픽스처 주입)
    await _set_approvers(PRODUCT_OWNER)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver, aid = await _failed_apply(c, k)
        det = (await c.get(f"{A}/{aid}")).json()["data"]
        p = det["abandon_pins"]
        assert "abandon" in det["actions"] and p["state"] == "planned" and p["new_ver"] == ver and p["active_ver"] == 1
        assert [(x["cyc_key"], x["pin_ver"], x["exposed"], x["surface"]) for x in p["cycles"]] == [(11, 1, True, "global"), (12, 1, False, "global")]
        assert p["unexposed"] == 1 and p["requires_approval_later"] is True
        ab = (await k.w("POST", f"{A}/{aid}/abandon", {"reason": "멈춤"})).json()["data"]
        assert ab["abandon_pins"]["state"] == "planned" and [x["cyc_key"] for x in ab["abandon_pins"]["cycles"]] == [11, 12]
        # 적재기 포기 첫 처리 흉내: 고정 + 포기 시작 기록 + ABANDONING
        await _sql("cycle_pin", [11, 12], 1)
        try:
            await _x("UPDATE app.ecat_apply SET preview = preview || '{\"abandon\": {\"started_at\": \"x\"}}'::jsonb, "
                     "error = 'ECAT_APPLY_ABANDONING: 포기 진행 중' WHERE apply_id = $1", aid)
            mid = (await c.get(f"{A}/{aid}")).json()["data"]["abandon_pins"]
            assert mid["state"] == "abandoning" and [(x["cyc_key"], x["pin_ver"]) for x in mid["cycles"]] == [(11, 1), (12, 1)]
            await _x("UPDATE app.ecat_apply SET status = 'rejected', error = 'ECAT_APPLY_ABANDONED: 포기로 닫힘' WHERE apply_id = $1", aid)
            done = (await c.get(f"{A}/{aid}")).json()["data"]
            assert done["error_code"] == "ECAT_APPLY_ABANDONED" and done["abandon_pins"]["state"] == "abandoned"
            assert done["abandon_pins"]["unexposed"] == 1 and done["abandon_pins"]["requires_approval_later"] is True
        finally:
            await _sql("cycle_unpin", [10, 11, 12])


async def _set_lint(cfg: dict) -> None:
    await _x("INSERT INTO app.rule_param (key, value) VALUES ('ecat_lint', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
             json.dumps(cfg))


async def test_n4_global_block_matches_scope_observed_own_surface(ecat, client_as):  # noqa: F811 (픽스처 주입)
    """'Hyundai Motor Co' 는 이름·rep_name·허브 표면·대기함 어디에도 없고 Scope 관측 표면(ing.mention.surfaces)에만 있다.
    전각·공백만 다른 전역 차단도 정규형이 같으면 잡는다. 관측 안 된 표면·추적 밖이면 경고 없음."""
    await _sql("own_surface_mention", HYUNDAI)
    try:
        await _set_lint({"tracked_entity_ids": [str(HYUNDAI)], "own_surface_lookback_months": 240})
        async with client_as(ADMIN) as c:
            k = Calls(c)
            ver = (await k.w("POST", V, {"title": "전역 차단 관측"})).json()["data"]["version"]["ver"]
            hit = (await k.w("POST", f"{V}/{ver}/surfaces", {"surface": "ＨＹＵＮＤＡＩ  motor co", "action": "block"})).json()["data"]["surface"]
            miss = (await k.w("POST", f"{V}/{ver}/surfaces", {"surface": "Zebra Motor", "action": "block"})).json()["data"]["surface"]
            lint = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
            by = {f["target"]: f for f in lint["findings"]}
            f = by.get(f"surface:{hit['surface_id']}")
            assert f and (f["level"], f["code"], f["escalate"]) == ("L2", "TRACKED_ENTITY_EDIT", True), lint["findings"]
            assert f"surface:{miss['surface_id']}" not in by
            assert "rd.v_entity_mention_surface" in lint["observed_source"] and "최근 240개월" in lint["observed_source"]
            # 자사 브랜드 정본(app.brand is_hmg_own)은 린트 설정의 추적 목록과 무관하게 추적한다(5차: KPI own_bit 와 같은 원천).
            # 설정이 Kia 만 추적해도 Hyundai 관측 표면 전역 차단은 경고한다
            await _set_lint({"tracked_entity_ids": [KIA], "own_surface_lookback_months": 240})
            lint2 = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
            assert f"surface:{hit['surface_id']}" in {x["target"] for x in lint2["findings"]}, lint2["findings"]
    finally:
        await _sql("own_surface_cleanup")
    assert await _v("SELECT count(*) FROM app.rule_param WHERE key = 'ecat_lint'") in (0, 1)
