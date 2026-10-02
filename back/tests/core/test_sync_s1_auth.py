"""동기화 S1 BE-C(hmg-geo 7639b9e..2670a16 의 권한·스코프 3건): 계정 형태 격자로 현행 판정과 대조한다.

BE-7 파생 메뉴 그룹(#328 472dc57·#329 2a6c60e): 글로벌 시장 없는 전용 사이트 계정(WW·CPO)은 standard 를 뺀다. 세션·로그인 착지 같은 값
     (hub 착지는 front lib/auth/actions.ts apiLanding 이 /v1/auth/me menu_groups 를 본다).
BE-8 현대 N 계정 웹사이트(#326 5a526fa): 계정 brands + 브랜드 가상 코드가 여는 사이트 브랜드('Hyundai N', 모 브랜드가 있을 때), 사이트 선택은
     country_code ∈ 실 코드 ∨ 사이트 브랜드 ∈ 가상 코드 브랜드(website-sites.ts websiteScopeCountryCondition), 답변 국가 = 선택된 사이트 국가.
BE-6 전용 사이트 계정의 글로벌 국가(#328): 계정 국가에 전용 사이트 코드(worldwide·CPO·HYUNDAI-N)가 있으면 글로벌 = 같은 배열의 ISO ∪
     그 사이트의 글로벌 시장(현대 N = US·KR). 비면(WW·CPO) 전용 코드 그대로(0건, fail-closed). 권역·브랜드 전체로 넓히지 않는다.

정본 = hmg-geo origin/main 2670a16. 아래 _front_* 는 그 함수를 원 표기(worldwide 소문자·계정 순서) 그대로 옮긴 것이다:
  lib/scope/website-virtual-geo.ts  WEBSITE_DEDICATED_SITE_CODES·WEBSITE_SITE_GLOBAL_MARKETS·siteAccountGlobalCountries(:139-149)·
                                    hasGlobalSurface(:152-156)·WEBSITE_SITE_BRAND_PARENT·websiteScopeBrands(:183-196)
  lib/rhq/index.ts:97-115           effectiveScopeCountries(글로벌 표면 전용)
  lib/auth/menu-groups.ts:17-30     effectiveMenuGroups(lib/auth/session.ts:48·lib/auth/actions.ts:45-53 공용)
비교는 대문자 집합(백엔드 DataScope 표기)으로 한다. 순서 차이(현행 = 계정 순서 + 시장, 백엔드 = 정렬)는 값 집합이 같으면 같은 판정이다.
"""
from __future__ import annotations

import uuid

import pytest

from app.core import auth as auth_mod
from app.core import result_cache as rc
from app.core.auth import MENU_GROUPS, SITE_GLOBAL_MARKETS, WEBSITE_DEDICATED_SITE_CODES, principal_from_row, surface_denial
from app.core.codes import parse_refs
from app.features.platform.auth.session.service import build_session
from tests.core.rcache_calls import Stmts, get
from tests.support import CUST_PROJECT, HQ_HYUNDAI, SYSTEM, Rows, needs_db, staged

# ── 현행 상수(website-virtual-geo.ts, 2670a16) ────────────────────────────────────────────────────────────────
_FRONT_BRAND_GEO = {"HYUNDAI-N": "Hyundai N"}                          # WEBSITE_BRAND_GEO_CODES
_FRONT_DEDICATED = ["worldwide", "CPO", *_FRONT_BRAND_GEO]              # WEBSITE_DEDICATED_SITE_CODES
_FRONT_MARKETS = {"HYUNDAI-N": ["US", "KR"]}                            # WEBSITE_SITE_GLOBAL_MARKETS
_FRONT_SITE_BRAND_PARENT = {"Hyundai N": "Hyundai"}                     # WEBSITE_SITE_BRAND_PARENT
_FRONT_VALID_GROUPS = ["standard", "website", "project", "admin"]      # menu-groups.ts VALID_GROUPS


def _front_dedicated(countries: list[str] | None) -> list[str]:
    return [c for c in (countries or []) if c in _FRONT_DEDICATED]


def _front_site_global(countries: list[str] | None) -> list[str] | None:
    """siteAccountGlobalCountries."""
    dedicated = _front_dedicated(countries)
    if not dedicated:
        return None
    out = [c for c in (countries or []) if c not in _FRONT_DEDICATED]
    for code in dedicated:
        for c in _FRONT_MARKETS.get(code, []):
            if c not in out:
                out.append(c)
    return out


def _front_has_global(all_: bool, countries: list[str] | None) -> bool:
    """hasGlobalSurface."""
    if all_:
        return True
    g = _front_site_global(countries)
    return g is None or len(g) > 0


def _front_effective_menu(stored: list[str] | None, all_: bool, countries: list[str] | None) -> list[str] | None:
    """effectiveMenuGroups."""
    groups = [g for g in stored if g in _FRONT_VALID_GROUPS] if stored else None
    if groups is not None and not groups:
        groups = None
    if not _front_has_global(all_, countries):
        narrowed = [g for g in (groups or _FRONT_VALID_GROUPS) if g != "standard"]
        if narrowed:
            groups = narrowed
    return groups


# ── 합성 참조(DB 없이 격자를 돌린다. 브랜드·가상 코드 = seed-10-app.sql:39-44·seed-30-dims.sql 가상 브랜드 행과 같은 모양) ──
REFS = parse_refs({
    "brands": [{"code": "Hyundai", "bit": 1, "umb": False, "parent": None, "ord": 1},
               {"code": "Kia", "bit": 2, "umb": False, "parent": None, "ord": 2},
               {"code": "Genesis", "bit": 4, "umb": False, "parent": None, "ord": 3},
               {"code": "HMG", "bit": 8, "umb": True, "parent": None, "ord": 4},
               {"code": "Hyundai N", "bit": 16, "umb": False, "parent": "Hyundai", "ord": 5}],
    "owned": [], "engines": [], "langs": [], "cats": [], "projects": [],
    "countries": [{"k": i + 1, "code": c, "kind": kind, "r": None, "vb": vb, "h": False} for i, (c, kind, vb) in enumerate([
        ("US", "iso", None), ("KR", "iso", None), ("CA", "iso", None), ("DE", "iso", None), ("FR", "iso", None), ("CN", "iso", None),
        ("SA", "iso", None), ("AE", "iso", None), ("worldwide", "pseudo", None), ("CPO", "pseudo", None), ("EU", "pseudo", None),
        ("MIDDLEEAST", "pseudo", None), ("CN-BJ", "pseudo", None), ("HYUNDAI-N", "virtual_brand", 16)])],
    "rhq": [{"id": "hyundai-north-america", "brand": "Hyundai", "cc": ["US", "CA"]},
            {"id": "hyundai-europe", "brand": "Hyundai", "cc": ["DE", "FR"]},
            {"id": "hyundai-asia-pacific", "brand": "Hyundai", "cc": ["CN", "KR"]},
            {"id": "hyundai-middle-east", "brand": "Hyundai", "cc": ["SA", "AE"]},
            {"id": "kia-western-europe", "brand": "Kia", "cc": ["DE", "FR"]}],
})

