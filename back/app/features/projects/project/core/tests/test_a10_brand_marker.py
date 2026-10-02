"""A-10(결정 13, 2026-09-30): 이관 R1 전 브랜드 목록 계정의 프로젝트 생성 선택지는 현행 빈 brands 분기(권역 정본 브랜드)와 같고,
조회 가시성(DataScope·웹사이트 사이트·프로젝트 스코프)은 바뀌지 않는다.

- 현행 기준: hmg-geo front lib/auth/scope-policy.ts projectCreationOptions(:286-320). brands 가 비면 GEO_BRANDS(Hyundai·Genesis·Kia),
  목록이면 그 목록 그대로. 이관 R1(account-migration.md §5)이 빈 brands 계정을 app.brand 전 코드 목록으로 옮겨 생성 선택지에 Hyundai N 이
  더해지던 것을 막는다. 표식 = app.brand 전 코드(엄브렐러 포함)를 담은 목록(brand_scope_covers_all).
- 단위 부분은 DB 없이 parse_refs 참조로, 통합 부분(needs_db)은 픽스처 계정 GLOBAL_KIA 를 staged 로 전 코드 목록으로 바꿔 확인한다.
"""
from __future__ import annotations

import uuid
from dataclasses import replace

import pytest

from app.core.auth import DataScope, Principal
from app.core.codes import Refs, parse_refs
from app.features.projects.project.core.service import brand_scope_covers_all, creation_options, website_site_visible
from app.features.projects.project.core.tests.helpers import GLOBAL_KIA, ensure_extra_accounts
from tests.support import ADMIN, SYSTEM, Update, needs_db, raw_fetch, staged

# 이관 R1 이 채우는 값: app.brand 전 코드 sort_order 순(account-migration.md §3)
FULL = ("Hyundai", "Kia", "Genesis", "HMG", "Hyundai N")
REAL4 = ("Hyundai", "Kia", "Genesis", "Hyundai N")        # 엄브렐러만 빠진 목록(표식 아님)


def _refs() -> Refs:
    return parse_refs({
        "brands": [{"code": "Hyundai", "bit": 1, "umb": False, "parent": None, "ord": 1},
                   {"code": "Kia", "bit": 2, "umb": False, "parent": None, "ord": 2},
                   {"code": "Genesis", "bit": 4, "umb": False, "parent": None, "ord": 3},
                   {"code": "HMG", "bit": 8, "umb": True, "parent": None, "ord": 4},
                   {"code": "Hyundai N", "bit": 16, "umb": False, "parent": "Hyundai", "ord": 5}],
        "owned": [], "engines": [{"k": 1, "code": "chatgpt", "d": True}],
        "countries": [{"k": 1, "code": "US", "kind": "iso", "r": None, "vb": None, "h": False},
                      {"k": 2, "code": "DE", "kind": "iso", "r": None, "vb": None, "h": False},
                      {"k": 3, "code": "FR", "kind": "iso", "r": None, "vb": None, "h": False},
                      {"k": 4, "code": "KR", "kind": "iso", "r": None, "vb": None, "h": False},
                      {"k": 5, "code": "HYUNDAI-N", "kind": "virtual_brand", "r": None, "vb": 16, "h": False}],
        "langs": [{"k": 1, "code": "EN"}],
        "rhq": [{"id": "hyundai-europe", "brand": "Hyundai", "cc": ["DE", "FR"]},
                {"id": "hyundai-north-america", "brand": "Hyundai", "cc": ["US"]},
                {"id": "kia-western-europe", "brand": "Kia", "cc": ["DE", "FR"]},
                {"id": "genesis-europe", "brand": "Genesis", "cc": ["DE"]}],
        "cats": [], "projects": []})


def _p(role: str, brands: tuple[str, ...], *, regions: tuple[str, ...] = (), countries: tuple[str, ...] = (),
       operator: str = "global", scope_all: bool = False) -> Principal:
    return Principal(user_id=uuid.uuid4(), email="t@example.test", role=role, operator=operator,  # type: ignore[arg-type]
                     scope_all=scope_all, scope_brands=brands, scope_regions=regions, scope_countries=countries,
                     menu_groups=None, is_qa_reviewer=False)


# 이관 R1 대상 역할(hq·region; country 는 국가·권역이 없어 보류됐지만 규칙은 같다) × 계정 권역·국가 모양
R1_SHAPES = [
    pytest.param("hq", (), (), id="hq"),
    pytest.param("region", ("hyundai-europe", "kia-western-europe", "genesis-europe"), (), id="region-eu"),
    pytest.param("country", (), ("DE",), id="country-de"),
]


