"""admin.entities.versions(E6 엔티티 버전 관리 API) 통합 시험. 설계 hmg-entity-management-versioning-design-20261001.md 7·8절 E6.

수용 기준
  A1 비관리자 403(401 무인증·정지) 전 엔드포인트(라우터 전 경로 자동 열거), 쓰기 0
  A2 승인자 외 노출 회차 승인 403 ECAT_EXPOSED_REQUIRES_APPROVAL(상태·감사 불변), 승인자는 통과, 미노출은 요청 관리자 자체 승인
  A3 초안 중복 409 ECAT_DRAFT_EXISTS
  A4 L1 있을 때 반영 요청 422 ECAT_LINT_BLOCKED(반영 행·큐·감사 0), 미확인 L2 422 ECAT_LINT_UNACKED, 확인 뒤 통과
  A5 감사 행 누락 0: 성공한 쓰기 호출마다 app.ecat_audit_log ≥ 1행(행위자·요청 ID), 실패한 쓰기는 0행, api_rw 는 감사 행을 못 고친다
  + 기존 명부 PUT 은 컷오버 뒤 409 ECAT_LEGACY_WRITE(쓰기 0), 적재기 계약(E6 가 넣은 반영 행을 E4 미리보기가 처리, 롤백 트랜잭션)

상태: 이 대분류(admin) 복제본에서 API 쓰기는 커밋된다. 시험마다 v1 이관(app.ecat_cutover_v1)으로 시작하고 끝에 ecat_* 전부를
소유자(superuser)가 복제 모드(session_replication_role = replica, 불변 트리거 우회)로 지운다: 뒤따르는 admin 시험은 버전 없는 상태를 본다.
"""
from __future__ import annotations

import json
import pathlib
import re
import uuid

import asyncpg
import pytest

from app.features.admin.entities.versions import router as vrouter
from tests.support import (
    ADMIN,
    DB_URL,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    SUSPENDED,
    VENDOR,
    WEBSITE_KIA,
    Sql,
    load_named_sql,
    needs_db,
    raw_fetch,
    staged,
)

pytestmark = needs_db

V = "/v1/admin/entities/versions"
A = "/v1/admin/entities/applies"
R = "/v1/admin/entities/review"
PRODUCT_OWNER = uuid.UUID("7e000000-0000-4000-8000-0000000000f1")
HYUNDAI, KIA = uuid.UUID("00000000-0000-0000-0000-000000000301"), uuid.UUID("00000000-0000-0000-0000-000000000302")
KIA_KO = uuid.UUID("ed4b8012-4a73-4174-9b43-4cb696934b25")
TOYOTA, TOYOTA2, APPLE = (uuid.UUID(f"71000000-0000-4000-8000-00000000000{n}") for n in (1, 2, 3))
CRETA, TATA = uuid.UUID("71000000-0000-4000-8000-000000000004"), uuid.UUID("71000000-0000-4000-8000-000000000005")

SQL = load_named_sql(pathlib.Path(__file__).with_name("ecat6.pgsql"))
CLEANUP = SQL["cleanup"]


async def _conn() -> asyncpg.Connection:
    return await asyncpg.connect(DB_URL)


async def _q(sql: str, *args):
    c = await _conn()
    try:
        return await c.fetch(sql, *args)
    finally:
        await c.close()


async def _v(sql: str, *args):
    c = await _conn()
    try:
        return await c.fetchval(sql, *args)
    finally:
        await c.close()


async def _x(sql: str, *args) -> None:
    c = await _conn()
    try:
        await c.execute(sql, *args)
    finally:
        await c.close()


@pytest.fixture
async def ecat():
    """v1 이관(운영 명부 = 픽스처 별칭 7행) → 시험 → 전부 지움."""
    await _x(CLEANUP)
    reg_before = await _q("SELECT * FROM app.ecat_legacy_md5()")
    await _x("SELECT app.ecat_cutover_v1($1, 'E6 시험')", ADMIN)
    try:
        yield
    finally:
        await _x(CLEANUP)
        assert await _q("SELECT * FROM app.ecat_legacy_md5()") == reg_before          # 명부·별칭 표는 이관 전 그대로


@pytest.fixture
async def no_versions():
    await _x(CLEANUP)
    yield
    await _x(CLEANUP)


async def _audit_n() -> int:
    return int(await _v("SELECT count(*) FROM app.ecat_audit_log"))


class Calls:
    """성공한 쓰기 호출 수와 감사 행 증가를 함께 센다(A5)."""

    def __init__(self, c):
        self.c = c
        self.writes: list[tuple[str, str, int]] = []

    async def w(self, method: str, url: str, json_body=None, ok: bool = True):
        before = await _audit_n()
        r = await self.c.request(method, url, json=json_body)
        after = await _audit_n()
        if ok:
            assert r.status_code == 200, (method, url, r.text)
            assert after > before, (method, url, "감사 행 없음")
        self.writes.append((method, url, after - before))
        if r.status_code != 200:
            assert after == before, (method, url, r.status_code, "실패한 쓰기가 감사 행을 남겼다")
        return r


