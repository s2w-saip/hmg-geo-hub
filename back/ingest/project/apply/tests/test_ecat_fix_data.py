"""엔티티 버전 반영 독립 검증(고정 7cfdeed1) 반려 결함의 데이터·엔진 회귀 시험. 전부 롤백 트랜잭션(복제본 불변).

D1  영향 집합이 모 브랜드 참조(parent_brand_id, 병합 대상의 관계 2단)와 재매칭 행 롤업(Scope 롤업)을 따라간다(반례 CE5 + 재매칭 변형):
    증분(영향 집합만 재투영) = 전량 bulk 시드(행 단위).
D5  되돌리기 = 그 버전을 반영한 applied 반영 전부(원 반영 + 범위 확장)가 바꾼 회차를 반영 전 상태로(반례 CE11): 노출 회차 사실 행·고정 원복,
    대상 반영 전부 rolled_back. 반영 전 고정이 되돌리기 내용과 다른 버전이면 그 버전으로 다시 고정·투영(미리보기 = 반영 뒤 rd).
G3  포기(op abandon): failed 반영의 대기 표시 정리 + 범위 회차 반영 전 버전 고정·투영 → rejected. 이후 범위 확장으로 복구 가능.
G2  스캔 미완결 add 표면 → 미리보기 ECAT_SCAN_PENDING(큐 실패), 반영 시작 → previewed + ECAT_SCAN_PENDING.
G1  미리보기 hidden = 숨김 전환 목록 + 전 기간 즉시 적용 표시.
"""
from __future__ import annotations

import asyncpg

from ingest.project.apply import ecat_engine as ee
from ingest.project.apply.ecat import impact
from ingest.project.apply.service import apply
from ingest.project.apply.tests.test_ecat_apply import (  # noqa: F401 (_engine_env = 자동 픽스처: 기준일 고정·재스캔 준비 끔)
    ACTOR,
    EXPOSED,
    FACTS,
    PRODUCT_OWNER,
    _apply_row,
    _approve,
    _assert_preview_equals,
    _bulk_equal,
    _engine_env,
    _exposed_md5,
    _kpi_all,
    _md5,
    _op,
    _preview_json,
    _request,
    _setup,
    unexposed_work,
)
from ingest.project.apply.tests.test_ecat_overlay import (
    CRETA,
    FORTWO,
    HASH,
    J2,
    JD,
    TATA,
    TOYOTA,
    _all_keys,
    _apply_version,
    _as_loader,
    _brands,
    _key,
    _stage_v1,
)
from ingest.testkit import EQ_TABLES, bulk_seed, diff, referenced_extras, snapshot, strict_diff
from tests.support import DB_URL, needs_db

pytestmark = needs_db


# ── D1 ──────────────────────────────────────────────────────────────────────
async def _new_ver(c: asyncpg.Connection, base: int, *, origin: str = "admin") -> int:
    """base 내용을 복사한 새 초안(엔티티·표면)."""
    v = await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, origin, created_by) VALUES ($1, 'fix', 'fix', $2, $3) "
                         "RETURNING ver", base, origin, ACTOR)
    await c.execute("""INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id,
                                                    note, updated_by, updated_at)
                       SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by, updated_at
                         FROM app.ecat_entity WHERE ver = $2""", v, base)
    await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT $1, surface_id, action FROM app.ecat_surface WHERE ver = $2", v, base)
    return int(v)


async def _step(c: asyncpg.Connection, ctx, a: int, b: int):
    """E1 반영 흐름(활성화 → 영향 집합만 재투영 → 전 회차 표시)."""
    await c.execute("SELECT app.ecat_activate($1)", b)
    imp = await _as_loader(c, lambda: impact(c, a, b))
    cyc = [r[0] for r in await c.fetch("SELECT cyc_key FROM rd.cycle")]
    await _as_loader(c, lambda: _apply_version(c, ctx, imp, cyc))
    return imp


async def _bulk_diff(c: asyncpg.Connection):
    got = await snapshot(c, EQ_TABLES)
    sp = c.transaction()
    await sp.start()
    await bulk_seed(c)
    ref = await snapshot(c, EQ_TABLES)
    await sp.rollback()
    d = diff(ref, got)
    return d, await referenced_extras(c, d)


