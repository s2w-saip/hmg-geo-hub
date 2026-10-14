"""BG 보강(bg-citations) 회귀: /v1/citations/domains/{skey} 의 BG-23(URL 행 prompt_text)·BG-25(urls·prompts·answers 상한 파라미터 +
자르기 전 총수).

준비: prompts/tests/staged.pgsql @global + domains/tests/bg.pgsql @src_first(회차 14 스냅샷, 손 계산은 domains/tests/test_domains_bg.py 머리).
reddit.com 은 회차 14 에서 프롬프트 4개(PA·PB·PC·PD)·인용 9건, PD 는 답변 5개(9111·9112·9113·9117·9119)가 reddit 을 인용한다.
기대값은 같은 트랜잭션의 rd.citation 원소 독립 SQL 로 만든다.
"""
from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

from app.features.analytics.citations.prompts.tests.staged_db import SQL as PROMPT_SQL
from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, Sql, load_named_sql, needs_db, raw_fetch, staged

pytestmark = needs_db
BASE = "/v1/citations/domains/"
G = {"surface": "global"}
BG = load_named_sql(pathlib.Path(__file__).parents[2] / "domains" / "tests" / "bg.pgsql")
HQ_BGRPS = [m for m in range(1, 32) if m & 9]

# 출처 하나의 URL 별 인용 수와 가장 이른 인용(round_date·answer_key·ord)의 프롬프트 텍스트, 프롬프트별 인용·답변 수(회차 14 스냅샷)
URLS_SQL = """
SELECT du.url, count(*) AS n,
       (SELECT dp.text FROM rd.citation c2 JOIN rd.dim_prompt dp ON dp.prompt_key = c2.prompt_key
         WHERE c2.surface = 1 AND c2.round_date = '2026-09-23' AND c2.cyc_key = ANY(ARRAY[14]) AND c2.url_key = c.url_key AND c2.cit_in AND c2.dflt
           AND c2.bgrp = ANY($2::int2[])
         ORDER BY c2.round_date, c2.answer_key, c2.ord LIMIT 1) AS first_text
  FROM rd.citation c JOIN rd.dim_url du ON du.url_key = c.url_key JOIN rd.dim_source ds ON ds.source_key = c.source_key
 WHERE c.surface = 1 AND c.round_date = '2026-09-23' AND c.cyc_key = ANY(ARRAY[14]) AND ds.skey = $1 AND c.cit_in AND c.dflt AND c.bgrp = ANY($2::int2[])
 GROUP BY du.url, c.url_key
"""
PROMPTS_SQL = """
SELECT dp.prompt_id::text AS pid, count(*) AS n, count(DISTINCT c.answer_key) AS answers
  FROM rd.citation c JOIN rd.dim_prompt dp ON dp.prompt_key = c.prompt_key JOIN rd.dim_source ds ON ds.source_key = c.source_key
 WHERE c.surface = 1 AND c.round_date = '2026-09-23' AND c.cyc_key = ANY(ARRAY[14]) AND ds.skey = $1 AND c.cit_in AND c.dflt AND c.bgrp = ANY($2::int2[])
 GROUP BY dp.prompt_id
"""


def steps() -> list[Sql]:
    return [Sql(PROMPT_SQL["global"]), Sql(BG["src_first"])]


async def get(client_as, uid, skey, **params):
    async with client_as(uid) as c:
        return await c.get(BASE + skey, params=params)


