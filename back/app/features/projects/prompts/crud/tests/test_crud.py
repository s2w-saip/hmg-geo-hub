"""projects.prompts.crud: 목록(필터·키셋·태그·권한)·수동 추가·수정·단순 삭제."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db
T0 = datetime(2026, 9, 1, tzinfo=UTC)


def url(pid, suffix=""):
    return f"/v1/projects/{pid}/prompts{suffix}"


async def _fresh(env):
    """테스트 전용 프로젝트(다른 테스트 행과 섞이지 않게)."""
    return await env.mk_project()


async def test_list_shape_order_tags_and_page(env, client_as):
    pid = await _fresh(env)
    a = await env.mk_prompt("alpha", project_id=pid, created_at=T0)
    b = await env.mk_prompt("beta", project_id=pid, status="done", scope_prompt_id=uuid.uuid4(), created_at=T0 + timedelta(hours=1))
    gone = await env.mk_prompt("gone", project_id=pid, created_at=T0 + timedelta(hours=2))
    await env.as_actor("UPDATE app.prompt SET deleted_at = now() WHERE prompt_id = $1", gone)
    f = await env.mk_field("차종", project_id=pid)
    await env.set_tag(a, f, "SUV", project_id=pid)
    async with client_as(env.owner) as c:
        r = await c.get(url(pid))
    assert r.status_code == 200, r.text
    body = r.json()
    items = body["data"]["items"]
    assert [i["prompt_id"] for i in items] == [str(b), str(a)]           # created_at DESC, 삭제 행 제외
    assert items[1]["tags"] == {str(f): "SUV"} and items[0]["tags"] == {}
    assert items[0]["status"] == "done" and items[0]["kind"] == "single" and items[1]["status"] == "draft"
    assert set(items[0]) >= {"prompt_id", "text", "kind", "status", "brand_code", "category", "prompt_type", "lang", "regions",
                             "scope_prompt_id", "created_at", "updated_at", "tags"}
    assert "list_type" not in items[0] and "depth1" not in items[0]      # 은퇴 축 비노출
    meta = body["meta"]
    assert meta["mode"] == "crud" and meta["surface"] == "project" and meta["page"]["total"] == 2 and meta["page"]["next_cursor"] is None


async def test_list_permissions_and_scope(env, client_as):
    pid = env.project_id
    for uid, code in ((env.owner, 200), (ADMIN, 200), (VENDOR, 200), (HQ_HYUNDAI, 404), (env.op, 200),   # 메인 정정 2026-09-28: 비멤버(스코프 안) 읽기 404(front prompt/page.tsx:43 notFound)
                      (KIA_US, 404), (KIA_EU, 404), (SUSPENDED, 401), (env.nomenu, 403), (None, 401)):
        async with client_as(uid) as c:
            r = await c.get(url(pid))
        assert r.status_code == code, (uid, r.text)
        if code == 404:
            assert r.json()["error"]["code"] == "not_found" and "items" not in r.text     # 존재 은닉·누출 0
    async with client_as(env.nomenu) as c:
        assert (await c.get(url(pid))).json()["error"]["code"] == "menu_forbidden"
    async with client_as(HQ_HYUNDAI) as c:                                  # 루트(표준) 프로젝트는 고객 프로젝트가 아니다
        assert (await c.get(url("c0000000-0000-4000-8000-000000000001"))).status_code == 404
    async with client_as(HQ_HYUNDAI) as c:                                  # 없는 프로젝트
        assert (await c.get(url(uuid.uuid4()))).status_code == 404


async def test_list_filters_change_results(env, client_as):
    pid = await _fresh(env)
    d1 = await env.mk_prompt("Best SUV in Korea", project_id=pid, created_at=T0)
    d2 = await env.mk_prompt("family sedan", project_id=pid, kind="acr", created_at=T0 + timedelta(minutes=1))
    done = await env.mk_prompt("suv price", project_id=pid, status="done", scope_prompt_id=uuid.uuid4(), created_at=T0 + timedelta(minutes=2))
    f = await env.mk_field("세그먼트", project_id=pid)
    await env.set_tag(d1, f, "SUV", project_id=pid)
    await env.set_tag(done, f, "SUV", project_id=pid)
    await env.set_tag(d2, f, "Sedan", project_id=pid)
    other = await env.mk_project()
    foreign_field = await env.mk_field("x", project_id=other)

    async def ids(params):
        async with client_as(env.owner) as c:
            r = await c.get(url(pid), params=params)
        assert r.status_code == 200, r.text
        return {i["prompt_id"] for i in r.json()["data"]["items"]}, r.json()["meta"]

    assert (await ids({}))[0] == {str(d1), str(d2), str(done)}
    assert (await ids({"status": "draft"}))[0] == {str(d1), str(d2)}
    assert (await ids([("status", "draft"), ("status", "done")]))[0] == {str(d1), str(d2), str(done)}
    assert (await ids({"kind": "acr"}))[0] == {str(d2)}
    assert (await ids({"q": "suv"}))[0] == {str(d1), str(done)}             # 대소문자 무시
    assert (await ids({"q": "100%"}))[0] == set()                            # % 는 패턴이 아니다
    assert (await ids({f"cf.{f}": "SUV"}))[0] == {str(d1), str(done)}
    assert (await ids([(f"cf.{f}", "SUV"), ("status", "draft")]))[0] == {str(d1)}
    got, meta = await ids({f"cf.{foreign_field}": "x"})                     # 다른 프로젝트 필드 = dropped + 빈 결과
    assert got == set() and meta["dropped_filters"] == {"custom": [str(foreign_field)]}
    got, meta = await ids({"country": "US", "from": "2026-09-01", "to": "2026-09-30", "funnel": "F1"})   # 미지원 공통 축 = 무시 + 표기
    assert got == {str(d1), str(d2), str(done)} and meta["ignored_filters"] == ["country", "funnel", "period"]
    got, meta = await ids({"q": "nothing-matches"})
    assert got == set() and meta["page"]["total"] == 0


async def test_list_invalid_params_422(env, client_as):
    async with client_as(env.owner) as c:
        for params in ({"status": "bogus"}, {"kind": "multi"}, {"limit": 0}, {"limit": 501}, {"q": ""}, {"cursor": "garbage!!"},
                       {"cf.not-a-uuid": "x"}):
            r = await c.get(url(env.project_id), params=params)
            assert r.status_code == 422, (params, r.text)
        assert (await c.get("/v1/projects/not-a-uuid/prompts")).status_code == 422


async def test_list_keyset_pagination(env, client_as):
    pid = await _fresh(env)
    made = [await env.mk_prompt(f"p{i}", project_id=pid, created_at=T0 + timedelta(minutes=i % 3)) for i in range(7)]   # 같은 시각 섞임
    seen, cursor, pages = [], None, 0
    async with client_as(env.owner) as c:
        while True:
            params = {"limit": 3} | ({"cursor": cursor} if cursor else {})
            r = await c.get(url(pid), params=params)
            assert r.status_code == 200, r.text
            seen += [(i["created_at"], i["prompt_id"]) for i in r.json()["data"]["items"]]
            cursor = r.json()["data"]["next_cursor"]
            pages += 1
            assert r.json()["meta"]["page"]["total"] == 7
            if not cursor:
                break
        assert pages == 3 and len(seen) == 7 and {s[1] for s in seen} == {str(m) for m in made}
        assert seen == sorted(seen, reverse=True)
        first = await c.get(url(pid), params={"limit": 3})
        r = await c.get(url(pid), params={"limit": 3, "status": "draft", "cursor": first.json()["data"]["next_cursor"]})
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"     # 다른 필터로 커서 재사용


async def test_manual_add_splits_lines_and_audits(env, client_as):
    pid = await _fresh(env)
    async with client_as(env.owner) as c:
        r = await c.post(url(pid), json={"text": "  first line \n\n second line\r\nthird  "})
    assert r.status_code == 201, r.text
    ids = r.json()["data"]["prompt_ids"]
    assert r.json()["data"]["created"] == 3
    rows = await env.q("SELECT prompt_id::text, text, status, created_by FROM app.prompt WHERE project_id = $1", pid)
    assert {x["text"] for x in rows} == {"first line", "second line", "third"} and {x["prompt_id"] for x in rows} == set(ids)
    assert all(x["status"] == "draft" and x["created_by"] == env.owner for x in rows)
    for i in ids:                                                        # 감사 = DB 트리거(행위자 = 요청 사용자)
        a = await env.audits(uuid.UUID(i))
        assert [(x["event_type"], x["actor_id"]) for x in a] == [("created", env.owner)]
    async with client_as(env.owner) as c:
        assert (await c.post(url(pid), json={"text": " \n \n"})).status_code == 422
        assert (await c.post(url(pid), json={"text": "x", "extra": 1})).status_code == 422
        assert (await c.post(url(pid), json={})).status_code == 422
        assert (await c.post(url(pid), json={"text": "x" * 4001})).status_code == 422
    for uid, code in ((VENDOR, 403), (HQ_HYUNDAI, 403), (env.op, 403), (KIA_US, 404), (ADMIN, 201)):
        async with client_as(uid) as c:
            r = await c.post(url(pid), json={"text": "by someone"})
        assert r.status_code == code, (uid, r.text)
    assert await env.val("SELECT count(*) FROM app.prompt WHERE project_id = $1", pid) == 4


async def test_patch_rules_audit_and_rollback(env, client_as):
    pid = await _fresh(env)
    draft = await env.mk_prompt("draft text", project_id=pid)
    sp = uuid.uuid4()
    done = await env.mk_prompt("done text", project_id=pid, status="done", scope_prompt_id=sp)
    async with client_as(env.owner) as c:
        r = await c.patch(url(pid, f"/{draft}"), json={"text": " new text ", "category": "cat", "lang": "ko", "regions": ["US", "US", "KR"]})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["text"] == "new text" and d["category"] == "cat" and d["lang"] == "KO" and d["regions"] == ["US", "KR"]
        r = await c.patch(url(pid, f"/{done}"), json={"text": "changed"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "prompt_not_draft"
        r = await c.patch(url(pid, f"/{done}"), json={"category": "c2", "prompt_type": "t", "kind": "acr"})
        assert r.status_code == 200 and r.json()["data"]["kind"] == "acr"
        r = await c.patch(url(pid, f"/{done}"), json={"category": None})
        assert r.status_code == 200 and r.json()["data"]["category"] is None
        # 롤백: 본문 변경 + 없는 브랜드 → 422, 본문도 그대로
        r = await c.patch(url(pid, f"/{draft}"), json={"text": "should not stick", "brand_code": "NoSuchBrand"})
        assert r.status_code == 422, r.text
        for body in ({}, {"text": None}, {"kind": None}, {"kind": "multi"}, {"unknown": 1}, {"lang": "x"}):
            assert (await c.patch(url(pid, f"/{draft}"), json=body)).status_code == 422, body
        other = await env.mk_project()
        foreign = await env.mk_prompt("foreign", project_id=other)
        assert (await c.patch(url(pid, f"/{foreign}"), json={"category": "x"})).status_code == 404    # IDOR 은폐
    assert await env.val("SELECT text FROM app.prompt WHERE prompt_id = $1", draft) == "new text"
    ev = [x["event_type"] for x in await env.audits(draft)]
    assert ev == ["created", "text_updated"]
    # kind 변경은 트리거가 prompt_kind 재판정 요청을 남긴다(Scope 발행 행만)
    jc = await env.q("SELECT kind, subject_uuids FROM app.judgment_change WHERE payload->>'prompt_id' = $1 ORDER BY change_id", str(done))
    assert [x["kind"] for x in jc].count("prompt_kind") == 1 and all(x["subject_uuids"] == [sp] for x in jc)
    async with client_as(VENDOR) as c:
        assert (await c.patch(url(pid, f"/{draft}"), json={"category": "v"})).status_code == 403


async def test_delete_draft_only(env, client_as):
    pid = await _fresh(env)
    draft = await env.mk_prompt("d", project_id=pid)
    queued = await env.mk_prompt("q", project_id=pid, status="queued")
    done = await env.mk_prompt("x", project_id=pid, status="done", scope_prompt_id=uuid.uuid4())
    async with client_as(VENDOR) as c:
        assert (await c.delete(url(pid, f"/{draft}"))).status_code == 403
    async with client_as(env.owner) as c:
        assert (await c.delete(url(pid, f"/{draft}"))).status_code == 204
        for pr in (queued, done):
            r = await c.delete(url(pid, f"/{pr}"))
            assert r.status_code == 409 and r.json()["error"]["code"] == "prompt_not_deletable"
        assert (await c.delete(url(pid, f"/{draft}"))).status_code == 404
        assert (await c.delete(url(CUST_PROJECT, "/c3000000-0000-4000-8000-000000000031"))).status_code == 403   # 비멤버 owner 아님
    assert await env.val("SELECT count(*) FROM app.prompt WHERE prompt_id = $1", draft) == 0
    assert [x["event_type"] for x in await env.audits(draft)] == ["created", "deleted"]


async def test_control_chars_rejected_422(env, client_as):
    """검증 D2·D5 회귀: NUL 이 든 본문·메타가 DB 까지 가서 500 이던 결함, q=%00 이 cursor_invalid 로 오보고되던 결함."""
    pid = await _fresh(env)
    d = await env.mk_prompt("draft", project_id=pid)
    async with client_as(env.owner) as c:
        for body in ({"text": "ok\u0000null"}, {"text": "a\nb\u0007c"}, {"text": "x\u007f"}):
            r = await c.post(url(pid), json=body)
            assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (body, r.text)
        for body in ({"text": "ok\u0000zero"}, {"category": "c\u0000"}, {"prompt_type": "t\u001f"}, {"brand_code": "Hy\u0000"},
                     {"category": "two\nlines"}):
            r = await c.patch(url(pid, f"/{d}"), json=body)
            assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (body, r.text)
        r = await c.get(url(pid), params={"q": "\u0000"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"          # cursor_invalid 아님
        assert (await c.get(url(pid), params={"q": "a\u001fb"})).status_code == 422
        r = await c.post(url(pid), json={"text": "tab\there\r\nnext line"})                   # 탭·CRLF 는 허용(줄 분리)
        assert r.status_code == 201 and r.json()["data"]["created"] == 2
        r = await c.patch(url(pid, f"/{d}"), json={"text": "fixed\tok", "category": "카테고리"})
        assert r.status_code == 200 and r.json()["data"]["text"] == "fixed\tok"
    assert await env.val("SELECT count(*) FROM app.prompt WHERE project_id = $1", pid) == 3


async def test_lone_surrogates_rejected_422(env, client_as):
    """검증 D2-R 회귀: regions 항목의 짝 없는 서로게이트(원문 JSON "\\ud800")가 asyncpg 인코딩 오류로 500 이던 결함.
    본문·분류 값도 같은 방어선(check_body·core PgLine)에서 422. 짝이 맞는 서로게이트 이스케이프(이모지)는 정상 값이다."""
    import pydantic
    import pytest

    from app.core.filters import single_line
    from app.features.projects.prompts.crud.schemas import ManualAdd, PromptPatch, check_body
    for bad in ({"regions": ["U\ud800"]}, {"regions": ["\udfff"]}, {"text": "a\ud800b"}, {"category": "c\udc00"}):
        with pytest.raises(pydantic.ValidationError):
            PromptPatch.model_validate(bad)
    with pytest.raises(pydantic.ValidationError):
        ManualAdd.model_validate({"text": "ok\n\ud800"})
    with pytest.raises(ValueError):
        check_body("x\ud83d")
    with pytest.raises(ValueError):          # 6라운드: 기능 check_line 을 core PgLine(single_line)으로 교체(같은 규칙, §8 처분)
        single_line("x\ud83d")
    pid = await _fresh(env)
    d = await env.mk_prompt("draft", project_id=pid)
    async with client_as(env.owner) as c:
        for raw in (b'{"regions":["U\\ud800"]}', b'{"regions":["US","\\udfff"]}', b'{"text":"a\\ud800"}', b'{"category":"\\ud800"}'):
            r = await c.patch(url(pid, f"/{d}"), content=raw, headers={"content-type": "application/json"})
            assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (raw, r.text)
        r = await c.post(url(pid), content=b'{"text":"line\\ud800"}', headers={"content-type": "application/json"})
        assert r.status_code == 422, r.text
        r = await c.patch(url(pid, f"/{d}"), content=b'{"regions":["US","KR"],"category":"\\ud83d\\ude00"}',
                          headers={"content-type": "application/json"})
        assert r.status_code == 200 and r.json()["data"]["category"] == "\U0001f600", r.text


async def test_pj3_reads_are_member_only(env, client_as):
    """메인 정정 2026-09-28(PJ-3): 프롬프트 읽기 4곳(목록·후보·태그 목록·내보내기)은 활성 멤버 또는 admin 만.
    스코프 안 비멤버(HQ_HYUNDAI)는 404(front app/[locale]/(dash)/projects/[id]/prompt/page.tsx:43 notFound 와 같은 쪽)."""
    base = f"/v1/projects/{env.project_id}"
    paths = ("/prompts", "/prompt-candidates", "/prompt-fields", "/prompts/export")
    for uid, code in ((HQ_HYUNDAI, 404), (VENDOR, 200), (ADMIN, 200)):
        async with client_as(uid) as c:
            for path in paths:
                r = await c.get(base + path)
                assert r.status_code == code, (uid, path, r.text[:200])
                if code == 404:
                    assert r.json()["error"]["code"] == "not_found"
