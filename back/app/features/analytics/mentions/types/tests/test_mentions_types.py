"""GET /v1/mentions/types (M-2) 테스트. 기대값은 합성 픽스처 손 계산(back/tests/fixtures/fixture-10-data.sql).

글로벌 스냅샷(회차 11) 현대 관점: 답변 3(k1·k2·k12). 경쟁·std_in answer_brand 행(유형은 전부 t_mention):
  당사 Hyundai k1 t4(pos 3·neu 1) · k12 t1(pos 1) / 비교 Toyota k1 t3(neu 1·neg 1) · Kia k2 t2(pos 1·mix 1) · smart k2 t1.
  mention: 당사 언급 5·답변 2, 비교 언급 6·답변 2(k1·k2), 점유 5/11.
  매트릭스 mention: own 행 2·pos 4·neu 1, all 행 5·pos 5·neu 2·mix 1·neg 1. 나머지 유형 0.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.cycles import CycleRow, build_window
from app.core.filters import CommonFilters, resolve_read_context
from app.core.measure import MeasureScope
from app.core.sqlguard import fact_guard
from app.features.analytics.mentions.brands.common import MENTIONS_SUPPORT
from app.features.analytics.mentions.brands.tests.mentions_testkit import (
    GLOBAL_PREV,
    GLOBAL_SNAPSHOT,
    BrandRow,
    SynthAnswer,
    borrowed_run,
    brand_keys,
    cycle_row,
    hide,
    insert_answers,
    patch_window,
    prompt_key,
    rollback_tx,
)
from app.features.analytics.mentions.types.queries import stance_sql, types_sql
from app.features.analytics.mentions.types.service import mention_types
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, TODAY, VENDOR, needs_db, principal

URL = "/v1/mentions/types"
TYPES = ["mention", "recommendation", "comparison", "definition", "final_choice"]


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _zero_row(t, den):
    return {"type": t, "own_mentions": 0, "other_mentions": 0, "own_answers": 0, "other_answers": 0,
            "own_exposure": {"num": 0, "den": den}, "other_exposure": {"num": 0, "den": den}, "own_share": {"num": 0, "den": 0}}


@needs_db
async def test_global_hyundai_values(client_as):
    r = await _get(client_as, HQ_HYUNDAI, surface="global", source="news")
    assert r.status_code == 200, r.text
    body = r.json()
    d, m = body["data"], body["meta"]
    assert m["ignored_filters"] == ["source"] and m["suppressed"] == {}
    assert d["stance"] == {"positive": 1, "neutral": 0, "mixed": 0, "negative": 0, "pairs": 1}
    assert d["answers_total"] == 3
    assert [x["type"] for x in d["by_type"]] == TYPES
    assert d["by_type"][0] == {"type": "mention", "own_mentions": 5, "other_mentions": 6, "own_answers": 2, "other_answers": 2,
                               "own_exposure": {"num": 2, "den": 3}, "other_exposure": {"num": 2, "den": 3},
                               "own_share": {"num": 5, "den": 11}}
    assert d["by_type"][1:] == [_zero_row(t, 3) for t in TYPES[1:]]
    mx = {(c["type"], c["scope"]): c for c in d["sentiment_matrix"]}
    assert len(d["sentiment_matrix"]) == 10
    assert mx[("mention", "own")] == {"type": "mention", "scope": "own", "rows": 2, "positive": 4, "neutral": 1, "mixed": 0, "negative": 0}
    assert mx[("mention", "all")] == {"type": "mention", "scope": "all", "rows": 5, "positive": 5, "neutral": 2, "mixed": 1, "negative": 1}
    assert all(c["rows"] == 0 for (t, _), c in mx.items() if t != "mention")


@needs_db
async def test_filters_and_scope(client_as):
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", engine="gemini")).json()["data"]     # k2 만
    assert d["answers_total"] == 1 and (d["by_type"][0]["own_mentions"], d["by_type"][0]["other_mentions"]) == (0, 3)
    assert d["by_type"][0]["other_answers"] == 1
    d = (await _get(client_as, KIA_US, surface="global")).json()["data"]                       # 기아 관점·US: k12 만
    assert d["answers_total"] == 1
    assert (d["by_type"][0]["own_mentions"], d["by_type"][0]["other_mentions"], d["by_type"][0]["other_answers"]) == (0, 1, 1)
    assert next(c for c in d["sentiment_matrix"] if c["scope"] == "all" and c["type"] == "mention")["rows"] == 1   # Toyota(k1) 누출 없음
    d = (await _get(client_as, ADMIN, surface="global")).json()["data"]                        # 전사 관점: Kia 도 당사
    assert (d["by_type"][0]["own_mentions"], d["by_type"][0]["other_mentions"], d["by_type"][0]["own_answers"]) == (7, 4, 3)


@needs_db
async def test_empty_and_denied(client_as):
    r = await _get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2025-01-01", "to": "2025-01-02"})
    d = r.json()["data"]
    assert r.status_code == 200 and d["answers_total"] == 0 and d["by_type"] == [_zero_row(t, 0) for t in TYPES]
    r = await _get(client_as, VENDOR, surface="website")
    assert r.status_code == 403
    r = await _get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2025-01-03", "to": "2025-01-02"})
    assert r.status_code == 422
    assert (await _get(client_as, None, surface="global")).status_code == 401


# DB 를 읽지 않는 형태(가드) 시험용 임의 정수: 픽스처 키와 무관하다(값이 아니라 술어 모양만 본다).
_SYN_CYC, _SYN_PROJECT, _SYN_GEO = 7_011, 7_001, 7_175


def _ms_win():
    d = date(2026, 9, 14)
    win = build_window(surface="global", mode="snapshot", rows=[CycleRow(_SYN_CYC, _SYN_PROJECT, d, 0)], lo=d, hi=d, generation=1,
                       project_keys=(_SYN_PROJECT,))
    ms = MeasureScope(sf=1, project_keys=(_SYN_PROJECT,), own_bits=(1,), bgrps=(1, 5, 8, 9), pop_bits=(1, 8), geo_keys=(_SYN_GEO,))
    return ms, win


def test_types_sql_passes_guard():
    ms, win = _ms_win()
    assert fact_guard(types_sql(ms, win).text) == []


def test_stance_sql_passes_guard():
    """R1 해소(DB-v2.5 rd.answer_stance.cyc_key): 스탠스 문장은 두 사실 표 모두 3술어를 걸어 가드를 통과한다."""
    ms, win = _ms_win()
    t = stance_sql(ms, win).text
    assert fact_guard(t) == [] and "s.cyc_key = ANY(" in t and "a.cyc_key = ANY(" in t


@pytest.mark.parametrize("surface", ["global", "website"])
def test_support_declares_source_ignored(surface):
    from app.features.analytics.mentions.brands.common import MENTIONS_SUPPORT
    assert "source" not in MENTIONS_SUPPORT.for_surface(surface) and "period" in MENTIONS_SUPPORT.for_surface(surface)


def test_suppression_and_runnable_rules():
    """언급 숨김 회차(hidden_scope 3·1)는 전체 억제 hidden, 스냅샷 회차 없음은 no_active_snapshot, 기간 모드 빈 창은 억제 없이 0."""
    from app.features.analytics.mentions.brands.common import runnable, suppression
    d = date(2026, 9, 14)
    hid = build_window(surface="global", mode="snapshot", rows=[CycleRow(_SYN_CYC, _SYN_PROJECT, d, 3)], lo=d, hi=d, generation=1,
                       project_keys=(_SYN_PROJECT,))
    assert suppression(hid) == {"*": "hidden"} and not runnable(hid)
    cit = build_window(surface="global", mode="snapshot", rows=[CycleRow(_SYN_CYC, _SYN_PROJECT, d, 2)], lo=d, hi=d, generation=1,
                       project_keys=(_SYN_PROJECT,))
    assert suppression(cit) == {} and runnable(cit)                   # 인용 숨김은 언급 계열에 영향 없음
    none = build_window(surface="global", mode="snapshot", rows=[], lo=None, hi=None, generation=1, project_keys=(_SYN_PROJECT,))
    assert suppression(none) == {"*": "no_active_snapshot"} and not runnable(none)
    rng = build_window(surface="global", mode="cumulative", rows=[], lo=d, hi=d, generation=1, project_keys=(_SYN_PROJECT,))
    assert suppression(rng) == {} and not runnable(rng)


@needs_db
async def test_mentions_hidden_cycle_over_http(client_as, monkeypatch):
    """회차 언급 숨김(hidden_scope 3) 스냅샷: 전체 억제 hidden + 스탠스 사유, 값은 0(분모 0)."""
    patch_window(monkeypatch, hide([GLOBAL_SNAPSHOT]))
    body = (await _get(client_as, HQ_HYUNDAI, surface="global")).json()
    assert body["meta"]["suppressed"]["*"] == "hidden"
    assert body["data"]["answers_total"] == 0 and body["data"]["by_type"] == [_zero_row(t, 0) for t in TYPES]


@needs_db
async def test_website_and_project_values(client_as):
    """website(KIA_EU, 회차 21 인용 숨김·언급 보임): 답변 2(k21·k22), Kia 당사 k21 언급 1(neu 1). project(VENDOR, 회차 31): 답변 1, 언급 행 없음."""
    r = await _get(client_as, KIA_EU, surface="website")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["answers_total"] == 2
    assert d["by_type"][0] == {"type": "mention", "own_mentions": 1, "other_mentions": 0, "own_answers": 1, "other_answers": 0,
                               "own_exposure": {"num": 1, "den": 2}, "other_exposure": {"num": 0, "den": 2}, "own_share": {"num": 1, "den": 1}}
    mx = {(c["type"], c["scope"]): c for c in d["sentiment_matrix"]}
    assert mx[("mention", "own")] == mx[("mention", "all")] | {"scope": "own"}
    assert mx[("mention", "own")]["rows"] == 1 and mx[("mention", "own")]["neutral"] == 1
    r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["answers_total"] == 1 and d["by_type"] == [_zero_row(t, 1) for t in TYPES]


@needs_db
async def test_cumulative_both_cycles_non_empty(ro, refs):
    """기간 모드 합산: 회차 10 에 std_in 답변(Hyundai 1·pos 1, Toyota 3·neg 1)을 롤백 트랜잭션에 넣는다.
    기대(mention): 답변 3+1, 당사 5+1(답변 2+1), 비교 6+3(답변 2+1), 점유 6/15. 매트릭스 own 행 3·pos 5, all 행 7·neg 2."""
    async with rollback_tx() as (c, tx):
        k = await brand_keys(tx, ["Hyundai", "Toyota"])
        run_key, load_id = await borrowed_run(c, "90000000-0000-4000-8000-000000000001")
        await insert_answers(c, [SynthAnswer(
            answer_key=9_301, cyc=await cycle_row(tx, 1, GLOBAL_PREV), prompt_key=await prompt_key(tx, "b0000000-0000-4000-8000-000000000001"),
            engine_key=refs.engines["chatgpt"][0], geo_key=refs.geo_key("US"), lang_key=refs.langs["en"], bgrp=5,
            brands=(BrandRow(k["Hyundai"], 1, 1, rk=3, pos=1), BrandRow(k["Toyota"], 0, 3, rk=1, neg=1)))], run_key=run_key, load_id=load_id)
        f = CommonFilters.model_validate({"surface": "global", "from": "2026-09-01", "to": "2026-09-30"})
        ctx = await resolve_read_context(tx, await principal(ro, HQ_HYUNDAI), f, support=MENTIONS_SUPPORT, refs=refs)
        win = await ctx.window(tx, today=TODAY)
        d, _ = await mention_types(tx, ctx, win)
        m = d.by_type[0].model_dump()
        assert d.answers_total == 4
        assert (m["own_mentions"], m["own_answers"], m["other_mentions"], m["other_answers"], m["own_share"]) == (6, 3, 9, 3, {"num": 6, "den": 15})
        mx = {(x.type, x.scope): x.model_dump() for x in d.sentiment_matrix}
        assert (mx[("mention", "own")]["rows"], mx[("mention", "own")]["positive"]) == (3, 5)
        assert (mx[("mention", "all")]["rows"], mx[("mention", "all")]["negative"]) == (7, 2)


@needs_db
async def test_stance_values(client_as):
    """스탠스 값 대조(손 계산, fixture-10-data ing.answer_stance): 현대 관점 대표 턴(turn 0) k1 Hyundai positive 1건.
    k1 turn 1(negative)은 대표 턴이 아니고, Toyota·기아 행은 당사가 아니다. 전사 관점(ADMIN)은 k2 기아 mixed 가 더해진다."""
    d = (await _get(client_as, HQ_HYUNDAI, surface="global")).json()
    assert "stance" not in d["meta"]["suppressed"]
    assert d["data"]["stance"] == {"positive": 1, "neutral": 0, "mixed": 0, "negative": 0, "pairs": 1}
    d = (await _get(client_as, ADMIN, surface="global")).json()["data"]
    assert d["stance"] == {"positive": 1, "neutral": 0, "mixed": 1, "negative": 0, "pairs": 2}
