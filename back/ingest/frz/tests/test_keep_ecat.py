"""보관 관문(DB-v2.21 P117, 설계 12.11) 엔티티 반영 경로: 반영(apply)·되돌리기(rollback = 옛 내용 새 버전 반영)·포기(abandon)가 동결 답변을
다시 써도(엔진 → service.project → _write_facts 관문) 동결 읽기 뷰는 동결 시점 값이고, 보관은 첫 변경 직전 값 한 벌만 남는다.
엔진은 큐 경로(process_change, loader 롤)로 돈다. 시험은 한 트랜잭션이라 되돌리기 관문의 정리(keep_settle apply = 이 트랜잭션에서
잡은 것)가 반영 때 잡은 보관도 값이 같으면 푼다(운영은 청크·요청마다 트랜잭션이 달라 반영 때 보관이 남는다. 어느 쪽이든 뷰 값은 같다).
시나리오·헬퍼는 E5 시험(test_ecat_apply·test_ecat_abandon_scan)을 그대로 쓴다. 전부 롤백 트랜잭션(복제본 불변).
범위는 '미노출만'(unexposed): 'all'·'from_round' 반영은 끝에 범위의 발행 동결 회차를 재해석 재동결한다(보관 해제 → 새 버전 카드 값,
ingest/frz/tests/test_ecat_refreeze.py). 이 시험은 보관 관문 자체(첫 값 한 벌)를 본다.
"""
from __future__ import annotations

import asyncpg

from ingest.frz.tests.support import freeze, frozen_keys, keep_rows_of, kept, rd_rows_of, view_rows
from ingest.project.apply import ecat_engine as ee
from ingest.project.apply.tests.test_ecat_apply import (  # noqa: F401 (_engine_env = 자동 픽스처: 기준일 고정·재스캔 준비 끔)
    ACTOR,
    PRODUCT_OWNER,
    _apply_row,
    _approve,
    _engine_env,
    _op,
    _request,
    _setup,
)
from ingest.project.apply.tests.test_ecat_pinned_scan import _v3_without_polestar
from tests.support import DB_URL, needs_db

pytestmark = needs_db


async def _freeze_all(c: asyncpg.Connection) -> None:
    cycs = [int(r[0]) for r in await c.fetch("SELECT DISTINCT cyc_key FROM rd.answer WHERE is_rep ORDER BY 1")]
    await freeze(c, cycs)


def _only(rows: dict[str, list[str]], keys: set[int]) -> dict[str, list[str]]:
    import json
    return {t: [r for r in v if json.loads(r)["answer_key"] in keys] for t, v in rows.items()}


async def test_ecat_apply_then_rollback_keeps_first_values(monkeypatch):
    monkeypatch.setenv("HGH_ECAT_CHUNK", "2")
    monkeypatch.setenv("HGH_ECAT_STAMP_CHUNK", "5")
    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    try:
        v2, _ = await _setup(c)
        await _freeze_all(c)
        v0 = await view_rows(c)
        keys = await frozen_keys(c)
        before = await rd_rows_of(c, keys)

        aid = await _request(c, v2, "unexposed")
        assert [o.status for o in await _op(c, aid, "preview")] == ["applied"]
        await _approve(c, aid, PRODUCT_OWNER)
        assert (await _op(c, aid, "apply"))[-1].status == "applied"
        k1 = await kept(c)
        assert k1 and set(k1.values()) == {"apply"}, k1
        assert await keep_rows_of(c, list(k1)) == _only(before, set(k1)), "보관 = 반영 직전 값"
        assert await view_rows(c) == v0, "반영 뒤에도 동결 뷰 = 동결 시점 값"

        # 되돌리기(origin rollback 새 버전 = v1 내용)
        v3 = await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, origin, created_by) "
                              "VALUES (1, 'v1 로 되돌림', '시험', 'rollback', $1) RETURNING ver", ACTOR)
        await c.execute("""INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id,
                                                        note, updated_by, updated_at)
                           SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by, updated_at
                             FROM app.ecat_entity WHERE ver = 1""", v3)
        await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT $1, surface_id, action FROM app.ecat_surface WHERE ver = 1", v3)
        rid = await _request(c, v3, "unexposed")
        assert [o.status for o in await _op(c, rid, "preview")] == ["applied"]
        await _approve(c, rid, PRODUCT_OWNER)
        assert (await _op(c, rid, "apply"))[-1].status == "applied"
        k2 = await kept(c)
        assert await keep_rows_of(c, list(k2)) == _only(before, set(k2)), "되돌린 뒤에도 남은 보관 = 첫 값"
        assert await view_rows(c) == v0
    finally:
        await tr.rollback()
        await c.close()


async def test_ecat_abandon_keeps_first_values(monkeypatch):
    """반영이 청크 중간에 실패(대기 표시가 rd 에 남음) → 포기(abandon)가 반영 전 버전으로 되돌려 투영. 동결 뷰 불변, 보관 = 첫 값."""
    monkeypatch.setenv("HGH_ECAT_CHUNK", "1")
    real = ee.project
    calls = {"n": 0}

    async def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("시험 주입: 두 번째 청크 실패")
        return await real(*a, **k)

    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    try:
        v2, _ = await _setup(c)
        a2 = await _request(c, v2, "unexposed")
        await _op(c, a2, "preview")
        await _approve(c, a2, ACTOR)
        assert (await _op(c, a2, "apply"))[-1].status == "applied"
        await _freeze_all(c)
        v0 = await view_rows(c)
        keys = await frozen_keys(c)
        before = await rd_rows_of(c, keys)
        v3, _ps = await _v3_without_polestar(c, v2, extra_edits=True)
        a3 = await _request(c, v3, "unexposed")
        await _op(c, a3, "preview")
        await _approve(c, a3, ACTOR)
        monkeypatch.setattr(ee, "project", flaky)
        assert [o.status for o in await _op(c, a3, "apply")] == ["progress", "failed"]
        monkeypatch.setattr(ee, "project", real)
        k1 = await kept(c)        # 대기 표시(MARK_PENDING)는 장부 열(ecat_ver)만 쓴다 = 관문 밖·보관 없음. 첫 청크가 값을 바꾼 동결 답변만 남는다
        assert await keep_rows_of(c, list(k1)) == _only(before, set(k1))
        assert await view_rows(c) == v0, "청크 중간 실패(대기 표시가 rd 에 남음)에도 동결 뷰 불변"
        done = await _op(c, a3, "abandon")
        assert done[-1].status == "applied" and (await _apply_row(c, a3))["status"] == "rejected", done
        k2 = await kept(c)
        assert await keep_rows_of(c, list(k2)) == _only(before, set(k2)), "포기 뒤에도 남은 보관 = 첫 값"
        assert await view_rows(c) == v0
    finally:
        await tr.rollback()
        await c.close()
