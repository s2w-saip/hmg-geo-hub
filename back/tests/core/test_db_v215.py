"""DB-v2.15(현행 값 재현 되돌림 열, 제품 결정 19·23~25) 패치 시험. 이 대분류(core)의 복제본은 dbforward 가 v2.15 까지 올린 상태(채우지 않음)다.
쓰기는 전부 트랜잭션 안에서 하고 되돌린다(복제본 불변). 채우기 SQL(배치·멱등·VALIDATE)은 ingest/project/apply/tests/test_db_v215_fill.py.

  1. 합본 = v2.14 + 패치(바이트), 재적용 거부, 새 열 = NULL 허용·기본값 없음(값은 시드·적재기가 쓴다, 자식 is_rep 만 NOT NULL DEFAULT false),
     rd.answer CHECK 4개 = NOT VALID(검증 스캔 없음)
  2. 채우기 함수 값 = 독립 재계산(함수가 쓰지 않는 경로: ing.answer.answer_key 로 region, rd.citation 직접 GROUP BY 로 인용 수),
     호스트 없는 인용이 cit_n_all 에만 들어간다, Σ cit_c = cit_n, global·project region_geo_key = geo_key
  3. CHECK 가 잡는 것(짝 NULL·cit_n_all < cit_n·합 불일치·global region ≠ geo), 단언 함수가 잡는 것(합을 지킨 카테고리 이동)
  4. rd.dim_prompt: 삭제 행 포함 비트 ⊇ 비삭제, 삭제 행만 있는 프롬프트가 in_root_catalog_all 로 드러난다
  5. 자식 is_rep 은 패치가 채우지 않고(false, 채우기 = fill-v215-rep.sql), 복사 함수는 키 필수·부모 사본만 쓴다. api_ro 는 새 함수를 못 부른다
     (대표 규칙·전파·채우기 SQL 시험은 tests/core/test_cell_rep.py)
"""
from __future__ import annotations

import pathlib

import asyncpg
import pytest

from tests.support import DB_URL, needs_db

BACK = pathlib.Path(__file__).resolve().parents[2]
DB = BACK / "db"
CATS = [f"cit_c{k}" for k in range(1, 14)]
NEW_ANSWER_COLS = ["cit_n_all", *CATS, "region_geo_key"]


def test_merged_ddl_is_v214_plus_patch():
    assert (DB / "DB-v2.15.sql").read_bytes() == (DB / "DB-v2.14.sql").read_bytes() + (DB / "DB-v2.15-patch.sql").read_bytes()
    src = (DB / "DB-v2.15-patch.sql").read_text(encoding="utf-8")
    assert "fill-v215.sql" in src and "result_cache_invalidate" in src and "lock_timeout" in src


async def _conn() -> asyncpg.Connection:
    return await asyncpg.connect(DB_URL)


