"""intent.keywords.tracked 테스트: 목록(최신 월 검색량 손계산)·추가(409·422)·삭제(IDOR 0건)·권한·롤백."""
from __future__ import annotations

import uuid

import pytest_asyncio

from app.features.intent.keywords.research.tests import intent_fixtures as fx
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, VENDOR, WEBSITE_KIA, Update, needs_db, staged

pytestmark = needs_db
URL = "/v1/intent/keywords"


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def world(seeded):
    w = await fx.build_kw_world("tracked")
    pr = await fx.create_projects()
    yield w, pr
    await fx.drop_projects(pr)
    await fx.cleanup_drafts([w.serp_new, w.serp_old, w.serp_stale])


async def _rows(pid: uuid.UUID) -> list[tuple]:
    c = await fx.su()
    try:
        return [tuple(r) for r in await c.fetch("SELECT term, country_code FROM app.project_tracked_keyword WHERE project_id = $1 "
                                                "ORDER BY created_at, keyword_id", pid)]
    finally:
        await c.close()


async def test_add_list_delete_flow(client_as, world):
    """빈 목록에서 시작해야 하므로 이 테스트만 쓰는 프로젝트(Hyundai US, HQ_HYUNDAI owner)를 만든다(다른 테스트가 공용 프로젝트에
    남긴 행과 순서 무관)."""
    w, _ = world
    own = await fx.create_project("Hyundai", "US", member=(HQ_HYUNDAI, "owner"))
    pid = str(own)
    try:
        async with client_as(HQ_HYUNDAI) as c:                    # 배정 운영자 + 활성 멤버(owner) = 운영 가능
            empty = await c.get(URL, params={"project_id": pid})
            assert empty.status_code == 200 and empty.json()["data"]["items"] == []
            a = await c.post(URL, params={"project_id": pid}, json={"term": f"  {w.fresh}  "})
            b = await c.post(URL, params={"project_id": pid}, json={"term": w.fresh, "country": "KR"})
            m = await c.post(URL, params={"project_id": pid}, json={"term": w.missing})
            assert (a.status_code, b.status_code, m.status_code) == (201, 201, 201), (a.text, b.text)
            assert a.json()["data"]["term"] == w.fresh and a.json()["data"]["country_code"] is None and a.json()["data"]["country"] == "us"
            assert b.json()["data"]["country_code"] == "KR"                # 저장 = 프로젝트 국가와 같은 ISO 대문자(검증 m-4, CHECK ptk_country_upper)
            lst = (await c.get(URL, params={"project_id": pid})).json()["data"]["items"]
        # 최신 월 검색량: US(프로젝트 국가) = 100 + 13, KR = 777, 미수집 = null
        assert [(i["term"], i["country"], i["latest_volume"]) for i in lst] == [(w.fresh, "us", 113), (w.fresh, "kr", w.kr_volume),
                                                                                 (w.missing, "us", None)]
        assert lst[0]["latest_month"] == w.months[-1].isoformat()
        ids = [i["keyword_id"] for i in lst]
        async with client_as(HQ_HYUNDAI) as c:
            d = await c.request("DELETE", URL, params={"project_id": pid, "ids": ids[:2]})
        assert d.status_code == 200 and d.json()["data"]["removed_count"] == 2
        assert await _rows(own) == [(w.missing, None)]
    finally:
        await fx.drop_project_ids([own])


async def test_duplicate_and_invalid(client_as, world):
    w, pr = world
    pid = str(pr.own)
    async with client_as(HQ_HYUNDAI) as c:
        first = await c.post(URL, params={"project_id": pid}, json={"term": fx.uniq("dup"), "country": "de"})
        before = await _rows(pr.own)
        dup = await c.post(URL, params={"project_id": pid}, json={"term": fx.uniq("dup") + " ", "country": "DE"})
        bad_c = await c.post(URL, params={"project_id": pid}, json={"term": "x", "country": "zz"})
        blank = await c.post(URL, params={"project_id": pid}, json={"term": "   "})
        extra = await c.post(URL, params={"project_id": pid}, json={"term": "x", "surprise": 1})
        no_pid = await c.post(URL, json={"term": "x"})
        many = await c.request("DELETE", URL, params={"project_id": pid, "ids": [str(uuid.uuid4()) for _ in range(101)]})
    assert first.status_code == 201
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "duplicate_keyword"
    assert await _rows(pr.own) == before                          # 409 는 쓰기 없음(롤백)
    assert bad_c.json()["error"]["code"] == "unknown_country" and bad_c.status_code == 422
    assert blank.status_code == 422 and extra.status_code == 422 and no_pid.status_code == 422 and many.status_code == 422


