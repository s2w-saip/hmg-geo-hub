"""회차 고정 버전의 add 표면 재스캔(검증 반례 CE15 회귀). 전부 롤백 트랜잭션(복제본 불변).

1. v2(Polestar add 표면)를 all 로 반영(회차 10 = v2 고정) → v3(Polestar 표면 제거)를 unexposed 로 반영 → 회차 10 의 JA 본문 재적재.
   적재 훅(on_load)이 고정 버전 v2 의 표면도 스캔해 JA 의 ('polestar', True) 행·유효 hub_match 가 남고, 전량 bulk 재구축 = 증분.
   기본 CLI·따라잡기 대상(surfaces_for 기본값)도 고정 버전 표면을 포함한다.
2. 포기 경로: v2 all 반영 → v3(Polestar 제거 + 편집 2) unexposed 반영이 두 번째 청크에서 실패 → 포기(미노출 회차가 반영 전 버전 v2 에
   고정) → 그 회차 답변(J3) 본문이 Polestar 를 담아 재적재 → v2 규칙의 재매칭 언급이 생기고 bulk = 증분.
"""
from __future__ import annotations

import asyncpg
import pytest

from ingest.ecat.scan import on_load, surfaces_for
from ingest.project.apply import ecat_engine as ee
from ingest.project.apply.service import project
from ingest.project.apply.tests.test_ecat_apply import (  # noqa: F401 (_engine_env = 자동 픽스처: 기준일 고정·재스캔 준비 끔)
    ACTOR,
    PRODUCT_OWNER,
    _apply_row,
    _approve,
    _bulk_equal,
    _engine_env,
    _op,
    _request,
    _setup,
)
from ingest.project.apply.tests.test_ecat_overlay import FORTWO, J3, JA, TOYOTA, _as_loader, _brands, _ctx, _key
from tests.support import DB_URL, keep_name_projection, needs_db

pytestmark = needs_db


async def _v3_without_polestar(c: asyncpg.Connection, v2: int, *, extra_edits: bool = False) -> tuple[int, int]:
    v3 = await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, created_by) VALUES ($1, 'v3', 'fix2', $2) RETURNING ver",
                          v2, ACTOR)
    await c.execute("""INSERT INTO app.ecat_entity SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id,
                                                         note, updated_by, updated_at FROM app.ecat_entity WHERE ver = $2""", v3, v2)
    ps = await c.fetchval("SELECT surface_id FROM app.ecat_surface_def WHERE surface = 'Polestar'")
    await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT $1, surface_id, action FROM app.ecat_surface "
                    "WHERE ver = $2 AND surface_id <> $3", v3, v2, ps)
    if extra_edits:                                             # 미노출 회차(11) 작업 답변 2개 이상(J1 Toyota, J2 Fortwo 관계)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Toyota', 'Brand', 'removed', $3) ON CONFLICT (ver, entity_id) DO UPDATE SET role = 'removed'",
                        v3, TOYOTA, ACTOR)
        await c.execute("UPDATE app.ecat_entity SET parent_brand_id = NULL WHERE ver = $1 AND entity_id = $2", v3, FORTWO)
    return int(v3), int(ps)


async def _reload(c: asyncpg.Connection, job, text_sql: str, new_hash: bytes) -> int:
    """본문·해시가 바뀐 재적재(적재 훅 + 그 답변 재투영, pull 서비스 load_run 과 같은 순서). 반환 = 훅이 쓴 hub_match 행 수."""
    await c.execute(f"UPDATE ing.answer SET answer_text = {text_sql}, content_hash = $2 WHERE job_id = $1", job, new_hash)
    ctx = await _ctx(c)

    async def hook():
        await c.execute("CREATE TEMP TABLE _pl_changed ON COMMIT DROP AS SELECT run_month, job_id FROM ing.answer WHERE job_id = $1", job)
        return await on_load(c, ctx)
    n = await _as_loader(c, hook)
    k = await _key(c, job)
    await _as_loader(c, lambda: project(c, ctx, [], extra_keys=[k], detect_global=False))
    return int(n)


