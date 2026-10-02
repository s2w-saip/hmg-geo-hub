"""포기(op abandon) 경로의 재스캔·스캔 완결(3차 수정). 전부 롤백 트랜잭션(복제본 불변).

시나리오: v2(Polestar 등 add 표면) unexposed 반영(노출 회차 10 은 v1 고정) → v3(= v2 − Polestar + 편집 2) unexposed 반영이 두 번째 청크에서
실패(failed). 실패가 열린 동안 미노출 회차 11 의 J3 본문이 Polestar 를 담아 재적재된다: 활성 v3·초안·회차 고정(v1) 어디에도 Polestar 가
없어 적재 훅이 스캔하지 않는다. 포기는 미노출 회차를 반영 전 버전 v2 로 되돌려 투영하므로 그대로 진행하면 J3 의 v2 재매칭 언급이 빠진다.
  1. prepare(포기)의 재스캔 대상에 반영 전 버전 v2 의 Polestar 가 든다(시작된 포기는 빈 목록).
  2. 재스캔 전 포기 = ECAT_SCAN_PENDING(반영 failed 그대로, 회차 고정·대기 표시 불변).
  3. 따라잡기 스캔(ensure_scanned 와 같은 행) 뒤 포기 = rejected, J3 에 ('polestar', True), bulk 시드와 같다.
"""
from __future__ import annotations

import asyncpg

from ingest.ecat import queries as eq
from ingest.ecat.scan import _copy, compile_rows, scan_records
from ingest.project.apply import ecat_engine as ee
from ingest.project.apply.tests.test_ecat_apply import (  # noqa: F401 (_engine_env = 자동 픽스처: 기준일 고정·재스캔 준비 끔)
    ACTOR,
    _apply_row,
    _approve,
    _bulk_equal,
    _engine_env,
    _op,
    _request,
    _setup,
)
from ingest.project.apply.tests.test_ecat_overlay import J3, _brands, _ctx
from ingest.project.apply.tests.test_ecat_pinned_scan import _reload, _v3_without_polestar, _valid_hits
from tests.support import DB_URL, needs_db

pytestmark = needs_db


async def _catchup(c: asyncpg.Connection, sid: int) -> None:
    """ensure_scanned(따라잡기)와 같은 행: 표면 sid 를 지금 본문 전체로 다시 쓰고 진행 원장을 지금 최대 load 로."""
    ctx = await _ctx(c)
    compiled = compile_rows(await c.fetch(eq.SURFACES_BY_ID, [sid]))
    keys = [(r[0], r[1]) for r in await c.fetch("SELECT run_month, job_id FROM ing.answer")]
    recs, _ = scan_records(await c.fetch(eq.BODIES_OF_KEYS, [k[0] for k in keys], [k[1] for k in keys]), compiled, ctx.load_id)
    await c.execute(eq.DELETE_KEYS, [sid], [k[0] for k in keys], [k[1] for k in keys])
    await _copy(c, recs)
    await c.execute("UPDATE ing.hub_match_scan SET scanned_to_load_id = (SELECT max(load_id) FROM ing.load) WHERE surface_id = $1", sid)


async def test_abandon_rescans_prior_version_surfaces(monkeypatch):
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
        a2 = await _request(c, v2, "unexposed")
        await _op(c, a2, "preview")
        await _approve(c, a2, ACTOR)
        assert (await _op(c, a2, "apply"))[-1].status == "applied"
        v3, ps = await _v3_without_polestar(c, v2, extra_edits=True)
        a3 = await _request(c, v3, "unexposed")
        await _op(c, a3, "preview")
        await _approve(c, a3, ACTOR)
        monkeypatch.setattr(ee, "project", flaky)
        assert [o.status for o in await _op(c, a3, "apply")] == ["progress", "failed"]
        monkeypatch.setattr(ee, "project", real)
        live_before = {int(r["surface_id"]) for r in await c.fetch(eq.SURFACES_LIVE)}
        n_hook = await _reload(c, J3, "'Polestar 2 and more.'", b"\xcc")                  # 실패가 열린 동안 재적재(훅이 Polestar 를 모른다)
        await c.execute("UPDATE ing.answer SET load_id = (SELECT max(load_id) FROM ing.load) WHERE job_id = $1", J3)   # 적재기는 쓴 load 를 남긴다
        sids = await ee.prepare_surface_ids(c, a3, "abandon")
        pins0 = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        neg0 = await c.fetchval("SELECT count(*) FROM rd.answer WHERE ecat_ver < 0")
        blocked = await _op(c, a3, "abandon")
        st_blocked = await _apply_row(c, a3)
        pins1 = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        neg1 = await c.fetchval("SELECT count(*) FROM rd.answer WHERE ecat_ver < 0")
        await _catchup(c, ps)
        done = await _op(c, a3, "abandon")
        st = (await _apply_row(c, a3))["status"]
        sids_after = await ee.prepare_surface_ids(c, a3, "abandon")
        j3 = await _brands(c, J3)
        hits = await _valid_hits(c, ps, J3)
        pins2 = dict(await c.fetch("SELECT cyc_key, ecat_ver FROM rd.cycle"))
        await _bulk_equal(c)
        await tr.rollback()
    finally:
        await c.close()
    assert ps not in live_before and n_hook == 0, (live_before, n_hook)                       # 전제: 적재 훅이 Polestar 를 스캔하지 않았다
    assert ps in sids and sids_after == [], (sids, sids_after)                               # 1
    assert blocked[-1].status == "failed" and "ECAT_SCAN_PENDING" in blocked[-1].error and str(ps) in blocked[-1].error, blocked
    assert st_blocked["status"] == "failed" and "abandon" not in (st_blocked["preview"] or "")    # 2: 포기 시작 안 함
    assert pins1 == pins0 and neg1 == neg0
    assert done[-1].status == "applied" and st == "rejected", (done, st)                     # 3
    assert pins2[11] == v2 and hits == 1 and ("polestar", True) in j3, (pins2, hits, j3)
