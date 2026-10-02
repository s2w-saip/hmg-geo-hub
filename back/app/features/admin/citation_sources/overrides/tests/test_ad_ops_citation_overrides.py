"""admin.citation_sources.overrides 통합 테스트(로컬 개발 DB, 합성 픽스처).

손 계산 기대값(tests/fixtures/fixture-10-data.sql): 글로벌 최신 노출 회차 = 11(2026-09-14). 그 회차의 cit_in 인용 중 호스트 있는 것
(source_key <> 0)을 도메인별로 세면 reddit.com 2, caranddriver.com·example.org·foo-bar.xyz·hyundai.com·hyundaiusa.com·kia.com·
linkedin.com 각 1. bmwusa.com 은 cit_in 거짓이라 빠진다. 웹사이트 회차 21 은 인용 숨김(hidden_scope 2)이라 인용 계열 키가 없다.
오버라이드 시드 = example.org → newsMedia(5), dim_source 도 category_src 1(override)로 반영돼 있다.
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest_asyncio

from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db

BASE = "/v1/admin/citation-overrides"
EXPECTED_GLOBAL = {"reddit.com": 2, "caranddriver.com": 1, "example.org": 1, "foo-bar.xyz": 1, "hyundai.com": 1,
                   "hyundaiusa.com": 1, "kia.com": 1, "linkedin.com": 1}


@pytest_asyncio.fixture(loop_scope="session")
async def owner(seeded):
    c = await asyncpg.connect(DB_URL)
    yield c
    await c.close()


@pytest_asyncio.fixture(loop_scope="session")
async def domain(owner):
    """테스트 전용 도메인(재실행해도 대기 요청과 겹치지 않게 매번 새로). 끝나면 원본·요청 행을 소유자 접속으로 지운다."""
    d = f"t-{uuid.uuid4().hex[:12]}.example"
    yield d
    await owner.execute("DELETE FROM app.citation_domain_override WHERE domain = $1", d)
    await owner.execute("DELETE FROM app.judgment_change WHERE kind = 'citation_override' AND subject_texts = ARRAY[$1]::text[]", d)


async def test_auth_gates(client_as, domain):
    async with client_as(None) as c:
        assert (await c.get(BASE)).status_code == 401
        assert (await c.put(f"{BASE}/{domain}", json={"category_key": 5})).status_code == 401
    for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
        async with client_as(uid) as c:
            for r in (await c.get(BASE), await c.get(f"{BASE}/categories"),
                      await c.get(f"{BASE}/candidates", params={"surface": "global"}),
                      await c.put(f"{BASE}/{domain}", json={"category_key": 5}), await c.delete(f"{BASE}/example.org")):
                assert r.status_code == 403, (uid, r.text)
                assert "example.org" not in r.text                        # 스코프 밖 누출 0


async def test_categories_and_list(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(f"{BASE}/categories")
        assert r.status_code == 200
        items = r.json()["data"]["items"]
        assert len(items) == 13 and items[0] == {"key": 1, "name": "Official (HMG)", "slug": "officialHmg", "ord": 1}
        assert [i["ord"] for i in items] == sorted(i["ord"] for i in items)
        r = await c.get(BASE, params={"brand": "Kia"})
        assert r.status_code == 200 and r.json()["meta"]["ignored_filters"] == ["brand"]
        ov = {i["domain"]: i for i in r.json()["data"]["items"]}
        assert ov["example.org"]["category"]["slug"] == "newsMedia" and ov["example.org"]["note"] == "test override"


async def test_candidates_default_window(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(f"{BASE}/candidates", params={"surface": "global"})
        assert r.status_code == 200, r.text
        b = r.json()
        got = {i["domain"]: i["citations"] for i in b["data"]["items"] if i["citations"] > 0}
        assert got == EXPECTED_GLOBAL
        items = b["data"]["items"]
        assert items[0]["domain"] == "reddit.com"                                    # 인용 수 DESC
        assert [i["domain"] for i in items[1:len(EXPECTED_GLOBAL)]] == sorted(d for d in EXPECTED_GLOBAL if d != "reddit.com")
        by = {i["domain"]: i for i in items}
        assert by["example.org"]["source"] == "override" and by["example.org"]["override"]["propagated"] is True
        assert by["linkedin.com"]["source"] == "social" and by["hyundai.com"]["source"] == "owned"
        assert by["caranddriver.com"]["source"] == "seed" and by["foo-bar.xyz"]["source"] == "fallback"
        assert "bmwusa.com" not in by                                                # cit_in 거짓
        m = b["meta"]
        assert m["cycles"] == ["2026-09-14"] and m["source"]["default_window"] is True and m["source"]["pool"] == "api_ro"
        assert "cyc_key" not in r.text


async def test_candidates_limit_keeps_overrides_and_source_filter(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(f"{BASE}/candidates", params={"surface": "global", "limit": 1})
        doms = [i["domain"] for i in r.json()["data"]["items"]]
        assert doms[0] == "reddit.com" and "example.org" in doms and len(doms) == 2   # 상위 1 + 오버라이드 도메인
        # 필터 전후 값 변화: 카테고리(source[]) automotiveMedia 만 → caranddriver.com 하나
        r = await c.get(f"{BASE}/candidates", params={"surface": "global", "source": "automotiveMedia"})
        assert [(i["domain"], i["citations"]) for i in r.json()["data"]["items"]] == [("caranddriver.com", 1)]
        # 알 수 없는 slug 만 → 빈 결과(fail-closed) + dropped_filters, 지원하지 않는 축 → ignored_filters
        r = await c.get(f"{BASE}/candidates", params={"surface": "global", "source": "nope", "country": "US", "engine": "gemini"})
        b = r.json()
        assert r.status_code == 200 and b["data"]["items"] == []
        assert b["meta"]["dropped_filters"] == {"source": ["nope"]} and b["meta"]["ignored_filters"] == ["country", "engine"]


async def test_candidates_range_and_hidden(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(f"{BASE}/candidates", params={"surface": "global", "from": "2026-09-01", "to": "2026-09-30"})
        b = r.json()
        assert r.status_code == 200 and b["meta"]["source"]["pool"] == "admin_long" and b["meta"]["mode"] == "cumulative"
        assert {i["domain"]: i["citations"] for i in b["data"]["items"] if i["citations"] > 0} == EXPECTED_GLOBAL
        # 빈 창(회차 없는 기간): 사실 표를 읽지 않고 오버라이드 도메인만 0건으로
        r = await c.get(f"{BASE}/candidates", params={"surface": "global", "from": "2025-01-01", "to": "2025-01-31"})
        assert [(i["domain"], i["citations"]) for i in r.json()["data"]["items"]] == [("example.org", 0)]
        # 웹사이트: 회차 21 인용 숨김 → 인용 0, 억제 사유 hidden
        r = await c.get(f"{BASE}/candidates", params={"surface": "website"})
        b = r.json()
        assert [(i["domain"], i["citations"]) for i in b["data"]["items"]] == [("example.org", 0)]
        assert b["meta"]["suppressed"] == {"citations": "hidden"}
        # 프로젝트 표면(회차 31): example.com 3(fallback), hyundaiusa.com 1
        r = await c.get(f"{BASE}/candidates", params={"surface": "project", "project_id": "c0000000-0000-4000-8000-000000000003"})
        got = {i["domain"]: i["citations"] for i in r.json()["data"]["items"] if i["citations"] > 0}
        assert got == {"example.com": 3, "hyundaiusa.com": 1}


async def test_candidates_invalid(client_as):
    async with client_as(ADMIN) as c:
        for params in ({}, {"surface": "nope"}, {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"},
                       {"surface": "global", "from": "2026-09-30", "to": "2026-09-01"}, {"surface": "global", "limit": 0},
                       {"surface": "global", "limit": 5001}, {"surface": "project"}):
            r = await c.get(f"{BASE}/candidates", params=params)
            assert r.status_code == 422, params
        r = await c.get(f"{BASE}/candidates", params={"surface": "global", "from": "2025-01-01", "to": "2026-09-30"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "window_too_large"


async def test_put_delete_roundtrip(client_as, owner, domain):
    async with client_as(ADMIN) as c:
        r = await c.put(f"{BASE}/www.{domain.upper()}", json={"category": "automotiveMedia", "note": " 첫 교정 "})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["domain"] == domain and d["category"]["key"] == 4 and d["note"] == "첫 교정" and d["propagation"] == "pending"
        assert d["updated_by"] == str(ADMIN)
        row = await owner.fetchrow("SELECT kind, status, subject_texts, payload::text AS pl, requested_by FROM app.judgment_change "
                                   "WHERE change_id = $1", d["change_id"])
        assert row["kind"] == "citation_override" and row["status"] == "pending" and row["subject_texts"] == [domain]
        assert row["requested_by"] == ADMIN and '"op": "set"' in row["pl"] and '"old": null' in row["pl"]
        # 같은 도메인 대기 요청이 있으면 409 duplicate_pending, 원본은 롤백(첫 값 유지)
        r = await c.put(f"{BASE}/{domain}", json={"category_key": 6, "note": "둘째"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_pending"
        assert await owner.fetchval("SELECT note FROM app.citation_domain_override WHERE domain = $1", domain) == "첫 교정"
        # 노트만 바꾸면 판정 입력이 아니라 요청 없이 반영(propagation none)
        r = await c.put(f"{BASE}/{domain}", json={"category_key": 4, "note": "노트만"})
        assert r.status_code == 200 and r.json()["data"]["change_id"] is None and r.json()["data"]["propagation"] == "none"
        # 목록 맨 앞(updated_at DESC)
        r = await c.get(BASE, params={"limit": 1})
        b = r.json()
        assert b["data"]["items"][0]["domain"] == domain and b["meta"]["page"]["next_cursor"]
        r2 = await c.get(BASE, params={"limit": 1, "cursor": b["meta"]["page"]["next_cursor"]})
        assert r2.status_code == 200 and r2.json()["data"]["items"][0]["domain"] != domain
        # 후보에 0건 오버라이드로 보인다(아직 dim_source 미반영 → propagated 거짓)
        r = await c.get(f"{BASE}/candidates", params={"surface": "global"})
        cand = {i["domain"]: i for i in r.json()["data"]["items"]}[domain]
        assert cand["citations"] == 0 and cand["in_dim_source"] is False and cand["override"]["propagated"] is False
        # 적재기가 반영했다고 가정하고 삭제(대기 요청이 남아 있으면 삭제도 409)
        r = await c.delete(f"{BASE}/{domain}")
        assert r.status_code == 409 and await owner.fetchval(
            "SELECT count(*) FROM app.citation_domain_override WHERE domain = $1", domain) == 1
        await owner.execute("UPDATE app.judgment_change SET status = 'applied' WHERE kind = 'citation_override' "
                            "AND subject_texts = ARRAY[$1]::text[]", domain)
        r = await c.delete(f"{BASE}/{domain}")
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d == {"domain": domain, "reverted": True, "change_id": d["change_id"], "propagation": "pending"}
        pl = await owner.fetchval("SELECT payload->>'op' FROM app.judgment_change WHERE change_id = $1", d["change_id"])
        assert pl == "clear"
        assert (await c.delete(f"{BASE}/{domain}")).status_code == 404


async def test_put_invalid(client_as, owner, domain):
    async with client_as(ADMIN) as c:
        for path, body in ((domain, {"category_key": 99}), (domain, {"category": "nope"}), (domain, {}),
                           (domain, {"category_key": 4, "category": "automotiveMedia"}), (domain, {"category_key": 4, "note": "x" * 501}),
                           ("localhost", {"category_key": 4}), ("a b.com", {"category_key": 4}), (domain, {"category_key": 4, "x": 1})):
            r = await c.put(f"{BASE}/{path}", json=body)
            assert r.status_code == 422, (path, body, r.text)
        assert await owner.fetchval("SELECT count(*) FROM app.citation_domain_override WHERE domain = $1", domain) == 0
        assert await owner.fetchval("SELECT count(*) FROM app.judgment_change WHERE subject_texts = ARRAY[$1]::text[]", domain) == 0


async def test_d3_candidates_surface_ignored_custom_and_project_id(client_as):
    """검증 D3 회귀: cf.*(custom)·global 표면의 project_id 가 조용히 무시되지 않고 meta.ignored_filters 에 드러난다(값은 그대로)."""
    cf = f"cf.{uuid.uuid4()}"
    pid = "c0000000-0000-4000-8000-000000000003"
    async with client_as(ADMIN) as c:
        base = (await c.get(f"{BASE}/candidates", params={"surface": "project", "project_id": pid})).json()
        r = await c.get(f"{BASE}/candidates", params={"surface": "project", "project_id": pid, cf: "x"})
        assert r.status_code == 200 and r.json()["meta"]["ignored_filters"] == ["custom"]
        assert r.json()["data"] == base["data"]
        g0 = (await c.get(f"{BASE}/candidates", params={"surface": "global"})).json()
        r = await c.get(f"{BASE}/candidates", params={"surface": "global", "project_id": str(uuid.uuid4())})
        assert r.status_code == 200 and r.json()["meta"]["ignored_filters"] == ["project_id"]
        assert r.json()["data"] == g0["data"]
        r = await c.get(f"{BASE}/candidates", params={"surface": "global", "project_id": pid, cf: "x", "country": "US"})
        assert r.json()["meta"]["ignored_filters"] == ["country", "custom", "project_id"]
        # 형식이 틀린 cf 키는 422(core parse_custom_fields)
        assert (await c.get(f"{BASE}/candidates", params={"surface": "global", "cf.nope": "x"})).status_code == 422


async def test_v1_admin_menu_only_candidates_global(client_as):
    """4라운드 검증 V1 회귀: role admin · menu_groups {admin}(표준 메뉴 없음) 계정이 surface=global 후보를 부르면 200(예전 403 menu_forbidden).
    관리 기능이라 표면 경로 게이트를 걸지 않는다(resolve_read_context(surface_gate=False)). 값은 무제한 admin 과 같다(데이터 스코프 그대로).
    표준 메뉴 없는 계정이 분석 표면에서 여전히 막히는지는 core 테스트(test_v1_surface_gate_skip_for_admin_features)가 본다."""
    from tests.support import Sql, Update, staged

    async with client_as(ADMIN) as c:
        base = (await c.get(f"{BASE}/candidates", params={"surface": "global"})).json()
    actor = Sql("SELECT set_config('app.actor_id', $1, true)", (str(ADMIN),))          # 계정 쓰기 = 감사 트리거 행위자 필수(롤백 전용 준비)
    admin_menu_only = Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["admin"]})
    async with staged(actor, admin_menu_only), client_as(ADMIN) as c:
        for params in ({"surface": "global"}, {"surface": "website"},
                       {"surface": "project", "project_id": "c0000000-0000-4000-8000-000000000003"}):
            r = await c.get(f"{BASE}/candidates", params=params)
            assert r.status_code == 200, (params, r.text)
        r = await c.get(f"{BASE}/candidates", params={"surface": "global"})
        assert r.json()["data"] == base["data"]
        assert {i["domain"]: i["citations"] for i in r.json()["data"]["items"] if i["citations"] > 0} == EXPECTED_GLOBAL
        assert (await c.get(BASE)).status_code == 200                                         # 목록·카테고리도 관리 메뉴로 충분
        assert (await c.get(f"{BASE}/categories")).status_code == 200
