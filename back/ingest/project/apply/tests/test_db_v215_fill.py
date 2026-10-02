"""DB-v2.15 채우기 SQL(back/migration/fill-v215.sql, 현행 값 재현 되돌림 열) 시험. 배치마다 COMMIT 하므로 일회 DB(fresh_db).

  드라이런은 쓰지 않는다 → commit=1(batch=2)은 배치마다 단언하고 전 서빙 답변·dim_prompt 를 채운다 → 다시 돌리면 0행(멱등) →
  VALIDATE 뒤 rd.answer CHECK 4개가 검증됨 → 웹사이트 답변 region 을 바꾸고 recheck=1 이면 region_geo_key 만 따라간다(geo_key = 사이트 국가 불변)
  → 적재기가 다시 넣은 행(새 열 NULL)은 대상에 다시 잡혀 채워진다.
"""
from __future__ import annotations

import pathlib

import asyncpg

from tests.dbforward import run_psql_file
from tests.support import TEST_NAME_KEY, needs_db

FILL = pathlib.Path(__file__).resolve().parents[4] / "migration" / "fill-v215.sql"


async def _name_rule(c: asyncpg.Connection) -> None:
    """복제본이 현행 프로필 NAME 으로 투영됐으면 채우기도 같은 이름 규칙으로 돈다(운영 절차 = PGOPTIONS='-c hgh.legacy_name=1', 파일 머리 P89 주석).
    P89 rid_n 은 표시 브랜드 키(bare)로 투영 행을 찾으므로 값이 다르면 매핑 불일치 예외로 멈춘다(be/int3-name2)."""
    await c.execute("SELECT set_config('hgh.legacy_name', $1, false)", "1" if TEST_NAME_KEY else "")


CONS = ("answer_cit_ext_bounds", "answer_cit_ext_cat_sum", "answer_cit_ext_pair", "answer_region_geo_same")