# (이름, 역할, scope_all, 브랜드, 권역, 국가). 국가 표기는 현행 계정 저장 표기(worldwide 소문자). stg 전용 사이트 계정 형태 포함(2026-09-29 사양표)
ACCOUNTS = [
    ("WW 현대", "hq", False, ["Hyundai"], [], ["worldwide"]),
    ("WW 기아", "hq", False, ["Kia"], [], ["worldwide"]),
    ("CPO", "hq", False, ["Hyundai"], [], ["CPO"]),
    ("CPO+US 북미(920e21cb 형태)", "country", False, ["Hyundai"], ["hyundai-north-america"], ["CPO", "US"]),
    ("CPO 북미 권역(권역으로 넓히지 않음)", "region", False, ["Hyundai"], ["hyundai-north-america"], ["CPO"]),
    ("현대 N", "hq", False, ["Hyundai"], [], ["HYUNDAI-N"]),
    ("현대 N+KR(08-20 발급 형태)", "hq", False, ["Hyundai"], [], ["HYUNDAI-N", "KR"]),
    ("현대 N + worldwide", "hq", False, ["Hyundai"], [], ["worldwide", "HYUNDAI-N"]),
    ("현대 N 코드 + 기아 브랜드", "hq", False, ["Kia"], [], ["HYUNDAI-N"]),
    ("EU 허브(a66a4e12 형태)", "region", False, ["Hyundai"], ["hyundai-europe"], ["EU", "DE", "FR"]),
    ("CN-BJ·CN(21dad652 형태)", "region", False, ["Hyundai"], ["hyundai-asia-pacific"], ["CN-BJ", "CN"]),
    ("MIDDLEEAST·SA", "region", False, ["Hyundai"], ["hyundai-middle-east"], ["MIDDLEEAST", "SA"]),
    ("권역만(기아 서유럽)", "region", False, ["Kia"], ["kia-western-europe"], []),
    ("국가만(DE)", "country", False, ["Kia"], [], ["DE"]),
    ("브랜드만(현대 hq)", "hq", False, ["Hyundai"], [], []),
    ("website 역할 WW", "website", False, ["Hyundai"], [], ["worldwide"]),
    ("vendor(브랜드 없음)", "vendor", False, [], [], []),
    ("vendor + 현대 N 코드", "vendor", False, [], [], ["HYUNDAI-N"]),
    ("admin", "admin", True, [], [], []),
]
IDS = [a[0] for a in ACCOUNTS]
STORED_MENUS = [None, ["standard", "website"], ["standard"], ["website"], ["project", "admin"], ["standard", "project"],
                ["standard", "website", "project", "admin"]]


def _row(role: str, scope_all: bool, brands: list[str], regions: list[str], countries: list[str], menu: list[str] | None) -> dict:
    return {"user_id": uuid.uuid4(), "email": "t@example.test", "display_name": None, "role": role,
            "operator": "global" if role == "admin" else "none", "scope_all": scope_all, "scope_brands": brands, "scope_regions": regions,
            "scope_countries": countries, "menu_groups": menu, "is_qa_reviewer": False}


# 픽스처 rd.dim_country 에 없는 전용 사이트 코드(계정 국가 참조 트리거 P70 이 받도록 준비 트랜잭션에만 더한다)
DIM_EXTRA = Rows("rd.dim_country", [
    {"geo_key": 32001, "code": "worldwide", "region_key": None, "kind": "pseudo", "virtual_brand_bit": None, "hidden_standard": False},
    {"geo_key": 32002, "code": "CPO", "region_key": None, "kind": "pseudo", "virtual_brand_bit": None, "hidden_standard": False},
])
P = str(CUST_PROJECT)                  # 현대 US 고객 프로젝트(HQ_HYUNDAI 비멤버 스코프 열람)


def _acct(role: str, regions: list[str], countries: list[str], menu: list[str] | None, brands: list[str] | None = None) -> dict:
    uid = uuid.uuid4()
    return {"user_id": uid, "email": f"t-s1bec-{uid.hex[:8]}@example.test", "role": role, "operator": "none", "scope_all": False,
            "scope_brands": brands if brands is not None else ["Hyundai"], "scope_regions": regions, "scope_countries": countries,
            "menu_groups": menu, "status": "active"}


def _status(r) -> int | tuple[int, str]:  # noqa: ANN001
    return r.status_code if r.status_code != 403 else (403, r.json()["error"]["code"])


# ════════════════════════════════════════════════════════════════════════════
# BE-7 파생 메뉴 그룹
# ════════════════════════════════════════════════════════════════════════════
def test_constants_match_front():
    """전용 사이트 코드·글로벌 시장·메뉴 그룹 상수 = 현행 상수(대문자 표기)."""
    assert {c.upper() for c in _FRONT_DEDICATED} == set(WEBSITE_DEDICATED_SITE_CODES) | set(SITE_GLOBAL_MARKETS)
    assert {k: tuple(v) for k, v in _FRONT_MARKETS.items()} == SITE_GLOBAL_MARKETS
    assert list(MENU_GROUPS) == _FRONT_VALID_GROUPS


@needs_db
async def test_brand_geo_codes_all_have_global_markets(refs):
    """메뉴 파생은 참조 없이(계정 행만) 전용 사이트 코드를 판정하고 데이터 스코프(website·global)는 rd.dim_country virtual_brand 로 판정한다.
    둘이 같으려면 브랜드 가상 코드가 전부 SITE_GLOBAL_MARKETS 에 있어야 한다(시장 없는 브랜드 가상 코드가 생기면 여기서 멈춘다: 시장·메뉴
    규칙을 먼저 정한다). 사이트 브랜드 = Hyundai N, 부모 = Hyundai(website_scope_brands 가 쓰는 참조)."""
    brand_geo = {code for code, c in refs.countries.items() if c.kind == "virtual_brand"}
    assert brand_geo == set(SITE_GLOBAL_MARKETS) == {"HYUNDAI-N"}
    vb = refs.countries["HYUNDAI-N"].virtual_brand_bit
    site = refs.brand(refs.brand_code_of_bit(vb)) if vb is not None else None
    assert site is not None and site.code == "Hyundai N" and site.parent == "Hyundai"


@pytest.mark.parametrize("name,role,scope_all,brands,regions,countries", ACCOUNTS, ids=IDS)
def test_menu_groups_equal_front(name, role, scope_all, brands, regions, countries):
    """principal_from_row 의 menu_groups = 현행 effectiveMenuGroups(저장값 7종). /v1/auth/me(build_session)도 같은 값."""
    for stored in STORED_MENUS:
        p = principal_from_row(_row(role, scope_all, brands, regions, countries, stored))
        want = _front_effective_menu(stored, scope_all, countries)
        assert (list(p.menu_groups) if p.menu_groups is not None else None) == want, (name, stored, p.menu_groups, want)
        assert build_session(p, REFS).menu_groups == want, (name, stored)


def test_menu_groups_named_cases():
    """현행 menu-groups.test.ts 4건 + 무효값·admin·CPO+US(독립 기대값)."""
    def m(stored: list[str] | None, countries: list[str], role: str = "hq", scope_all: bool = False) -> tuple[str, ...] | None:
        return principal_from_row(_row(role, scope_all, ["Hyundai"], [], countries, stored)).menu_groups
    assert m(["standard", "website"], ["DE"]) == ("standard", "website")
    assert m(["bogus"], []) is None and m(None, []) is None
    assert m(["standard", "website"], ["worldwide"]) == ("website",)
    assert m(None, ["CPO"]) == ("website", "project", "admin")         # 제한 없음 → 전체에서 standard 만 뺀다
    assert m(["standard", "website"], ["HYUNDAI-N"]) == ("standard", "website")
    assert m(["standard"], ["worldwide"]) == ("standard",)              # 비우지 않는다(빈 값 = 제한 없음이라 넓어진다)
    assert m(None, ["CPO", "US"]) is None                                # CPO+US 는 글로벌 시장(US)이 있다
    assert m(None, [], role="admin", scope_all=True) is None


