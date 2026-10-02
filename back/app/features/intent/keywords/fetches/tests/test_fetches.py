"""intent.keywords.fetches 테스트: 신선 skip(200)·큐 기록(202, judgment_change 행 대조)·중복 대기·권한·상태 조회·롤백."""
from __future__ import annotations

import uuid

import pytest
import pytest_asyncio

from app.features.intent.keywords.research.tests import intent_fixtures as fx
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

pytestmark = needs_db
URL = "/v1/intent/fetches"
CREATED: list[int] = []


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def world(seeded):
    w = await fx.build_kw_world("fetches")
    pr = await fx.create_projects()
    yield w, pr
    await fx.drop_projects(pr)
    await fx.cleanup_drafts([w.serp_new, w.serp_old, w.serp_stale])
    await fx.delete_changes(CREATED)


async def _change(cid: int) -> dict | None:
    c = await fx.su()
    try:
        r = await c.fetchrow("SELECT kind, subject_texts, payload::text AS payload, requested_by, status FROM app.judgment_change "
                             "WHERE change_id = $1", cid)
        return dict(r) if r else None
    finally:
        await c.close()


async def _count_open() -> int:
    c = await fx.su()
    try:
        return await c.fetchval("SELECT count(*) FROM app.judgment_change WHERE kind = 'dfs_fetch' AND status IN ('pending','running')")
    finally:
        await c.close()


async def test_insight_fetch_queues_only_non_fresh(client_as, world):
    import json
    w, _ = world
    body = {"kind": "insight", "terms": [w.fresh, w.stale, f" {w.missing} ", w.half], "country": "us"}
    async with client_as(ADMIN) as c:
        r = await c.post(URL, json=body)
    assert r.status_code == 202, r.text
    d = r.json()["data"]
    CREATED.append(d["change_id"])
    assert d["status"] == "queued" and d["fresh_terms"] == [w.fresh]
    assert d["terms"] == [w.stale, w.missing, w.half]            # 검색량만 있는 half 도 수집 대상
    row = await _change(d["change_id"])
    assert row["kind"] == "dfs_fetch" and row["status"] == "pending" and row["requested_by"] == ADMIN
    assert row["subject_texts"] == sorted(fx.norm(t) for t in (w.stale, w.missing, w.half))
    pl = json.loads(row["payload"])
    assert pl == {"fetch": "insight", "country": "us", "location_code": 2840, "language_code": "en", "depth": 10,
                  "project_id": None, "terms": [w.stale, w.missing, w.half], "force": False}

    # 같은 요청 재전송 → 기존 change_id(202 pending), 행 늘지 않음
    n = await _count_open()
    async with client_as(ADMIN) as c:
        again = await c.post(URL, json=body)
        kr = await c.post(URL, json={**body, "country": "kr"})   # 같은 term 집합, 다른 국가 → 새 요청
    assert again.status_code == 202 and again.json()["data"] == {**d, "status": "pending"}
    assert kr.status_code == 202 and kr.json()["data"]["status"] == "queued" and kr.json()["data"]["change_id"] != d["change_id"]
    CREATED.append(kr.json()["data"]["change_id"])
    assert await _count_open() == n + 1


async def test_fresh_skip_and_force(client_as, world):
    w, _ = world
    n = await _count_open()
    async with client_as(ADMIN) as c:
        fresh = await c.post(URL, json={"kind": "insight", "terms": [w.fresh], "country": "us"})
        forced = await c.post(URL, json={"kind": "insight", "terms": [w.fresh], "country": "us", "force": True})
        related = await c.post(URL, json={"kind": "related", "terms": [w.fresh], "country": "us"})
        rel_forced = await c.post(URL, json={"kind": "related", "terms": [w.fresh], "country": "us", "force": True})
        rel_mixed = await c.post(URL, json={"kind": "related", "terms": [w.half, w.stale], "country": "us"})
        search_half = await c.post(URL, json={"kind": "search", "terms": [w.half], "country": "us"})
        search_fresh = await c.post(URL, json={"kind": "search", "terms": [w.fresh], "country": "us"})
    assert fresh.status_code == 200 and fresh.json()["data"] == {"status": "fresh", "change_id": None, "terms": [], "fresh_terms": [w.fresh]}
    assert forced.status_code == 202 and forced.json()["data"]["terms"] == [w.fresh]
    # intent R4: 연관어도 rd.kw_suggestion.observed_at 으로 "신선하면 skip"(예전: 관측 시각이 없어 항상 수집)
    assert related.status_code == 200 and related.json()["data"]["status"] == "fresh"
    assert rel_forced.status_code == 202 and rel_forced.json()["data"]["terms"] == [w.fresh]
    # half = 1시간 전 related 호출(신선), stale = 8일 전 호출(TTL 7일 밖) → stale 만 수집
    assert rel_mixed.status_code == 202 and rel_mixed.json()["data"]["terms"] == [w.stale]
    assert rel_mixed.json()["data"]["fresh_terms"] == [w.half]
    # search 는 seed 행을 포함한 호출만 신선도로 친다: half 는 seed 없는 related 호출뿐 → 수집, fresh 는 seed 포함 1시간 전 → skip
    assert search_half.status_code == 202 and search_fresh.status_code == 200
    ids = [x.json()["data"]["change_id"] for x in (forced, rel_forced, rel_mixed, search_half)]
    CREATED.extend(ids)
    assert len(set(ids)) == 4 and await _count_open() == n + 4


