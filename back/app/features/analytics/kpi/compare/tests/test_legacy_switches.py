"""K-2 현행 프로필 스위치(WU-9, 제품 결정 19·24·25): compare_epoch_gate·compare_suppress.

현행 fetchPeriodCompare(front/lib/scope/server.ts:5921-6034) 순서: 적용일 게이트(cur.hi < 2026-09-08 → null = 종전 Δ) → 집계층 표현 불가
(planTrendRead ok:false → 전 지표 unsupported, emptyCompare) → 읽기. 앞의 둘은 원장·측정을 읽지 않는다.
가짜 core(test_compare_service.fake)로 조립·문장 수를, 로컬 개발 DB 로 라우트(설정 HGH_LEGACY_PROFILE)를 시험한다.
"""
from __future__ import annotations

import dataclasses
from datetime import date

import pytest

from app.core import profile as P
from app.core.config import set_settings
from app.features.analytics.kpi.compare import service as svc
from app.features.analytics.kpi.compare.logic import EPOCH_GATED, PERIOD_COMPARE_EPOCH, legacy_unsupported_reason, period_compare_applies
from app.features.analytics.kpi.compare.schemas import CompareQuery
from app.features.analytics.kpi.compare.tests.test_compare_service import ctx
from app.features.analytics.kpi.summary.shared import kpi_today
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, TODAY, VENDOR, needs_db

D = date.fromisoformat
GATE = P.LegacyProfile(compare_epoch_gate=True)
SUPP = P.LegacyProfile(compare_suppress=True)
BOTH = P.LegacyProfile(compare_epoch_gate=True, compare_suppress=True)
ALL_METRICS = ["visibility", "share_of_voice", "sentiment", "position", "citation_share"]


async def run(profile, lo="2026-08-15", hi="2026-09-13", *, surface="global", own_bits=(1,), **q):
    query = CompareQuery(surface=surface, **{"from": lo, "to": hi}, **q)
    c = dataclasses.replace(ctx(D(lo), D(hi)), surface=surface, own_bits=own_bits)
    return await svc.get_compare(None, c, query, today=D("2026-09-11"), profile=profile)


def dump(res) -> str:
    return res.model_dump_json()


# ── 순수 판정 ────────────────────────────────────────────────────────────────
def test_epoch_constant_and_boundary():
    assert D("2026-09-08") == PERIOD_COMPARE_EPOCH                       # 현행 period-compare.ts:297(운영 DB 덮어쓰기 행 없음)
    assert period_compare_applies(D("2026-09-08")) and period_compare_applies(D("2026-09-30"))
    assert not period_compare_applies(D("2026-09-07"))


@pytest.mark.parametrize("surface,d2,d3,bits,want", [
    ("global", True, False, (1,), "unsupported-agg:depth2"),
    ("global", False, True, (1, 2, 4), "unsupported-agg:depth3"),
    ("global", True, True, (1,), "unsupported-agg:depth2"),               # 현행 판정 순서(depth2 먼저)
    ("global", False, False, (1, 2), "unsupported-agg:own-variant"),      # admin 임의 두 브랜드
    ("website", False, False, (2, 4), "unsupported-agg:own-variant"),
    ("global", False, False, (1,), None),                                 # 한 브랜드 = 그 변형
    ("global", False, False, (1, 1), None),                               # 하위 브랜드(Hyundai N → 1)는 부모로 접힌다
    ("global", False, False, (1, 2, 4), None),                            # 명부 전부 = ALL
    ("project", True, False, (1, 2), None),                               # 현행 기간 비교가 없는 표면
])
def test_legacy_unsupported_reason(surface, d2, d3, bits, want):
    assert legacy_unsupported_reason(surface, depth2=d2, depth3=d3, own_bits=bits) == want


# ── 조립(가짜 core) ──────────────────────────────────────────────────────────
async def test_off_is_unchanged(fake):
    """스위치 꺼짐 = 도입 전 경로(명시 OFF 와 기본 활성 프로필이 같은 응답). 적용일 전 창도 값을 낸다."""
    a, b = await run(P.OFF, "2026-08-01", "2026-09-07"), await run(None, "2026-08-01", "2026-09-07")
    assert dump(a) == dump(b) and a.data and "*" not in a.meta.suppressed
    assert dump(await run(P.OFF, depth2=["x"], own_bits=(1, 2))) == dump(await run(None, depth2=["x"], own_bits=(1, 2)))


async def test_epoch_gate_before_epoch_returns_gated_without_reads(fake):
    res = await run(GATE, "2026-08-01", "2026-09-07")
    assert res.data == [] and res.meta.suppressed == {"*": EPOCH_GATED}
    assert fake["scan"] is None and fake["seen_keys"] is None             # 원장·측정 문장 없음(현행도 읽지 않는다)
    w = res.meta.compare.windows
    assert (w.cur.lo, w.cur.hi) == (D("2026-08-01"), D("2026-09-07")) and res.meta.compare.first_published is None