async def test_bg23_url_prompt_text_and_bg25_totals(client_as):
    async with staged(*steps()) as conn:
        urls = await raw_fetch(conn, URLS_SQL, "reddit.com", HQ_BGRPS)
        prompts = await raw_fetch(conn, PROMPTS_SQL, "reddit.com", HQ_BGRPS)
        b = (await get(client_as, HQ_HYUNDAI, "reddit.com", **G)).json()["data"]
        assert b["url_total"] == len(urls) and b["prompt_total"] == len(prompts) == 4
        assert {(u["url"], u["citations"], u["prompt_text"]) for u in b["urls"]} == {(u["url"], int(u["n"]), u["first_text"]) for u in urls}
        assert {u["prompt_text"] for u in b["urls"]} <= {"stage a tie", "stage b uncited"}                 # 이른 답변 = PA(9101)·PB(9102)
        # 기본 상한(현행 10·12·8) 안에서는 전부
        assert len(b["prompts"]) == 4 and all(len(p["answers"]) <= 8 for p in b["prompts"])
        pd = next(p for p in b["prompts"] if p["text"] == "stage d many")
        want_pd = next(int(p["answers"]) for p in prompts if p["pid"] == pd["prompt_id"])
        assert len(pd["answers"]) == want_pd == 5


async def test_bg25_limits_cut_and_tail(client_as):
    async with staged(*steps()) as conn:
        prompts = await raw_fetch(conn, PROMPTS_SQL, "reddit.com", HQ_BGRPS)
        order = [p["pid"] for p in sorted(prompts, key=lambda p: (-int(p["n"]), p["pid"]))]
        one = (await get(client_as, HQ_HYUNDAI, "reddit.com", **G, prompts_limit=1, answers_limit=2, urls_limit=1)).json()["data"]
        assert [p["prompt_id"] for p in one["prompts"]] == order[:1] and one["prompt_total"] == 4
        assert len(one["urls"]) == 1 and one["url_total"] >= 1 and one["citations"] == 9                   # 요약 수는 자르기와 무관
        assert all(len(p["answers"]) <= 2 for p in one["prompts"])
        cites = [a["citations"] for a in one["prompts"][0]["answers"]]
        assert cites == sorted(cites, reverse=True)
        wide = (await get(client_as, HQ_HYUNDAI, "reddit.com", **G, prompts_limit=100, answers_limit=20, urls_limit=200)).json()["data"]
        assert [p["prompt_id"] for p in wide["prompts"]] == order and len(wide["urls"]) == wide["url_total"]
        # 스코프 밖 계정은 같은 파라미터로도 0(누출 없음)
        k = (await get(client_as, KIA_US, "reddit.com", **G, prompts_limit=100)).json()["data"]
        assert k["prompts"] == [] and k["urls"] == [] and k["prompt_total"] == 0 and k["url_total"] == 0


async def test_bg25_fixture_defaults_unchanged(client_as):
    """준비 없는 픽스처(회차 11): 기본값이면 BG-25 이전과 같은 응답에 새 필드만 더해진다."""
    b = (await get(client_as, ADMIN, "reddit.com", **G)).json()["data"]
    assert b["citations"] == 2 and b["url_total"] == len(b["urls"]) and b["prompt_total"] == len(b["prompts"]) == 1
    assert all(u["prompt_text"] == "best suv" for u in b["urls"])
    empty = (await get(client_as, ADMIN, "reddit.com", **G, **{"from": "2025-01-01", "to": "2025-01-31"})).json()["data"]
    assert (empty["urls"], empty["prompts"], empty["url_total"], empty["prompt_total"]) == ([], [], 0, 0)


@pytest.mark.parametrize("bad", [{"prompts_limit": 0}, {"prompts_limit": 101}, {"answers_limit": 0}, {"answers_limit": 21},
                                 {"urls_limit": 0}, {"urls_limit": 201}, {"urls_limit": "x"}])
async def test_bg25_invalid_limits_422(client_as, bad):
    r = await get(client_as, ADMIN, "reddit.com", **G, **bad)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (bad, r.text)


def _cte_scans(node: Any, name: str) -> int:
    """EXPLAIN (FORMAT JSON) 계획 트리에서 이름이 name 인 CTE 의 스캔 노드 수."""
    if isinstance(node, list):
        return sum(_cte_scans(x, name) for x in node)
    if not isinstance(node, dict):
        return 0
    own = 1 if node.get("Node Type") == "CTE Scan" and node.get("CTE Name") == name else 0
    return own + sum(_cte_scans(v, name) for k, v in node.items() if k in ("Plan", "Plans"))


