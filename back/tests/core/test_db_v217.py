"""DB-v2.17(엔티티 직접 관리·버전 반영 E0 데이터 모델, 제품 결정 26~29) 패치 시험. 이 대분류(core)의 복제본은 dbforward 가 v2.17 까지 올린 상태다.
쓰기는 전부 트랜잭션 안에서 하고 되돌린다(복제본 불변: 버전 행이 남으면 같은 대분류의 명부 쓰기 시험이 가드에 막힌다).

  1. 합본 = v2.16(WU-7) + 패치(바이트), 재적용 거부, 패치 직후 버전 0·기존 명부 쓰기 열림, rd.answer.ecat_ver = 1(기존 행·새 leaf), rd.cycle.ecat_ver NULL
  2. v1 이관: 행 수 = 명부 + 별칭 − 겹침, own → own·excluded → hidden·별칭 → merge_into, 뷰 행 = 이관 전 기존 표 행(행 단위·md5),
     기존 표 불변, 재이관 거부, 이관 스크립트(드라이런) = 쓰기 없음
  3. 호환 계층: 활성 버전이 있으면 기존 표 직접 쓰기(INSERT·UPDATE·DELETE·TRUNCATE, 소유자·api_rw 모두) 거부
  4. 버전 흐름: 초안 1개, 활성·보관 불변, 활성화는 ecat_activate 로만(loader), 새 버전 활성화 = 기존 표 투영 + md5 동치, 되돌림 = 원래 md5
  5. 병합 체인·자기 병합·전역 표면 add·표면 정의 불변, 반영 원장 상태 전이·동시 실행 1건·삭제 금지, judgment_change entity_version payload,
     ing.hub_match leaf·적재기 쓰기, 권한(api_rw 는 활성화·이관 불가)
"""
from __future__ import annotations

import contextlib
import hashlib
import pathlib
import uuid

import asyncpg
import pytest

from tests.support import DB_URL, needs_db

BACK = pathlib.Path(__file__).resolve().parents[2]
DB = BACK / "db"
CUTOVER = BACK / "migration" / "ecat-v1-cutover.sql"

ACTOR = uuid.UUID("7e000000-0000-4000-8000-0000000000e0")
EDITOR = uuid.UUID("7e000000-0000-4000-8000-0000000000e1")
HYUNDAI, KIA, GENESIS = (uuid.UUID(f"00000000-0000-0000-0000-000000000{n}") for n in (301, 302, 304))
KIA_KO = uuid.UUID("ed4b8012-4a73-4174-9b43-4cb696934b25")          # 픽스처 별칭(→ Kia) 이자 아래 명부 own 행: 겹침 1
APPLE = uuid.UUID("71000000-0000-4000-8000-000000000003")
SMART = uuid.UUID("71000000-0000-4000-8000-000000000006")
TOYOTA = uuid.UUID("71000000-0000-4000-8000-000000000001")
TOYOTA2 = uuid.UUID("71000000-0000-4000-8000-000000000002")

# 명부 6행(own 4 · excluded 2, brand_code·updated_by 가 있는 excluded 포함). 픽스처 별칭 7행과 KIA_KO 1행이 겹친다.
REGISTRY = [
    (HYUNDAI, "Hyundai", "own", "Hyundai", None),
    (KIA, "Kia", "own", "Kia", EDITOR),
    (GENESIS, "Genesis", "own", "Genesis", None),
    (KIA_KO, "기아", "own", "Kia", None),
    (APPLE, "Apple", "excluded", None, EDITOR),
    (SMART, "smart", "excluded", "Hyundai", None),
]
REG_SQL = "SELECT entity_id, name, role, brand_code, updated_by, updated_at FROM app.entity_registry ORDER BY entity_id"
ALIAS_SQL = "SELECT alias_entity_id, canon_entity_id FROM app.entity_alias ORDER BY alias_entity_id"
VIEW_REG_SQL = "SELECT entity_id, name, role, brand_code, updated_by, updated_at FROM app.ecat_registry_active ORDER BY entity_id"
VIEW_ALIAS_SQL = "SELECT alias_entity_id, canon_entity_id FROM app.ecat_alias_active ORDER BY alias_entity_id"


