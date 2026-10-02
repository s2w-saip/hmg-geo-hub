"""WU-8 현행 프로필 filter_options 와 결과 캐시(로컬 개발 DB).

켜짐 + surface=website 옵션은 app.website_site·app.website_prompt(결과 캐시 추적 표 아님)를 읽는다. 끝점 추가 키 legacy_web(요청마다 두 표
지문을 다시 읽는다)가 키에 실려, 사이트가 새로 등록되면 다음 요청이 미스이고 바이트 = 캐시 끔이다. 꺼짐·다른 표면은 지문을 읽지 않는다(None).
"""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from app.core import result_cache as rc
from app.core.config import get_settings, set_settings
from tests.core.rcache_calls import get
from tests.support import ADMIN, DB_URL, needs_db

URL = "/v1/filters/options"


@pytest.fixture
def legacy_cache(cache_on):
    before = get_settings()
    set_settings(before.model_copy(update={"legacy_profile": "filter_options"}))
    yield
    set_settings(before)


async def _off(client_as, prm: dict) -> bytes:
    s_on = get_settings()
    set_settings(s_on.model_copy(update={"result_cache": False}))
    try:
        r = await get(client_as, ADMIN, URL, prm)
        assert r.status_code == 200, r.text[:200]
        return r.content
    finally:
        set_settings(s_on)


@needs_db
async def test_new_registered_site_turns_hit_into_miss(client_as, legacy_cache):
    c = await asyncpg.connect(DB_URL)
    try:
        await c.fetchval("SELECT app.result_cache_invalidate()")
        prm = {"surface": "website"}
        first = await get(client_as, ADMIN, URL, prm)
        assert first.headers.get(rc.HEADER) == "miss"
        assert (await get(client_as, ADMIN, URL, prm)).headers.get(rc.HEADER) == "hit"
        site = uuid.uuid4()
        await c.execute("INSERT INTO app.website_site (site_id, brand_code, country_code) VALUES ($1, 'Kia', 'FR')", site)
        try:
            after = await get(client_as, ADMIN, URL, prm)
            assert (after.status_code, after.headers.get(rc.HEADER)) == (200, "miss")
            assert "FR" in [x["code"] for x in after.json()["data"]["regions"]]
            assert after.content == await _off(client_as, prm) != first.content
        finally:
            await c.execute("DELETE FROM app.website_site WHERE site_id = $1", site)
        back = await get(client_as, ADMIN, URL, prm)
        assert back.headers.get(rc.HEADER) == "hit" and back.content == first.content     # 원상태 지문 = 처음 항목
    finally:
        await c.close()


@needs_db
async def test_key_is_none_when_off_or_not_website(client_as, cache_on):
    """꺼짐이면 website 요청도 지문을 읽지 않는다(키 추가 요소 None): 사이트를 더해도 적중(웹 옵션이 등록 사이트를 읽지 않는 새 정의)."""
    c = await asyncpg.connect(DB_URL)
    try:
        await c.fetchval("SELECT app.result_cache_invalidate()")
        prm = {"surface": "website"}
        assert (await get(client_as, ADMIN, URL, prm)).headers.get(rc.HEADER) == "miss"
        site = uuid.uuid4()
        await c.execute("INSERT INTO app.website_site (site_id, brand_code, country_code) VALUES ($1, 'Kia', 'FR')", site)
        try:
            assert (await get(client_as, ADMIN, URL, prm)).headers.get(rc.HEADER) == "hit"
        finally:
            await c.execute("DELETE FROM app.website_site WHERE site_id = $1", site)
    finally:
        await c.close()