async def test_permissions_and_status(client_as, world):
    w, pr = world
    body = {"kind": "search", "terms": [fx.uniq("perm")], "country": "us"}
    async with client_as(HQ_HYUNDAI) as c:
        no_pid = await c.post(URL, json=body)                         # 배정 운영자는 프로젝트 없는 수집 불가
        own = await c.post(URL, json={**body, "project_id": str(pr.own)})   # 국가 생략 = 프로젝트 국가
        cust = await c.post(URL, json={**body, "project_id": str(CUST_PROJECT)})   # 비멤버 → 운영 불가
    assert no_pid.status_code == 403 and no_pid.json()["error"]["code"] == "operator_forbidden"
    assert own.status_code == 202 and cust.status_code == 403
    cid = own.json()["data"]["change_id"]
    CREATED.append(cid)
    async with client_as(VENDOR) as c:
        assert (await c.post(URL, json={**body, "project_id": str(CUST_PROJECT)})).status_code == 403
        assert (await c.get(f"{URL}/{cid}")).status_code == 404         # 요청자 아님·운영자 아님
    async with client_as(KIA_US) as c:
        assert (await c.post(URL, json=body)).status_code == 403
        assert (await c.get(f"{URL}/{cid}")).status_code == 404
    async with client_as(HQ_HYUNDAI) as c:
        st = await c.get(f"{URL}/{cid}")
    assert st.status_code == 200
    sd = st.json()["data"]
    assert (sd["status"], sd["kind"], sd["country"], sd["terms"], sd["project_id"]) == ("pending", "search", "us", body["terms"], str(pr.own))
    async with client_as(ADMIN) as c:
        assert (await c.get(f"{URL}/{cid}")).status_code == 200
        assert (await c.get(f"{URL}/999999999999")).status_code == 404
        assert (await c.get(f"{URL}/0")).status_code == 422
        assert (await c.post(URL, json={**body, "project_id": str(uuid.uuid4())})).status_code == 404


@pytest.mark.parametrize("body", [
    {"kind": "insight", "terms": [], "country": "us"},
    {"kind": "insight", "terms": [f"t{i}" for i in range(21)], "country": "us"},
    {"kind": "volume", "terms": ["x"], "country": "us"},
    {"kind": "insight", "terms": ["x"], "country": "zz"},
    {"kind": "insight", "terms": ["   "], "country": "us"},
    {"kind": "insight", "terms": ["x"]},
])
async def test_422_writes_nothing(client_as, world, body):
    n = await _count_open()
    async with client_as(ADMIN) as c:
        r = await c.post(URL, json=body)
    assert r.status_code == 422
    assert await _count_open() == n


# ── 검증 D1: 같은 term 에 다른 국가 대기 행이 있어도 같은 요청은 기존 change_id(행 중복 없음) ──
async def test_same_request_dedupes_despite_other_country_pending_d1(client_as, world):
    t = fx.uniq("d1 dedupe")
    base = {"kind": "insight", "terms": [t]}
    n = await _count_open()
    async with client_as(ADMIN) as c:
        us = await c.post(URL, json={**base, "country": "us"})
        krs = [await c.post(URL, json={**base, "country": "kr"}) for _ in range(3)]
        rel = await c.post(URL, json={"kind": "related", "terms": [t], "country": "kr"})     # 종류가 다르면 새 요청
        rel2 = await c.post(URL, json={"kind": "related", "terms": [t], "country": "kr"})
    ids = [us.json()["data"]["change_id"], *[r.json()["data"]["change_id"] for r in krs], rel.json()["data"]["change_id"]]
    CREATED.extend(ids)
    assert [r.json()["data"]["status"] for r in krs] == ["queued", "pending", "pending"]
    assert len({r.json()["data"]["change_id"] for r in krs}) == 1 and ids[0] != ids[1]
    assert rel.json()["data"]["status"] == "queued" and rel.json()["data"]["change_id"] not in ids[:4]
    assert rel2.json()["data"] == {**rel.json()["data"], "status": "pending"}
    c2 = await fx.su()
    try:
        rows = await c2.fetch("SELECT payload->>'fetch' AS f, payload->>'country' AS cc FROM app.judgment_change "
                              "WHERE kind = 'dfs_fetch' AND status = 'pending' AND subject_texts = $1::text[] ORDER BY change_id", [fx.norm(t)])
    finally:
        await c2.close()
    assert [(r["f"], r["cc"]) for r in rows] == [("insight", "us"), ("insight", "kr"), ("related", "kr")]
    assert await _count_open() == n + 3


