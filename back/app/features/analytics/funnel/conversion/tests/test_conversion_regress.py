"""GET /v1/funnel/conversion 검증 결함 회귀(D1·D2·D4, 검증 커밋 c063a69).

각 테스트는 필요한 추가 행을 모듈 준비 트랜잭션의 세이브포인트 안에서 넣고(core stage) 끝에 되돌린다(키 905~909, property_id 't-ga4-rg-*').
관리자 기본 창 기대값은 test_conversion.py 머리 주석과 같다: (AI 세션, AI 전환, 비AI 세션, 비AI 전환) = (35, 7, 350, 17).
"""
from __future__ import annotations

import pathlib
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.errors import db_error_info
from app.core.write import savepoint as core_savepoint
from tests.support import ADMIN, KIA_EU, Sql, needs_db, savepoint, stage

URL = "/v1/funnel/conversion"
pytestmark = [needs_db, pytest.mark.usefixtures("ga4_seed")]

# 시드 조각은 rd 쓰기(소유자 실행)라 데이터 파일(.pgsql)로 두고 '-- @이름' 으로 나눠 읽는다(back/tests/README.md 6절).
_SQL: dict[str, str] = {}
for _part in (pathlib.Path(__file__).parent / "regress_ga4.pgsql").read_text(encoding="utf-8").split("-- @")[1:]:
    _name, _, _body = _part.partition("\n")
    _SQL[_name.strip()] = _body.strip()


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _pair(d):
    return (d["summary"]["ai"]["sessions"], d["summary"]["ai"]["conversions"], d["summary"]["human"]["sessions"],
            d["summary"]["human"]["conversions"])


def _markets(d):
    return [(x["brand"], x["country"], x["status"], x["as_of"]) for x in d["coverage"]["markets"]]


class _Stager:
    """시험 하나의 추가 행: core stage() 로 소유자가 넣는다(savepoint 안이라 시험 끝에 되돌린다)."""

    def __init__(self, conn):
        self.conn = conn

    async def execute(self, sql: str, *args) -> None:
        await stage(self.conn, Sql(sql, tuple(args)))


@asynccontextmanager
async def _owner(conn):
    async with savepoint(conn):
        yield _Stager(conn)


# ── D1: website 가상 지역 코드는 GA4 시장을 사이트 브랜드로 좁힌다(조용히 무시하지 않는다) ──
async def test_d1_website_virtual_code_narrows_markets(client_as, ga4_seed):
    async with _owner(ga4_seed) as c:
        await c.execute(_SQL["d1"])            # Hyundai N × KR active: 가상 코드가 걸리면 이 시장만 남아야 한다

        r = await _get(client_as, KIA_EU, surface="website", country="HYUNDAI-N")      # 관점 Kia ∩ N 비트 = 없음
        assert r.status_code == 200, r.text
        body = r.json()
        assert _pair(body["data"]) == (0, 0, 0, 0) and body["data"]["coverage"]["total_markets"] == 0
        assert body["meta"]["suppressed"] == {} and "Kia" not in {x["brand"] for x in body["data"]["coverage"]["markets"]}

        r = await _get(client_as, ADMIN, surface="website", country="HYUNDAI-N")
        body = r.json()
        assert _pair(body["data"]) == (3, 0, 30, 0) and body["meta"]["suppressed"] == {}
        assert _markets(body["data"]) == [("Hyundai N", "KR", "active", "2026-09-11")]

        r = await _get(client_as, ADMIN, surface="website")                              # 가상 코드 없으면 무변화(+ N 시장)
        assert _pair(r.json()["data"]) == (38, 7, 380, 17)
        r = await _get(client_as, KIA_EU, surface="website")
        assert _pair(r.json()["data"]) == (15, 3, 150, 7)


