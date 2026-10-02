"""DB-v2.15 P85 셀 대표 채우기 SQL(back/migration/fill-v215-rep.sql, WU-2) 시험. 배치마다 COMMIT 하므로 일회 DB(fresh_db).

  드라이런은 쓰지 않는다(패치 직후 자식 is_rep = false 라 대표 행 수만큼 불일치) → commit=1(cycles=1)은 회차마다 커밋·단언하고 자식 사본을
  채운다 → 다시 돌리면 0행(멱등) → 경계 셀(셀 최신이 elig 아님)을 만들고 latest_first=1 이면 그 셀 부모 1행만 바뀌고 자식이 따라간다.
"""
from __future__ import annotations

import pathlib

import asyncpg

from app.core.profile import OFF
from ingest.testkit import bulk_seed
from tests.dbforward import run_psql_file
from tests.support import load_named_sql, needs_db

BACK = pathlib.Path(__file__).resolve().parents[4]
FILL = BACK / "migration" / "fill-v215-rep.sql"
PREP = load_named_sql(BACK / "tests" / "core" / "cell_rep.pgsql")


@needs_db
async def test_fill_v215_rep_dry_run_batches_idempotent(fresh_db):
    c = await asyncpg.connect(fresh_db)
    notes: list[str] = []
    c.add_log_listener(lambda _c, m: notes.append(m.message))
    try:
        # 이 시험은 hub 규칙으로 투영된 상태(stg 패치 직후)에서 시작한다: 세션 시험 프로필(HGH_TEST_LEGACY_PROFILE)이 투영 스위치를 켰으면
        # 복제본 rd 가 그 규칙이라 hub 규칙 드라이런이 차이를 센다 → 일회 DB 를 끔 프로필 bulk 로 되돌린다(끔 세션이면 같은 값, 멱등)
        b = await asyncpg.connect(fresh_db)          # 별도 연결(시드의 세션 SET client_min_messages 등이 이 시험의 NOTICE 수집을 막지 않게)
        try:
            async with b.transaction():
                await bulk_seed(b, profile=OFF)
        finally:
            await b.close()
        cycles = await c.fetchval("""SELECT count(*) FROM rd.cycle cy WHERE EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = cy.surface
                                      AND a.round_date = cy.round_date AND a.cyc_key = cy.cyc_key)""")
        await c.execute(PREP["reset_children"])                              # 패치 직후 상태(dbforward 는 복제본을 이미 채웠다)
        reps_ab = await c.fetchval("""SELECT count(*) FROM rd.answer_brand x JOIN rd.answer a ON a.surface = x.surface AND a.round_date = x.round_date
                                        AND a.answer_key = x.answer_key WHERE a.is_rep""")
        dry = await run_psql_file(c, FILL, {})
        head = dry[1][0]
        assert head["target_cycles"] == cycles > 1 and head["parent_rule_differs"] == 0 and head["brand_differs"] == reps_ab > 0
        assert await c.fetchval("SELECT count(*) FILTER (WHERE is_rep) FROM rd.answer_brand") == 0          # 드라이런은 쓰지 않는다

        notes.clear()
        await run_psql_file(c, FILL, {"commit": "1", "cycles": "1"})
        assert sum(m.startswith("fill-v215-rep 배치") for m in notes) == cycles
        assert await c.fetchval("SELECT rd.assert_rep(NULL, false)") == await c.fetchval("SELECT count(*) FROM rd.answer")

        notes.clear()
        await run_psql_file(c, FILL, {"commit": "1", "full_assert": "1"})
        assert [m for m in notes if m.startswith("fill-v215-rep 끝")][-1] == f"fill-v215-rep 끝: 회차 {cycles}, 부모 갱신 0, 자식 갱신 0"

        # 현행 규칙으로 재투영: 경계 셀(셀 최신이 elig 아님)의 부모가 바뀌고 그 자식도 따라간다. 현행 게이트는 카탈로그 무관 elig_nc 라
        # (DB-v2.15 P89, WU-4) 카탈로그 밖 프롬프트 셀(픽스처 k6: elig 거짓·elig_nc 참)에도 대표가 생긴다(조회는 scope_where 카탈로그 게이트가 거른다)
        moved = await c.fetch(PREP["boundary_latest_non_elig"])
        assert len(moved) == 1
        await c.fetchval(PREP["propagate_all"])
        cat_only = await c.fetchval("""SELECT count(*) FROM rd.rep_expected(NULL, true) e JOIN rd.answer a ON a.surface = e.surface
                                          AND a.round_date = e.round_date AND a.answer_key = e.answer_key WHERE e.rep AND NOT a.elig""")
        assert cat_only >= 1
        dry = await run_psql_file(c, FILL, {"latest_first": "1"})
        assert dry[1][0]["parent_rule_differs"] == 1 + cat_only
        notes.clear()
        await run_psql_file(c, FILL, {"commit": "1", "latest_first": "1", "full_assert": "1"})
        end = [m for m in notes if m.startswith("fill-v215-rep 끝")][-1]
        assert f", 부모 갱신 {1 + cat_only}, " in end
        assert await c.fetchval("SELECT rd.assert_rep(NULL, true)") > 0
    finally:
        await c.close()
