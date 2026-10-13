"""GET /v1/funnel/conversion 통합 테스트(로컬 합성 DB). 기대값은 conftest 표에서 손으로 계산했다.

관리자 기본 창(최신 적재일 09-11 기준 90일 = 06-14 ~ 09-11, active 속성 901·902):
  AI 세션(report 2) 10+5+20 = 35 · page_views 30+8+40 = 78
  AI 전환(report 3 is_conv) 901 event_count 2+1 = 3, 902 key_events 4 → 7
  비AI 세션(report 1 NOT is_ai) 100+50+200 = 350(05-01 은 창 밖) · 비AI 전환 901 event_count 7 + 902 key_events 10 = 17
  903(pending_grant) 의 7777 은 어디에도 없어야 한다.
"""
from __future__ import annotations

import pytest

from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

URL = "/v1/funnel/conversion"
pytestmark = [needs_db, pytest.mark.usefixtures("ga4_seed")]


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _pair(d):
    return (d["summary"]["ai"]["sessions"], d["summary"]["ai"]["conversions"], d["summary"]["human"]["sessions"],
            d["summary"]["human"]["conversions"])


async def test_admin_default_window_shape_and_values(client_as):
    r = await _get(client_as, ADMIN, surface="global")
    assert r.status_code == 200, r.text
    body = r.json()
    d, m = body["data"], body["meta"]
    assert m["mode"] == "cumulative" and m["as_of"] == "2026-09-11" and m["cycles"] == [] and m["suppressed"] == {}
    assert d["period"] == {"from": "2026-06-14", "to": "2026-09-11"}
    assert d["summary"] == {"ai": {"sessions": 35, "conversions": 7, "page_views": 78, "conv": {"num": 7, "den": 35}},
                            "human": {"sessions": 350, "conversions": 17, "conv": {"num": 17, "den": 350}}}
    assert d["trend"] == [
        {"date": "2026-09-10", "ai_sessions": 10, "ai_conversions": 2, "human_sessions": 100, "human_conversions": 7},
        {"date": "2026-09-11", "ai_sessions": 25, "ai_conversions": 5, "human_sessions": 250, "human_conversions": 10}]
    assert d["by_engine"] == [{"engine": "chatgpt", "sessions": 30, "conversions": 6, "conv": {"num": 6, "den": 30}},
                              {"engine": "gemini", "sessions": 5, "conversions": 1, "conv": {"num": 1, "den": 5}}]
    assert d["pages"] == [{"url": "/a", "ai_sessions": 30, "ai_conversions": 2, "human_sessions": 260, "human_conversions": 7},
                          {"url": "/b", "ai_sessions": 5, "ai_conversions": 0, "human_sessions": 50, "human_conversions": 0}]
    assert d["by_country"] == [
        {"brand": "Hyundai", "country": "US", "ai": {"sessions": 20, "conversions": 4}, "human": {"sessions": 200, "conversions": 10}},
        {"brand": "Kia", "country": "IT", "ai": {"sessions": 15, "conversions": 3}, "human": {"sessions": 150, "conversions": 7}}]
    cov = d["coverage"]
    assert (cov["measured_markets"], cov["total_markets"]) == (2, 4)
    assert [(x["brand"], x["country"], x["status"], x["as_of"]) for x in cov["markets"]] == [
        ("Hyundai", "US", "active", "2026-09-11"), ("Kia", "IT", "active", "2026-09-11"),
        ("Kia", "DE", "pending_grant", None), ("Genesis", "KR", "unmapped", None)]
    assert "7777" not in r.text and "prop_key" not in r.text and "geo_key" not in r.text


async def test_scope_isolation(client_as):
    r = await _get(client_as, HQ_HYUNDAI, surface="global")
    d = r.json()["data"]
    assert r.status_code == 200 and _pair(d) == (20, 4, 200, 10) and d["by_country"] is None
    assert (d["coverage"]["measured_markets"], d["coverage"]["total_markets"]) == (1, 1) and "Kia" not in r.text
    r = await _get(client_as, KIA_EU, surface="global")                      # 권역 → IT(active)·DE(pending)
    d = r.json()["data"]
    assert _pair(d) == (15, 3, 150, 7) and (d["coverage"]["measured_markets"], d["coverage"]["total_markets"]) == (1, 2)
    assert "Hyundai" not in r.text and "US" not in {x["country"] for x in d["coverage"]["markets"]}
    r = await _get(client_as, KIA_US, surface="global")                      # Kia × US 시장 없음 = 준비 중
    body = r.json()
    assert body["meta"]["suppressed"] == {"*": "source_pending"} and body["data"]["coverage"]["total_markets"] == 0
    assert _pair(body["data"]) == (0, 0, 0, 0) and "IT" not in r.text


