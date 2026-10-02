"""K-1 url_prompts(제품 결정 6, DC-02 현행 문구 유지): 웹사이트 자사·타겟 URL 인용률의 프롬프트 단위 모수(추가형).

현행 front 정의(hmg-geo main lib/db/repositories/scope-aggregates.ts aggregateWebsiteTargetHitRate, GGMD-61): 측정 프롬프트 = 창 안 답변이
있는 웹 등록 프롬프트, 타겟·자사 = 그 프롬프트의 답변 인용 중 하나라도 타겟·자사 URL(답변 플래그를 프롬프트로 bool_or). 발행 회차는
발행값(publishedSubtotal: 프롬프트 단위). 기존 측정 단위 Ratio(target_url_rate·owned_url_rate)는 바뀌지 않는다.
준비(rounds.pgsql web_dup_prompt): 회차 21 인용 숨김 해제 + k21(프롬프트 8) 사본 2101(gemini). 기본 엔진 라이브 답변 3·프롬프트 2.
"""
from __future__ import annotations

import pathlib

from app.core.db import fetch_one
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, Sql, load_named_sql, needs_db, staged

URL = "/v1/kpi/summary"
BLOCKS = load_named_sql(pathlib.Path(__file__).with_name("rounds.pgsql"))
pytestmark = needs_db
RANGE = {"from": "2026-09-01", "to": "2026-09-30"}                 # 회차 둘 이상 기간 = R09 period_range → 라이브

_INDEP = """
SELECT count(*) FILTER (WHERE a.web_reg) AS answers,
       count(DISTINCT a.prompt_key) FILTER (WHERE a.web_reg) AS measured,
       count(DISTINCT a.prompt_key) FILTER (WHERE a.web_reg AND a.tgt_cited) AS target,
       count(DISTINCT a.prompt_key) FILTER (WHERE a.web_reg AND a.own_url_cited) AS owned
  FROM rd.answer a
 WHERE a.surface = 2 AND a.round_date = DATE '2026-09-18' AND a.cyc_key = ANY('{21}'::int4[]) AND a.cit_in AND a.dflt
"""


async def test_url_prompts_live_is_prompt_unit_report_is_publication(client_as):
    async with staged(Sql(BLOCKS["web_dup_prompt"])) as conn:
        want = await fetch_one(conn, _INDEP)
        async with client_as(KIA_EU) as c:
            live = (await c.get(URL, params={"surface": "website", **RANGE})).json()
            eng = (await c.get(URL, params={"surface": "website", "engine": "chatgpt"})).json()
            rep = (await c.get(URL, params={"surface": "website"})).json()
    assert want["answers"] == 3 and want["measured"] == 2                          # 준비가 두 단위를 가른다
    d = live["data"]
    assert live["meta"]["source"]["url_rates"] == "live"
    assert d["target_url_rate"] == {"num": 3, "den": 3} and d["owned_url_rate"] == {"num": 3, "den": 3}      # 측정 단위(기존 그대로)
    assert d["url_prompts"] == {"measured_prompts": want["measured"], "target_prompts": want["target"], "owned_prompts": want["owned"]}
    assert d["url_prompts"] == {"measured_prompts": 2, "target_prompts": 2, "owned_prompts": 2}
    assert "url_prompts" not in live["meta"]["suppressed"]
    # 엔진 축(라이브): chatgpt 답변 k21 하나 = 프롬프트 8 하나
    assert eng["meta"]["source"]["reason"] == "engine_axis"
    assert eng["data"]["url_prompts"] == {"measured_prompts": 1, "target_prompts": 1, "owned_prompts": 1}
    # 스냅샷(발행 회차 09-18): 발행 프롬프트 합(유닛 101·102: 측정 10+5, 타겟 7+3, 자사 8+4) = 카드 target_url_rate 와 같은 원천
    assert rep["meta"]["source"]["url_rates"] == "report"
    assert rep["data"]["url_prompts"] == {"measured_prompts": 15, "target_prompts": 10, "owned_prompts": 12}
    assert rep["data"]["target_url_rate"] == {"num": 10, "den": 15}


async def test_url_prompts_suppressed_outside_website_and_when_hidden(client_as):
    """global·project 표면 = null + not_website_surface, 인용 숨김 회차(픽스처 21 그대로) = null + hidden."""
    async with client_as(HQ_HYUNDAI) as c:
        g = (await c.get(URL, params={"surface": "global"})).json()
    assert g["data"]["url_prompts"] is None and g["meta"]["suppressed"]["url_prompts"] == "not_website_surface"
    async with client_as(ADMIN) as c:
        from tests.support import CUST_PROJECT
        p = (await c.get(URL, params={"surface": "project", "project_id": str(CUST_PROJECT)})).json()
        w = (await c.get(URL, params={"surface": "website"})).json()
    assert p["data"]["url_prompts"] is None and p["meta"]["suppressed"]["url_prompts"] == "not_website_surface"
    assert w["data"]["url_prompts"] is None and w["meta"]["suppressed"]["url_prompts"] == "hidden"
