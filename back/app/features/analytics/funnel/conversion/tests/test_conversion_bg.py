"""GET /v1/funnel/conversion 값 갭 보강(BG-28·29 coverage·30·31) + GET /v1/funnel/conversion/events(BG-29 읽기) 통합 테스트.

기대값은 conftest 표(모듈 시드 901·902·903)와 bg_ga4.pgsql 조각에서 손으로 계산했다(구현 SQL 을 옮기지 않는다).
  시드 엔진별(관리자 기본 창): chatgpt = 901 09-10 세션 10·전환 event_count 2 + 902 세션 20·전환 key_events 4 → 30/6,
                              gemini  = 901 09-11 세션 5·전환 event_count 1 → 5/1.
  프로젝트 CUST_PROJECT = Hyundai US → 시장 속성 902: (AI 세션, AI 전환, 비AI 세션, 비AI 전환) = (20, 4, 200, 10).
"""
from __future__ import annotations

import pathlib
from contextlib import asynccontextmanager

import pytest

from tests.support import (
    ADMIN,
    CUST_PROJECT,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    SYSTEM,
    VENDOR,
    WEBSITE_KIA,
    Sql,
    Update,
    needs_db,
    raw_fetch,
    savepoint,
    stage,
)

URL = "/v1/funnel/conversion"
EV = "/v1/funnel/conversion/events"
pytestmark = [needs_db, pytest.mark.usefixtures("ga4_seed")]

_SQL: dict[str, str] = {}
for _part in (pathlib.Path(__file__).parent / "bg_ga4.pgsql").read_text(encoding="utf-8").split("-- @")[1:]:
    _name, _, _body = _part.partition("\n")
    _SQL[_name.strip()] = _body.strip()


@asynccontextmanager
async def _staged_part(conn, *names: str, extra=()):
    """시험 하나의 추가 행(세이브포인트 안, 시험 끝에 되돌린다)."""
    async with savepoint(conn):
        await stage(conn, *[Sql(_SQL[n]) for n in names], *extra)
        yield conn


async def _get(client_as, uid, url=URL, **params):
    async with client_as(uid) as c:
        return await c.get(url, params=params)


def _pair(d):
    return (d["summary"]["ai"]["sessions"], d["summary"]["ai"]["conversions"], d["summary"]["human"]["sessions"],
            d["summary"]["human"]["conversions"])


def _eng(rows):
    return [(e["engine"], e["sessions"], e["conversions"]) for e in rows]


# ── BG-29: coverage.markets[].property_id ──
async def test_bg29_coverage_property_id(client_as):
    r = await _get(client_as, ADMIN, surface="global")
    assert r.status_code == 200, r.text
    got = [(m["brand"], m["country"], m["status"], m["property_id"]) for m in r.json()["data"]["coverage"]["markets"]]
    assert got == [("Hyundai", "US", "active", "t-ga4-hy-us"), ("Kia", "IT", "active", "t-ga4-kia-it"),
                   ("Kia", "DE", "pending_grant", "t-ga4-kia-de"), ("Genesis", "KR", "unmapped", None)]
    r = await _get(client_as, HQ_HYUNDAI, surface="global")                  # 스코프 밖 시장 속성 id 누출 없음
    assert "t-ga4-kia" not in r.text and "t-ga4-gen" not in r.text
    assert [m["property_id"] for m in r.json()["data"]["coverage"]["markets"]] == ["t-ga4-hy-us"]


# ── BG-30: days(7·28·90) = 최신 적재일 기준 상대 창 ──
@pytest.mark.parametrize(("days", "period", "pair"), [
    (7, ("2026-09-05", "2026-09-11"), (35, 7, 350, 17)),
    (28, ("2026-08-15", "2026-09-11"), (75, 7, 1350, 17)),
    (90, ("2026-06-14", "2026-09-11"), (75, 7, 1350, 17)),
])
async def test_bg30_relative_days(client_as, ga4_seed, days, period, pair):
    async with _staged_part(ga4_seed, "days"):
        r = await _get(client_as, ADMIN, surface="global", days=days)
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert (d["period"]["from"], d["period"]["to"]) == period and _pair(d) == pair
        assert r.json()["meta"]["as_of"] == "2026-09-11"
        base = await _get(client_as, ADMIN, surface="global")                # 생략 = 90(기존 동작 무변화)
        assert _pair(base.json()["data"]) == (75, 7, 1350, 17)


