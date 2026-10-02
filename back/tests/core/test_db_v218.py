"""DB-v2.18(P105 rd.answer.t_own, P106 함수) 패치·채우기 시험. 이 대분류(core)의 복제본은 dbforward 가 v2.18 까지 올리고 fill-v218.sql 로 채운 상태다.
쓰기는 전부 트랜잭션 안에서 하고 되돌린다(복제본 불변).

  1. 합본 = v2.17 + 패치(바이트), 재적용 거부(아무것도 안 바뀜), 열 형·CHECK 이름·함수 소유자·권한
  2. 채우기 파일: 드라이런은 쓰기 없음, commit=1 은 NULL 로 되돌린 행을 다시 채우고(값 = 재계산) 두 번째 실행 0행, CHECK 검증됨
  3. 단언·CHECK 가 어긋남을 잡는다: t_own 을 자식과 다르게 바꾸면 rd.assert_answer_t_own 예외, own_mask 밖 비트·음수는 CHECK 위반
  4. 적재기 단언(ASSERT_OWN)이 t_own 을 본다: 적재가 쓴 답변의 t_own 을 틀리게 바꾸면 위반 행 수 > 0
"""
from __future__ import annotations

import pathlib

import asyncpg
import pytest

from tests.dbforward import run_psql_file
from tests.support import DB_URL, needs_db

pytestmark = needs_db
BACK = pathlib.Path(__file__).resolve().parents[2]
DB = BACK / "db"
FILL = BACK / "migration" / "fill-v218.sql"


def test_merged_ddl_is_v217_plus_patch():
    assert (DB / "DB-v2.18.sql").read_bytes() == (DB / "DB-v2.17.sql").read_bytes() + (DB / "DB-v2.18-patch.sql").read_bytes()
    src = (DB / "DB-v2.18-patch.sql").read_text(encoding="utf-8")
    assert "fill-v218.sql" in src and "lock_timeout" in src and "DB-v2.18 이미 적용됨" in src and "P105" in src and "P106" in src


async def _conn() -> asyncpg.Connection:
    return await asyncpg.connect(DB_URL)


