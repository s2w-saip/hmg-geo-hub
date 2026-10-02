"""core 전용 픽스처. 공용 픽스처(settings·token·seeded·database·ro·refs·client_as)는 back/conftest.py, 상수는 tests/support.py.

rcache_db  결과 캐시 DB 객체(DB-v2.11 P66~P68)가 있는 테스트 DB. 템플릿이 v2.10(hmg_tpl 을 다시 만들기 전)이면 이 복제본에
           back/db/DB-v2.11-patch.sql 을 1회 적용한다(복제본 전용: 템플릿 DB 이름이면 거부). v2.11 템플릿·CI 는 이미 있어 건너뛴다.
cache_on   이 시험 동안 HGH_RESULT_CACHE=1(설정 교체, 끝나면 원복)과 프로세스 single-flight 표 비움.
db_v212    DB-v2.12(P69 country 역할 권역만 허용·P70 계정 국가 정본 표기 dim_country 우선)가 있는 테스트 DB. 없으면 복제본에만
           back/db/DB-v2.12-patch.sql 을 1회 적용한다(rcache_db 가 v2.11 을 먼저 맞춘다).
"""
from __future__ import annotations

import pathlib

import asyncpg
import pytest
import pytest_asyncio

from app.core.config import get_settings, set_settings
from tests.support import DB_URL

PATCH_V211 = pathlib.Path(__file__).resolve().parents[2] / "db" / "DB-v2.11-patch.sql"
TEMPLATE_NAMES = ("hmg_tpl",)


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def rcache_db(seeded):
    if not DB_URL:
        pytest.skip("HGH_TEST_DB_URL 미설정")
    c = await asyncpg.connect(DB_URL)
    try:
        if await c.fetchval("SELECT to_regnamespace('rcache') IS NULL"):
            db = await c.fetchval("SELECT current_database()")
            if db in TEMPLATE_NAMES:
                raise RuntimeError(f"템플릿 DB({db})에는 패치를 적용하지 않는다: 복제본으로 시험한다(back/tests/README.md)")
            await c.execute(PATCH_V211.read_text(encoding="utf-8"))
    finally:
        await c.close()
    return True


PATCH_V212 = pathlib.Path(__file__).resolve().parents[2] / "db" / "DB-v2.12-patch.sql"


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def db_v212(rcache_db):
    """DB-v2.12(P69 ua_country_scope 권역 허용·P70 계정 국가 정본 표기 dim_country 우선)가 있는 테스트 DB. 템플릿이 v2.10·v2.11 이면 이 복제본에만
    back/db/DB-v2.12-patch.sql 을 1회 적용한다(rcache_db 가 v2.11 을 먼저 맞춘다. 템플릿 DB 이름이면 거부)."""
    c = await asyncpg.connect(DB_URL)
    try:
        d = await c.fetchval("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'app.user_account'::regclass "
                             "AND conname = 'ua_country_scope'")
        if "scope_regions" not in (d or ""):
            db = await c.fetchval("SELECT current_database()")
            if db in TEMPLATE_NAMES:
                raise RuntimeError(f"템플릿 DB({db})에는 패치를 적용하지 않는다: 복제본으로 시험한다(back/tests/README.md)")
            await c.execute(PATCH_V212.read_text(encoding="utf-8"))
    finally:
        await c.close()
    return True


@pytest.fixture
def cache_on(settings, rcache_db):
    from app.core import result_cache as rc

    before = get_settings()
    set_settings(before.model_copy(update={"result_cache": True}))
    rc._inflight.clear()
    yield
    rc._inflight.clear()
    set_settings(before)
