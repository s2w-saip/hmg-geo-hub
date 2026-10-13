"""intent.social.prompts 테스트(가짜 LLM, 외부 호출 없음): 시드 선정(손계산)·제외 집합·조합 정규화·동시 생성 충돌·유사도·
소프트 삭제·권한·스냅샷 없음·LLM 실패 시 쓰기 없음·LLM 대기 중 api_ro 커넥션 미보유(intent R5).

테스트마다 자기 임시 프로젝트를 만든다(_projects): 생성물·제외 집합이 프로젝트 단위라 공용 프로젝트를 쓰면 실행 순서에 따라 기대값이 바뀐다."""
from __future__ import annotations

import contextlib
import math
import re
import uuid

import pytest_asyncio

from app.core import llm as core_llm
from app.core.config import get_settings, set_settings
from app.core.db import get_db
from app.core.llm import LlmError, get_llm
from app.features.intent.keywords.research.tests import intent_fixtures as fx
from app.main import app
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db
URL = "/v1/intent/social/prompts"
SNAP = 30011


def answer(prompt, schema):
    """시드마다 '<concept> 추천해줘', 퍼널 consideration."""
    rows = re.findall(r"^- seedId=(\S+) \[[^\]]+\] concept: (.*)$", prompt, flags=re.M)
    return {"prompts": [{"seedId": k, "question": f"{c} 추천해줘", "funnelStage": "consideration"} for k, c in rows]}


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def world(seeded):
    w = await fx.build_ctx_world(SNAP)
    base = get_settings()
    # 컨텍스트 맵 산업·키워드 = core.config(intent R2: 기능 안 설정 모델 get_ctx_config 폐기)
    set_settings(base.model_copy(update={"context_map_industry_entity_id": w.industry, "context_map_keyword": "자동차"}))
    yield w
    set_settings(base)
    app.dependency_overrides.pop(get_llm, None)
    await fx.drop_ctx_world(SNAP)


@contextlib.asynccontextmanager
async def _projects():
    pr = await fx.create_projects()
    try:
        yield pr
    finally:
        await fx.drop_projects(pr)


def _use_industry(industry: uuid.UUID) -> None:
    set_settings(get_settings().model_copy(update={"context_map_industry_entity_id": industry}))


def _llm(fake):
    app.dependency_overrides[get_llm] = lambda: fake
    return fake


async def _db_rows(pid) -> list[dict]:
    c = await fx.su()
    try:
        return [dict(r) for r in await c.fetch("SELECT seed_key, text, layer, funnel_stage, priority, origin, batch_no, removed_at, "
                                               "seed_entity_ids, model FROM app.ctx_generated_prompt WHERE project_id = $1 "
                                               "ORDER BY batch_no, priority DESC, seed_key", pid)]
    finally:
        await c.close()


async def _generate_two_batches(c, pid) -> tuple:
    b1 = await c.post(URL, params={"project_id": str(pid)}, json={"mode": "more"})
    b2 = await c.post(URL, params={"project_id": str(pid)}, json={"mode": "more"})
    return b1, b2