def _code(r) -> str:
    return r.json()["error"]["code"]


# ════════════════════════════════════════════════════════════════════════════
# A1 권한: 전 엔드포인트
# ════════════════════════════════════════════════════════════════════════════
def _routes() -> list[tuple[str, str]]:
    out = []
    for rt in vrouter.router.routes:
        path = rt.path
        path = re.sub(r"\{ver\}", "1", path)
        path = re.sub(r"\{entity_id\}", str(TOYOTA), path)
        path = re.sub(r"\{(apply_id|review_id|surface_id)\}", "1", path)
        for m in sorted(rt.methods):
            out.append((m, path))
    return out


def test_route_inventory():
    routes = _routes()
    assert len(routes) == 26 and len({p for _, p in routes}) == 22
    assert all(p.startswith("/v1/admin/entities") for _, p in routes)


@pytest.mark.parametrize("uid,status", [(HQ_HYUNDAI, 403), (KIA_US, 403), (VENDOR, 403), (KIA_EU, 403), (WEBSITE_KIA, 403),
                                        (SUSPENDED, 401), (None, 401)])
async def test_non_admin_forbidden_everywhere(ecat, client_as, uid, status):
    before = (await _audit_n(), await _v("SELECT count(*) FROM app.ecat_version"), await _v("SELECT count(*) FROM app.ecat_apply"),
              await _v("SELECT count(*) FROM app.judgment_change"))
    bad = []
    async with client_as(uid) as c:
        for m, p in _routes():
            params = {"surface": "global"} if p.endswith("/mentions") else None
            r = await c.request(m, p, params=params, json={} if m in ("POST", "PUT", "PATCH") else None)
            if r.status_code != status:
                bad.append((m, p, r.status_code))
    assert not bad, bad
    after = (await _audit_n(), await _v("SELECT count(*) FROM app.ecat_version"), await _v("SELECT count(*) FROM app.ecat_apply"),
             await _v("SELECT count(*) FROM app.judgment_change"))
    assert after == before


async def test_admin_reaches_every_endpoint(ecat, client_as):
    """관리자는 권한 단계를 통과한다(403·401 이 아닌 응답: 404·409·422 는 업무 규칙)."""
    async with client_as(ADMIN) as c:
        for m, p in _routes():
            params = {"surface": "global"} if p.endswith("/mentions") else None
            r = await c.request(m, p, params=params, json={} if m in ("POST", "PUT", "PATCH") else None)
            assert r.status_code not in (401, 403, 500), (m, p, r.status_code, r.text[:200])


# ════════════════════════════════════════════════════════════════════════════
# 초안·편집·비교
# ════════════════════════════════════════════════════════════════════════════
async def test_draft_lifecycle_and_duplicate(ecat, client_as):
    async with client_as(ADMIN) as c:
        k = Calls(c)
        lst = await c.get(V)
        assert lst.status_code == 200 and lst.json()["data"]["active_ver"] == 1 and lst.json()["data"]["draft_ver"] is None
        r = await k.w("POST", V, {"title": "  초안 A ", "reason": "시험"})
        d = r.json()["data"]
        ver = d["version"]["ver"]
        assert d["version"]["status"] == "draft" and d["version"]["based_on"] == 1 and d["version"]["title"] == "초안 A"
        assert d["version"]["origin"] == "admin" and d["version"]["created_by"] == str(ADMIN)
        v1 = (await c.get(f"{V}/1")).json()["data"]
        assert len(d["entities"]) == len(v1["entities"]) == 7                       # v1 = 픽스처 별칭 7행(merge_into)
        assert d["content_md5"] == v1["content_md5"]                                 # 복사 = 같은 내용
        dup = await k.w("POST", V, {"title": "초안 B"}, ok=False)
        assert dup.status_code == 409 and _code(dup) == "ECAT_DRAFT_EXISTS" and dup.json()["error"]["details"] == {"ver": ver}
        await k.w("PATCH", f"{V}/{ver}", {"title": "초안 A2"})
        same = await k.w("PATCH", f"{V}/{ver}", {"title": "초안 A2"}, ok=False)          # 변경 없음 = 200, 감사 없음
        assert same.status_code == 200
        edit_active = await k.w("PUT", f"{V}/1/entities/{TOYOTA}", {"role": "hidden"}, ok=False)
        assert edit_active.status_code == 409 and _code(edit_active) == "ECAT_VERSION_STATE"
        lst = (await c.get(V)).json()["data"]
        assert lst["draft_ver"] == ver and [i["ver"] for i in lst["items"]] == [ver, 1]
        dis = await k.w("POST", f"{V}/{ver}/discard", {"reason": "안 씀"})
        assert dis.json()["data"]["status"] == "discarded"
        again = await k.w("POST", f"{V}/{ver}/discard", {}, ok=False)
        assert again.status_code == 409 and _code(again) == "ECAT_VERSION_STATE"
        nf = await c.get(f"{V}/999")
        assert nf.status_code == 404 and _code(nf) == "ECAT_VERSION_NOT_FOUND"
    acts = [r["action"] for r in await _q("SELECT action FROM app.ecat_audit_log ORDER BY audit_id")]
    assert acts == ["draft.create", "draft.update", "draft.discard"]


