"""성능 라운드 A6(2026-09-30) 동치: limit=0 전용 문장(목록 CTE 없이 출처 키로 한 번 접기) = 이전 목록 문장의 limit=0 결과.

1) GET /v1/citations/domains limit=0 을 새 문장·이전 문장(legacy_perf.domains_sql)으로 불러 봉투 바이트가 같다: 요약·경쟁사 합·
   경쟁사 출처(상한 + 1 잘림 판정)·meta.page.total(= 경쟁사 선택·검색·skey[] 로 좁힌 출처 수, 검증 D4).
2) limit > 0 경로는 문장 글자·바인드까지 이전과 같다(바뀐 것은 limit=0 분기뿐).
준비: prompts/tests/staged.pgsql @global(글로벌 회차 14 = 새 스냅샷) + domains/tests/bg.pgsql src_first·competitor(경쟁사 카테고리·브랜드,
운영자 오버라이드).
"""
from __future__ import annotations

import pathlib
from typing import Any

import pytest

from app.features.analytics.citations.domains import queries as dq
from app.features.analytics.citations.domains.tests import legacy_perf
from app.features.analytics.citations.prompts.tests.staged_db import SQL as PROMPT_SQL
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, VENDOR, Sql, load_named_sql, needs_db, staged

URL = "/v1/citations/domains"
BG = load_named_sql(pathlib.Path(__file__).with_name("bg.pgsql"))
STEPS = [Sql(PROMPT_SQL["global"]), Sql(BG["src_first"]), Sql(BG["competitor"])]

LIMIT0: list[dict[str, Any]] = [
    {},
    {"competitor_sources": "true"},
    {"competitor_sources": "true", "competitor": ["caranddriver.com"]},
    {"competitor": ["caranddriver.com", "reddit.com"], "q": "com"},
    {"q": "o"},
    {"q": "%_"},
    {"skey": ["reddit.com", "hyundai.com", "nope.test"]},
    {"skey": ["reddit.com"], "competitor": ["foo-bar.xyz"], "competitor_sources": "true"},
    {"source": ["officialCompetitor", "communityForums"], "competitor_sources": "true"},
    {"mention_brand": "Hyundai", "competitor_sources": "true"},
    {"mention_brand": "nobody-brand"},
    {"engine": ["gemini"], "competitor_sources": "true"},
    {"country": ["US"], "from": "2026-09-01", "to": "2026-09-30"},
]


async def _pair(client_as, monkeypatch, uid, params: dict[str, Any]) -> tuple[int, dict | None]:
    async with client_as(uid) as c:
        new = await c.get(URL, params=params)
        with monkeypatch.context() as m:
            # 이전 문장 사본은 host_fold(WU-12, 현행 프로필 domains_card_by_host 전용) 이전이라 받지 않는다: 이 시험은 프로필 꺼짐(무효과)
            m.setattr(dq, "domains_sql", lambda *a, host_fold=False, **k: legacy_perf.domains_sql(*a, **k))
            old = await c.get(URL, params=params)
    assert new.status_code == old.status_code, (params, new.text, old.text)
    assert new.content == old.content, params
    return new.status_code, (new.json() if new.status_code == 200 else None)


@needs_db
@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI, KIA_US], ids=["admin", "hq_hyundai", "kia_us"])
async def test_domains_limit0_equiv_global(client_as, monkeypatch, uid):
    async with staged(*STEPS):
        seen = 0
        for extra in LIMIT0:
            st, body = await _pair(client_as, monkeypatch, uid, {"surface": "global", "limit": 0, **extra})
            if body is not None:
                assert body["data"]["items"] == []
                seen += body["data"]["summary"]["total_citations"] + len(body["data"]["competitor_sources"] or [])
        assert seen > 0 or uid == KIA_US                    # 빈 결과끼리의 동치가 아니다(기아 US 관점은 픽스처 인용 0: 동치만 본다)


@needs_db
async def test_domains_limit0_equiv_other_surfaces(client_as, monkeypatch):
    async with staged(*STEPS):
        for uid, params in ((ADMIN, {"surface": "website", "limit": 0}), (ADMIN, {"surface": "website", "limit": 0, "competitor_sources": "true"}),
                            (ADMIN, {"surface": "project", "project_id": str(CUST_PROJECT), "limit": 0, "q": "example"}),
                            (VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT), "limit": 0, "competitor_sources": "true"})):
            await _pair(client_as, monkeypatch, uid, params)


@needs_db
async def test_domains_limit0_matched_and_totals_are_real(client_as, monkeypatch):
    """새 limit=0 값이 목록(limit=200)과 맞물린다: 요약·경쟁사 합은 목록 요청과 같고, meta.page.total 은 목록의 좁힌 행 수와 같다."""
    async with staged(*STEPS):
        for extra in ({}, {"q": "com", "competitor": ["caranddriver.com"]}, {"skey": ["reddit.com", "kia.com"]}):
            _, z = await _pair(client_as, monkeypatch, ADMIN, {"surface": "global", "limit": 0, **extra})
            async with client_as(ADMIN) as c:
                full = (await c.get(URL, params={"surface": "global", "limit": 200, **extra})).json()
            assert z is not None
            assert z["data"]["summary"] == full["data"]["summary"] and z["data"]["competitor_totals"] == full["data"]["competitor_totals"]
            assert z["meta"]["page"]["total"] == full["meta"]["page"]["total"] == len(full["data"]["items"])


@needs_db
async def test_domains_list_statement_unchanged(ro, refs):
    """limit > 0 문장은 글자·바인드가 이전과 같다(정렬·커서·검색·선택·경쟁사 출처 조합)."""
    from app.core.auth import load_principal
    from app.core.filters import CommonFilters, resolve_read_context
    from app.features.analytics.citations.domains.shared import CITATION_SUPPORT

    p = await load_principal(ro, ADMIN)
    ctx = await resolve_read_context(ro, p, CommonFilters(surface="global"), support=CITATION_SUPPORT)
    win = await ctx.window(ro)
    for kw in ({"limit": 200}, {"limit": 7, "q": "o", "skeys": ("a.com", "b.com")},
               {"limit": 50, "competitor_category_key": 2, "competitor_limit": 5000, "competitor_pick": ("x.com",)},
               {"limit": 3, "spec": dq.sort_spec("share", "asc"), "mention_brand_key": 1, "answers_den": 5}):
        kw2 = {"cursor": None, "mention_brand_key": None, **kw}
        new, old = dq.domains_sql(ctx, win, **kw2), legacy_perf.domains_sql(ctx, win, **kw2)
        # 유일한 의도된 차이(be/web-card-perf): 합계 CTE t 를 MATERIALIZED 로(값 무관, 1행 추정 시 O(n²) 재집계 차단). 값 동치 = test_web_card_perf
        want = old.text.replace("\nt AS (\n", "\nt AS MATERIALIZED (\n", 1)
        assert want != old.text
        assert new.text == want and new.params == old.params, kw
