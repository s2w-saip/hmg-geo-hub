"""린트 자사 귀속 판정(app.core.ecat.lint.RollupRule + app.ecat_hmg_prefix_id) = 엔진 귀속 규칙(투영 오버레이) 동치 시험(검증 N7).

표 형태: 엔진 귀속 규칙마다 사례 1개. 사례마다 실제 엔진으로 v1 → v2(사례 설정) → v3(v2 + 전역 차단 'Creta')를 투영하고, Creta 언급이 든
답변의 hyundai(자사) 언급 수가 v2 → v3 에서 줄면 "엔진 = 자사 귀속". 같은 v3 내용·같은 언급 관측(엔티티, Scope 롤업, 표시명 접두 교정)으로
RollupRule.own_of 가 자사를 돌려주는지와 대조한다. 엔티티 단위 판정 RollupRule.entity_own(목록 배지·드로어·린트 편집 경고가 쓰는 것: 덮어쓰기
없을 때 투영 차원 귀속 scope_own + Scope 롤업 scope_rollups)도 같은 사례에서 엔진과 대조한다(검증 N8: 롤업 대상 제거를 차원이 모른다). 규칙 원천 = migration/seed/seed-3x-common.sql §4-2 _ecat_x · §6 _bn_pair(J1) ·
seed-40 §5-0 _meff(같은 식을 적재기 ingest/project/apply/queries.py 가 범위로 좁혀 쓴다).

접두 교정 함수 동치: app.ecat_hmg_prefix_id(린트가 쓰는 영구 사본, DB-v2.17 P104) = pg_temp.hmg_prefix_id(엔진 원본, ingest.common.rules 가
적재기 연결에 올리는 seed-3x-common §2)를 같은 입력(픽스처 전 표시명 + 경계 사례)에서 대조한다. 원본이 바뀌면 이 시험이 실패한다.
전부 롤백 트랜잭션(복제본 불변).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

import asyncpg
import pytest

from app.core.ecat.lint import EntityRow, LintConfig, RollupRule, VersionSnapshot, tracked_ids
from app.core.ecat.text import normalize_surface
from ingest.common.rules import ensure_session_rules
from ingest.project.apply.ecat import impact
from ingest.project.apply.service import apply
from ingest.project.apply.tests.test_ecat_overlay import (
    ACTOR,
    CRETA,
    HYUNDAI,
    SMART,
    TATA,
    TOYOTA,
    TOYOTA2,
    _all_keys,
    _apply_version,
    _as_loader,
    _stage_v1,
)
from tests.support import DB_URL, needs_db

pytestmark = needs_db

ENT_COLS = "entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by, updated_at"


@dataclass
class Case:
    rule: str
    want_own: bool
    display: str | None = None                  # Creta 언급 표시명(원천 수정, None = 픽스처 'Hyundai Creta')
    scope_rollup: uuid.UUID | None = None       # Creta 언급 Scope 롤업(None = 픽스처 Tata)
    edits: list[tuple[uuid.UUID, dict]] = field(default_factory=list)   # v2 엔티티 행(없으면 Scope 기본 경쟁)


CASES = [
    Case("J1 접두 교정: 표시명 'Hyundai Creta', Scope 롤업 Tata → Hyundai", True),
    Case("접두 없음: Scope 롤업 Tata → 자사 아님", False, display="Creta"),
    Case("Scope 롤업 = 자사", True, display="Creta", scope_rollup=HYUNDAI),
    Case("덮어쓰기(경쟁사) 우선: 접두 교정 건너뜀", False, edits=[(CRETA, {"parent_brand_id": TOYOTA})]),
    Case("덮어쓰기 = 자사", True, display="Creta", edits=[(CRETA, {"parent_brand_id": HYUNDAI})]),
    Case("덮어쓰기 대상이 자사 별칭 → 별칭 접기", True, display="Creta",
         edits=[(TOYOTA2, {"merge_into": HYUNDAI}), (CRETA, {"parent_brand_id": TOYOTA2})]),
    Case("병합 원본은 병합 대상의 덮어쓰기(2단)", True, display="Creta",
         edits=[(SMART, {"parent_brand_id": HYUNDAI, "role": "hidden", "name": "smart"}), (CRETA, {"merge_into": SMART})]),
    Case("모 브랜드의 모 브랜드는 따라가지 않는다", False, display="Creta",
         edits=[(SMART, {"parent_brand_id": HYUNDAI, "role": "hidden", "name": "smart"}), (CRETA, {"parent_brand_id": SMART})]),
    Case("엔티티 제거 → 언급 제외", False, edits=[(CRETA, {"role": "removed"})]),
    Case("롤업 대상 제거 → 접두가 있어도 브랜드 귀속 없음", False, edits=[(TATA, {"role": "removed"})]),
    Case("롤업 대상의 병합 대상 제거 → 브랜드 귀속 없음", False, edits=[(TOYOTA, {"role": "removed"}), (TATA, {"merge_into": TOYOTA})]),
    Case("롤업 대상 제거 + 덮어쓰기 자사 → 덮어쓰기 우선(자사)", True, edits=[(TATA, {"role": "removed"}), (CRETA, {"parent_brand_id": HYUNDAI})]),
]


async def _new_ver(c: asyncpg.Connection, base: int) -> int:
    v = int(await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, created_by) VALUES ($1, 'parity', 'parity', $2) RETURNING ver",
                             base, ACTOR))
    await c.execute(f"INSERT INTO app.ecat_entity (ver, {ENT_COLS}) SELECT $1, {ENT_COLS} FROM app.ecat_entity WHERE ver = $2", v, base)
    await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT $1, surface_id, action FROM app.ecat_surface WHERE ver = $2", v, base)
    return v


async def _edit(c: asyncpg.Connection, ver: int, eid: uuid.UUID, fields: dict) -> None:
    row = await c.fetchrow("SELECT role, name, merge_into, parent_brand_id FROM app.ecat_entity WHERE ver = $1 AND entity_id = $2", ver, eid)
    cur = dict(row) if row else {"role": "competitor", "name": None, "merge_into": None, "parent_brand_id": None}
    cur.update(fields)
    await c.execute("""INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, merge_into, parent_brand_id, updated_by)
                       VALUES ($1, $2, 'scope', $3, 'Brand', $4, $5, $6, $7)
                       ON CONFLICT (ver, entity_id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, merge_into = EXCLUDED.merge_into,
                                                                  parent_brand_id = EXCLUDED.parent_brand_id""",
                    ver, eid, cur["name"], cur["role"], cur["merge_into"], cur["parent_brand_id"], ACTOR)


async def _step(c: asyncpg.Connection, ctx, a: int, b: int) -> None:
    await c.execute("SELECT app.ecat_activate($1)", b)
    imp = await _as_loader(c, lambda: impact(c, a, b))
    cyc = [r[0] for r in await c.fetch("SELECT cyc_key FROM rd.cycle")]
    await _as_loader(c, lambda: _apply_version(c, ctx, imp, cyc))


async def _own_mentions(c: asyncpg.Connection, job: uuid.UUID) -> int:
    return int(await c.fetchval("""
        SELECT coalesce(sum(ab.mention_count), 0) FROM rd.job j
          JOIN rd.answer_brand ab ON ab.surface = j.surface AND ab.round_date = j.round_date AND ab.answer_key = j.answer_key
          JOIN rd.dim_brand_name b ON b.brand_key = ab.brand_key
         WHERE j.job_id = $1 AND lower(b.bare) = 'hyundai'""", job))     # 현행 프로필 NAME 의 bare = 'Hyundai'(정본 표시명 그대로)


async def _snapshot(c: asyncpg.Connection, ver: int) -> VersionSnapshot:
    rows = await c.fetch("SELECT entity_id, role, name, brand_code, merge_into, parent_brand_id FROM app.ecat_entity WHERE ver = $1", ver)
    return VersionSnapshot(entities=tuple(EntityRow(str(r["entity_id"]), r["role"], r["name"] or "", r["brand_code"],
                                                    str(r["merge_into"]) if r["merge_into"] else None,
                                                    str(r["parent_brand_id"]) if r["parent_brand_id"] else None) for r in rows))


async def _case(c: asyncpg.Connection, ctx, case: Case) -> tuple[bool, bool, bool, str]:
    if case.display is not None:
        await c.execute("UPDATE ing.mention SET display_name = $2 WHERE entity_id = $1", CRETA, case.display)
    if case.scope_rollup is not None:
        await c.execute("UPDATE ing.mention SET brand_rollup_entity_id = $2 WHERE entity_id = $1", CRETA, case.scope_rollup)
    await _as_loader(c, lambda: apply(c, ctx, keys_holder["keys"]))
    v2 = await _new_ver(c, 1)
    for eid, f in case.edits:
        await _edit(c, v2, eid, f)
    await _step(c, ctx, 1, v2)
    job = await c.fetchval("SELECT job_id FROM ing.mention WHERE entity_id = $1 ORDER BY job_id LIMIT 1", CRETA)
    before = await _own_mentions(c, job)
    v3 = await _new_ver(c, v2)
    sid = await c.fetchval("INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, created_by) VALUES (NULL, 'Creta', $1, $2) "
                           "RETURNING surface_id", normalize_surface("Creta"), ACTOR)
    await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) VALUES ($1, $2, 'block')", v3, sid)
    await _step(c, ctx, v2, v3)
    after = await _own_mentions(c, job)
    engine_own = after < before
    obs = await c.fetchrow("SELECT brand_rollup_entity_id AS rollup, app.ecat_hmg_prefix_id(display_name) AS pfx FROM ing.mention "
                           "WHERE entity_id = $1 LIMIT 1", CRETA)
    draft, base = await _snapshot(c, v3), await _snapshot(c, v2)
    rule = RollupRule(draft, tracked_ids(draft, LintConfig.build(), base))
    lint_own = rule.own_of(str(CRETA), str(obs["rollup"]) if obs["rollup"] else None, str(obs["pfx"]) if obs["pfx"] else None) is not None
    # 엔티티 단위: scope_own = 투영 차원 표시 브랜드의 자사(versions.queries.OWN_SCOPE_ATTRIBUTION 과 같은 식), scope_rollups = 언급의 Scope 롤업
    dim = await c.fetchval("""SELECT b.canonical_entity_id FROM rd.dim_entity e
                                JOIN rd.dim_brand_name bn ON bn.brand_key = e.brand_key AND bn.own_bit <> 0
                                JOIN app.brand b ON b.is_hmg_own AND NOT b.is_umbrella AND b.brand_bit = bn.own_bit AND b.canonical_entity_id IS NOT NULL
                               WHERE e.entity_id = $1""", CRETA)
    rups = {str(r[0]) for r in await c.fetch("SELECT DISTINCT brand_rollup_entity_id FROM ing.mention WHERE entity_id = $1 "
                                             "AND brand_rollup_entity_id IS NOT NULL", CRETA)}
    ent_own = rule.entity_own(str(CRETA), {str(CRETA): str(dim)} if dim else {}, {str(CRETA): rups}) is not None
    return engine_own, lint_own, ent_own, f"hyundai {before} → {after}, 차원 귀속 {dim}, 롤업 {sorted(rups)}"


keys_holder: dict = {}


@pytest.mark.parametrize("case", CASES, ids=[c.rule for c in CASES])
async def test_lint_rollup_rule_equals_engine_attribution(case: Case):
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        try:
            ctx = await _stage_v1(c)
            await c.execute("UPDATE ing.mention SET surfaces = ARRAY['Creta'] WHERE entity_id = $1", CRETA)
            keys_holder["keys"] = await _all_keys(c)
            await c.execute("SELECT app.ecat_cutover_v1($1, 'parity')", ACTOR)
            engine_own, lint_own, ent_own, note = await _case(c, ctx, case)
        finally:
            await tr.rollback()
    finally:
        await c.close()
    assert engine_own == case.want_own, (case.rule, "엔진 기대값이 다르다(픽스처·규칙 변경?)", note)
    assert lint_own == engine_own, (case.rule, "린트 자사 귀속 판정이 엔진과 다르다", note)
    assert ent_own == engine_own, (case.rule, "엔티티 단위 귀속(배지·드로어·린트 편집 경고)이 엔진과 다르다", note)


async def test_prefix_function_copy_equals_engine_original():
    c = await asyncpg.connect(DB_URL)
    try:
        await ensure_session_rules(c)
        cases = ["Hyundai Creta", "hyundai", "HYUNDAI-N", "Hyundai_x", "Hyundaii", "  Hyundai Kona", " Hyundai Tucson", "　Kia EV6",
                 "Kia", "Kiaora", "GENESIS GV80", "Genesis.", "제네시스 G80", "현대자동차 아이오닉", "현대차", "현대", "현대모비스", "기아 K5",
                 "كيا سبورتاج", "هيونداي", "יונדאי", "Toyota", "", "Tata (Hyundai)", "Hyundai/Kia"]
        cases += [r[0] for r in await c.fetch("SELECT DISTINCT display_name FROM ing.mention WHERE display_name IS NOT NULL")]
        bad = []
        for d in cases:
            a = await c.fetchval("SELECT pg_temp.hmg_prefix_id($1)", d)
            b = await c.fetchval("SELECT app.ecat_hmg_prefix_id($1)", d)
            if a != b:
                bad.append((d, a, b))
        assert not bad, bad
        assert await c.fetchval("SELECT app.ecat_hmg_prefix_id('Hyundai Creta')") == HYUNDAI
    finally:
        await c.close()
