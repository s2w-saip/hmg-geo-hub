"""admin.catalog.prompts 통합 테스트(로컬 개발 DB 복제본 ad_content, 합성 픽스처).

기대값은 픽스처 손계산(주석) 또는 테스트 안의 독립 SQL(asyncpg, 구현 SQL 복붙 아님)로 낸다. DB 는 실행 간 유지되므로
쓰기 테스트는 매번 새 행(uuid 표식)을 만들어 쓰고, 목록 수치는 실행 시점 독립 SQL 로 센다.
픽스처 표준 루트(c0…01) 행: 01 best suv(Hyundai·D2a) 02 common q(D2b) 03 acr q(HMG·acr) 04 현대 SUV 추천(Hyundai·branded·D2a)
05 deleted row(삭제) 06 us only 11 best suv (G)(Genesis·D2a). 전부 scope_prompt_id 있음. rd.dim_prompt 루트 7행 중 b…07 은 미연결(orphan 1).
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from app.core import errors
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_EU, KIA_US, ROOT_PROJECT, SUSPENDED, SYSTEM, VENDOR, needs_db

BASE = "/v1/admin/catalog/prompts"
pytestmark = needs_db


async def _db():
    return await asyncpg.connect(DB_URL)


async def _val(sql: str, *args):
    c = await _db()
    try:
        return await c.fetchval(sql, *args)
    finally:
        await c.close()


async def _new_tracked(text: str, **cols) -> uuid.UUID:
    """트리거 행위자(SYSTEM)로 루트 카탈로그에 연결된(추적) 행 하나를 직접 만든다(테스트 준비)."""
    c = await _db()
    try:
        async with c.transaction():
            await c.execute("SELECT set_config('app.actor_id', $1, true)", str(SYSTEM))
            pid = await c.fetchval(
                "INSERT INTO app.prompt (project_id, text, scope_prompt_id, created_by, brand_code, list_type, kind) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING prompt_id",
                ROOT_PROJECT, text, uuid.uuid4(), SYSTEM, cols.get("brand_code"), cols.get("list_type"), cols.get("kind", "single"))
        return pid
    finally:
        await c.close()


# ── 권한 ──
@pytest.mark.parametrize("uid,status", [(ADMIN, 200), (HQ_HYUNDAI, 403), (KIA_US, 403), (VENDOR, 403), (KIA_EU, 403),
                                        (SUSPENDED, 401), (None, 401)])
async def test_list_access(client_as, uid, status):
    async with client_as(uid) as c:
        r = await c.get(BASE)
    assert r.status_code == status, r.text
    if status == 403:
        assert r.json()["error"]["code"] == "admin_only"


async def test_write_forbidden_for_non_admin(client_as):
    before = await _val("SELECT count(*) FROM app.prompt")
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.post(BASE, json={"text": "hq 는 못 만든다"})
    assert r.status_code == 403
    assert await _val("SELECT count(*) FROM app.prompt") == before


# ── 목록 ──
async def _all_items(c, params):
    items, cursor = [], None
    for _ in range(2000):                        # 쓰기 테스트가 실행마다 추적 행을 더하므로 넉넉히(무한 루프 방지용 상한)
        r = await c.get(BASE, params={**params, **({"cursor": cursor} if cursor else {})})
        assert r.status_code == 200, r.text
        body = r.json()
        items += body["data"]["items"]
        cursor = body["meta"]["page"]["next_cursor"]
        if not cursor:
            return items, body
    raise AssertionError("페이지 끝 없음")


async def test_list_shape_and_stats(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(BASE, params={"limit": 500})
    assert r.status_code == 200
    body = r.json()
    live = await _val("SELECT count(*) FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL", ROOT_PROJECT)
    tracked = await _val("SELECT count(*) FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL AND scope_prompt_id IS NOT NULL",
                         ROOT_PROJECT)
    acr = await _val("SELECT count(*) FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL AND kind = 'acr'", ROOT_PROJECT)
    orphans = await _val("""SELECT count(*) FROM rd.dim_prompt d WHERE d.surface = 1 AND d.project_key = 1 AND d.prompt_id NOT IN
                            (SELECT scope_prompt_id FROM app.prompt WHERE scope_prompt_id IS NOT NULL)""")
    st = body["data"]["stats"]
    assert st == {"total": live, "tracked": tracked, "untracked": live - tracked, "scope_orphans": orphans, "acr": acr, "deleted": 0}
    assert orphans >= 1                                                    # 픽스처 b…07 미연결
    assert len(body["data"]["items"]) == live
    row = next(i for i in body["data"]["items"] if i["prompt_id"] == "c1000000-0000-4000-8000-000000000001")
    assert row["scope_text"] == "best suv" and row["tracked"] is True and row["brand_code"] == "Hyundai"
    assert body["meta"]["mode"] == "admin" and body["meta"]["ignored_filters"] == []
    assert all(i["deleted_at"] is None for i in body["data"]["items"])


async def test_list_filters_change_result(client_as):
    async with client_as(ADMIN) as c:
        full = (await c.get(BASE, params={"limit": 500})).json()["data"]["items"]
        hy = (await c.get(BASE, params={"brand": "Hyundai", "limit": 500})).json()["data"]["items"]
        d2a = (await c.get(BASE, params={"depth2": "D2a", "limit": 500})).json()["data"]["items"]
        acr = (await c.get(BASE, params={"kind": "acr", "limit": 500})).json()["data"]["items"]
        suv = (await c.get(BASE, params={"q": "SUV", "limit": 500})).json()["data"]["items"]
        pct = (await c.get(BASE, params={"q": "%", "limit": 500})).json()["data"]["items"]
    exp_hy = await _val("SELECT count(*) FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL AND brand_code = 'Hyundai'", ROOT_PROJECT)
    exp_d2a = await _val("SELECT count(*) FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL AND depth2 = 'D2a'", ROOT_PROJECT)
    assert len(hy) == exp_hy and 0 < exp_hy < len(full) and all(i["brand_code"] == "Hyundai" for i in hy)
    assert len(d2a) == exp_d2a and exp_d2a >= 3                           # 01·04·11
    assert {i["prompt_id"] for i in acr} >= {"c1000000-0000-4000-8000-000000000003"} and all(i["kind"] == "acr" for i in acr)
    assert {"c1000000-0000-4000-8000-000000000001", "c1000000-0000-4000-8000-000000000004",
            "c1000000-0000-4000-8000-000000000011"} <= {i["prompt_id"] for i in suv}
    assert all("suv" in i["text"].lower() for i in suv)
    assert all("%" in i["text"] for i in pct)                              # % 는 와일드카드가 아니라 글자


async def test_list_include_deleted(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(BASE, params={"include_deleted": "true", "limit": 500})
    body = r.json()
    deleted = await _val("SELECT count(*) FROM app.prompt WHERE project_id = $1 AND deleted_at IS NOT NULL", ROOT_PROJECT)
    assert body["data"]["stats"]["deleted"] == deleted >= 1
    assert "c1000000-0000-4000-8000-000000000005" in {i["prompt_id"] for i in body["data"]["items"]}


async def test_list_empty_and_ignored_filters(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(BASE, params={"q": "zz-없는-문구-zz", "country": "US", "surface": "global", "from": "2026-09-01"})
    assert r.status_code == 200
    body = r.json()
    assert body["data"]["items"] == [] and body["meta"]["page"]["next_cursor"] is None
    assert body["meta"]["ignored_filters"] == ["country", "period", "surface"]
    assert body["data"]["stats"]["total"] > 0                              # 통계는 루트 전체


@pytest.mark.parametrize("params", [{"kind": "bogus"}, {"limit": 0}, {"limit": 501}, {"cursor": "!!bad!!"},
                                    {"brand": "a\x01b"}, {"include_deleted": "maybe"}, {"q": "a\tb"}])   # q = PgLine(R3)
async def test_list_422(client_as, params):
    async with client_as(ADMIN) as c:
        r = await c.get(BASE, params=params)
    assert r.status_code == 422, r.text


async def test_list_keyset_pagination(client_as):
    async with client_as(ADMIN) as c:
        full = (await c.get(BASE, params={"limit": 500})).json()["data"]["items"]
        paged, _ = await _all_items(c, {"limit": 2})
        r = await c.get(BASE, params={"limit": 2})
        cur = r.json()["meta"]["page"]["next_cursor"]
        other = await c.get(BASE, params={"limit": 2, "cursor": cur, "kind": "acr"})       # 다른 필터로 커서 재사용
    assert [i["prompt_id"] for i in paged] == [i["prompt_id"] for i in full]
    assert other.status_code == 422 and other.json()["error"]["code"] == "cursor_invalid"
    # 정렬: depth1, depth2(NULL 뒤), depth3, text
    d2 = [(i["depth1"], i["depth2"]) for i in full if i["depth1"] == "D1"]
    nonnull = [x for x in d2 if x[1] is not None]
    assert d2[: len(nonnull)] == nonnull


# ── 단건 ──
async def test_detail(client_as):
    async with client_as(ADMIN) as c:
        ok = await c.get(f"{BASE}/c1000000-0000-4000-8000-000000000001")
        nf = await c.get(f"{BASE}/{uuid.uuid4()}")
        cust = await c.get(f"{BASE}/c3000000-0000-4000-8000-000000000031")      # 고객 프로젝트 행은 루트 카탈로그 밖
        bad = await c.get(f"{BASE}/not-a-uuid")
    assert ok.status_code == 200
    d = ok.json()["data"]
    assert d["prompt"]["text"] == "best suv" and isinstance(d["pending_changes"], list) and isinstance(d["pending_outbox"], list)
    assert nf.status_code == 404 and cust.status_code == 404
    assert bad.status_code in (404, 422)


# ── 생성 ──
async def test_create_writes_audit_and_outbox(client_as):
    marker = f"create-{uuid.uuid4().hex[:8]}"
    async with client_as(ADMIN) as c:
        r = await c.post(BASE, json={"text": f"  {marker}  ", "brand_code": "Kia", "list_type": " L9 ", "category": "",
                                     "regions": ["us", "x:ww", "US"], "lang": "en", "kind": "single"})
    assert r.status_code == 201, r.text
    d = r.json()["data"]
    p = d["prompt"]
    assert p["text"] == marker and p["brand_code"] == "Kia" and p["list_type"] == "L9" and p["category"] is None
    assert p["regions"] == ["US", "x:WW"] and p["lang"] == "EN" and p["tracked"] is False
    assert d["outbox_id"] is not None and d["propagation"] == "pending" and d["change_ids"] == []   # 미연결 행 = 재판정 요청 없음
    pid = uuid.UUID(p["prompt_id"])
    assert await _val("SELECT count(*) FROM app.prompt_audit_log WHERE prompt_id = $1 AND event_type = 'created' AND actor_id = $2",
                      pid, ADMIN) == 1
    ob = await _val("SELECT payload->>'text' FROM app.scope_outbox WHERE aggregate = 'prompt' AND aggregate_id = $1 AND op = 'create'", pid)
    assert ob == marker
    # 미연결 행 편집은 대기 중 create 의 payload 를 최신으로 덮는다(새 update 행을 만들지 않는다)
    async with client_as(ADMIN) as c:
        r2 = await c.patch(f"{BASE}/{pid}/text", json={"text": marker + "-v2"})
    assert r2.status_code == 200 and r2.json()["data"]["outbox_id"] == d["outbox_id"]
    assert await _val("SELECT count(*) FROM app.scope_outbox WHERE aggregate_id = $1", pid) == 1
    assert await _val("SELECT payload->>'text' FROM app.scope_outbox WHERE outbox_id = $1", d["outbox_id"]) == marker + "-v2"


@pytest.mark.parametrize("body,code", [
    ({"text": "x", "brand_code": "NoSuchBrand"}, "unknown_brand"),
    ({"text": "x", "regions": ["USA"]}, "invalid_region"),
    ({"text": "x", "lang": "eng"}, "invalid_lang"),
    ({"text": "   "}, "unprocessable"),
    ({"text": "x", "brand_presence": "maybe"}, "unprocessable"),
    ({"text": "x", "extra": 1}, "unprocessable"),
    ({"text": "a\x00b"}, "unprocessable"),                                # R3: 본문 PgText(NUL 거부)
    ({"text": "x", "depth1": "줄\n바꿈"}, "unprocessable"),                  # R3: 라벨 PgLine(한 줄, 제어 문자 거부)
])
async def test_create_422_writes_nothing(client_as, body, code):
    before = await _val("SELECT count(*) FROM app.prompt")
    async with client_as(ADMIN) as c:
        r = await c.post(BASE, json=body)
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == code
    assert await _val("SELECT count(*) FROM app.prompt") == before


async def test_regions_vocabulary(client_as, monkeypatch):
    """어휘(rd.dim_project.regions)가 있으면 그 밖의 시장은 422 region_out_of_vocabulary.
    픽스처 루트 regions 는 NULL 이고 테스트가 rd 를 쓰지 않도록(G6) 어휘 조회 문장을 상수 배열을 내는 SELECT 로 바꿔 끼운다
    (root_dim 의 정규화·하위 검증 경로는 그대로 탄다)."""
    from app.features.admin.catalog.prompts import queries as pq

    pid = await _new_tracked(f"vocab-{uuid.uuid4().hex[:6]}")
    monkeypatch.setattr(pq, "ROOT_DIM_SQL", "SELECT project_key, ARRAY['US', 'kr ', 'x:ww']::text[] AS regions "
                                            "FROM rd.dim_project WHERE surface = 1 AND is_root ORDER BY project_key LIMIT 1")
    async with client_as(ADMIN) as c:
        bad = await c.patch(f"{BASE}/{pid}/regions", json={"regions": ["US", "DE"]})
        ok = await c.patch(f"{BASE}/{pid}/regions", json={"regions": ["kr", "US"]})
        mk = await c.get("/v1/admin/catalog/markets")
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "region_out_of_vocabulary"
    assert bad.json()["error"]["details"]["values"] == ["DE"]
    assert ok.status_code == 200 and ok.json()["data"]["prompt"]["regions"] == ["KR", "US"]
    assert [m["code"] for m in mk.json()["data"]["items"]] == ["KR", "US", "x:WW"]


# ── 수정(추적 행: 트리거 감사·재판정 요청 + outbox) ──
async def test_labels_patch_trigger_change_and_outbox(client_as):
    pid = await _new_tracked(f"labels-{uuid.uuid4().hex[:6]}", brand_code="Hyundai", list_type="L1")
    async with client_as(ADMIN) as c:
        r = await c.patch(f"{BASE}/{pid}/labels", json={"brand_code": "Kia", "depth4": "D4x", "list_type": None})
        same = await c.patch(f"{BASE}/{pid}/labels", json={"brand_code": "Kia"})
        empty = await c.patch(f"{BASE}/{pid}/labels", json={})
        bad = await c.patch(f"{BASE}/{pid}/labels", json={"brand_code": "Nope"})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["prompt"]["brand_code"] == "Kia" and d["prompt"]["depth4"] == "D4x" and d["prompt"]["list_type"] is None
    assert d["applied"] is True and d["propagation"] == "pending" and len(d["change_ids"]) == 1
    kind = await _val("SELECT kind FROM app.judgment_change WHERE change_id = $1", d["change_ids"][0])
    assert kind == "catalog"
    ev = await _val("SELECT event_type FROM app.prompt_audit_log WHERE prompt_id = $1 ORDER BY audit_id DESC LIMIT 1", pid)
    assert ev == "meta_updated"
    kws = await _val("SELECT payload->'keywords' FROM app.scope_outbox WHERE outbox_id = $1", d["outbox_id"])
    assert '"hmg:brand:Kia"' in kws
    assert same.status_code == 200 and same.json()["data"]["applied"] is False and same.json()["data"]["propagation"] == "none"
    assert empty.status_code == 422 and bad.status_code == 422


async def test_text_patch_no_judgment_change(client_as):
    pid = await _new_tracked(f"text-{uuid.uuid4().hex[:6]}")
    async with client_as(ADMIN) as c:
        r = await c.patch(f"{BASE}/{pid}/text", json={"text": "  새 본문  "})
        blank = await c.patch(f"{BASE}/{pid}/text", json={"text": "   "})
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["prompt"]["text"] == "새 본문" and d["change_ids"] == [] and d["outbox_id"] is not None   # text 는 판정 입력 아님(cat_f 밖)
    assert await _val("SELECT op FROM app.scope_outbox WHERE outbox_id = $1", d["outbox_id"]) == "update"
    assert await _val("SELECT event_type FROM app.prompt_audit_log WHERE prompt_id = $1 ORDER BY audit_id DESC LIMIT 1", pid) == "text_updated"
    assert blank.status_code == 422


async def test_kind_dry_run_and_apply(client_as):
    pid = await _new_tracked(f"kind-{uuid.uuid4().hex[:6]}")
    before = await _val("SELECT count(*) FROM app.judgment_change WHERE payload->>'prompt_id' = $1", str(pid))
    async with client_as(ADMIN) as c:
        dry = await c.patch(f"{BASE}/{pid}/kind", json={"kind": "acr", "dry_run": True})
        assert await _val("SELECT kind FROM app.prompt WHERE prompt_id = $1", pid) == "single"
        assert await _val("SELECT count(*) FROM app.judgment_change WHERE payload->>'prompt_id' = $1", str(pid)) == before
        real = await c.patch(f"{BASE}/{pid}/kind", json={"kind": "acr"})
    assert dry.status_code == 200 and dry.json()["data"]["applied"] is False and dry.json()["data"]["warnings"] == ["acr_measurement_cost"]
    d = real.json()["data"]
    assert d["prompt"]["kind"] == "acr" and d["warnings"] == ["acr_measurement_cost"]
    kinds = {await _val("SELECT kind FROM app.judgment_change WHERE change_id = $1", i) for i in d["change_ids"]}
    assert kinds == {"prompt_kind"}
    assert await _val("SELECT payload->>'kind' FROM app.scope_outbox WHERE outbox_id = $1", d["outbox_id"]) == "acr"


async def test_delete_restore_state_guard(client_as):
    pid = await _new_tracked(f"del-{uuid.uuid4().hex[:6]}")
    async with client_as(ADMIN) as c:
        d1 = await c.delete(f"{BASE}/{pid}")
        ob = d1.json()["data"]["outbox_id"]
        enabled_after_delete = await _val("SELECT payload->>'enabled' FROM app.scope_outbox WHERE outbox_id = $1", ob)
        d2 = await c.delete(f"{BASE}/{pid}")
        edit = await c.patch(f"{BASE}/{pid}/text", json={"text": "삭제 행 수정"})
        r1 = await c.post(f"{BASE}/{pid}/restore")
        r2 = await c.post(f"{BASE}/{pid}/restore")
        nf = await c.delete(f"{BASE}/{uuid.uuid4()}")
    assert d1.status_code == 200 and d1.json()["data"]["prompt"]["deleted_at"] is not None
    ch = d1.json()["data"]["change_ids"]
    assert len(ch) == 1 and await _val("SELECT kind FROM app.judgment_change WHERE change_id = $1", ch[0]) == "catalog"
    assert enabled_after_delete == "false"
    # 복원은 같은 미완료 update 행을 최신 전체 상태로 덮는다(병합: 잃는 값 없음)
    assert r1.json()["data"]["outbox_id"] == ob
    assert await _val("SELECT payload->>'enabled' FROM app.scope_outbox WHERE outbox_id = $1", ob) == "true"
    assert d2.status_code == 409 and d2.json()["error"]["code"] == "state_mismatch"
    assert edit.status_code == 409
    assert r1.status_code == 200 and r1.json()["data"]["prompt"]["deleted_at"] is None
    assert r2.status_code == 409 and nf.status_code == 404
    evs = await _val("SELECT array_agg(event_type ORDER BY audit_id) FROM app.prompt_audit_log WHERE prompt_id = $1", pid)
    assert evs == ["created", "deleted", "restored"]


async def test_write_rolls_back_on_failure(client_as, monkeypatch):
    """UPDATE 뒤 outbox 단계가 실패하면 prompt·감사·재판정 요청이 모두 롤백된다(한 트랜잭션)."""
    from app.features.admin.catalog.prompts import service as svc

    pid = await _new_tracked(f"rb-{uuid.uuid4().hex[:6]}")
    audits = await _val("SELECT count(*) FROM app.prompt_audit_log WHERE prompt_id = $1", pid)
    changes = await _val("SELECT count(*) FROM app.judgment_change WHERE payload->>'prompt_id' = $1", str(pid))

    async def boom(*a, **k):
        raise errors.conflict("injected", "주입 실패")
    monkeypatch.setattr(svc, "enqueue_prompt_outbox", boom)
    async with client_as(ADMIN) as c:
        r = await c.patch(f"{BASE}/{pid}/labels", json={"brand_code": "Genesis"})
    assert r.status_code == 409
    assert await _val("SELECT brand_code FROM app.prompt WHERE prompt_id = $1", pid) is None
    assert await _val("SELECT count(*) FROM app.prompt_audit_log WHERE prompt_id = $1", pid) == audits
    assert await _val("SELECT count(*) FROM app.judgment_change WHERE payload->>'prompt_id' = $1", str(pid)) == changes


async def test_detail_shows_pending(client_as):
    pid = await _new_tracked(f"pend-{uuid.uuid4().hex[:6]}")
    async with client_as(ADMIN) as c:
        await c.patch(f"{BASE}/{pid}/labels", json={"funnel_stage": "F2"})
        r = await c.get(f"{BASE}/{pid}")
    d = r.json()["data"]
    assert {x["kind"] for x in d["pending_changes"]} == {"catalog"} and len(d["pending_changes"]) >= 2   # 준비 INSERT + 라벨 수정
    assert [x["op"] for x in d["pending_outbox"]] == []                   # funnel_stage 는 Scope 에 보이지 않는 필드


async def test_b075_return_minimal_writes_same_without_response_reads(client_as):
    """B075: return=minimal 은 쓰기·트리거(감사·재판정 요청)·outbox 가 기본(full)과 같고, 응답용 재조회(OUTBOX_FLAGS·TX_CHANGES)만 생략한다.
    prompt·change_id 는 null, change_ids 는 [], propagation 은 outbox 기준. 기본값은 종전(full)."""
    from tests.core.rcache_calls import Stmts

    def response_reads(seen):                    # OUTBOX_FLAGS(outbox 표시 열)·TX_CHANGES(이번 트랜잭션 재판정 요청) 문장 수
        return sum("AS outbox_pending" in q or "requested_at = now()" in q for q in seen)

    a = await _new_tracked(f"min-a-{uuid.uuid4().hex[:6]}")
    b = await _new_tracked(f"min-b-{uuid.uuid4().hex[:6]}")
    calls = [("PATCH", "kind", {"kind": "acr"}), ("PATCH", "text", {"text": "새 본문 min"}), ("PATCH", "labels", {"funnel_stage": "F9"}),
             ("PATCH", "regions", {"lang": "en"}), ("DELETE", "", None), ("POST", "restore", None)]

    async def state(pid):
        return (await _val("SELECT row_to_json(x)::text FROM (SELECT text, kind, funnel_stage, lang, deleted_at IS NULL AS live "
                           "FROM app.prompt WHERE prompt_id = $1) x", pid),
                await _val("SELECT array_agg(event_type ORDER BY audit_id) FROM app.prompt_audit_log WHERE prompt_id = $1", pid),
                await _val("SELECT array_agg(kind ORDER BY change_id) FROM app.judgment_change WHERE payload->>'prompt_id' = $1", str(pid)),
                await _val("SELECT array_agg(op || ':' || (payload->>'kind') || ':' || (payload->>'enabled') ORDER BY outbox_id) "
                           "FROM app.scope_outbox WHERE aggregate = 'prompt' AND aggregate_id = $1", pid))

    async with client_as(ADMIN) as c:
        for method, op, body in calls:
            url = f"{BASE}/{a}" + (f"/{op}" if op else "")
            with Stmts() as sf:
                full = await c.request(method, url, json=body)
            with Stmts() as st:
                mini = await c.request(method, f"{BASE}/{b}" + (f"/{op}" if op else ""), params={"return": "minimal"}, json=body)
            assert full.status_code == 200 and mini.status_code == 200, (op, mini.text)
            fd, md = full.json()["data"], mini.json()["data"]
            assert fd["prompt"] is not None and md["prompt"] is None and md["change_id"] is None and md["change_ids"] == []
            assert (md["applied"], md["warnings"], md["outbox_id"] is not None) == (fd["applied"], fd["warnings"], fd["outbox_id"] is not None)
            assert md["propagation"] == ("pending" if md["outbox_id"] is not None else "none")
            assert response_reads(st.seen) == 0 and response_reads(sf.seen) == 2, op       # full = 2문장(종전), minimal = 0
        # 결과 상태(행·감사·재판정 요청·outbox)는 full 로 쓴 행과 같다
        sa, sb = await state(a), await state(b)
        assert sa[0].replace("min-a", "") == sb[0].replace("min-a", "") and sa[1:] == sb[1:]
        # 변경 없는 요청·dry_run 도 minimal
        same = await c.patch(f"{BASE}/{b}/kind", params={"return": "minimal"}, json={"kind": "acr"})
        dry = await c.patch(f"{BASE}/{b}/kind", params={"return": "minimal"}, json={"kind": "single", "dry_run": True})
        bad = await c.patch(f"{BASE}/{b}/kind", params={"return": "none"}, json={"kind": "acr"})
    assert same.json()["data"]["applied"] is False and same.json()["data"]["propagation"] == "none"
    assert dry.json()["data"]["prompt"] is None and dry.json()["data"]["applied"] is False
    assert bad.status_code == 422
