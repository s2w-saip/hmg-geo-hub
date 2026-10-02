"""읽기 풀 계획 캐시 규약(범용 계획 전환 방지) 시험.

배경(2026-10-01 stg hmg_r2 실측, 읽기 전용, 같은 연결 10회 반복): 같은 준비문을 한 연결에서 6번째 실행할 때 PostgreSQL 이 plan_cache_mode = auto
면 범용 계획으로 바꾼다. 범용 계획은 회차 키 배열·날짜 범위 바인드를 계획 시점에 몰라 1년 창이 2~5배 느려졌다(대조군: kpi/summary 290 → 705ms,
mentions/brands 385 → 1,965ms, citations/domains 690 → 2,965ms, filters/options 1,500 → 3,125ms. 30일 창은 첫 회부터 2~4배 느림).
API 는 두 겹으로 이를 막고 있었다(같은 실측에서 10회 모두 평평):
  1) 읽기 풀(api_ro·admin_long) 트랜잭션마다 set_config('plan_cache_mode', 'force_custom_plan', true)(core.db.POOL_SPECS)
  2) asyncpg statement_cache_size=0 + 준비문 이름 매번 새로(core.db.asyncpg_url): 같은 준비문을 다시 실행하지 않는다
이 시험은 둘을 단언해, 리팩터링이 한쪽을 빼도 다른 쪽이 남아 있는지·실제 연결에 걸렸는지(SHOW)를 지킨다.
쓰기 풀(api_rw·qa_gate)은 이 규약 밖이다(값은 그대로 두고 단언만: 계획 캐시 설정이 트랜잭션 밖으로 새지 않는다).
"""
from __future__ import annotations

from datetime import date
from urllib.parse import parse_qsl, urlsplit

import pytest
from sqlalchemy import text

from app.core import db as D
from tests.support import needs_db

READ_POOLS = ("api_ro", "admin_long")


def test_read_pool_specs_force_custom_plan():
    for pool in READ_POOLS:
        assert ("plan_cache_mode", "force_custom_plan") in D.POOL_SPECS[pool].extra, pool
    for pool in ("api_rw", "qa_gate"):                      # 쓰기 풀은 손대지 않는다(현 상태 고정)
        assert all(k != "plan_cache_mode" for k, _ in D.POOL_SPECS[pool].extra), pool


def test_driver_never_reuses_prepared_statements():
    url, ca = D.asyncpg_url("postgresql://u:p@h:5432/db")
    assert ca["statement_cache_size"] == 0
    assert dict(parse_qsl(urlsplit(url).query))["prepared_statement_cache_size"] == "0"
    names = {ca["prepared_statement_name_func"]() for _ in range(50)}
    assert len(names) == 50                                  # 준비문 이름이 매번 새로: 같은 준비문의 6번째 실행이 생기지 않는다


@needs_db
@pytest.mark.parametrize("pool", READ_POOLS)
async def test_read_transaction_shows_force_custom_plan(database, pool):
    """실제 연결의 트랜잭션 안 값(current_setting = SHOW)과, 같은 문장을 같은 연결에서 반복해도 남는 준비문이 없음을 단언한다."""
    for _ in range(7):
        async with database.read(pool) as conn:
            assert (await conn.execute(text("SELECT current_setting('plan_cache_mode')"))).scalar() == "force_custom_plan"
            assert (await conn.execute(text("SELECT current_setting('jit')"))).scalar() == "off"
            for _ in range(7):
                await conn.execute(text("SELECT count(*) FROM rd.cycle WHERE round_date >= :d"), {"d": date(2026, 1, 1)})
            # 남은 준비문 = 지금 이 문장 하나뿐(앞의 49번 실행 문장은 남지 않는다)
            left = (await conn.execute(text("SELECT count(*) FROM pg_prepared_statements WHERE statement NOT LIKE '%pg_prepared_statements%'"))).scalar()
            assert left == 0


@needs_db
async def test_force_custom_plan_is_transaction_local(database):
    """set_config(…, true) 라 트랜잭션이 끝나면 풀 연결의 세션 값으로 돌아간다(쓰기 풀 트랜잭션에 새지 않는다)."""
    async with database.read("api_ro") as conn:
        assert (await conn.execute(text("SELECT current_setting('plan_cache_mode')"))).scalar() == "force_custom_plan"
    async with database.engine("api_ro").connect() as raw:
        session_value = (await raw.execute(text("SELECT current_setting('plan_cache_mode')"))).scalar()
        await raw.rollback()
    async with database.write("5eed0000-0000-4000-8000-000000000001", actor_type="system") as conn:
        assert (await conn.execute(text("SELECT current_setting('plan_cache_mode')"))).scalar() == session_value
