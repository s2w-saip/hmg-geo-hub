"""projects.prompts.lifecycle: 영향 미리보기(rd, api_ro)·중지·재개·완전 삭제(outbox·감사·공유 가드·롤백)."""
from __future__ import annotations

import uuid

from app.core import errors
from app.features.projects.prompts.execute.publisher import get_publisher
from app.main import app
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db
CUST_PROMPT = uuid.UUID("c3000000-0000-4000-8000-000000000031")
CUST_SCOPE = uuid.UUID("b0000000-0000-4000-8000-000000000031")


def url(pid, prompt, action):
    return f"/v1/projects/{pid}/prompts/{prompt}/{action}"


async def _expected(env, scope_prompt_id):
    """독립 SQL: 표면 3 전 회차 키(rd.cycle, 프로젝트 무관)·넓은 날짜 범위로 프롬프트 키 행을 그대로 센다(core 창 빌더 미사용).
    사실 표 3술어는 정적 가드(G1) 때문에 붙이되 값은 구현과 다른 경로로 만든다."""
    pk = await env.val("SELECT prompt_key FROM rd.dim_prompt WHERE prompt_id = $1", scope_prompt_id)
    keys = [r["cyc_key"] for r in await env.q("SELECT cyc_key FROM rd.cycle WHERE surface = 3")]
    out = {}
    for name, tbl in (("answers", "rd.answer"), ("mentions", "rd.answer_brand"), ("citations", "rd.citation")):
        out[name] = await env.val(f"SELECT count(*) FROM {tbl} t WHERE t.surface = 3 AND t.round_date BETWEEN '2000-01-01' AND '2100-01-01' "
                                  "AND t.cyc_key = ANY($2::int4[]) AND t.prompt_key = $1", pk, keys)
    return out


async def test_impact_counts_match_fact_tables(env, client_as):
    exp = await _expected(env, CUST_SCOPE)
    assert exp == {"answers": 1, "mentions": 0, "citations": 4}                   # 픽스처 손계산(k31: 답변 1·언급 0·인용 4)
    async with client_as(ADMIN) as c:
        r = await c.get(url(CUST_PROJECT, CUST_PROMPT, "lifecycle-impact"), params={"country": "US"})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert {k: d[k] for k in exp} == exp and d["shared_rows"] == 0 and d["published"] is True
    assert r.json()["meta"]["ignored_filters"] == ["country"]


async def test_impact_shared_rows_unpublished_and_permissions(env, client_as):
    pid = await env.mk_project()
    shared = await env.mk_prompt("shared copy", project_id=pid, status="done", scope_prompt_id=CUST_SCOPE)
    draft = await env.mk_prompt("draft", project_id=pid)
    try:
        async with client_as(ADMIN) as c:
            r = await c.get(url(CUST_PROJECT, CUST_PROMPT, "lifecycle-impact"))
            assert r.json()["data"]["shared_rows"] == 1
            # 다른 프로젝트 행이 같은 Scope 프롬프트를 가리켜도 rd 카운트는 그 행 프로젝트의 차원 키로만 센다(누출 0)
            r = await c.get(url(pid, shared, "lifecycle-impact"))
            d = r.json()["data"]
            assert (d["published"], d["answers"], d["mentions"], d["citations"], d["shared_rows"]) == (True, 0, 0, 0, 1)
        async with client_as(env.owner) as c:
            r = await c.get(url(pid, draft, "lifecycle-impact"))
            assert r.status_code == 200 and r.json()["data"] == {"prompt_id": str(draft), "published": False, "answers": 0, "mentions": 0,
                                                                 "citations": 0, "shared_rows": 0}
            assert (await c.get(url(pid, CUST_PROMPT, "lifecycle-impact"))).status_code == 404            # 다른 프로젝트 프롬프트
            assert (await c.get(url(pid, uuid.uuid4(), "lifecycle-impact"))).status_code == 404
            assert (await c.get(url(pid, "bad", "lifecycle-impact"))).status_code == 422
        for uid, code in ((VENDOR, 403), (HQ_HYUNDAI, 403), (env.op, 403), (KIA_US, 404)):
            async with client_as(uid) as c:
                assert (await c.get(url(pid, draft, "lifecycle-impact"))).status_code == code, uid
    finally:
        await env.as_actor("DELETE FROM app.prompt WHERE prompt_id = $1", shared)