# ── D2: 한 시장에 속성이 여럿이어도 결과는 물리 순서와 무관, project_override 는 global·website 에서 제외 ──
# DB-v2.6 P45 이후 레지스트리(app.ga4_property)는 시장당 1행(ga4_property_market_uq)이라 레지스트리 중복 시드는 DB 가 거부한다
# (test_d2_registry_duplicate_market_rejected). 적재 투영(rd.ga4_dim_property)은 시장 유니크가 없어 중복이 여전히 가능하므로
# 결정성 시험은 투영 쪽 중복(905·906·908)만으로 한다(regress_ga4.pgsql @d2: 레지스트리 INSERT 를 뺐다, 기대값은 그대로).
async def test_d2_registry_duplicate_market_rejected(ga4_seed):
    """같은 (brand_code, country_code) 의 두 번째 레지스트리 행은 23505 ga4_property_market_uq 로 거부된다(이전 d2 시드가 23505 로 실패한 원인)."""
    caught: list[tuple[str | None, str | None]] = []

    async def dup(conn) -> None:                                   # stage() 가 소유자 롤로 부른다
        with pytest.raises(IntegrityError) as ei:
            async with core_savepoint(conn):                       # 실패한 INSERT 만 되돌린다(준비 트랜잭션은 계속 쓸 수 있다)
                await conn.execute(text(_SQL["d2_dup_registry"]))
        caught.append(db_error_info(ei.value))

    async with savepoint(ga4_seed):
        await stage(ga4_seed, dup)
    assert caught == [("23505", "ga4_property_market_uq")]


async def test_d2_duplicate_properties_deterministic(client_as, ga4_seed):
    async with _owner(ga4_seed) as c:
        await c.execute(_SQL["d2"])

        expect_markets = [("Hyundai", "US", "active", "2026-09-11"), ("Kia", "IT", "active", "2026-09-11"),
                          ("Kia", "DE", "pending_grant", None), ("Genesis", "KR", "unmapped", None)]
        seen = []
        for touch in (None, 902, 905, 908, 902):
            if touch is not None:                                         # 값 무변화 UPDATE = 물리 순서만 바뀐다
                await c.execute(_SQL["touch"], touch)
                await c.execute(_SQL["touch_registry"])
            r = await _get(client_as, ADMIN, surface="global")
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            seen.append((_pair(d), _markets(d)))
            for bad in ("1111", "2222", "3333"):                          # 선택되지 않은 속성·프로젝트 속성 값은 어디에도 없다
                assert bad not in r.text
        assert all(x == ((35, 7, 350, 17), expect_markets) for x in seen), seen

        # active 가 없고 pending 이 둘이면 상태는 pending_grant 로 고정(레지스트리 순서 무관)
        await c.execute(_SQL["d2_no_active"])
        try:
            r = await _get(client_as, ADMIN, surface="global")
            d = r.json()["data"]
            assert ("Hyundai", "US", "pending_grant", None) in _markets(d) and _pair(d) == (15, 3, 150, 7)
        finally:
            await c.execute(_SQL["d2_restore"])


# ── D4: 필터가 다 걸러낸 빈 결과는 source_pending 이 아니다 ──
@pytest.mark.parametrize("country", ["HYUNDAI-N", "ZZ"])
async def test_d4_filtered_empty_not_source_pending(client_as, country):
    r = await _get(client_as, ADMIN, surface="global", country=country)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["dropped_filters"] == {"country": [country]}
    assert body["meta"]["suppressed"] == {} and _pair(body["data"]) == (0, 0, 0, 0)
    assert body["data"]["coverage"]["total_markets"] == 0


async def test_d4_in_scope_without_active_is_source_pending(client_as):
    """스코프 안 시장이 있는데 active 가 없으면(필터 무관) 여전히 source_pending."""
    r = await _get(client_as, ADMIN, surface="global", country="DE")               # Kia DE = pending_grant 만
    body = r.json()
    assert body["meta"]["suppressed"] == {"*": "source_pending"}
    assert _markets(body["data"]) == [("Kia", "DE", "pending_grant", None)]
