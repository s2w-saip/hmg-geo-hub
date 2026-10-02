"""website 표면 계정 국가 스코프(현행 front 패리티).

core 9라운드: 도시 의사 코드 scopeParent(front lib/geo-catalog/pseudo-country.ts:31-51·:73-83 withPseudoCountries).
core 10라운드(제품 결정 2, 2026-09-30): 웹사이트 표면만 현행 교집합 규칙. front 정본 = hmg-geo main 2670a16
lib/db/repositories/website-sites.ts effectiveCountries(c52a60d 가상 코드 교집합 통과·빈 교집합 fail-closed, #326·#328 전용 사이트 코드)와
lib/scope/website-virtual-geo.ts(WEBSITE_DEDICATED_SITE_CODES·WEBSITE_BRAND_GEO_CODES). 아래 _front_* 로 한 줄씩 옮겨, 같은 계정·같은 사이트
목록에서 백엔드 website 사이트 선택(ReadContext.project_keys)과 요청 국가 축 판정이 정확히 같은지 본다. global·project 표면은 Q10 그대로.
"""
from __future__ import annotations

import dataclasses
import uuid

import pytest

from app.core.auth import WEBSITE_SCOPE_PARENT, DataScope, Principal
from app.core.codes import Country, ProjectDim, load_refs
from app.core.filters import CommonFilters, FilterSupport, resolve_read_context
from tests.support import needs_db, staged

# front pseudo-country.ts:31-51 그대로(scopeParent 있는 것만 의미가 있다)
_FRONT_PSEUDO = {"SA-Dammam": "SA", "SA-Jeddah": "SA", "SA-Riyadh": "SA", "CN-BJ": None}
SUPPORT = FilterSupport.of(website=("brand", "country"))
SITES = [("Genesis", "SA"), ("Genesis", "SA-Dammam"), ("Genesis", "SA-Jeddah"), ("Genesis", "SA-Riyadh"), ("Genesis", "AE"),
         ("Hyundai", "CN"), ("Hyundai", "CN-BJ"), ("Hyundai", "worldwide"), ("Hyundai", "KR"),
         ("Hyundai", "CPO"), ("Hyundai", "US"), ("Hyundai", "MIDDLEEAST"), ("Hyundai", "AE"), ("Hyundai", "SA"),
         ("Genesis", "MIDDLEEAST"), ("Hyundai", "EU"), ("Hyundai", "DE"), ("Hyundai", "FR"), ("Genesis", "worldwide")]
# front lib/scope/website-virtual-geo.ts(main 2670a16): 전용 사이트 코드 = worldwide·CPO + 브랜드 가상 코드(HYUNDAI-N)
_FRONT_BRAND_GEO = {"HYUNDAI-N": "Hyundai N"}
_FRONT_DEDICATED = ["worldwide", "CPO", *_FRONT_BRAND_GEO]


def _front_with_pseudo(countries: list[str]) -> list[str]:
    """withPseudoCountries(pseudo-country.ts:73-83): 순서 보존, scopeParent 가 목록에 있는 의사 코드를 뒤에 덧붙인다(정확 일치)."""
    out, seen = list(countries), set(countries)
    for code, parent in _FRONT_PSEUDO.items():
        if parent and parent in seen and code not in seen:
            out.append(code)
            seen.add(code)
    return out


def _front_effective(countries: list[str], region_countries: list[str] | None, rhq_iso: set[str] | None = None) -> list[str] | None:
    """effectiveCountries(website-sites.ts, main 2670a16): 전용 사이트 코드 → 그 코드만 / 권역·국가 둘 다 → ISO(RHQ 유니버스)는 권역 교집합,
    사이트 가상 코드(RHQ 밖, 브랜드 가상 코드 아님)는 통과 / 한쪽만 → 그쪽 / 끝에 withPseudoCountries. region_countries None = 권역 없음."""
    dedicated = [c for c in countries if c in _FRONT_DEDICATED]
    if dedicated:
        return dedicated
    explicit = countries or None
    if region_countries is None:
        base = explicit
    elif explicit is None:
        base = region_countries
    else:
        iso = rhq_iso or set()
        base = ([c for c in explicit if c in iso and c in region_countries]
                + [c for c in explicit if c not in iso and c not in _FRONT_BRAND_GEO])
    return _front_with_pseudo(base) if base is not None else base