async def test_more_batches_until_exhausted(client_as, world):
    w = world
    C1, C2, C3 = w.ctx
    R1, R2, R3, R4 = w.cond
    held: list[int] = []

    def answer_and_probe(prompt, schema):
        held.append(get_db().engine("api_ro").pool.checkedout())       # LLM 대기 중 요청이 쥔 api_ro 커넥션 수
        return answer(prompt, schema)
    fake = _llm(fx.FakeLlm(answer_and_probe))
    async with _projects() as pr:
        async with client_as(HQ_HYUNDAI) as c:
            b1, b2 = await _generate_two_batches(c, pr.own)
            b3 = await c.post(URL, params={"project_id": str(pr.own)}, json={"mode": "more"})
        rows = await _db_rows(pr.own)
    assert b1.status_code == 200, b1.text
    assert held == [0, 0]            # intent R5: CurrentUserDetached + RoSession 이라 LLM 동안 api_ro 커넥션을 쥐지 않는다

    def k(a, b):
        x, y = sorted((str(a), str(b)))
        return f"l3-{x}:{y}"
    # 배치 1: 맥락 3·조건 4·조합 4(우선순위 = 최댓값 대비 반올림), 우선순위 내림차순(동률은 LLM 응답 순서)
    got = [(p["seed_key"], p["priority"], p["layer"]) for p in b1.json()["data"]["prompts"]]
    assert got == [(f"l1-{C1}", 100, "L1-context"), (f"l2-{R1}", 100, "L2-condition"), (k(R1, R2), 100, "L3-intersection"),
                   (f"l1-{C2}", 60, "L1-context"), (f"l2-{R2}", 50, "L2-condition"), (k(R1, R3), 40, "L3-intersection"),
                   (f"l2-{R3}", 38, "L2-condition"), (k(R2, R3), 30, "L3-intersection"), (f"l1-{C3}", 20, "L1-context"),
                   (k(R3, R4), 17, "L3-intersection"), (f"l2-{R4}", 13, "L2-condition")]
    p0 = b1.json()["data"]["prompts"][0]
    assert p0["question"] == "주말 가족 여행 추천해줘" and p0["funnel_stage"] == "consideration" and p0["origin"] is None
    assert p0["batch_no"] == 1 and p0["model"] == "fake/model" and b1.json()["data"]["exhausted"] is False
    assert "The project tracks the brand \"Hyundai\" in the 자동차 category." in fake.calls[0]
    # 배치 2: 엔티티·조합 소진 → 구동 관계 대체(강도 high 85, 나머지 70), co_count 내림차순
    assert [(p["seed_key"], p["priority"]) for p in b2.json()["data"]["prompts"]] == [
        (f"l3-{C1}-{R1}", 85), (f"l3-{C2}-{R1}", 70), (f"l3-{C1}-{R2}", 70), (f"l3-{C1}-{R3}", 70)]
    assert {p["batch_no"] for p in b2.json()["data"]["prompts"]} == {2}
    assert b3.json()["data"] == {"prompts": [], "exhausted": True, "skipped_existing": 0} and len(fake.calls) == 2
    assert len(rows) == 15 and rows[0]["seed_entity_ids"] == [C1]
    combo = next(r for r in rows if r["seed_key"] == k(R1, R2))
    assert sorted(combo["seed_entity_ids"]) == sorted([R1, R2])


async def test_selected_normalizes_and_skips(client_as, world):
    w = world
    C1, C2, C3 = w.ctx
    R1, R2, R3, R4 = w.cond
    fake = _llm(fx.FakeLlm(answer))
    sel = {"context_ids": [str(C1), str(R1), str(uuid.uuid4())], "condition_ids": [str(R2)],
           "combinations": [{"cond_a_id": str(R3), "cond_b_id": str(R1)}], "cross": True}
    async with _projects() as pr, client_as(ADMIN) as c:
        r = await c.post(URL, params={"project_id": str(pr.other)}, json={"mode": "selected", "selection": sel})
        again = await c.post(URL, params={"project_id": str(pr.other)}, json={"mode": "selected", "selection": {
            **sel, "combinations": [{"cond_a_id": str(R1), "cond_b_id": str(R3)}]}})
    x, y = sorted((str(R1), str(R3)))
    d = r.json()["data"]
    assert [(p["seed_key"], p["priority"], p["origin"], p["source_label"]) for p in d["prompts"]] == [
        (f"l1-{C1}", 100, "composed", "주말 가족 여행"), (f"l2-{R2}", 100, "composed", "50% 할인"),
        (f"l3-{C1}-{R2}", 100, "composed", "주말 가족 여행 × 50% 할인"), (f"l3-{x}:{y}", 80, "composed", "넓은 트렁크 × 연비 좋은 차")]
    assert d["skipped_existing"] == 0 and d["exhausted"] is False
    # 같은 선택 재요청(조합은 반대 방향) → 전부 이미 생성, LLM 미호출
    assert again.json()["data"] == {"prompts": [], "exhausted": False, "skipped_existing": 4} and len(fake.calls) == 1