async def test_pause_resume_flow(env, client_as):
    pid = await env.mk_project()
    sp = uuid.uuid4()
    pr = await env.mk_prompt("measured", project_id=pid, status="done", scope_prompt_id=sp)
    draft = await env.mk_prompt("draft", project_id=pid)
    async with client_as(env.op) as c:                                    # viewer 운영자는 중지(Owner) 불가
        assert (await c.post(url(pid, pr, "pause"))).status_code == 403
    async with client_as(env.owner) as c:
        r = await c.post(url(pid, pr, "pause"))
        assert r.status_code == 200, r.text
        assert r.json()["data"]["status"] == "paused" and r.json()["data"]["propagation"] == "pending"
        r2 = await c.post(url(pid, pr, "pause"))
        assert r2.status_code == 409 and r2.json()["error"]["code"] == "invalid_status"
        r3 = await c.post(url(pid, draft, "pause"))
        assert r3.status_code == 409
        r4 = await c.post(url(pid, pr, "resume"))                           # Owner 지만 운영자 아님(operator none)
        assert r4.status_code == 403 and r4.json()["error"]["code"] == "operator_forbidden"
    assert await env.val("SELECT status FROM app.prompt WHERE prompt_id = $1", pr) == "paused"
    ob = await env.outbox(pr)
    assert [o["op"] for o in ob] == ["disable"] and ob[0]["payload"]["scope_prompt_id"] == str(sp)
    assert ob[0]["payload"]["project_id"] == str(pid) and ob[0]["done_at"] is None
    au = await env.audits(pr)
    assert au[-1]["event_type"] == "enabled_changed" and au[-1]["actor_id"] == env.owner
    for uid, code in ((HQ_HYUNDAI, 403), (VENDOR, 403), (KIA_US, 404)):   # assigned 비멤버·vendor·스코프 밖
        async with client_as(uid) as c:
            assert (await c.post(url(pid, pr, "resume"))).status_code == code, uid
    async with client_as(env.op) as c:                                     # assigned 운영자 + 활성 멤버 = 재개 가능
        r = await c.post(url(pid, pr, "resume"))
        assert r.status_code == 200 and r.json()["data"]["status"] == "done"
        assert (await c.post(url(pid, pr, "resume"))).status_code == 409
    assert [o["op"] for o in await env.outbox(pr)] == ["disable", "enable"]
    assert await env.val("SELECT status FROM app.prompt WHERE prompt_id = $1", pr) == "done"


async def test_pause_shared_guard_and_unpublished_resume(env, client_as):
    pid = await env.mk_project()
    sp = uuid.uuid4()
    a = await env.mk_prompt("a", project_id=pid, status="done", scope_prompt_id=sp)
    await env.mk_prompt("b", project_id=pid, status="done", scope_prompt_id=sp)
    queued = await env.mk_prompt("q", project_id=pid, status="queued")
    async with client_as(env.owner) as c:
        r = await c.post(url(pid, a, "pause"))
        assert r.status_code == 409 and r.json()["error"] == {"code": "shared_prompt", "message": r.json()["error"]["message"],
                                                              "details": {"shared_rows": 1}}
        assert (await c.post(url(pid, queued, "pause"))).status_code == 200
    assert await env.outbox(a) == []
    async with client_as(ADMIN) as c:                                      # 미발행 행 재개는 queued 로(실행 복구 대상)
        r = await c.post(url(pid, queued, "resume"))
        assert r.status_code == 200 and r.json()["data"]["status"] == "queued"