async def test_no_active_version(no_versions, client_as):
    async with client_as(ADMIN) as c:
        r = await c.post(V, json={"title": "x"})
        ap = await c.post(A, json={"scope_kind": "unexposed", "reason": "x"})
    assert r.status_code == 409 and _code(r) == "ECAT_NO_ACTIVE"
    assert ap.status_code == 409 and _code(ap) == "ECAT_NO_ACTIVE"
    assert await _audit_n() == 0


async def test_entity_and_surface_edits(ecat, client_as):
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver = (await k.w("POST", V, {"title": "편집"})).json()["data"]["version"]["ver"]
        e = f"{V}/{ver}/entities"
        h = (await k.w("PUT", f"{e}/{TOYOTA}", {"role": "hidden"})).json()["data"]
        assert h["changed"] and h["entity"]["role"] == "hidden" and h["entity"]["name"] == "Toyota" and h["entity"]["observed"]
        await k.w("PUT", f"{e}/{APPLE}", {"role": "removed", "note": "비자동차"})
        await k.w("PUT", f"{e}/{TOYOTA2}", {"role": "competitor", "merge_into": str(TOYOTA)})
        chain = await k.w("PUT", f"{e}/{TOYOTA}", {"role": "hidden", "merge_into": str(APPLE)}, ok=False)      # 대상이 병합 원본 → 사슬
        assert chain.status_code == 422 and _code(chain) == "ECAT_MERGE_CHAIN"
        for body, code in [({"role": "own"}, "brand_required"), ({"role": "own", "brand_code": "HMG"}, "invalid_brand"),
                           ({"role": "competitor", "merge_into": str(TATA)}, None)]:
            r = await k.w("PUT", f"{e}/{CRETA}", body, ok=code is None)
            if code:
                assert r.status_code == 422 and _code(r) == code
        self_m = await k.w("PUT", f"{e}/{CRETA}", {"role": "competitor", "merge_into": str(CRETA)}, ok=False)
        assert self_m.status_code == 422 and _code(self_m) == "ECAT_MERGE_SELF"
        unk = await k.w("PUT", f"{e}/{uuid.uuid4()}", {"role": "hidden", "name": "x"}, ok=False)
        assert unk.status_code == 404 and _code(unk) == "ECAT_UNKNOWN_ENTITY"
        own = (await k.w("PUT", f"{e}/{HYUNDAI}", {"role": "own", "brand_code": "Hyundai"})).json()["data"]["entity"]
        assert own["brand_code"] == "Hyundai" and own["name"] == "Hyundai"
        back = (await k.w("PUT", f"{e}/{CRETA}", {"role": "competitor"})).json()["data"]          # 기본값 = 행 삭제
        assert back["changed"] and back["entity"] is None
        nop = await k.w("PUT", f"{e}/{CRETA}", {"role": "competitor"}, ok=False)
        assert nop.status_code == 200 and nop.json()["data"]["changed"] is False
        hub = (await k.w("POST", e, {"name": "Polestar", "role": "competitor"})).json()["data"]["entity"]
        assert hub["origin"] == "hub" and hub["observed"] is False and hub["entity_type"] == "Brand"
        s = f"{V}/{ver}/surfaces"
        add = (await k.w("POST", s, {"entity_id": hub["entity_id"], "surface": " Polestar  2 ", "action": "add"})).json()["data"]["surface"]
        assert add["surface_norm"] == "polestar 2" and add["action"] == "add"
        glob_add = await k.w("POST", s, {"surface": "Plus", "action": "add"}, ok=False)
        assert glob_add.status_code == 422 and _code(glob_add) == "ECAT_SURFACE_ADD_GLOBAL"
        blk = (await k.w("POST", s, {"surface": "Plus", "action": "block"})).json()["data"]["surface"]
        assert blk["entity_id"] is None
        flip = (await k.w("POST", s, {"entity_id": str(HYUNDAI), "surface": "N", "action": "block"})).json()["data"]["surface"]
        again = (await k.w("POST", s, {"entity_id": str(HYUNDAI), "surface": "n", "action": "block"}, ok=False)).json()["data"]
        assert again["changed"] is False and again["surface"]["surface_id"] == flip["surface_id"]            # 정의 재사용(정규형)
        in_use = await k.w("DELETE", f"{e}/{hub['entity_id']}", ok=False)
        assert in_use.status_code == 409 and _code(in_use) == "ECAT_ENTITY_IN_USE"
        await k.w("DELETE", f"{s}/{add['surface_id']}")
        await k.w("DELETE", f"{e}/{hub['entity_id']}")
        gone = await k.w("DELETE", f"{s}/{add['surface_id']}", ok=False)
        assert gone.status_code == 404
        detail = (await c.get(f"{V}/{ver}")).json()["data"]
        roles = {x["entity_id"]: x["role"] for x in detail["entities"]}
        assert roles[str(TOYOTA)] == "hidden" and roles[str(APPLE)] == "removed" and roles[str(HYUNDAI)] == "own" and str(CRETA) not in roles
        diff = (await c.get(f"{V}/{ver}/diff")).json()["data"]
        assert diff["against"] == 1
        assert diff["counts"] == {"entity_added": 4, "surface_added": 2}, diff["counts"]          # v1 = 별칭 7행, 초안 = + TOYOTA·APPLE·TOYOTA2·HYUNDAI
        added = {x["entity_id"]: x["after"] for x in diff["entities"]}
        assert added[str(TOYOTA2)]["merge_into"] == str(TOYOTA) and added[str(APPLE)]["note"] == "비자동차"
        v1_diff = (await c.get(f"{V}/{ver}/diff", params={"against": ver})).json()["data"]
        assert v1_diff["entities"] == [] and v1_diff["surfaces"] == []
    rows = await _q("SELECT ver, entity_id, role, updated_by FROM app.ecat_entity WHERE ver = $1 AND entity_id = $2", ver, TOYOTA)
    assert rows[0]["updated_by"] == ADMIN