@pytest.mark.parametrize("name,role,scope_all,brands,regions,countries", ACCOUNTS, ids=IDS)
def test_surface_gate_uses_derived_menu(name, role, scope_all, brands, regions, countries):
    """표면 게이트(surface_denial = 역할 천장 → 메뉴)가 파생 메뉴를 본다. 현행 route-policy: 역할이 먼저(website 역할 WW 는 role_forbidden)."""
    for stored in STORED_MENUS:
        p = principal_from_row(_row(role, scope_all, brands, regions, countries, stored))
        menu = _front_effective_menu(stored, scope_all, countries)
        for surface, group in (("global", "standard"), ("website", "website"), ("project", "project")):
            want = ("role_forbidden" if role not in auth_mod.SURFACE_ROLES[surface]
                    else "menu_forbidden" if menu is not None and group not in menu else None)
            assert surface_denial(p, surface) == want, (name, stored, surface)


# (이름, 역할, 권역, 국가, 저장 메뉴, 기대: global·website·project 상태 코드(403 은 오류 코드까지))
API_CASES = [
    ("WW", "hq", [], ["worldwide"], None, (403, "menu_forbidden"), 200, 404),
    ("CPO", "hq", [], ["CPO"], None, (403, "menu_forbidden"), 200, 404),
    ("CPO+US 북미", "country", ["hyundai-north-america"], ["CPO", "US"], None, 200, 200, 200),
    ("현대 N", "hq", [], ["HYUNDAI-N"], None, 200, 200, 404),
    ("현대 N+KR", "hq", [], ["HYUNDAI-N", "KR"], None, 200, 200, 404),
    ("WW website 역할", "website", [], ["worldwide"], ["website"], (403, "role_forbidden"), 200, (403, "role_forbidden")),
    ("WW 저장 메뉴 standard 만", "hq", [], ["worldwide"], ["standard"], 200, (403, "menu_forbidden"), (403, "menu_forbidden")),
    ("WW 저장 메뉴 standard·website", "hq", [], ["worldwide"], ["standard", "website"], (403, "menu_forbidden"), 200,
     (403, "menu_forbidden")),
]


@needs_db
@pytest.mark.parametrize("name,role,regions,countries,menu,want_g,want_w,want_p", API_CASES, ids=[c[0] for c in API_CASES])
async def test_api_surfaces_and_me(client_as, db_v212, name, role, regions, countries, menu, want_g, want_w, want_p):
    """API 경로: /v1/auth/me menu_groups = 현행 effectiveMenuGroups, 표면 게이트 200/403(코드)/404. 프로젝트 = 현대 US 고객 프로젝트
    (전용 사이트 계정은 계정 국가 원값에 US 가 없어 비가시 404: 현행 projectInScope 와 같다. CPO+US 는 보인다)."""
    acct = _acct(role, regions, countries, menu)
    async with staged(DIM_EXTRA, Rows("app.user_account", [acct]), actor=SYSTEM), client_as(acct["user_id"]) as c:
        me = (await c.get("/v1/auth/me")).json()["data"]
        g = await c.get("/v1/kpi/summary", params={"surface": "global"})
        w = await c.get("/v1/kpi/summary", params={"surface": "website"})
        pr = await c.get("/v1/kpi/summary", params={"surface": "project", "project_id": P})
    assert me["menu_groups"] == _front_effective_menu(menu, False, countries), (name, me["menu_groups"])
    assert me["scope"]["account_countries"] == countries                       # 계정 원값(FA-1 이 쓰는 값) 그대로
    assert (_status(g), _status(w), _status(pr)) == (want_g, want_w, want_p), (name, g.text[:200], w.text[:200], pr.text[:200])


@needs_db
async def test_cache_denied_ww_never_looks_up(client_as, cache_on, db_v212):
    """WW 계정(저장 메뉴 없음 → 파생 메뉴에 standard 없음)은 같은 해석 스코프의 허용 계정(저장 메뉴 standard 만: 비우지 않아 standard 유지)이
    행을 채워도 global 을 조회하지 않고 403 menu_forbidden(캐시 문장 0, 헤더 없음). 서명에 메뉴가 없으므로 게이트가 조회보다 먼저여야 한다."""
    allowed = _acct("hq", [], ["worldwide"], ["standard"])
    denied = _acct("hq", [], ["worldwide"], None)
    path, prm = "/v1/kpi/summary", {"surface": "global"}
    async with staged(DIM_EXTRA, Rows("app.user_account", [allowed, denied]), actor=SYSTEM):
        r0 = await get(client_as, allowed["user_id"], path, prm)
        assert r0.status_code == 200 and r0.headers.get(rc.HEADER) in ("miss", "hit"), r0.text[:200]
        with Stmts() as st:
            r = await get(client_as, denied["user_id"], path, prm)
    assert (r.status_code, r.json()["error"]["code"]) == (403, "menu_forbidden")
    assert rc.HEADER.lower() not in {k.lower() for k in r.headers}
    assert not [s for s in st.seen if "result_cache" in s]


# ════════════════════════════════════════════════════════════════════════════
# BE-8 현대 N 웹사이트 브랜드
# ════════════════════════════════════════════════════════════════════════════
def _front_website_scope_brands(brands: list[str] | None, countries: list[str] | None) -> list[str]:
    """websiteScopeBrands."""
    out = list(brands or [])
    if not out:
        return out
    for code in countries or []:
        site = _FRONT_BRAND_GEO.get(code)
        if not site or site in out:
            continue
        parent = _FRONT_SITE_BRAND_PARENT.get(site)
        if parent and parent in out:
            out.append(site)
    return out


@pytest.mark.parametrize("name,role,scope_all,brands,regions,countries", ACCOUNTS, ids=IDS)
def test_website_brands_equal_front(name, role, scope_all, brands, regions, countries):
    """website 표면 브랜드 = 현행 websiteScopeBrands. 백엔드 None(전체·무제한 vendor) = 현행 빈 배열(제한 없음). global·project 는 계정 브랜드."""
    from app.core.auth import DataScope

    ds = DataScope.of(principal_from_row(_row(role, scope_all, brands, regions, countries, None)), REFS)
    web = ds.for_surface("website").brands
    assert (list(web) if web is not None else []) == _front_website_scope_brands(brands, countries), (name, web)
    assert ds.for_surface("global").brands == ds.for_surface("project").brands == ds.brands


def test_website_brands_named_cases():
    """현행 website-virtual-geo.test.ts '전용 사이트 계정' 4건(독립 기대값)."""
    from app.core.auth import DataScope

    def w(brands: list[str], countries: list[str], role: str = "hq") -> tuple[str, ...] | None:
        return DataScope.of(principal_from_row(_row(role, False, brands, [], countries, None)), REFS).for_surface("website").brands
    assert w(["Hyundai"], ["HYUNDAI-N", "KR"]) == ("Hyundai", "Hyundai N")
    assert w(["Kia"], ["HYUNDAI-N"]) == ("Kia",)
    assert w(["Hyundai"], ["KR"]) == ("Hyundai",)
    assert w([], ["HYUNDAI-N"], role="vendor") is None                 # 브랜드 제한 없는 계정에 제한을 만들지 않는다


