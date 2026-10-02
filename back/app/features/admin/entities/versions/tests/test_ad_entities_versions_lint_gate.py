"""admin.entities.versions 린트 게이트 회귀 시험(검증자 반례 CE1·CE2·CE7 과 G2·확인 감사, 고정 7cfdeed1 반려분).

  D2  되돌리기 초안 내용 편집 = 409 ECAT_ROLLBACK_IMMUTABLE(쓰기·감사 0). 어떤 길로든 내용이 바뀌면 린트 면제가 풀린다
      (면제 = origin rollback ∧ 내용 지문 = 되돌릴 버전 지문): 다시 미리보기·새 요청 422 ECAT_LINT_BLOCKED, 승인 409 ECAT_LINT_STALE
  D3  전역 차단 표면이 추적 엔티티 표면(대표 표기)과 같으면 L2 에스컬레이션(반영 요청 422 ECAT_LINT_UNACKED 가 그 키를 든다)
  D4  편집 없는 복사 초안 = 린트 L2·L3 0(v1 별칭 행이 자사로 병합돼도). 대상 행이 바뀌면 확인 키가 바뀌어 확인이 풀린다
  G2  미리보기 전(draft) 요청 뒤 편집 = 낡음 표시, 미리보기가 끝나도 승인은 린트 지문이 지금 내용과 같아야 한다
  ack 확인 집합이 같으면(순서만 다름) 쓰기도 감사도 없다
"""
from __future__ import annotations

import json

from app.features.admin.entities.versions.tests.test_ad_entities_versions import (  # noqa: F401  (ecat 픽스처 재사용)
    APPLE,
    HYUNDAI,
    PRODUCT_OWNER,
    TOYOTA,
    A,
    Calls,
    R,
    V,
    _audit_n,
    _code,
    _draft_with_apply,
    _force_status,
    _q,
    _set_approvers,
    _simulate_preview,
    _v,
    _x,
    ecat,
)
from tests.support import ADMIN, needs_db

pytestmark = needs_db


async def _set_tracked(*ids) -> None:
    await _x("INSERT INTO app.rule_param (key, value) VALUES ('ecat_lint', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
             json.dumps({"tracked_entity_ids": [str(i) for i in ids]}))


async def _rollback_draft(c, k: Calls) -> tuple[int, int, int]:
    """v2(Apple 제거) 반영 → 되돌리기. 반환 (되돌릴 반영 id, 되돌리기 초안 ver, 되돌리기 요청 id)."""
    ver, aid = await _draft_with_apply(c, k, scope="unexposed")
    await _simulate_preview(aid, requires_approval=False)
    await _force_status(aid, ["approved", "running"])
    await _x("SELECT app.ecat_activate($1)", ver)
    await _force_status(aid, ["applied"])
    rb = (await k.w("POST", f"{A}/{aid}/rollback", {"reason": "원복"})).json()["data"]
    return aid, rb["ver"], rb["apply_id"]


async def test_d2_rollback_draft_content_immutable(ecat, client_as):  # noqa: F811 (픽스처 주입)
    """반례 CE1 앞 절반: 되돌리기 초안에 L1 표면('N' add)을 넣는 편집이 막히고, 편집 안 된 되돌리기는 그대로 흐른다."""
    await _set_approvers(PRODUCT_OWNER)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        _, rver, rid = await _rollback_draft(c, k)
        n0 = await _audit_n()
        edits = [("POST", f"{V}/{rver}/surfaces", {"entity_id": str(HYUNDAI), "surface": "N", "action": "add"}),
                 ("PUT", f"{V}/{rver}/entities/{TOYOTA}", {"role": "hidden"}),
                 ("POST", f"{V}/{rver}/entities", {"name": "Polestar", "role": "competitor"}),
                 ("DELETE", f"{V}/{rver}/entities/{APPLE}", None)]
        for m, url, body in edits:
            r = await k.w(m, url, body, ok=False)
            assert r.status_code == 409 and _code(r) == "ECAT_ROLLBACK_IMMUTABLE", (m, url, r.status_code, r.text[:200])
        rid_review = int((await _q("INSERT INTO app.ecat_review (kind, entity_id, surface, surface_norm, display_name, entity_type, n_mentions, "
                                   "n_answers) VALUES ('new_surface', $1, 'N', 'n', 'Hyundai', 'Brand', 5, 5) RETURNING review_id", HYUNDAI))[0][0])
        reg = await k.w("POST", f"{R}/{rid_review}/decision", {"action": "register", "surface_action": "add"}, ok=False)
        assert reg.status_code == 409 and _code(reg) == "ECAT_ROLLBACK_IMMUTABLE"
        assert await _audit_n() == n0
        assert await _v("SELECT status FROM app.ecat_review WHERE review_id = $1", rid_review) == "pending"
        same = await _v("SELECT app.ecat_content_md5($1) = app.ecat_content_md5(1)", rver)
        assert same is True                                                              # 내용 = 되돌릴 버전(v1) 그대로
        meta = await k.w("PATCH", f"{V}/{rver}", {"title": "되돌리기 제목 수정"})               # 제목·사유는 고친다
        assert meta.status_code == 200
        await _simulate_preview(rid, requires_approval=False)
        pv = await k.w("POST", f"{A}/{rid}/preview")                                      # 편집 안 된 되돌리기 = 린트 면제
        assert pv.status_code == 200
        await _simulate_preview(rid, requires_approval=False)
        ap = await k.w("POST", f"{A}/{rid}/approve", {})
        assert ap.json()["data"]["status"] == "approved"