@needs_db
async def test_patch_refuses_reapply_and_leaves_columns_null():
    c = await _conn()
    try:
        with pytest.raises(asyncpg.RaiseError, match="DB-v2.15 이미 적용됨"):
            await c.execute((DB / "DB-v2.15-patch.sql").read_text(encoding="utf-8"))
        await c.execute("ROLLBACK")
        cols = await c.fetch("""
            SELECT a.attrelid::regclass::text AS rel, a.attname, a.attnotnull, a.atthasdef, format_type(a.atttypid, NULL) AS typ
              FROM pg_attribute a
             WHERE a.attrelid IN ('rd.answer'::regclass, 'rd.answer_brand'::regclass, 'rd.answer_stance'::regclass, 'rd.citation'::regclass,
                                  'rd.dim_prompt'::regclass)
               AND (a.attname = ANY($1::text[]) OR (a.attname = 'is_rep' AND a.attrelid <> 'rd.answer'::regclass)
                    OR a.attname IN ('cat_mask_all', 'in_root_catalog_all')) AND NOT a.attisdropped""", NEW_ANSWER_COLS)
        assert len(cols) == len(NEW_ANSWER_COLS) + 3 + 2
        assert all(not r["attnotnull"] and not r["atthasdef"] for r in cols if r["attname"] != "is_rep")
        reps = [r for r in cols if r["attname"] == "is_rep"]
        assert len(reps) == 3 and all(r["attnotnull"] and r["atthasdef"] and r["typ"] == "boolean" for r in reps)   # DEFAULT false(fast default)
        # P85~P89 는 전부 seed·적재기가 쓴다(dbforward 가 시드 재실행). P87 region_geo_key 도 be/incr-parity(2026-10-01)부터 seed-40·적재기
        # FACT_SRC 가 쓴다(그 전에는 NULL 로 들어가 fill-v215.sql 이 메웠다: stg 재투영 17,488 답변) → 전부 채워져 있고 정본 재계산과 같다
        n = await c.fetchval("SELECT count(*) FROM rd.answer")
        assert n > 0
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE region_geo_key IS NULL") == 0
        assert await c.fetchval("""SELECT count(*) FROM rd.answer a JOIN rd.answer_region_geo(NULL) g
                                     ON g.surface = a.surface AND g.round_date = a.round_date AND g.answer_key = a.answer_key
                                    WHERE a.region_geo_key IS DISTINCT FROM g.region_geo_key""") == 0
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE cit_n_all IS NOT NULL AND cit_c7 IS NOT NULL") == n
        assert await c.fetchval("""SELECT count(*) FROM rd.answer a LEFT JOIN rd.answer_cit_ext(NULL) x
                                     ON x.surface = a.surface AND x.round_date = a.round_date AND x.answer_key = a.answer_key
                                    WHERE (a.cit_n_all, a.cit_c1, a.cit_c13) IS DISTINCT FROM
                                          (coalesce(x.cit_n_all, 0)::int2, coalesce(x.cit_c1, 0)::int2, coalesce(x.cit_c13, 0)::int2)""") == 0
        for t in ("rd.answer_brand", "rd.answer_stance", "rd.citation"):   # 시험 복제본은 dbforward 가 시드 + fill-v215-rep.sql 로 맞췄다
            assert await c.fetchval(f"""SELECT count(*) FROM {t} x JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date
                                          AND a.answer_key = x.answer_key WHERE x.is_rep IS DISTINCT FROM a.is_rep""") == 0, t
        assert await c.fetchval("SELECT count(*) FROM rd.dim_prompt WHERE cat_mask_all IS NULL OR in_root_catalog_all IS NULL") == 0
        cons = {r["conname"]: r["convalidated"] for r in await c.fetch(
            "SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass AND conname ~ '^answer_(cit_ext|region_geo)'")}
        assert cons == {"answer_cit_ext_pair": False, "answer_cit_ext_bounds": False, "answer_cit_ext_cat_sum": False,
                        "answer_region_geo_same": False}
        for fn in ("rd.answer_cit_ext(int4[])", "rd.fill_answer_v215(int4[])", "rd.assert_answer_v215(int4[])", "rd.fill_prompt_catalog_all()",
                   "rd.fill_child_is_rep(int4[])", "rd.answer_region_geo(int4[])", "rd.rep_expected(int4[], bool)",
                   "rd.reselect_rep(int4[], bool)", "rd.assert_rep(int4[], bool)"):
            assert not await c.fetchval("SELECT has_function_privilege('api_ro', $1, 'execute')", fn), fn
            assert await c.fetchval("SELECT has_function_privilege('loader', $1, 'execute')", fn), fn
    finally:
        await c.close()