# ════════════════════════════════════════════════════════════════════════════
# A4 린트 게이트
# ════════════════════════════════════════════════════════════════════════════
async def test_lint_gate_blocks_and_unacked(ecat, client_as):
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver = (await k.w("POST", V, {"title": "린트"})).json()["data"]["version"]["ver"]
        n = (await k.w("POST", f"{V}/{ver}/surfaces", {"entity_id": str(HYUNDAI), "surface": "N", "action": "add"})).json()["data"]["surface"]
        lint = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
        assert lint["blocked"] and lint["counts"]["L1"] == 1 and lint["findings"][0]["code"] == "SURFACE_SINGLE_CHAR" and not lint["stale"]
        before = (await _v("SELECT count(*) FROM app.ecat_apply"), await _v("SELECT count(*) FROM app.judgment_change WHERE kind = 'entity_version'"))
        blocked = await k.w("POST", A, {"scope_kind": "unexposed", "reason": "N 추가"}, ok=False)
        assert blocked.status_code == 422 and _code(blocked) == "ECAT_LINT_BLOCKED"
        assert blocked.json()["error"]["details"]["keys"] == [lint["findings"][0]["key"]]
        assert lint["findings"][0]["key"].startswith(f"SURFACE_SINGLE_CHAR|surface:{n['surface_id']}|")       # 코드|대상|내용 지문
        assert (await _v("SELECT count(*) FROM app.ecat_apply"),
                await _v("SELECT count(*) FROM app.judgment_change WHERE kind = 'entity_version'")) == before
        await k.w("DELETE", f"{V}/{ver}/surfaces/{n['surface_id']}")
        ep = (await k.w("POST", f"{V}/{ver}/surfaces", {"entity_id": str(TOYOTA), "surface": "Epit", "action": "add"})).json()["data"]["surface"]
        lint = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
        key = next(f["key"] for f in lint["findings"] if f["target"] == f"surface:{ep['surface_id']}")
        assert key.startswith(f"SURFACE_ASCII_4_5|surface:{ep['surface_id']}|")
        assert not lint["blocked"] and lint["unacked"] == [key]
        un = await k.w("POST", A, {"scope_kind": "unexposed", "reason": "Epit"}, ok=False)
        assert un.status_code == 422 and _code(un) == "ECAT_LINT_UNACKED" and un.json()["error"]["details"]["unacked"] == [key]
        bad = await k.w("PUT", f"{V}/{ver}/lint/acks", {"keys": ["NOPE|x"]}, ok=False)
        assert bad.status_code == 422 and _code(bad) == "ECAT_LINT_UNKNOWN_KEY"
        ack = (await k.w("PUT", f"{V}/{ver}/lint/acks", {"keys": [key]})).json()["data"]
        assert ack["acked"] == [key] and ack["unacked"] == []
        ok = await k.w("POST", A, {"scope_kind": "unexposed", "reason": "Epit 추가"})
        d = ok.json()["data"]
        assert d["status"] == "draft" and d["ver"] == ver and d["from_ver"] == 1 and d["requested_by"] == str(ADMIN)
        assert [(q["op"], q["status"]) for q in d["queue"]] == [("preview", "pending")]
        stale_edit = await k.w("PUT", f"{V}/{ver}/entities/{APPLE}", {"role": "hidden"})
        assert stale_edit.json()["data"]["stale_applies"] == [d["apply_id"]]                             # 미리보기 전(draft) 요청도 낡음 표시
        assert await _v("SELECT status || ':' || error FROM app.ecat_apply WHERE apply_id = $1", d["apply_id"]) == \
            "draft:ECAT_PREVIEW_STALE: 미리보기 뒤 초안이 바뀌었다(다시 미리보기)"
        stale = await k.w("PUT", f"{V}/{ver}/lint/acks", {"keys": [key]}, ok=False)
        assert stale.status_code == 409 and _code(stale) == "ECAT_LINT_STALE"
        dup = await k.w("POST", A, {"scope_kind": "all", "reason": "또"}, ok=False)
        assert dup.status_code == 409 and _code(dup) == "ECAT_APPLY_OPEN"
        fr = await k.w("POST", A, {"scope_kind": "from_round", "reason": "x"}, ok=False)
        assert fr.status_code == 422 and _code(fr) == "ECAT_SCOPE_INVALID"
    pl = await _v("SELECT payload::text FROM app.judgment_change WHERE kind = 'entity_version'")
    assert json.loads(pl) == {"apply_id": d["apply_id"], "op": "preview"}


