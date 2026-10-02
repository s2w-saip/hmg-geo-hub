"""C-3·C-4 테스트 전용: 합성 픽스처 위에 행을 잠깐 더한다(staged.pgsql 조각). core 롤백 전용 준비(tests.support.staged) 위의 얇은 층:
조각을 소유자로 실행하고 요청은 같은 트랜잭션에서 api_ro 로 돈 뒤 ROLLBACK(커밋·치우기 없음).

- rd 쓰기 문장은 기능 모듈 SQL 이 아니라 데이터 파일(.pgsql)에 둔다(back/tests/README.md 6절).
- owner_fetch(독립 기대값 조회)는 준비 블록 안에서는 같은 트랜잭션(준비한 행이 보인다), 밖에서는 새 소유자 접속으로 읽는다.
"""
from __future__ import annotations

import contextlib
import contextvars
import pathlib
from collections.abc import AsyncIterator
from typing import Any

import asyncpg

from tests.support import DB_URL, Sql, raw_fetch
from tests.support import staged as core_staged

SQL: dict[str, str] = {}
for _part in (pathlib.Path(__file__).parent / "staged.pgsql").read_text(encoding="utf-8").split("-- @")[1:]:
    _name, _, _body = _part.partition("\n")
    SQL[_name.strip()] = _body.strip()

_CONN: contextvars.ContextVar[Any] = contextvars.ContextVar("cit_b_staged_conn", default=None)


@contextlib.asynccontextmanager
async def staged(*names: str) -> AsyncIterator[Any]:
    """조각 names(@global·@website·@pub_*)를 차례로 넣은 롤백 전용 트랜잭션. 반환 = 요청과 같은 트랜잭션의 커넥션."""
    async with core_staged(*(Sql(SQL[n]) for n in names)) as conn:
        token = _CONN.set(conn)
        try:
            yield conn
        finally:
            _CONN.reset(token)


async def owner_fetch(sql: str, *args: Any) -> list[dict[str, Any]]:
    """독립 기대값 조회(기능 코드와 다른 경로). 준비 블록 안이면 그 트랜잭션, 밖이면 새 소유자 접속."""
    conn = _CONN.get()
    if conn is not None:
        return await raw_fetch(conn, sql, *args)
    c = await asyncpg.connect(DB_URL)
    try:
        return [dict(r) for r in await c.fetch(sql, *args)]
    finally:
        await c.close()
