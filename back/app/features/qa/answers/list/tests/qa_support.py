"""qa 기능 테스트 공용 도우미(qa 7개 기능 tests/ 가 함께 쓴다).

- 검수 게이트(Q17)는 계정이 아니라 HMAC 세션 쿠키다: new_session(이름) 으로 app.qa_review_session 행을 만들고 qa_client 로 쿠키를 싣는다.
- 기대값은 소유자(postgres) 접속의 독립 SQL(db_val·db_rows) 또는 손계산으로 낸다(구현 SQL 을 복사하지 않는다).
- qa_clean(각 tests/conftest.py 가 등록): 매 테스트 전후 app.qa_* 4표 비움, 설정(서버 검수 범위·신뢰 프록시 홉)·입장 시도 상한 초기화.
- 서버 검수 범위는 core.config(qa_surfaces·qa_since)다: use_qa_scope 로 설정 사본을 교체하고 qa_clean 이 세션 설정으로 되돌린다.
- qa_gate 참조 표 권한(DB-v2.6 P47, qa R1)은 템플릿 DB 에 이미 있다: 테스트가 GRANT·REVOKE 하지 않는다(REVOKE 는 P47 을 지운다).
"""
from __future__ import annotations

import contextlib
import time
import uuid
from collections.abc import AsyncIterator
from datetime import date
from typing import Any

import asyncpg
import pytest_asyncio

from app.core.auth import QA_COOKIE, QaReviewer, sign_qa_cookie
from app.core.config import get_settings, set_settings
from tests.support import DB_URL

QA_TABLES = ("app.qa_answer_lock", "app.qa_review_note", "app.qa_answer_review", "app.qa_review_session")


async def db_rows(sql: str, *args: Any) -> list[asyncpg.Record]:
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetch(sql, *args)
    finally:
        await c.close()


async def db_val(sql: str, *args: Any) -> Any:
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetchval(sql, *args)
    finally:
        await c.close()


async def db_exec(sql: str, *args: Any) -> None:
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute(sql, *args)
    finally:
        await c.close()


async def new_session(name: str) -> QaReviewer:
    sid = await db_val("INSERT INTO app.qa_review_session (reviewer_name) VALUES ($1) RETURNING session_id", name)
    return QaReviewer(str(sid), name, time.time())


async def job_id_of(answer_key: int) -> uuid.UUID:
    return await db_val("SELECT job_id FROM rd.job WHERE answer_key = $1", answer_key)


@contextlib.asynccontextmanager
async def qa_client(client_as: Any, reviewer: QaReviewer | None, *, bearer: uuid.UUID | None = None) -> AsyncIterator[Any]:
    """reviewer 가 있으면 검수 쿠키를 싣는다. bearer 는 일반 계정 JWT(QA 경로를 열지 못해야 한다)."""
    async with client_as(bearer) as c:
        if reviewer is not None:
            c.cookies.set(QA_COOKIE, sign_qa_cookie(reviewer))
        yield c


async def _wipe() -> None:
    c = await asyncpg.connect(DB_URL)
    try:
        for t in QA_TABLES:
            await c.execute(f"DELETE FROM {t}")
    finally:
        await c.close()


def use_qa_scope(*, surfaces: tuple[str, ...] = ("global", "website", "project"), since: date | None = None) -> None:
    """서버 검수 범위만 바꾼 설정 사본으로 교체(core.config qa_surfaces·qa_since, qa R3). 인자 없이 부르면 기본 범위."""
    set_settings(get_settings().model_copy(update={"qa_surfaces": surfaces, "qa_since": since}))


@pytest_asyncio.fixture(loop_scope="session")
async def qa_clean(database, settings):
    from app.features.qa.review.sessions.service import limiter

    await _wipe()
    set_settings(settings)
    limiter.reset()
    yield
    set_settings(settings)
    limiter.reset()
    await _wipe()