async def _valid_hits(c: asyncpg.Connection, sid: int, job) -> int:
    return int(await c.fetchval("SELECT count(*) FROM ing.hub_match h JOIN ing.answer a ON a.run_month = h.run_month AND a.job_id = h.job_id "
                                "WHERE h.surface_id = $1 AND h.job_id = $2 AND h.answer_hash = a.content_hash", sid, job))


# 전제(회차 10 이 보관된 v2 에 고정되고 JA 가 그 회차 답변)는 hub 귀속에서만 성립한다: 현행 프로필 resub_phantom_exclude 는 JA(run RX)를
# 비노출 회차 12 로 귀속해 v3 가 그대로 덮는다(rx_cycle). 그래서 이 시험은 프로필을 끔으로 고정한다(_setup 이 전 답변을 그 프로필로 다시 투영).
# 단 NAME(표시 브랜드 키 투영)은 복제본 투영 그대로 둔다: _setup 은 답변만 다시 투영하고 차원 키는 복제본 것이라 섞이면 bulk 대조가 키로 갈린다.
@pytest.mark.legacy_profile(keep_name_projection("off"))
async def test_pinned_retired_version_reload_keeps_rematch():
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        a2 = await _request(c, v2, "all")
        await _op(c, a2, "preview")
        await _approve(c, a2, PRODUCT_OWNER)
        assert (await _op(c, a2, "apply"))[-1].status == "applied"
        v3, ps = await _v3_without_polestar(c, v2)
        a3 = await _request(c, v3, "unexposed")
        await _op(c, a3, "preview")
        await _approve(c, a3, ACTOR)
        assert (await _op(c, a3, "apply"))[-1].status == "applied"
        pins = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        vstatus = await c.fetchval("SELECT status FROM app.ecat_version WHERE ver = $1", v2)
        live = {int(r["surface_id"]) for r in await surfaces_for(c)}
        n = await _reload(c, JA, "answer_text || ' Also Polestar 3.'", b"\xbb")
        ja = await _brands(c, JA)
        hits = await _valid_hits(c, ps, JA)
        await _bulk_equal(c)
        await tr.rollback()
    finally:
        await c.close()
    assert pins[10] == v2 and vstatus != "active", (pins, vstatus)                     # 전제: 회차 10 은 보관된 v2 에 고정
    assert ps in live, "기본 스캔 대상(적재 훅·CLI·따라잡기)에 회차 고정 버전의 add 표면이 없다"
    assert hits == 1 and n >= 1, (hits, n)
    assert ("polestar", True) in ja, ja


async def test_abandon_then_reload_scans_prior_version_surfaces(monkeypatch):
    monkeypatch.setenv("HGH_ECAT_CHUNK", "1")
    real = ee.project
    calls = {"n": 0}

    async def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("시험 주입: 두 번째 청크 실패")
        return await real(*a, **k)

    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        v2, _ = await _setup(c)
        a2 = await _request(c, v2, "all")
        await _op(c, a2, "preview")
        await _approve(c, a2, PRODUCT_OWNER)
        assert (await _op(c, a2, "apply"))[-1].status == "applied"
        v3, ps = await _v3_without_polestar(c, v2, extra_edits=True)
        a3 = await _request(c, v3, "unexposed")
        await _op(c, a3, "preview")
        await _approve(c, a3, ACTOR)
        monkeypatch.setattr(ee, "project", flaky)
        assert [o.status for o in await _op(c, a3, "apply")] == ["progress", "failed"]
        monkeypatch.setattr(ee, "project", real)
        outs = await _op(c, a3, "abandon")
        st = (await _apply_row(c, a3))["status"]
        pins = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        active = await c.fetchval("SELECT ver FROM app.ecat_version WHERE status = 'active'")
        j3_before = await _brands(c, J3)
        n = await _reload(c, J3, "'Polestar 2 and more.'", b"\xcc")
        j3 = await _brands(c, J3)
        hits = await _valid_hits(c, ps, J3)
        await _bulk_equal(c)
        await tr.rollback()
    finally:
        await c.close()
    assert outs[-1].status == "applied" and st == "rejected", (outs, st)
    assert active == v3 and pins[11] == v2, (active, pins)                             # 전제: 포기 뒤 미노출 회차는 반영 전 v2 고정
    assert ("polestar", True) not in j3_before and hits == 1 and n >= 1, (j3_before, hits, n)
    assert ("polestar", True) in j3, j3