async def _v1(c: asyncpg.Connection):
    ctx = await _stage_v1(c)
    keys = await _all_keys(c)
    await c.execute("SELECT app.ecat_cutover_v1($1, 'fix')", ACTOR)
    await _as_loader(c, lambda: apply(c, ctx, keys))
    return ctx


async def test_d1_parent_override_target_removed_follows_parent_reference():
    """반례 CE5: v2 Smart Fortwo 모 브랜드 = Toyota(관계 덮어쓰기) → v3 Toyota 제거. D = {Toyota} 만으로는 Fortwo 언급(J2)이 빠진다."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        ctx = await _v1(c)
        v2 = await _new_ver(c, 1)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, parent_brand_id, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Smart Fortwo', 'Product', 'competitor', $3, $4)", v2, FORTWO, TOYOTA, ACTOR)
        await _step(c, ctx, 1, v2)
        d2, r2 = await _bulk_diff(c)
        b2 = await _brands(c, J2)
        v3 = await _new_ver(c, v2)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Toyota', 'Brand', 'removed', $3) "
                        "ON CONFLICT (ver, entity_id) DO UPDATE SET role = 'removed'", v3, TOYOTA, ACTOR)
        imp = await _step(c, ctx, v2, v3)
        k2 = await _key(c, J2)
        b3 = await _brands(c, J2)
        d3, r3 = await _bulk_diff(c)
        await tr.rollback()
    finally:
        await c.close()
    assert not strict_diff(d2) and not r2, "v2 자체가 bulk 와 다르다(전제)"
    assert ("toyota", True) in b2 and ("toyota", True) not in b3, (b2, b3)
    assert FORTWO in imp.entities and k2 in imp.answer_keys, "모 브랜드 참조(Fortwo → Toyota)를 영향 집합이 따라가지 않았다"
    assert not strict_diff(d3) and not r3, d3


async def test_d1_merge_target_parent_two_level():
    """2단: v2 Smart Fortwo → Smart 병합, Smart 의 모 브랜드 = Toyota. v3 Toyota 제거 → Fortwo(병합 원본)도 영향 집합."""
    from ingest.project.apply.tests.test_ecat_overlay import SMART
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        ctx = await _v1(c)
        v2 = await _new_ver(c, 1)
        await c.execute("UPDATE app.ecat_entity SET parent_brand_id = $3 WHERE ver = $1 AND entity_id = $2", v2, SMART, TOYOTA)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, merge_into, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Smart Fortwo', 'Product', 'competitor', $3, $4)", v2, FORTWO, SMART, ACTOR)
        await _step(c, ctx, 1, v2)
        d2, r2 = await _bulk_diff(c)
        v3 = await _new_ver(c, v2)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Toyota', 'Brand', 'removed', $3) "
                        "ON CONFLICT (ver, entity_id) DO UPDATE SET role = 'removed'", v3, TOYOTA, ACTOR)
        imp = await _step(c, ctx, v2, v3)
        d3, r3 = await _bulk_diff(c)
        await tr.rollback()
    finally:
        await c.close()
    assert not strict_diff(d2) and not r2, "v2 자체가 bulk 와 다르다(전제)"
    assert {SMART, FORTWO} <= set(imp.entities), imp.entities
    assert not strict_diff(d3) and not r3, d3


async def test_d1_hub_add_surface_scope_rollup_removed():
    """재매칭 변형: v2 Creta(Scope 롤업 = Tata) 에 add 표면 → JD(Scope 언급 없음)에 재매칭 언급. v3 Tata 제거 → 재매칭 언급의 롤업이
    사라진다. Tata 를 가리키는 Scope 언급이 없는 JD 는 엔티티 경로로 잡히지 않으므로 add 표면(엔티티의 Scope 롤업 ∈ D)으로 잡아야 한다."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        ctx = await _v1(c)
        v2 = await _new_ver(c, 1)
        sid = await c.fetchval("INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, created_by) VALUES ($1, 'review', 'review', $2) "
                               "RETURNING surface_id", CRETA, ACTOR)
        await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) VALUES ($1, $2, 'add')", v2, sid)
        await c.execute("SELECT rd.ensure_hub_match_leaf('2026-09-01')")
        await c.execute("INSERT INTO ing.hub_match (surface_id, run_month, job_id, turn_index, entity_id, n_occ, first_start, starts, ends, "
                        "answer_hash, load_id) VALUES ($1, '2026-09-01', $2, 1, $3, 1, 11, '{11}', '{17}', $4, $5)",
                        sid, JD, CRETA, HASH[JD], ctx.load_id)
        await _step(c, ctx, 1, v2)
        d2, r2 = await _bulk_diff(c)
        jd2 = await _brands(c, JD)
        v3 = await _new_ver(c, v2)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Tata', 'Brand', 'removed', $3) "
                        "ON CONFLICT (ver, entity_id) DO UPDATE SET role = 'removed'", v3, TATA, ACTOR)
        imp = await _step(c, ctx, v2, v3)
        kd = await _key(c, JD)
        jd3 = await _brands(c, JD)
        d3, r3 = await _bulk_diff(c)
        await tr.rollback()
    finally:
        await c.close()
    assert not strict_diff(d2) and not r2, "v2 자체가 bulk 와 다르다(전제)"
    assert jd2 and jd2 != jd3, (jd2, jd3)                   # 재매칭 언급의 브랜드 귀속이 v3 에서 바뀐다(반례 전제)
    assert sid in imp.add_surfaces and kd in imp.answer_keys, "재매칭 행 롤업(Scope 롤업 Tata 제거)을 영향 집합이 따라가지 않았다"
    assert not strict_diff(d3) and not r3, d3