@pytest.mark.parametrize("role,regions,countries", R1_SHAPES)
def test_full_list_creation_equals_legacy_unrestricted(role, regions, countries):
    """전 코드 목록 = 현행 빈 brands: 생성 브랜드 = 권역 정본 브랜드(app.brand sort_order 순), Hyundai N·HMG 없음.
    국가는 명시 3브랜드 목록과 같다(Hyundai N·HMG 는 권역이 없어 국가를 더하지 않는다)."""
    refs = _refs()
    p = _p(role, FULL, regions=regions, countries=countries)
    assert brand_scope_covers_all(p, refs)
    brands, cc = creation_options(p, refs)
    assert brands == ["Hyundai", "Kia", "Genesis"] and "Hyundai N" not in brands
    assert cc == creation_options(replace(p, scope_brands=("Hyundai", "Kia", "Genesis")), refs)[1]
    assert set(brands) <= set(FULL)                                   # 넓히지 않는다: 계정 목록의 부분집합


@pytest.mark.parametrize("role,regions,countries", R1_SHAPES)
def test_full_list_visibility_unchanged(role, regions, countries):
    """조회 가시성은 표식을 쓰지 않는다: DataScope 는 엄브렐러만 빠진 4브랜드 목록(표식 아님)과 같은 값이고,
    Hyundai N 웹사이트 사이트·브랜드 Hyundai N 프로젝트 스코프도 그대로 열린다(목록에서 Hyundai N 을 빼는 방식이면 여기서 닫힌다)."""
    refs = _refs()
    p = _p(role, FULL, regions=regions, countries=countries)
    ds = DataScope.of(p, refs)
    assert ds.brands == REAL4
    assert ds == DataScope.of(replace(p, scope_brands=REAL4), refs)
    assert ds.brand_allowed("Hyundai N") and ds.brand_allowed("Kia") and ds.brand_allowed(None)
    assert ds.project_in_scope(refs, "Hyundai N", None) and ds.project_in_scope(refs, None, None)
    site_country = countries[0] if countries else ("DE" if regions else "US")
    assert website_site_visible(p, refs, "Hyundai N", site_country)
    assert website_site_visible(p, refs, "Hyundai", site_country)


@pytest.mark.parametrize("brands,expected", [
    pytest.param(("Hyundai N",), ["Hyundai N"], id="explicit-hyundai-n"),
    pytest.param(REAL4, list(REAL4), id="real4-no-umbrella"),
    pytest.param(("Kia", "Genesis", "Hyundai"), ["Kia", "Genesis", "Hyundai"], id="explicit-3-keeps-order"),
    pytest.param(("Kia", "HMG"), ["Kia"], id="umbrella-alone-not-marker"),
    pytest.param(("HMG",), [], id="umbrella-only-deny"),
])
def test_explicit_lists_unchanged(brands, expected):
    """표식이 아닌 명시 목록은 종전 그대로(좁히지도 넓히지도 않는다). 엄브렐러 하나만으로는 표식이 아니다(Kia+HMG 가 전 브랜드로 넓어지지 않는다)."""
    refs = _refs()
    p = _p("hq", brands)
    assert not brand_scope_covers_all(p, refs)
    assert creation_options(p, refs)[0] == expected


def test_admin_scope_all_and_vendor_unchanged():
    refs = _refs()
    assert creation_options(_p("admin", (), scope_all=True), refs)[0] == ["Hyundai", "Kia", "Genesis"]
    assert creation_options(_p("hq", FULL, scope_all=True), refs)[0] == ["Hyundai", "Kia", "Genesis"]
    assert not brand_scope_covers_all(_p("vendor", (), operator="none"), refs)
    assert creation_options(_p("vendor", (), operator="none"), refs)[0] == ["Hyundai", "Kia", "Genesis"]   # 종전: brands None


# ════════════════════════════════════════════════════════════════════════════
# 통합(needs_db): GLOBAL_KIA(hq · operator global)를 staged 로 전 코드 목록으로 바꾼다
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_api_full_list_account_creation_options_and_post(client_as):
    await ensure_extra_accounts()
    async with staged() as conn, client_as(ADMIN) as c:
        admin = (await c.get("/v1/projects/creation-options")).json()["data"]
        full = [x["b"] for x in await raw_fetch(conn, "SELECT brand_code AS b FROM app.brand ORDER BY sort_order, brand_code")]
    assert set(full) >= {"HMG", "Hyundai N"}                        # 픽스처 app.brand 에 엄브렐러·하위 브랜드가 있어야 의미가 있다
    async with staged(Update("app.user_account", {"user_id": GLOBAL_KIA}, {"scope_brands": full}), actor=SYSTEM), \
            client_as(GLOBAL_KIA) as c:
        r = await c.get("/v1/projects/creation-options")
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        post = await c.post("/v1/projects", json={"name": "a10-n", "country_code": d["countries"][0], "brand_code": "Hyundai N",
                                                   "ai_engines": ["chatgpt"]})
    assert d["brands"] == admin["brands"] == ["Hyundai", "Kia", "Genesis"]
    assert d["countries"] == admin["countries"] and d["brand_locked"] is False
    assert post.status_code == 403 and post.json()["error"]["code"] == "brand_forbidden", post.text