async def test_d2_rollback_draft_changed_by_other_path_loses_exemption(ecat, client_as):  # noqa: F811 (픽스처 주입)
    """반례 CE1 뒤 절반(이중 방어): API 밖 길로 되돌리기 초안 내용이 바뀌면(소유자 SQL 로 'N' add) 린트 면제가 풀려
    다시 미리보기·새 요청 422 ECAT_LINT_BLOCKED, 미리보기가 끝난 요청의 승인 409 ECAT_LINT_STALE."""
    await _set_approvers(PRODUCT_OWNER)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        _, rver, rid = await _rollback_draft(c, k)
        await _x("INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, lang, created_by) VALUES ($1, 'N', 'n', NULL, $2) "
                 "ON CONFLICT ON CONSTRAINT ecat_surface_def_uniq DO NOTHING", HYUNDAI, ADMIN)
        await _x("INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT $1, d.surface_id, 'add' FROM app.ecat_surface_def d "
                 "WHERE d.entity_id = $2 AND d.surface_norm = 'n' AND d.lang IS NULL", rver, HYUNDAI)
        assert await _v("SELECT app.ecat_content_md5($1) = app.ecat_content_md5(1)", rver) is False
        await _simulate_preview(rid, requires_approval=False)                             # 적재기가 바뀐 내용으로 미리보기를 끝냈다
        ap = await k.w("POST", f"{A}/{rid}/approve", {}, ok=False)
        assert ap.status_code == 409 and _code(ap) == "ECAT_LINT_STALE", ap.text[:200]
        pv = await k.w("POST", f"{A}/{rid}/preview", ok=False)
        assert pv.status_code == 422 and _code(pv) == "ECAT_LINT_BLOCKED", pv.text[:200]
        await k.w("POST", f"{A}/{rid}/reject", {"reason": "다시"})
        nr = await k.w("POST", A, {"scope_kind": "unexposed", "reason": "L1 우회", "ver": rver}, ok=False)
        assert nr.status_code == 422 and _code(nr) == "ECAT_LINT_BLOCKED", nr.text[:200]
        assert await _v("SELECT status FROM app.ecat_apply WHERE apply_id = $1", rid) == "rejected"


async def test_g2_edit_before_preview_needs_fresh_lint_to_approve(ecat, client_as):  # noqa: F811 (픽스처 주입)
    """요청(린트 통과) → 미리보기 전 편집으로 L1 추가 → 미리보기 완료 → 승인 409 ECAT_LINT_STALE → 다시 미리보기 422 ECAT_LINT_BLOCKED."""
    await _set_approvers(PRODUCT_OWNER)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver, aid = await _draft_with_apply(c, k, scope="unexposed")
        e = (await k.w("POST", f"{V}/{ver}/surfaces", {"entity_id": str(HYUNDAI), "surface": "N", "action": "add"})).json()["data"]
        assert e["stale_applies"] == [aid]
        row = (await _q("SELECT status, error FROM app.ecat_apply WHERE apply_id = $1", aid))[0]
        assert row["status"] == "draft" and row["error"].startswith("ECAT_PREVIEW_STALE")
        await _x("UPDATE app.ecat_apply SET error = NULL WHERE apply_id = $1", aid)          # 적재기 미리보기는 오류를 지운다
        await _simulate_preview(aid, requires_approval=False)
        n0 = await _audit_n()
        ap = await k.w("POST", f"{A}/{aid}/approve", {}, ok=False)
        assert ap.status_code == 409 and _code(ap) == "ECAT_LINT_STALE", ap.text[:200]
        assert await _audit_n() == n0 and await _v("SELECT status FROM app.ecat_apply WHERE apply_id = $1", aid) == "previewed"
        assert await _v("SELECT count(*) FROM app.judgment_change WHERE kind = 'entity_version' AND payload->>'op' = 'apply'") == 0
        pv = await k.w("POST", f"{A}/{aid}/preview", ok=False)
        assert pv.status_code == 422 and _code(pv) == "ECAT_LINT_BLOCKED"