async def test_hard_delete_variants(env, client_as):
    pid = await env.mk_project()
    sp_solo, sp_shared = uuid.uuid4(), uuid.uuid4()
    solo = await env.mk_prompt("solo", project_id=pid, status="paused", scope_prompt_id=sp_solo)
    sh1 = await env.mk_prompt("sh1", project_id=pid, status="done", scope_prompt_id=sp_shared)
    await env.mk_prompt("sh2", project_id=pid, status="done", scope_prompt_id=sp_shared)
    draft = await env.mk_prompt("draft", project_id=pid)
    async with client_as(VENDOR) as c:
        assert (await c.post(url(pid, solo, "hard-delete"))).status_code == 403
    async with client_as(env.owner) as c:
        r = await c.post(url(pid, solo, "hard-delete"))
        assert r.status_code == 200, r.text
        assert r.json()["data"] | {"outbox_id": None} == {"prompt_id": str(solo), "status": "paused", "deleted": True, "shared_rows": 0,
                                                            "propagation": "pending", "outbox_id": None}
        r = await c.post(url(pid, sh1, "hard-delete"))
        assert r.json()["data"]["propagation"] == "none" and r.json()["data"]["shared_rows"] == 1
        r = await c.post(url(pid, draft, "hard-delete"))
        assert r.json()["data"]["propagation"] == "none"
        assert (await c.post(url(pid, solo, "hard-delete"))).status_code == 404            # 이미 삭제
        lst = await c.get(f"/v1/projects/{pid}/prompts")
        assert [i["text"] for i in lst.json()["data"]["items"]] == ["sh2"]
    ob = await env.outbox(solo)
    assert [o["op"] for o in ob] == ["delete"] and ob[0]["payload"]["was_paused"] is True
    assert await env.outbox(sh1) == [] and await env.outbox(draft) == []
    assert await env.val("SELECT deleted_at IS NOT NULL FROM app.prompt WHERE prompt_id = $1", solo)
    assert (await env.audits(solo))[-1]["event_type"] == "deleted"
    jc = await env.q("SELECT kind, subject_uuids, payload->'new'->>'deleted_at' AS d FROM app.judgment_change "
                     "WHERE payload->>'prompt_id' = $1 AND payload->>'op' = 'update'", str(solo))
    assert [(x["kind"], x["subject_uuids"], x["d"] is not None) for x in jc] == [("catalog", [sp_solo], True)]   # 트리거가 재판정 요청


class _Boom:
    async def publish(self, conn, op, prompt_id, payload):
        raise errors.unavailable("가짜 publisher 실패", code="publisher_down")


async def test_publisher_failure_rolls_back(env, client_as):
    pid = await env.mk_project()
    pr = await env.mk_prompt("m", project_id=pid, status="done", scope_prompt_id=uuid.uuid4())
    app.dependency_overrides[get_publisher] = lambda: _Boom()
    try:
        async with client_as(env.owner) as c:
            r = await c.post(url(pid, pr, "pause"))
            assert r.status_code == 503 and r.json()["error"]["code"] == "publisher_down"
            r = await c.post(url(pid, pr, "hard-delete"))
            assert r.status_code == 503
    finally:
        app.dependency_overrides.pop(get_publisher, None)
    assert await env.val("SELECT status || ':' || (deleted_at IS NULL)::text FROM app.prompt WHERE prompt_id = $1", pr) == "done:true"
    assert await env.outbox(pr) == [] and [a["event_type"] for a in await env.audits(pr)] == ["created"]


# ── 검증 D1 회귀: 토글 op(disable·enable)가 옛 미완료 행에 병합돼 워커 순서 처리 시 최종 상태가 뒤집히던 결함 ──
async def _pending(env, prompt_id):
    """미완료 outbox 를 outbox_id 순으로(워커 처리 순서). 워커가 이대로 처리하면 마지막 토글이 Scope 최종 상태다."""
    return [(r["outbox_id"], r["op"]) for r in await env.q(
        "SELECT outbox_id, op FROM app.scope_outbox WHERE aggregate = 'prompt' AND aggregate_id = $1 AND done_at IS NULL "
        "ORDER BY outbox_id", prompt_id)]