async def test_bg30_days_with_filters_and_scope(client_as, ga4_seed):
    async with _staged_part(ga4_seed, "days"):
        r = await _get(client_as, ADMIN, surface="global", days=28, engine="gemini")    # 08-20 행은 chatgpt
        assert _pair(r.json()["data"]) == (5, 1, 1350, 17)
        r = await _get(client_as, HQ_HYUNDAI, surface="global", days=7)                  # Hyundai US 만(901 행 누출 없음)
        assert _pair(r.json()["data"]) == (20, 4, 200, 10)
        r = await _get(client_as, ADMIN, surface="global", days=7, device="desktop")      # 08-20 행은 mobile: 창 7 은 무관
        assert _pair(r.json()["data"]) == (5, 1, 300, 17)


@pytest.mark.parametrize("params", [
    {"surface": "global", "days": 14},
    {"surface": "global", "days": 0},
    {"surface": "global", "days": "x"},
    {"surface": "global", "days": 7, "from": "2026-09-01", "to": "2026-09-11"},
])
async def test_bg30_bad_days_422(client_as, params):
    r = await _get(client_as, ADMIN, **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"


# ── BG-31: by_engine_all 은 engine[] 을 무시한다(by_engine 의미는 그대로) ──
async def test_bg31_by_engine_all(client_as):
    r = await _get(client_as, ADMIN, surface="global")
    d = r.json()["data"]
    assert _eng(d["by_engine_all"]) == _eng(d["by_engine"]) == [("chatgpt", 30, 6), ("gemini", 5, 1)]
    assert d["by_engine_all"][0]["conv"] == {"num": 6, "den": 30}
    r = await _get(client_as, ADMIN, surface="global", engine="gemini")
    d = r.json()["data"]
    assert _eng(d["by_engine"]) == [("gemini", 5, 1)] and _eng(d["by_engine_all"]) == [("chatgpt", 30, 6), ("gemini", 5, 1)]
    assert _pair(d) == (5, 1, 350, 17)                                          # 요약은 engine[] 적용 그대로


@pytest.mark.parametrize(("uid", "params", "expect"), [
    (ADMIN, {"engine": "gemini", "device": "mobile"}, [("chatgpt", 30, 6)]),           # 기기는 적용(gemini 행은 desktop)
    (ADMIN, {"engine": "chatgpt", "country": "IT"}, [("chatgpt", 10, 2), ("gemini", 5, 1)]),   # 시장 적용
    (ADMIN, {"engine": "chatgpt", "visitor_type": "returning"}, [("chatgpt", 20, 4)]),  # 902 만 returning
    (HQ_HYUNDAI, {"engine": "gemini"}, [("chatgpt", 20, 4)]),                         # 스코프: Kia IT 행 누출 없음
    (ADMIN, {"engine": "gemini", "from": "2026-01-01", "to": "2026-01-31"}, []),       # 빈 창
])
async def test_bg31_filters_apply_except_engine(client_as, uid, params, expect):
    r = await _get(client_as, uid, surface="global", **params)
    assert r.status_code == 200, r.text
    assert _eng(r.json()["data"]["by_engine_all"]) == expect


# ── BG-28: project 표면 = 프로젝트 속성(직접 지정 우선, 없으면 시장 속성) ──
async def test_bg28_project_market_property(client_as):
    r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), brand="Kia")
    assert r.status_code == 200, r.text
    body = r.json()
    d = body["data"]
    assert _pair(d) == (20, 4, 200, 10) and body["meta"]["suppressed"] == {} and body["meta"]["ignored_filters"] == ["brand"]
    assert d["coverage"] == {"measured_markets": 1, "total_markets": 1, "markets": [
        {"brand": "Hyundai", "country": "US", "status": "active", "as_of": "2026-09-11", "property_id": "t-ga4-hy-us"}]}
    assert d["period"] == {"from": "2026-06-14", "to": "2026-09-11"} and d["by_country"] is None
    assert [t["date"] for t in d["trend"]] == ["2026-09-11"] and "t-ga4-kia" not in r.text
    r = await _get(client_as, ADMIN, surface="project", project_id=str(CUST_PROJECT))
    assert r.status_code == 200 and _pair(r.json()["data"]) == (20, 4, 200, 10)


