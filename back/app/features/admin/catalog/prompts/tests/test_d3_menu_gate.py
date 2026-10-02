"""검증 D3 회귀: 관리 카탈로그(AD-1 prompts·bulk·reference) 라우터의 메뉴 그룹 게이트(롤백 전용 준비, 외부 호출 없음).

재현(수정 전): ADMIN 의 menu_groups 를 '{standard}' 로 바꾸면 GA4·인용 오버라이드는 403 menu_forbidden 인데
/v1/admin/catalog/prompts 는 200(outbox_error 포함). 현행 route-policy 는 /admin/standards/prompts 를 group admin 으로 막는다.
수정 뒤: 카탈로그 읽기·쓰기·일괄·참조 경로 전부 403 menu_forbidden, 본문에 데이터가 없다. 쓰기는 일어나지 않는다.
"""
from __future__ import annotations

import uuid

from tests.support import ADMIN, Sql, Update, needs_db, raw_fetch, staged

pytestmark = needs_db

BASE = "/v1/admin/catalog/prompts"
ACTOR = Sql("SELECT set_config('app.actor_id', $1, true)", (str(ADMIN),))   # 계정 쓰기 = 감사 트리거 행위자 필수
MENU_STD = Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["standard"]})
ROOT_ONE = "SELECT prompt_id FROM app.prompt WHERE project_id = 'c0000000-0000-4000-8000-000000000001' AND deleted_at IS NULL LIMIT 1"


async def test_d3_catalog_menu_gate(client_as):
    async with staged(ACTOR, MENU_STD) as conn, client_as(ADMIN) as c:
        pid = (await raw_fetch(conn, ROOT_ONE))[0]["prompt_id"]
        text = f"d3-{uuid.uuid4().hex[:8]}"
        calls = [
            ("GET", BASE, None), ("GET", f"{BASE}/{pid}", None), ("GET", f"{BASE}/export", None),
            ("GET", "/v1/admin/catalog/markets", None), ("GET", "/v1/admin/catalog/taxonomy", None),
            ("POST", BASE, {"text": text}), ("PATCH", f"{BASE}/{pid}/kind", {"kind": "acr", "dry_run": True}),
            ("POST", f"{BASE}/bulk/regions", {"prompt_ids": [str(pid)], "regions": ["KR"]}),
        ]
        for method, url, body in calls:
            r = await c.request(method, url, json=body)
            assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden", (method, url, r.text)
            assert str(pid) not in r.text and "outbox" not in r.text
        assert await raw_fetch(conn, "SELECT 1 FROM app.prompt WHERE text = $1", text) == []


async def test_d3_admin_with_admin_menu_passes(client_as):
    """좁히기만: admin 메뉴를 가진 admin(menu_groups {admin}) 은 그대로 200."""
    menu_admin = Update("app.user_account", {"user_id": ADMIN}, {"menu_groups": ["admin"]})
    async with staged(ACTOR, menu_admin), client_as(ADMIN) as c:
        for url in (BASE, "/v1/admin/catalog/markets", "/v1/admin/catalog/taxonomy"):
            r = await c.get(url)
            assert r.status_code == 200, (url, r.text)