async def test_epoch_gate_boundary_and_after_equal_off(fake):
    """cur.hi = 적용일(경계 포함)·이후는 꺼짐과 같은 응답."""
    for lo, hi in (("2026-08-10", "2026-09-08"), ("2026-08-15", "2026-09-13")):
        assert dump(await run(GATE, lo, hi)) == dump(await run(P.OFF, lo, hi))


async def test_epoch_gate_calendar_month_uses_cur_hi(fake):
    """달력 월: cur = 1일~to. 09-01~09-07 은 적용일 전(현행 months.cur.hi), 09-01~09-08 은 비교한다."""
    assert (await run(GATE, "2026-09-01", "2026-09-07", kind="calendarMonth")).meta.suppressed == {"*": EPOCH_GATED}
    assert (await run(GATE, "2026-09-01", "2026-09-08", kind="calendarMonth")).data


async def test_suppress_unsupported_combo_all_metrics(fake):
    for kw in ({"depth2": ["d2"]}, {"depth3": ["d3"]}, {"own_bits": (1, 2)}):
        res = await run(SUPP, **kw)
        assert [i.metric for i in res.data] == ALL_METRICS
        for i in res.data:
            assert i.suppressed and i.reason == "unsupported" and i.delta is None
            assert (i.cycles_prev, i.cycles_cur, i.planned_prev, i.planned_cur) == (0, 0, 0, 0)
            assert (i.missing_share_prev, i.missing_share_cur) == (0.0, 0.0)
            assert (i.prev.sum, i.prev.count) == (0, 0) if i.unit == "rank" else (i.prev.num, i.prev.den) == (0, 0)
        assert res.meta.suppressed == dict.fromkeys(ALL_METRICS, "unsupported") and res.meta.compare.first_published is None
        assert fake["scan"] is None and fake["seen_keys"] is None


async def test_suppress_keeps_supported_combos(fake):
    for kw in ({}, {"own_bits": (1, 2, 4)}, {"surface": "project", "depth2": ["d2"]}):
        assert dump(await run(SUPP, **kw)) == dump(await run(P.OFF, **kw)), kw


async def test_suppress_metrics_subset_order(fake):
    res = await run(SUPP, own_bits=(2, 4), metrics=["position", "mentions_per_answer"])
    assert [(i.metric, i.unit, i.reason) for i in res.data] == [("position", "rank", "unsupported"), ("mentions_per_answer", "pct", "unsupported")]


async def test_epoch_gate_wins_over_suppress(fake):
    """현행 순서: 적용일 게이트가 먼저(null), 그 뒤 집계층 억제."""
    assert (await run(BOTH, "2026-08-01", "2026-09-07", own_bits=(1, 2))).meta.suppressed == {"*": EPOCH_GATED}
    assert (await run(BOTH, own_bits=(1, 2))).data[0].reason == "unsupported"


# ── 라우트(로컬 개발 DB) ─────────────────────────────────────────────────────
@pytest.fixture
def legacy(settings):
    from app.main import app

    app.dependency_overrides[kpi_today] = lambda: TODAY

    def on(spec: str) -> None:
        set_settings(settings.model_copy(update={"legacy_profile": spec}))
    yield on
    set_settings(settings)
    app.dependency_overrides.pop(kpi_today, None)


async def get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get("/v1/kpi/compare", params=params)


@needs_db
async def test_route_epoch_gate(client_as, legacy):
    legacy("compare_epoch_gate")
    b = (await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-01", "to": "2026-09-07"})).json()
    assert b["data"] == [] and b["meta"]["suppressed"] == {"*": "before_epoch"}
    assert b["meta"]["compare"]["windows"]["cur"] == {"lo": "2026-09-01", "hi": "2026-09-07"}
    after = (await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-08", "to": "2026-09-14"})).json()
    legacy("off")
    assert after == (await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-08", "to": "2026-09-14"})).json()


@needs_db
async def test_route_suppress(client_as, legacy):
    legacy("compare_epoch_gate,compare_suppress")
    multi = (await get(client_as, ADMIN, surface="global", brand=["Hyundai", "Kia"], kind="cycle")).json()
    assert {i["reason"] for i in multi["data"]} == {"unsupported"} and all(i["delta"] is None for i in multi["data"])
    one = (await get(client_as, ADMIN, surface="global", brand=["Kia"], kind="cycle")).json()
    assert {i["reason"] for i in one["data"]} == {"no_data"}                      # 한 브랜드는 그대로 계산(test_compare_db 와 같은 억제)
    d2 = (await get(client_as, HQ_HYUNDAI, surface="global", depth2=["anything"], kind="cycle")).json()
    assert {i["reason"] for i in d2["data"]} == {"unsupported"}
    proj = await get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), kind="cycle")
    assert proj.status_code == 200 and proj.json()["data"][0]["reason"] != "unsupported"


def test_settings_accept_the_two_switches():
    """두 스위치는 설정 적재에서 켤 수 있다(IMPLEMENTED). 정규 표기 = SWITCHES 순서."""
    from app.core.config import load_settings
    assert load_settings({"HGH_LEGACY_PROFILE": "compare_suppress,compare_epoch_gate"}).legacy_profile == "compare_epoch_gate,compare_suppress"
