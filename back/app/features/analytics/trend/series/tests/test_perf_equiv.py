"""성능 라운드(A1~A3, 2026-09-30) 동치: 새 구현 응답 = 이전 구현(legacy_perf) 응답, 바이트 단위.

같은 준비 트랜잭션에서 한 요청을 두 번 부른다. 두 번째는 service·queries 의 바뀐 이름을 legacy_perf 의 이전 식으로 바꿔 끼운다
(A1 queries.measured_days_sql, A2 service._series_mix, A3 service._own_parts). 응답 봉투 전체(data·meta)가 같아야 한다.

준비(perf_seed.pgsql + 회차 복사): 글로벌 회차 9101(08-17, 인용 숨김)·9102(08-24)·9103(08-31)·9104(09-02) = 회차 11 복사,
9105(08-10, 수집 오류 전체 숨김 = 갭 자리)·9106(08-03, 운영자 전체 숨김 = 자리 아님). job 측정 시각을 여러 KST 날짜·NULL·비서빙으로 흩고,
순위 경계 동률(합계 8 세 개, 4 열세 개: 밑줄·숫자·대소문자·악센트), 출처 차원에 없는 출처, 카테고리 오버라이드를 더한다.
"""
from __future__ import annotations

import pathlib
from datetime import date
from typing import Any

import pytest

from app.features.analytics.trend.series import queries as q
from app.features.analytics.trend.series import service
from app.features.analytics.trend.series.tests import legacy_perf
from app.features.analytics.trend.series.tests.staged import NewCycle, Stage, _apply
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, Sql, SqlFile, needs_db, staged

SEED = pathlib.Path(__file__).with_name("perf_seed.pgsql")
AUG_LEAF = Sql("SELECT rd.ensure_leaf(1::int2, DATE '2026-08-01')")      # 픽스처는 2026-09 파티션만 있다(롤백으로 사라진다)
CYCLES = [NewCycle(9101, date(2026, 8, 17), hidden_scope=2, hidden_reason=2, copy_from=11),
          NewCycle(9102, date(2026, 8, 24), copy_from=11),
          NewCycle(9103, date(2026, 8, 31), copy_from=11),
          NewCycle(9104, date(2026, 9, 2), copy_from=11),
          NewCycle(9105, date(2026, 8, 10), hidden_scope=1, hidden_reason=1, copy_from=11),
          NewCycle(9106, date(2026, 8, 3), hidden_scope=1, hidden_reason=2, copy_from=11)]
LEGACY = ((q, "measured_days_sql", legacy_perf.measured_days_sql), (service, "_own_parts", legacy_perf.own_parts),
          (service, "_series_mix", legacy_perf.series_mix))


async def _copy(conn: Any) -> None:
    await _apply(conn, Stage(cycles=CYCLES))


async def _pair(client_as, monkeypatch, uid, params: dict[str, Any]) -> tuple[dict, bytes]:
    """(새 응답 JSON, 새 응답 바이트) 를 돌려주고 이전 구현 응답 바이트와 같은지 단언한다."""
    async with client_as(uid) as c:
        new = await c.get("/v1/trend", params=params)
        with monkeypatch.context() as m:
            for mod, name, fn in LEGACY:
                m.setattr(mod, name, fn)
            old = await c.get("/v1/trend", params=params)
    assert new.status_code == 200, (params, new.text)
    assert old.status_code == 200, (params, old.text)
    assert new.content == old.content, params
    return new.json(), new.content


def _days(b: dict) -> list[int]:
    return [x["measured_days"] for x in b["data"]["buckets"]]


def _keys(b: dict) -> list[str | None]:
    return [s["key"] for s in b["data"]["series"]]


GLOBAL_CASES: list[dict[str, Any]] = [
    {"surface": "global"},
    {"surface": "global", "bucket": "week"},
    {"surface": "global", "bucket": "month"},
    {"surface": "global", "engine": "gemini"},
    {"surface": "global", "country": "US"},
    {"surface": "global", "from": "2026-08-20", "to": "2026-09-10"},
    {"surface": "global", "from": "2026-08-31", "to": "2026-08-31"},
    {"surface": "global", "dimension": "engine", "metrics": ["M01", "M05"]},
    {"surface": "global", "dimension": "type"},
    {"surface": "global", "dimension": "brand", "top": 3},
    {"surface": "global", "dimension": "brand", "split_own": "true", "metrics": ["M01", "M02", "M03", "M04"]},
    {"surface": "global", "dimension": "brand", "split_own": "true", "bucket": "week", "metrics": ["M02", "M03"]},
    {"surface": "global", "dimension": "brand", "split_own": "true", "bucket": "month", "brand": ["Hyundai", "Kia"]},
    {"surface": "global", "dimension": "brand", "split_own": "true", "engine": "chatgpt", "country": "US"},
    {"surface": "global", "dimension": "source", "top": 1},
    {"surface": "global", "dimension": "source", "top": 3},
    {"surface": "global", "dimension": "source", "top": 4},
    {"surface": "global", "dimension": "source", "top": 5},
    {"surface": "global", "dimension": "source", "top": 15},
    {"surface": "global", "dimension": "source", "top": 50},
    {"surface": "global", "dimension": "source", "top": 10, "bucket": "week"},
    {"surface": "global", "dimension": "source", "top": 10, "bucket": "month"},
    {"surface": "global", "dimension": "source", "top": 6, "source": ["communityForums", "blogsReviews"]},
    {"surface": "global", "dimension": "source", "top": 5, "engine": "gemini", "country": "US"},
    {"surface": "global", "dimension": "source", "top": 5, "from": "2026-08-24", "to": "2026-09-02"},
    {"surface": "global", "dimension": "category", "top": 13},
    {"surface": "global", "dimension": "category", "top": 3},
    {"surface": "global", "dimension": "category", "top": 13, "bucket": "week"},
    {"surface": "global", "dimension": "category", "top": 13, "source": ["newsMedia", "communityForums", "dealerMarketplace"]},
]


