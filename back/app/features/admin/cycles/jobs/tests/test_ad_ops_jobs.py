"""admin.cycles.jobs 통합 테스트(로컬 개발 DB, 합성 픽스처).

픽스처(fixture-10-data.sql): job k17(회차 10, 2026-09-07) 앵커 고정 'test pin', k14 드롭 'test drop'(서빙 아님), k13 비완료(running),
k1 완료·서빙(회차 11, 2026-09-14).
"""
from __future__ import annotations

import json
import uuid

import asyncpg
import pytest_asyncio

from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db

K1, K13, K14, K17 = (f"90000000-0000-4000-8000-0000000000{n:02d}" for n in (1, 13, 14, 17))
C10 = "f0000000-0000-4000-8000-000000000010"


@pytest_asyncio.fixture(loop_scope="session")
async def owner(seeded):
    c = await asyncpg.connect(DB_URL)
    tag = f"t-jobs-{uuid.uuid4().hex[:8]}"
    yield c, tag
    await c.execute("DELETE FROM app.judgment_change WHERE kind IN ('anchor_pin', 'answer_drop') AND payload->>'reason' LIKE $1",
                    f"{tag}%")
    await c.close()


async def test_auth_gates(client_as, owner):
    c_, tag = owner
    async with client_as(None) as c:
        assert (await c.get(f"/v1/admin/jobs/{K17}/registry")).status_code == 401
    for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
        async with client_as(uid) as c:
            for r in (await c.get(f"/v1/admin/jobs/{K17}/registry"),
                      await c.post(f"/v1/admin/jobs/{K1}/drop", json={"reason": tag, "confirm": True}),
                      await c.post(f"/v1/admin/jobs/{K1}/anchor-pin", json={"reason": tag, "anchor": "2026-09-14"})):
                assert r.status_code == 403 and "test pin" not in r.text
    assert await c_.fetchval("SELECT count(*) FROM app.judgment_change WHERE payload->>'reason' = $1", tag) == 0