@needs_db
async def test_fill_v215_dry_run_batches_idempotent_and_validate(fresh_db):
    c = await asyncpg.connect(fresh_db)
    await _name_rule(c)
    notes: list[str] = []
    c.add_log_listener(lambda _c, m: notes.append(m.message))
    try:
        served = await c.fetchval("SELECT count(*) FROM rd.job WHERE served")
        assert served > 0 and served == await c.fetchval("SELECT count(*) FROM rd.answer")
        # 시드·적재기가 P86(cit_n_all·cit_c1..13, WU-5)·P87(region_geo_key, WU-7 be/incr-parity)을 다 쓰므로 템플릿은 이미 채워져 있다(대상 0)
        assert (await run_psql_file(c, FILL, {}))[1][0]["target_answers"] == 0
        assert await c.fetchval("SELECT rd.assert_answer_v215(NULL)") == served
        # 이 시험은 적재기가 P87 을 쓰기 전에 들어간 행(stg 2026-10-01 재투영 17,488 답변 NULL)을 채우는 경로를 본다: 그 상태로 되돌린다
        await c.execute("UPDATE rd.answer SET region_geo_key = NULL")
        dry = await run_psql_file(c, FILL, {})
        head = dry[1][0]
        assert head["target_answers"] == served and head["already_filled"] == served and head["batches"] == -(-served // 20000)
        assert head["hostless_citations"] == await c.fetchval("SELECT count(*) FROM rd.citation WHERE source_key = 0") > 0
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE region_geo_key IS NOT NULL") == 0         # 드라이런은 쓰지 않는다

        notes.clear()
        await run_psql_file(c, FILL, {"commit": "1", "batch": "2"})
        assert sum(m.startswith("fill-v215 배치") for m in notes) == -(-served // 2)
        assert [m for m in notes if m.startswith("fill-v215 답변 끝")][-1].endswith(f"갱신 {served} 행")
        assert await c.fetchval("SELECT count(*) FROM rd.answer WHERE cit_n_all IS NULL OR region_geo_key IS NULL") == 0
        assert await c.fetchval("SELECT count(*) FROM rd.dim_prompt WHERE cat_mask_all IS NULL") == 0
        assert await c.fetchval("SELECT coalesce(sum(cit_n_all - cit_n), 0) FROM rd.answer") == head["hostless_citations"]
        got = {r[0]: r[1] for r in await c.fetch(
            "SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'rd.answer'::regclass AND conname = ANY($1::text[])", list(CONS))}
        assert got == dict.fromkeys(CONS, True)

        notes.clear()
        await run_psql_file(c, FILL, {"commit": "1", "full_assert": "1"})                                        # 두 번째 = 대상 0
        assert [m for m in notes if m.startswith("fill-v215 답변 끝")][-1] == "fill-v215 답변 끝: 대상 0 답변, 갱신 0 행"
        assert await c.fetchval("SELECT rd.assert_answer_v215(NULL)") == served

        # 웹사이트 답변의 답변 region 이 바뀌면(재측정 시장) region_geo_key 만 따라간다. geo_key(사이트 국가 우선)는 그대로
        w = await c.fetchrow("""
            SELECT a.answer_key, a.geo_key, a.region_geo_key, j.job_id FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
             WHERE a.surface = 2 ORDER BY a.answer_key LIMIT 1""")
        assert w is not None
        other = await c.fetchrow("SELECT geo_key, code FROM rd.dim_country WHERE geo_key NOT IN ($1, $2) AND kind = 'iso' ORDER BY geo_key LIMIT 1",
                                 w["geo_key"], w["region_geo_key"])
        await c.execute("UPDATE ing.answer SET region = $1 WHERE job_id = $2", other["code"], w["job_id"])
        notes.clear()
        await run_psql_file(c, FILL, {"commit": "1", "recheck": "1", "validate": "0"})
        assert [m for m in notes if m.startswith("fill-v215 답변 끝")][-1].endswith("갱신 1 행")
        r = await c.fetchrow("SELECT geo_key, region_geo_key FROM rd.answer WHERE answer_key = $1", w["answer_key"])
        assert (r["geo_key"], r["region_geo_key"]) == (w["geo_key"], other["geo_key"])

        # 적재기 재투영과 같은 상태(새 열 NULL)는 다음 실행이 다시 채운다
        await c.execute("UPDATE rd.answer SET cit_n_all = NULL, " + ", ".join(f"cit_c{k} = NULL" for k in range(1, 14))
                        + ", region_geo_key = NULL WHERE answer_key = $1", w["answer_key"])
        dry = await run_psql_file(c, FILL, {})
        assert dry[1][0]["target_answers"] == 1
        await run_psql_file(c, FILL, {"commit": "1", "validate": "0"})
        assert await c.fetchval("SELECT rd.assert_answer_v215(ARRAY[$1]::int4[])", w["answer_key"]) == 1
    finally:
        await c.close()


P89_COLS = {"rd.answer": ("elig_nc", "std_in_nc", "cit_in_nc"), "rd.answer_brand": ("std_in_nc", "rid_n"), "rd.answer_stance": ("std_in_nc",),
            "rd.citation": ("cit_in_nc",)}
P89_CONS = {"rd.answer": ("answer_nc_pair", "answer_nc_rule"), "rd.answer_brand": ("answer_brand_rid_n",)}


async def _p89_snapshot(c: asyncpg.Connection) -> dict[str, list[tuple]]:
    keys = {"rd.answer": "answer_key", "rd.answer_brand": "answer_key, brand_key, competitive", "rd.answer_stance": "answer_key, turn_index, entity_key",
            "rd.citation": "answer_key, ord"}
    return {t: [tuple(r) for r in await c.fetch(f"SELECT {keys[t]}, {', '.join(cols)} FROM {t} ORDER BY {keys[t]}")] for t, cols in P89_COLS.items()}


@needs_db
async def test_fill_v215_p89_restores_seed_values(fresh_db):
    """§P89(WU-4): 패치 직후 상태(열 NULL)에서 채우기 = 시드가 쓴 값(적재 경로 = 시드 경로, test_equivalence). 배치·멱등·VALIDATE."""
    c = await asyncpg.connect(fresh_db)
    await _name_rule(c)
    notes: list[str] = []
    c.add_log_listener(lambda _c, m: notes.append(m.message))
    try:
        seeded = await _p89_snapshot(c)
        assert all(v is not None for rows in seeded.values() for r in rows for v in r)                       # 시드가 전부 채웠다
        for t, cols in P89_COLS.items():                                                                      # 패치 직후와 같은 상태
            await c.execute(f"UPDATE {t} SET " + ", ".join(f"{x} = NULL" for x in cols))
        served = await c.fetchval("SELECT count(*) FROM rd.job WHERE served")
        notes.clear()
        await run_psql_file(c, FILL, {"commit": "1", "batch": "3"})
        assert [m for m in notes if m.startswith("fill-v215 P89 모수 열 끝")][-1].startswith(f"fill-v215 P89 모수 열 끝: 대상 {served} 답변")
        assert [m for m in notes if m.startswith("fill-v215 P89 rid_n 끝")]
        assert await _p89_snapshot(c) == seeded
        for t, cons in P89_CONS.items():
            got = {r[0]: r[1] for r in await c.fetch("SELECT conname, convalidated FROM pg_constraint WHERE conrelid = $1::regclass "
                                                      "AND conname = ANY($2::text[])", t, list(cons))}
            assert got == dict.fromkeys(cons, True), t
        notes.clear()
        await run_psql_file(c, FILL, {"commit": "1", "validate": "0"})                                        # 두 번째 = 대상 0
        assert [m for m in notes if m.startswith("fill-v215 P89 모수 열 끝")][-1] == "fill-v215 P89 모수 열 끝: 대상 0 답변, 갱신 0 행"
        assert [m for m in notes if m.startswith("fill-v215 P89 rid_n 끝")][-1] == "fill-v215 P89 rid_n 끝: 대상 0 답변, 갱신 0 행"
        # 표시 브랜드 매핑이 투영과 다르면(rid_n 행을 찾지 못함) 조용히 넘어가지 않는다
        ak = await c.fetchval("SELECT answer_key FROM rd.answer_brand ORDER BY answer_key LIMIT 1")
        await c.execute("UPDATE rd.answer_brand SET rid_n = NULL, entity_rows = entity_rows + 1 WHERE answer_key = $1", ak)
        try:
            await run_psql_file(c, FILL, {"commit": "1", "validate": "0"})
            raise AssertionError("매핑 불일치를 못 잡음")
        except asyncpg.RaiseError as e:
            assert "표시 브랜드 매핑이 투영과 다른 행" in str(e)
    finally:
        await c.close()
