"""intent.keywords.research 테스트: 형태·기대값(합성 rd.kw_* 에서 손계산)·권한·스코프·빈 결과·422·필터 무시 기록."""
from __future__ import annotations

import unicodedata
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio

from app.features.intent.keywords.research.intent_common import freshness
from app.features.intent.keywords.research.tests import intent_fixtures as fx
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def world(seeded):
    w = await fx.build_kw_world("research")
    pr = await fx.create_projects()
    yield w, pr
    await fx.drop_projects(pr)
    await fx.cleanup_drafts([w.serp_new, w.serp_old, w.serp_stale])


# ── 단위 ──
# term_norm·프리셋 골든 세트는 core.kw 로 옮겨 tests/core/test_round6.py 가 맡는다(intent R1). 여기는 기능 신선도 규칙만.
def test_freshness_ttl():
    now = datetime(2026, 9, 28, 12, tzinfo=UTC)
    assert freshness(None, "insight", now=now) == "missing"
    assert freshness(now - timedelta(hours=24), "insight", now=now) == "fresh"
    assert freshness(now - timedelta(hours=24, seconds=1), "insight", now=now) == "stale"
    assert freshness(now - timedelta(days=7), "related", now=now) == "fresh"
    assert freshness(now - timedelta(days=7, seconds=1), "search", now=now) == "stale"


# ── insight ──
async def test_insight_shape_and_values(client_as, world):
    w, _ = world
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "us"})
    assert r.status_code == 200, r.text
    body = r.json()
    d, m = body["data"], body["meta"]
    assert (d["location_code"], d["language_code"], d["country"]) == (2840, "en", "us")
    # 14개월 적재 → 최근 12개월, 시간순. 값 = 100 + 인덱스(2..13)
    assert [p["month"] for p in d["trend"]] == [x.isoformat() for x in w.months[2:]]
    assert [p["search_volume"] for p in d["trend"]] == list(range(102, 114))
    # 최신 SERP 호출(new, 10행) 중 기본 8행, 순위 오름차순
    assert d["serp_call_id"] == w.serp_new
    assert [s["rank"] for s in d["serp"]] == list(range(1, 9))
    assert d["serp"][0]["title"] == "title new1"
    # rank 2 초안은 gen 이 2개 → 최신 gen(2)만, 행 중복 없음
    assert d["serp"][1]["suggested_prompt"] == "new draft" and d["serp"][1]["draft_gen"] == 2
    assert d["serp"][0]["suggested_prompt"] is None
    assert m["source"]["freshness"] == "fresh" and m["mode"] == "external" and m["surface"] is None
    assert m["suppressed"] == {}


async def test_insight_limit_and_country_changes_value(client_as, world):
    w, _ = world
    async with client_as(ADMIN) as c:
        r10 = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "us", "limit": 10})
        kr = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "KR"})
    assert len(r10.json()["data"]["serp"]) == 10
    d = kr.json()["data"]
    assert [p["search_volume"] for p in d["trend"]] == [w.kr_volume] and d["serp"] == []
    assert kr.json()["meta"]["source"]["freshness"] == "stale"      # 검색량만 있고 SERP 없음 → stale


async def test_insight_stale_missing_and_nfd(client_as, world):
    w, _ = world
    async with client_as(ADMIN) as c:
        st = await c.get("/v1/intent/insight", params={"term": w.stale, "country": "us"})
        ms = await c.get("/v1/intent/insight", params={"term": w.missing, "country": "us"})
        ko = await c.get("/v1/intent/insight", params={"term": unicodedata.normalize("NFD", w.korean.upper()), "country": "kr"})
    assert st.json()["meta"]["source"]["freshness"] == "stale"
    mj = ms.json()
    assert ms.status_code == 200 and mj["data"]["trend"] == [] and mj["data"]["serp"] == [] and mj["data"]["serp_call_id"] is None
    assert mj["meta"]["suppressed"] == {"*": "source_pending"} and mj["meta"]["source"]["freshness"] == "missing"
    assert [p["search_volume"] for p in ko.json()["data"]["trend"]] == [1234]


@pytest.mark.parametrize("params,code", [
    ({"term": "x", "country": "zz"}, "unknown_country"),
    ({"term": "   ", "country": "us"}, "unprocessable"),
    ({"term": "x", "country": "us", "limit": 11}, "unprocessable"),
    ({"country": "us"}, "unprocessable"),
    ({"term": "x"}, "unknown_country"),            # 프로젝트 없음 + 국가 없음
])
async def test_insight_422(client_as, world, params, code):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/intent/insight", params=params)
    assert r.status_code == 422 and r.json()["error"]["code"] == code


