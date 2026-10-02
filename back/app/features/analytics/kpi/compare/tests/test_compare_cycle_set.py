"""K-2 현행 프로필 compare_cycle_set(WU-12, 제품 결정 19·25): 글로벌 기간 비교 창 회차 = 노출된 발행 회차 전부(함대 가시성 무관).

현행 readComparePeriods(front lib/db/repositories/summary-period-compare.ts:536-699): 원장 대상(ledgerScopeConds :218-236)은 fleet_visible 을
웹사이트에만 걸고, 값의 회차 집합(buildCompareCycleSet :300-324)은 자리 대표로 좁히지 않은 발행 회차 전부다. 그래서 글로벌 자리 병합으로
비서빙(rd.cycle.servable 거짓 = published ∧ fleet_visible 아님)이 된 회차도 직전·현재 창 값과 원장 발행에 든다.
운영 실측(2026-10-01, 미러 읽기 전용): 08-10 자리 회차 343·356·396, 08-17 자리 365·414 를 전부 더해야 C04·C07 구 Δ 8키가 정확히 재현된다.

픽스처: 글로벌 회차 10(09-07)·11(09-14). staged 로 회차 11 을 복사한 비서빙 발행 회차 903(같은 자리 09-14)을 더한다.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core import cycles as C
from app.core import profile as P
from app.core.config import set_settings
from app.features.analytics.kpi.summary.shared import kpi_today
from app.features.analytics.trend.series.tests.staged import NewCycle, Stage, staged
from tests.support import HQ_HYUNDAI, TODAY, needs_db

M = ["visibility", "share_of_voice", "sentiment", "position"]
WIN = {"from": "2026-09-08", "to": "2026-09-14"}          # 7일 창: cur = 회차 11(·903), prev = 09-01~09-07(회차 10). cur.hi ≥ 적용일


def test_off_sql_unchanged_and_fleet_any_differs_only_in_publish_predicate():
    assert "c.servable\n" in C._CAND and C._range_sql(C._CAND) == C._RANGE_SQL
    assert C._RANGE_SQL.replace("c.servable\n", "(c.servable OR c.status = 2)\n") == C._RANGE_SQL_FLEET_ANY
    assert C._LEDGER_SQL.replace("(c.servable AND c.view_date", "((c.servable OR c.status = 2) AND c.view_date") == C._LEDGER_SQL_FLEET_ANY
    assert C._FIRST_SQL.replace("c.servable\n", "(c.servable OR c.status = 2)\n") == C._FIRST_SQL_FLEET_ANY
    assert "compare_cycle_set" in P.IMPLEMENTED


@pytest.fixture
def legacy(settings):
    from app.main import app

    app.dependency_overrides[kpi_today] = lambda: TODAY

    def on(spec: str) -> None:
        set_settings(settings.model_copy(update={"legacy_profile": spec}))
    yield on
    set_settings(settings)
    app.dependency_overrides.pop(kpi_today, None)


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        r = await c.get("/v1/kpi/compare", params=params)
    assert r.status_code == 200, r.text
    return {i["metric"]: i for i in r.json()["data"]}, r.json()["meta"]


@needs_db
async def test_switch_includes_non_servable_published_global_cycle(client_as, legacy):
    async with staged(Stage(cycles=[NewCycle(903, date(2026, 9, 14), copy_from=11, servable=False, expected_units=5)])):
        legacy("off")
        off, _ = await _get(client_as, HQ_HYUNDAI, surface="global", kind="window", metrics=M, card="true", **WIN)
        legacy("compare_cycle_set")
        on, _ = await _get(client_as, HQ_HYUNDAI, surface="global", kind="window", metrics=M, card="true", **WIN)
    # 새 정의(꺼짐): 회차 903 은 비서빙이라 값에 없고 원장에서는 미발행(누락) 단위
    assert off["visibility"]["cur"] == {"num": 2, "den": 3}
    # 현행(켜짐): 같은 자리 두 회차를 더한다(행 복사라 정확히 두 배), 원장 발행 회차 수는 자리 수(09-14 하나), 누락 0
    for m in ("visibility", "share_of_voice", "sentiment"):
        assert on[m]["cur"] == {"num": 2 * off[m]["cur"]["num"], "den": 2 * off[m]["cur"]["den"]}, m
    assert on["position"]["cur"] == {"sum": 2 * off["position"]["cur"]["sum"], "count": 2 * off["position"]["cur"]["count"]}
    assert on["visibility"]["prev"] == off["visibility"]["prev"]                     # 직전 창(회차 10)은 그대로
    assert (on["visibility"]["cycles_cur"], on["visibility"]["missing_share_cur"]) == (1, 0.0)
    assert off["visibility"]["missing_share_cur"] > 0                                 # 꺼짐: 비서빙 회차의 계획 단위가 누락으로 잡힌다
    assert on["visibility"]["planned_cur"] == off["visibility"]["planned_cur"]


@needs_db
async def test_switch_ignores_website_and_unpublished(client_as, legacy):
    """웹사이트는 현행도 fleet_visible 을 걸어 servable 그대로, 글로벌 미발행(status closed) 비서빙 회차는 켜도 빠진다."""
    async with staged(Stage(cycles=[NewCycle(904, date(2026, 9, 14), copy_from=11, servable=False, status=1)])):
        legacy("off")
        off, _ = await _get(client_as, HQ_HYUNDAI, surface="global", kind="window", metrics=M, card="true", **WIN)
        legacy("compare_cycle_set")
        on, _ = await _get(client_as, HQ_HYUNDAI, surface="global", kind="window", metrics=M, card="true", **WIN)
    assert on["visibility"]["cur"] == off["visibility"]["cur"] == {"num": 2, "den": 3}