# 독립 재계산(채우기 함수와 다른 경로): 인용 수 = rd.citation 직접 GROUP BY(카테고리 = rd.dim_source 조인), region = ing.answer.answer_key 열
_ORACLE = """
WITH ct AS (
  SELECT c.surface, c.round_date, c.answer_key, count(*) AS n_all, count(*) FILTER (WHERE c.source_key <> 0) AS n_host,
         array_agg(s.category_key) FILTER (WHERE c.source_key <> 0) AS cats
    FROM rd.citation c LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
   GROUP BY 1, 2, 3)
SELECT a.answer_key, a.surface, a.geo_key, a.cit_n, coalesce(ct.n_all, 0) AS n_all, coalesce(ct.n_host, 0) AS n_host,
       coalesce(ct.cats, '{}') AS cats,
       coalesce((SELECT g.geo_key FROM ing.answer ia JOIN rd.dim_country g ON lower(g.code) = lower(ia.region) WHERE ia.answer_key = a.answer_key), 0)
         AS region_geo
  FROM rd.answer a LEFT JOIN ct ON ct.surface = a.surface AND ct.round_date = a.round_date AND ct.answer_key = a.answer_key
"""


@needs_db
async def test_fill_answer_matches_independent_recount():
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        keys = [r[0] for r in await c.fetch("SELECT answer_key FROM rd.job WHERE served ORDER BY answer_key")]
        assert await c.fetchval("SELECT rd.fill_answer_v215($1::int4[])", keys) == 0                       # 시드가 이미 같은 값을 썼다
        # 채우기 경로 시험: 패치 직후·옛 적재기 상태(15열 NULL)로 되돌린 뒤 채운다(트랜잭션 롤백)
        await c.execute("UPDATE rd.answer SET cit_n_all = NULL, " + ", ".join(f"{x} = NULL" for x in CATS) + ", region_geo_key = NULL")
        assert await c.fetchval("SELECT rd.fill_answer_v215($1::int4[])", keys) == len(keys)
        assert await c.fetchval("SELECT rd.fill_answer_v215($1::int4[])", keys) == 0                       # 멱등
        assert await c.fetchval("SELECT rd.assert_answer_v215(NULL)") == len(keys)
        got = {r["answer_key"]: r for r in await c.fetch(f"SELECT answer_key, cit_n_all, region_geo_key, {', '.join(CATS)} FROM rd.answer")}
        oracle = await c.fetch(_ORACLE)
        assert len(oracle) == len(got) == len(keys)
        hostless = 0
        for o in oracle:
            g = got[o["answer_key"]]
            assert g["cit_n_all"] == o["n_all"] and o["n_host"] == o["cit_n"], o["answer_key"]
            want = [sum(1 for x in o["cats"] if x == k) for k in range(1, 14)]
            assert [g[x] for x in CATS] == want and sum(want) == o["cit_n"], o["answer_key"]
            assert g["region_geo_key"] == o["region_geo"], o["answer_key"]
            if o["surface"] != 2:
                assert g["region_geo_key"] == o["geo_key"], o["answer_key"]
            hostless += o["n_all"] - o["n_host"]
        assert hostless == await c.fetchval("SELECT count(*) FROM rd.citation WHERE source_key = 0")
        assert hostless > 0                                                   # 합성 픽스처에 호스트 없는 인용이 있다(비어 있지 않은 단언)
        for con in ("answer_cit_ext_pair", "answer_cit_ext_bounds", "answer_cit_ext_cat_sum", "answer_region_geo_same"):
            await c.execute(f"ALTER TABLE rd.answer VALIDATE CONSTRAINT {con}")
        with pytest.raises(asyncpg.RaiseError, match="키 배열 필수"):
            await c.fetchval("SELECT rd.fill_answer_v215(NULL)")
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_checks_and_assert_catch_drift():
    c = await _conn()
    try:
        k = await c.fetchval("SELECT answer_key FROM rd.answer WHERE cit_n > 0 AND surface = 1 ORDER BY answer_key LIMIT 1")
        assert k is not None
        cases = [
            ("UPDATE rd.answer SET cit_n_all = cit_n - 1 WHERE answer_key = $1", "answer_cit_ext_bounds"),
            ("UPDATE rd.answer SET cit_c3 = NULL WHERE answer_key = $1", "answer_cit_ext_pair"),
            ("UPDATE rd.answer SET cit_c13 = cit_c13 + 1 WHERE answer_key = $1", "answer_cit_ext_cat_sum"),
            ("UPDATE rd.answer SET cit_c1 = -1, cit_c2 = cit_c2 + cit_c1 + 1 WHERE answer_key = $1", "answer_cit_ext_bounds"),
            ("UPDATE rd.answer SET region_geo_key = geo_key + 1 WHERE answer_key = $1", "answer_region_geo_same"),
        ]
        for stmt, con in cases:
            tr = c.transaction()
            await tr.start()
            try:
                await c.fetchval("SELECT rd.fill_answer_v215($1::int4[])", [k])
                with pytest.raises(asyncpg.CheckViolationError, match=con):
                    await c.execute(stmt, k)
            finally:
                await tr.rollback()
        # 합(= cit_n)을 지킨 채 카테고리를 옮기면 CHECK 는 통과하고 단언이 잡는다
        tr = c.transaction()
        await tr.start()
        try:
            await c.fetchval("SELECT rd.fill_answer_v215($1::int4[])", [k])
            src = await c.fetchval(f"SELECT (ARRAY[{', '.join(CATS)}]) FROM rd.answer WHERE answer_key = $1", k)
            i = next(n for n, v in enumerate(src, 1) if v > 0)
            j = 1 if i != 1 else 2
            await c.execute(f"UPDATE rd.answer SET cit_c{i} = cit_c{i} - 1, cit_c{j} = cit_c{j} + 1 WHERE answer_key = $1", k)
            with pytest.raises(asyncpg.RaiseError, match="재계산"):
                await c.fetchval("SELECT rd.assert_answer_v215($1::int4[])", [k])
        finally:
            await tr.rollback()
        # 채우지 않은 행(NULL)은 단언 대상 밖(WU-5 이전 적재기가 넣은 행과 같다). 시드·새 적재기는 P86 을 쓰고 P87(WU-7)은 아직 NULL 이라
        # 그 행은 fill-v215.sql(대상 = cit_n_all 또는 region_geo_key 가 NULL)이 채운 뒤 단언한다 → 여기서는 15열을 비워 옛 행을 만든다
        tr = c.transaction()
        await tr.start()
        try:
            cols = ", ".join(f"cit_c{x} = NULL" for x in range(1, 14))
            await c.execute(f"UPDATE rd.answer SET cit_n_all = NULL, {cols}, region_geo_key = NULL WHERE answer_key = $1", k)
            assert await c.fetchval("SELECT rd.assert_answer_v215($1::int4[])", [k]) == 0
        finally:
            await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_fill_prompt_catalog_all_includes_soft_deleted():
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        # 루트 카탈로그 행을 하나 소프트 삭제(dim_prompt 재판정은 하지 않는다 = 채우기 시점의 cat_mask 는 그대로)
        pid = await c.fetchval("""
            SELECT p.scope_prompt_id FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
              JOIN rd.dim_prompt d ON d.prompt_id = p.scope_prompt_id
             WHERE p.deleted_at IS NULL AND d.in_root_catalog ORDER BY p.scope_prompt_id LIMIT 1""")
        assert pid is not None
        n = await c.fetchval("SELECT count(*) FROM rd.dim_prompt")
        assert await c.fetchval("SELECT rd.fill_prompt_catalog_all()") == 0                                  # 시드(WU-4)가 이미 같은 값을 썼다
        await c.execute("UPDATE rd.dim_prompt SET cat_mask_all = NULL, in_root_catalog_all = NULL")          # 패치 직후 상태(미채움)
        assert await c.fetchval("SELECT rd.fill_prompt_catalog_all()") == n
        assert await c.fetchval("SELECT rd.fill_prompt_catalog_all()") == 0                                  # 멱등
        rows = await c.fetch("""
            SELECT d.prompt_id, d.cat_mask, d.in_root_catalog, d.cat_mask_all, d.in_root_catalog_all,
                   EXISTS (SELECT 1 FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
                            WHERE p.scope_prompt_id = d.prompt_id AND p.deleted_at IS NOT NULL) AS has_deleted
              FROM rd.dim_prompt d""")
        for r in rows:
            assert r["cat_mask_all"] & r["cat_mask"] == r["cat_mask"] and (r["in_root_catalog_all"] or not r["in_root_catalog"])
            if not r["has_deleted"]:
                assert (r["cat_mask_all"], r["in_root_catalog_all"]) == (r["cat_mask"], r["in_root_catalog"]), r["prompt_id"]
        # 모든 루트 행을 지운 프롬프트: 비삭제 판정(seed-30 식)은 카탈로그 밖, 삭제 포함 판정은 안
        await c.execute("SET LOCAL app.actor_id = '5eed0000-0000-4000-8000-000000000001'")               # app.prompt 감사 트리거(DB-v2.3 P31)
        await c.execute("UPDATE app.prompt SET deleted_at = now() WHERE scope_prompt_id = $1 AND deleted_at IS NULL", pid)
        assert await c.fetchval("SELECT rd.fill_prompt_catalog_all()") == 0                                  # 삭제 포함 값은 그대로
        assert await c.fetchval("SELECT in_root_catalog_all AND cat_mask_all <> 0 FROM rd.dim_prompt WHERE prompt_id = $1", pid)
        with pytest.raises(asyncpg.CheckViolationError, match="dim_prompt_cat_all_pair"):
            await c.execute("UPDATE rd.dim_prompt SET cat_mask_all = NULL WHERE prompt_id = $1", pid)
    finally:
        await tr.rollback()
        await c.close()


