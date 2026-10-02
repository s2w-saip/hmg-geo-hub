"""BG 보강(bg-citations) 회귀: /v1/citations/sources/tone 의 BG-27 탭 카운트(with_counts → data.counts{positive, negative}).

준비: prompts/tests/staged.pgsql @global(회차 14, 답변은 템플릿 k1 복사라 전부 현대 긍정 톤) + domains/tests/bg.pgsql @src_first·
@tone_negative(PD 답변 9114·9120 = example.org 인용 답변을 부정 톤으로). 기대값 = 같은 트랜잭션의 독립 SQL(톤별 DISTINCT url_key),
그리고 같은 필터의 /v1/citations/sources tone 타일 urls(현행 탭 카운트 원천)와 같아야 한다.
"""
from __future__ import annotations

import pathlib

from app.features.analytics.citations.prompts.tests.staged_db import SQL as PROMPT_SQL
from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, Sql, load_named_sql, needs_db, raw_fetch, staged

pytestmark = needs_db
URL = "/v1/citations/sources/tone"
G = {"surface": "global"}
BG = load_named_sql(pathlib.Path(__file__).parents[2] / "domains" / "tests" / "bg.pgsql")
HQ_BGRPS = [m for m in range(1, 32) if m & 9]
TONE_SQL = """
SELECT count(DISTINCT c.url_key) FILTER (WHERE a.sent_pos_h > a.sent_neg_h) AS pos,
       count(DISTINCT c.url_key) FILTER (WHERE a.sent_neg_h > a.sent_pos_h) AS neg
  FROM rd.citation c JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.answer_key = c.answer_key
 WHERE c.surface = 1 AND c.round_date = '2026-09-23' AND c.cyc_key = ANY(ARRAY[14]) AND c.cit_in AND c.source_key <> 0 AND c.dflt
   AND c.bgrp = ANY($1::int2[]) AND a.surface = 1 AND a.round_date = '2026-09-23' AND a.cyc_key = ANY(ARRAY[14])
"""


async def get(client_as, uid, url=URL, **params):
    async with client_as(uid) as c:
        return await c.get(url, params=params)


async def test_bg27_counts_match_tiles_and_ignore_q(client_as):
    async with staged(Sql(PROMPT_SQL["global"]), Sql(BG["src_first"]), Sql(BG["tone_negative"])) as conn:
        w = (await raw_fetch(conn, TONE_SQL, HQ_BGRPS))[0]
        assert int(w["neg"]) == 1 and int(w["pos"]) >= 3                                        # 손 계산: 부정 = example.org URL 하나
        want = {"positive": int(w["pos"]), "negative": int(w["neg"])}
        tiles = (await get(client_as, HQ_HYUNDAI, "/v1/citations/sources", **G)).json()["data"]["tone"]
        assert (tiles["positive"]["urls"], tiles["negative"]["urls"]) == (want["positive"], want["negative"])
        for params in ({"tone": "positive"}, {"tone": "negative"}, {"tone": "negative", "group_by": "source"},
                       {"tone": "positive", "q": "zzz-no-match"}):
            b = (await get(client_as, HQ_HYUNDAI, **G, **params, with_counts="true")).json()
            assert b["data"]["counts"] == want, params
        assert (await get(client_as, HQ_HYUNDAI, **G, tone="positive")).json()["data"]["counts"] is None   # 요청 없으면 싣지 않는다
        # 커서는 with_counts 와 무관(목록 모집단이 같다): 카운트 없이 받은 커서를 카운트 요청에 그대로 쓴다
        first = (await get(client_as, HQ_HYUNDAI, **G, tone="positive", limit=1)).json()["meta"]["page"]["next_cursor"]
        r = await get(client_as, HQ_HYUNDAI, **G, tone="positive", limit=1, cursor=first, with_counts="true")
        assert r.status_code == 200 and r.json()["data"]["counts"] == want
        # 필터 적용: 엔진 deepseek(9105, 긍정) · 스코프 밖 계정 0
        ds = (await get(client_as, HQ_HYUNDAI, **G, tone="positive", engine="deepseek", with_counts="true")).json()["data"]["counts"]
        assert ds == {"positive": 2, "negative": 0}                                             # 9105{hyundai.com, reddit ord2}
        k = (await get(client_as, KIA_US, **G, tone="positive", with_counts="true")).json()["data"]["counts"]
        assert k == {"positive": 0, "negative": 0}


async def test_bg27_empty_and_invalid(client_as):
    e = (await get(client_as, ADMIN, **G, tone="positive", with_counts="true", **{"from": "2025-01-01", "to": "2025-01-31"})).json()
    assert e["data"] == {"items": [], "counts": {"positive": 0, "negative": 0}}
    r = await get(client_as, ADMIN, **G, tone="positive", with_counts="sometimes")
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"