def test_merged_ddl_is_v215_plus_patch():
    assert (DB / "DB-v2.17.sql").read_bytes() == (DB / "DB-v2.16.sql").read_bytes() + (DB / "DB-v2.17-patch.sql").read_bytes()
    src = (DB / "DB-v2.17-patch.sql").read_text(encoding="utf-8")
    assert "ecat-v1-cutover.sql" in src and "lock_timeout" in src and "DB-v2.17 이미 적용됨" in src


def _tuples(rows) -> list[tuple]:
    return [tuple(r) for r in rows]


def _md5(rows: list[tuple]) -> str:
    """독립 지문(파이썬): 행 튜플 repr 을 정렬 순서대로 이은 md5. SQL 지문 함수와 다른 경로."""
    return hashlib.md5("\n".join(repr(r) for r in rows).encode()).hexdigest()


async def _conn() -> asyncpg.Connection:
    return await asyncpg.connect(DB_URL)


async def _seed_registry(c: asyncpg.Connection) -> None:
    await c.executemany(
        "INSERT INTO app.entity_registry (entity_id, name, role, brand_code, updated_by, updated_at) "
        "VALUES ($1, $2, $3, $4, $5, timestamptz '2026-09-20 10:00:00+00' + (random() * interval '9 days'))", REGISTRY)


@contextlib.asynccontextmanager
async def _as(c: asyncpg.Connection, role: str):
    """저장점 안에서 role 을 내리고 끝나면 되돌린다(SET LOCAL 은 저장점 해제 뒤에도 바깥 트랜잭션 끝까지 남는다)."""
    async with c.transaction():
        await c.execute(f"SET LOCAL ROLE {role}")
        yield                                     # 예외면 저장점 롤백이 SET LOCAL 도 되돌린다
        await c.execute("RESET ROLE")


async def _raises(c: asyncpg.Connection, sql: str, match: str, *args, role: str | None = None) -> None:
    with pytest.raises(asyncpg.PostgresError, match=match):
        async with c.transaction():
            if role:
                await c.execute(f"SET LOCAL ROLE {role}")
            await c.execute(sql, *args)


