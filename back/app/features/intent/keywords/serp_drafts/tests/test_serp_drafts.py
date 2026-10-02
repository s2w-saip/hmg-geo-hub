"""intent.keywords.serp_drafts 테스트(가짜 LLM 주입, 외부 호출 없음): 대상 선정·gen 증가·실패 시 쓰기 없음·권한·503·
LLM 대기 중 api_ro 커넥션 미보유(intent R5)."""
from __future__ import annotations

import re

import pytest_asyncio

from app.core import llm as core_llm
from app.core.config import get_settings
from app.core.db import get_db
from app.core.llm import LlmError, get_llm
from app.features.intent.keywords.research.tests import intent_fixtures as fx
from app.main import app
from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, needs_db

pytestmark = needs_db
URL = "/v1/intent/serp-drafts"


def _answer(prompt, schema):
    items = re.findall(r"^\d+\. (.*)$", prompt, flags=re.M)
    return {"questions": [{"originalInput": x, "question": f"Q:{x[:20]}", "searchIntent": "informational"} for x in items]}


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def world(seeded):
    w = await fx.build_kw_world("drafts")
    pr = await fx.create_projects()
    yield w, pr
    app.dependency_overrides.pop(get_llm, None)
    await fx.drop_projects(pr)
    await fx.cleanup_drafts([w.serp_new, w.serp_old, w.serp_stale])


async def _drafts(call_id: int) -> list[tuple]:
    c = await fx.su()
    try:
        return [tuple(r) for r in await c.fetch("SELECT rank, gen, prompt, model FROM app.kw_prompt_draft WHERE serp_call_id = $1 "
                                                "ORDER BY rank, gen", call_id)]
    finally:
        await c.close()


async def test_generate_missing_then_regenerate(client_as, world):
    w, _ = world
    held: list[int] = []

    def answer_and_probe(prompt, schema):
        held.append(get_db().engine("api_ro").pool.checkedout())       # LLM 대기 중 요청이 쥔 api_ro 커넥션 수
        return _answer(prompt, schema)
    fake = fx.FakeLlm(answer_and_probe)
    app.dependency_overrides[get_llm] = lambda: fake
    try:
        async with client_as(ADMIN) as c:
            r = await c.post(URL, json={"serp_call_id": w.serp_new})
            again = await c.post(URL, json={"serp_call_id": w.serp_new})
            regen = await c.post(URL, json={"serp_call_id": w.serp_new, "ranks": [2, 2]})
    finally:
        app.dependency_overrides.pop(get_llm, None)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    # 상위 8행 중 rank 2 는 이미 초안 → 7행, gen 1, 입력 형식 "[term]-title - snippet"
    assert [x["rank"] for x in d["drafts"]] == [1, 3, 4, 5, 6, 7, 8] and {x["gen"] for x in d["drafts"]} == {1}
    assert d["drafts"][0]["prompt"] == f"Q:{f'[{w.fresh}]-title new1 - snippet new1'[:20]}" and d["drafts"][0]["model"] == "fake/model"
    assert d["skipped_count"] == 0
    assert len(fake.calls) == 2 and f"1. [{w.fresh}]-title new1 - snippet new1" in fake.calls[0]
    assert again.json()["data"]["drafts"] == []                         # 대상 없음 → LLM 미호출
    assert held == [0, 0]            # intent R5: CurrentUserDetached + RoSession 이라 LLM 동안 api_ro 커넥션을 쥐지 않는다
    assert [(x["rank"], x["gen"]) for x in regen.json()["data"]["drafts"]] == [(2, 3)]
    rows = await _drafts(w.serp_new)
    assert len(rows) == 7 + 3 and (2, 3, f"Q:{f'[{w.fresh}]-title new2 - snippet new2'[:20]}", "fake/model") in rows
    # insight 가 최신 gen 초안을 싣는다
    async with client_as(ADMIN) as c:
        ins = (await c.get("/v1/intent/insight", params={"term": w.fresh, "country": "us"})).json()["data"]["serp"]
    assert ins[1]["draft_gen"] == 3 and ins[0]["suggested_prompt"].startswith("Q:")


async def test_llm_failure_writes_nothing(client_as, world):
    """이 테스트만 쓰는 2행 SERP(고유 call_id): 공용 serp_stale 은 다른 테스트가 rank 1 초안을 써서 순서에 따라 대상 수가 달라진다."""
    call = await fx.new_serp(fx.uniq("serp fail drafts"), 2, tag="fail")

    def boom(prompt, schema):
        raise LlmError("upstream", "down")
    app.dependency_overrides[get_llm] = lambda: fx.FakeLlm(boom)
    try:
        async with client_as(ADMIN) as c:
            r = await c.post(URL, json={"serp_call_id": call})
            partial_app = fx.FakeLlm(lambda p, s: {"questions": []})
            app.dependency_overrides[get_llm] = lambda: partial_app
            empty = await c.post(URL, json={"serp_call_id": call})
    finally:
        app.dependency_overrides.pop(get_llm, None)
        await fx.cleanup_drafts([call])
    assert r.status_code == 502 and r.json()["error"]["code"] == "llm_failed"
    assert empty.status_code == 200 and empty.json()["data"] == {"serp_call_id": call, "drafts": [], "skipped_count": 2}
    assert await _drafts(call) == []


