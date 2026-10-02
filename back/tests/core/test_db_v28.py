"""DB-v2.8(core 6라운드 5.1 좁은 검증 수정) 확인: N-1 마지막 admin 트리거 발동 조건·재시도 매핑, N-2 P54 중복 사전 단언 순서,
I-1 app.term_norm 소유자, m-2 동시성 행렬(연산 4 × 격리 3 × 흐름 2 = 24) 유지."""
from __future__ import annotations

import asyncio
import contextlib
import pathlib
import re
import uuid

import asyncpg
import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.exc import DBAPIError

from app.core.errors import from_db_error, install_error_handlers
from tests.support import ADMIN, CUST_PROJECT, DB_URL, needs_db

BACK = pathlib.Path(__file__).resolve().parents[2]
EFF = ("SELECT count(*) FROM app.user_account u WHERE u.role = 'admin' AND u.status = 'active' "
       "AND (u.menu_groups IS NULL OR 'admin' = ANY (u.menu_groups))")
ISOS = ("read_committed", "repeatable_read", "serializable")


@contextlib.asynccontextmanager
async def two_admins(only: bool):
    """실효 admin x·y 를 만든다. only=True 면 나머지 실효 admin 을 잠시 정지해 x·y 둘만 남긴다(끝나면 원복·삭제)."""
    x, y = uuid.uuid4(), uuid.uuid4()
    own = await asyncpg.connect(DB_URL)
    others: list[uuid.UUID] = []
    try:
        await own.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
        await own.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, menu_groups) VALUES "
                          "($1, $3, 'admin', 'global', true, NULL), ($2, $4, 'admin', 'global', true, NULL)",
                          x, y, f"t-v28-{x}@example.test", f"t-v28-{y}@example.test")
        if only:
            others = [r[0] for r in await own.fetch(EFF.replace("count(*)", "u.user_id") + " AND u.user_id <> ALL($1::uuid[])", [x, y])]
            await own.execute("UPDATE app.user_account SET status = 'suspended' WHERE user_id = ANY($1::uuid[])", others)
        yield own, x, y
    finally:
        await own.execute("UPDATE app.user_account SET status = 'active' WHERE user_id = ANY($1::uuid[])", others)
        await own.execute("DELETE FROM app.user_account WHERE user_id = ANY($1::uuid[])", [x, y])
        await own.close()


async def _pair(iso: str, probe: str = EFF) -> tuple[list[asyncpg.Connection], list]:
    """probe = 스냅샷을 확정하는 첫 문장(RR·SERIALIZABLE). 기본은 실효 admin 수 읽기(m-2 행렬: 서로의 행을 읽은 상태를 만든다)."""
    conns, txs = [], []
    for _ in range(2):
        c = await asyncpg.connect(DB_URL)
        await c.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
        t = c.transaction(isolation=iso)
        await t.start()
        await c.fetchval(probe)
        conns.append(c)
        txs.append(t)
    return conns, txs


async def _close(conns, txs) -> None:
    for t in txs:
        with contextlib.suppress(Exception):
            await t.rollback()
    for c in conns:
        await c.close()