# ════════════════════════════════════════════════════════════════════════════
# A2 승인·거절·재개·되돌리기
# ════════════════════════════════════════════════════════════════════════════
async def _simulate_preview(apply_id: int, *, requires_approval: bool) -> None:
    """적재기 E4 결과 흉내(소유자): previewed + preview JSON(ecat_engine 모양의 필요한 키) + 큐 행 applied."""
    pv = {"v": 1, "apply_id": apply_id, "requires_approval": requires_approval,
          "cycles": {"in_scope": 2, "exposed_in_scope": [10] if requires_approval else [], "pin_to_active": []}}
    await _x("UPDATE app.ecat_apply SET status = 'previewed', preview = $2::jsonb, preview_set_md5 = decode(md5('x'), 'hex'), "
             "cycle_keys = '{11,12}', affected_answers = 3 WHERE apply_id = $1", apply_id, json.dumps(pv))
    await _x("UPDATE app.judgment_change SET status = 'applied', applied_at = now() WHERE kind = 'entity_version' AND status = 'pending' "
             "AND payload @> $1::jsonb", json.dumps({"apply_id": apply_id}))


async def _set_approvers(*uids: uuid.UUID) -> None:
    await _x("INSERT INTO app.rule_param (key, value) VALUES ('ecat_approvers', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
             json.dumps([str(u) for u in uids]))


async def _draft_with_apply(c, k: Calls, scope: str = "all", **extra) -> tuple[int, int]:
    ver = (await k.w("POST", V, {"title": "반영"})).json()["data"]["version"]["ver"]
    await k.w("PUT", f"{V}/{ver}/entities/{APPLE}", {"role": "removed"})
    body = {"scope_kind": scope, "reason": "Apple 제거", **extra}
    return ver, (await k.w("POST", A, body)).json()["data"]["apply_id"]


async def test_exposed_approval_requires_approver(ecat, client_as):
    await _set_approvers(PRODUCT_OWNER)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver, aid = await _draft_with_apply(c, k)
        early = await k.w("POST", f"{A}/{aid}/approve", {}, ok=False)
        assert early.status_code == 409 and _code(early) == "ECAT_APPLY_STATE"
        await _simulate_preview(aid, requires_approval=True)
        det = (await c.get(f"{A}/{aid}")).json()["data"]
        assert det["status"] == "previewed" and det["requires_approval"] and det["approver_required"] and det["can_approve"] is False
        assert "approve" not in det["actions"] and det["preview"]["cycles"]["exposed_in_scope"] == [10]
        n0 = await _audit_n()
        denied = await k.w("POST", f"{A}/{aid}/approve", {}, ok=False)
        assert denied.status_code == 403 and _code(denied) == "ECAT_EXPOSED_REQUIRES_APPROVAL"
        assert await _audit_n() == n0 and await _v("SELECT status FROM app.ecat_apply WHERE apply_id = $1", aid) == "previewed"
        assert await _v("SELECT count(*) FROM app.judgment_change WHERE kind = 'entity_version' AND payload->>'op' = 'apply'") == 0
        await _set_approvers(PRODUCT_OWNER, ADMIN)
        det = (await c.get(f"{A}/{aid}")).json()["data"]
        assert det["can_approve"] and "approve" in det["actions"]
        ok = (await k.w("POST", f"{A}/{aid}/approve", {"reason": "확인"})).json()["data"]
        assert ok["status"] == "approved" and ok["approved_by"] == str(ADMIN)
        assert [(q["op"], q["status"]) for q in ok["queue"]][0] == ("apply", "pending")
    row = (await _q("SELECT detail FROM app.ecat_audit_log WHERE action = 'apply.approve'"))[0]
    assert json.loads(row["detail"])["requires_approval"] is True