async def test_standard_screen_permissions(client_as, world):
    w, _ = world
    p = {"term": w.fresh}
    async with client_as(VENDOR) as c:                      # vendor 메뉴 {project}: 표준 화면 메뉴 없음(역할 게이트 앞에서 막힌다)
        assert (await c.get("/v1/intent/insight", params={**p, "country": "us"})).json()["error"]["code"] == "menu_forbidden"
    async with client_as(KIA_US) as c:                      # 국가 스코프 US
        assert (await c.get("/v1/intent/insight", params={**p, "country": "us"})).status_code == 200
        r = await c.get("/v1/intent/insight", params={**p, "country": "kr"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "country_forbidden"
    async with client_as(KIA_EU) as c:                      # 권역 kia-western-europe → DE 포함, US 불포함
        assert (await c.get("/v1/intent/related", params={**p, "country": "de"})).status_code == 200
        assert (await c.get("/v1/intent/related", params={**p, "country": "us"})).status_code == 403
    async with client_as(SUSPENDED) as c:
        assert (await c.get("/v1/intent/insight", params={**p, "country": "us"})).status_code == 401
    async with client_as(None) as c:
        assert (await c.get("/v1/intent/insight", params={**p, "country": "us"})).status_code == 401


async def test_project_access(client_as, world):
    w, pr = world
    async with client_as(VENDOR) as c:     # 고객 프로젝트 활성 멤버(viewer): 국가 생략 = 프로젝트 국가(US)
        r = await c.get("/v1/intent/insight", params={"term": w.fresh, "project_id": str(CUST_PROJECT)})
        assert r.status_code == 200 and r.json()["data"]["country"] == "us" and len(r.json()["data"]["trend"]) == 12
        assert (await c.get("/v1/intent/insight", params={"term": w.fresh, "project_id": str(pr.own)})).status_code == 404
    async with client_as(KIA_US) as c:     # Hyundai 프로젝트는 Kia 스코프 밖 → 404(IDOR 은폐)
        assert (await c.get("/v1/intent/related", params={"term": w.fresh, "project_id": str(pr.own)})).status_code == 404
    async with client_as(HQ_HYUNDAI) as c:
        assert (await c.get("/v1/intent/lookup", params={"terms": [w.fresh], "project_id": str(pr.own)})).status_code == 200


# ── related·lookup ──
async def test_related_excludes_seed(client_as, world):
    w, _ = world
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/intent/related", params={"term": w.fresh, "country": "us"})
        miss = await c.get("/v1/intent/related", params={"term": w.missing, "country": "us"})
    d = r.json()["data"]
    assert d["found_count"] == 2 and d["total_count"] == 1234      # BG-39: 원래 총수(DataForSEO total_count)는 found_count 와 따로
    assert miss.json()["data"]["total_count"] is None
    assert d["items"] == [{"term": w.t("kona price"), "search_volume": 300, "intent": "transactional"},
                          {"term": w.t("kona review"), "search_volume": None, "intent": "informational"}]
    # 신선도 = 최신 연관어 호출 rd.kw_suggestion.observed_at(DB-v2.6 P43, intent R4: 예전 unknown), 1시간 전 → fresh
    m = r.json()["meta"]
    assert m["source"]["freshness"] == "fresh" and m["source"]["ttl"] == "7d" and m["source"]["observed_at"] and m["as_of"]
    assert miss.json()["data"]["items"] == [] and miss.json()["meta"]["suppressed"] == {"*": "source_pending"}
    assert miss.json()["meta"]["source"]["freshness"] == "missing"


async def test_related_stale_by_observed_at(client_as, world):
    """intent R4: 8일 전 연관어 호출 → stale(TTL 7일), 값은 그대로 보여 준다(suppressed 없음)."""
    w, _ = world
    async with client_as(ADMIN) as c:
        st = await c.get("/v1/intent/related", params={"term": w.stale, "country": "us"})
    assert st.json()["data"]["items"] == [{"term": w.t("tucson size"), "search_volume": 20, "intent": "informational"}]
    assert st.json()["data"]["total_count"] is None                   # 응답에 total_count 가 없던 호출 → null(프론트는 items 수 폴백)
    assert st.json()["meta"]["source"]["freshness"] == "stale" and st.json()["meta"]["suppressed"] == {}


async def test_lookup_found_and_missing(client_as, world):
    w, _ = world
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/intent/lookup", params={"terms": [w.fresh, w.missing, w.fresh], "country": "us"})
        too_many = await c.get("/v1/intent/lookup", params={"terms": [f"t{i}" for i in range(21)], "country": "us"})
    items = r.json()["data"]["items"]
    assert [i["term"] for i in items] == [w.fresh, w.missing]          # 중복 term 은 한 번
    assert items[0]["status"] == "found" and items[0]["search_volume"] == 900 and items[0]["intent"] == "commercial"
    assert len(items[0]["related"]) == 2 and items[0]["total_count"] == 1234
    assert items[1] == {"term": w.missing, "status": "missing", "search_volume": None, "intent": None, "related": [], "total_count": None}
    assert r.json()["meta"]["source"]["missing_terms"] == 1 and r.json()["meta"]["suppressed"] == {}
    assert too_many.status_code == 422
    # intent R4: 찾은 term 이 모두 7일 안이면 fresh(예전 unknown), 하나라도 8일 전이면 stale, 찾은 term 이 없으면 missing
    src = r.json()["meta"]["source"]
    assert (src["freshness"], src["stale_terms"], src["ttl"]) == ("fresh", 0, "7d")
    async with client_as(ADMIN) as c:
        mixed = await c.get("/v1/intent/lookup", params={"terms": [w.fresh, w.stale], "country": "us"})
        none = await c.get("/v1/intent/lookup", params={"terms": [w.missing], "country": "us"})
    assert [i["search_volume"] for i in mixed.json()["data"]["items"]] == [900, 70]
    assert (mixed.json()["meta"]["source"]["freshness"], mixed.json()["meta"]["source"]["stale_terms"]) == ("stale", 1)
    assert none.json()["meta"]["source"]["freshness"] == "missing" and none.json()["meta"]["suppressed"] == {"*": "source_pending"}


async def test_common_filters_are_reported_not_silently_ignored(client_as, world):
    w, _ = world
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "us", "brand": "Hyundai", "engine": "chatgpt",
                                                      "from": "2026-09-01", "to": "2026-09-10", "surface": "global", "cf.x": "1"})
        base = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "us"})
    assert r.status_code == 200
    assert r.json()["meta"]["ignored_filters"] == ["brand", "custom", "engine", "period", "surface"]
    assert r.json()["data"] == base.json()["data"]           # 무시된 축은 값에 영향 없음
    assert base.json()["meta"]["ignored_filters"] == []


