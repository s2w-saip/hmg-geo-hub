"""Scope 롤업 대상 제거(검증 N8, CE25b·CE27): 경쟁사를 제거하면 그 경쟁사를 Scope 롤업으로 둔 접두 교정 제품('Hyundai Creta', 롤업 Tata)이
엔진에서 자사 집계를 잃는다(롤업 대상 제거 → 접두 교정 전에 브랜드 귀속 없음, seed-3x-common _acr_nm·_bn_pair). 목록 배지·드로어
(versions.service.active_own_brands = RollupRule.entity_own)와 린트(역방향: 제거 대상을 롤업으로 두는 자사 귀속 엔티티 → L2)가 엔진과 같은지 본다.

일회 DB(fresh_db, 커밋). 엔진 = 실제 적재기 투영(rd.answer_brand), 배지 = 서비스 함수(SQLAlchemy 연결), 린트 = 서비스와 같은 역방향 SQL + lint_version.
"""
from __future__ import annotations

import asyncpg
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.db import fetch_all
from app.core.ecat.lint import LintConfig, lint_version, rollup_edit_targets
from app.features.admin.entities.versions import queries as vq
from app.features.admin.entities.versions.service import _own_scope, _snapshot, _with_own, active_own_brands
from ingest.project.apply.ecat import impact
from ingest.project.apply.service import apply
from ingest.project.apply.tests.test_ecat_overlay import (
    ACTOR,
    CRETA,
    FORTWO,
    IONIQ,
    J1,
    J2,
    TATA,
    TOYOTA,
    _all_keys,
    _apply_version,
    _as_loader,
    _brands,
    _make_v2,
    _stage_v1,
)
from tests.support import needs_db

pytestmark = needs_db


def _sa(url: str):
    return create_async_engine(url.replace("postgresql://", "postgresql+asyncpg://"))


async def _v1(c: asyncpg.Connection):
    ctx = await _stage_v1(c)
    keys = await _all_keys(c)
    await c.execute("SELECT app.ecat_cutover_v1($1, 'N8')", ACTOR)
    await _as_loader(c, lambda: apply(c, ctx, keys))
    return ctx


async def _activate_apply(c: asyncpg.Connection, ctx, a: int, b: int) -> None:
    await c.execute("SELECT app.ecat_activate($1)", b)
    imp = await _as_loader(c, lambda: impact(c, a, b))
    cyc = [r[0] for r in await c.fetch("SELECT cyc_key FROM rd.cycle")]
    await _as_loader(c, lambda: _apply_version(c, ctx, imp, cyc))


async def test_removing_rollup_target_only_badge_and_lint_follow_engine(fresh_db):
    """CE27: v1 에서 경쟁사 Tata 만 제거 → 엔진 J1 hyundai entity_rows 2→1·언급 4→3(Creta 탈락). 배지 Creta = 자사 아님, 린트 'Tata 제거' = L2(Hyundai KPI)."""
    c = await asyncpg.connect(fresh_db)
    try:
        ctx = await _v1(c)
        before = (await _brands(c, J1))[("hyundai", True)]
        v2 = int(await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, created_by) VALUES (1, 'N8', 'N8', $1) RETURNING ver",
                                  ACTOR))
        await c.execute("""INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id,
                                                        note, updated_by, updated_at)
                           SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by,
                                  updated_at FROM app.ecat_entity WHERE ver = 1""", v2)
        await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT $1, surface_id, action FROM app.ecat_surface WHERE ver = 1", v2)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, updated_by) "
                        "VALUES ($1, $2, 'scope', 'Tata', 'Brand', 'removed', $3)", v2, TATA, ACTOR)
    finally:
        await c.close()

    # 린트(초안 v2, 기준 v1): 서비스 run_lint 와 같은 역방향 SQL(ROLLUP_DEPENDENTS) → scope_rollups
    eng = _sa(fresh_db)
    try:
        async with eng.connect() as conn:
            draft, base = await _snapshot(conn, v2), await _snapshot(conn, 1)
            targets = rollup_edit_targets(draft, base)
            assert set(targets) == {str(TATA)}, targets
            rows = await fetch_all(conn, vq.ROLLUP_DEPENDENTS, {"targets": sorted(targets), "months": 120, "lim": 5000})
            rups: dict[str, set[str]] = {}
            for r in rows:
                rups.setdefault(str(r["entity_id"]), set()).add(str(r["rollup"]))
            assert rups.get(str(CRETA)) == {str(TATA)}, rups
            scope, labels = await _own_scope(conn, [e.entity_id for e in (*draft.entities, *base.entities)] + sorted(rups))
            rep = lint_version(draft, _with_own(LintConfig.build(), labels), base=base, scope_own=scope, own_labels=labels, scope_rollups=rups)
            f = [x for x in rep.findings if x.code == "OWN_ATTRIBUTED_EDIT" and x.target == f"entity:{TATA}"]
            assert len(f) == 1 and f[0].level == "L2" and f[0].escalate and "Hyundai KPI" in f[0].detail, rep.findings
            assert lint_version(draft, _with_own(LintConfig.build(), labels), base=base, scope_own=scope, own_labels=labels).findings != rep.findings
    finally:
        await eng.dispose()

    c = await asyncpg.connect(fresh_db)
    try:
        await _activate_apply(c, ctx, 1, v2)
        after = (await _brands(c, J1))[("hyundai", True)]
    finally:
        await c.close()
    assert (before[1], before[3]) == (2, 4) and (after[1], after[3]) == (1, 3), (before, after)   # 엔진: Creta 언급이 Hyundai 에서 빠짐

    eng = _sa(fresh_db)
    try:
        async with eng.connect() as conn:
            badge = await active_own_brands(conn, [CRETA, TATA])
    finally:
        await eng.dispose()
    assert badge[str(CRETA)] is None, badge                                    # 배지 = 엔진(롤업 대상 제거 → 접두 교정 전에 귀속 없음)


async def test_badge_equals_engine_on_overlay_v2(fresh_db):
    """CE25b: 오버레이 v2(Fortwo 모 브랜드 = Kia, Ioniq 제거, Tata 제거로 Creta 롤업 상실) 반영 뒤 배지 = 엔진 J1·J2."""
    c = await asyncpg.connect(fresh_db)
    try:
        ctx = await _v1(c)
        j1_v1 = await _brands(c, J1)
        v2 = await _make_v2(c, ctx)
        imp = await _as_loader(c, lambda: impact(c, 1, v2))
        cyc = [r[0] for r in await c.fetch("SELECT cyc_key FROM rd.cycle")]
        await _as_loader(c, lambda: _apply_version(c, ctx, imp, cyc))
        j1, j2 = await _brands(c, J1), await _brands(c, J2)
    finally:
        await c.close()
    assert j1_v1[("hyundai", True)][1] == 2 and j1[("hyundai", True)][1] == 1, (j1_v1, j1)   # 엔진: Creta 탈락
    assert j2[("kia", True)][1] == 2, j2                                                      # 엔진: Fortwo → Kia
    eng = _sa(fresh_db)
    try:
        async with eng.connect() as conn:
            badge = await active_own_brands(conn, [FORTWO, IONIQ, CRETA, TOYOTA])
    finally:
        await eng.dispose()
    assert badge == {str(FORTWO): "Kia", str(IONIQ): None, str(CRETA): None, str(TOYOTA): None}, badge