def _rhq_iso(refs) -> set[str]:
    """front ALL_RHQ_COUNTRIES(RHQ 맵 전 국가) = app.rhq_region_country 전 코드."""
    return {c for _, cc in refs.rhq.values() for c in cc}


def test_mapping_matches_front_constant():
    assert {k.upper(): v for k, v in _FRONT_PSEUDO.items() if v} == WEBSITE_SCOPE_PARENT


def test_for_surface_unit():
    ds = DataScope(False, ("Genesis",), ("SA",), ())
    assert ds.for_surface("website").countries == ("SA", "SA-DAMMAM", "SA-JEDDAH", "SA-RIYADH")
    assert ds.for_surface("global") is ds and ds.for_surface("project") is ds
    for none_or_empty in (DataScope(True, None, None, ()), DataScope(False, None, (), ())):
        assert none_or_empty.for_surface("website") is none_or_empty
    only_city = DataScope(False, ("Genesis",), ("SA-RIYADH",), ())
    assert only_city.for_surface("website") is only_city                       # 도시만 가진 계정은 모국·다른 도시를 얻지 않는다
    cn = DataScope(False, ("Hyundai",), ("CN",), ())
    assert cn.for_surface("website") is cn                                        # CN-BJ 는 scopeParent 없음(전용 계정만)


def _principal(countries: list[str], regions: list[str], role: str = "country") -> Principal:
    return Principal(user_id=uuid.uuid4(), email="t@example.test", role=role, operator="none", scope_all=False,  # type: ignore[arg-type]
                     scope_brands=("Hyundai", "Genesis"), scope_regions=tuple(regions), scope_countries=tuple(countries),
                     menu_groups=None, is_qa_reviewer=False)


async def _refs_with_sites():
    """실제 참조 차원 + 합성 사이트 프로젝트(SITES). 없는 의사 코드는 국가 차원에도 더한다(적재기라면 dim_country 에 생길 행)."""
    async with staged() as conn:
        refs = await load_refs(conn)
    countries = dict(refs.countries)
    nxt = max(c.geo_key for c in countries.values()) + 1
    for _, code in SITES:
        if code.upper() not in countries:
            kind = "iso" if len(code) == 2 else "pseudo"
            countries[code.upper()] = Country(nxt, code, kind, None, None, False)
            nxt += 1
    pk = max(p.project_key for p in refs.projects) + 1
    bit = {b.code: b.bit for b in refs.brands}
    sites = []
    for i, (brand, code) in enumerate(SITES):
        sites.append(ProjectDim(pk + i, 2, False, None, str(uuid.uuid4()), bit[brand], countries[code.upper()].geo_key))
    refs2 = dataclasses.replace(refs, countries=countries, projects=tuple(p for p in refs.projects if p.surface != 2) + tuple(sites))
    by_key = {s.project_key: SITES[i] for i, s in enumerate(sites)}
    return refs2, by_key


def _visible(ctx, by_key) -> set[tuple[str, str]]:
    return {by_key[k] for k in ctx.project_keys if k in by_key}


CASES = [
    # (이름, 계정 국가, 계정 권역)
    ("SA 국가 계정", ["SA"], []),
    ("중동 권역 계정(제네시스)", [], ["genesis-middle-east"]),
    ("국가 ⊆ 권역(SA·AE)", ["SA", "AE"], ["genesis-middle-east"]),
    ("리야드만", ["SA-Riyadh"], []),
    ("CN 국가 계정", ["CN"], []),
    ("CN-BJ 전용(국가만)", ["CN-BJ", "CN"], []),
    ("worldwide·KR(권역 없음, 전용 사이트 코드)", ["worldwide", "KR"], []),
    # 결정 2 대상 5계정 형태(stg 실측 2026-09-30, 역할·브랜드는 _principal 고정. ISO 는 일부만)
    ("21dad652 CN-BJ·CN + 현대 아태", ["CN-BJ", "CN"], ["hyundai-asia-pacific"]),
    ("920e21cb CPO·US + 현대 북미(전용 사이트 코드)", ["CPO", "US"], ["hyundai-north-america"]),
    ("78a9ecb7 MIDDLEEAST·AE·SA + 현대 중동", ["MIDDLEEAST", "AE", "SA"], ["hyundai-middle-east"]),
    ("e66a3945 MIDDLEEAST·AE·SA + 제네시스 중동", ["MIDDLEEAST", "AE", "SA"], ["genesis-middle-east"]),
    ("a66a4e12 EU·DE·FR + 현대 유럽", ["EU", "DE", "FR"], ["hyundai-europe"]),
    # 권역 밖 ISO 는 교집합에서 탈락(front aa57bda AND 의미론 유지)
    ("권역 밖 ISO(US) + 가상 코드 + 현대 유럽", ["EU", "DE", "US"], ["hyundai-europe"]),
    ("CPO 만(권역 없음, 2026-09-29 운영 사양)", ["CPO"], []),
]