def test_unresolved_datascope_keeps_old_surface_rule():
    """of() 를 거치지 않고 직접 만든 DataScope 는 표면 값이 없다: global·project 는 그대로, website 는 도시 scopeParent 만(종전)."""
    from app.core.auth import DataScope

    ds = DataScope(False, ("Hyundai",), ("HYUNDAI-N",), ())
    assert ds.for_surface("global") is ds and ds.for_surface("project") is ds and ds.for_surface("website") is ds


def test_result_cache_signature_website_brand():
    """결과 캐시 서명은 for_surface 값을 쓴다: 현대 N 의 website 서명 브랜드에 'Hyundai N' 이 붙는다(국가는 core 10 규칙 그대로)."""
    n = principal_from_row(_row("hq", False, ["Hyundai"], [], ["HYUNDAI-N"], None))
    assert rc.scope_signature(n, REFS, "website")["brands"] == ["Hyundai", "Hyundai N"]
    assert rc.scope_signature(n, REFS, "website")["countries"] == ["HYUNDAI-N"]
    kia = principal_from_row(_row("hq", False, ["Kia"], [], ["HYUNDAI-N"], None))
    assert rc.scope_signature(kia, REFS, "website")["brands"] == ["Kia"]


# 합성 웹사이트 사이트(브랜드, 사이트 국가 = website_sites.country_code 표기). 현대 N 사이트 2행 = 현행 website-virtual-geo.ts 머리 주석(KR·worldwide)
N_SITES = [("Hyundai N", "KR"), ("Hyundai N", "worldwide"), ("Hyundai", "KR"), ("Hyundai", "worldwide"), ("Hyundai", "US"),
           ("Hyundai", "CPO"), ("Kia", "KR"), ("Kia", "worldwide")]
# (이름, 브랜드, 권역, 국가, 전체 스코프)
SITE_ACCOUNTS = [
    ("현대 N", ["Hyundai"], [], ["HYUNDAI-N"], False),
    ("현대 N+KR", ["Hyundai"], [], ["HYUNDAI-N", "KR"], False),
    ("현대 N + worldwide", ["Hyundai"], [], ["worldwide", "HYUNDAI-N"], False),
    ("현대·기아 + HYUNDAI-N", ["Hyundai", "Kia"], [], ["HYUNDAI-N"], False),
    ("기아 + HYUNDAI-N(모 브랜드 없음)", ["Kia"], [], ["HYUNDAI-N"], False),
    ("현대 KR", ["Hyundai"], [], ["KR"], False),
    ("현대 브랜드만", ["Hyundai"], [], [], False),
    ("CPO+US 북미", ["Hyundai"], ["hyundai-north-america"], ["CPO", "US"], False),
    ("WW 현대", ["Hyundai"], [], ["worldwide"], False),
    ("admin", [], [], [], True),
]


async def _refs_with_n_sites():
    """실제 참조 차원 + 합성 사이트(N_SITES). 픽스처에 없는 사이트 국가(worldwide·CPO)는 국가 차원에도 더한다(적재기라면 생길 행)."""
    import dataclasses

    from app.core.codes import Country, ProjectDim, load_refs

    async with staged() as conn:
        refs = await load_refs(conn)
    countries = dict(refs.countries)
    for i, code in enumerate(("worldwide", "CPO")):
        countries.setdefault(code.upper(), Country(32001 + i, code, "pseudo", None, None, False))
    pk = max(p.project_key for p in refs.projects) + 1
    bit = {b.code: b.bit for b in refs.brands}
    sites = [ProjectDim(pk + i, 2, False, None, str(uuid.uuid4()), bit[b], countries[c.upper()].geo_key) for i, (b, c) in enumerate(N_SITES)]
    refs2 = dataclasses.replace(refs, countries=countries, projects=refs.projects + tuple(sites))
    return refs2, {s.project_key: N_SITES[i] for i, s in enumerate(sites)}


def _front_website_sites(brands: list[str], regions: list[str], countries: list[str], all_: bool, refs, rhq_iso: set[str]  # noqa: ANN001
                         ) -> set[tuple[str, str]]:
    """현행 getProjectIdsForScope(website-sites.ts:146-169): scope.all 이면 전 사이트, 아니면 websiteBrandCondition(websiteScopeBrands, 빈 배열 =
    조건 없음) ∧ websiteScopeCountryCondition(effectiveCountries → splitWebsiteGeo: country_code ∈ 실 코드 ∨ brand ∈ 가상 코드 브랜드)."""
    from tests.core.test_scope_parent import _front_effective

    if all_:
        return set(N_SITES)
    allow = _front_website_scope_brands(brands, countries) or None
    eff = _front_effective(countries, sorted(refs.region_countries(regions)) if regions else None, rhq_iso)
    codes = [c for c in eff or () if c not in _FRONT_BRAND_GEO]
    vbrands = [_FRONT_BRAND_GEO[c] for c in eff or () if c in _FRONT_BRAND_GEO]
    return {(b, c) for b, c in N_SITES
            if (allow is None or b in allow) and (eff is None or c in codes or b in vbrands)}


@needs_db
@pytest.mark.parametrize("name,brands,regions,countries,all_", SITE_ACCOUNTS, ids=[a[0] for a in SITE_ACCOUNTS])
async def test_website_sites_equal_front(name, brands, regions, countries, all_):
    """website 사이트 선택 = 현행(2670a16) website-sites.ts: websiteBrandCondition(websiteScopeBrands) ∧ websiteScopeCountryCondition
    (effectiveCountries → splitWebsiteGeo: country_code ∈ 실 코드 ∨ 사이트 브랜드 ∈ 가상 코드 브랜드). 사이트 가시성(by-scope website_site_visible)도 같다.
    현대 N 계정은 현대 N 사이트(KR·worldwide)만, 현대 본사 KR·worldwide 사이트는 아니다."""
    from app.core.filters import CommonFilters, FilterSupport, resolve_read_context
    from app.features.projects.project.core.service import website_site_visible
    from tests.core.test_scope_parent import _rhq_iso

    refs, by_key = await _refs_with_n_sites()
    role = "admin" if all_ else "hq"
    p = principal_from_row(_row(role, all_, brands, regions, countries, None))
    ctx = await resolve_read_context(None, p, CommonFilters(surface="website"), support=FilterSupport.of(website=("brand", "country")),
                                     refs=refs, surface_gate=False)
    want = _front_website_sites(brands, regions, countries, all_, refs, _rhq_iso(refs))
    assert {by_key[k] for k in ctx.project_keys if k in by_key} == want, (name, want)
    assert {s for s in N_SITES if website_site_visible(p, refs, s[0], s[1])} == want, name