# ── N-1: 역할 무관 열 편집은 트리거가 발동하지 않는다(교착 없음) ──────────────────
@needs_db
@pytest.mark.parametrize("iso", ISOS)
async def test_concurrent_rename_of_different_admins_both_commit_n1(seeded, iso):
    """서로 다른 admin 의 display_name 만 두 트랜잭션이 동시에 고치면 트리거가 발동하지 않는다: RC(api_rw 격리)·RR 은 둘 다 커밋
    (v2.7 P53 은 40P01 교착 → 500). SERIALIZABLE 은 표가 작아 UPDATE 가 순차 스캔이면 SSI 관계 단위 읽기 잠금으로 한쪽이 40001 일 수
    있다(트리거와 무관한 SSI 의미, v2.6 도 같다): 그때도 교착(40P01)·마지막 admin(23514)은 없어야 한다."""
    async with two_admins(only=False) as (own, x, y):
        conns, txs = await _pair(iso, "SELECT 1")      # 표 전체를 읽지 않는다
        try:
            await conns[0].execute("UPDATE app.user_account SET display_name = 'n1-a' WHERE user_id = $1", x)
            await conns[1].execute("UPDATE app.user_account SET display_name = 'n1-b' WHERE user_id = $1", y)
            res = await asyncio.gather(txs[0].commit(), txs[1].commit(), return_exceptions=True)
            errs = [r for r in res if isinstance(r, BaseException)]
        finally:
            await _close(conns, txs)
        if iso == "serializable":
            assert len(errs) <= 1 and all(getattr(e, "sqlstate", None) == "40001" for e in errs), errs
            if errs:
                return
        assert errs == []
        names = dict(await own.fetch("SELECT user_id, display_name FROM app.user_account WHERE user_id = ANY($1::uuid[])", [x, y]))
        assert names == {x: "n1-a", y: "n1-b"}


@needs_db
async def test_demote_while_other_admin_renamed_read_committed_n1(seeded):
    """RC: 한쪽은 admin A 를 정지(트리거 발동, B 를 FOR SHARE 로 기다림), 다른 쪽은 B 이름만 편집(트리거 없음) → 둘 다 커밋."""
    async with two_admins(only=True) as (own, x, y):
        conns, txs = await _pair("read_committed")
        try:
            await conns[0].execute("UPDATE app.user_account SET status = 'suspended' WHERE user_id = $1", x)
            await conns[1].execute("UPDATE app.user_account SET display_name = 'n1-c' WHERE user_id = $1", y)
            res = await asyncio.gather(txs[0].commit(), txs[1].commit(), return_exceptions=True)
            assert [r for r in res if isinstance(r, BaseException)] == []
        finally:
            await _close(conns, txs)
        assert await own.fetchval(EFF) == 1


# ── m-2 행렬 유지: 실효 admin 2명을 두 트랜잭션이 각각 없애면 한쪽만 성공 ──────────
OPS = {
    "suspend": "UPDATE app.user_account SET status = 'suspended' WHERE user_id = $1",
    "demote": "UPDATE app.user_account SET role = 'hq' WHERE user_id = $1",
    "menu": "UPDATE app.user_account SET menu_groups = '{standard}' WHERE user_id = $1",
    "delete": "DELETE FROM app.user_account WHERE user_id = $1",
}


@needs_db
@pytest.mark.parametrize("op", list(OPS))
@pytest.mark.parametrize("iso", ISOS)
@pytest.mark.parametrize("flow", ["interleaved", "sequential"])
async def test_last_admin_matrix_m2(seeded, op, iso, flow):
    async with two_admins(only=True) as (own, x, y):
        assert await own.fetchval(EFF) == 2
        conns, txs = await _pair(iso)
        errs: list[BaseException] = []
        try:
            if flow == "interleaved":
                await conns[0].execute(OPS[op], x)
                await conns[1].execute(OPS[op], y)
                res = await asyncio.gather(txs[0].commit(), txs[1].commit(), return_exceptions=True)
                errs = [r for r in res if isinstance(r, BaseException)]
            else:
                await conns[0].execute(OPS[op], x)
                await txs[0].commit()
                try:
                    await conns[1].execute(OPS[op], y)
                    await txs[1].commit()
                except asyncpg.PostgresError as e:
                    errs.append(e)
        finally:
            await _close(conns, txs)
        assert len(errs) == 1 and getattr(errs[0], "sqlstate", None) in ("40001", "40P01", "23514"), errs
        assert await own.fetchval(EFF) == 1


# ── N-1: 쓰기 요청의 40001·40P01 → 409 retry_conflict ─────────────────────────────
def _db_err(exc: Exception) -> DBAPIError:
    return DBAPIError("UPDATE app.user_account …", {}, exc)