async def test_delete_other_project_rows_is_noop(client_as, world):
    """다른 프로젝트 행 id 를 내 프로젝트로 지우면 0건(project_id 조건)."""
    w, pr = world
    term = fx.uniq("kia term")                                    # 고유 term: 다른 테스트 행과 섞이지 않게 자기 행만 단언
    c0 = await fx.su()
    try:
        other_id = await c0.fetchval("INSERT INTO app.project_tracked_keyword (project_id, term) VALUES ($1, $2) "
                                     "RETURNING keyword_id", pr.other, term)
    finally:
        await c0.close()
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.request("DELETE", URL, params={"project_id": str(pr.own), "ids": [str(other_id)]})
        r2 = await c.request("DELETE", URL, params={"project_id": str(pr.other), "ids": [str(other_id)]})
    assert r.status_code == 200 and r.json()["data"]["removed_count"] == 0
    assert r2.status_code == 404                                  # Kia 프로젝트는 HQ_HYUNDAI 에게 안 보인다
    assert (term, None) in await _rows(pr.other)
    async with client_as(ADMIN) as c:                              # admin 은 운영 가능
        r3 = await c.request("DELETE", URL, params={"project_id": str(pr.other), "ids": [str(other_id)]})
    assert r3.json()["data"]["removed_count"] == 1


async def test_permissions(client_as, world):
    _, pr = world
    async with client_as(VENDOR) as c:     # 고객 프로젝트 viewer: 목록 가능, 추가 불가(operator none)
        assert (await c.get(URL, params={"project_id": str(CUST_PROJECT)})).status_code == 200
        r = await c.post(URL, params={"project_id": str(CUST_PROJECT)}, json={"term": "x"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "operator_forbidden"
        assert (await c.get(URL, params={"project_id": str(pr.own)})).status_code == 404
    async with client_as(KIA_US) as c:
        assert (await c.get(URL, params={"project_id": str(pr.own)})).status_code == 404
        assert (await c.post(URL, params={"project_id": str(pr.own)}, json={"term": "x"})).status_code == 404
    async with client_as(HQ_HYUNDAI) as c:  # 스코프 안이지만 비멤버 → 열람 가능, 운영 불가
        assert (await c.get(URL, params={"project_id": str(CUST_PROJECT)})).status_code == 200
        assert (await c.post(URL, params={"project_id": str(CUST_PROJECT)}, json={"term": "x"})).status_code == 403
    async with client_as(None) as c:
        assert (await c.get(URL, params={"project_id": str(pr.own)})).status_code == 401
    async with client_as(ADMIN) as c:
        assert (await c.get(URL, params={"project_id": str(uuid.uuid4())})).status_code == 404


# ── 검증 D6: 중복 = 같은 프로젝트의 term_norm·유효 국가가 같은 행(대소문자·국가 생략 = 프로젝트 국가) ──
async def test_duplicate_by_norm_and_effective_country_d6(client_as, world):
    _, pr = world
    pid = str(pr.own)                                              # 프로젝트 국가 US
    a, c_ = fx.uniq("d6 alpha"), fx.uniq("d6 charlie")
    async with client_as(HQ_HYUNDAI) as c:
        first = await c.post(URL, params={"project_id": pid}, json={"term": a, "country": "kr"})
        upper = await c.post(URL, params={"project_id": pid}, json={"term": a.upper(), "country": "KR"})
        plain = await c.post(URL, params={"project_id": pid}, json={"term": c_})
        same_country = await c.post(URL, params={"project_id": pid}, json={"term": c_, "country": "us"})
        explicit = await c.post(URL, params={"project_id": pid}, json={"term": fx.uniq("d6 delta"), "country": "US"})
        after_explicit = await c.post(URL, params={"project_id": pid}, json={"term": fx.uniq("d6 delta")})
        other_country = await c.post(URL, params={"project_id": pid}, json={"term": a, "country": "de"})
        lst = (await c.get(URL, params={"project_id": pid})).json()["data"]["items"]
    assert first.status_code == 201 and other_country.status_code == 201 and plain.status_code == 201
    for r in (upper, same_country, after_explicit):
        assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_keyword", r.text
    assert explicit.status_code == 201 and explicit.json()["data"]["country_code"] is None     # 프로젝트 국가와 같으면 NULL 저장
    keys = [(fx.norm(i["term"]), i["country"]) for i in lst]
    assert len(keys) == len(set(keys))


async def test_website_role_blocked_on_project_paths_m7(client_as, world):
    """검증 m-7: website 역할(메뉴 NULL = 무제한, 스코프 Kia)이 Kia 프로젝트 project_id 로 프로젝트 화면 intent 경로를 읽으면 안 된다.
    project 표면 역할 천장 = front route-policy PROJECT_VIEWERS(hq·region·country·admin·vendor, website 제외) → 403 role_forbidden."""
    _, pr = world
    async with staged(Update("app.user_account", {"user_id": WEBSITE_KIA}, {"menu_groups": None}), actor=ADMIN), client_as(WEBSITE_KIA) as c:
        for path in (URL, "/v1/intent/social/prompts"):
            r = await c.get(path, params={"project_id": str(pr.other)})
            assert (r.status_code, r.json()["error"]["code"]) == (403, "role_forbidden"), (path, r.text)
        r = await c.get("/v1/intent/insight", params={"project_id": str(pr.other), "term": "x"})
        assert (r.status_code, r.json()["error"]["code"]) == (403, "role_forbidden"), r.text
    async with client_as(KIA_US) as c:                          # 대조: country 역할은 표면 통과(프로젝트 스코프 판정으로 넘어간다)
        r = await c.get(URL, params={"project_id": str(pr.other)})
    assert r.json()["error"]["code"] != "role_forbidden"
