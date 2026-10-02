"""GET /v1/citations/domains/{skey} (C-1 드릴다운) 통합 테스트. 기대값 근거: domains/tests/helpers.py 머리 주석(픽스처 손 계산)."""
from __future__ import annotations

import re

import pytest

from app.core.auth import load_principal
from app.core.db import fetch_one
from app.core.filters import CommonFilters, resolve_read_context
from app.features.analytics.citations.domain_detail import queries as q
from app.features.analytics.citations.domains.shared import CITATION_SUPPORT
from app.features.analytics.citations.domains.tests.helpers import fetch_scalar, website_window
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, VENDOR, needs_db

G = {"surface": "global"}
P = {"surface": "project", "project_id": str(CUST_PROJECT)}
JOB1 = "90000000-0000-4000-8000-000000000001"


async def _get(client_as, uid, skey, params):
    async with client_as(uid) as c:
        return await c.get(f"/v1/citations/domains/{skey}", params=params)


@needs_db
async def test_global_reddit_shape(client_as):
    r = await _get(client_as, ADMIN, "reddit.com", G)
    assert r.status_code == 200, r.text
    body = r.json()
    d = body["data"]
    assert d["source"] == {"skey": "reddit.com", "domain": "reddit.com", "is_social": False,
                           "category": {"category_key": 6, "slug": "communityForums", "name": "Community & Forums"}, "competitor_brand": None}
    assert d["citations"] == 2 and d["own_citations"] == 0
    assert sorted(u["url"] for u in d["urls"]) == ["https://www.reddit.com/r/cars", "https://www.reddit.com/r/suv"]
    assert all(u["engines"] == ["chatgpt"] and u["citations"] == 1 and u["country"] is None for u in d["urls"])
    pid = await fetch_scalar("SELECT prompt_id::text FROM rd.dim_prompt WHERE text = 'best suv'")
    assert d["prompts"] == [{"prompt_id": pid, "text": "best suv", "funnel": "F1", "citations": 2, "own_citations": 0, "engines": ["chatgpt"],
                             "answers": [{"job_id": JOB1, "engine": "chatgpt", "country": "US", "citations": 2}]}]
    assert body["meta"]["cycles"] == ["2026-09-14"]


@needs_db
async def test_social_skey_with_slash_and_owned_country(client_as):
    d = (await _get(client_as, ADMIN, "linkedin.com/hyundai-motor-group", G)).json()["data"]
    assert d["source"]["is_social"] is True and d["citations"] == 1
    h = (await _get(client_as, ADMIN, "hyundai.com", G)).json()["data"]
    assert h["own_citations"] == 1 and h["urls"][0]["country"] == "AU"          # 자사 URL = owned base(hyundai.com/au/en) 국가


@needs_db
async def test_viewpoint_own(client_as):
    """현대 관점: kia.com(worldwide 기아 base) 인용은 자사 아님, 관리자(3사)는 자사."""
    assert (await _get(client_as, HQ_HYUNDAI, "kia.com", G)).json()["data"]["own_citations"] == 0
    assert (await _get(client_as, ADMIN, "kia.com", G)).json()["data"]["own_citations"] == 1


@needs_db
async def test_unknown_skey_404_and_auth(client_as):
    r = await _get(client_as, ADMIN, "no-such-source.example", G)
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert (await _get(client_as, None, "reddit.com", G)).status_code == 401
    assert (await _get(client_as, ADMIN, "reddit.com", {"surface": "bogus"})).status_code == 422


@needs_db
async def test_scope_no_leak(client_as):
    d = (await _get(client_as, KIA_US, "reddit.com", G)).json()["data"]
    assert d["citations"] == 0 and d["urls"] == [] and d["prompts"] == []
    assert (await _get(client_as, KIA_US, "example.com", P)).status_code == 404


@needs_db
async def test_project(client_as):
    d = (await _get(client_as, VENDOR, "example.com", P)).json()["data"]
    assert d["citations"] == 3 and d["own_citations"] == 2 and len(d["urls"]) == 3
    assert d["prompts"][0]["text"] == "cust q" and d["prompts"][0]["own_citations"] == 2
    assert d["prompts"][0]["answers"] == [{"job_id": "90000000-0000-4000-8000-000000000031", "engine": "chatgpt", "country": "US", "citations": 3}]


@needs_db
async def test_filters(client_as):
    assert (await _get(client_as, ADMIN, "reddit.com", {**G, "engine": "gemini"})).json()["data"]["citations"] == 0
    assert (await _get(client_as, ADMIN, "reddit.com", {**G, "source": "communityForums"})).json()["data"]["citations"] == 2
    out = (await _get(client_as, ADMIN, "reddit.com", {**G, "source": "newsMedia"})).json()["data"]             # 이 출처 카테고리 밖
    assert out["citations"] == 0 and out["urls"] == []
    assert (await _get(client_as, ADMIN, "reddit.com", {**G, "mention_brand": "Toyota"})).json()["data"]["citations"] == 2
    r = (await _get(client_as, ADMIN, "reddit.com", {**G, "mention_brand": "Nope"})).json()
    assert r["data"]["citations"] == 0 and r["meta"]["dropped_filters"] == {"mention_brand": ["Nope"]}