async def _superseded(env, prompt_id):
    return [r["op"] for r in await env.q(
        "SELECT op FROM app.scope_outbox WHERE aggregate = 'prompt' AND aggregate_id = $1 AND last_error = 'superseded' "
        "AND done_at IS NOT NULL ORDER BY outbox_id", prompt_id)]


def _scope_final(pending, *, processed_state):
    """워커 규약 ①(outbox_id 순서 처리)을 흉내 낸 Scope 최종 활성 여부. processed_state = 이미 처리된 상태(True=측정 중)."""
    state = processed_state
    for _, op in pending:
        if op == "disable":
            state = False
        elif op == "enable":
            state = True
    return state


async def test_toggle_pause_resume_pause_keeps_latest_order(env, client_as):
    """pause→resume→pause: 예전엔 세 번째 pause 가 첫 disable 행(16)에 병합돼 미완료 [(16,disable),(17,enable)] → Scope 최종 enable."""
    pid = await env.mk_project()
    pr = await env.mk_prompt("toggle a", project_id=pid, status="done", scope_prompt_id=uuid.uuid4())
    ids = []
    async with client_as(ADMIN) as c:
        for action in ("pause", "resume", "pause"):
            r = await c.post(url(pid, pr, action))
            assert r.status_code == 200, r.text
            ids.append(r.json()["data"]["outbox_id"])
    assert ids[0] < ids[1] < ids[2]                                        # 세 번째가 옛 행 id 를 돌려주지 않는다
    pend = await _pending(env, pr)
    assert pend == [(ids[2], "disable")]
    assert await _superseded(env, pr) == ["disable", "enable"]
    assert await env.val("SELECT status FROM app.prompt WHERE prompt_id = $1", pr) == "paused"
    assert _scope_final(pend, processed_state=True) is False               # 화면(중지) = Scope 최종(중지)


async def test_toggle_resume_pause_resume_after_processed_disable(env, client_as):
    """disable 처리 완료 뒤 resume→pause→resume: 예전엔 미완료 [(34,enable),(35,disable)] + 로컬 done → Scope 최종 disable."""
    pid = await env.mk_project()
    pr = await env.mk_prompt("toggle b", project_id=pid, status="done", scope_prompt_id=uuid.uuid4())
    async with client_as(ADMIN) as c:
        assert (await c.post(url(pid, pr, "pause"))).status_code == 200
    await env.conn.execute("UPDATE app.scope_outbox SET done_at = now() WHERE aggregate_id = $1 AND done_at IS NULL", pr)  # 워커 처리
    ids = []
    async with client_as(ADMIN) as c:
        for action in ("resume", "pause", "resume"):
            r = await c.post(url(pid, pr, action))
            assert r.status_code == 200, r.text
            ids.append(r.json()["data"]["outbox_id"])
    assert len(set(ids)) == 3 and ids == sorted(ids)
    pend = await _pending(env, pr)
    assert pend == [(ids[2], "enable")]
    assert await env.val("SELECT status FROM app.prompt WHERE prompt_id = $1", pr) == "done"
    assert _scope_final(pend, processed_state=False) is True               # 화면(측정 중) = Scope 최종(측정 중)


async def test_toggle_after_execute_keeps_create_first(env, client_as):
    """execute→pause→resume→pause: create 는 남고 토글은 마지막 disable 1행(create 뒤) → 워커가 발행 후 중지로 수렴."""
    pid = await env.mk_project()
    pr = await env.mk_prompt("toggle c", project_id=pid)
    async with client_as(ADMIN) as c:
        assert (await c.post(f"/v1/projects/{pid}/prompts/execute")).status_code == 202
        for action in ("pause", "resume", "pause"):
            assert (await c.post(url(pid, pr, action))).status_code == 200
    pend = await _pending(env, pr)
    assert [op for _, op in pend] == ["create", "disable"]
    assert await env.val("SELECT status FROM app.prompt WHERE prompt_id = $1", pr) == "paused"
    assert _scope_final(pend, processed_state=True) is False