async def test_unexposed_self_approval_and_stale(ecat, client_as):
    await _set_approvers(PRODUCT_OWNER)                                                       # 관리자는 승인자 목록 밖
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver, aid = await _draft_with_apply(c, k, scope="unexposed")
        await _simulate_preview(aid, requires_approval=False)
        edit = (await k.w("PUT", f"{V}/{ver}/entities/{TOYOTA}", {"role": "hidden"})).json()["data"]
        assert edit["stale_applies"] == [aid]
        stale = await k.w("POST", f"{A}/{aid}/approve", {}, ok=False)
        assert stale.status_code == 409 and _code(stale) == "ECAT_PREVIEW_STALE"
        re_pv = (await k.w("POST", f"{A}/{aid}/preview")).json()["data"]
        assert [(q["op"], q["status"]) for q in re_pv["queue"]][0] == ("preview", "pending")
        pending = await k.w("POST", f"{A}/{aid}/approve", {}, ok=False)
        assert pending.status_code == 409 and _code(pending) in ("ECAT_PREVIEW_STALE", "ECAT_PREVIEW_PENDING")
        await _x("UPDATE app.ecat_apply SET error = NULL WHERE apply_id = $1", aid)
        await _simulate_preview(aid, requires_approval=False)
        ok = (await k.w("POST", f"{A}/{aid}/approve", {})).json()["data"]
        assert ok["status"] == "approved" and ok["requires_approval"] is False
        rej = (await k.w("POST", f"{A}/{aid}/reject", {"reason": "보류"})).json()["data"]
        assert rej["status"] == "rejected" and rej["error_code"] == "ECAT_REJECTED"
        again = await k.w("POST", f"{A}/{aid}/reject", {"reason": "또"}, ok=False)
        assert again.status_code == 409 and _code(again) == "ECAT_APPLY_STATE"
        empty = await k.w("POST", f"{A}/{aid}/reject", {"reason": ""}, ok=False)
        assert empty.status_code == 422


async def _force_status(apply_id: int, path: list[str]) -> None:
    """소유자: 상태 전이 트리거가 허용하는 길로 반영 행을 옮긴다(적재기 흉내)."""
    for st in path:
        await _x("UPDATE app.ecat_apply SET status = $2, approved_by = coalesce(approved_by, $3), approved_at = coalesce(approved_at, now()), "
                 "started_at = CASE WHEN $2 IN ('running','applied','failed') THEN coalesce(started_at, now()) ELSE started_at END, "
                 "finished_at = CASE WHEN $2 = 'applied' THEN now() ELSE finished_at END, "
                 "error = CASE WHEN $2 = 'failed' THEN 'ECAT_SCAN_FAILED: 시험' ELSE NULL END WHERE apply_id = $1", apply_id, st, ADMIN)


async def test_busy_resume_and_rollback(ecat, client_as):
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver, aid = await _draft_with_apply(c, k)
        await _simulate_preview(aid, requires_approval=False)
        await _force_status(aid, ["approved", "running", "failed"])
        det = (await c.get(f"{A}/{aid}")).json()["data"]
        assert det["status"] == "failed" and det["error_code"] == "ECAT_SCAN_FAILED" and "resume" in det["actions"]
        busy = await k.w("POST", V + f"/{ver}/discard", {}, ok=True)                    # 초안 폐기는 막지 않는다(열린 요청만 거절 대상)
        assert busy.json()["data"]["rejected_applies"] == []
        ver2 = (await k.w("POST", V, {"title": "다음"})).json()["data"]["version"]["ver"]
        blocked = await k.w("POST", A, {"scope_kind": "unexposed", "reason": "x"}, ok=False)
        assert blocked.status_code == 409 and _code(blocked) == "ECAT_APPLY_RUNNING"
        assert blocked.json()["error"]["details"] == {"apply_id": aid, "status": "failed"}
        res = (await k.w("POST", f"{A}/{aid}/resume")).json()["data"]
        assert [(q["op"], q["status"]) for q in res["queue"]][0] == ("resume", "pending")
        dup = await k.w("POST", f"{A}/{aid}/resume", ok=False)
        assert dup.status_code == 409
        await k.w("POST", f"{V}/{ver2}/discard", {})
    # 되돌리기: v2 를 활성으로(적재기 흉내) + 그 반영을 applied 로
    await _x(CLEANUP)
    await _x("SELECT app.ecat_cutover_v1($1, 'E6 시험')", ADMIN)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver, aid = await _draft_with_apply(c, k, scope="from_round", from_round_date="2026-09-14")
        await _simulate_preview(aid, requires_approval=False)
        await _force_status(aid, ["approved", "running"])
        await _x("SELECT app.ecat_activate($1)", ver)
        await _force_status(aid, ["applied"])
        det = (await c.get(f"{A}/{aid}")).json()["data"]
        assert det["actions"] == ["rollback"]
        rb = (await k.w("POST", f"{A}/{aid}/rollback", {"reason": "원복"})).json()["data"]
        assert rb["scope_kind"] == "from_round" and rb["from_round_date"] == "2026-09-14" and rb["from_ver"] == ver
        new = (await c.get(f"{V}/{rb['ver']}")).json()["data"]
        assert new["version"]["origin"] == "rollback" and new["version"]["based_on"] == 1
        v1 = (await c.get(f"{V}/1")).json()["data"]
        assert new["content_md5"] == v1["content_md5"]                              # 되돌릴 버전(v1) 내용 그대로
        dup = await k.w("POST", f"{A}/{aid}/rollback", {"reason": "또"}, ok=False)
        assert dup.status_code == 409 and _code(dup) in ("ECAT_DRAFT_EXISTS", "ECAT_APPLY_OPEN")
    acts = [r["action"] for r in await _q("SELECT action FROM app.ecat_audit_log WHERE apply_id IS NOT NULL OR action = 'draft.create' ORDER BY audit_id")]
    assert acts[-2:] == ["draft.create", "apply.rollback"]


