"""qa.answers.detail: 상세 낱알 전량. 기대값은 픽스처 손계산·독립 SQL."""
from __future__ import annotations

import uuid

import pytest

from app.core.write import get_audit_writer
from app.features.qa.answers.list.tests.qa_support import db_rows, job_id_of, new_session, qa_client, use_qa_scope
from tests.support import ADMIN, needs_db

pytestmark = [needs_db, pytest.mark.usefixtures("qa_clean")]


async def get(client_as, answer_key: int):
    rv = await new_session("검수자")
    async with qa_client(client_as, rv) as c:
        return await c.get(f"/v1/qa/answers/{await job_id_of(answer_key)}")


async def test_detail_head_prompt_mentions(client_as):
    r = await get(client_as, 1)
    assert r.status_code == 200
    d, meta = r.json()["data"], r.json()["meta"]
    a = d["answer"]
    assert a["job_id"] == str(await job_id_of(1)) and a["surface"] == "global" and a["country"] == "US" and a["engine"] == "chatgpt"
    assert a["job_status"] == "completed" and a["served"] is True and a["status"] == "completed" and a["round_date"] == "2026-09-14"
    assert d["prompt"]["text"] == "best suv" and d["prompt"]["funnel"] == "F1" and d["prompt"]["lang"] == "en"
    # qa R1(DB-v2.6 P47): qa_gate 가 app.prompt 16열·app.brand 를 읽어 catalog·brand 가 채워지고 가림(meta.suppressed)이 없다
    assert d["prompt"]["catalog"]["brand"] == "Hyundai" and d["prompt"]["catalog"]["depth2"] == "D2a"
    assert a["brand"] == ["Hyundai", "Genesis"] and meta["suppressed"] == {}                  # bgrp 5 = Hyundai 1 | Genesis 4
    # 멘션: mention_count DESC, display_name NULLS LAST(픽스처 6행)
    want = [r["display_name"] for r in await db_rows(
        "SELECT display_name FROM rd.v_answer_mention_raw WHERE answer_key = 1 ORDER BY mention_count DESC, display_name NULLS LAST, ord")]
    assert [m["display_name"] for m in d["mentions"]] == want and want[0] == "safety"
    creta = next(m for m in d["mentions"] if m["display_name"] == "Hyundai Creta")
    assert creta["rollup_parent_name"] == "Tata"                                 # 같은 답변에 없는 부모 → rd.dim_entity.rep_name
    hy = next(m for m in d["mentions"] if m["display_name"] == "Hyundai")
    assert hy["rollup_parent_name"] == "Hyundai" and hy["mention_count"] == 3 and hy["is_own"] is False


async def test_rollup_parent_from_same_answer(client_as):
    d = (await get(client_as, 2)).json()["data"]
    fortwo = next(m for m in d["mentions"] if m["display_name"] == "Smart Fortwo")
    assert fortwo["rollup_parent_name"] == "smart"                               # 같은 답변의 display_name 우선


async def test_citations_and_override(client_as):
    r = await get(client_as, 1)
    cits = r.json()["data"]["citations"]
    jid = str(await job_id_of(1))
    assert len(cits) == 10 and [c["ord"] for c in cits] == list(range(1, 11))   # ref_index 전부 NULL → ord 순
    assert cits[0]["target_key"] == f"{jid}:1" and cits[5]["host"] == "example.org"
    # qa R1(DB-v2.6 P47): 권한 부여 문맥 없이 오버라이드 분류가 나온다. 픽스처 오버라이드는 example.org → category_key 5(newsMedia) 하나뿐
    ex = cits[5]
    assert ex["override_category"] == "newsMedia" and ex["effective_category"] == "newsMedia"
    rest = cits[:5] + cits[6:]
    assert all(c["override_category"] is None and c["effective_category"] == c["stored_category"] for c in rest)
    assert r.json()["meta"]["suppressed"] == {}


async def test_acr_exact_link(client_as):
    d = (await get(client_as, 10)).json()["data"]
    assert len(d["acr"]) == 1
    cell = d["acr"][0]
    assert (cell["planned"], cell["valid_turn1"], cell["valid_acr"]) == (3, 3, 2)
    hy = next(ch for ch in cell["choices"] if ch["brand"] == "Hyundai")
    # 손계산: appearance 2 / valid_turn1 3, choice 1 / valid_acr 2
    assert hy["appearance_rate"] == {"num": 2, "den": 3} and hy["acr"] == {"num": 1, "den": 2} == hy["overall_choice_share"]
    assert len(cell["choices"]) == 3
    assert (await get(client_as, 1)).json()["data"]["acr"] == []                  # ACR 셀과 연결 없는 job


async def test_nonserved_and_derived(client_as):
    d = (await get(client_as, 13)).json()["data"]                                 # 비완료 job 도 열린다(G-24)
    assert d["answer"]["job_status"] == "in_progress" and d["answer"]["served"] is False and d["answer"]["status"] == "running"
    d = (await get(client_as, 14)).json()["data"]
    assert d["answer"]["dropped"] is True and d["derived"]["drop"]["reason"] == "test drop" and d["derived"]["anchor"] is None
    d = (await get(client_as, 17)).json()["data"]
    assert d["derived"]["anchor"]["anchor"] == "2026-09-07" and d["derived"]["drop"] is None


async def test_not_found_scope_and_auth(client_as):
    rv = await new_session("검수자")
    async with qa_client(client_as, rv) as c:
        assert (await c.get(f"/v1/qa/answers/{uuid.uuid4()}")).status_code == 404
        assert (await c.get("/v1/qa/answers/xyz")).status_code == 422
        use_qa_scope(surfaces=("project",))                                        # qa R3: core.config qa_surfaces
        r = await c.get(f"/v1/qa/answers/{await job_id_of(1)}")
        assert r.status_code == 404 and r.json()["error"]["code"] == "job_not_found"
        assert (await c.get(f"/v1/qa/answers/{await job_id_of(31)}")).status_code == 200
    async with qa_client(client_as, None, bearer=ADMIN) as c:
        assert (await c.get(f"/v1/qa/answers/{await job_id_of(1)}")).status_code == 401


async def test_r2_detail_access_audit(client_as):
    """qa R2: 원문 열람 1건 = 접근 감사 1건(core.write.access_audit_qa). 검수자는 계정이 없어 actor_id = 세션 id, actor_role 'vendor'
    (처분: app.user_role 에 값을 더하지 않고 detail.actor_kind 로 구분). 404·401 은 기록하지 않는다."""
    w = get_audit_writer()
    before = len(w.pending())
    rv = await new_session("감사검수자")
    jid = await job_id_of(1)
    async with qa_client(client_as, rv) as c:
        assert (await c.get(f"/v1/qa/answers/{jid}")).status_code == 200
        assert (await c.get(f"/v1/qa/answers/{uuid.uuid4()}")).status_code == 404
    async with qa_client(client_as, None) as c:
        assert (await c.get(f"/v1/qa/answers/{jid}")).status_code == 401
    ev = w.pending()[before:]
    assert len(ev) == 1
    e = ev[0]
    assert (e.kind, e.action, e.target, e.actor_role) == ("data_access", "qa.answers.detail", str(jid), "vendor")
    assert e.actor_id == uuid.UUID(rv.session_id)
    assert e.detail == {"actor_kind": "qa_reviewer", "reviewer_name": "감사검수자"}