async def test_concurrent_conflict_and_partial_output(client_as, world):
    w = world
    C1, C2, C3 = w.ctx
    R1, R2, R3, R4 = w.cond
    async with _projects() as pr:
        async def racing(prompt, schema):       # LLM 대기 중 다른 요청이 같은 시드를 먼저 저장
            c = await fx.su()
            try:
                await c.execute("INSERT INTO app.ctx_generated_prompt (project_id, batch_no, text, seed_key) VALUES ($1, 9, 'race', $2)",
                                pr.other, f"l1-{C2}")
            finally:
                await c.close()
            return answer(prompt, schema)
        _llm(fx.FakeLlm(racing))
        async with client_as(ADMIN) as c:
            r = await c.post(URL, params={"project_id": str(pr.other)},
                             json={"mode": "selected", "selection": {"context_ids": [str(C2)]}})
            _llm(fx.FakeLlm(lambda p, s: {"prompts": [{"seedId": f"l1-{C3}", "question": " 출퇴근 차 ", "funnelStage": "bogus"},
                                                        {"seedId": "l9-unknown", "question": "x", "funnelStage": "purchase"}]}))
            part = await c.post(URL, params={"project_id": str(pr.other)},
                                json={"mode": "selected", "selection": {"context_ids": [str(C3)], "condition_ids": [str(R4)]}})
        keys = {r["seed_key"] for r in await _db_rows(pr.other)}
    assert r.json()["data"] == {"prompts": [], "exhausted": False, "skipped_existing": 1}
    pd = part.json()["data"]
    assert [(p["seed_key"], p["question"], p["funnel_stage"]) for p in pd["prompts"]] == [(f"l1-{C3}", "출퇴근 차", None)]
    assert f"l1-{C3}" in keys and f"l2-{R4}" not in keys          # LLM 이 답하지 않은 시드는 저장 안 함(다음에 다시 생성 가능)


async def test_list_similarity_and_soft_delete(client_as, world):
    w = world
    C1 = w.ctx[0]
    async with _projects() as pr:
        c0 = await fx.su()
        try:
            await c0.execute("INSERT INTO app.prompt_candidate (project_id, source, text) VALUES ($1, 'manual', '주말 가족 여행 차 추천해줘'), "
                             "($1, 'manual', '출퇴근 추천해줘')", pr.own)
        finally:
            await c0.close()
        _llm(fx.FakeLlm(answer))
        async with client_as(HQ_HYUNDAI) as c:           # 자기 준비: 자동 배치 2회로 15행(배치 1 = 11, 배치 2 = 4)
            b1, b2 = await _generate_two_batches(c, pr.own)
        assert (b1.status_code, b2.status_code) == (200, 200)
        # 생성 응답의 '이미 추가됨': 후보와 정확히 같은 '출퇴근 추천해줘'(C3 맥락)만. 비슷한 '주말 가족 여행 추천해줘' 는 아님
        generated = [*b1.json()["data"]["prompts"], *b2.json()["data"]["prompts"]]
        assert {p["seed_key"] for p in generated if p["in_candidate_pool"]} == {f"l1-{w.ctx[2]}"}
        async with client_as(VENDOR) as c:
            assert (await c.get(URL, params={"project_id": str(CUST_PROJECT)})).json()["data"]["items"] == []
        async with client_as(HQ_HYUNDAI) as c:
            items = (await c.get(URL, params={"project_id": str(pr.own)})).json()["data"]["items"]
            assert len(items) == 15 and [i["batch_no"] for i in items] == [1] * 11 + [2] * 4
            sims = {i["seed_key"]: i["similar_to"] for i in items if i["similar_to"]}
            # '주말 가족 여행 추천해줘' vs 후보 '주말 가족 여행 차 추천해줘': 공통 bigram 8 / √(9·10) (손계산), 같은 텍스트('출퇴근 추천해줘')는 제외
            assert sims[f"l1-{C1}"] == {"text": "주말 가족 여행 차 추천해줘", "score": round(8 / math.sqrt(90), 4), "kind": "candidate"}
            # '출퇴근 추천해줘' 는 후보와 정확히 같아(추가됨 상태) 제외, 다른 후보와는 3/√60≈0.39 < 0.5
            assert f"l1-{w.ctx[2]}" not in sims and f"l2-{w.cond[3]}" not in sims
            # 목록의 '이미 추가됨' = 후보 풀 텍스트와 정확히 같은 행(현행 addedTexts 포함 판정)
            assert {i["seed_key"] for i in items if i["in_candidate_pool"]} == {f"l1-{w.ctx[2]}"}
            target = next(i["prompt_id"] for i in items if i["seed_key"] == f"l1-{C1}")
            d1 = await c.request("DELETE", URL, params={"project_id": str(pr.own), "ids": [target]})
            d2 = await c.request("DELETE", URL, params={"project_id": str(pr.own), "ids": [target]})
            after = (await c.get(URL, params={"project_id": str(pr.own)})).json()["data"]["items"]
            more = await c.post(URL, params={"project_id": str(pr.own)}, json={"mode": "more"})
    assert d1.json()["data"]["removed_count"] == 1 and d2.json()["data"]["removed_count"] == 0
    assert len(after) == 14 and target not in {i["prompt_id"] for i in after}
    assert more.json()["data"]["exhausted"] is True                 # 삭제한 시드도 제외 집합에 남는다