@pytest.mark.parametrize(("params", "pair"), [
    ({"engine": "chatgpt"}, (20, 4, 200, 10)),
    ({"engine": "gemini"}, (0, 0, 200, 10)),
    ({"device": "desktop"}, (0, 0, 200, 10)),
    ({"country": "US"}, (20, 4, 200, 10)),
    ({"from": "2026-09-10", "to": "2026-09-10"}, (0, 0, 0, 0)),
    ({"days": 7}, (20, 4, 200, 10)),
])
async def test_bg28_project_filters(client_as, params, pair):
    r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), **params)
    assert r.status_code == 200, r.text
    assert _pair(r.json()["data"]) == pair and r.json()["meta"]["suppressed"] == {}


async def test_bg28_project_country_filtered_out_and_gate(client_as):
    r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), country="KR")
    body = r.json()
    assert r.status_code == 200 and body["meta"]["suppressed"] == {} and body["data"]["coverage"]["total_markets"] == 0
    assert _pair(body["data"]) == (0, 0, 0, 0)
    # 게이트 = 활성 멤버 ∨ admin(현행 프로젝트 화면 notFound): 스코프 안 비멤버·스코프 밖은 404
    for uid in (HQ_HYUNDAI, KIA_US, KIA_EU):
        assert (await _get(client_as, uid, surface="project", project_id=str(CUST_PROJECT))).status_code == 404, uid
    assert (await _get(client_as, WEBSITE_KIA, surface="project", project_id=str(CUST_PROJECT))).status_code == 403


async def test_bg28_project_override_property(client_as, ga4_seed):
    """직접 지정 속성(7003, 적재 출처 project_override)이 시장 속성(902)보다 우선. global·website 에는 안 섞인다."""
    upd = Update("app.project", {"project_id": CUST_PROJECT}, {"ga4_property_id": "7003"})
    async with _staged_part(ga4_seed, "events", extra=(upd,)):
        r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert _pair(d) == (7, 1, 70, 0) and d["summary"]["ai"]["page_views"] == 9
        assert d["coverage"]["markets"] == [{"brand": "Hyundai", "country": "US", "status": "active", "as_of": "2026-09-11",
                                             "property_id": "7003"}]
        assert _eng(d["by_engine_all"]) == [("chatgpt", 7, 1)]
        g = await _get(client_as, ADMIN, surface="global")                    # 프로젝트 자체 속성은 글로벌 모수에 없다
        assert _pair(g.json()["data"]) == (35, 7, 350, 17) and "7003" not in g.text
    async with savepoint(ga4_seed):                                          # 직접 지정했는데 적재 전·레지스트리 밖 = 대기
        await stage(ga4_seed, Update("app.project", {"project_id": CUST_PROJECT}, {"ga4_property_id": "7999"}))
        r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
        body = r.json()
        assert body["meta"]["suppressed"] == {"*": "source_pending"} and _pair(body["data"]) == (0, 0, 0, 0)
        assert body["data"]["coverage"]["markets"] == [{"brand": "Hyundai", "country": "US", "status": "pending_grant",
                                                        "as_of": None, "property_id": "7999"}]


async def test_bg28_project_unmapped_umbrella(client_as, ga4_seed):
    """브랜드 없는(엄브렐러) 프로젝트 + 직접 지정 없음 = unmapped(현행 page.tsx:52-55 brand ? resolveProperty : null)."""
    async with savepoint(ga4_seed):
        await stage(ga4_seed, Sql("SELECT set_config('app.actor_id', $1, true)", (str(SYSTEM),)),
                    Update("app.project", {"project_id": CUST_PROJECT}, {"brand_code": None}))
        r = await _get(client_as, ADMIN, surface="project", project_id=str(CUST_PROJECT))
        body = r.json()
        assert r.status_code == 200, r.text
        assert body["meta"]["suppressed"] == {"*": "source_pending"} and _pair(body["data"]) == (0, 0, 0, 0)
        m = body["data"]["coverage"]["markets"]
        assert [(x["country"], x["status"], x["property_id"]) for x in m] == [("US", "unmapped", None)]
        assert m[0]["brand"] == (await raw_fetch(ga4_seed, "SELECT brand_code FROM app.brand WHERE is_umbrella"))[0]["brand_code"]


# ── BG-29: GET /v1/funnel/conversion/events(비관리자 경로) ──
def _items(d):
    return [(i["event_name"], i["count"], i["tracked"]) for i in d["items"]]


