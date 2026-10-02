"""검증 D2 후속(BG-43, DB-v2.9 P60·P61 반영): verified_at 과 속성 없는 시장(대기) API 계약.

예전 이 파일(test_d2_blocked_fields)은 DDL 이 없다는 것을 고정했다. core 8라운드가 bg-admin R1·R2 (a) 를 반영해 기대를 뒤집었다.
- verified_at: 현행 '검증일' 열(ga4-registry-client.tsx:151·170, verifyGa4Mapping _actions.ts:56 이 성공 때 now()). verify=true 성공 때만 갱신,
  verify 없는 저장·매핑 변경은 유지(현행 upsertGa4Mapping 은 verified_at 을 건드리지 않았다).
- 대기 시장: 현행은 속성 id 없이 브랜드·국가만 등록(status unmapped)하고 브랜드×국가 유일 인덱스로 같은 시장의 속성 행과 공존하지 못했다.
  → 대기 등록은 그 시장에 속성이 있으면 409 market_taken, 속성 매핑은 같은 트랜잭션에서 대기 행을 지운다(pending_market_cleared).
"""
from __future__ import annotations

import random
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest_asyncio

from app.features.admin.integrations.ga4.adapters import get_ga4_access
from app.features.admin.integrations.ga4.schemas import Ga4Property
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, needs_db, raw_fetch, staged

pytestmark = needs_db

PROPS = "/v1/admin/ga4/properties"
MARKETS = "/v1/admin/ga4/markets"
MK = [("Kia", "ZW"), ("Genesis", "ZM")]            # 합성 픽스처에 GA4 행이 없는 시장

DDL_SQL = """
SELECT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'app' AND table_name = 'ga4_property' AND column_name = 'verified_at') AS has_verified_at,
       to_regclass('app.ga4_market_pending') IS NOT NULL AS has_pending_table,
       (SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'ga4_property' AND column_name = 'property_id') AS pid_nullable
"""


class _Ok:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def check_access(self, property_id: str) -> None:
        self.calls.append(property_id)


@pytest_asyncio.fixture(loop_scope="session")
async def env(seeded):
    from app.main import app

    fake = _Ok()
    app.dependency_overrides[get_ga4_access] = lambda: fake
    c = await asyncpg.connect(DB_URL)
    pids = [str(random.randint(10 ** 11, 10 ** 12 - 1)) for _ in range(2)]

    async def clean() -> None:
        await c.execute("DELETE FROM app.ga4_property WHERE property_id = ANY($1::text[])", pids)
        await c.execute("DELETE FROM app.judgment_change WHERE kind = 'ga4_property' AND subject_texts && $1::text[]", pids)
        for b, cc in MK:
            await c.execute("DELETE FROM app.ga4_market_pending WHERE brand_code = $1 AND country_code = $2", b, cc)

    await clean()
    try:
        yield {"fake": fake, "owner": c, "pids": pids}
    finally:
        app.dependency_overrides.pop(get_ga4_access, None)
        await clean()
        await c.close()


async def _applied(own, pid: str) -> None:
    """적재기 반영을 가정(대기 요청이 있으면 같은 속성 재요청이 409 duplicate_pending)."""
    await own.execute("UPDATE app.judgment_change SET status = 'applied' WHERE kind = 'ga4_property' AND subject_texts = ARRAY[$1]::text[]", pid)


async def test_d2_ddl_arrived():
    """(a) 안: 별도 표 + verified_at 열. property_id PK·NOT NULL 은 그대로(적재기·judgment_change 계약 불변)."""
    async with staged() as conn:
        r = (await raw_fetch(conn, DDL_SQL))[0]
        assert (r["has_verified_at"], r["has_pending_table"], r["pid_nullable"]) == (True, True, "NO"), r
    assert "verified_at" in Ga4Property.model_fields


