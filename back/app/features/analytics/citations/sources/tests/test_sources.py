"""GET /v1/citations/sources · /sources/types (C-2) 통합 테스트. 기대값 근거: domains/tests/helpers.py 머리 주석과 독립 SQL."""
from __future__ import annotations

from app.core.auth import load_principal
from app.core.db import fetch_all
from app.core.filters import CommonFilters, resolve_read_context
from app.features.analytics.citations.domains.shared import CITATION_SUPPORT
from app.features.analytics.citations.domains.tests.helpers import fetch_scalar, override, website_window
from app.features.analytics.citations.sources import queries as q
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

G = {"surface": "global"}
P = {"surface": "project", "project_id": str(CUST_PROJECT)}
# 독립 기대값: 글로벌 스냅샷 k1 인용(호스트 있는 9건)을 출처 카테고리로 센다(오버라이드 우선)
CAT_SQL = """
SELECT coalesce(json_object_agg(slug, n), '{}')::text FROM (
  SELECT cc.slug, count(*) AS n
    FROM rd.citation c JOIN rd.dim_source ds ON ds.source_key = c.source_key
    LEFT JOIN app.citation_domain_override o ON o.domain = ds.skey
    JOIN app.citation_category cc ON cc.category_key = coalesce(o.category_key, ds.category_key)
   WHERE c.surface = 1 AND c.round_date = '2026-09-14' AND c.cyc_key IN (11) AND c.cit_in AND c.dflt AND c.source_key <> 0
   GROUP BY cc.slug) x
"""


async def _get(client_as, uid, params, path="/v1/citations/sources"):
    async with client_as(uid) as c:
        return await c.get(path, params=params)


def _cats(d):
    return {c["category"]["slug"]: c["citations"] for c in d["categories"]}


@needs_db
async def test_global_shape_admin(client_as):
    import json
    r = await _get(client_as, ADMIN, G)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    expect = json.loads(await fetch_scalar(CAT_SQL))
    assert _cats(d) == expect == {"officialHmg": 4, "communityForums": 2, "automotiveMedia": 1, "newsMedia": 1, "other": 1}
    assert d["total_citations"] == 9
    assert d["categories"][0]["category"]["slug"] == "officialHmg" and d["categories"][0]["share"] == {"num": 4, "den": 9}
    assert [c["category"]["slug"] for c in d["categories"][2:]] == ["automotiveMedia", "newsMedia", "other"]     # 동률 = 카테고리 ord 순
    assert d["by_engine"] == [{"engine": "chatgpt", "total": 9, "categories": [
        {"category_key": 1, "citations": 4}, {"category_key": 6, "citations": 2}, {"category_key": 4, "citations": 1},
        {"category_key": 5, "citations": 1}, {"category_key": 13, "citations": 1}]}]
    # 톤: k1 관점 sent_pos 3 > sent_neg 0 → 긍정. 인용 9, URL 9, 답변 1
    assert d["tone"] == {"positive": {"urls": 9, "citations": 9, "answers": 1}, "negative": {"urls": 0, "citations": 0, "answers": 0}}
    types = {t["type"]: t for t in d["types"]}
    assert list(types) == ["mention", "recommendation", "comparison", "definition", "final_choice"]
    assert types["mention"]["total"] == 9 and types["recommendation"]["total"] == 0                   # k1 당사(현대) t_mention 4


@needs_db
async def test_types_endpoint_matches_sources(client_as):
    s = (await _get(client_as, HQ_HYUNDAI, G)).json()["data"]["types"]
    t = await _get(client_as, HQ_HYUNDAI, G, "/v1/citations/sources/types")
    assert t.status_code == 200 and t.json()["data"]["items"] == s


@needs_db
async def test_override_applied_at_read_time(client_as):
    """적재기 반영 전(judgment_change 대기)에도 운영자 오버라이드가 카테고리에 즉시 보인다(rd.dim_source 는 그대로)."""
    async with override("reddit.com", 9):
        d = (await _get(client_as, ADMIN, G)).json()["data"]
        assert _cats(d).get("wikiReference") == 2 and "communityForums" not in _cats(d)
        f = (await _get(client_as, ADMIN, {**G, "source": "wikiReference"})).json()["data"]
        assert f["total_citations"] == 2
    assert _cats((await _get(client_as, ADMIN, G)).json()["data"])["communityForums"] == 2