async def test_bg29_events_read_scope(client_as, ga4_seed):
    async with _staged_part(ga4_seed, "events"):
        today = (await raw_fetch(ga4_seed, "SELECT rd.today_kst() AS d"))[0]["d"]
        r = await _get(client_as, ADMIN, EV, property_id="7001", surface="global")
        assert r.status_code == 200, r.text
        body = r.json()
        d = body["data"]
        assert _items(d) == [("purchase", 5, True), ("page_view", 3, False)]
        assert (d["loaded"], d["conv_basis"], d["registered"], d["can_edit"]) == (True, "tracked_events", True, True)
        assert d["window_to"] == today.isoformat() and body["meta"]["mode"] == "crud" and body["meta"]["surface"] == "global"
        # 계정 스코프 시장(Kia FR)이 해석하는 속성: 권역 계정은 편집 가능, website 역할은 조회만
        r = await _get(client_as, KIA_EU, EV, property_id="7001")                                     # 생략 표면 = website
        assert r.status_code == 200 and r.json()["data"]["can_edit"] is True and r.json()["meta"]["surface"] == "website"
        r = await _get(client_as, WEBSITE_KIA, EV, property_id="7001")
        assert r.status_code == 200 and r.json()["data"]["can_edit"] is False and _items(r.json()["data"])[0] == ("purchase", 5, True)
        # 스코프 밖(국가·브랜드)은 404, 표면 게이트 밖은 403
        assert (await _get(client_as, KIA_US, EV, property_id="7001", surface="global")).status_code == 404
        assert (await _get(client_as, HQ_HYUNDAI, EV, property_id="7001", surface="global")).status_code == 404
        r = await _get(client_as, HQ_HYUNDAI, EV, property_id="7001")
        assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
        r = await _get(client_as, VENDOR, EV, property_id="7001", surface="global")
        assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
        # 적재 전 pending 속성(Hyundai DE): 목록 비어 있음, 편집 역할(hq)
        r = await _get(client_as, HQ_HYUNDAI, EV, property_id="7002", surface="global")
        d = r.json()["data"]
        assert r.status_code == 200 and d["items"] == [] and (d["loaded"], d["registered"], d["can_edit"]) == (False, True, True)
        # 모르는 속성은 admin 도 404
        assert (await _get(client_as, ADMIN, EV, property_id="7999", surface="global")).status_code == 404
        # 공통 필터 축은 무시를 드러낸다
        r = await _get(client_as, ADMIN, EV, property_id="7001", surface="global", brand="Kia", engine="chatgpt")
        assert r.json()["meta"]["ignored_filters"] == ["brand", "engine"]


async def test_bg29_events_read_project(client_as, ga4_seed):
    upd = Update("app.project", {"project_id": CUST_PROJECT}, {"ga4_property_id": "7003"})
    async with _staged_part(ga4_seed, "events", extra=(upd,)):
        r = await _get(client_as, VENDOR, EV, property_id="7003", project_id=str(CUST_PROJECT))
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert _items(d) == [("purchase", 2, False)]
        assert (d["loaded"], d["conv_basis"], d["registered"], d["can_edit"]) == (True, "key_events", False, False)
        assert r.json()["meta"]["surface"] == "project"
        # 프로젝트가 해석하지 않는 속성(IDOR), 비멤버, 스코프 밖은 404
        assert (await _get(client_as, VENDOR, EV, property_id="7001", project_id=str(CUST_PROJECT))).status_code == 404
        assert (await _get(client_as, HQ_HYUNDAI, EV, property_id="7003", project_id=str(CUST_PROJECT))).status_code == 404
        assert (await _get(client_as, KIA_US, EV, property_id="7003", project_id=str(CUST_PROJECT))).status_code == 404
        r = await _get(client_as, ADMIN, EV, property_id="7003", project_id=str(CUST_PROJECT))
        assert r.status_code == 200 and r.json()["data"]["can_edit"] is False                 # 레지스트리 밖은 편집 불가
        r = await _get(client_as, ADMIN, EV, property_id="7001", project_id=str(CUST_PROJECT))  # admin 은 알려진 속성이면 연다
        assert r.status_code == 200 and r.json()["data"]["can_edit"] is True


@pytest.mark.parametrize("params", [
    {"property_id": "abc"},
    {"property_id": ""},
    {"property_id": "1" * 21},
    {"property_id": "7001", "surface": "website", "project_id": str(CUST_PROJECT)},
    {"property_id": "7001", "surface": "project"},
    {"property_id": "7001", "surface": "nowhere"},
    {"property_id": "7001", "project_id": "not-a-uuid"},
    {},
])
async def test_bg29_events_bad_params_422(client_as, params):
    r = await _get(client_as, ADMIN, EV, **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"


async def test_bg29_events_unauthenticated(client_as):
    assert (await _get(client_as, None, EV, property_id="7001")).status_code == 401
