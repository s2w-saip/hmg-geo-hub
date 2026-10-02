"""core 9 U9-5: 이관 시 경쟁사 별칭 ∪ 같은 이름 tracked_brand 별칭(seed-10-app.sql 4-8b)과 이미 이관된 DB 1회 보정 SQL
(back/migration/fix-u95-competitor-aliases.sql). 두 식이 같은 결과를 내고 재실행에 안전한지 롤백 트랜잭션에서 확인한다."""
from __future__ import annotations

import pathlib
import re

import asyncpg
import pytest

from tests.support import CUST_PROJECT, DB_URL, needs_db

BACK = pathlib.Path(__file__).resolve().parents[2]
SEED = BACK / "migration" / "seed"
FIX = BACK / "migration" / "fix-u95-competitor-aliases.sql"


def seed_step() -> str:
    """seed-10-app.body.sql 의 4-8b UPDATE 한 문장(주석 다음부터 차종 INSERT 전까지)."""
    body = (SEED / "seed-10-app.body.sql").read_text(encoding="utf-8")
    m = re.search(r"-- 4-8b\..*?\n(UPDATE app\.project_tracked_competitor c.*?;)\nINSERT INTO app\.project_tracked_vehicle", body, re.S)
    assert m, "4-8b 단계 없음"
    return m.group(1)


def test_seed_body_is_embedded_and_has_merge_step():
    """seed-10-app.sql 은 gen_seed10.py 가 본문(seed-10-app.body.sql)을 그대로 끼워 만든다: 두 파일이 같은 본문을 가져야 한다."""
    body = (SEED / "seed-10-app.body.sql").read_text(encoding="utf-8")
    assert body in (SEED / "seed-10-app.sql").read_text(encoding="utf-8")
    step = seed_step()
    assert step.startswith("UPDATE app.project_tracked_competitor c") and "cardinality(x.add) > 0" in step
    fix = FIX.read_text(encoding="utf-8")
    code = [ln for ln in fix.splitlines() if ln.strip() and not ln.startswith("--")]
    assert code[0] == "BEGIN;" and code[-1] == "COMMIT;" and fix.count("BEGIN;") == 1 and fix.count("COMMIT;") == 1


CASES = [
    # (brand_name, competitor aliases, tracked_brand aliases | None, 기대 경쟁사 별칭)
    ("U95 Alpha", ["a1", " a2"], ["U95 Alpha", "a2", " b1 ", "A1", "", "b1", None, "c1", "  "], ["a1", " a2", "b1", "A1", "c1"]),
    ("U95 Beta", [], None, []),                                        # 같은 이름 tracked_brand 없음 → 그대로
    ("U95 Gamma", ["g"], ["U95 Gamma", " g "], ["g"]),                 # 덧붙일 것 없음 → 갱신 안 함
    ("U95 Delta", ["x", "x"], ["y", "x", "Y"], ["x", "x", "y", "Y"]),  # 원래 별칭(중복 포함)은 손대지 않는다
]


async def _stage(conn) -> None:
    await conn.execute("SET LOCAL app.actor_id = '5eed0000-0000-4000-8000-000000000001'")
    for name, comp, tb, _ in CASES:
        await conn.execute("INSERT INTO app.project_tracked_competitor (project_id, brand_name, aliases) VALUES ($1, $2, $3)",
                           CUST_PROJECT, name, comp)
        if tb is not None:
            await conn.execute("INSERT INTO app.project_tracked_brand (project_id, canonical_name, aliases) VALUES ($1, $2, $3)",
                               CUST_PROJECT, name, tb)
    await conn.execute("INSERT INTO app.project_tracked_brand (project_id, canonical_name, aliases) VALUES ($1, 'U95 Only Brand', '{z}')",
                       CUST_PROJECT)


async def _aliases(conn) -> dict[str, list[str]]:
    rows = await conn.fetch("SELECT brand_name, aliases FROM app.project_tracked_competitor WHERE project_id = $1 AND brand_name LIKE 'U95 %'",
                            CUST_PROJECT)
    return {r["brand_name"]: list(r["aliases"]) for r in rows}


class _Rollback(Exception):
    pass


@needs_db
async def test_seed_step_merges_union_and_is_rerunnable():
    want = {name: exp for name, _, _, exp in CASES}
    c = await asyncpg.connect(DB_URL)
    try:
        with pytest.raises(_Rollback):
            async with c.transaction():
                await _stage(c)
                assert await c.execute(seed_step()) == "UPDATE 2"                  # Alpha·Delta 만(Beta 짝 없음, Gamma 덧붙일 것 없음)
                assert await _aliases(c) == want
                assert await c.execute(seed_step()) == "UPDATE 0"                  # 재실행 안전
                assert await _aliases(c) == want
                assert await c.fetchval("SELECT count(*) FROM app.project_tracked_competitor WHERE brand_name = 'U95 Only Brand'") == 0
                raise _Rollback
    finally:
        await c.close()


@needs_db
async def test_fix_sql_same_result_counts_and_idempotent():
    """보정 SQL(BEGIN·COMMIT 을 뺀 본문)을 롤백 트랜잭션에서 돌린다: 대상·갱신 행 수 NOTICE, seed 단계와 같은 결과, 두 번째 실행은 0."""
    want = {name: exp for name, _, _, exp in CASES}
    fix = FIX.read_text(encoding="utf-8")
    inner = "\n".join(ln for ln in fix.splitlines() if ln.strip() not in ("BEGIN;", "COMMIT;"))
    notices: list[str] = []
    c = await asyncpg.connect(DB_URL)
    c.add_log_listener(lambda _c, msg: notices.append(msg.message))
    try:
        with pytest.raises(_Rollback):
            async with c.transaction():
                await _stage(c)
                await c.execute(inner)
                assert await _aliases(c) == want
                assert notices[-2:] == ["u95 대상 경쟁사 행 2, 덧붙일 별칭 5", "u95 갱신 행 2, 남은 대상 0"], notices
                async with c.transaction():                                          # 같은 트랜잭션에서 한 번 더(임시 표는 새로)
                    await c.execute("DROP TABLE IF EXISTS _u95")
                    await c.execute(inner)
                assert notices[-2:] == ["u95 대상 경쟁사 행 0, 덧붙일 별칭 0", "u95 갱신 행 0, 남은 대상 0"], notices
                assert await _aliases(c) == want
                raise _Rollback
    finally:
        await c.close()
