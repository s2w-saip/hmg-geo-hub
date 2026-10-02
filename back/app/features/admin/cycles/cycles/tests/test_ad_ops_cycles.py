"""admin.cycles.cycles 통합 테스트(로컬 개발 DB, 합성 픽스처 회차만: rd 는 쓰지 않는다).

손 계산 기대값(tests/fixtures/fixture-10-data.sql)
- 글로벌(프로젝트 루트) 회차: 10 = 2026-09-07(발행), 11 = 09-14(발행), 12 = 09-21(open·비서빙·원장). 모두 숨김 없음.
  웹사이트 21 = 09-18 인용 숨김(사유 operator), 프로젝트 31 = 09-20 가상 회차(원장 없음, open).
- 회차 11: rd.cycle 카운터 expected 10·completed_units 9·completed_answers 12·gap 3.
  rd.job 15건(answer_key 1~15): status 0 = 14(드롭 k14 포함), 1 = 1(k13), 드롭 1, 서빙 13.
  rd.answer 13건 analysis_state: 0 = k1·k2·k3·k12(4), 1 = k5(1), 2 = k4·k6·k7·k8·k10·k11·k15(7), 3 = k9(1) → gap 8.
- 숨김 경고: 10 을 숨기면 같은 주(2026-09-07 주) 남는 회차 0, 더 최신 비숨김 2(11·12). 12 는 가장 최근.
"""
from __future__ import annotations

import json
import uuid

import asyncpg
import pytest_asyncio

from app.features.admin.cycles.cycles.service import close_warnings, hide_cycle_warnings
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_DE_SITE, KIA_US, ROOT_PROJECT, VENDOR, needs_db

C = {k: f"f0000000-0000-4000-8000-0000000000{k}" for k in (10, 11, 12, 21, 31)}


@pytest_asyncio.fixture(loop_scope="session")
async def owner(seeded):
    """픽스처 회차에 대한 운영 요청(cycle_admin)을 시작·끝에 지운다(적재기가 없어 대기 요청이 남으므로 재실행 대비)."""
    c = await asyncpg.connect(DB_URL)
    ids = [uuid.UUID(v) for v in C.values()]
    sql = "DELETE FROM app.judgment_change WHERE kind = 'cycle_admin' AND subject_uuids && $1::uuid[]"
    await c.execute(sql, ids)
    yield c
    await c.execute(sql, ids)
    await c.close()


async def _changes(owner, cid: str) -> int:
    return await owner.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'cycle_admin' AND $1::uuid = ANY(subject_uuids)",
                                uuid.UUID(cid))


@needs_db
async def test_auth_gates(client_as, owner):
    async with client_as(None) as c:
        assert (await c.get("/v1/admin/cycles", params={"surface": "global"})).status_code == 401
    for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
        async with client_as(uid) as c:
            for r in (await c.get("/v1/admin/cycles", params={"surface": "global"}), await c.get(f"/v1/admin/cycles/{C[11]}"),
                      await c.post(f"/v1/admin/cycles/{C[10]}/hide", json={"reason": "operator"}),
                      await c.put(f"/v1/admin/cycles/{C[12]}/view-date", json={"view_date": "2026-09-23"})):
                assert r.status_code == 403, (uid, r.text)
                assert "2026-09-14" not in r.text
    assert await _changes(owner, C[10]) == 0


@needs_db
async def test_list_default_window_and_filters(client_as, owner):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/admin/cycles", params={"surface": "global"})
        assert r.status_code == 200, r.text
        b = r.json()
        items = b["data"]["items"]
        assert [i["cycle_id"] for i in items] == [C[12], C[11], C[10]]
        assert [i["status"] for i in items] == ["open", "published", "published"] and items[0]["servable"] is False
        assert items[1]["pending"] == [] and items[1]["project_id"] == str(ROOT_PROJECT) and items[1]["view_date"] == "2026-09-16"
        assert b["meta"]["source"]["default_window"] is True and b["meta"]["surface"] == "global" and b["meta"]["generation"] == 1
        assert '"cyc_key"' not in r.text and "project_key" not in r.text
        # 필터 전후: 기간을 09-10~09-20 으로 좁히면 11 하나, 지원하지 않는 축은 ignored_filters
        r = await c.get("/v1/admin/cycles", params={"surface": "global", "from": "2026-09-10", "to": "2026-09-20", "country": "US"})
        b = r.json()
        assert [i["cycle_id"] for i in b["data"]["items"]] == [C[11]]
        assert b["meta"]["ignored_filters"] == ["country"] and b["meta"]["source"]["default_window"] is False
        # 웹사이트 + 사이트 필터, 프로젝트 표면(가상 회차)
        r = await c.get("/v1/admin/cycles", params={"surface": "website", "project_id": str(KIA_DE_SITE)})
        assert [(i["cycle_id"], i["hidden_scope"], i["hidden_reason"], i["site_id"]) for i in r.json()["data"]["items"]] == \
            [(C[21], "citations", "operator", str(KIA_DE_SITE))]
        r = await c.get("/v1/admin/cycles", params={"surface": "project"})
        assert [(i["cycle_id"], i["ledger_backed"]) for i in r.json()["data"]["items"]] == [(C[31], False)]
        assert (await c.get("/v1/admin/cycles", params={"surface": "website", "project_id": str(ROOT_PROJECT)})).status_code == 404
        r = await c.get("/v1/admin/cycles", params={"surface": "global", "from": "2020-01-01", "to": "2020-01-31"})
        assert r.status_code == 200 and r.json()["data"]["items"] == []


