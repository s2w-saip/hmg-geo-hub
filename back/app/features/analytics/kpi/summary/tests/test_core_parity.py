"""이 라운드가 core 에 더한 조각(추가형)의 정합 테스트.

- core.measure.applied_prompt_keys_sql: 행 수 = applied_prompts_sql 카운트(표면·필터별).
- core.measure.measured_prompt_where: count(DISTINCT prompt_key) = fetch_counts(parts 'prompts') measured_prompts.
- core.filters depth4 축: 지원 선언한 엔드포인트만 적용, 선언 없는 FilterSupport 는 meta.ignored_filters 표식(검증 D2: 선언 밖 축 계약).
"""
from __future__ import annotations

from app.core.db import fetch_all, fetch_val
from app.core.filters import KPI_SUPPORT, TAXONOMY_AXES, CommonFilters, FilterSupport, resolve_read_context
from app.core.measure import applied_prompt_keys_sql, applied_prompts_sql, fetch_counts, measured_prompt_where
from app.core.sqlb import Binder
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, TODAY, needs_db, principal

pytestmark = needs_db

CASES = [
    (HQ_HYUNDAI, {"surface": "global"}),
    (HQ_HYUNDAI, {"surface": "global", "funnel": ["F2"]}),
    (HQ_HYUNDAI, {"surface": "global", "lang": ["en"], "country": ["US"]}),
    (KIA_US, {"surface": "global"}),
    (ADMIN, {"surface": "website"}),
    (ADMIN, {"surface": "website", "lang": ["de"]}),
    (ADMIN, {"surface": "project", "project_id": str(CUST_PROJECT)}),
    (ADMIN, {"surface": "global", "from": "2026-09-01", "to": "2026-09-30"}),
]


async def _ctx(ro, uid, params, support=KPI_SUPPORT):
    return await resolve_read_context(ro, await principal(ro, uid), CommonFilters.model_validate(params), support=support)


async def test_applied_and_measured_sets_match_counts(ro):
    for uid, params in CASES:
        ctx = await _ctx(ro, uid, params)
        ms = ctx.measure()
        win = await ctx.window(ro, today=TODAY)
        q = applied_prompts_sql(ms)
        want_applied = int(await fetch_val(ro, q.text, q.params) or 0)
        b = Binder("t")
        keys = await fetch_all(ro, applied_prompt_keys_sql(ms, b), b.params)
        assert len(keys) == len({r["prompt_key"] for r in keys}) == want_applied, params
        want_measured = (await fetch_counts(ro, ms, win, parts=("prompts",)))[0]["measured_prompts"]
        b2 = Binder("t")
        n = await fetch_val(ro, f"SELECT count(DISTINCT a.prompt_key) FROM rd.answer a WHERE {' AND '.join(measured_prompt_where(ms, win, 'a', b2))}",
                            b2.params)
        assert int(n or 0) == want_measured, params


async def test_depth4_declaration_gate(ro):
    no_d4 = FilterSupport.of(global_=("brand", "period", *TAXONOMY_AXES))            # 선언 없음: 적용하지 않고 무시 표식(검증 D2)
    c = await _ctx(ro, HQ_HYUNDAI, {"surface": "global", "depth4": ["ZZZ"]}, support=no_d4)
    assert c.prompt_keys is None and c.ignored_filters == ("depth4",) and c.dropped_filters == {}
    c = await _ctx(ro, HQ_HYUNDAI, {"surface": "global"}, support=no_d4)               # 안 주면 표식 없음
    assert c.ignored_filters == ()
    web_only = FilterSupport.of(global_=("brand",), website=("depth4",))               # 다른 표면에 선언: 이 표면에서는 무시 표식
    c = await _ctx(ro, HQ_HYUNDAI, {"surface": "global", "depth4": ["ZZZ"]}, support=web_only)
    assert c.ignored_filters == ("depth4",) and c.prompt_keys is None
    c = await _ctx(ro, HQ_HYUNDAI, {"surface": "global", "depth4": ["ZZZ"]})           # KPI_SUPPORT: 적용, 카탈로그에 없는 값 = dropped·빈 집합
    assert c.dropped_filters == {"depth4": ("ZZZ",)} and c.prompt_keys == ()