async def test_permissions_validation_and_failures(client_as, world, monkeypatch):
    w = world
    _llm(fx.FakeLlm(answer))
    async with _projects() as pr:
        c0 = await fx.su()                               # 자기 준비: 내 프로젝트 생성물 1행(다른 프로젝트 id 로 삭제 시도용)
        try:
            oid = str(await c0.fetchval("INSERT INTO app.ctx_generated_prompt (project_id, batch_no, text, seed_key) "
                                        "VALUES ($1, 1, 'perm probe', 'l1-perm-probe') RETURNING prompt_id", pr.own))
        finally:
            await c0.close()
        async with client_as(VENDOR) as c:
            r = await c.post(URL, params={"project_id": str(CUST_PROJECT)}, json={"mode": "more"})
            assert r.status_code == 403 and r.json()["error"]["code"] == "operator_forbidden"
            assert (await c.request("DELETE", URL, params={"project_id": str(CUST_PROJECT), "ids": [str(uuid.uuid4())]})).status_code == 403
        async with client_as(KIA_US) as c:
            assert (await c.get(URL, params={"project_id": str(pr.own)})).status_code == 404
        async with client_as(HQ_HYUNDAI) as c:
            assert (await c.post(URL, params={"project_id": str(pr.other)}, json={"mode": "more"})).status_code == 404
            # 다른 프로젝트 생성물 id 를 내 프로젝트로 삭제 → 0건
            assert [i["prompt_id"] for i in (await c.get(URL, params={"project_id": str(pr.own)})).json()["data"]["items"]] == [oid]
        async with client_as(ADMIN) as c:
            assert (await c.request("DELETE", URL, params={"project_id": str(pr.other), "ids": [oid]})).json()["data"]["removed_count"] == 0
            assert (await c.post(URL, params={"project_id": str(pr.other)}, json={"mode": "selected"})).status_code == 422
            assert (await c.post(URL, params={"project_id": str(pr.other)}, json={"mode": "selected", "selection": {}})).status_code == 422
            assert (await c.post(URL, params={"project_id": str(pr.other)}, json={"mode": "all"})).status_code == 422
            assert (await c.request("DELETE", URL, params={"project_id": str(pr.other)})).status_code == 422
            before = await _db_rows(pr.other)

            def boom(p, s):
                raise LlmError("upstream", "x")
            _llm(fx.FakeLlm(boom))
            fail = await c.post(URL, params={"project_id": str(pr.other)}, json={"mode": "more"})
            assert fail.status_code == 502 and fail.json()["error"]["code"] == "llm_failed"
            assert await _db_rows(pr.other) == before
            app.dependency_overrides.pop(get_llm, None)
            no_key = get_settings().model_copy(update={"openrouter_api_key": None})
            monkeypatch.setattr(core_llm, "get_settings", lambda: no_key)      # core.llm.get_llm 이 읽는 설정(키 미설정)
            un = await c.post(URL, params={"project_id": str(pr.other)}, json={"mode": "more"})
            assert un.status_code == 503 and un.json()["error"]["code"] == "llm_unavailable"
            _use_industry(uuid.uuid4())                  # 설정 산업의 활성 스냅샷 없음
            try:
                nosnap = await c.post(URL, params={"project_id": str(pr.other)}, json={"mode": "more"})
            finally:
                _use_industry(w.industry)
            assert nosnap.status_code == 409 and nosnap.json()["error"]["code"] == "no_active_snapshot"