@needs_db
@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI, KIA_US], ids=["admin", "hq_hyundai", "kia_us"])
async def test_trend_global_equiv(client_as, monkeypatch, uid):
    """글로벌 표면: 버킷·기간·엔진·국가·source[]·brand·split_own·top 조합에서 새 응답 = 이전 응답(바이트)."""
    async with staged(AUG_LEAF, _copy, SqlFile(SEED)):
        for params in GLOBAL_CASES:
            await _pair(client_as, monkeypatch, uid, params)


@needs_db
async def test_trend_other_surfaces_equiv(client_as, monkeypatch):
    """website(인용 숨김 회차 21)·project(프로젝트 회차 31): 측정 일수와 구성비가 같다."""
    async with staged(AUG_LEAF, _copy, SqlFile(SEED)):
        for params in ({"surface": "website"}, {"surface": "website", "bucket": "week"},
                       {"surface": "website", "dimension": "source", "top": 2}, {"surface": "website", "dimension": "category"},
                       {"surface": "project", "project_id": str(CUST_PROJECT)},
                       {"surface": "project", "project_id": str(CUST_PROJECT), "dimension": "source", "top": 1},
                       {"surface": "project", "project_id": str(CUST_PROJECT), "dimension": "category", "bucket": "month"}):
            await _pair(client_as, monkeypatch, ADMIN, params)


@needs_db
async def test_trend_equiv_exercises_the_changed_paths(client_as, monkeypatch):
    """동치가 빈 결과끼리의 우연이 아님을 확인: 측정 일수가 버킷마다 다르고(0·1·여러 날), 출처 순위 경계가 동률 규칙으로 갈리며,
    split_own 이 관점 비트별 계열을 내고, 출처 차원에 없는 출처(9999, 창 합계 1위)는 순위에 없고 분모에만 들어간다."""
    async with staged(AUG_LEAF, _copy, SqlFile(SEED)):
        base, _ = await _pair(client_as, monkeypatch, ADMIN, {"surface": "global"})
        top4, _ = await _pair(client_as, monkeypatch, ADMIN, {"surface": "global", "dimension": "source", "top": 4})
        top9, _ = await _pair(client_as, monkeypatch, ADMIN, {"surface": "global", "dimension": "source", "top": 9})
        cat, _ = await _pair(client_as, monkeypatch, ADMIN, {"surface": "global", "dimension": "category", "top": 13})
        split, _ = await _pair(client_as, monkeypatch, ADMIN, {"surface": "global", "dimension": "brand", "split_own": "true"})
    days = _days(base)
    assert len(set(days)) >= 3 and max(days) >= 2 and 0 in days, days                  # 08-10 수집 오류 갭 자리 = 0
    assert [b["key"] for b in base["data"]["buckets"]][0] == "2026-08-10"             # 운영자 숨김 08-03 은 자리가 아니다
    # 합계 8: reddit.com(소문자 우선) → Reddit.com → réddit.com, 4 동률의 첫째 = 밑줄(구두점 1차 그룹) → 숫자 → 문자
    assert _keys(top4) == ["reddit.com", "reddit-alt.test", "reddit-acc.test", "under.test"]
    assert _keys(top9)[3:] == ["under.test", "num.test", "alpha1.test", "alpha2.test", "alpha3.test", "caranddriver.com"]
    assert "9999" not in _keys(top4)
    b0902 = next(p for p in top4["data"]["series"][0]["points"] if p["bucket"] == "2026-09-02")
    assert b0902["ratio"]["den"] >= 20 + 41                                            # 9999 인용 20건은 분모에 남는다
    cats = {s["key"]: s for s in cat["data"]["series"]}
    assert "newsMedia" in cats and "dealerMarketplace" in cats                        # 오버라이드(reddit.com → 5, zeta.test → 3)
    owns = [s["own_brand_code"] for s in split["data"]["series"] if s["is_own"] and s["metric"] == "share_of_voice"]
    assert owns == ["Hyundai", "Kia", "Genesis"]