async def test_b013_summary_counts_read_base_once(ro):
    """B013: 요약 수 중 base 를 다시 읽던 자사 인용 수(own_citations)는 프롬프트별로 이미 센 pl 의 합으로 낸다. 계획의 base 스캔 =
    u·pl·rf·인용 수 4회(종전 5회: 요약 스칼라 부분질의 둘이 base 를 따로 읽었다). 값은 위 BG-23·25 시험(독립 SQL 대조)과 픽스처 손 계산이
    같고, 자사 인용이 있는 출처(hyundai.com)에서 pl 합 = base 직접 FILTER 수다."""
    from app.core.auth import load_principal
    from app.core.db import fetch_all, fetch_one
    from app.core.filters import CommonFilters, resolve_read_context
    from app.features.analytics.citations.domain_detail.queries import detail_sql
    from app.features.analytics.citations.domains.shared import CITATION_SUPPORT

    p = await load_principal(ro, ADMIN)
    ctx = await resolve_read_context(ro, p, CommonFilters(surface="global"), support=CITATION_SUPPORT)
    win = await ctx.window(ro)
    src = await fetch_one(ro, "SELECT source_key FROM rd.dim_source WHERE skey = :k", {"k": "reddit.com"})
    assert src is not None
    s = detail_sql(ctx, win, source_key=int(src["source_key"]), mention_brand_key=None)
    plan = (await fetch_all(ro, "EXPLAIN (FORMAT JSON) " + s.text, s.params))[0]
    doc = next(iter(plan.values()))
    doc = json.loads(doc) if isinstance(doc, str) else doc
    assert _cte_scans(doc, "base") == 4, doc
    assert s.text.count("FROM base") == 4 and "FILTER (WHERE base.own) FROM base)" not in s.text
    r = await fetch_one(ro, s.text, s.params)
    assert r is not None and (int(r["citations"]), int(r["own_citations"]), int(r["prompt_total"])) == (2, 0, 1)   # 픽스처 k1 ord2·ord4
    # 자사 인용이 있는 출처: pl 합 = base 를 직접 센 FILTER 수(종전 문장의 값)
    hk = await fetch_one(ro, "SELECT source_key FROM rd.dim_source WHERE skey = :k", {"k": "hyundai.com"})
    assert hk is not None
    h = detail_sql(ctx, win, source_key=int(hk["source_key"]), mention_brand_key=None)
    old = h.text.replace("(SELECT coalesce(sum(pl.own_citations), 0) FROM pl) AS own_citations",
                         "(SELECT count(*) FILTER (WHERE base.own) FROM base) AS own_citations", 1)
    assert old != h.text
    new_r, old_r = await fetch_one(ro, h.text, h.params), await fetch_one(ro, old, h.params)
    assert new_r is not None and old_r is not None and int(new_r["own_citations"]) == int(old_r["own_citations"]) == 1
    assert {k: new_r[k] for k in ("citations", "url_total", "prompt_total", "urls", "prompts", "refs")} == \
        {k: old_r[k] for k in ("citations", "url_total", "prompt_total", "urls", "prompts", "refs")}


def test_d3_embed_rationale_cites_component_fix_6():
    """재현(검증 D3): embed 미구현 근거로 메인 결정 D4(필터 옵션 패널 로드 시점, 인용 드릴다운과 무관)를 들었다.
    근거는 어댑터 설계 컴포넌트 수정 #6('펼칠 때 조회')이어야 한다."""
    from app.features.analytics.citations.domain_detail import service
    readme = (pathlib.Path(service.__file__).with_name("README.md")).read_text(encoding="utf-8")
    for text in (service.__doc__ or "", readme):
        assert "결정 D4" not in text and "컴포넌트 수정 #6" in text