# ── 검증 D4: 남의(요청자가 볼 수 없는) 대기 행 change_id 를 돌려주지 않는다 ──
async def test_pending_match_respects_visibility_d4(client_as, world):
    t = fx.uniq("d4 visibility")
    kia_kr = await fx.create_project("Kia", "KR")
    own_kr = await fx.create_project("Hyundai", "KR", member=(HQ_HYUNDAI, "owner"))
    try:
        body = {"kind": "related", "terms": [t]}
        async with client_as(ADMIN) as c:
            other = await c.post(URL, json={**body, "project_id": str(kia_kr)})
        async with client_as(HQ_HYUNDAI) as c:
            mine = await c.post(URL, json={**body, "project_id": str(own_kr)})
            again = await c.post(URL, json={**body, "project_id": str(own_kr)})
            st = await c.get(f"{URL}/{mine.json()['data']['change_id']}")
            hidden = await c.get(f"{URL}/{other.json()['data']['change_id']}")
        CREATED.extend([other.json()["data"]["change_id"], mine.json()["data"]["change_id"]])
        assert other.status_code == 202 and mine.status_code == 202
        assert mine.json()["data"]["status"] == "queued" and mine.json()["data"]["change_id"] != other.json()["data"]["change_id"]
        assert again.json()["data"] == {**mine.json()["data"], "status": "pending"}
        assert st.status_code == 200 and hidden.status_code == 404
        async with client_as(ADMIN) as c:          # admin 은 전부 보이므로 기존 행(가장 오래된 것)을 받는다
            adm = await c.post(URL, json={**body, "country": "kr"})
        assert adm.json()["data"]["status"] == "pending" and adm.json()["data"]["change_id"] == other.json()["data"]["change_id"]
    finally:
        await fx.delete_changes(CREATED)
        await fx.drop_project_ids([kia_kr, own_kr])


# ── 검증 D3·D5: 메뉴 게이트, project_id 경로 국가 묶기 ──
async def test_menu_gate_and_project_country_binding_d3_d5(client_as, world):
    _, pr = world
    t = fx.uniq("d3 menu")
    std = fx.temp_user("hq", "global", ("Hyundai",), ("standard",))
    prj = fx.temp_user("hq", "global", ("Hyundai",), ("project",))
    await fx.create_users([std, prj])
    try:
        body = {"kind": "search", "terms": [t], "country": "us"}
        async with client_as(prj.uid) as c:
            r = await c.post(URL, json=body)
            assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
        async with client_as(std.uid) as c:
            ok = await c.post(URL, json=body)
            r = await c.post(URL, json={**body, "project_id": str(pr.own)})
            assert ok.status_code == 202 and r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
        async with client_as(HQ_HYUNDAI) as c:     # 배정 운영자: 자기 프로젝트(US)로 kr 수집 = 프로젝트에 묶이지 않은 국가 → 403
            r = await c.post(URL, json={**body, "country": "kr", "project_id": str(pr.own)})
            assert r.status_code == 403 and r.json()["error"]["code"] == "operator_forbidden"
    finally:
        await fx.drop_users([std, prj])


async def test_concurrent_same_request_single_row_d1(client_as, world):
    import asyncio
    t = fx.uniq("d1 concurrent")
    body = {"kind": "search", "terms": [t], "country": "us"}
    async with client_as(ADMIN) as c:
        rs = await asyncio.gather(*[c.post(URL, json=body) for _ in range(5)])
    ids = {r.json()["data"]["change_id"] for r in rs}
    CREATED.extend(ids)
    assert all(r.status_code == 202 for r in rs) and len(ids) == 1
    assert sorted(r.json()["data"]["status"] for r in rs) == ["pending"] * 4 + ["queued"]
