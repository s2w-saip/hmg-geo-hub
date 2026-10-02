"""BG-43 GA4 프로젝트 직접 지정(brand·country, 레지스트리 밖 속성 포함) 통합 테스트(롤백 전용 준비, GA4 외부 호출 없음).

준비(전부 롤백):
  레지스트리 속성 P_REG(Kia·DE·active)
  프로젝트 A 'bg43-a'(customer, Kia·DE, P_REG 지정, created 09-01)
  프로젝트 B 'bg43-b'(customer, Hyundai·US, 미등록 속성 P_UNREG 지정, created 09-02)
  프로젝트 C 'bg43-c'(customer, brand 없음·KR, ga4_property_id '' = 지정 없음, created 09-03)
손 계산(created_at DESC): [B(미등록, 상태 null), A(등록, active)]. C 는 빈 문자열이라 빠진다(현행 filter(p => p.ga4PropertyId)).
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, VENDOR, Rows, needs_db, raw_fetch, staged

pytestmark = needs_db

BASE = "/v1/admin/ga4/project-overrides"
PROPS = "/v1/admin/ga4/properties"
P_REG, P_UNREG = "940000000101", "940000000199"
A, B, C = (uuid.UUID(f"b4300000-0000-4000-8000-00000000000{i}") for i in (1, 2, 3))


def _ts(day: int) -> datetime:
    return datetime(2026, 9, day, tzinfo=UTC)


STEPS = (
    Rows("app.ga4_property", [{"property_id": P_REG, "brand_code": "Kia", "country_code": "DE", "status": "active"}]),
    Rows("app.project", [
        {"project_id": A, "kind": "customer", "name": "bg43-a", "brand_code": "Kia", "country_code": "DE",
         "ga4_property_id": P_REG, "created_by": ADMIN, "created_at": _ts(1)},
        {"project_id": B, "kind": "customer", "name": "bg43-b", "brand_code": "Hyundai", "country_code": "US",
         "ga4_property_id": P_UNREG, "created_by": ADMIN, "created_at": _ts(2)},
        {"project_id": C, "kind": "customer", "name": "bg43-c", "brand_code": None, "country_code": "KR",
         "ga4_property_id": "", "created_by": ADMIN, "created_at": _ts(3)},
    ]),
)

# 독립 기대값: 지정이 있는 프로젝트 전부(NULLIF 로 빈 값 제외), 등록 여부는 EXISTS, 정렬은 파이썬에서
EXPECT_SQL = """
SELECT p.project_id, p.name, p.brand_code, p.country_code, p.ga4_property_id AS pid, p.created_at,
       EXISTS (SELECT 1 FROM app.ga4_property g WHERE g.property_id = p.ga4_property_id) AS reg
  FROM app.project p
 WHERE nullif(p.ga4_property_id, '') IS NOT NULL
"""


def _mine(items: list[dict]) -> list[tuple]:
    return [(i["name"], i["brand_code"], i["country_code"], i["property_id"], i["registered"], i["property_status"])
            for i in items if uuid.UUID(i["project_id"]) in (A, B, C)]


async def test_values_and_order(client_as):
    async with staged(*STEPS) as conn, client_as(ADMIN) as c:
        r = await c.get(BASE)
        assert r.status_code == 200, r.text
        items = r.json()["data"]["items"]
        assert _mine(items) == [("bg43-b", "Hyundai", "US", P_UNREG, False, None), ("bg43-a", "Kia", "DE", P_REG, True, "active")]
        exp = sorted(await raw_fetch(conn, EXPECT_SQL), key=lambda x: (x["created_at"], x["project_id"]), reverse=True)
        assert [(uuid.UUID(i["project_id"]), i["property_id"], i["registered"]) for i in items] == \
            [(x["project_id"], x["pid"], x["reg"]) for x in exp]
        a = next(i for i in items if i["name"] == "bg43-a")
        assert a["kind"] == "customer" and a["created_at"].startswith("2026-09-01")
        # 기존 속성 목록의 project_overrides 에도 brand·country(추가 필드)
        r = await c.get(PROPS, params={"brand_code": "Kia", "country_code": "DE"})
        it = next(i for i in r.json()["data"]["items"] if i["property_id"] == P_REG)
        assert it["project_overrides"] == [{"project_id": str(A), "name": "bg43-a", "brand_code": "Kia", "country_code": "DE"}]


async def test_filters_pagination_empty(client_as):
    async with staged(*STEPS), client_as(ADMIN) as c:
        r = await c.get(BASE, params={"registered": "false"})
        assert [i["name"] for i in r.json()["data"]["items"] if i["name"].startswith("bg43")] == ["bg43-b"]
        assert all(i["registered"] is False for i in r.json()["data"]["items"])
        r = await c.get(BASE, params={"registered": "true"})
        assert all(i["registered"] is True for i in r.json()["data"]["items"]) and "bg43-b" not in r.text
        r = await c.get(BASE, params={"property_id": P_REG})
        assert [i["name"] for i in r.json()["data"]["items"]] == ["bg43-a"]
        # 키셋: 1건씩(같은 필터로 커서 이어 받기)
        r1 = await c.get(BASE, params={"property_id": P_UNREG, "limit": 1})
        assert [i["name"] for i in r1.json()["data"]["items"]] == ["bg43-b"] and r1.json()["meta"]["page"]["next_cursor"] is None
        names, cur = [], None
        while True:
            r = await c.get(BASE, params={"limit": 1, **({"cursor": cur} if cur else {})})
            assert r.status_code == 200
            names += [i["name"] for i in r.json()["data"]["items"]]
            cur = r.json()["meta"]["page"]["next_cursor"]
            if not cur:
                break
        assert [n for n in names if n.startswith("bg43")] == ["bg43-b", "bg43-a"]
        # 다른 필터로 커서 재사용 → 422
        r = await c.get(BASE, params={"limit": 1})
        cur = r.json()["meta"]["page"]["next_cursor"]
        assert cur                                                              # 준비 행만 2건이라 다음 페이지가 있다
        assert (await c.get(BASE, params={"limit": 1, "cursor": cur, "registered": "true"})).status_code == 422
        # 빈 결과 + 공통 축 무시 표시
        r = await c.get(BASE, params={"property_id": "999999999999", "brand": "Kia"})
        assert r.status_code == 200 and r.json()["data"]["items"] == [] and r.json()["meta"]["ignored_filters"] == ["brand"]


async def test_scope_and_invalid(client_as):
    async with staged(*STEPS):
        async with client_as(None) as c:
            assert (await c.get(BASE)).status_code == 401
        for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
            async with client_as(uid) as c:
                r = await c.get(BASE)
            assert r.status_code == 403 and "bg43" not in r.text and P_UNREG not in r.text
        async with client_as(ADMIN) as c:
            for params in ({"property_id": "12a"}, {"limit": 0}, {"limit": 501}, {"registered": "maybe"}, {"cursor": "garbage"}):
                assert (await c.get(BASE, params=params)).status_code == 422, params


async def test_admin_menu_gate(client_as):
    """관리 메뉴 없는 admin = 403 menu_forbidden(속성 목록과 같은 게이트)."""
    from tests.support import Sql, Update

    actor = Sql("SELECT set_config('app.actor_id', $1, true)", (str(ADMIN),))
    menu_std = Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["standard"]})
    async with staged(actor, menu_std, *STEPS), client_as(ADMIN) as c:
        r = await c.get(BASE)
        assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden" and "bg43" not in r.text