@needs_db
async def test_child_is_rep_copy_slot():
    c = await _conn()
    tr = c.transaction()
    await tr.start()
    try:
        k = await c.fetchval("""SELECT a.answer_key FROM rd.answer a
                                 WHERE EXISTS (SELECT 1 FROM rd.citation x WHERE x.surface = a.surface AND x.round_date = a.round_date
                                                AND x.answer_key = a.answer_key)
                                   AND EXISTS (SELECT 1 FROM rd.answer_brand x WHERE x.surface = a.surface AND x.round_date = a.round_date
                                                AND x.answer_key = a.answer_key)
                                   AND a.is_rep
                                 ORDER BY a.answer_key LIMIT 1""")
        assert k is not None
        rep = await c.fetchval("SELECT is_rep FROM rd.answer WHERE answer_key = $1", k)
        for t in ("rd.answer_brand", "rd.citation", "rd.answer_stance"):        # 패치 직후 상태(미채움 = false)로 되돌린 뒤 복사
            await c.execute(f"UPDATE {t} SET is_rep = false WHERE answer_key = $1", k)
        n = await c.fetchval("SELECT rd.fill_child_is_rep($1::int4[])", [k])
        assert n > 0
        for t in ("rd.answer_brand", "rd.citation", "rd.answer_stance"):
            vals = {r[0] for r in await c.fetch(f"SELECT DISTINCT is_rep FROM {t} WHERE answer_key = $1", k)}
            assert vals <= {rep}, t
            assert await c.fetchval(f"""SELECT count(*) FROM {t} x JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date
                                          AND a.answer_key = x.answer_key WHERE x.is_rep IS DISTINCT FROM a.is_rep""") == 0, t
        assert await c.fetchval("SELECT rd.fill_child_is_rep($1::int4[])", [k]) == 0
        with pytest.raises(asyncpg.RaiseError, match="키 배열 필수"):
            await c.fetchval("SELECT rd.fill_child_is_rep(NULL)")
    finally:
        await tr.rollback()
        await c.close()
