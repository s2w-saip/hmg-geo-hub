"""GET /v1/mentions/prompts (M-3) 테스트. 기대값은 합성 픽스처 손 계산(back/tests/fixtures/fixture-10-data.sql).

글로벌 스냅샷(회차 11) 현대 관점 경쟁·std_in answer_brand 행:
  Hyundai(1) k1 프롬프트 1(chatgpt·US) 4 rk 2 pos 3 neu 1 · k12 프롬프트 3(chatgpt·US) 1 rk 1 pos 1
  Toyota(61) k1 프롬프트 1 3 rk 1 · Kia(2) k2 프롬프트 1(gemini) 2 · smart(56) k2 프롬프트 1 1
  brand=1 → [프롬프트 1: 4, 프롬프트 3: 1] 합 5. signal=positive(당사 s_pos) → [1: 3, 3: 1] 합 4 = M-1 당사 긍정.
대표·runs 시험은 셀(프롬프트 1·chatgpt·US)에 답변 2건(9001 is_rep, 9002)과 셀(프롬프트 1·gemini·US)에 9003 을 롤백 트랜잭션 안에서만 넣는다.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from app.core.codes import brand_masks
from app.core.cycles import build_window
from app.core.filters import resolve_read_context
from app.core.measure import MeasureScope
from app.core.sqlb import render_literals
from app.core.sqlguard import fact_guard
from app.features.analytics.mentions.brands.common import MENTIONS_SUPPORT
from app.features.analytics.mentions.brands.tests.mentions_testkit import (
    GLOBAL_PREV,
    GLOBAL_SNAPSHOT,
    BrandRow,
    SynthAnswer,
    borrowed_run,
    brand_keys,
    bump_generation,
    cycle_row,
    hide,
    insert_answers,
    patch_window,
    prompt_key,
    rollback_tx,
    root_project_key,
)
from app.features.analytics.mentions.prompts.queries import TargetSpec, answers_sql, page_sql
from app.features.analytics.mentions.prompts.schemas import PromptsQuery
from app.features.analytics.mentions.prompts.service import mention_prompts
from tests.support import CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, TEST_NAME_KEY, TODAY, VENDOR, needs_db, principal

pytestmark = needs_db
URL = "/v1/mentions/prompts"
P1 = "b0000000-0000-4000-8000-000000000001"
P3 = "b0000000-0000-4000-8000-000000000003"
P21 = "b0000000-0000-4000-8000-000000000021"
J1 = "90000000-0000-4000-8000-000000000001"
NAMES = ["Hyundai", "Kia", "Toyota"]


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


async def test_brand_mode_shape_and_values(client_as, ro):
    k = await brand_keys(ro, NAMES)
    r = await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", brand_key=k["Hyundai"])
    assert r.status_code == 200, r.text
    body = r.json()
    d, m = body["data"], body["meta"]
    assert d["mode"] == "brand" and d["target"] == {"brand_key": k["Hyundai"], "name": "Hyundai", "signal": None} and d["total"] == 5
    assert m["page"] == {"next_cursor": None, "limit": 50, "total": 2} and m["as_of"] == "2026-09-14"
    assert [(i["prompt_id"], i["count"], i["share"]) for i in d["items"]] == [
        (P1, 4, {"num": 4, "den": 5}), (P3, 1, {"num": 1, "den": 5})]
    i1 = d["items"][0]
    assert (i1["prompt_text"], i1["funnel_code"], i1["providers"]) == ("best suv", "F1", ["chatgpt"])
    assert i1["answers"] == [{"job_id": "90000000-0000-4000-8000-000000000001", "engine": "chatgpt", "region": "US", "value": 4,
                              "position": 2, "measured_at": "2026-09-14T01:00:00Z", "runs": 1}]


async def test_signal_mode_and_invariants(client_as):
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="signal", signal="positive")).json()["data"]
    assert d["target"] == {"brand_key": None, "name": None, "signal": "positive"}
    assert [(i["prompt_id"], i["count"]) for i in d["items"]] == [(P1, 3), (P3, 1)] and d["total"] == 4
    async with client_as(HQ_HYUNDAI) as c:
        m1 = (await c.get("/v1/mentions/brands", params={"surface": "global"})).json()["data"]
    own = next(b for b in m1["brands"] if b["is_own"])
    toyota = next(b for b in m1["brands"] if b["name"] == "Toyota")
    assert d["total"] == own["sentiment"]["positive"]                                         # 불변식: signal=positive 합 = 당사 s_pos 합
    t = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", brand_key=toyota["brand_key"])).json()["data"]
    assert t["total"] == toyota["mentions"] == 3                                               # 불변식: brand 모드 합 = M-1 브랜드 언급
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="signal", signal="final_choice")).json()
    assert d["data"]["items"] == [] and d["data"]["total"] == 0 and d["meta"]["page"]["total"] == 0


async def test_keyset_pagination_and_cursor_checks(client_as, ro, monkeypatch):
    k = await brand_keys(ro, NAMES)
    base = {"surface": "global", "mode": "brand", "brand_key": k["Hyundai"], "limit": 1}
    r1 = (await _get(client_as, HQ_HYUNDAI, **base)).json()
    assert [i["prompt_id"] for i in r1["data"]["items"]] == [P1] and r1["meta"]["page"]["total"] == 2
    cur = r1["meta"]["page"]["next_cursor"]
    assert cur
    r2 = (await _get(client_as, HQ_HYUNDAI, **base, cursor=cur)).json()
    assert [i["prompt_id"] for i in r2["data"]["items"]] == [P3] and r2["meta"]["page"]["next_cursor"] is None
    assert r2["data"]["total"] == 5                                                   # 합계는 페이지와 무관
    r = await _get(client_as, HQ_HYUNDAI, **{**base, "engine": "chatgpt"}, cursor=cur)   # 다른 필터로 재사용
    assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
    r = await _get(client_as, HQ_HYUNDAI, **base, cursor="not-a-cursor")
    assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
    patch_window(monkeypatch, bump_generation)                                          # 적재로 데이터 세대가 바뀐 뒤 같은 커서
    r = await _get(client_as, HQ_HYUNDAI, **base, cursor=cur)
    assert r.status_code == 409 and r.json()["error"]["code"] == "cursor_stale"
    r = await _get(client_as, HQ_HYUNDAI, **base)                                        # 첫 페이지 재조회는 정상
    assert r.status_code == 200 and r.json()["meta"]["page"]["next_cursor"]


async def test_filters_scope_and_errors(client_as, ro):
    k = await brand_keys(ro, NAMES)
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", brand_key=k["Hyundai"], funnel="F2")).json()["data"]
    assert d["items"] == [] and d["total"] == 0                                        # 필터 전후 값 변화
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", brand_key=k["Kia"])).json()["data"]
    assert [(i["count"], i["providers"]) for i in d["items"]] == [(2, ["gemini"])]
    d = (await _get(client_as, KIA_US, surface="global", mode="brand", brand_key=k["Toyota"])).json()["data"]
    assert d["items"] == [] and d["total"] == 0                                        # Toyota(k1, bgrp 5)는 기아 관점 모수 밖: 누출 0
    d = (await _get(client_as, KIA_US, surface="global", mode="brand", brand_key=k["Hyundai"])).json()["data"]
    assert [(i["prompt_id"], i["count"]) for i in d["items"]] == [(P3, 1)]
    r = await _get(client_as, HQ_HYUNDAI, surface="global", mode="brand", brand_key=2**31 - 1)     # int4 상한 이내·없는 키
    assert r.status_code == 404 and r.json()["error"]["code"] == "brand_not_found"
    assert (await _get(client_as, VENDOR, surface="global", mode="signal", signal="positive")).status_code == 403
    assert (await _get(client_as, None, surface="global", mode="signal", signal="positive")).status_code == 401


@pytest.mark.parametrize("params", [
    {"mode": "brand"}, {"mode": "signal"}, {}, {"mode": "x", "brand_key": 1}, {"mode": "signal", "signal": "joy"},
    {"mode": "brand", "brand_key": 0}, {"mode": "brand", "brand_key": 2**31}, {"mode": "brand", "brand_key": 2**63},
    {"mode": "brand", "brand_key": 10**30}, {"mode": "brand", "brand_key": 1, "limit": 0}, {"mode": "brand", "brand_key": 1, "limit": 201},
    {"mode": "brand", "brand_key": 1, "answers_limit": 51}])
async def test_bad_params_422(client_as, params):
    r = await _get(client_as, HQ_HYUNDAI, surface="global", **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"


_AT4, _AT6 = datetime(2026, 9, 14, 4, tzinfo=UTC), datetime(2026, 9, 14, 6, tzinfo=UTC)
_EXTRA = [  # (answer_key, 엔진, is_rep, Toyota 언급 수, 측정 시각): 9002 가 더 최신이고 값도 크지만 셀 대표는 is_rep 인 9001
    (9001, "chatgpt", True, 1, _AT4), (9002, "chatgpt", False, 5, _AT6), (9003, "gemini", False, 2, _AT4)]


async def test_answers_cell_representative_and_runs(refs):
    """R05 셀 대표·runs·answers_limit: 셀(프롬프트 1·chatgpt·US)에 답변 2건, 셀(프롬프트 1·gemini·US)에 1건을 소유자 접속 트랜잭션에
    COPY 로 넣고(커밋하지 않고 롤백) 빌더 문장(page_sql·answers_sql)을 같은 트랜잭션에서 실행한다. 다른 시험·빌더에 영향 없음."""
    async with rollback_tx() as (c, tx):
        k = await brand_keys(tx, NAMES)
        pk1 = await prompt_key(tx, P1)
        cyc = await cycle_row(tx, 1, GLOBAL_SNAPSHOT)
        run_key, load_id = await borrowed_run(c, J1)
        root = root_project_key(refs)
        ms = MeasureScope(sf=1, project_keys=(root,), own_bits=(1,), bgrps=tuple(brand_masks(1 | refs.umbrella_bit, refs.bit_universe)),
                          pop_bits=(1, refs.umbrella_bit))
        d = cyc.round_date
        win = build_window(surface="global", mode="snapshot", rows=[cyc], lo=d, hi=d, generation=1, project_keys=(root,))
        spec = TargetSpec("brand", brand_key=k["Toyota"])
        toyota_fixture = 2 if TEST_NAME_KEY else 3       # 픽스처 J1 의 Toyota 언급: NAME 은 'TOYOTA'(1)가 다른 표시 브랜드 행(운영 생성기와 같다)
        await insert_answers(c, [SynthAnswer(answer_key=ak, cyc=cyc, prompt_key=pk1, engine_key=refs.engines[eng][0], geo_key=refs.geo_key("US"),
                                             lang_key=refs.langs["en"], bgrp=5, brands=(BrandRow(k["Toyota"], 0, m, rk=1),), is_rep=rep,
                                             measured_at=at) for ak, eng, rep, m, at in _EXTRA], run_key=run_key, load_id=load_id)
        q = page_sql(ms, win, spec, cursor=None, limit=10)
        assert fact_guard(q.text) == []
        page = await c.fetch(render_literals(q))
        assert [(r["prompt_key"], r["cnt"], r["total"], sorted(r["engines"])) for r in page] == [
            (pk1, toyota_fixture + 1 + 5 + 2, toyota_fixture + 8, sorted([refs.engines["chatgpt"][0], refs.engines["gemini"][0]]))]
        a = answers_sql(ms, win, spec, prompt_keys=[pk1], answers_limit=6)
        assert fact_guard(a.text) == []
        got = [(r["job_id"], r["engine"], r["val"], r["runs"]) for r in await c.fetch(render_literals(a))]
        assert got == [(uuid.UUID(int=9003), "gemini", 2, 1), (uuid.UUID(int=9001), "chatgpt", 1, 3)]   # is_rep 우선, 값 내림차순
        a1 = answers_sql(ms, win, spec, prompt_keys=[pk1], answers_limit=1)
        assert [r["engine"] for r in await c.fetch(render_literals(a1))] == ["gemini"]


async def test_mentions_hidden_cycle_over_http(client_as, ro, monkeypatch):
    """회차 언급 숨김(hidden_scope 3) 스냅샷: 목록 비고 합계 0, meta.suppressed = hidden."""
    k = await brand_keys(ro, NAMES)
    patch_window(monkeypatch, hide([GLOBAL_SNAPSHOT]))
    for params in ({"mode": "brand", "brand_key": k["Hyundai"]}, {"mode": "signal", "signal": "positive"}):
        body = (await _get(client_as, HQ_HYUNDAI, surface="global", **params)).json()
        assert body["meta"]["suppressed"] == {"*": "hidden"}, body
        assert body["data"]["items"] == [] and body["data"]["total"] == 0 and body["meta"]["page"]["total"] == 0


async def test_website_and_project_values(client_as, ro):
    """website(KIA_EU, 회차 21 인용 숨김·언급 보임): k21 Kia 1(neu 1) → 프롬프트 21. project(VENDOR, 회차 31): 언급 행 없음 → 0."""
    k = await brand_keys(ro, NAMES)
    for params in ({"mode": "brand", "brand_key": k["Kia"]}, {"mode": "signal", "signal": "neutral"}, {"mode": "signal", "signal": "mention"}):
        r = await _get(client_as, KIA_EU, surface="website", **params)
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert [(i["prompt_id"], i["count"], i["providers"]) for i in d["items"]] == [(P21, 1, ["chatgpt"])] and d["total"] == 1, params
        assert d["items"][0]["answers"][0]["region"] == "DE"
    d = (await _get(client_as, KIA_EU, surface="website", mode="signal", signal="positive")).json()["data"]
    assert d["items"] == [] and d["total"] == 0
    r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), mode="signal", signal="mention")
    assert r.status_code == 200 and r.json()["data"]["items"] == [] and r.json()["data"]["total"] == 0
    r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), mode="brand", brand_key=k["Hyundai"])
    assert r.status_code == 200 and r.json()["data"]["total"] == 0


async def test_cumulative_both_cycles_non_empty(ro, refs):
    """기간 모드 합산: 회차 10 에 Toyota 3 언급 답변(프롬프트 1)을 롤백 트랜잭션에 넣으면 Toyota 프롬프트 1 = 스냅샷 3 + 3."""
    async with rollback_tx() as (c, tx):
        k = await brand_keys(tx, NAMES)
        pk1 = await prompt_key(tx, P1)
        run_key, load_id = await borrowed_run(c, J1)
        await insert_answers(c, [SynthAnswer(
            answer_key=9_201, cyc=await cycle_row(tx, 1, GLOBAL_PREV), prompt_key=pk1, engine_key=refs.engines["gemini"][0],
            geo_key=refs.geo_key("US"), lang_key=refs.langs["en"], bgrp=5, brands=(BrandRow(k["Toyota"], 0, 3, rk=1),))],
            run_key=run_key, load_id=load_id)
        p = await principal(ro, HQ_HYUNDAI)
        out = {}
        for label, extra in (("snap", {}), ("range", {"from": "2026-09-01", "to": "2026-09-30"})):
            q = PromptsQuery.model_validate({"surface": "global", "mode": "brand", "brand_key": k["Toyota"], **extra})
            ctx = await resolve_read_context(tx, p, q, support=MENTIONS_SUPPORT, refs=refs)
            win = await ctx.window(tx, today=TODAY)
            out[label] = (await mention_prompts(tx, ctx, win, q, custom={}))[0]
        assert [(str(i.prompt_id), i.count, sorted(i.providers)) for i in out["snap"].items] == [(P1, 3, ["chatgpt"])]
        r = out["range"]
        assert r.total == 6 and [(str(i.prompt_id), i.count, sorted(i.providers)) for i in r.items] == [(P1, 6, ["chatgpt", "gemini"])]
        assert sorted((a.engine, a.value, a.measured_at.date().isoformat()) for a in r.items[0].answers) == [
            ("chatgpt", 3, "2026-09-14"), ("gemini", 3, "2026-09-07")]
