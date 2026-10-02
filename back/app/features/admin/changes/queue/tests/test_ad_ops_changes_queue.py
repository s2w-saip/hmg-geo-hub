"""admin.changes.queue 통합 테스트(로컬 개발 DB, 합성 픽스처). 기대값은 테스트가 직접 넣은 행에서 손으로 센다."""
from __future__ import annotations

import json
import uuid

import asyncpg
import pytest_asyncio

from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db


@pytest_asyncio.fixture(loop_scope="session")
async def rows(seeded):
    """이 테스트 전용 요청 3건(주체 텍스트가 고유해 다른 테스트 행과 섞이지 않는다). 끝나면 소유자 접속으로 지운다."""
    tag = f"t-queue-{uuid.uuid4()}"
    su = uuid.uuid4()
    c = await asyncpg.connect(DB_URL)
    try:
        ids = []
        for kind, status, st, sus in (("citation_override", "pending", [tag], None), ("rule_param", "applied", [tag], None),
                                      ("cycle_admin", "failed", None, [su])):
            ids.append(await c.fetchval(
                "INSERT INTO app.judgment_change (kind, subject_texts, subject_uuids, payload, requested_by, status, error) "
                "VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING change_id",
                kind, st, sus, json.dumps({"op": "t", "tag": tag}), ADMIN, status, "boom" if status == "failed" else None))
        yield {"tag": tag, "uuid": su, "ids": ids}
    finally:
        await c.execute("DELETE FROM app.judgment_change WHERE payload->>'tag' = $1", tag)
        await c.close()


async def test_auth_gates(client_as, rows):
    async with client_as(None) as c:
        assert (await c.get("/v1/admin/changes")).status_code == 401
    for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
        async with client_as(uid) as c:
            r = await c.get("/v1/admin/changes")
            assert r.status_code == 403, uid
            r = await c.get(f"/v1/admin/changes/{rows['ids'][0]}")
            assert r.status_code == 403
            assert "boom" not in r.text                                   # 권한 밖 누출 0


async def test_list_filters_and_shape(client_as, rows):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/admin/changes", params={"subject": rows["tag"]})
        assert r.status_code == 200, r.text
        b = r.json()
        items = b["data"]["items"]
        assert [i["change_id"] for i in items] == sorted(rows["ids"][:2], reverse=True)     # 텍스트 주체 2건, change_id DESC
        assert items[0]["kind"] == "rule_param" and items[0]["status"] == "applied"
        assert items[1]["requested_by"] == str(ADMIN) and items[1]["requested_by_email"] == "t-admin@example.test"
        assert b["meta"]["mode"] == "admin" and b["meta"]["page"]["limit"] == 50 and b["meta"]["page"]["next_cursor"] is None
        # 필터 전후 값 변화: kind·status 로 좁히면 1건
        r = await c.get("/v1/admin/changes", params={"subject": rows["tag"], "kind": "citation_override"})
        assert [i["change_id"] for i in r.json()["data"]["items"]] == [rows["ids"][0]]
        r = await c.get("/v1/admin/changes", params={"subject": rows["tag"], "status": ["applied", "failed"]})
        assert [i["change_id"] for i in r.json()["data"]["items"]] == [rows["ids"][1]]
        # UUID 주체는 subject_uuids 로 찾는다
        r = await c.get("/v1/admin/changes", params={"subject": str(rows["uuid"])})
        its = r.json()["data"]["items"]
        assert [i["change_id"] for i in its] == [rows["ids"][2]] and its[0]["error"] == "boom"
        # 요청자 필터(다른 사람) → 빈 결과, 공통 필터 축은 무시 사실을 드러낸다
        r = await c.get("/v1/admin/changes", params={"subject": rows["tag"], "requested_by": str(HQ_HYUNDAI), "surface": "global",
                                                     "from": "2026-09-01"})
        assert r.status_code == 200 and r.json()["data"]["items"] == []
        assert r.json()["meta"]["ignored_filters"] == ["period", "surface"]


async def test_pagination(client_as, rows):
    async with client_as(ADMIN) as c:
        r1 = await c.get("/v1/admin/changes", params={"subject": rows["tag"], "limit": 1})
        b1 = r1.json()
        nxt = b1["meta"]["page"]["next_cursor"]
        assert len(b1["data"]["items"]) == 1 and nxt
        r2 = await c.get("/v1/admin/changes", params={"subject": rows["tag"], "limit": 1, "cursor": nxt})
        b2 = r2.json()
        assert [b1["data"]["items"][0]["change_id"], b2["data"]["items"][0]["change_id"]] == sorted(rows["ids"][:2], reverse=True)
        assert b2["meta"]["page"]["next_cursor"] is None
        # 다른 필터로 커서 재사용 → 422 cursor_invalid
        r = await c.get("/v1/admin/changes", params={"subject": rows["tag"], "kind": "rule_param", "limit": 1, "cursor": nxt})
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"


async def test_invalid_params_and_detail(client_as, rows):
    async with client_as(ADMIN) as c:
        for params in ({"kind": "nope"}, {"status": "done"}, {"limit": 0}, {"limit": 201}, {"requested_by": "x"}):
            r = await c.get("/v1/admin/changes", params=params)
            assert r.status_code == 422, params
            assert r.json()["error"]["code"] == "unprocessable"
        r = await c.get(f"/v1/admin/changes/{rows['ids'][2]}")
        assert r.status_code == 200
        d = r.json()["data"]
        assert d["status"] == "failed" and d["subject_uuids"] == [str(rows["uuid"])] and d["payload"]["tag"] == rows["tag"]
        assert (await c.get("/v1/admin/changes/999999999999")).status_code == 404
        assert (await c.get("/v1/admin/changes/0")).status_code == 422
        assert (await c.get("/v1/admin/changes/abc")).status_code == 422