@needs_db
async def test_website_hidden(client_as):
    r = (await _get(client_as, KIA_EU, "kia.com", {"surface": "website"})).json()
    assert r["meta"]["suppressed"] == {"*": "hidden"} and r["data"]["citations"] == 0 and r["data"]["urls"] == []


@needs_db
async def test_website_sql_without_hidden(ro):
    """숨김만 뺀 창으로 같은 빌더 실행: kia.com 3건 중 자사(loc_owned ∨ tgt_hit) 2, 프롬프트 ev9?·sub?, 엔진 chatgpt 2 + gemini 1."""
    p = await load_principal(ro, KIA_EU)
    ctx = await resolve_read_context(ro, p, CommonFilters(surface="website"), support=CITATION_SUPPORT)
    sk = await fetch_scalar("SELECT source_key FROM rd.dim_source WHERE skey = 'kia.com'")
    s = q.detail_sql(ctx, website_window(ctx.project_keys), source_key=sk, mention_brand_key=None)
    r = await fetch_one(ro, s.text, s.params)
    assert (r["citations"], r["own_citations"]) == (3, 2)
    assert {x["text"] for x in r["prompts"]} == {"ev9?", "sub?"}
    assert sorted(e for u in r["urls"] for e in u["engines"]) == [1, 1, 2]                               # engine_key: chatgpt 1, gemini 2
    assert {x["geo_code"] for x in r["urls"]} == {"DE"}                                                  # 세 URL 모두 kia.com/de base(owner 76) = DE


@needs_db
async def test_competitor_source_mapping(client_as):
    """공식 경쟁사 출처(bmwusa.com)는 경쟁 브랜드 표시명을 싣는다(k5 인용은 cit_in 거짓이라 인용 수 0)."""
    expect = await fetch_scalar("SELECT bn.name FROM rd.dim_source ds JOIN rd.dim_brand_name bn ON bn.brand_key = ds.competitor_brand_key "
                                "WHERE ds.skey = 'bmwusa.com'")
    d = (await _get(client_as, ADMIN, "bmwusa.com", {**G, "engine": "gemini"})).json()["data"]
    assert d["source"]["competitor_brand"] == expect == "BMW" and d["source"]["category"]["slug"] == "officialCompetitor"
    assert d["citations"] == 0


@pytest.mark.parametrize(("path", "params"), [
    ("/v1/citations/domains/reddit.com", {**G, "mention_brand": "a\x00b"}),
    ("/v1/citations/domains/red%00dit.com", G),
    ("/v1/citations/domains/red%1Fdit.com", G),
])
@needs_db
async def test_control_chars_422(client_as, path, params):
    """D2 회귀: mention_brand·경로 skey 의 제어문자 → 010dc5d 는 500 internal(invalid byte sequence 0x00). 이제 422."""
    async with client_as(ADMIN) as c:
        r = await c.get(path, params=params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", r.text
    assert any(d["loc"][-1] in ("mention_brand", "skey") for d in r.json()["error"]["details"])


@needs_db
async def test_refs_cut_before_job_join(ro):
    """D6 회귀: 답변 참조 순위(rk)는 rd.job 없이 (cites DESC, answer_key) 로 매기고, rd.job PK 조인은 rn <= 8 로 자른 표본(rs)에만 한다
    (모듈-인용 C-3 규약, 최대 12 × 8 = 96행). 010dc5d 는 rn 자르기 전에 프롬프트 상위 12 의 (프롬프트, 답변) 전체를 rd.job 과 조인했다."""
    p = await load_principal(ro, ADMIN)
    ctx = await resolve_read_context(ro, p, CommonFilters(surface="global"), support=CITATION_SUPPORT)
    sk = await fetch_scalar("SELECT source_key FROM rd.dim_source WHERE skey = 'reddit.com'")
    s = q.detail_sql(ctx, await ctx.window(ro), source_key=int(sk), mention_brand_key=None)
    txt = s.text
    rk = txt[txt.index("rk AS ("):txt.index("rs AS (")]
    rs = txt[txt.index("rs AS ("):txt.index("SELECT\n  (SELECT count(*) FROM base)")]
    assert "rd.job" not in rk and "job_id" not in rk and "ORDER BY rf.cites DESC, rf.answer_key" in rk
    # BG-25: 상한이 요청 값(answers_limit, 기본 REFS_PER_PROMPT)이라 바인드로 들어간다. 자르는 위치(rs)는 그대로
    m = re.search(r"rk\.rn <= CAST\(:(\w+) AS int4\)", rs)
    assert "JOIN rd.job j ON j.answer_key = rk.answer_key" in rs and m is not None and s.params[m.group(1)] == q.REFS_PER_PROMPT
    assert txt.count("rd.job") == 1
    r = await fetch_one(ro, s.text, s.params)
    assert [x["job_id"] for x in r["refs"]] == [JOB1]                     # 결과는 그대로(k1 의 reddit 인용 2건)