@needs_db
async def test_n_account_answer_geo_and_scope_site_rule():
    """현대 N 계정 website 문맥: 답변 국가 축 = 선택된 사이트 국가(KR·WORLDWIDE, 가상 코드 HYUNDAI-N 은 답변 국가가 아니다), 사이트 브랜드 모수 =
    Hyundai N 비트만. 사이트 판정(DataScope.site_allowed)은 스코프 가상 코드를 사이트 브랜드로 본다. 요청 국가 축(virtual_brand_bits·request_iso)은
    요청 값만이다(스코프 값을 싣지 않는다: GA4 시장은 계정 원값, 카탈로그는 site_allowed). 요청 country=HYUNDAI-N 도 같은 사이트·국가,
    country=KR 은 스코프 밖이라 dropped(종전 규칙). worldwide + HYUNDAI-N 두 전용 코드 계정은 합집합이고 현대 KR 본사 사이트는 아니다."""
    from app.core.filters import CommonFilters, FilterSupport, resolve_read_context

    refs, by_key = await _refs_with_n_sites()
    sup = FilterSupport.of(website=("brand", "country"))
    n = principal_from_row(_row("hq", False, ["Hyundai"], [], ["HYUNDAI-N"], None))
    ctx = await resolve_read_context(None, n, CommonFilters(surface="website"), support=sup, refs=refs, surface_gate=False)
    assert ctx.countries == ("KR", "WORLDWIDE")
    assert set(ctx.geo_keys or ()) == {refs.geo_key("KR"), refs.geo_key("WORLDWIDE")}
    assert ctx.bgrps == (16,) and ctx.virtual_brand_bits is None and ctx.request_iso is None
    assert ctx.scope.site_allowed(refs, 16, "KR") and not ctx.scope.site_allowed(refs, 1, "KR")
    assert not ctx.scope.site_allowed(refs, 1, "worldwide")
    req = await resolve_read_context(None, n, CommonFilters(surface="website", country=["HYUNDAI-N"]), support=sup, refs=refs,
                                     surface_gate=False)
    assert (set(req.project_keys), req.countries, req.virtual_brand_bits) == (set(ctx.project_keys), ctx.countries, (16,))
    kr = await resolve_read_context(None, n, CommonFilters(surface="website", country=["KR"]), support=sup, refs=refs, surface_gate=False)
    assert kr.dropped_filters["country"] == ("KR",) and kr.countries == ()
    mix = principal_from_row(_row("hq", False, ["Hyundai"], [], ["worldwide", "HYUNDAI-N"], None))
    m = await resolve_read_context(None, mix, CommonFilters(surface="website"), support=sup, refs=refs, surface_gate=False)
    assert {by_key[k] for k in m.project_keys if k in by_key} == {("Hyundai", "worldwide"), ("Hyundai N", "KR"), ("Hyundai N", "worldwide")}
    assert m.countries == ("KR", "WORLDWIDE") and m.request_iso is None and m.virtual_brand_bits is None
    assert m.scope.site_allowed(refs, 1, "worldwide") and m.scope.site_allowed(refs, 16, "KR") and not m.scope.site_allowed(refs, 1, "KR")
    hy = principal_from_row(_row("hq", False, ["Hyundai"], [], ["KR"], None))
    h = await resolve_read_context(None, hy, CommonFilters(surface="website"), support=sup, refs=refs, surface_gate=False)
    assert h.countries == ("KR",) and h.virtual_brand_bits is None and h.request_iso is None          # 가상 코드 없는 계정은 종전 그대로


@needs_db
async def test_f3_union_request_country_case_insensitive():
    """검증 F3: 요청 country[]=worldwide&country[]=HYUNDAI-N(ISO·가상 합집합). 사이트 국가 원표기(worldwide)와 요청 대문자 집합을 대문자로 비교해
    현대·기아 worldwide 사이트가 빠지지 않는다. 현행 websiteSiteGeoPred(country_code ∈ 실 코드 ∨ brand ∈ 가상 코드 브랜드)와 같은 사이트 집합."""
    from app.core.filters import CommonFilters, FilterSupport, resolve_read_context

    refs, by_key = await _refs_with_n_sites()
    admin = principal_from_row(_row("admin", True, [], [], [], None))
    ctx = await resolve_read_context(None, admin, CommonFilters(surface="website", country=["worldwide", "HYUNDAI-N"]),
                                     support=FilterSupport.of(website=("brand", "country")), refs=refs, surface_gate=False)
    want = {(b, c) for b, c in N_SITES if c == "worldwide" or b == "Hyundai N"}
    assert {by_key[k] for k in ctx.project_keys if k in by_key} == want
    assert ctx.countries == ("KR", "WORLDWIDE")


@needs_db
async def test_by_scope_n_site_visibility_api(client_as, db_v212):
    """API 경로 GET /v1/projects/by-scope/{id}(website_site_visible): 현대 N 계정 → 현대 N 사이트 200(website), 현대 본사 사이트 404.
    현대 국가 계정은 반대(본사 200, N 사이트 404: 사이트 브랜드 허용에 Hyundai N 이 없다). 사이트 (브랜드, 국가)는 다른 시험 시드와 겹치지 않는
    값(UNIQUE (brand_code, country_code): 카탈로그 시드 Hyundai KR·Hyundai N DE 가 같은 DB 에 남을 수 있다)."""
    n_spid, h_spid = uuid.uuid4(), uuid.uuid4()
    sites = Rows("app.website_site", [{"site_id": uuid.uuid4(), "brand_code": "Hyundai N", "country_code": "worldwide", "scope_project_id": n_spid},
                                      {"site_id": uuid.uuid4(), "brand_code": "Hyundai", "country_code": "MX", "scope_project_id": h_spid}])
    n = _acct("hq", [], ["HYUNDAI-N"], None)
    hy = _acct("hq", [], ["MX"], None)
    got = {}
    async with staged(sites, Rows("app.user_account", [n, hy]), actor=SYSTEM):
        for who, acct in (("n", n), ("hy", hy)):
            for site, spid in (("n_site", n_spid), ("h_site", h_spid)):
                async with client_as(acct["user_id"]) as c:
                    r = await c.get(f"/v1/projects/by-scope/{spid}")
                got[(who, site)] = (r.status_code, r.json()["data"]["brand_code"] if r.status_code == 200 else None)
    assert got == {("n", "n_site"): (200, "Hyundai N"), ("n", "h_site"): (404, None),
                   ("hy", "n_site"): (404, None), ("hy", "h_site"): (200, "Hyundai")}, got


# ════════════════════════════════════════════════════════════════════════════
# BE-6 전용 사이트 계정의 글로벌 국가
# ════════════════════════════════════════════════════════════════════════════
def _up(v: list[str] | tuple[str, ...] | None) -> list[str] | None:
    return None if v is None else sorted({c.upper() for c in v})


def _front_effective_scope_countries(all_: bool, countries: list[str] | None, regions: list[str] | None,
                                     rhq: dict[str, tuple[str, tuple[str, ...]]]) -> list[str] | None:
    """lib/rhq effectiveScopeCountries(글로벌 표면). rhq = 권역 id → (브랜드, 국가) = front rhq-map.json 과 같은 원천(app.rhq_region_country)."""
    if all_:
        return None
    site = _front_site_global(countries)
    if site is not None:
        return site if site else _front_dedicated(countries)
    if countries:
        return list(countries)
    s = {c for rid in (regions or []) for c in rhq.get(rid, ("", ()))[1]}
    return sorted(s) if s else None


@pytest.mark.parametrize("name,role,scope_all,brands,regions,countries", ACCOUNTS, ids=IDS)
def test_global_countries_equal_front(name, role, scope_all, brands, regions, countries):
    """global 표면 국가 = 현행 effectiveScopeCountries(대문자 집합). project 표면·세션(DataScope.countries, Q10)은 바뀌지 않는다."""
    from app.core.auth import DataScope

    ds = DataScope.of(principal_from_row(_row(role, scope_all, brands, regions, countries, None)), REFS)
    want = _front_effective_scope_countries(scope_all, countries, regions, REFS.rhq)
    assert _up(ds.for_surface("global").countries) == _up(want), (name, ds.for_surface("global").countries, want)
    assert ds.for_surface("project") is ds
    q10 = None if scope_all else (_up(countries) or (sorted({c for r in regions for c in REFS.rhq[r][1]}) or None))
    assert _up(ds.countries) == q10, name