@needs_db
@pytest.mark.parametrize("name,countries,regions", CASES, ids=[c[0] for c in CASES])
async def test_website_sites_equal_front(name, countries, regions):
    """사이트 선택 = front effectiveCountries 로 고른 사이트 집합(브랜드 스코프 = Hyundai·Genesis, 브랜드 가상 코드 계정은 따로)."""
    refs, by_key = await _refs_with_sites()
    p = _principal(countries, regions)
    ctx = await resolve_read_context(None, p, CommonFilters(surface="website"), support=SUPPORT, refs=refs, surface_gate=False)
    rc = sorted(refs.region_countries(regions)) if regions else None
    eff = _front_effective(countries, rc, _rhq_iso(refs))
    assert eff is None or eff, (name, eff)                                        # 빈 교집합 계정은 이 목록에 넣지 않는다(아래 따로)
    want = {s for s in SITES if eff is None or s[1] in eff}
    assert _visible(ctx, by_key) == want, (name, eff)
    # 요청 국가 축: 도시·가상·ISO 코드를 고르면 front(narrowGeoToScope ∩ scopeCountries)와 같이 남거나 버려진다
    for code in ("SA-Dammam", "SA-Riyadh", "CN-BJ", "CPO", "US", "EU", "worldwide"):
        c2 = await resolve_read_context(None, p, CommonFilters(surface="website", country=[code]), support=SUPPORT, refs=refs, surface_gate=False)
        dropped = code in (c2.dropped_filters.get("country") or ())
        assert dropped == (eff is not None and code not in eff), (name, code, eff)


@needs_db
async def test_global_surface_unchanged_by_scope_parent():
    """표준(global) 은 도시 코드를 더하지 않는다(front standard-filters 는 effectiveScopeCountries 만)."""
    refs, _ = await _refs_with_sites()
    ctx = await resolve_read_context(None, _principal(["SA"], []), CommonFilters(surface="global"), support=FilterSupport.of(global_=("country",)), surface_gate=False,
                                     refs=refs)
    assert ctx.scope.countries == ("SA",)


@needs_db
async def test_decision2_website_narrowed_global_unchanged():
    """결정 2(2026-09-30): 웹사이트 표면만 현행 교집합 규칙. Q10(직접 국가 우선) 때 백엔드가 넓게 보던 사이트가 website 에서 빠지고
    global 스코프는 Q10 그대로다. 단 전용 사이트 계정의 global 은 동기화 S1 BE-6(hmg-geo #328 effectiveScopeCountries)을 따른다:
    CPO·US 계정 website = CPO 사이트만(US 사이트 제외), global = (US)(전용 코드 CPO 는 글로벌 시장이 없어 빠진다).
    권역 밖 ISO: website 에서 탈락, global 은 유지. CN-BJ·EU·MIDDLEEAST 가상 코드는 현행(c52a60d)도 통과라 보인다."""
    refs, by_key = await _refs_with_sites()
    hy = {"Hyundai"}
    cpo = _principal(["CPO", "US"], ["hyundai-north-america"])
    w = await resolve_read_context(None, cpo, CommonFilters(surface="website"), support=SUPPORT, refs=refs, surface_gate=False)
    assert {s for s in _visible(w, by_key) if s[0] in hy} == {("Hyundai", "CPO")}
    g = await resolve_read_context(None, cpo, CommonFilters(surface="global"), support=FilterSupport.of(global_=("country",)), refs=refs,
                                   surface_gate=False)
    assert g.scope.countries == ("US",)           # #328 규칙. 종전 (CPO, US) 와 데이터 같음: 글로벌 답변 국가는 ISO 라 CPO 와 맞는 답변이 없다
    eu = _principal(["EU", "DE", "US"], ["hyundai-europe"])
    w = await resolve_read_context(None, eu, CommonFilters(surface="website"), support=SUPPORT, refs=refs, surface_gate=False)
    assert {s for s in _visible(w, by_key) if s[0] in hy} == {("Hyundai", "EU"), ("Hyundai", "DE")}
    g = await resolve_read_context(None, eu, CommonFilters(surface="global"), support=FilterSupport.of(global_=("country",)), refs=refs,
                                   surface_gate=False)
    assert g.scope.countries == ("DE", "EU", "US")
    bj = _principal(["CN-BJ", "CN"], ["hyundai-asia-pacific"])
    w = await resolve_read_context(None, bj, CommonFilters(surface="website"), support=SUPPORT, refs=refs, surface_gate=False)
    assert {("Hyundai", "CN-BJ"), ("Hyundai", "CN")} <= _visible(w, by_key)