@needs_db
async def test_d3_list_ignores_custom_visibly(client_as):
    """검증 D3 회귀: 회차 목록에 cf.*(custom)가 오면 조용히 버리지 않고 meta.ignored_filters 에 드러낸다(목록은 그대로)."""
    cf = f"cf.{uuid.uuid4()}"
    async with client_as(ADMIN) as c:
        for surface in ("project", "global", "website"):
            base = (await c.get("/v1/admin/cycles", params={"surface": surface})).json()
            r = await c.get("/v1/admin/cycles", params={"surface": surface, cf: "x"})
            assert r.status_code == 200 and r.json()["meta"]["ignored_filters"] == ["custom"], (surface, r.text)
            assert r.json()["data"] == base["data"]
        r = await c.get("/v1/admin/cycles", params={"surface": "global", cf: "x", "country": "US"})
        assert r.json()["meta"]["ignored_filters"] == ["country", "custom"]
        assert (await c.get("/v1/admin/cycles", params={"surface": "global", "cf.bad": "x"})).status_code == 422


@needs_db
async def test_d5_blank_reason_rejected(client_as, owner):
    """검증 D5 회귀: 공백만 있는 마감 사유는 dry_run 이어도 422, 요청을 남기지 않는다. 앞뒤 공백은 걷어 저장한다."""
    async with client_as(ADMIN) as c:
        for reason in ("  ", "\t\n ", ""):
            for dry in (True, False):
                r = await c.post(f"/v1/admin/cycles/{C[12]}/close", json={"reason": reason, "dry_run": dry})
                assert r.status_code == 422, (reason, dry, r.text)
    assert await _changes(owner, C[12]) == 0


@needs_db
async def test_list_pagination_and_invalid(client_as):
    async with client_as(ADMIN) as c:
        r1 = (await c.get("/v1/admin/cycles", params={"surface": "global", "limit": 2})).json()
        cur = r1["meta"]["page"]["next_cursor"]
        r2 = (await c.get("/v1/admin/cycles", params={"surface": "global", "limit": 2, "cursor": cur})).json()
        assert [i["cycle_id"] for i in r1["data"]["items"] + r2["data"]["items"]] == [C[12], C[11], C[10]]
        assert r2["meta"]["page"]["next_cursor"] is None
        r = await c.get("/v1/admin/cycles", params={"surface": "website", "limit": 2, "cursor": cur})
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
        for bad in ({}, {"surface": "x"}, {"surface": "global", "from": "2025-03-01"}, {"surface": "global", "limit": 501}):
            assert (await c.get("/v1/admin/cycles", params=bad)).status_code == 422, bad