def test_global_countries_named_cases():
    """사양표 값을 이름으로 고정(격자가 같은 식을 두 번 쓰는 것을 막는 독립 기대값)."""
    from app.core.auth import DataScope

    def g(countries: list[str], regions: list[str] | None = None) -> tuple[str, ...] | None:
        p = principal_from_row(_row("hq", False, ["Hyundai"], regions or [], countries, None))
        return DataScope.of(p, REFS).for_surface("global").countries
    assert g(["HYUNDAI-N"]) == ("KR", "US")
    assert g(["HYUNDAI-N", "KR"]) == ("KR", "US")
    assert g(["CPO", "US"], ["hyundai-north-america"]) == ("US",)
    assert g(["worldwide"]) == ("WORLDWIDE",)                          # 시장 없음: 전용 코드 그대로(ISO 와 안 맞는다), 빈 튜플(403) 아님
    assert g(["CPO"], ["hyundai-north-america"]) == ("CPO",)            # 권역으로 넓히지 않는다
    assert g(["EU", "DE", "FR"], ["hyundai-europe"]) == ("DE", "EU", "FR")   # 권역 허브는 전용 사이트 계정이 아니다(종전)
    assert g([], ["hyundai-europe"]) == ("DE", "FR")


def test_result_cache_signature_global():
    """결과 캐시 서명(scope_signature)은 for_surface 값을 쓴다: 현대 N global = (KR, US) 로 현대 KR·US 국가 계정과 같은 서명(같은 데이터),
    종전 (HYUNDAI-N) 과 다르다. 프로젝트 표면은 Q10 그대로. 메뉴는 서명 밖(게이트가 조회 전: DB 시험이 본다)."""
    n = principal_from_row(_row("hq", False, ["Hyundai"], [], ["HYUNDAI-N"], None))
    twin = principal_from_row(_row("hq", False, ["Hyundai"], [], ["KR", "US"], None))
    assert rc.scope_signature(n, REFS, "global") == rc.scope_signature(twin, REFS, "global")
    assert rc.scope_signature(n, REFS, "global")["countries"] == ["KR", "US"]
    assert rc.scope_signature(n, REFS, "project")["countries"] == ["HYUNDAI-N"]
    cpo_us = principal_from_row(_row("country", False, ["Hyundai"], ["hyundai-north-america"], ["CPO", "US"], None))
    assert rc.scope_signature(cpo_us, REFS, "global")["countries"] == ["US"]


@needs_db
async def test_n_account_global_equals_kr_us_twin(client_as, db_v212):
    """현대 N 계정의 global 응답 = 현대 KR·US 국가 계정 응답(같은 해석 스코프). 현대 전체 계정과는 스코프가 다르다.
    종전(글로벌 국가 = HYUNDAI-N)은 0건이라 쌍둥이와 다르다(되돌림 시험).
    스코프 차이의 증거는 요청 country=DE(현대 전체는 받고, N·쌍둥이는 스코프 밖이라 dropped)다. 픽스처의 현대 관점 글로벌 데이터는 KR·US 뿐이라
    나머지 호출은 현대 전체와 바이트가 같을 수 있다(동기화 S1 BE-B 뒤 ⑤ 분자 = Σ cit_off 는 국가 스코프로 좁히지 않는다: 종전 차이는 옛 자사 분자뿐)."""
    n = _acct("hq", [], ["HYUNDAI-N"], None)
    twin = _acct("hq", [], ["KR", "US"], None)
    calls = [("/v1/kpi/summary", {"surface": "global"}), ("/v1/mentions/brands", {"surface": "global", "top_n": "20"}),
             ("/v1/trend", {"surface": "global"}), ("/v1/filters/options", {"surface": "global"}),
             ("/v1/kpi/summary", {"surface": "global", "country": "DE"})]
    differs = []
    async with staged(Rows("app.user_account", [n, twin]), actor=SYSTEM):
        for path, prm in calls:
            rn = await get(client_as, n["user_id"], path, prm)
            rt = await get(client_as, twin["user_id"], path, prm)
            rh = await get(client_as, HQ_HYUNDAI, path, prm)
            assert rn.status_code == rt.status_code == rh.status_code == 200, (path, rn.text[:200])
            assert rn.content == rt.content, path
            differs.append(rn.content != rh.content)
        opts = (await get(client_as, n["user_id"], "/v1/filters/options", {"surface": "global"})).json()["data"]
    assert differs[-1]                                                        # 현대 전체(DE 등 포함)와는 다른 스코프(country=DE 수용 여부)
    assert {r["code"] for r in opts["regions"]} == {"KR", "US"}               # 픽스처 글로벌 국가 US·KR·DE·ID 중 시장만(종전 = 빈 집합)


@needs_db
async def test_read_context_global_scope(db_v212):
    """resolve_read_context(global) 의 스코프 = 전용 사이트 계정 글로벌 국가, 요청 국가는 그 안에서만(현행 narrowGeoToScope: 밖은 dropped)."""
    from app.core.codes import load_refs
    from app.core.filters import CommonFilters, FilterSupport, resolve_read_context

    async with staged() as conn:
        refs = await load_refs(conn)
    sup = FilterSupport.of(global_=("country",))
    n = principal_from_row(_row("hq", False, ["Hyundai"], [], ["HYUNDAI-N"], None))
    ctx = await resolve_read_context(None, n, CommonFilters(surface="global"), support=sup, refs=refs, surface_gate=False)
    assert ctx.scope.countries == ("KR", "US")
    ctx2 = await resolve_read_context(None, n, CommonFilters(surface="global", country=["US", "DE", "HYUNDAI-N"]), support=sup, refs=refs,
                                      surface_gate=False)
    assert ctx2.countries == ("US",) and sorted(ctx2.dropped_filters["country"]) == ["DE", "HYUNDAI-N"]


@needs_db
async def test_cache_n_account_shares_twin_not_hq(client_as, cache_on, db_v212):
    """현대 N global 서명 = 현대 KR·US 쌍둥이 서명 → 쌍둥이가 채운 행을 적중(바이트 = N 이 캐시 끔으로 계산한 값). 현대 전체(HQ_HYUNDAI)와는
    서명이 달라 미스(교차 없음: r3 miss 가 증거). 종전 서명((HYUNDAI-N))이면 쌍둥이 행을 받지 못하고 바이트도 다르다.
    현대 전체의 바이트는 N 과 같을 수 있다(픽스처 현대 관점 글로벌 데이터 = KR·US 뿐, 동기화 S1 BE-B ⑤ 분자는 국가로 좁히지 않는다)."""
    from app.core.config import get_settings, set_settings
    from tests.core.test_result_cache import _drop_account, _temp_account, invalidate

    await invalidate()
    n = await _temp_account(["Hyundai"], [], ["HYUNDAI-N"], "hq")
    twin = await _temp_account(["Hyundai"], [], ["KR", "US"], "hq")
    path, prm = "/v1/kpi/summary", {"surface": "global"}
    try:
        s_on = get_settings()
        set_settings(s_on.model_copy(update={"result_cache": False}))
        try:
            off_n = (await get(client_as, n, path, prm)).content
            off_h = (await get(client_as, HQ_HYUNDAI, path, prm)).content
        finally:
            set_settings(s_on)
        r1 = await get(client_as, twin, path, prm)
        r2 = await get(client_as, n, path, prm)
        r3 = await get(client_as, HQ_HYUNDAI, path, prm)
        assert (r1.headers.get(rc.HEADER), r2.headers.get(rc.HEADER), r3.headers.get(rc.HEADER)) == ("miss", "hit", "miss")
        assert r2.content == off_n == r1.content and r3.content == off_h
    finally:
        await _drop_account(n)
        await _drop_account(twin)


