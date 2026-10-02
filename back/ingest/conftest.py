"""적재 모듈 테스트 공용 픽스처. 공용 픽스처(settings·client_as 등)는 back/conftest.py.

합성 픽스처(tests/fixtures/fixture-10-data.sql)는 ing IDENTITY 키(run_key·answer_key·cyc_key·acr_cell_key)를 OVERRIDING SYSTEM VALUE 로
넣고 시퀀스를 맞추지 않는다. 적재기는 IDENTITY 로 키를 발급하므로 세션 시작에 시퀀스를 최대값으로 맞춘다(복제본 DB 전용, 멱등).
"""
from __future__ import annotations

import asyncpg
import pytest_asyncio

from tests.support import DB_URL

_SEQ = [("ing.run", "run_key"), ("ing.answer_key_map", "answer_key"), ("ing.cycle", "cyc_key"), ("ing.acr_prompt_run", "acr_cell_key"),
        ("ing.load", "load_id")]


@pytest_asyncio.fixture(scope="session", loop_scope="session", autouse=True)
async def _ing_sequences():
    if not DB_URL:
        return
    c = await asyncpg.connect(DB_URL)
    try:
        for t, col in _SEQ:
            await c.execute(f"SELECT setval(pg_get_serial_sequence('{t}', '{col}'), greatest((SELECT max({col}) FROM {t}), 1000))")
    finally:
        await c.close()


def _db_name(url: str) -> str:
    from urllib.parse import urlsplit
    return urlsplit(url).path.lstrip("/")


def _with_db(url: str, name: str) -> str:
    from urllib.parse import urlsplit, urlunsplit
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, "/" + name, p.query, p.fragment))


@pytest_asyncio.fixture(loop_scope="session")
async def fresh_db():
    """커밋하는 테스트(pull 패스·큐·틱)용 일회 DB: 이 빌더의 복제본을 템플릿으로 만들고 끝나면 지운다(복제본 불변).
    템플릿에 다른 연결이 있으면 CREATE DATABASE 가 실패하므로 테스트는 연결을 닫고 끝낸다."""
    import pytest
    if not DB_URL:
        pytest.skip("HGH_TEST_DB_URL 미설정")
    base = _db_name(DB_URL)
    name = f"{base}_f"
    admin = await asyncpg.connect(_with_db(DB_URL, "postgres"))
    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await admin.execute(f'CREATE DATABASE "{name}" TEMPLATE "{base}"')
    finally:
        await admin.close()
    yield _with_db(DB_URL, name)
    admin = await asyncpg.connect(_with_db(DB_URL, "postgres"))
    try:
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    finally:
        await admin.close()