@needs_db
async def test_detail_progress(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(f"/v1/admin/cycles/{C[11]}")
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["counters"] == {"expected_units": 10, "completed_units": 9, "completed_answers": 12, "gap_answers": 3}
        assert d["jobs"] == {"total": 15, "completed": 14, "running": 1, "failed": 0, "other": 0, "dropped": 1, "served": 13}
        assert d["answers"] == {"total": 13, "gap": 8, "analyzed_mentions": 4, "analyzed_empty": 1, "pending": 7, "failed": 1}
        assert '"cyc_key"' not in r.text
        r2 = await c.get("/v1/admin/cycles/11")                        # 정수 키 호환
        assert r2.status_code == 200 and r2.json()["data"] == d
        # 인용 숨김 웹사이트 회차도 진행률은 센다(관리 진행률은 숨김 무관)
        d = (await c.get(f"/v1/admin/cycles/{C[21]}")).json()["data"]
        assert d["answers"]["total"] == 2 and d["jobs"]["served"] == 2 and d["hidden_scope"] == "citations"
        d = (await c.get(f"/v1/admin/cycles/{C[12]}")).json()["data"]          # 답변 없는 open 회차 = 빈 분포
        assert d["jobs"]["total"] == 0 and d["answers"]["total"] == 0 and d["counters"]["expected_units"] is None
        assert (await c.get(f"/v1/admin/cycles/{uuid.uuid4()}")).status_code == 404
        assert (await c.get("/v1/admin/cycles/abc")).status_code == 422


@needs_db
async def test_hide_flow(client_as, owner):
    async with client_as(ADMIN) as c:
        r = await c.post(f"/v1/admin/cycles/{C[10]}/hide", json={"reason": "operator", "dry_run": True})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["dry_run"] is True and d["change_id"] is None and d["propagation"] == "none"
        assert d["requested"]["hidden_scope"] == "all" and d["current"]["hidden_scope"] == "none"
        assert d["warnings"] == [hide_cycle_warnings(cycle_week="2026-09-07", remaining_visible_in_week=0, newer_visible=2,
                                                     reason="operator")[0]]
        assert "사유가 operator" in d["warnings"][0] and await _changes(owner, C[10]) == 0
        r = await c.post(f"/v1/admin/cycles/{C[10]}/hide", json={"reason": "collection_error", "hidden_scope": "citations", "dry_run": True})
        w = r.json()["data"]["warnings"]
        assert w[0].startswith("범위 = citations") and "더 최신 비숨김 회차가 2개" in w[1]
        r = await c.post(f"/v1/admin/cycles/{C[12]}/hide", json={"reason": "operator", "dry_run": True})
        assert "가장 최근 회차" in r.json()["data"]["warnings"][0]
        # 실제 요청 → 202 + judgment_change 1행
        r = await c.post(f"/v1/admin/cycles/{C[10]}/hide", json={"reason": "operator", "expected_generation": 1})
        assert r.status_code == 202, r.text
        cid = r.json()["data"]["change_id"]
        row = await owner.fetchrow("SELECT payload, requested_by, status FROM app.judgment_change WHERE change_id = $1", cid)
        pl = json.loads(row["payload"])
        assert (pl["op"], pl["cycle_id"], pl["hidden_scope"], pl["reason"]) == ("hide", C[10], "all", "operator")
        assert pl["old"]["hidden_scope"] == "none" and row["requested_by"] == ADMIN and row["status"] == "pending"
        # 목록에 대기 요청이 보인다
        items = (await c.get("/v1/admin/cycles", params={"surface": "global"})).json()["data"]["items"]
        pend = {i["cycle_id"]: i["pending"] for i in items}
        assert [(p["change_id"], p["op"]) for p in pend[C[10]]] == [(cid, "hide")] and pend[C[11]] == []
        # 같은 회차·같은 op 대기 요청 → 409, 새 행 없음(롤백)
        r = await c.post(f"/v1/admin/cycles/{C[10]}/hide", json={"reason": "collection_error", "hidden_scope": "citations"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_pending" and await _changes(owner, C[10]) == 1
        # 다른 op(노출일)는 숨김 대기 중에도 받는다. 기대 변경 이유: 예전 409 → core enqueue_change dedupe_key={"op": op}(ad-ops R6 dedupe_on_op)
        r = await c.put(f"/v1/admin/cycles/{C[10]}/view-date", json={"view_date": "2026-09-10"})
        assert r.status_code == 202, r.text
        assert await _changes(owner, C[10]) == 2
        r = await c.put(f"/v1/admin/cycles/{C[10]}/view-date", json={"view_date": "2026-09-11"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate_pending" and await _changes(owner, C[10]) == 2
        # 검증: 세대 불일치·mentions 범위(Q18)·잘못된 사유·남는 필드·이미 같은 상태
        r = await c.post(f"/v1/admin/cycles/{C[11]}/hide", json={"reason": "operator", "expected_generation": 5})
        assert r.status_code == 409 and r.json()["error"]["code"] == "generation_mismatch"
        for body in ({"reason": "operator", "hidden_scope": "mentions"}, {"reason": "nope"}, {}, {"reason": "operator", "x": 1}):
            assert (await c.post(f"/v1/admin/cycles/{C[11]}/hide", json=body)).status_code == 422, body
        r = await c.post(f"/v1/admin/cycles/{C[21]}/hide", json={"reason": "operator", "hidden_scope": "citations"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "state_mismatch"
        assert await _changes(owner, C[11]) == 0 and await _changes(owner, C[21]) == 0


@needs_db
async def test_unhide_close_view_date(client_as, owner):
    async with client_as(ADMIN) as c:
        r = await c.post(f"/v1/admin/cycles/{C[11]}/unhide", json={})
        assert r.status_code == 409 and r.json()["error"]["code"] == "state_mismatch"
        r = await c.post(f"/v1/admin/cycles/{C[21]}/unhide", json={})
        assert r.status_code == 202 and r.json()["data"]["requested"]["hidden_scope"] == "none"
        assert json.loads(await owner.fetchval("SELECT payload FROM app.judgment_change WHERE change_id = $1",
                                               r.json()["data"]["change_id"]))["op"] == "unhide"
        # 마감: 가상 회차·이미 발행된 회차는 409, open 원장 회차는 요청
        r = await c.post(f"/v1/admin/cycles/{C[31]}/close", json={"reason": "x"})
        assert r.status_code == 409 and "가상" in r.json()["error"]["message"]
        assert (await c.post(f"/v1/admin/cycles/{C[11]}/close", json={"reason": "x"})).status_code == 409
        assert (await c.post(f"/v1/admin/cycles/{C[12]}/close", json={"reason": ""})).status_code == 422
        r = await c.post(f"/v1/admin/cycles/{C[12]}/close", json={"reason": " 수집 종료 ", "dry_run": True})
        assert r.status_code == 200 and r.json()["data"]["requested"]["status"] == "closed" and r.json()["data"]["warnings"] == []
        # 노출일(회차 12): round_date 이전 422, 정상 202 + 경고(비서빙·즉시 노출)
        r = await c.put(f"/v1/admin/cycles/{C[12]}/view-date", json={"view_date": "2026-09-20"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "view_date_before_round"
        r = await c.put(f"/v1/admin/cycles/{C[12]}/view-date", json={"view_date": "2026-09-23"})
        assert r.status_code == 202, r.text
        w = r.json()["data"]["warnings"]
        assert any("servable 거짓" in x for x in w) and any("즉시" in x for x in w)
        pl = json.loads(await owner.fetchval("SELECT payload FROM app.judgment_change WHERE change_id = $1", r.json()["data"]["change_id"]))
        assert (pl["op"], pl["view_date"], pl["expected_generation"]) == ("set_view_date", "2026-09-23", 1)
        r = await c.put(f"/v1/admin/cycles/{C[11]}/view-date", json={"view_date": "2026-09-16"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "state_mismatch"
        assert (await c.put(f"/v1/admin/cycles/{C[12]}/view-date", json={"view_date": "bad"})).status_code == 422
        assert (await c.put(f"/v1/admin/cycles/{uuid.uuid4()}/view-date", json={"view_date": "2026-09-23"})).status_code == 404


def test_hide_cycle_warnings_port():
    """hide-cycle-warning.test.ts 분기 이식: 같은 주 잔여 → 최신 경계 → collection_error 갭 → operator."""
    w = hide_cycle_warnings(cycle_week="2026-09-07", remaining_visible_in_week=1, newer_visible=3, reason="collection_error")
    assert len(w) == 1 and "숨기지 않은 회차가 1개 남아 있다" in w[0] and "갭 슬롯은 안 생기고" in w[0]
    w = hide_cycle_warnings(cycle_week="2026-09-07", remaining_visible_in_week=0, newer_visible=0, reason="collection_error")
    assert "가장 최근 회차" in w[0] and "측정 기준일" in w[0]
    w = hide_cycle_warnings(cycle_week="2026-09-07", remaining_visible_in_week=0, newer_visible=2, reason="collection_error")
    assert "갭 슬롯이 생겨 주 축은 유지" in w[0]
    w = hide_cycle_warnings(cycle_week="2026-09-07", remaining_visible_in_week=0, newer_visible=2, reason="operator", scope="citations")
    assert len(w) == 2 and w[0].startswith("범위 = citations") and "사유가 operator" in w[1]


def test_close_warnings():
    assert close_warnings(10, 7, 2) == ["완료 유닛 7/10: 마감하면 미완료 3유닛은 이 회차의 결손으로 남는다.",
                                        "분석 결손 답변 2건이 남아 있다(언급 계열 모수에서 빠진다)."]
    assert close_warnings(None, None, None) == [] and close_warnings(10, 10, 0) == []