@needs_db
async def test_empty_intersection_is_denied_not_opened():
    """교집합이 비면(권역 밖 ISO 만) website 는 거부(403 no_country_scope). front 는 0 사이트(빈 화면)라 둘 다 아무것도 보이지 않는다.
    front 옛 결함(교집합이 비면 국가 조건을 빼 브랜드 전 사이트를 연다, 7639b9e website-sites.ts:85-86)은 따르지 않는다."""
    from app.core import errors

    refs, _ = await _refs_with_sites()
    p = _principal(["US"], ["hyundai-europe"])
    assert _front_effective(["US"], sorted(refs.region_countries(["hyundai-europe"])), _rhq_iso(refs)) == []
    with pytest.raises(errors.ApiError) as ei:
        await resolve_read_context(None, p, CommonFilters(surface="website"), support=SUPPORT, refs=refs, surface_gate=False)
    assert ei.value.status == 403 and ei.value.code == "no_country_scope"
    g = await resolve_read_context(None, p, CommonFilters(surface="global"), support=FilterSupport.of(global_=("country",)), refs=refs,
                                   surface_gate=False)
    assert g.scope.countries == ("US",)                                           # global 은 Q10 그대로


@needs_db
async def test_brand_geo_dedicated_account_sees_no_hq_sites():
    """브랜드 가상 코드(HYUNDAI-N) 전용 계정: website 국가 스코프 = (HYUNDAI-N,)(전용 코드만). 사이트는 사이트 브랜드 'Hyundai N' 으로 열린다
    (동기화 S1 BE-8: DataScope.site_allowed, 현행 websiteScopeBrands·splitWebsiteGeo, 대조 시험 tests/core/test_sync_s1_auth.py).
    이 합성 목록(SITES)에는 현대 N 사이트가 없어 0 사이트다: 현대 본사 KR·worldwide 사이트로 넓어지지 않는다."""
    refs, by_key = await _refs_with_sites()
    n = _principal(["HYUNDAI-N"], [])
    ds = DataScope.of(n, refs).for_surface("website")
    assert ds.countries == ("HYUNDAI-N",)
    ctx = await resolve_read_context(None, n, CommonFilters(surface="website"), support=SUPPORT, refs=refs, surface_gate=False)
    assert _visible(ctx, by_key) == set()


@needs_db
async def test_by_scope_site_visibility_uses_same_rule():
    """GET /v1/projects/by-scope/{id} 사이트 분기(website_site_visible)도 분석 읽기 website 와 같은 규칙(SA → SA-* 도시 사이트)."""
    from app.features.projects.project.core.service import website_site_visible

    refs, _ = await _refs_with_sites()
    p = dataclasses.replace(_principal(["SA"], []), role="region")
    assert website_site_visible(p, refs, "Genesis", "SA-Dammam") and website_site_visible(p, refs, "Genesis", "SA-Riyadh")
    assert not website_site_visible(p, refs, "Genesis", "AE")
    cn = dataclasses.replace(_principal(["CN"], []), role="region")
    assert not website_site_visible(cn, refs, "Hyundai", "CN-BJ")