async def test_registry(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(f"/v1/admin/jobs/{K17}/registry")
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["pin"] == {"anchor": "2026-09-07", "reason": "test pin", "source_measured_at": None}
        assert d["drop"] is None and d["cycle_id"] == C10 and d["status"] == "completed" and d["served"] is True
        assert "answer_key" not in r.text and '"cyc_key"' not in r.text
        d = (await c.get(f"/v1/admin/jobs/{K14}/registry")).json()["data"]
        assert d["dropped"] is True and d["served"] is False and d["drop"]["reason"] == "test drop" and d["pin"] is None
        d = (await c.get(f"/v1/admin/jobs/{K13}/registry")).json()["data"]
        assert d["status"] == "running" and d["analysis_state"] is None and d["pin"] is None and d["drop"] is None
        assert (await c.get(f"/v1/admin/jobs/{uuid.uuid4()}/registry")).status_code == 404
        assert (await c.get("/v1/admin/jobs/not-a-uuid/registry")).status_code == 422


async def test_anchor_pin(client_as, owner):
    c_, tag = owner
    async with client_as(ADMIN) as c:
        r = await c.post(f"/v1/admin/jobs/{K1}/anchor-pin", json={"reason": tag, "anchor": "2026-09-14", "dry_run": True})
        assert r.status_code == 200 and r.json()["data"]["warnings"] == [] and r.json()["data"]["change_id"] is None
        r = await c.post(f"/v1/admin/jobs/{K1}/anchor-pin", json={"reason": tag, "anchor": "2099-01-01"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "anchor_in_future"
        r = await c.post(f"/v1/admin/jobs/{K17}/anchor-pin", json={"reason": tag, "anchor": "2026-09-07"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "state_mismatch"
        for body in ({"reason": "", "anchor": "2026-09-14"}, {"reason": tag}, {"reason": tag, "anchor": "2026-09-14", "x": 1}):
            assert (await c.post(f"/v1/admin/jobs/{K1}/anchor-pin", json=body)).status_code == 422
        r = await c.post(f"/v1/admin/jobs/{K1}/anchor-pin", json={"reason": f"{tag} 앵커", "anchor": "2026-09-13"})
        assert r.status_code == 202, r.text
        d = r.json()["data"]
        assert d["kind"] == "anchor_pin" and d["propagation"] == "pending" and any("회차 날짜" in w for w in d["warnings"])
        row = await c_.fetchrow("SELECT kind, subject_uuids, payload, requested_by FROM app.judgment_change WHERE change_id = $1",
                                d["change_id"])
        pl = json.loads(row["payload"])
        assert row["kind"] == "anchor_pin" and [str(u) for u in row["subject_uuids"]] == [K1] and row["requested_by"] == ADMIN
        # op 명시: core.contracts AnchorPin(op 기본 set)을 payload 에 적는다(6라운드 계약 통일)
        assert pl == {"job_id": K1, "op": "set", "anchor": "2026-09-13", "reason": f"{tag} 앵커", "old": None}
        reg = (await c.get(f"/v1/admin/jobs/{K1}/registry")).json()["data"]
        assert [(p["change_id"], p["kind"]) for p in reg["pending"]] == [(d["change_id"], "anchor_pin")]
        r = await c.post(f"/v1/admin/jobs/{K1}/anchor-pin", json={"reason": tag, "anchor": "2026-09-12"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_pending"
        assert await c_.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'anchor_pin' AND payload->>'reason' LIKE $1",
                                 f"{tag}%") == 1


async def test_drop(client_as, owner):
    c_, tag = owner
    async with client_as(ADMIN) as c:
        r = await c.post(f"/v1/admin/jobs/{K1}/drop", json={"reason": tag})
        assert r.status_code == 422 and r.json()["error"]["code"] == "confirm_required"
        r = await c.post(f"/v1/admin/jobs/{K1}/drop", json={"reason": tag, "dry_run": True})
        assert r.status_code == 200 and "서빙 중" in r.json()["data"]["warnings"][0]
        r = await c.post(f"/v1/admin/jobs/{K14}/drop", json={"reason": tag, "confirm": True})
        assert r.status_code == 409 and r.json()["error"]["code"] == "state_mismatch"
        assert (await c.post(f"/v1/admin/jobs/{uuid.uuid4()}/drop", json={"reason": tag, "confirm": True})).status_code == 404
        r = await c.post(f"/v1/admin/jobs/{K13}/drop", json={"reason": f"{tag} 드롭", "confirm": True})
        assert r.status_code == 202 and "서빙되지 않는" in r.json()["data"]["warnings"][0]
        pl = json.loads(await c_.fetchval("SELECT payload FROM app.judgment_change WHERE change_id = $1", r.json()["data"]["change_id"]))
        assert pl == {"job_id": K13, "op": "drop", "reason": f"{tag} 드롭"}      # op 명시: core.contracts AnswerDrop(op 기본 drop)
        assert await c_.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'answer_drop' AND payload->>'reason' LIKE $1",
                                 f"{tag}%") == 1


async def test_d5_blank_reason_rejected(client_as, owner):
    """검증 D5 회귀: 공백만 있는 드롭·앵커 고정 사유는 dry_run 이어도 422, 요청을 남기지 않는다(감사 사유가 비지 않게)."""
    c_, tag = owner
    before = await c_.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind IN ('anchor_pin', 'answer_drop') "
                               "AND subject_uuids && $1::uuid[]", [uuid.UUID(K1), uuid.UUID(K13)])
    async with client_as(ADMIN) as c:
        for reason in ("   ", "\t \n", ""):
            for dry in (True, False):
                r = await c.post(f"/v1/admin/jobs/{K13}/drop", json={"reason": reason, "confirm": True, "dry_run": dry})
                assert r.status_code == 422, (reason, dry, r.text)
                r = await c.post(f"/v1/admin/jobs/{K1}/anchor-pin", json={"reason": reason, "anchor": "2026-09-14", "dry_run": dry})
                assert r.status_code == 422, (reason, dry, r.text)
        r = await c.post(f"/v1/admin/jobs/{K13}/drop", json={"reason": f"  {tag} 사유  ", "confirm": True, "dry_run": True})
        assert r.status_code == 200
    assert await c_.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind IN ('anchor_pin', 'answer_drop') "
                             "AND subject_uuids && $1::uuid[]", [uuid.UUID(K1), uuid.UUID(K13)]) == before