# ── D5 ──────────────────────────────────────────────────────────────────────
async def _rollback_request(c: asyncpg.Connection, content_ver: int, scope: str) -> tuple[int, int]:
    """E6 rollback 흉내: content_ver 내용의 rollback 초안 + 요청(from_ver = 지금 활성)."""
    rv = await _new_ver(c, content_ver, origin="rollback")
    return rv, await _request(c, rv, scope)


async def test_d5_rollback_restores_range_extension():
    """반례 CE11: X1(v2 unexposed) → X2(v2 all, 범위 확장) → X1 되돌리기(unexposed 요청). 노출 회차 10 까지 반영 전으로, X1·X2 rolled_back."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        exp0 = await _exposed_md5(c)
        facts0 = await _md5(c, FACTS, drop=("load_id", "ecat_ver"))
        x1 = await _request(c, v2, "unexposed")
        await _op(c, x1, "preview")
        await _approve(c, x1, ACTOR)
        assert (await _op(c, x1, "apply"))[-1].status == "applied"
        pins_x1 = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        x2 = await _request(c, v2, "all")
        await _op(c, x2, "preview")
        await _approve(c, x2, PRODUCT_OWNER)
        assert (await _op(c, x2, "apply"))[-1].status == "applied"
        assert await _exposed_md5(c) != exp0                                                   # 범위 확장이 노출 회차를 바꿨다(전제)
        pv2 = await _preview_json(c, x2)
        rv, r = await _rollback_request(c, 1, "unexposed")
        assert (await _op(c, r, "preview"))[-1].status == "applied"
        rpv = await _preview_json(c, r)
        kpi_b = await _kpi_all(c)
        await _approve(c, r, ACTOR)                                                            # 노출 회차 원복 = 승인자 필요
        out = await _op(c, r, "apply")
        rej = (await _apply_row(c, r))["status"], out[-1].error
        await _approve(c, r, PRODUCT_OWNER)
        assert (await _op(c, r, "apply"))[-1].status == "applied"
        st = {k: (await _apply_row(c, k))["status"] for k in (x1, x2, r)}
        pins = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        exp_final = await _exposed_md5(c)
        facts_final = await _md5(c, FACTS, drop=("load_id", "ecat_ver"))
        _assert_preview_equals(rpv, kpi_b, await _kpi_all(c))
        await _bulk_equal(c)
        await tr.rollback()
    finally:
        await c.close()
    assert pins_x1 == {10: 1, 11: None, 12: None, 21: None, 31: None}
    assert pv2["pins_before"]["10"] == {"pin": 1, "ver": 1}                                     # 범위 확장 시작 때 기록
    assert rpv["requires_approval"] is True and rpv["cycles"]["restore_pin"] == {"10": 1} and 10 in rpv["cycles"]["exposed_in_scope"]
    assert rej[0] == "previewed" and "ECAT_EXPOSED_REQUIRES_APPROVAL" in (rej[1] or "")
    assert st == {x1: "rolled_back", x2: "rolled_back", r: "applied"}, st
    assert pins == pins_x1, pins                                                               # 노출 회차 10 = v1 고정으로 원복
    assert exp_final == exp0, "노출 회차 사실 행(ecat_ver 포함)이 반영 전과 다르다"
    assert facts_final == facts0


async def test_d5_rollback_restores_older_pin_version():
    """반영 전 고정이 되돌리기 내용과 다른 버전: X0(v2 unexposed: 10 은 v1 고정) → X1(v3 = v2 + Toyota 제거, all) → X1 되돌리기(v2 내용, all).
    회차 10 은 v1 로 다시 고정·투영(되돌리기 내용 v2 가 아니다), 나머지는 v2 내용. 미리보기 KPI = 반영 뒤 rd(임시 고정 시뮬레이션)."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        x0 = await _request(c, v2, "unexposed")
        await _op(c, x0, "preview")
        await _approve(c, x0, ACTOR)
        assert (await _op(c, x0, "apply"))[-1].status == "applied"
        pins0 = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        facts0 = await _md5(c, FACTS, drop=("load_id", "ecat_ver"))
        v3 = await _new_ver(c, v2)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Toyota', 'Brand', 'removed', $3) "
                        "ON CONFLICT (ver, entity_id) DO UPDATE SET role = 'removed'", v3, TOYOTA, ACTOR)
        x1 = await _request(c, v3, "all")
        await _op(c, x1, "preview")
        await _approve(c, x1, PRODUCT_OWNER)
        assert (await _op(c, x1, "apply"))[-1].status == "applied"
        assert dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))[10] == v3
        rv, r = await _rollback_request(c, v2, "all")
        assert (await _op(c, r, "preview"))[-1].status == "applied"
        rpv = await _preview_json(c, r)
        kpi_b = await _kpi_all(c)
        await _approve(c, r, PRODUCT_OWNER)
        assert (await _op(c, r, "apply"))[-1].status == "applied"
        pins = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        facts = await _md5(c, FACTS, drop=("load_id", "ecat_ver"))
        vers10 = {r[0] for r in await c.fetch("SELECT DISTINCT ecat_ver FROM rd.answer WHERE cyc_key = 10")}
        st = {k: (await _apply_row(c, k))["status"] for k in (x0, x1, r)}
        _assert_preview_equals(rpv, kpi_b, await _kpi_all(c))
        await _bulk_equal(c)
        await tr.rollback()
    finally:
        await c.close()
    assert rpv["cycles"]["restore_pin"] == {"10": 1} and set(rpv["impact"]["restore_by_version"]) == {f"{v3}->1"}, rpv["cycles"]
    assert pins == pins0 and vers10 == {1}, (pins, vers10)
    assert facts == facts0, "되돌리기 뒤 사실 표가 X1 반영 전과 다르다"
    assert st == {x0: "applied", x1: "rolled_back", r: "applied"}, st