async def test_retryable_states_map_to_409_on_writes_n1():
    for exc in (asyncpg.exceptions.DeadlockDetectedError("deadlock"), asyncpg.exceptions.SerializationError("serialize")):
        m = from_db_error(_db_err(exc), write=True)
        assert m is not None and (m.status, m.code, m.details) == (409, "retry_conflict", None)
        assert from_db_error(_db_err(exc), write=False) is None               # 읽기 요청은 500 유지(원인 추적)

    app = FastAPI()
    install_error_handlers(app)

    async def boom():
        raise _db_err(asyncpg.exceptions.DeadlockDetectedError("deadlock"))
    app.add_api_route("/x", boom, methods=["GET", "PATCH"])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.patch("/x")                                                # PATCH 는 커밋이 의존성 정리 때라 전역 처리기가 받는다
        assert (r.status_code, r.json()["error"]["code"]) == (409, "retry_conflict")
        assert (await c.get("/x")).status_code == 500


# ── N-2: P54 중복 사전 단언이 정규화 UPDATE 보다 먼저 ─────────────────────────────
def _p54_section() -> str:
    src = (BACK / "db" / "DB-v2.7-patch.sql").read_text(encoding="utf-8")
    m = re.search(r"-- ── P54 ─+\n(.*?)-- ── P55", src, re.S)
    assert m is not None
    return m.group(1)


@needs_db
async def test_p54_duplicate_precheck_reports_count_n2(seeded):
    """v2.6 상태 재현(CHECK 없음): 같은 프로젝트 (dup2,'de')+(dup2,'DE'), US 프로젝트 (dupkw,'us')+(dupkw,NULL) → P54 가 설계 메시지로
    '중복 2건' 을 내고 멈춘다(예전 순서는 첫 정규화 UPDATE 가 유니크 인덱스에 걸려 날것의 23505)."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        try:
            await c.execute("ALTER TABLE app.project_tracked_keyword DROP CONSTRAINT IF EXISTS ptk_country_upper")
            assert await c.fetchval("SELECT country_code FROM app.project WHERE project_id = $1", CUST_PROJECT) == "US"
            await c.execute("INSERT INTO app.project_tracked_keyword (project_id, term, country_code) VALUES "
                            "($1, 'dup2', 'de'), ($1, 'dup2', 'DE'), ($1, 'dupkw', 'us'), ($1, 'dupkw', NULL)", CUST_PROJECT)
            with pytest.raises(asyncpg.UniqueViolationError):                  # 예전 순서(정규화 먼저)는 23505(세이브포인트로 되돌림)
                async with c.transaction():
                    await c.execute("UPDATE app.project_tracked_keyword SET country_code = upper(btrim(country_code)) "
                                    "WHERE country_code IS NOT NULL AND country_code IS DISTINCT FROM upper(btrim(country_code))")
            with pytest.raises(asyncpg.RaiseError) as ei:
                await c.execute(_p54_section())
            assert "추적 키워드 중복 2건" in str(ei.value)
        finally:
            await tr.rollback()
    finally:
        await c.close()


# ── I-1: app.term_norm 소유자 ─────────────────────────────────────────────────────
@needs_db
async def test_term_norm_owned_by_table_owner_i1(seeded):
    c = await asyncpg.connect(DB_URL)
    try:
        r = await c.fetchrow(
            "SELECT pg_get_userbyid(p.proowner) AS fn_owner, pg_get_userbyid(t.relowner) AS tbl_owner, "
            "has_function_privilege(pg_get_userbyid(t.relowner), 'app.term_norm(text)', 'execute') AS owner_exec, "
            "has_function_privilege('api_ro', 'app.term_norm(text)', 'execute') AS ro_exec, "
            "has_function_privilege('public', 'app.term_norm(text)', 'execute') AS public_exec "
            "FROM pg_proc p, pg_class t WHERE p.oid = 'app.term_norm(text)'::regprocedure AND t.oid = 'app.project_tracked_keyword'::regclass")
    finally:
        await c.close()
    assert r["fn_owner"] == r["tbl_owner"] and r["owner_exec"] and r["ro_exec"] and not r["public_exec"]
