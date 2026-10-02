"""KPI 회귀 테스트용 준비 픽스처. 문장은 같은 폴더 rounds.pgsql("-- name: x" 블록)에 두고 core 롤백 전용 준비(tests.support.staged)로
실행한다: 소유자로 행을 더하고, 요청은 같은 트랜잭션에서 api_ro 로 돈 뒤 ROLLBACK(복제본 무변경, 치우기 문장 없음).

픽스처
  seeded_rounds  글로벌 추가 회차 40~44(closed 비서빙 누락·언급 숨김·발행)
  web_unhidden   웹사이트 회차 21 의 인용 숨김을 푼다(R09 발행값 접기 경로)
"""
from __future__ import annotations

import pathlib

import pytest_asyncio

from tests.support import Sql, load_named_sql, staged

BLOCKS = load_named_sql(pathlib.Path(__file__).with_name("rounds.pgsql"))


@pytest_asyncio.fixture(loop_scope="session")
async def seeded_rounds(database):
    async with staged(Sql(BLOCKS["seed_global"])) as conn:
        yield conn


@pytest_asyncio.fixture(loop_scope="session")
async def web_unhidden(database):
    async with staged(Sql(BLOCKS["web_unhide"])) as conn:
        yield conn