async def test_patch_refuses_reapply_and_structure():
    c = await _conn()
    try:
        with pytest.raises(asyncpg.RaiseError, match="DB-v2.18 이미 적용됨"):
            await c.execute((DB / "DB-v2.18-patch.sql").read_text(encoding="utf-8"))
        await c.execute("ROLLBACK")
        col = await c.fetchrow("SELECT format_type(atttypid, atttypmod) AS t, attnotnull, atthasdef FROM pg_attribute "
                               "WHERE attrelid = 'rd.answer'::regclass AND attname = 't_own' AND NOT attisdropped")
        assert col["t"] == "smallint" and not col["attnotnull"] and not col["atthasdef"]
        cons = {r["conname"] for r in await c.fetch("SELECT conname FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass "
                                                     "AND conname LIKE 'answer_t_own_%'")}
        assert cons == {"answer_t_own_range", "answer_t_own_in_mask"}
        for fn in ("rd.t_own_bits(int2, int2, int2, int2, int2, int2)", "rd.answer_t_own(int4[])", "rd.fill_answer_t_own(int4[])",
                   "rd.assert_answer_t_own(int4[])"):
            assert await c.fetchval(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = '{fn}'::regprocedure") == "hmg_owner"
            assert await c.fetchval(f"SELECT has_function_privilege('loader', '{fn}', 'execute')")
            assert not await c.fetchval(f"SELECT has_function_privilege('api_ro', '{fn}', 'execute')")
        # rd.t_own_bits 는 인라인 가능해야 한다(SET 절 없음 = 적재 집계에서 함수 호출 비용 없음)
        assert await c.fetchval("SELECT proconfig IS NULL AND provolatile = 'i' FROM pg_proc "
                                "WHERE oid = 'rd.t_own_bits(int2, int2, int2, int2, int2, int2)'::regprocedure")
    finally:
        await c.close()


async def test_fill_script_dry_run_commit_and_idempotent():
    c = await _conn()
    try:
        served = await c.fetchval("SELECT count(*) FROM rd.job WHERE served")
        assert served > 0
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE t_own IS NULL") == 0           # dbforward 가 채웠다
        nz = await c.fetchval("SELECT count(*) FROM rd.answer WHERE t_own <> 0")
        assert nz > 0
        before = await c.fetch("SELECT answer_key, t_own FROM rd.answer ORDER BY answer_key")
        try:
            # 일부를 NULL 로(패치 직후·옛 적재기 상태) 커밋해 둔다 → 드라이런은 그대로 두고 commit=1 이 다시 채운다(끝에서 원래 값과 대조)
            await c.execute("UPDATE rd.answer SET t_own = NULL WHERE answer_key IN (SELECT answer_key FROM rd.answer WHERE t_own <> 0 "
                            "ORDER BY answer_key LIMIT 5) OR answer_key IN (SELECT answer_key FROM rd.answer WHERE t_own = 0 ORDER BY answer_key LIMIT 2)")
            res = await run_psql_file(c, FILL, {})
            assert any(r and "target_answers" in r[0] and r[0]["target_answers"] == 7 for r in res), res
            assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE t_own IS NULL") == 7                # 드라이런 = 쓰기 없음
            await run_psql_file(c, FILL, {"commit": "1", "batch": "3"})
            assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE t_own IS NULL") == 0
            res2 = await run_psql_file(c, FILL, {"commit": "1", "recheck": "1", "full_assert": "1"})
            assert any(r and "target_answers" in r[0] for r in res2)
            after = await c.fetch("SELECT answer_key, t_own FROM rd.answer ORDER BY answer_key")
            assert [tuple(r) for r in after] == [tuple(r) for r in before]
            assert await c.fetchval("SELECT bool_and(convalidated) FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass "
                                    "AND conname LIKE 'answer_t_own_%'")
        finally:
            # 복제본 원상(값은 위에서 같음을 봤다. 실패했을 때만 의미가 있다)
            await c.execute("UPDATE rd.answer a SET t_own = x.t_own FROM rd.answer_t_own(NULL) x "
                            "WHERE a.surface = x.surface AND a.round_date = x.round_date AND a.answer_key = x.answer_key "
                            "AND a.t_own IS DISTINCT FROM x.t_own")
    finally:
        await c.close()


async def test_assert_and_checks_catch_drift():
    c = await _conn()
    try:
        k = await c.fetchrow("SELECT answer_key, own_mask, t_own FROM rd.answer WHERE t_own <> 0 AND own_mask & 1 <> 0 ORDER BY answer_key LIMIT 1")
        assert k is not None
        tr = c.transaction()
        await tr.start()
        try:
            # 자식과 다른 값(같은 당사 비트 안의 다른 유형 비트) → 단언 예외
            flip = int(k["t_own"]) ^ 1
            await c.execute("UPDATE rd.answer SET t_own = $2 WHERE answer_key = $1", k["answer_key"], flip)
            with pytest.raises(asyncpg.RaiseError, match="t_own ≠ 재계산"):
                await c.fetchval("SELECT rd.assert_answer_t_own(ARRAY[$1]::int4[])", k["answer_key"])
        finally:
            await tr.rollback()
        for bad in (-1, 1 << 14 if not (int(k["own_mask"]) & 4) else None):
            if bad is None:
                continue
            tr = c.transaction()
            await tr.start()
            try:
                with pytest.raises(asyncpg.CheckViolationError):
                    await c.execute("UPDATE rd.answer SET t_own = $2 WHERE answer_key = $1", k["answer_key"], bad)
            finally:
                await tr.rollback()
        # own_mask 에 없는 당사의 유형 비트
        k2 = await c.fetchrow("SELECT answer_key FROM rd.answer WHERE own_mask & 2 = 0 ORDER BY answer_key LIMIT 1")
        tr = c.transaction()
        await tr.start()
        try:
            with pytest.raises(asyncpg.CheckViolationError, match="answer_t_own_in_mask"):
                await c.execute("UPDATE rd.answer SET t_own = 32 WHERE answer_key = $1", k2["answer_key"])
        finally:
            await tr.rollback()
    finally:
        await c.close()


async def test_loader_assert_own_sees_t_own():
    """적재기 ASSERT_OWN 은 _ig_s 범위 답변의 t_own 을 자식 합과 대조한다(재판정·엔티티 반영 project() 끝 단언)."""
    from ingest.project.apply import queries as q

    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        k = await c.fetchval("SELECT answer_key FROM rd.answer WHERE t_own <> 0 ORDER BY answer_key LIMIT 1")
        await c.execute("CREATE TEMP TABLE _ig_s ON COMMIT DROP AS SELECT $1::int4 AS answer_key", k)
        assert await c.fetchval(q.ASSERT_OWN) == 0
        await c.execute("UPDATE rd.answer SET t_own = 0 WHERE answer_key = $1", k)
        assert await c.fetchval(q.ASSERT_OWN) == 1
    finally:
        await tr.rollback()
        await c.close()