# ── G3 ──────────────────────────────────────────────────────────────────────
async def test_g3_abandon_failed_apply_restores_and_closes(monkeypatch):
    """청크 실패(failed, 대기 표시 = 비노출 작업 − 1: hub 2·현행 프로필 6) → op abandon(청크 1 로 여러 번) → rejected·대기 0·범위 회차 v1 고정·사실 행 반영 전.
    포기 시작 뒤 resume 거절. 이후 범위 확장(v2 all)으로 다시 펴면 bulk 와 같다."""
    monkeypatch.setenv("HGH_ECAT_CHUNK", "1")
    real = ee.project
    calls = {"n": 0}

    async def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("시험 주입: 두 번째 청크 실패")
        return await real(*a, **k)

    monkeypatch.setattr(ee, "project", flaky)
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        facts0 = await _md5(c, FACTS, drop=("load_id",))
        aid = await _request(c, v2, "unexposed")
        await _op(c, aid, "preview")
        await _approve(c, aid, ACTOR)
        assert [o.status for o in await _op(c, aid, "apply")] == ["progress", "failed"]
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE ecat_ver = $1", -v2) == unexposed_work() - 1   # 청크 1개 처리(프로필별)
        # 포기 첫 처리만(한 청크) 돌리고 멈춘 상태에서 resume 은 거절된다
        cid = await c.fetchval("INSERT INTO app.judgment_change (kind, payload, requested_by) VALUES ('entity_version', $1::jsonb, $2) "
                               "RETURNING change_id", f'{{"apply_id": {aid}, "op": "abandon"}}', ACTOR)
        from ingest.project.apply.tests.test_ecat_apply import _run
        first = await _run(c, cid, limit=1)
        mid = await _apply_row(c, aid)
        res = await _op(c, aid, "resume")
        outs = await _run(c, cid)
        ap = await _apply_row(c, aid)
        pins = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        neg = await c.fetchval("SELECT count(*) FROM rd.answer WHERE ecat_ver < 0")
        facts1 = await _md5(c, FACTS, drop=("load_id",))
        active = await c.fetchval("SELECT ver FROM app.ecat_version WHERE status = 'active'")
        await _bulk_equal(c)
        # 복구: 범위 확장(활성 v2 all) → 전 회차 v2
        ext = await _request(c, v2, "all")
        assert (await _op(c, ext, "preview"))[-1].status == "applied"
        await _approve(c, ext, PRODUCT_OWNER)
        assert (await _op(c, ext, "apply"))[-1].status == "applied"
        vers = {r[0] for r in await c.fetch("SELECT DISTINCT ecat_ver FROM rd.answer")}
        await _bulk_equal(c)
        await tr.rollback()
    finally:
        await c.close()
    assert first[-1].status == "progress" and mid["status"] == "failed" and "ECAT_APPLY_ABANDONING" in mid["error"]
    assert res[-1].status == "failed" and "ECAT_APPLY_STATE" in res[-1].error, res
    assert outs[-1].status == "applied", outs
    assert ap["status"] == "rejected" and ap["error"].startswith("ECAT_APPLY_ABANDONED"), (ap["status"], ap["error"])
    assert neg == 0 and active == v2
    assert pins == {10: 1, 11: 1, 12: 1, 21: 1, 31: 1}, pins
    assert facts1 == facts0, "포기 뒤 사실 표(ecat_ver 포함)가 반영 전과 다르다"
    assert vers == {v2}


