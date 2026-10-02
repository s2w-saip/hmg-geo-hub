"""GET /v1/citations/domains (C-1) 통합 테스트. 기대값 근거는 helpers.py 머리 주석(픽스처 손 계산)과 독립 SQL."""
from __future__ import annotations

import pytest

from app.core.auth import load_principal
from app.core.db import fetch_all
from app.core.filters import CommonFilters, resolve_read_context
from app.core.measure import fetch_counts
from app.features.analytics.citations.domains import queries as q
from app.features.analytics.citations.domains.shared import CITATION_SUPPORT
from app.features.analytics.citations.domains.tests.helpers import website_window
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

URL = "/v1/citations/domains"
G = {"surface": "global"}
P = {"surface": "project", "project_id": str(CUST_PROJECT)}


async def _get(client_as, uid, params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


@needs_db
async def test_global_shape_and_values_admin(client_as):
    r = await _get(client_as, ADMIN, G)
    assert r.status_code == 200, r.text
    body = r.json()
    d, m = body["data"], body["meta"]
    assert d["summary"] == {"total_citations": 9, "unique_sources": 8, "own_share": {"num": 3, "den": 9}, "answers_den": 5}
    assert m["surface"] == "global" and m["mode"] == "snapshot" and m["cycles"] == ["2026-09-14"] and m["suppressed"] == {}
    assert m["page"] == {"next_cursor": None, "limit": 50, "total": 8}
    items = d["items"]
    assert [i["skey"] for i in items] == ["reddit.com", "caranddriver.com", "example.org", "foo-bar.xyz", "hyundai.com", "hyundaiusa.com",
                                          "kia.com", "linkedin.com/hyundai-motor-group"]
    by = {i["skey"]: i for i in items}
    assert by["reddit.com"]["citations"] == 2 and by["reddit.com"]["share"] == {"num": 2, "den": 9}
    assert by["reddit.com"]["citing_answers"] == 1 and by["reddit.com"]["coverage"] == {"num": 1, "den": 5}
    assert by["example.org"]["category"]["slug"] == "newsMedia"                          # 운영자 오버라이드 반영
    assert by["linkedin.com/hyundai-motor-group"]["is_social"] is True
    assert by["linkedin.com/hyundai-motor-group"]["category"]["slug"] == "officialHmg"
    # 관점 = 3사 전체(admin): 자사 = 허용 배열(owner_key) 안 → hyundai.com(AU base)·hyundaiusa.com(US 루트)·kia.com(worldwide base)
    assert {k for k, i in by.items() if i["is_own"]} == {"hyundai.com", "hyundaiusa.com", "kia.com"}
    assert all(not i["is_target"] for i in items)                                      # 글로벌엔 타겟 판정이 없다
    assert d["competitor_totals"] == []
    assert "cyc_key" not in r.text and "source_key" not in r.text                        # 내부 정수 키 비노출


@needs_db
async def test_viewpoint_own_is_brand_scoped(client_as):
    """QUERY-FIXES C-1: 현대 관점에서 kia.com 인용은 자사가 아니다(관점 밖 HMG 브랜드)."""
    d = (await _get(client_as, HQ_HYUNDAI, G)).json()["data"]
    assert d["summary"]["own_share"] == {"num": 2, "den": 9}
    by = {i["skey"]: i for i in d["items"]}
    assert by["kia.com"]["is_own"] is False and by["hyundai.com"]["is_own"] is True and by["hyundaiusa.com"]["own_citations"] == 1


@needs_db
async def test_own_share_equals_kpi_m05(ro):
    """산식 단일화(모듈-인용 §7): /domains summary.own_share = core M05(rd.answer cit_* 열) 정수 쌍."""
    for uid in (ADMIN, HQ_HYUNDAI):
        p = await load_principal(ro, uid)
        ctx = await resolve_read_context(ro, p, CommonFilters(surface="global"), support=CITATION_SUPPORT)
        win = await ctx.window(ro)
        row = (await fetch_counts(ro, ctx.measure(), win, parts=("citations",)))[0]
        s = q.domains_sql(ctx, win, limit=0, cursor=None, mention_brand_key=None)
        summ = (await fetch_all(ro, s.text, s.params))[0]["summary"]
        assert (int(summ["own"]), int(summ["citations"])) == (row["cit_owned"], row["cit_total"]), uid


@needs_db
async def test_scope_no_leak_kia_us(client_as):
    """기아 US 계정: 글로벌 모수 bgrp 가 기아·엄브렐러 비트만 → 현대·제네시스 카탈로그 답변(k1 bgrp 5) 인용 0."""
    d = (await _get(client_as, KIA_US, G)).json()["data"]
    assert d["summary"]["total_citations"] == 0 and d["items"] == []


@needs_db
async def test_auth_required_and_suspended(client_as):
    assert (await _get(client_as, None, G)).status_code == 401
    r = await _get(client_as, SUSPENDED, G)
    assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"


@needs_db
async def test_project_surface_and_membership(client_as):
    r = await _get(client_as, VENDOR, P)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["summary"] == {"total_citations": 4, "unique_sources": 2, "own_share": {"num": 3, "den": 4}, "answers_den": 1}
    by = {i["skey"]: i for i in d["items"]}
    assert by["example.com"]["own_citations"] == 2 and by["example.com"]["is_target"] is True     # 프로젝트 자사 = loc_owned
    assert by["hyundaiusa.com"]["own_citations"] == 1 and by["hyundaiusa.com"]["is_target"] is False
    assert (await _get(client_as, HQ_HYUNDAI, P)).status_code == 200                               # 비멤버지만 스코프 안
    r = await _get(client_as, KIA_US, P)                                                           # 스코프 밖 = 404(존재 은폐)
    assert r.status_code == 404
    r = await _get(client_as, ADMIN, {"surface": "project"})
    assert r.status_code == 422


@needs_db
async def test_filters_change_values(client_as):
    base = (await _get(client_as, ADMIN, G)).json()["data"]["summary"]
    gem = (await _get(client_as, ADMIN, {**G, "engine": "gemini"})).json()
    assert gem["data"]["summary"]["total_citations"] == 0 and gem["data"]["summary"]["answers_den"] == 1   # k2 만
    kr = (await _get(client_as, ADMIN, {**G, "country": "KR"})).json()["data"]["summary"]
    assert kr["total_citations"] == 0 and kr["answers_den"] == 1                                            # k4 만
    src = (await _get(client_as, ADMIN, {**G, "source": "communityForums"})).json()["data"]
    assert src["summary"]["total_citations"] == 2 and src["summary"]["unique_sources"] == 1
    assert src["summary"]["answers_den"] == base["answers_den"]                                             # source[] 는 분모 축 아님
    f2 = (await _get(client_as, ADMIN, {**G, "funnel": "F2"})).json()["data"]["summary"]                    # 'best suv' 는 F1
    assert f2["total_citations"] == 0
    f1 = (await _get(client_as, ADMIN, {**G, "funnel": "F1"})).json()["data"]["summary"]
    assert f1["total_citations"] == 9
    period = (await _get(client_as, ADMIN, {**G, "from": "2026-09-01", "to": "2026-09-30"})).json()
    assert period["meta"]["mode"] == "cumulative" and period["data"]["summary"]["total_citations"] == 9     # 회차 10 인용 없음


@needs_db
async def test_mention_brand(client_as):
    toyota = (await _get(client_as, ADMIN, {**G, "mention_brand": "toyota"})).json()["data"]["summary"]
    assert toyota["total_citations"] == 9 and toyota["answers_den"] == 1                                    # k1 만 Toyota 언급(std_in)
    kia = (await _get(client_as, ADMIN, {**G, "mention_brand": "Kia"})).json()["data"]["summary"]
    assert kia["total_citations"] == 0 and kia["answers_den"] == 1                                          # k2(인용 없음)
    r = (await _get(client_as, ADMIN, {**G, "mention_brand": "NoSuchBrand"})).json()
    assert r["data"]["summary"]["total_citations"] == 0 and r["meta"]["dropped_filters"] == {"mention_brand": ["NoSuchBrand"]}


@needs_db
async def test_pagination_keyset(client_as):
    seen, cursor, pages = [], None, 0
    while True:
        params = {**G, "limit": 3} | ({"cursor": cursor} if cursor else {})
        r = (await _get(client_as, ADMIN, params)).json()
        seen += [i["skey"] for i in r["data"]["items"]]
        assert r["meta"]["page"]["total"] == 8
        cursor = r["meta"]["page"]["next_cursor"]
        pages += 1
        if not cursor:
            break
    full = [i["skey"] for i in (await _get(client_as, ADMIN, G)).json()["data"]["items"]]
    assert seen == full and pages == 3
    first = (await _get(client_as, ADMIN, {**G, "limit": 3})).json()["meta"]["page"]["next_cursor"]
    r = await _get(client_as, ADMIN, {**G, "limit": 3, "engine": "gemini", "cursor": first})               # 다른 필터로 재사용
    assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
    r = await _get(client_as, ADMIN, {**G, "limit": 3, "cursor": "not-a-cursor"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"


@needs_db
async def test_limit_zero_summary_only(client_as):
    d = (await _get(client_as, ADMIN, {**G, "limit": 0})).json()
    assert d["data"]["items"] == [] and d["data"]["summary"]["total_citations"] == 9 and d["meta"]["page"]["next_cursor"] is None


@pytest.mark.parametrize("params", [{"surface": "nope"}, {"surface": "global", "limit": -1}, {"surface": "global", "limit": 201},
                                    {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"}, {"surface": "global", "from": "2026-09-30", "to": "2026-09-01"},
                                    {"surface": "global", "cf.bad": "x"}])
@needs_db
async def test_invalid_params_422(client_as, params):
    r = await _get(client_as, ADMIN, params)
    assert r.status_code == 422, (params, r.text)


@needs_db
async def test_website_hidden(client_as):
    """회차 21 은 인용 숨김(hidden_scope 2, Q18 인용 계열 배제 {1,2}) → 응답 전체 억제. 현대 계정은 웹사이트 메뉴 밖이라 403."""
    r = (await _get(client_as, KIA_EU, {"surface": "website", "funnel": "F1"})).json()
    assert r["meta"]["suppressed"] == {"*": "hidden"} and r["data"]["summary"]["total_citations"] == 0 and r["data"]["items"] == []
    assert r["meta"]["ignored_filters"] == ["funnel"]                                                        # 웹사이트 카탈로그 축 없음
    hq = await _get(client_as, HQ_HYUNDAI, {"surface": "website"})                                          # menu {standard, project}
    assert hq.status_code == 403 and hq.json()["error"]["code"] == "menu_forbidden"                          # D1 표면 게이트


@needs_db
async def test_website_sql_without_hidden(ro):
    """숨김만 뺀 창(build_window)으로 같은 빌더를 실행: kia.com 3 + kia.de 1, 웹사이트 자사 = loc_owned ∨ tgt_hit."""
    p = await load_principal(ro, KIA_EU)
    ctx = await resolve_read_context(ro, p, CommonFilters(surface="website"), support=CITATION_SUPPORT)
    win = website_window(ctx.project_keys)
    s = q.domains_sql(ctx, win, limit=50, cursor=None, mention_brand_key=None)
    r = (await fetch_all(ro, s.text, s.params))[0]
    assert (int(r["summary"]["citations"]), int(r["summary"]["own"]), int(r["summary"]["sources"])) == (4, 3, 2)
    by = {x["skey"]: x for x in r["rows"]}
    assert (by["kia.com"]["citations"], by["kia.com"]["own_citations"], by["kia.com"]["target_citations"]) == (3, 2, 2)
    assert (by["kia.de"]["own_citations"], by["kia.de"]["target_citations"]) == (1, 0)
    d = q.answers_den_sql(ctx, win, mention_brand_key=None)
    assert (await fetch_all(ro, d.text, d.params))[0]["answers"] == 2
    en = await resolve_read_context(ro, p, CommonFilters(surface="website", lang=["en"]), support=CITATION_SUPPORT)
    s2 = q.domains_sql(en, website_window(en.project_keys), limit=50, cursor=None, mention_brand_key=None)
    assert int((await fetch_all(ro, s2.text, s2.params))[0]["summary"]["citations"]) == 0                 # 사이트 답변 언어 = de


@needs_db
async def test_empty_period(client_as):
    r = (await _get(client_as, ADMIN, {**G, "from": "2025-01-01", "to": "2025-01-31"})).json()
    assert r["data"]["items"] == [] and r["data"]["summary"]["total_citations"] == 0 and r["meta"]["cycles"] == []


@needs_db
async def test_limit_cap_200(client_as):
    """D4 회귀: 모듈-인용 §2 PageIn limit 상한 200(0 은 요약 전용). 010dc5d 는 core MAX_LIMIT 500 을 써서 limit=500 이 200 이었다."""
    assert (await _get(client_as, ADMIN, {**G, "limit": 200})).status_code == 200
    for bad in (201, 500):
        r = await _get(client_as, ADMIN, {**G, "limit": bad})
        assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (bad, r.text)
        assert any(d["loc"][-1] == "limit" for d in r.json()["error"]["details"])


@pytest.mark.parametrize("value", ["a\x00b", "a\x1fb", "\x7f"])
@needs_db
async def test_mention_brand_control_chars_422(client_as, value):
    """D2 회귀: mention_brand 에 제어문자(NUL 등) → 010dc5d 는 DB 인코딩 오류 500. 이제 core 값 규칙과 같은 422."""
    r = await _get(client_as, ADMIN, {**G, "mention_brand": value})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", r.text
    assert any(d["loc"][-1] == "mention_brand" for d in r.json()["error"]["details"])