# ════════════════════════════════════════════════════════════════════════════
# 검토 대기함
# ════════════════════════════════════════════════════════════════════════════
async def test_review_register_and_dismiss(ecat, client_as):
    ids = [int(r[0]) for r in await _q("""
        INSERT INTO app.ecat_review (kind, entity_id, surface, surface_norm, display_name, entity_type, n_mentions, n_answers)
        VALUES ('new_entity', $1, NULL, NULL, 'Tata', 'Brand', 3, 2), ('new_surface', $2, 'N', 'n', 'Hyundai', 'Brand', 50, 40),
               ('new_entity', $3, NULL, NULL, 'Apple', 'Brand', 1, 1)
        RETURNING review_id""", TATA, HYUNDAI, APPLE)]
    async with client_as(ADMIN) as c:
        k = Calls(c)
        lst = (await c.get(R)).json()["data"]["items"]
        assert [i["review_id"] for i in lst] == sorted(ids, reverse=True)
        assert [i["display_name"] for i in (await c.get(R, params={"q": "tat"})).json()["data"]["items"]] == ["Tata"]
        nodraft = await k.w("POST", f"{R}/{ids[0]}/decision", {"action": "register", "role": "hidden"}, ok=False)
        assert nodraft.status_code == 409 and _code(nodraft) == "ECAT_NO_DRAFT"
        ver = (await k.w("POST", V, {"title": "대기함"})).json()["data"]["version"]["ver"]
        r1 = (await k.w("POST", f"{R}/{ids[0]}/decision", {"action": "register", "role": "removed", "note": "비대상"})).json()["data"]
        assert r1["review"]["status"] == "resolved" and r1["review"]["resolved_ver"] == ver and r1["entity"]["role"] == "removed"
        r2 = (await k.w("POST", f"{R}/{ids[1]}/decision", {"action": "register"})).json()["data"]
        assert r2["surface"]["action"] == "block" and r2["surface"]["surface_norm"] == "n" and r2["surface"]["entity_id"] == str(HYUNDAI)
        r3 = (await k.w("POST", f"{R}/{ids[2]}/decision", {"action": "dismiss", "note": "무시"})).json()["data"]
        assert r3["review"]["status"] == "dismissed" and r3["ver"] is None and r3["review"]["decided_by"] == str(ADMIN)
        again = await k.w("POST", f"{R}/{ids[2]}/decision", {"action": "dismiss"}, ok=False)
        assert again.status_code == 409 and _code(again) == "ECAT_REVIEW_DECIDED"
        assert (await c.get(R)).json()["data"]["items"] == []
        assert {i["status"] for i in (await c.get(R, params={"status": "all"})).json()["data"]["items"]} == {"resolved", "dismissed"}
    acts = [r["action"] for r in await _q("SELECT action FROM app.ecat_audit_log ORDER BY audit_id")]
    assert acts == ["draft.create", "entity.upsert", "review.register", "surface.block", "review.register", "review.dismiss"]


# ════════════════════════════════════════════════════════════════════════════
# A5 감사 완전성·기존 PUT·적재기 계약
# ════════════════════════════════════════════════════════════════════════════
async def test_audit_rows_complete_and_append_only(ecat, client_as):
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver = (await k.w("POST", V, {"title": "감사"})).json()["data"]["version"]["ver"]
        await k.w("PUT", f"{V}/{ver}/entities/{TOYOTA}", {"role": "hidden"})
        await k.w("POST", f"{V}/{ver}/surfaces", {"surface": "Modern", "action": "block"})
        await k.w("POST", f"{V}/{ver}/lint")
        aid = (await k.w("POST", A, {"scope_kind": "unexposed", "reason": "감사 시험"})).json()["data"]["apply_id"]
        await k.w("POST", f"{A}/{aid}/reject", {"reason": "끝"})
        listing = (await c.get("/v1/admin/entities/audit", params={"ver": ver})).json()["data"]["items"]
    succeeded = [w for w in k.writes if w[2] > 0]
    rows = await _q("SELECT actor_id, request_id, action FROM app.ecat_audit_log ORDER BY audit_id")
    assert len(rows) == sum(n for *_, n in succeeded) == len(succeeded) == 6
    assert all(r["actor_id"] == ADMIN and r["request_id"] is not None for r in rows)
    assert [x["action"] for x in listing] == ["apply.reject", "apply.request", "lint.run", "surface.block", "entity.upsert", "draft.create"]
    c2 = await _conn()
    try:
        async with c2.transaction():
            await c2.execute(SQL["role_api_rw"])
            await c2.execute("SELECT set_config('app.actor_id', $1, true)", str(ADMIN))
            with pytest.raises(asyncpg.PostgresError):
                await c2.execute("UPDATE app.ecat_audit_log SET action = 'x.y'")
        async with c2.transaction():
            await c2.execute(SQL["role_api_rw"])
            with pytest.raises(asyncpg.PostgresError, match="app.actor_id"):              # 행위자 없는 감사 행 거부
                await c2.execute("INSERT INTO app.ecat_audit_log (action) VALUES ('draft.create')")
    finally:
        await c2.close()