# ── 검증 D3: 메뉴 그룹 게이트(project_id 없음 = standard, 있음 = project) ──
async def test_menu_gate_regression_d3(client_as, world):
    w, pr = world
    web = fx.temp_user("hq", "none", ("Hyundai",), ("website",))       # 검증 재현 계정
    std = fx.temp_user("hq", "none", ("Hyundai",), ("standard",))
    prj = fx.temp_user("hq", "none", ("Hyundai",), ("project",))
    ven = fx.temp_user("vendor", "none", (), None)                        # 메뉴 무제한 vendor → 역할 게이트
    await fx.create_users([web, std, prj, ven])
    try:
        async with client_as(web.uid) as c:
            for path, country in (("/v1/intent/insight", "us"), ("/v1/intent/related", "kr"), ("/v1/intent/lookup", "us")):
                prm = {"terms": [w.fresh]} if path.endswith("lookup") else {"term": w.fresh}
                r = await c.get(path, params={**prm, "country": country})
                assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden", (path, r.text)
            r = await c.get("/v1/intent/insight", params={"term": w.fresh, "project_id": str(pr.own)})
            assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
        async with client_as(std.uid) as c:
            assert (await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "us"})).status_code == 200
            r = await c.get("/v1/intent/insight", params={"term": w.fresh, "project_id": str(pr.own)})
            assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
        async with client_as(prj.uid) as c:
            r = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "us"})
            assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
            # 스코프 안 비멤버 프로젝트(Hyundai US), 국가 생략 = 프로젝트 국가 → 프로젝트 권한으로 200
            assert (await c.get("/v1/intent/insight", params={"term": w.fresh, "project_id": str(pr.own)})).status_code == 200
        async with client_as(ven.uid) as c:
            r = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "us"})
            assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    finally:
        await fx.drop_users([web, std, prj, ven])


# ── 검증 D5: project_id 경로의 국가는 프로젝트 국가·추적 키워드 국가로 묶인다(밖이면 표준 화면 규칙) ──
async def test_project_country_binding_regression_d5(client_as, world):
    w, _ = world
    kia_us = await fx.create_project("Kia", "US")                               # KIA_US 스코프 안 비멤버
    ven_prj = await fx.create_project("Hyundai", "US", member=(VENDOR, "viewer"))
    try:
        async with client_as(KIA_US) as c:
            assert (await c.get("/v1/intent/insight", params={"term": w.fresh, "project_id": str(kia_us)})).status_code == 200
            r = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "kr", "project_id": str(kia_us)})
            assert r.status_code == 403 and r.json()["error"]["code"] == "country_forbidden"
        async with client_as(VENDOR) as c:
            r = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "kr", "project_id": str(ven_prj)})
            assert r.status_code == 403
            await fx.add_tracked(ven_prj, w.fresh, "kr")                          # 프로젝트가 kr 키워드를 추적하면 프로젝트 권한으로 허용
            ok = await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "kr", "project_id": str(ven_prj)})
            assert ok.status_code == 200 and [x["search_volume"] for x in ok.json()["data"]["trend"]] == [w.kr_volume]
            r = await c.get("/v1/intent/related", params={"term": w.fresh, "country": "de", "project_id": str(ven_prj)})
            assert r.status_code == 403
    finally:
        await fx.drop_project_ids([kia_us, ven_prj])