async def test_verified_at_only_on_verify_success(client_as, env):
    p1 = env["pids"][0]
    own = env["owner"]
    async with client_as(ADMIN) as c:
        r = await c.put(f"{PROPS}/{p1}", json={"brand_code": "Kia", "country_code": "DE"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["property"]["verified_at"] is None and r.json()["data"]["pending_market_cleared"] is False
        await _applied(own, p1)
        t0 = datetime.now(UTC) - timedelta(seconds=5)
        r = await c.put(f"{PROPS}/{p1}", json={"brand_code": "Kia", "country_code": "DE", "verify": True})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["verified"] is True and d["property"]["status"] == "active" and env["fake"].calls == [p1]
        v1 = datetime.fromisoformat(d["property"]["verified_at"])
        assert v1 >= t0
        await _applied(own, p1)
        # verify 없는 저장·매핑 변경은 verified_at 유지(현행과 같음)
        r = await c.put(f"{PROPS}/{p1}", json={"brand_code": "Kia", "country_code": "FR"})
        assert r.status_code == 200, r.text
        assert datetime.fromisoformat(r.json()["data"]["property"]["verified_at"]) == v1
        items = (await c.get(PROPS, params={"brand_code": "Kia", "country_code": "FR"})).json()["data"]["items"]
        assert [(i["property_id"], datetime.fromisoformat(i["verified_at"])) for i in items] == [(p1, v1)]


async def test_pending_market_crud_and_conflicts(client_as, env):
    p2 = env["pids"][1]
    own = env["owner"]
    (b1, c1), (b2, c2) = MK
    async with client_as(ADMIN) as c:
        url = f"{MARKETS}/{b1}/{c1.lower()}"
        assert (await c.get(url)).status_code == 404
        r = await c.put(url, json={"note": "  속성 발급 대기  "})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["created"] is True and d["market"]["country_code"] == c1 and d["market"]["note"] == "속성 발급 대기"
        assert d["market"]["updated_by"] == str(ADMIN)
        r = await c.put(url, json={})
        assert r.status_code == 200 and r.json()["data"]["created"] is False and r.json()["data"]["market"]["note"] is None
        assert (await c.put(f"{MARKETS}/{b2}/{c2}", json={})).status_code == 200
        lst = (await c.get(MARKETS)).json()["data"]["items"]
        assert [(i["brand_code"], i["country_code"]) for i in lst if (i["brand_code"], i["country_code"]) in MK] == [(b2, c2), (b1, c1)]
        assert [i["country_code"] for i in (await c.get(MARKETS, params={"brand_code": b1, "country_code": c1.lower()})).json()["data"]["items"]] == [c1]
        assert (await c.get(f"{MARKETS}/{b1}/{c1}")).json()["data"]["brand_code"] == b1
        # 입력 오류
        r = await c.put(f"{MARKETS}/NoSuchBrand/{c1}", json={})
        assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_brand"
        assert (await c.put(f"{MARKETS}/{b1}/Z1", json={})).status_code == 422
        assert (await c.put(url, json={"property_id": "1"})).status_code == 422                       # extra=forbid
        # 속성을 그 시장에 매핑 → 같은 트랜잭션에서 대기 행 삭제
        r = await c.put(f"{PROPS}/{p2}", json={"brand_code": b1, "country_code": c1})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["pending_market_cleared"] is True
        assert await own.fetchval("SELECT count(*) FROM app.ga4_market_pending WHERE brand_code = $1 AND country_code = $2", b1, c1) == 0
        # 속성이 매핑된 시장에 대기 등록 → 409 market_taken(현행 브랜드×국가 유일)
        r = await c.put(url, json={})
        assert r.status_code == 409 and r.json()["error"]["code"] == "market_taken" and r.json()["error"]["details"] == {"property_id": p2}
        # 삭제
        r = await c.delete(f"{MARKETS}/{b2}/{c2.lower()}")
        assert r.status_code == 200 and r.json()["data"] == {"brand_code": b2, "country_code": c2, "deleted": True}
        assert (await c.delete(f"{MARKETS}/{b2}/{c2}")).status_code == 404


async def test_pending_market_admin_only(client_as, env):
    b, cc = MK[0]
    async with client_as(HQ_HYUNDAI) as c:
        for r in (await c.get(MARKETS), await c.get(f"{MARKETS}/{b}/{cc}"), await c.put(f"{MARKETS}/{b}/{cc}", json={}),
                  await c.delete(f"{MARKETS}/{b}/{cc}")):
            assert r.status_code == 403, r.text
    async with client_as(None) as c:
        assert (await c.get(MARKETS)).status_code == 401
    assert await env["owner"].fetchval("SELECT count(*) FROM app.ga4_market_pending WHERE brand_code = $1 AND country_code = $2", b, cc) == 0