# ════════════════════════════════════════════════════════════════════════════
# 독립 검증 반영(65e4d8c4 반려: F1 GA4 시장·이벤트 인가, F2 website 옵션, 웹사이트 카탈로그)
# ════════════════════════════════════════════════════════════════════════════
# GA4 레지스트리(app.ga4_property) 합성 행: (브랜드, 국가) → 속성 id(숫자, 다른 시험과 겹치지 않는 값)
GA4_MARKETS = [("Hyundai", "KR"), ("Hyundai", "US"), ("Hyundai", "worldwide"), ("Hyundai", "CPO"), ("Hyundai N", "KR"),
               ("Hyundai N", "worldwide"), ("Kia", "KR"), ("Kia", "US")]
GA4_PID = {m: str(9_870_000_001 + i) for i, m in enumerate(GA4_MARKETS)}
# (이름, 역할, 브랜드, 권역, 국가, 전체). 권역만 계정은 뺀다(현행 resolveProperties 는 권역을 풀지 않고, 백엔드는 Q10 전개: 알려진 좁힘)
GA4_ACCOUNTS = [
    ("현대 N", "hq", ["Hyundai"], [], ["HYUNDAI-N"], False),
    ("현대 N country 역할", "country", ["Hyundai"], [], ["HYUNDAI-N"], False),
    ("현대 N+KR", "hq", ["Hyundai"], [], ["HYUNDAI-N", "KR"], False),
    ("CPO+US 북미", "country", ["Hyundai"], ["hyundai-north-america"], ["CPO", "US"], False),
    ("WW 현대", "hq", ["Hyundai"], [], ["worldwide"], False),
    ("현대 KR", "hq", ["Hyundai"], [], ["KR"], False),
    ("현대 브랜드만", "hq", ["Hyundai"], [], [], False),
    ("EU·DE·US + 현대 유럽(website 교집합이 US 를 빼는 계정)", "region", ["Hyundai"], ["hyundai-europe"], ["EU", "DE", "US"], False),
    ("admin", "admin", [], [], [], True),
]


def _front_resolve_properties(brands: list[str], countries: list[str], all_: bool, geo: list[str] | None = None) -> set[tuple[str, str]]:
    """현행 lib/ga4/property-map.ts resolveProperties(scope, {region: geography}): pickSet(필터, 계정 scope 원값) 브랜드·국가(정확 일치)."""
    def pick(f: list[str] | None, lst: list[str] | None) -> set[str] | None:
        if f and lst:
            return {v for v in f if v in lst}
        if f:
            return set(f)
        return set(lst) if lst else None
    b = pick(None, None if all_ else brands)
    c = pick(geo, None if all_ else countries)
    return {(mb, mc) for mb, mc in GA4_MARKETS if (b is None or mb in b) and (c is None or mc in c)}


def _registry() -> list[dict]:
    return [{"brand_code": b, "country_code": c, "status": "active", "property_id": GA4_PID[(b, c)]} for b, c in GA4_MARKETS]


@needs_db
@pytest.mark.parametrize("name,role,brands,regions,countries,all_", GA4_ACCOUNTS, ids=[a[0] for a in GA4_ACCOUNTS])
async def test_f1_ga4_markets_use_account_countries(name, role, brands, regions, countries, all_):
    """검증 F1: GA4 시장(조회 resolve_markets·이벤트 인가 scope_markets) = 현행 resolveProperties(계정 원값 brands·countries). 전용 사이트 계정의
    글로벌 시장(US·KR)이나 website 사이트 국가(KR·worldwide)·사이트 브랜드(Hyundai N)로 넓히지 않는다. global·website 두 표면, 요청 geography 없음."""
    from app.core.filters import CommonFilters, resolve_read_context
    from app.features.analytics.funnel.conversion.service import SUPPORT, resolve_markets, scope_markets

    refs, _ = await _refs_with_n_sites()
    p = principal_from_row(_row(role, all_, brands, regions, countries, None))
    want = {(b, c.upper()) for b, c in _front_resolve_properties(brands, countries, all_)}
    for surface in ("global", "website"):
        ctx = await resolve_read_context(None, p, CommonFilters(surface=surface), support=SUPPORT, refs=refs, surface_gate=False)
        got = {(m["brand"], m["country"]) for m in resolve_markets(ctx, _registry(), []) if (m["brand"], m["country"]) in
               {(b, c.upper()) for b, c in GA4_MARKETS}}
        scoped = {(m["brand"], m["country"]) for m in scope_markets(ctx, _registry(), []) if m["property_id"] in set(GA4_PID.values())}
        assert got == want, (name, surface, got, want)
        assert scoped == want, (name, surface, scoped)


@needs_db
async def test_f1_ga4_request_geography_meets_account_countries():
    """요청 geography 가 있으면 요청 ∩ 계정 원값(현행 pickSet). 현대 N+KR 계정 global country=US → 없음(US 는 글로벌 표면 스코프 안이지만 계정 원값
    밖), country=KR → (Hyundai, KR). CPO+US 계정 global 요청 없음 → (Hyundai, CPO)·(Hyundai, US)(현행과 같이 계정 원값)."""
    from app.core.filters import CommonFilters, resolve_read_context
    from app.features.analytics.funnel.conversion.service import SUPPORT, resolve_markets

    refs, _ = await _refs_with_n_sites()
    nkr = principal_from_row(_row("hq", False, ["Hyundai"], [], ["HYUNDAI-N", "KR"], None))

    async def markets(p, surface: str, country: list[str] | None = None) -> set[tuple[str, str]]:  # noqa: ANN001
        f = CommonFilters(surface=surface, country=country or [])
        ctx = await resolve_read_context(None, p, f, support=SUPPORT, refs=refs, surface_gate=False)
        return {(m["brand"], m["country"]) for m in resolve_markets(ctx, _registry(), []) if m.get("property_id") in set(GA4_PID.values())}
    assert await markets(nkr, "global", ["US"]) == set() == {(b, c.upper()) for b, c in _front_resolve_properties(["Hyundai"], ["HYUNDAI-N", "KR"], False, ["US"])}
    assert await markets(nkr, "global", ["KR"]) == {("Hyundai", "KR")}
    cpo = principal_from_row(_row("country", False, ["Hyundai"], ["hyundai-north-america"], ["CPO", "US"], None))
    assert await markets(cpo, "global") == {("Hyundai", "CPO"), ("Hyundai", "US")}