async def test_legacy_put_rejected_after_cutover(ecat, client_as):
    before = await _v("SELECT count(*) FROM app.judgment_change WHERE kind = 'entity'")
    async with client_as(ADMIN) as c:
        r = await c.put(f"/v1/admin/entities/{TOYOTA}", json={"role": "excluded", "name": "x"})
        lst = await c.get("/v1/admin/entities", params={"surface": "global"})
    assert r.status_code == 409 and _code(r) == "ECAT_LEGACY_WRITE"
    assert lst.status_code == 200                                                    # 읽기는 그대로(활성 버전 투영)
    assert await _v("SELECT count(*) FROM app.judgment_change WHERE kind = 'entity'") == before
    assert await _v("SELECT count(*) FROM app.entity_registry WHERE entity_id = $1", TOYOTA) == 0


async def test_engine_previews_e6_request(ecat, client_as, monkeypatch):
    """적재기 계약: E6 가 넣은 반영 행·큐 행을 E4 미리보기(process_change, loader 롤)가 처리해 previewed 가 되고, E6 상세가 그 결과를 읽는다.
    미리보기는 롤백 트랜잭션 안(복제본 불변)."""
    from ingest.common.db import LoaderDB
    from ingest.cycles.workers.service import process_change
    from ingest.project.apply import ecat_engine as ee

    async def no_scan(db, payload):
        return None
    monkeypatch.setattr(ee, "prepare", no_scan)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver, aid = await _draft_with_apply(c, k, scope="unexposed")
    cid = int(await _v("SELECT change_id FROM app.judgment_change WHERE kind = 'entity_version' AND payload @> $1::jsonb",
                       json.dumps({"apply_id": aid})))
    conn = await _conn()
    try:
        tr = conn.transaction()
        await tr.start()
        try:
            await conn.execute(SQL["role_loader"])
            out = await process_change(LoaderDB("postgresql://unused"), conn, change_id=cid)
            await conn.execute(SQL["role_reset"])
            row = await conn.fetchrow("SELECT status, preview, error FROM app.ecat_apply WHERE apply_id = $1", aid)
            assert out is not None and out.status == "applied", out
            assert row["status"] == "previewed" and row["error"] is None
            pv = json.loads(row["preview"])
            assert pv["apply_id"] == aid and pv["ver"] == ver and pv["from_ver"] == 1 and pv["requires_approval"] is False
            assert {"impact", "cycles", "kpi_metrics", "brands", "samples", "approx"} <= set(pv)
        finally:
            await tr.rollback()
    finally:
        await conn.close()


# ════════════════════════════════════════════════════════════════════════════
# 언급 표본
# ════════════════════════════════════════════════════════════════════════════
BODY = "For compact SUVs, the Hyundai Tucson and the Toyota RAV4 lead. Hyundai also offers hybrids."


async def test_mention_samples(ecat, client_as):
    async with staged(Sql(SQL["answer_text"], (BODY,)), Sql(SQL["mention_surfaces"], (HYUNDAI,)), Sql(SQL["occurrence"], (HYUNDAI,))) as conn:
        keys = {r["answer_key"] for r in await raw_fetch(conn, "SELECT answer_key FROM rd.answer_brand WHERE brand_key = 1 AND surface = 1 "
                                                               "AND round_date = '2026-09-14' AND cyc_key = ANY('{11}'::int4[])")}
        async with client_as(ADMIN) as c:
            r = await c.get(f"/v1/admin/entities/{HYUNDAI}/mentions", params={"surface": "global"})
            flt = await c.get(f"/v1/admin/entities/{HYUNDAI}/mentions", params={"surface": "global", "surface_text": "HYUNDAI"})
            none = await c.get(f"/v1/admin/entities/{HYUNDAI}/mentions", params={"surface": "global", "surface_text": "Genesis"})
            nf = await c.get(f"/v1/admin/entities/{uuid.uuid4()}/mentions", params={"surface": "global"})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["name"] == "Hyundai" and d["brand_name"] == "Hyundai" and r.json()["meta"]["cycles"] == ["2026-09-14"]
    by_src = {(i["answer_key"], i["source"]) for i in d["items"]}
    assert {1, 12} <= keys
    occ = next(i for i in d["items"] if i["source"] == "occurrence")
    assert occ["answer_key"] == 12 and occ["context"].endswith("value…") and occ["highlight"] == [18, 25] and occ["sentiment"] == "positive"
    body = next(i for i in d["items"] if i["source"] == "body")
    assert body["answer_key"] == 1 and body["surface_text"] == "Hyundai" and body["context"][body["highlight"][0]:body["highlight"][1]] == "Hyundai"
    assert (1, "body") in by_src and (12, "occurrence") in by_src
    assert d["surfaces"] == [{"surface": "Hyundai", "n": 1}]
    assert len(flt.json()["data"]["items"]) == len(d["items"]) and none.json()["data"]["items"] == []
    assert nf.status_code == 404 and _code(nf) == "ECAT_UNKNOWN_ENTITY"