@needs_db
async def test_patch_refuses_reapply_and_starts_empty():
    c = await _conn()
    try:
        with pytest.raises(asyncpg.RaiseError, match="DB-v2.17 이미 적용됨"):
            await c.execute((DB / "DB-v2.17-patch.sql").read_text(encoding="utf-8"))
        await c.execute("ROLLBACK")
        assert await c.fetchval("SELECT count(*) FROM app.ecat_version") == 0
        assert await c.fetchval("SELECT count(*) FROM app.ecat_registry_active") == 0
        n = await c.fetchval("SELECT count(*) FROM rd.answer")
        assert n > 0 and await c.fetchval("SELECT count(*) FROM rd.answer WHERE ecat_ver = 1") == n
        assert await c.fetchval("SELECT count(*) FROM rd.cycle WHERE ecat_ver IS NOT NULL") == 0
        # 버전이 없으면 기존 명부 쓰기는 현 동작 그대로(관리 PUT·시드·픽스처)
        tr = c.transaction()
        await tr.start()
        try:
            await _seed_registry(c)
            await c.execute("TRUNCATE app.entity_registry")
            await c.execute("DELETE FROM app.entity_alias WHERE alias_entity_id = $1", KIA_KO)
        finally:
            await tr.rollback()
        # ensure_leaf 가 패치 뒤에 만든 새 leaf 도 ecat_ver 기본값 1 을 갖는다(파티션 전파)
        tr = c.transaction()
        await tr.start()
        try:
            await c.execute("SELECT rd.ensure_leaf(1::int2, date '2031-01-01')")
            leaf = await c.fetchrow("SELECT attnotnull, pg_get_expr(d.adbin, d.adrelid) AS dflt FROM pg_attribute a "
                                    "JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum "
                                    "WHERE a.attrelid = 'rd.answer_g_203101'::regclass AND a.attname = 'ecat_ver'")
            assert leaf["attnotnull"] and leaf["dflt"] == "1"
        finally:
            await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_cutover_v1_counts_roles_and_view_equals_legacy():
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        await _seed_registry(c)
        reg0, ali0 = _tuples(await c.fetch(REG_SQL)), _tuples(await c.fetch(ALIAS_SQL))
        assert (len(reg0), len(ali0)) == (6, 7)
        overlap = len({r[0] for r in reg0} & {a[0] for a in ali0})
        assert overlap == 1
        md0 = await c.fetchrow("SELECT * FROM app.ecat_legacy_md5()")

        async with _as(c, "migrator"):                                              # 이관 롤(EXECUTE 만, app 쓰기 권한 없음)
            res = await c.fetchrow("SELECT * FROM app.ecat_cutover_v1($1, 'test')", ACTOR)
        assert (res["ver"], res["registry_rows"], res["alias_rows"], res["overlap_rows"], res["entity_rows"]) == (1, 6, 7, 1, 12)
        assert (res["own_rows"], res["hidden_rows"], res["legacy_changed"]) == (4, 2, 0)

        # v1 행 수 = 명부 + 별칭 − 겹침(독립 재계산: 파이썬 합집합)
        ents = await c.fetch("SELECT entity_id, role, brand_code, merge_into, name, origin FROM app.ecat_entity WHERE ver = 1")
        assert len(ents) == len({r[0] for r in reg0} | {a[0] for a in ali0}) == 12
        by = {e["entity_id"]: e for e in ents}
        for eid, name, role, bc, _ in REGISTRY:
            assert by[eid]["role"] == {"own": "own", "excluded": "hidden"}[role] and by[eid]["brand_code"] == bc and by[eid]["name"] == name
        for alias, canon in ali0:
            assert by[alias]["merge_into"] == canon
        assert by[KIA_KO]["role"] == "own" and by[KIA_KO]["merge_into"] == KIA            # 겹침 = 한 행에 역할 + 병합
        assert {e["origin"] for e in ents} == {"scope"}
        assert sum(1 for e in ents if e["role"] == "competitor") == 12 - 6              # 별칭만 있는 6행 = 기본 경쟁(명부 투영 없음)

        v = await c.fetchrow("SELECT status, origin, created_by, content_md5 FROM app.ecat_version WHERE ver = 1")
        assert (v["status"], v["origin"], v["created_by"]) == ("active", "cutover", ACTOR) and len(v["content_md5"]) == 16
        assert v["content_md5"] == await c.fetchval("SELECT app.ecat_content_md5(1)")

        # 호환 계층 동치: 뷰 행 = 이관 전 기존 표 행(행 단위·파이썬 md5·SQL md5), 기존 표도 이관 전 그대로
        vreg, vali = _tuples(await c.fetch(VIEW_REG_SQL)), _tuples(await c.fetch(VIEW_ALIAS_SQL))
        assert vreg == reg0 and vali == ali0
        assert _md5(vreg) == _md5(reg0) and _md5(vali) == _md5(ali0)
        assert tuple(await c.fetchrow("SELECT * FROM app.ecat_active_md5()")) == tuple(md0)
        assert _tuples(await c.fetch(REG_SQL)) == reg0 and _tuples(await c.fetch(ALIAS_SQL)) == ali0
        assert tuple(await c.fetchrow("SELECT * FROM app.ecat_legacy_md5()")) == tuple(md0)
        # 적재기가 읽는 모양 그대로: 명부 역할 값은 own·excluded 만
        assert {r[2] for r in vreg} == {"own", "excluded"}

        with pytest.raises(asyncpg.RaiseError, match="ECAT_CUTOVER_DONE"):
            async with c.transaction():
                await c.execute("SELECT app.ecat_cutover_v1($1)", ACTOR)
        assert await c.fetchval("SELECT nextval(pg_get_serial_sequence('app.ecat_version', 'ver'))") >= 2   # 다음 버전 번호가 v1 과 겹치지 않는다
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_cutover_script_dry_run_writes_nothing():
    from tests.dbforward import run_psql_file

    c = await _conn()
    try:
        results = await run_psql_file(c, CUTOVER, {"actor": str(ACTOR)})
        pre, cut, vers = results[0][0], results[1][0], results[2]
        assert pre["versions_before"] == 0 and pre["alias_rows"] == 7
        assert cut["ver"] == 1 and cut["entity_rows"] == pre["registry_rows"] + pre["alias_rows"] - pre["overlap_rows"]
        assert [(r["ver"], r["status"]) for r in vers] == [(1, "active")]
        assert await c.fetchval("SELECT count(*) FROM app.ecat_version") == 0              # 드라이런 = ROLLBACK
        with pytest.raises(asyncpg.RaiseError, match="행위자 필수"):
            await run_psql_file(c, CUTOVER, {})
        await c.execute("ROLLBACK")
        assert await c.fetchval("SELECT count(*) FROM app.ecat_version") == 0
    finally:
        await c.close()