async def test_validation_permissions_unavailable(client_as, world, monkeypatch):
    w, pr = world
    await fx.add_tracked(pr.own, w.fresh, None)     # 프로젝트(US)가 이 키워드를 추적 → US SERP 초안은 프로젝트 권한(검증 D5)
    app.dependency_overrides[get_llm] = lambda: fx.FakeLlm(_answer)
    try:
        async with client_as(ADMIN) as c:
            unknown = await c.post(URL, json={"serp_call_id": w.serp_old, "ranks": [99]})
            nocall = await c.post(URL, json={"serp_call_id": 1})
            bad = await c.post(URL, json={"serp_call_id": w.serp_old, "ranks": []})
        async with client_as(HQ_HYUNDAI) as c:
            no_pid = await c.post(URL, json={"serp_call_id": w.serp_old})
            own = await c.post(URL, json={"serp_call_id": w.serp_old, "project_id": str(pr.own), "ranks": [1]})
        async with client_as(KIA_US) as c:
            kia = await c.post(URL, json={"serp_call_id": w.serp_old})
    finally:
        app.dependency_overrides.pop(get_llm, None)
    assert unknown.status_code == 422 and unknown.json()["error"]["code"] == "unknown_rank"
    assert nocall.status_code == 404 and bad.status_code == 422
    assert no_pid.status_code == 403 and own.status_code == 200 and own.json()["data"]["drafts"][0]["rank"] == 1
    assert kia.status_code == 403
    no_key = get_settings().model_copy(update={"openrouter_api_key": None})
    monkeypatch.setattr(core_llm, "get_settings", lambda: no_key)      # core.llm.get_llm 이 읽는 설정(키 미설정)
    async with client_as(ADMIN) as c:                      # 가짜 미주입 + 키 미설정 → 권한 통과 뒤 503
        r = await c.post(URL, json={"serp_call_id": w.serp_old, "ranks": [2]})
    assert r.status_code == 503 and r.json()["error"]["code"] == "llm_unavailable"


# ── 검증 D3·D5: 메뉴 게이트, project_id 경로는 SERP 가 그 프로젝트 추적 키워드(유효 국가)와 맞을 때만 ──
async def test_menu_gate_and_project_binding_d3_d5(client_as, world):
    w, pr = world
    own_kr = await fx.create_project("Hyundai", "KR", member=(HQ_HYUNDAI, "owner"))
    prj = fx.temp_user("hq", "global", ("Hyundai",), ("project",))
    await fx.create_users([prj])
    fake = fx.FakeLlm(_answer)
    app.dependency_overrides[get_llm] = lambda: fake
    try:
        async with client_as(HQ_HYUNDAI) as c:
            # 검증 재현: KR 프로젝트 id 로 US SERP 전역 초안 → 403(배정 운영자, 프로젝트에 묶이지 않은 SERP)
            kr = await c.post(URL, json={"serp_call_id": w.serp_stale, "project_id": str(own_kr), "ranks": [1]})
            await fx.add_tracked(own_kr, w.stale, None)          # KR 프로젝트가 같은 term 을 KR 로 추적해도 US SERP 와는 다르다
            kr2 = await c.post(URL, json={"serp_call_id": w.serp_stale, "project_id": str(own_kr), "ranks": [1]})
            await fx.add_tracked(own_kr, w.stale, "us")          # 같은 term 을 US 로 추적하면 프로젝트 권한으로 허용
            kr3 = await c.post(URL, json={"serp_call_id": w.serp_stale, "project_id": str(own_kr), "ranks": [1]})
        async with client_as(prj.uid) as c:                      # 전역 운영자라도 표준 메뉴가 없으면 프로젝트 없는 초안 403
            menu = await c.post(URL, json={"serp_call_id": w.serp_stale, "ranks": [1]})
    finally:
        app.dependency_overrides.pop(get_llm, None)
        await fx.drop_users([prj])
        await fx.drop_project_ids([own_kr])
    assert kr.status_code == 403 and kr.json()["error"]["code"] == "operator_forbidden"
    assert kr2.status_code == 403
    assert kr3.status_code == 200 and [d["rank"] for d in kr3.json()["data"]["drafts"]] == [1]
    assert menu.status_code == 403 and menu.json()["error"]["code"] == "menu_forbidden"
    assert len(fake.calls) == 1
