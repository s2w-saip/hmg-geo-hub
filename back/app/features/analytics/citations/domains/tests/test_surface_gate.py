"""표면 게이트 회귀(검증 결함 D1): 인용 5엔드포인트는 route-policy 역할 천장 + 계정 menu_groups 좁히기를 데이터 스코프보다 먼저 건다.

재현(010dc5d): VENDOR(role vendor, menu {project}) 가 surface=global 로 /domains·/sources·/domains/{skey} 를 200(관리자와 같은 인용 18건,
job_id 포함)으로 받았다. 게이트 정본 = core.auth.require_surface(core 5라운드 이관, resolve_read_context 첫 줄). 이관 전 기능 임시 게이트와
같은 동작을 요구한다(D-vendor: vendor 는 표준·웹사이트 경로 밖).
"""
from __future__ import annotations

import uuid

import pytest

from app.core.auth import Principal, require_surface
from app.core.errors import ApiError
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, VENDOR, needs_db

PATHS = ("/v1/citations/domains", "/v1/citations/domains/hyundai.com", "/v1/citations/sources", "/v1/citations/sources/types",
         "/v1/citations/sources/tone")


def _params(path: str, surface: str, **extra: str) -> dict[str, str]:
    p = {"surface": surface, **extra}
    if path.endswith("/tone"):
        p["tone"] = "positive"
    return p


async def _get(client_as, uid, path, params):
    async with client_as(uid) as c:
        return await c.get(path, params=params)


@pytest.mark.parametrize("path", PATHS)
@needs_db
async def test_vendor_blocked_on_global_and_website(client_as, path):
    for surface in ("global", "website"):
        r = await _get(client_as, VENDOR, path, _params(path, surface))
        assert r.status_code == 403, (path, surface, r.text)
        assert r.json()["error"]["code"] == "role_forbidden"
        assert "job_id" not in r.text


@pytest.mark.parametrize("path", PATHS)
@needs_db
async def test_menu_narrowing_blocks_website_for_hq(client_as, path):
    """HQ_HYUNDAI(menu {standard, project}): 역할은 website 시청자지만 메뉴 그룹 밖이라 403 menu_forbidden. global 은 그대로 200."""
    r = await _get(client_as, HQ_HYUNDAI, path, _params(path, "website"))
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden", (path, r.text)
    ok = await _get(client_as, HQ_HYUNDAI, path, _params(path, "global"))
    assert ok.status_code == 200, (path, ok.text)


@pytest.mark.parametrize("path", PATHS)
@needs_db
async def test_allowed_surfaces_still_open(client_as, path):
    """게이트가 정상 경로를 막지 않는다: VENDOR 프로젝트(멤버), KIA_EU(menu 무제한) 웹사이트, ADMIN 전부."""
    r = await _get(client_as, VENDOR, path, _params(path, "project", project_id=str(CUST_PROJECT)))
    assert r.status_code == 200, (path, r.text)
    assert (await _get(client_as, KIA_EU, path, _params(path, "website"))).status_code == 200
    for surface in ("global", "website"):
        assert (await _get(client_as, ADMIN, path, _params(path, surface))).status_code == 200


def _p(role: str, menu: tuple[str, ...] | None) -> Principal:
    return Principal(user_id=uuid.uuid4(), email="x@example.test", role=role, operator="none", scope_all=False,  # type: ignore[arg-type]
                     scope_brands=(), scope_regions=(), scope_countries=(), menu_groups=menu, is_qa_reviewer=False)  # type: ignore[arg-type]


@pytest.mark.parametrize(("role", "menu", "surface", "code"), [
    ("vendor", None, "global", "role_forbidden"),            # STANDARD_VIEWERS 에 vendor 없음
    ("vendor", None, "website", "role_forbidden"),           # WEBSITE_VIEWERS 에 vendor 없음
    ("vendor", None, "project", None),                       # PROJECT_VIEWERS 에 vendor 있음
    ("website", None, "global", "role_forbidden"),
    ("website", None, "website", None),
    ("website", None, "project", "role_forbidden"),          # PROJECT_VIEWERS 에 website 없음
    ("hq", ("standard", "project"), "website", "menu_forbidden"),
    ("hq", ("standard", "project"), "global", None),
    ("country", ("website",), "global", "menu_forbidden"),
    ("country", ("website",), "project", "menu_forbidden"),
    ("admin", None, "global", None),
    ("region", None, "project", None),
])
def test_require_surface_table(role, menu, surface, code):
    if code is None:
        require_surface(_p(role, menu), surface)
        return
    with pytest.raises(ApiError) as e:
        require_surface(_p(role, menu), surface)
    assert e.value.status == 403 and e.value.code == code