@pytest.mark.parametrize(("params", "expect"), [
    ({"engine": "gemini"}, (5, 1, 350, 17)),
    ({"device": "mobile"}, (30, 6, 50, 0)),
    ({"visitor_type": "returning"}, (20, 4, 300, 17)),
    ({"country": "IT"}, (15, 3, 150, 7)),
    ({"brand": "Hyundai"}, (20, 4, 200, 10)),
    ({"from": "2026-05-01", "to": "2026-05-31"}, (0, 0, 999, 0)),
    ({"from": "2026-01-01", "to": "2026-01-31"}, (0, 0, 0, 0)),
])
async def test_filters_change_values(client_as, params, expect):
    r = await _get(client_as, ADMIN, surface="global", **params)
    assert r.status_code == 200, r.text
    assert _pair(r.json()["data"]) == expect


async def test_filter_details(client_as):
    r = await _get(client_as, ADMIN, surface="global", engine="gemini")
    d = r.json()["data"]
    assert [e["engine"] for e in d["by_engine"]] == ["gemini"] and d["summary"]["ai"]["page_views"] == 8
    assert d["pages"][0]["url"] == "/b"                                        # AI 세션 순: gemini 는 /b 에만
    r = await _get(client_as, ADMIN, surface="global", device="tablet")        # 적재 차원에 없는 값 = dropped + 빈 집합
    assert r.json()["meta"]["dropped_filters"] == {"device": ["tablet"]} and _pair(r.json()["data"]) == (0, 0, 0, 0)
    r = await _get(client_as, ADMIN, surface="global", lang="en", list_type="L1", source="news")
    assert r.json()["meta"]["ignored_filters"] == ["lang", "list_type", "source"] and _pair(r.json()["data"]) == (35, 7, 350, 17)
    r = await _get(client_as, ADMIN, surface="global", page_limit=1)
    assert [p["url"] for p in r.json()["data"]["pages"]] == ["/a"]
    r = await _get(client_as, ADMIN, **{"surface": "global", "from": "2026-05-01", "to": "2026-05-31"})
    body = r.json()
    assert body["meta"]["as_of"] == "2026-05-31" and body["data"]["period"] == {"from": "2026-05-01", "to": "2026-05-31"}
    assert [t["date"] for t in body["data"]["trend"]] == ["2026-05-01"]
    r = await _get(client_as, ADMIN, surface="global", country="IT")
    assert r.json()["data"]["by_country"] is None                              # active 속성 1개면 국가별 표 없음


async def test_include_pages_false_skips_page_table_only(client_as, monkeypatch):
    """대시보드 ⑦ 카드 호출(include_pages=false): 페이지별 집계 문장을 실행하지 않고 pages = [], 나머지 data·meta 는 기본 호출과 같다."""
    from app.features.analytics.funnel.conversion import service
    full = (await _get(client_as, ADMIN, surface="global")).json()

    def no_pages(*a, **k):
        raise AssertionError("pages_sql must not run when include_pages=false")
    monkeypatch.setattr(service.q, "pages_sql", no_pages)
    card = (await _get(client_as, ADMIN, surface="global", include_pages="false")).json()
    assert card["data"]["pages"] == [] and full["data"]["pages"] != []
    assert {**card["data"], "pages": full["data"]["pages"]} == full["data"] and card["meta"] == full["meta"]


async def test_website_surface_same_source(client_as):
    r = await _get(client_as, ADMIN, surface="website")
    assert r.status_code == 200 and r.json()["meta"]["surface"] == "website" and _pair(r.json()["data"]) == (35, 7, 350, 17)


@pytest.mark.parametrize("params", [
    {"surface": "global", "device": "phone"},
    {"surface": "global", "visitor_type": "x"},
    {"surface": "global", "page_limit": 0},
    {"surface": "global", "page_limit": 51},
    {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"},
    {"surface": "project"},
])
async def test_bad_params_422(client_as, params):
    r = await _get(client_as, ADMIN, **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"


async def test_auth_menu_and_project_pending(client_as):
    assert (await _get(client_as, None, surface="global")).status_code == 401
    assert (await _get(client_as, SUSPENDED, surface="global")).status_code == 401
    r = await _get(client_as, VENDOR, surface="global")          # core 표면 경로 게이트(D-vendor): 역할이 표준 경로 밖
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    r = await _get(client_as, HQ_HYUNDAI, surface="website")
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
    # project 표면(BG-28): 프로젝트 Hyundai US 시장 속성 902 를 읽는다(이전: 원천 없음 source_pending 고정). 상세는 test_conversion_bg.py
    r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), country="US")
    body = r.json()
    assert r.status_code == 200 and body["meta"]["suppressed"] == {} and body["meta"]["ignored_filters"] == []
    assert _pair(body["data"]) == (20, 4, 200, 10) and body["data"]["coverage"]["total_markets"] == 1
    assert (await _get(client_as, KIA_US, surface="project", project_id=str(CUST_PROJECT))).status_code == 404