# ── G2 ──────────────────────────────────────────────────────────────────────
async def test_g2_scan_pending_blocks_preview_and_apply():
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        sid = await c.fetchval("SELECT min(surface_id) FROM app.ecat_surface WHERE ver = $1 AND action = 'add'", v2)
        aid = await _request(c, v2, "unexposed")
        await c.execute("UPDATE ing.hub_match_scan SET scanned_to_load_id = NULL WHERE surface_id = $1", sid)     # 전체 스캔 미완(재개 중)
        pv_out = await _op(c, aid, "preview")
        st_pv = (await _apply_row(c, aid))["status"]
        await c.execute("UPDATE ing.hub_match_scan SET scanned_to_load_id = 1 WHERE surface_id = $1", sid)
        assert (await _op(c, aid, "preview"))[-1].status == "applied"
        await _approve(c, aid, ACTOR)
        await c.execute("DELETE FROM ing.hub_match_scan WHERE surface_id = $1", sid)                           # 진행 원장 없음
        ap_out = await _op(c, aid, "apply")
        ap = await _apply_row(c, aid)
        pins = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        await tr.rollback()
    finally:
        await c.close()
    assert pv_out[-1].status == "failed" and "ECAT_SCAN_PENDING" in pv_out[-1].error and st_pv == "draft", pv_out
    assert ap_out[-1].status == "failed" and "ECAT_SCAN_PENDING" in ap_out[-1].error, ap_out
    assert ap["status"] == "previewed" and ap["error"].startswith("ECAT_SCAN_PENDING") and str(sid) in ap["error"]
    assert all(v is None for v in pins.values()), "스캔 미완결인데 반영이 시작됐다"


# ── G1 ──────────────────────────────────────────────────────────────────────
async def test_g1_preview_lists_hidden_changes():
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Toyota', 'Brand', 'hidden', $3)", v2, TOYOTA, ACTOR)
        aid = await _request(c, v2, "unexposed")
        assert (await _op(c, aid, "preview"))[-1].status == "applied"
        pv = await _preview_json(c, aid)
        await tr.rollback()
    finally:
        await c.close()
    h = pv["hidden"]
    assert h["all_periods"] is True and h["note"] and h["truncated"] is False
    assert {"entity_id": str(TOYOTA), "name": "Toyota", "from_role": "competitor", "to_role": "hidden"} in h["changes"], h
    assert h["count"] == len(h["changes"]) and pv["cycles"]["exposed_in_scope"] == [] and EXPOSED == [10]
