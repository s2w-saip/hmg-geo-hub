"""GET /v1/citations/sources/tone (C-2 톤 드릴다운) 통합 테스트. 기대값 근거: domains/tests/helpers.py 머리 주석(픽스처 손 계산)."""
from __future__ import annotations

import hashlib

import pytest

from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, VENDOR, needs_db

URL = "/v1/citations/sources/tone"
G = {"surface": "global", "tone": "positive"}


async def _get(client_as, uid, params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


@needs_db
async def test_positive_url_rows(client_as):
    r = await _get(client_as, ADMIN, G)
    assert r.status_code == 200, r.text
    body = r.json()
    items = body["data"]["items"]
    assert len(items) == 9 and body["meta"]["page"]["total"] == 9 and body["meta"]["page"]["next_cursor"] is None
    by = {i["url"]: i for i in items}
    row = by["https://www.hyundai.com/au/en/cars/suv?utm_source=x"]
    assert row["display"] == "www.hyundai.com/au/en/cars/suv?utm_source=x"            # 표시 URL(스킴 제거)
    assert row["key"] == hashlib.sha256(row["url"].encode()).hexdigest()                 # 유일 식별자 = url_hash 16진(D5)
    assert row["skey"] == "hyundai.com" and row["category"]["slug"] == "officialHmg"
    assert row["engines"] == ["chatgpt"] and row["prompt_text"] == "best suv" and row["citations"] == 1
    assert by["https://example.org/x"]["category"]["slug"] == "newsMedia"             # 오버라이드 반영
    assert "https://not a url" not in by and not any(i["url"] == "not a url" for i in items)   # 호스트 없는 인용 제외


@needs_db
async def test_group_by_source_and_pagination(client_as):
    seen, cursor, pages = [], None, 0
    while True:
        params = {**G, "group_by": "source", "limit": 3} | ({"cursor": cursor} if cursor else {})
        r = (await _get(client_as, ADMIN, params)).json()
        assert r["meta"]["page"]["total"] == 8
        seen += [(i["key"], i["citations"]) for i in r["data"]["items"]]
        assert all(i["display"] == i["key"] == i["skey"] for i in r["data"]["items"])     # source 모드: key = display = skey
        cursor = r["meta"]["page"]["next_cursor"]
        pages += 1
        if not cursor:
            break
    assert pages == 3 and seen[0] == ("reddit.com", 2) and len({k for k, _ in seen}) == 8
    assert [k for k, _ in seen[1:]] == sorted(k for k, _ in seen[1:])                    # 동률 = skey 오름차순
    assert all(i[1] == 1 for i in seen[1:])
    first = (await _get(client_as, ADMIN, {**G, "group_by": "source", "limit": 3})).json()["meta"]["page"]["next_cursor"]
    r = await _get(client_as, ADMIN, {**G, "group_by": "url", "limit": 3, "cursor": first})    # 다른 group_by 에 재사용
    assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"


@needs_db
async def test_search_q(client_as):
    r = (await _get(client_as, ADMIN, {**G, "q": "reddit"})).json()
    assert sorted(i["url"] for i in r["data"]["items"]) == ["https://www.reddit.com/r/cars", "https://www.reddit.com/r/suv"]
    assert r["meta"]["page"]["total"] == 2
    # 표시 URL 은 스킴을 뺀 문자열이라 'https' 로는 걸리지 않는다(현행 citationDisplayUrlSql)
    assert (await _get(client_as, ADMIN, {**G, "q": "https"})).json()["data"]["items"] == []
    src = (await _get(client_as, ADMIN, {**G, "group_by": "source", "q": "LINKEDIN"})).json()["data"]["items"]   # ILIKE 대소문자 무시
    assert [i["skey"] for i in src] == ["linkedin.com/hyundai-motor-group"] and src[0]["url"] is None


@needs_db
async def test_negative_and_viewpoint(client_as):
    """픽스처에 부정 톤 답변이 없다: 부정 목록은 비고, 현대 관점 긍정 목록 = 관리자(3사) 긍정 목록(k1 은 현대 신호만)."""
    neg = (await _get(client_as, ADMIN, {**G, "tone": "negative"})).json()
    assert neg["data"]["items"] == [] and neg["meta"]["page"]["total"] == 0
    hq = (await _get(client_as, HQ_HYUNDAI, G)).json()["data"]["items"]
    admin = (await _get(client_as, ADMIN, G)).json()["data"]["items"]
    assert hq == admin


@needs_db
async def test_filters_and_scope(client_as):
    assert (await _get(client_as, ADMIN, {**G, "source": "communityForums"})).json()["meta"]["page"]["total"] == 2
    assert (await _get(client_as, ADMIN, {**G, "engine": "gemini"})).json()["data"]["items"] == []
    assert (await _get(client_as, KIA_US, G)).json()["data"]["items"] == []                           # 스코프 밖 누출 0
    p = {"surface": "project", "project_id": str(CUST_PROJECT), "tone": "positive"}
    assert (await _get(client_as, VENDOR, p)).json()["data"]["items"] == []                             # k31 은 당사 감정 신호 0
    assert (await _get(client_as, KIA_US, p)).status_code == 404
    w = (await _get(client_as, KIA_EU, {"surface": "website", "tone": "positive"})).json()
    assert w["meta"]["suppressed"] == {"*": "hidden"} and w["data"]["items"] == []
    assert (await _get(client_as, None, G)).status_code == 401


@pytest.mark.parametrize("params", [{"surface": "global"}, {"surface": "global", "tone": "neutral"},
                                    {**G, "group_by": "domain"}, {**G, "limit": 0}, {**G, "limit": 201}, {**G, "q": "x" * 201},
                                    {**G, "cursor": "!!"}])
@needs_db
async def test_invalid_params_422(client_as, params):
    r = await _get(client_as, ADMIN, params)
    assert r.status_code == 422, (params, r.text)


@needs_db
async def test_key_unique_and_display_separate(client_as):
    """D5 회귀: url 모드 key 는 url_hash(원본 URL sha256) 16진이라 표시 URL 이 같은 두 URL(프래그먼트·스킴만 다름)도 key 가 다르다.
    010dc5d 는 key = 표시 URL 이라 https://www.reddit.com/r/cars 와 ...#:~:text=suv 가 같은 key 두 행이 됐다. 표시 라벨은 display 로 분리."""
    items = (await _get(client_as, ADMIN, G)).json()["data"]["items"]
    assert len({i["key"] for i in items}) == len(items)
    for i in items:
        assert i["key"] == hashlib.sha256(i["url"].encode()).hexdigest()
        assert i["display"] == i["url"].split("#", 1)[0].removeprefix("https://").removeprefix("http://")


@needs_db
async def test_same_display_rows_get_distinct_keys(client_as, monkeypatch):
    """D5 회귀(행 조립): 표시 URL 이 같은 두 행을 SQL 결과로 흉내 내면 key 는 각 행의 url_hash 로 갈리고 display 만 같다.
    (기능 테스트는 rd 에 쓰지 않는다: G6. 프래그먼트만 다른 URL 적재 경로는 검증자 재현과 같다.)"""
    from app.features.analytics.citations.tone import service

    base = {"citations": 1, "engines": [], "skey": "reddit.com", "domain": "reddit.com", "title": None, "category_key": 6,
            "prompt_text": None, "total": 2, "display": "www.reddit.com/r/cars"}
    fake = [{**base, "k": "aa" * 32, "url": "https://www.reddit.com/r/cars"},
            {**base, "k": "bb" * 32, "url": "https://www.reddit.com/r/cars#:~:text=suv"}]

    async def _rows(*_a, **_k):
        return fake
    monkeypatch.setattr(service, "fetch_keyset", _rows)
    items = (await _get(client_as, ADMIN, {**G, "tone": "negative"})).json()["data"]["items"]
    assert [i["key"] for i in items] == ["aa" * 32, "bb" * 32]
    assert {i["display"] for i in items} == {"www.reddit.com/r/cars"}


@pytest.mark.parametrize("q", ["a\x00", "\x00", "a\x1fb", "x\x7f"])
@needs_db
async def test_q_control_chars_422_on_q(client_as, q):
    """D3 회귀: q 의 제어문자 → 010dc5d 는 422 cursor_invalid('커서 값이 정렬 열과 맞지 않음', 원인과 무관한 메시지).
    이제 422 unprocessable, 필드 q."""
    r = await _get(client_as, ADMIN, {**G, "q": q})
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    assert err["code"] == "unprocessable" and any(d["loc"][-1] == "q" for d in err["details"])