@needs_db
async def test_source_filter_applies_to_all_parts(client_as):
    d = (await _get(client_as, ADMIN, {**G, "source": ["communityForums", "newsMedia"]})).json()
    assert _cats(d["data"]) == {"communityForums": 2, "newsMedia": 1} and d["data"]["total_citations"] == 3
    assert d["data"]["categories"][0]["share"] == {"num": 2, "den": 3}
    assert d["data"]["tone"]["positive"] == {"urls": 3, "citations": 3, "answers": 1}
    assert {t["type"]: t["total"] for t in d["data"]["types"]}["mention"] == 3
    unknown = (await _get(client_as, ADMIN, {**G, "source": "noSuchCategory"})).json()                   # 전부 버려짐 = 빈 집합
    assert unknown["data"]["total_citations"] == 0 and unknown["meta"]["dropped_filters"] == {"source": ["noSuchCategory"]}


@needs_db
async def test_tone_partition(client_as):
    """긍정·부정 인용은 전체 인용을 넘지 않는다(동률 답변은 어느 쪽도 아니다). 픽스처에 부정 톤 답변은 없다."""
    for uid in (ADMIN, HQ_HYUNDAI):
        d = (await _get(client_as, uid, G)).json()["data"]
        assert d["tone"]["positive"]["citations"] + d["tone"]["negative"]["citations"] <= d["total_citations"]
        assert d["tone"]["negative"] == {"urls": 0, "citations": 0, "answers": 0}


@needs_db
async def test_filters_change_values_and_ignored(client_as):
    assert (await _get(client_as, ADMIN, {**G, "engine": "gemini"})).json()["data"]["total_citations"] == 0
    assert (await _get(client_as, ADMIN, {**G, "country": "US"})).json()["data"]["total_citations"] == 9
    assert (await _get(client_as, ADMIN, {**G, "country": "DE"})).json()["data"]["total_citations"] == 0
    r = (await _get(client_as, VENDOR, {**P, "brand": "Kia"})).json()
    assert r["meta"]["ignored_filters"] == ["brand"]                                                     # 프로젝트 표면 브랜드 축 없음


@needs_db
async def test_project_and_scope(client_as):
    d = (await _get(client_as, VENDOR, P)).json()["data"]
    assert _cats(d) == {"other": 3, "officialHmg": 1} and d["total_citations"] == 4
    assert (await _get(client_as, KIA_US, P)).status_code == 404
    assert (await _get(client_as, KIA_US, G)).json()["data"]["total_citations"] == 0                     # 기아 US 모수 밖
    assert (await _get(client_as, None, G)).status_code == 401
    assert (await _get(client_as, SUSPENDED, G)).status_code == 401


@needs_db
async def test_website_hidden(client_as):
    r = (await _get(client_as, KIA_EU, {"surface": "website"})).json()
    assert r["meta"]["suppressed"] == {"*": "hidden"} and r["data"]["categories"] == [] and r["data"]["total_citations"] == 0


@needs_db
async def test_website_sql_without_hidden(ro):
    """숨김만 뺀 창으로 같은 빌더 실행: 공식(HMG) 4건(kia.com 3 + kia.de 1), 엔진 chatgpt 3 · gemini 1, 기아 당사 유형 mention 3(k21 만 당사 언급)."""
    p = await load_principal(ro, KIA_EU)
    ctx = await resolve_read_context(ro, p, CommonFilters(surface="website"), support=CITATION_SUPPORT)
    win = website_window(ctx.project_keys)
    s = q.sources_sql(ctx, win)
    rows = await fetch_all(ro, s.text, s.params)
    assert {(r["engine_key"], r["category_key"], int(r["citations"]), r["grp"]) for r in rows} == {
        (None, None, 4, 3), (None, 1, 4, 2), (1, 1, 3, 0), (2, 1, 1, 0)}
    assert [(r["category_key"], int(r["t_mention"])) for r in rows if r["grp"] == 2] == [(1, 3)]
    t = q.types_sql(ctx, win)
    assert [(r["category_key"], int(r["t_mention"])) for r in await fetch_all(ro, t.text, t.params)] == [(1, 3)]


@needs_db
async def test_empty_and_422(client_as):
    d = (await _get(client_as, ADMIN, {**G, "from": "2025-01-01", "to": "2025-01-31"})).json()["data"]
    assert d["total_citations"] == 0 and d["categories"] == [] and len(d["types"]) == 5
    assert (await _get(client_as, ADMIN, {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"})).status_code == 422
    assert (await _get(client_as, ADMIN, {"surface": "global", "country": ["x\u0001"]})).status_code == 422
    assert (await _get(client_as, ADMIN, {"surface": "global", "from": "x", "to": "y"}, "/v1/citations/sources/types")).status_code == 422