@needs_db
@pytest.mark.parametrize("role", ["hq", "country"])
async def test_f1_events_authorization_api(client_as, db_v212, role):
    """검증 F1 재현: 현대 N 계정이 GET /v1/funnel/conversion/events?surface=global&property_id=<현대 KR·US 속성> → 404(현행 scopePropertyIds 밖),
    website 도 같다. 현대 N+KR 계정은 현대 US 속성 404, 현대 KR 속성 200(현행과 같다, 편집 가능 = 역할 hq·country 이고 등록 속성).
    조회 GET /v1/funnel/conversion 의 coverage.markets 에도 현대 KR·US·Hyundai N KR·worldwide 가 없다(현대 N)."""
    ga4 = Rows("app.ga4_property", [{"property_id": pid, "brand_code": b, "country_code": c, "status": "active"} for (b, c), pid in GA4_PID.items()])
    n = _acct(role, [], ["HYUNDAI-N"], None)
    nkr = _acct(role, [], ["HYUNDAI-N", "KR"], None)
    got: dict = {}
    async with staged(ga4, Rows("app.user_account", [n, nkr]), actor=SYSTEM):
        for who, acct in (("n", n), ("nkr", nkr)):
            async with client_as(acct["user_id"]) as c:
                for surface in ("global", "website"):
                    for mk in (("Hyundai", "KR"), ("Hyundai", "US"), ("Hyundai N", "KR")):
                        r = await c.get("/v1/funnel/conversion/events", params={"surface": surface, "property_id": GA4_PID[mk]})
                        got[(who, surface, mk)] = (r.status_code, r.json()["data"]["can_edit"] if r.status_code == 200 else None)
                    cv = await c.get("/v1/funnel/conversion", params={"surface": surface})
                    assert cv.status_code == 200, cv.text[:300]
                    got[(who, surface, "markets")] = {(m["brand"], m["country"]) for m in cv.json()["data"]["coverage"]["markets"]
                                                      if m.get("property_id") in set(GA4_PID.values())}
    for surface in ("global", "website"):
        assert got[("n", surface, ("Hyundai", "KR"))] == got[("n", surface, ("Hyundai", "US"))] == (404, None), (surface, got)
        assert got[("n", surface, ("Hyundai N", "KR"))] == (404, None)
        assert got[("n", surface, "markets")] == set()
        assert got[("nkr", surface, ("Hyundai", "US"))] == (404, None)
        assert got[("nkr", surface, ("Hyundai", "KR"))] == (200, True)
        assert got[("nkr", surface, "markets")] == {("Hyundai", "KR")}


# website 옵션 합성 행: 사이트 → 언어(KR 사이트 = ko·en, 그 밖 en)
def _site_langs(country: str) -> list[str]:
    return ["en", "ko"] if country == "KR" else ["en"]


def _front_website_matrix(brands: list[str], regions: list[str], countries: list[str], all_: bool, refs, rhq_iso: set[str]  # noqa: ANN001
                          ) -> tuple[set[tuple[str, str, str]], set[str]]:
    """현행 listWebsiteScopeMatrix(website-sites.ts:215-255)·listWebsiteCountries(:258-283): 스코프 사이트 행 → withWebsiteBrandGeoCombos(가상 코드 행
    덧붙임) → 전용 사이트 계정이면 국가 = 전용 코드만, 사이트 브랜드 = 모 브랜드. 국가 목록 = 사이트 국가 ∪ 스코프 사이트 브랜드의 가상 코드(같은 필터)."""
    sites = _front_website_sites(brands, regions, countries, all_, refs, rhq_iso)
    rows = {(b, c, lang) for b, c in sites for lang in _site_langs(c)}
    combos = set(rows) | {(b, code, lang) for code, vb in _FRONT_BRAND_GEO.items() for b, _, lang in rows if b == vb}
    codes = {c for _, c in sites} | {code for code, vb in _FRONT_BRAND_GEO.items() if any(b == vb for b, _ in sites)}
    dedicated = [] if all_ else _front_dedicated(countries)
    if not dedicated:
        return combos, codes
    parent = {"Hyundai N": "Hyundai"}
    return ({(parent.get(b, b), r, lang) for b, r, lang in combos if r in dedicated}, {c for c in codes if c in dedicated})


@needs_db
@pytest.mark.parametrize("name,brands,regions,countries,all_", SITE_ACCOUNTS, ids=[a[0] for a in SITE_ACCOUNTS])
async def test_f2_website_options_equal_front(name, brands, regions, countries, all_):
    """검증 F2: GET /v1/filters/options?surface=website 의 매트릭스·국가 옵션 = 현행. 현대 N 계정 = 국가 HYUNDAI-N 만, 매트릭스 브랜드 = 모 브랜드
    Hyundai(사이트 행의 KR·worldwide 는 옵션이 아니다). 전용 사이트 계정이 아니면 종전 그대로."""
    from app.core.filters import CommonFilters, resolve_read_context
    from app.features.analytics.filters.options.service import OPTIONS_SUPPORT, build_matrix
    from tests.core.test_scope_parent import _rhq_iso

    refs, by_key = await _refs_with_n_sites()
    p = principal_from_row(_row("admin" if all_ else "hq", all_, brands, regions, countries, None))
    ctx = await resolve_read_context(None, p, CommonFilters(surface="website"), support=OPTIONS_SUPPORT, refs=refs, surface_gate=False)
    eng = next(iter(refs.engines.values()))[0]
    rows = [{"project_key": k, "geo_key": 0, "lang_key": refs.langs[lang], "cat_mask": 0, "engine_key": eng}
            for k in ctx.project_keys if k in by_key for lang in _site_langs(by_key[k][1])]
    matrix, regions_out, _, _ = build_matrix(ctx, rows)
    want_matrix, want_codes = _front_website_matrix(brands, regions, countries, all_, refs, _rhq_iso(refs))
    assert {(m.brand, m.region.upper(), m.lang) for m in matrix} == {(b, r.upper(), lang) for b, r, lang in want_matrix}, name
    assert {r.code.upper() for r in regions_out} == {c.upper() for c in want_codes}, name


@needs_db
async def test_website_catalog_n_account_sees_n_site_prompts(client_as, db_v212):
    """웹사이트 프롬프트 카탈로그(GET /v1/prompts surface=website, _scoped_sites = DataScope.site_allowed): 현대 N 계정은 현대 N 사이트 프롬프트만,
    현대 국가 계정은 본사 사이트만(현행 listWebsitePromptRows 의 websiteBrandCondition ∧ websiteScopeCountryCondition). 사이트 (브랜드, 국가)는
    다른 시험 시드와 겹치지 않는 값."""
    n_site, h_site = uuid.uuid4(), uuid.uuid4()
    sites = Rows("app.website_site", [{"site_id": n_site, "brand_code": "Hyundai N", "country_code": "worldwide"},
                                      {"site_id": h_site, "brand_code": "Hyundai", "country_code": "MX"}])
    prompts = Rows("app.website_prompt", [
        {"website_prompt_id": uuid.uuid4(), "site_id": s, "file_seq": 1, "domain": d, "lang_code": "en", "seq_no": 1,
         "target_url": f"https://{d}/a", "prompt_text": f"s1bec probe {d}"}
        for s, d in ((n_site, "n.s1bec.example"), (h_site, "mx.s1bec.example"))])
    n = _acct("hq", [], ["HYUNDAI-N"], None)
    hy = _acct("hq", [], ["MX"], None)
    got = {}
    async with staged(sites, prompts, Rows("app.user_account", [n, hy]), actor=SYSTEM):
        for who, acct in (("n", n), ("hy", hy)):
            async with client_as(acct["user_id"]) as c:
                r = await c.get("/v1/prompts", params={"surface": "website", "search": "s1bec probe"})
            assert r.status_code == 200, r.text[:300]
            got[who] = sorted(i["prompt_text"] for i in r.json()["data"]["items"])
    assert got == {"n": ["s1bec probe n.s1bec.example"], "hy": ["s1bec probe mx.s1bec.example"]}, got
