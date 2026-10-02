"""T-1 현행 프로필 trend_grid(WU-6, XAXIS_G·XAXIS_W, 제품 결정 19·25) 라우트 시험. 로컬 개발 DB 복제본 + 롤백 전용 준비(staged).

현행 규칙(hmg-geo 2670a16 + read_screens X.trendGrid, 근거 file:line 은 core.cycles '현행 추이 격자' 절):
  자리 = 원장 round_date 최신 13개(오늘 − 180일 이후, 기간이 있으면 그 안), 끝쪽 미발행 절단, 중간 미발행 = 갭, 수집 오류 숨김뿐 = 갭,
  운영 숨김뿐·귀속 없는 서빙 불가 = 자리 아님. 값 = 자리 대표 회차 하나(글로벌 자리 / 웹사이트 (사이트, 자리)), 합산이 아니다.
  글로벌 완결성 0.9 미만 = 갭, 수집 오류 인용 숨김이 있는 자리 = 인용 계열 갭(⑥ 제외).
스위치 꺼짐이면 같은 준비에서 새 정의(최근 12자리·자리 합산)가 그대로 나온다(대조 단언).
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.core import profile as P
from app.core.config import set_settings
from app.core.cycles import resolve_recent_window
from app.features.analytics.trend.series.tests.staged import NewCycle, Stage, staged
from tests.support import HQ_HYUNDAI, KIA_EU, needs_db

pytestmark = needs_db

MON = [date(2026, 5, 25) + timedelta(days=7 * i) for i in range(15)]      # 05-25 ~ 08-31 월요일(픽스처 09-07·09-14 앞)
D07, D14, D18 = date(2026, 9, 7), date(2026, 9, 14), date(2026, 9, 18)


@pytest.fixture
def grid(settings):
    def on(spec: str) -> None:
        set_settings(settings.model_copy(update={"legacy_profile": spec}))
    yield on
    set_settings(settings)


async def _get(client_as, uid, params):
    async with client_as(uid) as c:
        r = await c.get("/v1/trend", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def series(body: dict, metric: str) -> dict:
    return next(s for s in body["data"]["series"] if s["metric"] == metric and s["key"] is None)


def point(body: dict, metric: str, d: date) -> dict:
    return next(p for p in series(body, metric)["points"] if p["bucket"] == d.isoformat())


def pair(p: dict) -> tuple[int, int] | None:
    return (p["ratio"]["num"], p["ratio"]["den"]) if p["ratio"] else None


def keys(body: dict) -> list[str]:
    return [b["key"] for b in body["data"]["buckets"]]


S08, S10 = date(2026, 9, 8), date(2026, 9, 10)                            # 사실 복사는 픽스처 파티션(2026-09) 안에서만


def _global_stage() -> Stage:
    """글로벌 루트(프로젝트 1) 원장: 사실 없는 월요일 15개 + 9월 자리(사실 = 회차 11 복사) + 픽스처 09-07·09-14. 번호 = cyc_key."""
    c = [NewCycle(900 + i, d) for i, d in enumerate(MON)]
    c[5] = NewCycle(905, MON[5], status=1, servable=False, view_days=None, completed_answers=4)     # 06-29 닫힘·미발행(귀속) → 갭 hidden
    c[6] = NewCycle(906, MON[6], status=1, servable=False, view_days=None)                        # 07-06 귀속 없음 → 자리 아님
    c[7] = NewCycle(907, MON[7], hidden_scope=1, hidden_reason=1, completed_answers=5)            # 07-13 수집 오류 숨김뿐 → 갭
    c[8] = NewCycle(908, MON[8], hidden_scope=1, hidden_reason=2)                                  # 07-20 운영 숨김뿐 → 자리 아님
    extra = [
        NewCycle(940, S08, copy_from=11),                                                          # 09-08 정상(이른 앵커)
        NewCycle(930, S08, anchor_date=S08 + timedelta(days=1), hidden_scope=2, hidden_reason=1, copy_from=11),  # 09-08 인용 숨김(늦은 앵커)
        NewCycle(941, S10, expected_units=10, completed_units=5, copy_from=11),                    # 09-10 완결성 0.5 → 갭(글로벌)
        NewCycle(931, D14, anchor_date=D14 + timedelta(days=1), copy_from=11),                     # 09-14 두 번째 회차(늦은 앵커)
        NewCycle(932, date(2026, 9, 28), status=1, servable=False, view_days=None, completed_answers=3),   # 09-28 끝쪽 미발행 → 절단
    ]
    return Stage(cycles=c + extra)


async def test_global_grid_slots_representative_and_gaps(client_as, grid):
    async with staged(_global_stage()):
        grid("trend_grid")
        on = await _get(client_as, HQ_HYUNDAI, {"surface": "global"})
        rng = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "from": "2026-09-01", "to": "2026-09-20"})
        wk = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "bucket": "week"})
        grid("off")
        off = await _get(client_as, HQ_HYUNDAI, {"surface": "global"})
    # 자리 17개(07-06·07-20 자리 아님, 09-21 open·귀속 없음, 09-28 끝쪽 미발행 절단) 중 최신 13개 = 06-22 부터
    want = [d for d in MON if d not in (MON[6], MON[8])] + [D07, S08, S10, D14]
    assert keys(on) == [d.isoformat() for d in want[-13:]] and keys(on)[0] == MON[4].isoformat()
    for m in ("visibility", "citation_share"):
        assert point(on, m, MON[5])["gap_reason"] == "hidden"                     # 미발행 자리(어댑터 not_published)
        assert point(on, m, MON[7])["gap_reason"] == "collection_error"
        assert point(on, m, S10)["gap_reason"] == "collection_error"              # 완결성 0.5
    # 대표 하나: 09-14 는 두 회차(같은 사실)인데 값은 한 회차(2/3), 꺼짐은 합산(4/6)
    assert pair(point(on, "visibility", D14)) == (2, 3)
    assert pair(point(off, "visibility", D14)) == (4, 6)
    # 09-08: 언급 대표 = 늦은 앵커(인용 숨김 회차) 값, 인용 계열 = 수집 오류 인용 숨김 표식 갭(꺼짐은 인용 값이 있다)
    assert pair(point(on, "visibility", S08)) == (2, 3)
    p = point(on, "citation_share", S08)
    assert p["gap"] and p["gap_reason"] == "collection_error" and p["ratio"] is None
    assert not point(off, "citation_share", S08)["gap"]
    # 기간: 그 안의 자리(끝 절단·13 상한 동일 규칙)
    assert keys(rng) == [d.isoformat() for d in (D07, S08, S10, D14)]
    # 주 버킷·꺼짐 = 새 정의(최근 12 버킷, 합산)
    assert len(keys(off)) == 12 and len(keys(wk)) <= 12
    assert on["meta"]["cycles"][-1] == D14.isoformat() and MON[5].isoformat() not in on["meta"]["cycles"]


async def test_website_grid_per_site_representative_no_completion(client_as, grid):
    st = Stage(unhide=[21], cycles=[
        NewCycle(960, D18, surface=2, project_key=2, anchor_date=D18 + timedelta(days=1), expected_units=10, completed_units=1,
                 copy_from=21),                                                   # 같은 사이트·같은 자리 두 번째 회차(미완결)
    ])
    async with staged(st):
        grid("trend_grid")
        on = await _get(client_as, KIA_EU, {"surface": "website", "metrics": ["visibility", "citation_share", "citation_accuracy"]})
        grid("off")
        off = await _get(client_as, KIA_EU, {"surface": "website", "metrics": ["visibility"]})
    assert keys(on) == [D18.isoformat()]
    v_on, v_off = pair(point(on, "visibility", D18)), pair(point(off, "visibility", D18))
    assert v_on is not None and v_off == (v_on[0] * 2, v_on[1] * 2)                # (사이트, 자리) 대표 하나 대 합산
    assert not point(on, "visibility", D18)["gap"]                                  # 웹사이트는 완결성 갭이 없다(대표는 완결 회차 21)


async def test_website_operator_hidden_only_slot_is_not_a_slot(client_as, grid):
    """픽스처 회차 21(운영 인용 숨김) 하나뿐인 자리: 현행 대시보드 추이 계열 'all' 에서 서빙 불가 ∧ 운영 숨김뿐 → 자리 아님."""
    grid("trend_grid")
    b = await _get(client_as, KIA_EU, {"surface": "website"})
    assert keys(b) == [] and b["meta"]["suppressed"] == {"*": "no_active_snapshot"}


async def test_website_citation_marker_spares_accuracy(client_as, grid):
    st = Stage(unhide=[21], cycles=[
        NewCycle(961, D18, surface=2, project_key=2, anchor_date=D18 - timedelta(days=1), hidden_scope=2, hidden_reason=1, copy_from=21),
    ])
    async with staged(st):
        grid("trend_grid")
        b = await _get(client_as, KIA_EU, {"surface": "website", "metrics": ["visibility", "citation_share", "citation_accuracy"]})
    assert point(b, "citation_share", D18)["gap_reason"] == "collection_error"
    assert point(b, "citation_accuracy", D18)["gap_reason"] != "collection_error"   # 현행 ⑥ 은 ② 표식을 보지 않는다
    assert not point(b, "visibility", D18)["gap"]


async def test_recent_window_delegates_to_grid(ro):
    """core.cycles.resolve_recent_window(profile.trend_grid, bucket=cycle) = 격자 창(구현 표식이 막지 않는다), week 는 새 정의."""
    on = P.LegacyProfile(trend_grid=True)
    w = await resolve_recent_window(ro, surface="global", project_keys=(1,), n=12, bucket="cycle", profile=on)
    ww = await resolve_recent_window(ro, surface="global", project_keys=(1,), n=12, bucket="week", profile=on)
    assert (w.lo, w.hi) == (D07, D14) and w.cyc_keys("mentions") == (10, 11)
    assert ww.lo == date(2026, 9, 7)