@needs_db
async def test_legacy_tables_reject_direct_writes_after_cutover():
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        await _seed_registry(c)
        await c.execute("SELECT app.ecat_cutover_v1($1)", ACTOR)
        for sql, args in [
            ("INSERT INTO app.entity_registry (entity_id, name, role) VALUES ($1, 'Toyota', 'excluded')", (TOYOTA,)),
            ("INSERT INTO app.entity_registry (entity_id, name, role) VALUES ($1, 'Apple', 'excluded') "
             "ON CONFLICT (entity_id) DO UPDATE SET role = EXCLUDED.role", (APPLE,)),          # 관리 PUT 모양
            ("UPDATE app.entity_registry SET role = 'own' WHERE entity_id = $1", (APPLE,)),
            ("DELETE FROM app.entity_registry WHERE entity_id = $1", (APPLE,)),
            ("TRUNCATE app.entity_registry", ()),
            ("INSERT INTO app.entity_alias VALUES ($1, $2)", (TOYOTA2, TOYOTA)),
            ("DELETE FROM app.entity_alias", ()),
            ("TRUNCATE app.entity_alias", ()),
        ]:
            await _raises(c, sql, "ECAT_LEGACY_WRITE", *args)
            if not sql.startswith("TRUNCATE"):
                await _raises(c, sql, "ECAT_LEGACY_WRITE", *args, role="api_rw")
        # 가드 우회 표시(GUC)만으로는 못 지나간다: hmg_owner(투영 함수 안)여야 한다
        with pytest.raises(asyncpg.RaiseError, match="ECAT_LEGACY_WRITE"):
            async with _as(c, "api_rw"):
                await c.execute("SELECT set_config('app.ecat_projecting', 'on', true)")
                await c.execute("DELETE FROM app.entity_registry WHERE entity_id = $1", APPLE)
        assert len(await c.fetch(REG_SQL)) == 6
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_version_flow_draft_activate_project_and_rollback():
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        await _seed_registry(c)
        await c.execute("SELECT app.ecat_cutover_v1($1)", ACTOR)
        reg0, ali0 = _tuples(await c.fetch(REG_SQL)), _tuples(await c.fetch(ALIAS_SQL))

        # 초안 = 활성 복사(관리 API 롤 api_rw, 식별자 발급 포함)
        async with _as(c, "api_rw"):
            v2 = await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, created_by) VALUES (1, '초안', '시험', $1) RETURNING ver",
                                  EDITOR)
            await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, "
                            "note, updated_by, updated_at) SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, "
                            "parent_brand_id, note, updated_by, updated_at FROM app.ecat_entity WHERE ver = 1", v2)
            await c.execute("UPDATE app.ecat_entity SET role = 'removed', updated_by = $2, updated_at = now() WHERE ver = $1 AND entity_id = $3",
                            v2, EDITOR, APPLE)                                                    # 숨김 → 제거
            await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, name, role, merge_into, updated_by) VALUES ($1, $2, 'TOYOTA', "
                            "'competitor', $3, $4)", v2, TOYOTA2, TOYOTA, EDITOR)                 # 병합 추가
            await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, origin, name, role, updated_by) VALUES ($1, $2, 'hub', 'Tata', "
                            "'hidden', $3)", v2, uuid.UUID("71000000-0000-4000-8000-000000000005"), EDITOR)
            sid = await c.fetchval("INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, created_by) "
                                   "VALUES (NULL, 'N', 'n', $1) RETURNING surface_id", EDITOR)
            await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) VALUES ($1, $2, 'block')", v2, sid)
        assert v2 >= 2
        with pytest.raises(asyncpg.UniqueViolationError, match="ecat_version_one_draft"):
            async with c.transaction():
                await c.execute("INSERT INTO app.ecat_version (title, created_by) VALUES ('둘째 초안', $1)", EDITOR)
        await _raises(c, "UPDATE app.ecat_version SET status = 'active', activated_at = now(), content_md5 = app.ecat_content_md5(ver) "
                         f"WHERE ver = {v2}", "ECAT_IMMUTABLE", role="api_rw")
        await _raises(c, f"SELECT app.ecat_activate({v2})", "permission denied", role="api_rw")
        await _raises(c, "UPDATE app.ecat_entity SET role = 'removed' WHERE ver = 1 AND entity_id = $1", "ECAT_IMMUTABLE", SMART)
        await _raises(c, "DELETE FROM app.ecat_version WHERE ver = 1", "ECAT_IMMUTABLE")
        await _raises(c, "UPDATE app.ecat_version SET title = 'x' WHERE ver = 1", "ECAT_IMMUTABLE")

        # 활성화(적재기 롤): v1 → retired, v2 → active, 기존 표 = v2 투영(제거·숨김·병합 반영), md5 동치
        async with _as(c, "loader"):
            changed = await c.fetchval("SELECT app.ecat_activate($1)", v2)
        st = {r["ver"]: r["status"] for r in await c.fetch("SELECT ver, status FROM app.ecat_version")}
        assert st == {1: "retired", v2: "active"}
        reg2, ali2 = _tuples(await c.fetch(REG_SQL)), _tuples(await c.fetch(ALIAS_SQL))
        assert APPLE not in {r[0] for r in reg2}                                     # 제거는 명부 투영에 없다(E1 이 언급을 뺀다)
        assert [r[2] for r in reg2 if r[1] == "Tata"] == ["excluded"]               # 허브 엔티티 숨김 = excluded
        assert (TOYOTA2, TOYOTA) in ali2 and len(ali2) == 8
        assert changed == 1 + 1 + 1                                                  # 명부 삭제 1·삽입 1, 별칭 삽입 1
        assert reg2 == _tuples(await c.fetch(VIEW_REG_SQL)) and ali2 == _tuples(await c.fetch(VIEW_ALIAS_SQL))
        assert tuple(await c.fetchrow("SELECT * FROM app.ecat_active_md5()")) == tuple(await c.fetchrow("SELECT * FROM app.ecat_legacy_md5()"))
        await _raises(c, "UPDATE app.ecat_surface SET action = action WHERE ver = $1", "ECAT_IMMUTABLE", v2)

        # 되돌림 = v1 내용을 새 초안으로 복사해 활성화 → 기존 표가 원래 행으로(md5 원복)
        v3 = await c.fetchval("INSERT INTO app.ecat_version (based_on, title, reason, origin, created_by) VALUES (1, '되돌림', '시험', 'rollback', $1) "
                              "RETURNING ver", EDITOR)
        await c.execute("INSERT INTO app.ecat_entity SELECT $1, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, "
                        "note, updated_by, updated_at FROM app.ecat_entity WHERE ver = 1", v3)
        await c.execute("SELECT app.ecat_activate($1)", v3)
        assert _tuples(await c.fetch(REG_SQL)) == reg0 and _tuples(await c.fetch(ALIAS_SQL)) == ali0
        assert await c.fetchval("SELECT app.ecat_content_md5($1) = app.ecat_content_md5(1)", v3)
        assert {r["ver"]: r["status"] for r in await c.fetch("SELECT ver, status FROM app.ecat_version")} == {1: "retired", v2: "retired", v3: "active"}
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_merge_chain_surface_and_definition_rules():
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        v = await c.fetchval("INSERT INTO app.ecat_version (title, created_by) VALUES ('초안', $1) RETURNING ver", EDITOR)
        a, b, x, y = (uuid.uuid4() for _ in range(4))
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, merge_into) VALUES ($1, $2, $3)", v, a, b)      # A → B
        await _raises(c, "INSERT INTO app.ecat_entity (ver, entity_id, merge_into) VALUES ($1, $2, $3)", "ECAT_MERGE_CHAIN", v, b, x)   # B → X
        await _raises(c, "INSERT INTO app.ecat_entity (ver, entity_id, merge_into) VALUES ($1, $2, $3)", "ECAT_MERGE_CHAIN", v, y, a)   # Y → A
        await _raises(c, "INSERT INTO app.ecat_entity (ver, entity_id, merge_into) VALUES ($1, $2, $2)", "ecat_entity_merge_self", v, x)
        await _raises(c, "INSERT INTO app.ecat_entity (ver, entity_id, name, role) VALUES ($1, $2, 'X', 'own')", "ecat_entity_own_brand", v, x)
        await _raises(c, "INSERT INTO app.ecat_entity (ver, entity_id, role) VALUES ($1, $2, 'hidden')", "ecat_entity_named", v, x)
        await c.execute("INSERT INTO app.ecat_entity (ver, entity_id, merge_into) VALUES ($1, $2, $3)", v, y, b)      # 같은 대상 여럿은 허용
        g = await c.fetchval("INSERT INTO app.ecat_surface_def (surface, surface_norm, created_by) VALUES ('Plus', 'plus', $1) RETURNING surface_id",
                             EDITOR)
        e = await c.fetchval("INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, created_by) VALUES ($1, 'Kia EV', 'kia ev', $2) "
                             "RETURNING surface_id", KIA, EDITOR)
        await _raises(c, "INSERT INTO app.ecat_surface (ver, surface_id, action) VALUES ($1, $2, 'add')", "ECAT_SURFACE_ADD_GLOBAL", v, g)
        await c.execute("INSERT INTO app.ecat_surface (ver, surface_id, action) VALUES ($1, $2, 'block'), ($1, $3, 'add')", v, g, e)
        await _raises(c, "INSERT INTO app.ecat_surface_def (surface, surface_norm, created_by) VALUES ('PLUS', 'plus', $1)", "ecat_surface_def_uniq",
                      EDITOR)
        await _raises(c, "UPDATE app.ecat_surface_def SET surface = 'x' WHERE surface_id = $1", "append-only", g)
        await _raises(c, "DELETE FROM app.ecat_surface_def WHERE surface_id = $1", "append-only", g)
        md = await c.fetchval("SELECT app.ecat_content_md5($1)", v)
        await c.execute("UPDATE app.ecat_entity SET note = '메모', updated_at = now() WHERE ver = $1", v)
        assert await c.fetchval("SELECT app.ecat_content_md5($1)", v) == md                  # 메모·시각은 내용 지문 밖
        await c.execute("DELETE FROM app.ecat_version WHERE ver = $1", v)                     # 초안 삭제 = 내용 CASCADE
        assert await c.fetchval("SELECT count(*) FROM app.ecat_entity WHERE ver = $1", v) == 0
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_apply_ledger_transitions_and_single_running():
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        v = await c.fetchval("INSERT INTO app.ecat_version (title, created_by) VALUES ('초안', $1) RETURNING ver", EDITOR)
        await _raises(c, "INSERT INTO app.ecat_apply (ver, scope_kind, requested_by, reason) VALUES ($1, 'from_round', $2, '사유')",
                      "ecat_apply_from_round", v, EDITOR)
        await _raises(c, "INSERT INTO app.ecat_apply (ver, scope_kind, requested_by, reason) VALUES ($1, 'all', $2, ' ')", "ecat_apply_reason",
                      v, EDITOR)
        await _raises(c, "INSERT INTO app.ecat_apply (scope_kind, requested_by, reason) VALUES ('all', $1, '사유')", "ecat_apply_ver_kind", EDITOR)
        await _raises(c, "INSERT INTO app.ecat_apply (ver, scope_kind, requested_by, reason, status) VALUES ($1, 'all', $2, '사유', 'approved')",
                      "ECAT_APPLY_TRANSITION", v, EDITOR)
        async with _as(c, "api_rw"):
            a1 = await c.fetchval("INSERT INTO app.ecat_apply (ver, from_ver, scope_kind, requested_by, reason) VALUES ($1, NULL, 'unexposed', $2, "
                                  "'시험') RETURNING apply_id", v, EDITOR)
            a2 = await c.fetchval("INSERT INTO app.ecat_apply (ver, scope_kind, from_round_date, requested_by, reason) VALUES ($1, 'from_round', "
                                  "date '2026-09-01', $2, '시험') RETURNING apply_id", v, EDITOR)
        await _raises(c, "UPDATE app.ecat_apply SET status = 'applied', started_at = now(), finished_at = now() WHERE apply_id = $1",
                      "ECAT_APPLY_TRANSITION", a1)
        async with _as(c, "loader"):
            await c.execute("UPDATE app.ecat_apply SET status = 'previewed', affected_answers = 10, preview_set_md5 = decode(md5('x'), 'hex') "
                            "WHERE apply_id = ANY($1::bigint[])", [a1, a2])
        await _raises(c, "UPDATE app.ecat_apply SET status = 'approved' WHERE apply_id = $1", "ecat_apply_approved", a1)   # 승인자 없는 승인
        await _raises(c, "UPDATE app.ecat_apply SET scope_kind = 'all', from_round_date = NULL WHERE apply_id = $1", "ECAT_IMMUTABLE", a2)
        await _raises(c, "UPDATE app.ecat_apply SET reason = '다른 사유' WHERE apply_id = $1", "permission denied", a1, role="loader")
        async with _as(c, "api_rw"):
            await c.execute("UPDATE app.ecat_apply SET status = 'approved', approved_by = $2, approved_at = now() WHERE apply_id = ANY($1::bigint[])",
                            [a1, a2], ACTOR)
        await c.execute("UPDATE app.ecat_apply SET status = 'running', started_at = now() WHERE apply_id = $1", a1)
        with pytest.raises(asyncpg.UniqueViolationError, match="ecat_apply_one_running"):
            async with c.transaction():
                await c.execute("UPDATE app.ecat_apply SET status = 'running', started_at = now() WHERE apply_id = $1", a2)
        await c.execute("UPDATE app.ecat_apply SET load_id = 5, affected_answers = 11 WHERE apply_id = $1", a1)   # 같은 상태 진행 열
        await c.execute("UPDATE app.ecat_apply SET status = 'applied', finished_at = now() WHERE apply_id = $1", a1)
        await _raises(c, "UPDATE app.ecat_apply SET affected_answers = 1 WHERE apply_id = $1", "ECAT_IMMUTABLE", a1)
        await c.execute("UPDATE app.ecat_apply SET status = 'rolled_back', finished_at = now() WHERE apply_id = $1", a1)
        await _raises(c, "UPDATE app.ecat_apply SET error = 'x' WHERE apply_id = $1", "ECAT_APPLY_TRANSITION", a1)
        await _raises(c, "DELETE FROM app.ecat_apply WHERE apply_id = $1", "ECAT_IMMUTABLE", a2)
        await _raises(c, "DELETE FROM app.ecat_apply WHERE apply_id = $1", "permission denied", a2, role="api_rw")
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_judgment_change_kind_hub_match_and_review_grants():
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        await _raises(c, "INSERT INTO app.judgment_change (kind) VALUES ('entity_version')", "judgment_change_entity_version_payload")
        await _raises(c, "INSERT INTO app.judgment_change (kind, payload) VALUES ('entity_version', '{\"apply_id\": 1}')",
                      "judgment_change_entity_version_payload")
        await c.execute("INSERT INTO app.judgment_change (kind, payload) VALUES ('entity_version', '{\"apply_id\": 1, \"op\": \"apply\"}')")
        await _raises(c, "INSERT INTO app.judgment_change (kind) VALUES ('entity_versions')", "judgment_change_kind_check")

        sid = await c.fetchval("INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, created_by) VALUES ($1, 'Kia EV', 'kia ev', $2) "
                               "RETURNING surface_id", KIA, EDITOR)
        job = uuid.uuid4()
        async with _as(c, "loader"):
            await c.execute("SELECT rd.ensure_hub_match_leaf(date '2031-02-17')")
            await c.execute("SELECT rd.ensure_hub_match_leaf(date '2031-02-01')")                  # 두 번째 = 무변화
            await c.execute("INSERT INTO ing.hub_match (surface_id, run_month, job_id, turn_index, entity_id, n_occ, first_start, starts, ends, "
                            "answer_hash, load_id) VALUES ($1, date '2031-02-01', $2, 1, $3, 2, 10, ARRAY[10, 40], ARRAY[16, 47], '\\x00'::bytea, 7)",
                            sid, job, KIA)
            await c.execute("INSERT INTO ing.hub_match_scan (surface_id, scanned_to_load_id, answers_scanned, hits) VALUES ($1, 7, 100, 1)", sid)
            rid = await c.fetchval("INSERT INTO app.ecat_review (kind, entity_id, surface, surface_norm, display_name, first_load_id) "
                                   "VALUES ('new_surface', $1, 'N', 'n', 'Hyundai', 7) RETURNING review_id", HYUNDAI)
            await c.execute("UPDATE app.ecat_review SET n_mentions = n_mentions + 5, last_seen_at = now(), alerted_at = now(), alert_grade = 1 "
                            "WHERE review_id = $1", rid)
        assert await c.fetchval("SELECT count(*) FROM ing.hub_match_203102 WHERE job_id = $1", job) == 1
        for starts, ends in (("ARRAY[10]", "ARRAY[16, 47]"), ("ARRAY[10, 40]", "ARRAY[16]")):     # 원소 수 = n_occ(시작·끝 둘 다)
            await _raises(c, "INSERT INTO ing.hub_match (surface_id, run_month, job_id, turn_index, entity_id, n_occ, first_start, starts, ends, "
                             f"answer_hash, load_id) VALUES ($1, date '2031-02-01', $2, 2, $3, 2, 10, {starts}, {ends}, '\\x00'::bytea, 7)",
                          "hub_match_occ_arrays", sid, job, KIA)
        await _raises(c, "INSERT INTO app.ecat_review (kind, entity_id, surface_norm) VALUES ('new_surface', $1, 'n')", "ecat_review_uniq", HYUNDAI)
        await _raises(c, "INSERT INTO app.ecat_review (kind, entity_id, surface_norm) VALUES ('new_entity', $1, 'n')", "ecat_review_surface", SMART)
        await _raises(c, "UPDATE app.ecat_review SET status = 'resolved' WHERE review_id = $1", "ecat_review_decided", rid)
        await _raises(c, "UPDATE app.ecat_review SET status = 'dismissed', decided_by = $2, decided_at = now() WHERE review_id = $1",
                      "permission denied", rid, EDITOR, role="loader")
        async with _as(c, "api_rw"):
            await c.execute("UPDATE app.ecat_review SET status = 'dismissed', decided_by = $2, decided_at = now() WHERE review_id = $1", rid, EDITOR)
        await _raises(c, "UPDATE app.ecat_review SET n_mentions = 0 WHERE review_id = $1", "permission denied", rid, role="api_rw")
        # 읽기 롤은 새 표를 읽고 쓰지 못한다, api_rw 는 이관·투영 함수를 부르지 못한다
        async with _as(c, "api_ro"):
            assert await c.fetchval("SELECT count(*) FROM app.ecat_review") >= 1
            await c.fetchval("SELECT count(*) FROM app.ecat_registry_active")
        await _raises(c, "INSERT INTO app.ecat_version (title, created_by) VALUES ('x', $1)", "permission denied", EDITOR, role="api_ro")
        await _raises(c, "SELECT app.ecat_cutover_v1($1)", "permission denied", ACTOR, role="api_rw")
        await _raises(c, "SELECT app.ecat_project_legacy()", "permission denied", role="api_rw")
    finally:
        await tr.rollback()
        await c.close()
