"""검증 결함 D1~D4(커밋 e9c64db 판정 1·2차) 회귀 테스트. 조회 경로만(쓰기 경로 D1 은 test_conversion_events_write.py).

준비 = conftest 시드(901·902·903) + bg_ga4.pgsql 의 events·override 조각. 기대값은 조각 주석에서 손으로 계산했다.
  CUST_PROJECT = Hyundai US, 시장 속성 902('t-ga4-hy-us'): (AI 세션, AI 전환, 비AI 세션, 비AI 전환) = (20, 4, 200, 10).
  다른 시장 속성 7001(Kia FR 레지스트리·적재) · 7006(Kia FR project_override 적재) · 7007(레지스트리 출처 미귀속 적재) · 7004(Kia BE 레지스트리).
  7006·7007 은 09-11 AI 세션 13·비AI 세션 130 이라, 프로젝트 화면에 읽히면 0 이 아니다.
"""
from __future__ import annotations

import pathlib
from contextlib import asynccontextmanager

import pytest

from tests.support import ADMIN, CUST_PROJECT, KIA_EU, VENDOR, Sql, Update, needs_db, savepoint, stage

URL = "/v1/funnel/conversion"
EV = "/v1/funnel/conversion/events"
pytestmark = [needs_db, pytest.mark.usefixtures("ga4_seed")]

_SQL: dict[str, str] = {}
for _part in (pathlib.Path(__file__).parent / "bg_ga4.pgsql").read_text(encoding="utf-8").split("-- @")[1:]:
    _name, _, _body = _part.partition("\n")
    _SQL[_name.strip()] = _body.strip()


@asynccontextmanager
async def _prepared(conn, override: str | None = None):
    """events·override 조각 + (선택) CUST_PROJECT 직접 지정 속성. 세이브포인트라 시험 끝에 되돌린다."""
    async with savepoint(conn):
        extra = (Update("app.project", {"project_id": CUST_PROJECT}, {"ga4_property_id": override}),) if override else ()
        await stage(conn, Sql(_SQL["events"]), Sql(_SQL["override"]), *extra)
        yield conn


async def _get(client_as, uid, url=URL, **params):
    async with client_as(uid) as c:
        return await c.get(url, params=params)


def _pair(d):
    return (d["summary"]["ai"]["sessions"], d["summary"]["ai"]["conversions"], d["summary"]["human"]["sessions"],
            d["summary"]["human"]["conversions"])


_UNMAPPED = [{"brand": "Hyundai", "country": "US", "status": "unmapped", "as_of": None, "property_id": None}]


# ── D1: 다른 시장에 귀속된 속성을 직접 지정해도 읽지 않고, 이벤트 경로도 비관리자는 404 ──
@pytest.mark.parametrize("override", ["7001", "7006", "7007", "7004"])
async def test_d1_foreign_override_not_read(client_as, ga4_seed, override):
    async with _prepared(ga4_seed, override):
        r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["data"]["coverage"]["markets"] == _UNMAPPED
        assert _pair(body["data"]) == (0, 0, 0, 0) and body["data"]["by_engine_all"] == []
        assert body["meta"]["suppressed"] == {"*": "source_pending"} and override not in r.text
        # 비관리자(활성 멤버)는 그 속성의 전환 이벤트를 열지 못한다(목록·편집 판정 모두)
        r = await _get(client_as, VENDOR, EV, property_id=override, project_id=str(CUST_PROJECT))
        assert r.status_code == 404, r.text
        # admin 은 알려진 속성이면 맥락과 무관하게 연다(현행 authorize: admin 무조건 허용)
        r = await _get(client_as, ADMIN, EV, property_id=override, project_id=str(CUST_PROJECT))
        assert r.status_code == 200, r.text
        # 프로젝트 화면도 admin 에게 다른 시장 수치를 이 프로젝트 라벨로 주지 않는다
        r = await _get(client_as, ADMIN, surface="project", project_id=str(CUST_PROJECT))
        assert r.json()["data"]["coverage"]["markets"] == _UNMAPPED and _pair(r.json()["data"]) == (0, 0, 0, 0)


async def test_d1_own_market_override_still_read(client_as, ga4_seed):
    """같은 시장(Hyundai US) 레지스트리·적재 속성을 직접 지정하면 그대로 읽는다(과잉 차단 방지)."""
    async with _prepared(ga4_seed, "t-ga4-hy-us"):
        r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
        d = r.json()["data"]
        assert r.status_code == 200 and _pair(d) == (20, 4, 200, 10)
        assert d["coverage"]["markets"] == [{"brand": "Hyundai", "country": "US", "status": "active", "as_of": "2026-09-11",
                                             "property_id": "t-ga4-hy-us"}]
    async with _prepared(ga4_seed, "7003"):                                   # 같은 시장 비트·국가의 project_override 적재
        r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
        assert _pair(r.json()["data"]) == (7, 1, 70, 0)
        assert (await _get(client_as, VENDOR, EV, property_id="7003", project_id=str(CUST_PROJECT))).status_code == 200


