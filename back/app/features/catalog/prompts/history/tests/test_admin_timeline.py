"""GET /v1/admin/catalog/prompts/{prompt_id}/history(U8-7, known_diff U8-N21) 통합 테스트.

현행 기준: hmg-geo fetchPromptAuditTimeline 의 admin 자리(/admin/standards/prompts: admin ∧ 메뉴 admin)는 listForPrompt(기간 없음, 최신 100,
스코프 없음)를 읽었다. 표준 메뉴 그룹이 없는 관리자도 관리 카탈로그의 타임라인을 본다. 새 경로는 그 자리만 연다:
- admin ∧ 메뉴 admin 이면 200. 표준 메뉴 그룹 게이트(/v1/prompts/history 의 menu_forbidden)를 걸지 않는다.
- 비 admin 은 전부 403 admin_only(메뉴·스코프와 무관), 메뉴 admin 이 없는 admin 은 403 menu_forbidden, 무인증·정지 401.
- 비 admin 의 /v1/prompts/history 는 지금과 같다(같은 요청의 응답이 이 변경 전후로 같다: test_history.py 가 고정, 여기서는 거절 경로만 재확인).
합성 행은 catalog/tests/seed.py(카탈로그·이력 공유), 기대값은 독립 SQL.
"""
from __future__ import annotations

import uuid

import pytest
import pytest_asyncio

from app.features.catalog.prompts.catalog.tests import seed as S
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, WEBSITE_KIA, Update, needs_db, staged

pytestmark = needs_db
G = S.gid
MENU_ADMIN_ONLY = Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["admin"]})
MENU_STANDARD_ONLY = Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["standard"]})


@pytest_asyncio.fixture(scope="module", loop_scope="session", autouse=True)
async def _seed(seeded):
    await S.seed()


def _url(pid: uuid.UUID | str) -> str:
    return f"/v1/admin/catalog/prompts/{pid}/history"


async def expected(pid: uuid.UUID) -> list[int]:
    """독립 SQL: 루트 원장 · 기간 없음 · 스코프 없음 · created_at DESC, audit_id DESC."""
    rows = await S.q("SELECT audit_id FROM app.prompt_audit_log WHERE project_id = $1 AND prompt_id = $2 "
                     "ORDER BY created_at DESC, audit_id DESC", uuid.UUID(S.ROOT), pid)
    return [r["audit_id"] for r in rows]


def aids(body) -> list[int]:
    return [x["audit_id"] for x in body["data"]["items"]]


async def test_admin_menu_only_reads_timeline(client_as):
    """메뉴 admin 만 가진 관리자: 표준 경로는 403 menu_forbidden(변함없음), 관리 경로는 200. 기간 없음(A1 = 2026-06-01 은 90일 밖),
    하드 삭제 프롬프트(PURGED, app.prompt 행 없음)의 이력도 준다(현행 listForPrompt 와 같다)."""
    exp5, exp_purged = await expected(G(5)), await expected(S.PURGED)
    assert S.A1 in exp5 and exp_purged == [S.A3]
    async with staged(MENU_ADMIN_ONLY, actor=ADMIN), client_as(ADMIN) as c:
        std = await c.get("/v1/prompts/history", params={"prompt_id": str(G(5))})
        r5 = await c.get(_url(G(5)))
        rp = await c.get(_url(S.PURGED))
    assert std.status_code == 403 and std.json()["error"]["code"] == "menu_forbidden", std.text
    assert r5.status_code == 200, r5.text
    b = r5.json()
    assert aids(b) == exp5
    assert (b["meta"]["mode"], b["meta"]["surface"], b["meta"]["page"]["limit"]) == ("audit", "global", 100)
    assert aids(rp.json()) == [S.A3] and rp.json()["data"]["items"][0]["prompt_text"] is None


async def test_same_rows_as_standard_route_for_full_admin(client_as):
    """메뉴 무제한 관리자: 관리 경로 = 표준 경로를 운영 범위 전체 기간으로 부른 결과(행·순서·모양). 어댑터 전환 전후 같은 값."""
    async with client_as(ADMIN) as c:
        for pid in (G(1), G(5), S.PURGED):
            adm = (await c.get(_url(pid))).json()
            std = (await c.get("/v1/prompts/history", params={"prompt_id": str(pid), "from": "2000-01-01", "to": "2100-12-31"})).json()
            assert adm["data"] == std["data"], pid


async def test_keyset_paging_and_validation(client_as):
    exp = await expected(G(5))
    assert len(exp) >= 2
    got, cur = [], None
    async with client_as(ADMIN) as c:
        while True:
            r = await c.get(_url(G(5)), params={"limit": 1, **({"cursor": cur} if cur else {})})
            assert r.status_code == 200, r.text
            got += aids(r.json())
            cur = r.json()["meta"]["page"]["next_cursor"]
            if not cur:
                break
        assert got == exp
        for params in ({"limit": 0}, {"limit": 501}, {"cursor": "garbage"}):
            assert (await c.get(_url(G(5)), params=params)).status_code == 422, params
        assert (await c.get("/v1/admin/catalog/prompts/not-a-uuid/history")).status_code in (404, 422)
        unknown = await c.get(_url(uuid.uuid4()))
    assert unknown.status_code == 200 and unknown.json()["data"]["items"] == []


@pytest.mark.parametrize("uid", [HQ_HYUNDAI, KIA_US, KIA_EU, VENDOR, WEBSITE_KIA, S.WEBSITE_USER])
async def test_non_admin_refused(client_as, uid):
    """비 admin 은 관리 경로에서 403 admin_only. 표준 경로는 지금과 같다(hq·region·country 는 200, vendor·website 는 403 role_forbidden)."""
    async with client_as(uid) as c:
        r = await c.get(_url(G(1)))
        std = await c.get("/v1/prompts/history", params={"prompt_id": str(G(1))})
    assert r.status_code == 403 and r.json()["error"]["code"] == "admin_only", r.text
    if uid in (VENDOR, WEBSITE_KIA, S.WEBSITE_USER):
        assert std.status_code == 403 and std.json()["error"]["code"] == "role_forbidden"
    else:
        assert std.status_code == 200


async def test_admin_without_admin_menu_and_unauthenticated(client_as):
    async with staged(MENU_STANDARD_ONLY, actor=ADMIN), client_as(ADMIN) as c:
        r = await c.get(_url(G(1)))
        std = await c.get("/v1/prompts/history", params={"prompt_id": str(G(1))})
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden", r.text
    assert std.status_code == 200                                    # 표준 메뉴 관리자는 표준 경로 그대로
    for uid in (None, SUSPENDED):
        async with client_as(uid) as c:
            assert (await c.get(_url(G(1)))).status_code == 401
