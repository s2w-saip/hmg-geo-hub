"""BG 보강(bg-citations) 회귀: /v1/citations/prompts 의 BG-01(global 표면 lang[] 적용).

준비: staged.pgsql @global(회차 14 스냅샷, 전부 en) + domains/tests/bg.pgsql @lang_ko(PD 답변 9111~9120 을 ko 로, 답변·인용·잡 사본 함께).
자사 판정은 core 규칙(관점 브랜드 owned_base 를 요청 언어로 좁힌 허용 배열, 비면 안 좁힘)을 독립 SQL 로 다시 쓴다:
  ko → 현대 ko 베이스(KR·루트 ko)만 허용 → PD 의 hyundai.com(AU en, owner 9) 인용은 자사가 아님 → PD 는 미인용 버킷.
  en → 현대 en 베이스(AU 9·US 루트 등) 허용 → PA(ord1)·PC(ord9) 자사, PB 미인용.
"""
from __future__ import annotations

import pathlib

from app.features.analytics.citations.prompts.tests.staged_db import SQL as PROMPT_SQL
from tests.support import HQ_HYUNDAI, KIA_US, Sql, load_named_sql, needs_db, raw_fetch, staged

pytestmark = needs_db
URL = "/v1/citations/prompts"
BG = load_named_sql(pathlib.Path(__file__).parents[2] / "domains" / "tests" / "bg.pgsql")
HQ_BGRPS = [m for m in range(1, 32) if m & 9]
SCAN = """
SELECT dp.prompt_id::text AS pid, count(*) AS cites,
       bool_or(c.owner_key = ANY(SELECT o.owner_key FROM app.owned_base o WHERE o.brand_code = 'Hyundai' AND o.language = $2)) AS owned
  FROM rd.citation c JOIN rd.dim_prompt dp ON dp.prompt_key = c.prompt_key JOIN rd.dim_lang l ON l.lang_key = c.lang_key
 WHERE c.surface = 1 AND c.round_date = '2026-09-23' AND c.cyc_key = ANY(ARRAY[14]) AND c.cit_in AND c.source_key <> 0 AND c.dflt
   AND c.bgrp = ANY($1::int2[]) AND l.code = $2
 GROUP BY dp.prompt_id
"""


async def get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


async def test_bg01_global_lang_applied(client_as):
    async with staged(Sql(PROMPT_SQL["global"]), Sql(BG["lang_ko"])) as conn:
        for lang in ("ko", "en"):
            rows = await raw_fetch(conn, SCAN, HQ_BGRPS, lang)
            owned = sorted((r for r in rows if r["owned"]), key=lambda r: (-int(r["cites"]), r["pid"]))
            uncited = sorted((r for r in rows if not r["owned"]), key=lambda r: (-int(r["cites"]), r["pid"]))
            for flag, want in (("true", owned), ("false", uncited)):
                b = (await get(client_as, HQ_HYUNDAI, surface="global", owned=flag, lang=lang)).json()
                assert b["meta"]["ignored_filters"] == [], lang
                assert b["data"]["counts"] == {"owned": len(owned), "uncited": len(uncited)}, lang
                assert [(i["prompt_id"], i["citations"]) for i in b["data"]["items"]] == [(r["pid"], int(r["cites"])) for r in want], (lang, flag)
        ko = await raw_fetch(conn, SCAN, HQ_BGRPS, "ko")
        assert [(r["cites"], r["owned"]) for r in ko] == [(13, False)]                          # 손 계산: PD 13건, ko 관점 자사 아님
        # 답변 표본도 언어 축 안에서만(PD 답변은 전부 ko)
        items = (await get(client_as, HQ_HYUNDAI, surface="global", owned="false", lang="ko")).json()["data"]["items"]
        assert len(items[0]["answers"]) == 8 and all(a["job_id"].startswith("9a000000") for a in items[0]["answers"])
        # 스코프 밖(기아 US) 누출 없음 · 모르는 언어는 dropped + 빈 결과(fail-closed)
        k = (await get(client_as, KIA_US, surface="global", owned="false", lang="ko")).json()
        assert k["data"]["counts"] == {"owned": 0, "uncited": 0}
        x = (await get(client_as, HQ_HYUNDAI, surface="global", owned="false", lang="xx")).json()
        assert x["meta"]["dropped_filters"].get("lang") == ["xx"] and x["data"]["counts"] == {"owned": 0, "uncited": 0}