async def test_d1_foreign_env_market_override_kia_it(client_as, ga4_seed):
    """검증 D1 재현 (5): 직접 지정을 다른 시장 시드 속성 t-ga4-kia-it(Kia IT 레지스트리·적재 901)로 두어도 project 표면은 Kia IT GA4 수·
    페이지를 내지 않는다(비관리자·admin 모두). property_source=market 이면 자기 시장 902 값 그대로."""
    async with _prepared(ga4_seed, "t-ga4-kia-it"):
        for uid in (VENDOR, ADMIN):
            r = await _get(client_as, uid, surface="project", project_id=str(CUST_PROJECT))
            d = r.json()["data"]
            assert r.status_code == 200, r.text
            assert d["coverage"]["markets"] == _UNMAPPED and _pair(d) == (0, 0, 0, 0) and d["pages"] == []
            assert "t-ga4-kia-it" not in r.text
        r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), property_source="market")
        assert _pair(r.json()["data"]) == (20, 4, 200, 10)


# ── D2: 직접 지정 속성이 레지스트리에 unmapped(매핑 전)로만 있고 적재가 없으면 대기(pending_grant) + 속성 id ──
async def test_d2_override_registry_unmapped_is_pending(client_as, ga4_seed):
    async with _prepared(ga4_seed, "7008"):
        r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
        body = r.json()
        assert r.status_code == 200, r.text
        assert body["data"]["coverage"]["markets"] == [{"brand": "Hyundai", "country": "US", "status": "pending_grant",
                                                        "as_of": None, "property_id": "7008"}]
        assert body["meta"]["suppressed"] == {"*": "source_pending"} and _pair(body["data"]) == (0, 0, 0, 0)
        r = await _get(client_as, VENDOR, EV, property_id="7008", project_id=str(CUST_PROJECT))   # 대기 안내와 같이 다이얼로그는 열린다
        d = r.json()["data"]
        assert r.status_code == 200 and (d["loaded"], d["registered"], d["can_edit"]) == (False, True, False)


# ── D3: property_source=market 은 직접 지정을 건너뛴다(대시보드 ⑦), 생략·project 는 직접 지정 우선(전환 화면) ──
async def test_d3_property_source(client_as, ga4_seed):
    async with _prepared(ga4_seed, "7003"):
        r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), property_source="market")
        d = r.json()["data"]
        assert r.status_code == 200 and _pair(d) == (20, 4, 200, 10)
        assert [m["property_id"] for m in d["coverage"]["markets"]] == ["t-ga4-hy-us"]
        for ps in ("project", None):
            params = {"property_source": ps} if ps else {}
            r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), **params)
            assert _pair(r.json()["data"]) == (7, 1, 70, 0), ps
            assert r.json()["meta"]["ignored_filters"] == []                    # 확장 파라미터라 공통 축 무시 목록에 안 나온다


@pytest.mark.parametrize("params", [
    {"surface": "global", "property_source": "market"},
    {"surface": "website", "property_source": "project"},
    {"surface": "project", "project_id": str(CUST_PROJECT), "property_source": "other"},
])
async def test_d3_property_source_422(client_as, params):
    r = await _get(client_as, ADMIN, **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"


# ── D4(known_diff 고정): 레지스트리 상태 unmapped 시장은 속성 id 가 있어도 coverage 에 null, 비관리자 이벤트 경로 404 ──
async def test_d4_unmapped_registry_market_known_diff(client_as, ga4_seed):
    async with _prepared(ga4_seed):
        r = await _get(client_as, KIA_EU, surface="global")
        assert r.status_code == 200, r.text
        be = [m for m in r.json()["data"]["coverage"]["markets"] if (m["brand"], m["country"]) == ("Kia", "BE")]
        assert be == [{"brand": "Kia", "country": "BE", "status": "unmapped", "as_of": None, "property_id": None}]
        assert "7004" not in r.text
        assert (await _get(client_as, KIA_EU, EV, property_id="7004")).status_code == 404        # 현행 다이얼로그는 열린다(의도된 축소)
        assert (await _get(client_as, ADMIN, EV, property_id="7004", surface="global")).status_code == 200


# ── 2차 D4(known_diff DC-5 고정): days 창 = [최신 적재일 - (N-1), 최신 적재일], N 일. 현행은 GA4 '{N}daysAgo'..'today'(N+1 달력일) ──
@pytest.mark.parametrize(("days", "lo"), [(7, "2026-09-05"), (28, "2026-08-15"), (90, "2026-06-14")])
async def test_d4_days_window_length_known_diff(client_as, days, lo):
    r = await _get(client_as, ADMIN, surface="global", days=days)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["period"] == {"from": lo, "to": "2026-09-11"}           # 끝점 = 최신 적재일(오늘 아님), 길이 N
    assert r.json()["meta"]["as_of"] == "2026-09-11"
