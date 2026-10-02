"""POST /v1/admin/entities/applies/{apply_id}/abandon(failed 반영 포기 → 적재기 op abandon). 권한(admin + 메뉴 admin)은 라우터 공통
의존성이라 test_ad_entities_versions 의 전 경로 열거 시험(A1)이 이 경로도 덮는다. 여기서는 업무 규칙·감사·큐만 본다.
"""
from __future__ import annotations

import json

from app.features.admin.entities.versions.tests.test_ad_entities_versions import (  # noqa: F401 (ecat = 픽스처)
    A,
    Calls,
    _code,
    _draft_with_apply,
    _force_status,
    _q,
    _simulate_preview,
    _x,
    ecat,
)
from tests.support import ADMIN, needs_db

pytestmark = needs_db


async def test_abandon_failed_apply_enqueues_and_audits(ecat, client_as):  # noqa: F811 (픽스처 주입)
    async with client_as(ADMIN) as c:
        k = Calls(c)
        ver, aid = await _draft_with_apply(c, k)
        await _simulate_preview(aid, requires_approval=False)
        early = await k.w("POST", f"{A}/{aid}/abandon", {"reason": "포기"}, ok=False)               # previewed 는 포기 대상 아님
        assert early.status_code == 409 and _code(early) == "ECAT_APPLY_STATE"
        await _force_status(aid, ["approved", "running", "failed"])
        det = (await c.get(f"{A}/{aid}")).json()["data"]
        assert {"resume", "abandon"} <= set(det["actions"])
        empty = await k.w("POST", f"{A}/{aid}/abandon", {"reason": ""}, ok=False)
        assert empty.status_code == 422
        res = (await k.w("POST", f"{A}/{aid}/abandon", {"reason": "원천 결함으로 이 반영을 닫는다"})).json()["data"]
        assert [(q["op"], q["status"]) for q in res["queue"]][0] == ("abandon", "pending")
        dup = await k.w("POST", f"{A}/{aid}/abandon", {"reason": "또"}, ok=False)
        assert dup.status_code == 409 and _code(dup) == "duplicate_pending"
        # 적재기가 포기를 시작한 뒤(preview.abandon 기록): 재개는 거절, 동작 목록에서도 빠진다
        await _x("UPDATE app.judgment_change SET status = 'applied', applied_at = now() WHERE kind = 'entity_version' AND status = 'pending' "
                 "AND payload @> $1::jsonb", json.dumps({"apply_id": aid}))
        await _x("UPDATE app.ecat_apply SET preview = preview || '{\"abandon\": {\"started_at\": \"x\"}}'::jsonb WHERE apply_id = $1", aid)
        det2 = (await c.get(f"{A}/{aid}")).json()["data"]
        assert "resume" not in det2["actions"] and "abandon" in det2["actions"]
        rs = await k.w("POST", f"{A}/{aid}/resume", ok=False)
        assert rs.status_code == 409 and _code(rs) == "ECAT_APPLY_STATE"
    rows = await _q("SELECT action, detail FROM app.ecat_audit_log WHERE apply_id = $1 AND action = 'apply.abandon'", aid)
    assert len(rows) == 1
    d = json.loads(rows[0]["detail"]) if isinstance(rows[0]["detail"], str) else rows[0]["detail"]
    assert d["reason"] == "원천 결함으로 이 반영을 닫는다" and d["previous_error"] == "ECAT_SCAN_FAILED: 시험" and d["change_id"]