async def test_d3_global_block_of_tracked_name_escalates(ecat, client_as):  # noqa: F811 (픽스처 주입)
    """반례 CE2: 전역 차단 'Hyundai'(추적 엔티티 대표 표기)가 L2 에스컬레이션으로 잡히고 확인 전 반영 요청이 그 키로 막힌다."""
    await _set_tracked(HYUNDAI)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver = (await k.w("POST", V, {"title": "전역 차단"})).json()["data"]["version"]["ver"]
        blk = (await k.w("POST", f"{V}/{ver}/surfaces", {"surface": "Hyundai", "action": "block"})).json()["data"]["surface"]
        lint = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
        hit = [f for f in lint["findings"] if f["target"] == f"surface:{blk['surface_id']}"]
        assert [(f["level"], f["code"], f["escalate"]) for f in hit] == [("L2", "TRACKED_ENTITY_EDIT", True)], lint["findings"]
        assert lint["unacked"] == [hit[0]["key"]]                                       # 변경 없는 별칭 행 L2 없음(D4)
        r = await k.w("POST", A, {"scope_kind": "unexposed", "reason": "전역 차단 Hyundai"}, ok=False)
        assert r.status_code == 422 and _code(r) == "ECAT_LINT_UNACKED" and r.json()["error"]["details"]["unacked"] == [hit[0]["key"]]


async def test_d4_unchanged_copy_is_clean_and_ack_resets_on_change(ecat, client_as):  # noqa: F811 (픽스처 주입)
    """반례 CE7(API): 추적 설정 아래 편집 없는 복사 초안 = L1·L2·L3 0. 추적 엔티티 행을 확인한 뒤 그 행이 바뀌면 확인이 풀린다."""
    await _set_tracked(HYUNDAI, TOYOTA)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver = (await k.w("POST", V, {"title": "무편집"})).json()["data"]["version"]["ver"]
        clean = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
        assert not clean["blocked"] and clean["counts"]["L1"] == clean["counts"]["L2"] == clean["counts"]["L3"] == 0, clean["findings"]
        await k.w("PUT", f"{V}/{ver}/entities/{TOYOTA}", {"role": "hidden"})
        l1 = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
        key = l1["unacked"][0]
        assert l1["unacked"] == [key] and key.startswith(f"TRACKED_ENTITY_EDIT|entity:{TOYOTA}|")
        await k.w("PUT", f"{V}/{ver}/lint/acks", {"keys": [key]})
        await k.w("PUT", f"{V}/{ver}/entities/{TOYOTA}", {"role": "hidden", "merge_into": str(APPLE)})
        l2 = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]
        assert l2["acked"] == [] and len(l2["unacked"]) >= 1 and key not in l2["unacked"]
        assert all(u.startswith(f"TRACKED_ENTITY_EDIT|entity:{TOYOTA}|") for u in l2["unacked"])


async def test_ack_reorder_is_noop(ecat, client_as):  # noqa: F811 (픽스처 주입)
    """확인 키 집합이 같으면(순서만 다름) 저장·감사 둘 다 없다. 집합이 바뀌면 저장 + 감사 1행."""
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver = (await k.w("POST", V, {"title": "확인"})).json()["data"]["version"]["ver"]
        await k.w("POST", f"{V}/{ver}/surfaces", {"entity_id": str(TOYOTA), "surface": "Epit", "action": "add"})
        await k.w("POST", f"{V}/{ver}/surfaces", {"entity_id": str(APPLE), "surface": "Zork", "action": "add"})
        keys = (await k.w("POST", f"{V}/{ver}/lint")).json()["data"]["unacked"]
        assert len(keys) == 2
        await k.w("PUT", f"{V}/{ver}/lint/acks", {"keys": keys})
        n0 = await _audit_n()
        same = await k.w("PUT", f"{V}/{ver}/lint/acks", {"keys": list(reversed(keys))}, ok=False)
        assert same.status_code == 200 and await _audit_n() == n0
        stored = json.loads(await _v("SELECT lint::text FROM app.ecat_version WHERE ver = $1", ver))
        assert stored["acked"] == keys                                                    # 쓰기 없음(순서 그대로)
        await k.w("PUT", f"{V}/{ver}/lint/acks", {"keys": keys[:1]})                        # 집합 변경 = 저장 + 감사
