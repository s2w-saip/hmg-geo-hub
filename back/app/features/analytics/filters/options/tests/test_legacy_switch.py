"""현행 프로필 filter_options(F1W4, WU-8, 제품 결정 19·25) 라우트 시험(로컬 개발 DB) + 권한 레드팀.

현행 규칙(hmg-geo 2670a16 + read_screens 14키, 축 on)과 픽스처 손 계산(tests/fixtures/fixture-10-data.sql, 글로벌 스냅샷 = 회차 11·09-14):
  rd.job 회차 11: k1·k2·k9(US en 5 chatgpt·gemini·chatgpt), k3(US ko 1, 한국어 비-KR → elig 거짓), k4(KR ko 1), k5(DE en 2 Kia, 시장 태그 {US}
  → elig 거짓), k6(루트 카탈로그 밖), k7(ID 숨김), k8(US en 5 deepseek = 기본 엔진 아님), k10~k12(US en 8 = HMG), k13(pending), k14(드롭),
  k15(US en 5, run 상태로 elig 거짓).
  - 현행 매트릭스(listMeasuredScopeMatrix): completed ∧ 루트 카탈로그 ∧ 기본 엔진 ∧ 숨김 제외, 지역 스코핑·run 상태 없음
    → (Hyundai,US,en)(Genesis,US,en)(Hyundai,US,ko)(Hyundai,KR,ko)(Kia,DE,en)(null,US,en).
  - 현행 국가(listMeasuredRegions): 위 + 상태 무관 → 실패 답변만 있는 국가도 나온다(아래 FR 준비 행).
  - 엔진 = 정적 [chatgpt, gemini](기본 엔진). deepseek 은 나오지 않는다.
  웹사이트: 등록 사이트 Kia DE(프롬프트 de)·Genesis SA-Dammam(프롬프트 없음, 측정 없음) → 국가 DE·SA-Dammam, 매트릭스 (Kia,DE,de).
권한(스코프 교집합) 레드팀: 스위치가 켜져도 스코프 밖 국가·브랜드는 어느 목록(geo_matrix·regions·languages)에도 없다.
"""
from __future__ import annotations

import pathlib
import uuid

import pytest

from app.core.config import set_settings
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    VENDOR,
    WEBSITE_KIA,
    Sql,
    load_named_sql,
    needs_db,
    raw_fetch,
    staged,
)

URL = "/v1/filters/options"
M = load_named_sql(pathlib.Path(__file__).with_name("mutations.pgsql"))
LEGACY_ADMIN_GLOBAL = {("Hyundai", "US", "en"), ("Genesis", "US", "en"), ("Hyundai", "US", "ko"), ("Hyundai", "KR", "ko"),
                       ("Kia", "DE", "en"), (None, "US", "en")}
DEFAULT_ENGINES = [{"code": "chatgpt", "is_default": True}, {"code": "gemini", "is_default": True}]
# app.rhq_region_country kia-western-europe(픽스처): JP·US·KR 은 밖, DE·FR 은 안
KIA_WEST_EUROPE = {"AT", "BE", "CH", "CZ", "DE", "DK", "ES", "FI", "FR", "GB", "GR", "HU", "IE", "IS", "IT", "LU", "MT", "NL", "NO", "PL",
                   "PT", "SE", "SK"}


@pytest.fixture
def legacy(settings):
    def on(spec: str) -> None:
        set_settings(settings.model_copy(update={"legacy_profile": spec}))
    yield on
    set_settings(settings)


def _combos(j: dict) -> set[tuple]:
    return {(x["brand"], x["region"], x["lang"]) for x in j["data"]["geo_matrix"]}


def _codes(xs: list[dict]) -> list[str]:
    return [x["code"] for x in xs]


def _all_regions(j: dict) -> set[str]:
    d = j["data"]
    return set(_codes(d["regions"])) | {x["region"] for x in d["geo_matrix"]}


def _all_brands(j: dict) -> set[str | None]:
    return {x["brand"] for x in j["data"]["geo_matrix"]}


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _steps(*stmts: tuple) -> list[Sql]:
    return [Sql(M["actor"]), *(Sql(s[0], tuple(s[1:])) for s in stmts)]


# ── 글로벌 ───────────────────────────────────────────────────────────────────
@needs_db
async def test_global_admin_snapshot(client_as, legacy):
    off = (await _get(client_as, ADMIN, surface="global")).json()
    legacy("filter_options")
    j = (await _get(client_as, ADMIN, surface="global")).json()
    d = j["data"]
    assert _combos(j) == LEGACY_ADMIN_GLOBAL
    assert _codes(d["regions"]) == ["DE", "KR", "US"] and d["languages"] == ["en", "ko"]
    assert d["engines"] == DEFAULT_ENGINES                                  # deepseek(k8) 없음: 정적 목록
    assert "ID" not in _all_regions(j)                                      # 숨김 표준 국가는 그대로 뺀다
    assert j["meta"]["suppressed"] == {} and j["meta"]["as_of"] == off["meta"]["as_of"]
    # 매트릭스 밖 필드는 새 정의와 같다(카탈로그·출처 카테고리)
    assert d["catalog"] == off["data"]["catalog"] and d["source_categories"] == off["data"]["source_categories"]


@needs_db
async def test_global_off_is_unchanged(client_as, legacy):
    """스위치 꺼짐(off)과 다른 스위치만 켜짐은 옵션 응답이 도입 전과 같다(새 정의: cit_in·전 엔진)."""
    base = (await _get(client_as, ADMIN, surface="global")).json()
    legacy("compare_epoch_gate")
    other = (await _get(client_as, ADMIN, surface="global")).json()
    assert base == other
    assert {x["code"] for x in base["data"]["engines"]} == {"chatgpt", "gemini", "deepseek"}


@needs_db
async def test_global_failed_only_country_and_period(client_as, legacy):
    """실패 답변만 있는 국가(FR, 현대 1)는 국가 목록에는 나오고 매트릭스에는 없다(현행 listMeasuredRegions 대 listMeasuredScopeMatrix).
    기간 창(09-01~09-30)은 회차 10 행을 더한다(값 변화 없음: 회차 10 도 US en)."""
    legacy("filter_options")
    async with staged(*_steps((M["legacy_job_ins"], 9801, "FR", 2, 1, 1))), client_as(ADMIN) as c:
        j = (await c.get(URL, params={"surface": "global"})).json()
        per = (await c.get(URL, params={"surface": "global", "from": "2026-09-01", "to": "2026-09-30"})).json()
    assert "FR" in _codes(j["data"]["regions"]) and "FR" not in {x["region"] for x in j["data"]["geo_matrix"]}
    assert _combos(j) == LEGACY_ADMIN_GLOBAL
    assert per["meta"]["mode"] == "cumulative" and per["meta"]["cycles"] == ["2026-09-07", "2026-09-14"]
    assert _combos(per) == LEGACY_ADMIN_GLOBAL and "FR" in _codes(per["data"]["regions"])


@needs_db
async def test_global_non_default_engine_only_country_not_offered(client_as, legacy):
    """현행 옵션 창은 기본 엔진 답변만(anchorDefaultEngineScope). deepseek 만 실패로 잰 국가(BR)는 국가 목록에도 없다."""
    legacy("filter_options")
    async with staged(*_steps((M["legacy_job_ins"], 9802, "BR", 2, 1, 3))), client_as(ADMIN) as c:
        j = (await c.get(URL, params={"surface": "global"})).json()
    assert "BR" not in _all_regions(j)


@needs_db
async def test_global_empty_window_keeps_static_engines(client_as, legacy):
    legacy("filter_options")
    j = (await _get(client_as, ADMIN, surface="global", **{"from": "2020-01-01", "to": "2020-01-31"})).json()
    assert j["data"]["geo_matrix"] == [] and j["data"]["regions"] == []
    assert j["data"]["engines"] == DEFAULT_ENGINES
    assert j["meta"]["suppressed"] == {"geo_matrix": "no_cycles_in_period"}                # 출처 카테고리는 include 없으면 계산하지 않는다


# ── 권한 레드팀(글로벌): 스코프 밖 국가·브랜드 0 ─────────────────────────────
@needs_db
async def test_redteam_global_brand_scope(client_as, legacy):
    """현대 계정: 켜짐에서 새로 들어온 행(k5 Kia DE, k3 Hyundai US ko)중 Kia 는 새지 않는다. 실패 국가 FR 도 Kia 행이면 새지 않는다."""
    legacy("filter_options")
    async with staged(*_steps((M["legacy_job_ins"], 9803, "FR", 2, 2, 1))):
        async with client_as(HQ_HYUNDAI) as c:
            j = (await c.get(URL, params={"surface": "global"})).json()
        async with client_as(ADMIN) as c:
            adm = (await c.get(URL, params={"surface": "global"})).json()
    assert _combos(j) == {("Hyundai", "US", "en"), ("Hyundai", "US", "ko"), ("Hyundai", "KR", "ko"), (None, "US", "en")}
    assert _all_regions(j) == {"KR", "US"}                                  # DE(Kia)·FR(Kia 실패) 없음
    assert "Kia" not in str(j["data"]) and "Genesis" not in str(j["data"])
    assert "FR" in _codes(adm["data"]["regions"])                            # 대조: 관리자에게는 보인다(준비 행이 실제로 먹었다)


@needs_db
async def test_redteam_global_country_scope(client_as, legacy):
    """Kia·US 계정: US 공통 행만. Kia·서유럽 계정: 스코프 안 DE(k5 Kia, 새 정의는 elig 거짓이라 없던 행)는 보이고 US 는 없다."""
    legacy("filter_options")
    async with staged(*_steps((M["legacy_job_ins"], 9804, "DE", 2, 2, 1), (M["legacy_job_ins"], 9805, "JP", 2, 2, 1))):
        async with client_as(KIA_US) as c:
            us = (await c.get(URL, params={"surface": "global"})).json()
        async with client_as(KIA_EU) as c:
            eu = (await c.get(URL, params={"surface": "global"})).json()
    assert us["data"]["geo_matrix"] == [{"brand": None, "region": "US", "lang": "en"}] and _all_regions(us) == {"US"}
    assert _combos(eu) == {("Kia", "DE", "en")} and _all_regions(eu) == {"DE"}        # JP(Kia 실패)는 권역 밖
    assert _all_regions(eu) <= KIA_WEST_EUROPE
    assert us["data"]["engines"] == DEFAULT_ENGINES == eu["data"]["engines"]


# ── 웹사이트 ─────────────────────────────────────────────────────────────────
# 기대값은 같은 트랜잭션에서 app.website_site·app.website_prompt 를 드라이버로 직접 읽어 현행 규칙(listWebsiteCountries·listWebsiteScopeMatrix)을
# 따로 계산한다(다른 기능 시험이 커밋해 둔 사이트가 있어도 흔들리지 않게). 가상 코드 HYUNDAI-N ↔ 사이트 브랜드 'Hyundai N'.
S_HUS, S_N, S_KFR = (uuid.UUID(f"d9800000-0000-4000-8000-00000000000{i}") for i in (1, 2, 3))
SITES_SQL = "SELECT s.site_id::text AS sid, s.brand_code, s.country_code FROM app.website_site s"
LANGS_SQL = "SELECT DISTINCT wp.site_id::text AS sid, wp.lang_code FROM app.website_prompt wp"
HIDDEN_SQL = "SELECT upper(country_code) AS cc FROM app.hidden_market WHERE surface = 'website'"
RHQ_SQL = "SELECT country_code FROM app.rhq_region_country WHERE region_id = 'kia-western-europe'"


async def _expected_web(conn, brands: set[str] | None, countries: set[str] | None) -> tuple[list[str], set[tuple], list[str]]:
    sites = [r for r in await raw_fetch(conn, SITES_SQL)
             if (brands is None or r["brand_code"] in brands) and (countries is None or r["country_code"].upper() in countries)]
    hidden = {r["cc"] for r in await raw_fetch(conn, HIDDEN_SQL)}
    sites = [r for r in sites if r["country_code"].upper() not in hidden]
    langs: dict[str, set[str]] = {}
    for r in await raw_fetch(conn, LANGS_SQL):
        langs.setdefault(r["sid"], set()).add(r["lang_code"])
    matrix = {(r["brand_code"], r["country_code"], lang) for r in sites for lang in langs.get(r["sid"], ())}
    regions = {r["country_code"] for r in sites}
    if any(r["brand_code"] == "Hyundai N" for r in sites) and "HYUNDAI-N" not in hidden:
        regions.add("HYUNDAI-N")
        matrix |= {("Hyundai N", "HYUNDAI-N", lang) for b, _, lang in matrix if b == "Hyundai N"}
    return sorted(regions), matrix, sorted({lang for r in sites for lang in langs.get(r["sid"], ())})


def _check(j: dict, exp: tuple[list[str], set[tuple], list[str]], label: str) -> None:
    assert _codes(j["data"]["regions"]) == exp[0], label
    assert _combos(j) == exp[1], label
    assert j["data"]["languages"] == exp[2], label
    assert j["data"]["engines"] == DEFAULT_ENGINES, label


@needs_db
async def test_website_registered_sites(client_as, legacy):
    """새 정의는 측정 사이트(Kia DE)만, 현행은 등록 사이트 전부: 측정·프롬프트 없는 Genesis SA-Dammam(픽스처)도 국가 옵션(kind pseudo)."""
    off = (await _get(client_as, ADMIN, surface="website")).json()
    legacy("filter_options")
    async with staged() as conn:
        exp = await _expected_web(conn, None, None)
        async with client_as(ADMIN) as c:
            j = (await c.get(URL, params={"surface": "website"})).json()
    _check(j, exp, "admin")
    assert "SA-Dammam" in _codes(j["data"]["regions"]) and "SA-Dammam" not in _codes(off["data"]["regions"])
    assert {"code": "SA-Dammam", "area": "Middle East", "kind": "pseudo"} in j["data"]["regions"]
    assert ("Kia", "DE", "de") in _combos(j)
    assert j["meta"]["suppressed"] == {} and j["data"]["catalog"] is None and j["data"]["source_categories"] is None


@needs_db
async def test_website_virtual_code_hidden_market_and_scope(client_as, legacy):
    """등록 사이트를 더한다: Hyundai US(프롬프트 없음), Hyundai N KR(ko), Kia FR(fr).
    - 관리자: 프롬프트 없는 사이트 국가·HYUNDAI-N 가상 코드(국가·매트릭스), app.hidden_market(website, US) 면 US 가 빠진다.
    - 레드팀: WEBSITE_KIA(브랜드 Kia) = Kia 사이트만, KIA_EU = 서유럽 Kia, KIA_US = Kia 의 US 사이트만. 현대·N·Genesis·권역 밖 국가 0."""
    legacy("filter_options")
    steps = _steps((M["legacy_site_ins"], S_HUS, "Hyundai", "US"), (M["legacy_site_ins"], S_N, "Hyundai N", "KR"),
                   (M["legacy_site_ins"], S_KFR, "Kia", "FR"), (M["legacy_site_prompt_ins"], S_N, "ko", 1),
                   (M["legacy_site_prompt_ins"], S_KFR, "fr", 1))
    async with staged(*steps) as conn:
        west = {r["country_code"] for r in await raw_fetch(conn, RHQ_SQL)}
        cases = {"admin": (ADMIN, None, None), "wk": (WEBSITE_KIA, {"Kia"}, None), "eu": (KIA_EU, {"Kia"}, west),
                 "us": (KIA_US, {"Kia"}, {"US"})}
        got, exp = {}, {}
        for name, (uid, brands, countries) in cases.items():
            exp[name] = await _expected_web(conn, brands, countries)
            async with client_as(uid) as c:
                got[name] = (await c.get(URL, params={"surface": "website"})).json()
    async with staged(*steps, Sql(M["website_hidden_us"])) as conn:
        exp_h = await _expected_web(conn, None, None)
        async with client_as(ADMIN) as c:
            hid = (await c.get(URL, params={"surface": "website"})).json()
    for name in cases:
        _check(got[name], exp[name], name)
    adm = _codes(got["admin"]["data"]["regions"])
    assert {"US", "HYUNDAI-N", "FR", "KR"} <= set(adm)                                   # 준비 행이 실제로 먹었다
    assert {("Hyundai N", "KR", "ko"), ("Hyundai N", "HYUNDAI-N", "ko"), ("Kia", "FR", "fr")} <= _combos(got["admin"])
    _check(hid, exp_h, "hidden")
    assert "US" not in _all_regions(hid)
    for name in ("wk", "eu", "us"):                                                      # 레드팀: 브랜드·국가 스코프 밖 0
        assert _all_brands(got[name]) <= {"Kia"}, name
        assert "HYUNDAI-N" not in _all_regions(got[name]) and "KR" not in _all_regions(got[name]), name
    assert _all_regions(got["eu"]) <= west and "FR" in _all_regions(got["eu"]) and "US" not in _all_regions(got["eu"])
    assert _all_regions(got["us"]) <= {"US"}


@needs_db
async def test_route_gates_unchanged(client_as, legacy):
    """표면 경로 게이트는 스위치와 무관: vendor 는 global·website 403, 현대 hq(메뉴 standard·project)는 website 403.
    project 표면은 이 스위치 대상이 아니다(켜짐 = 꺼짐)."""
    off = (await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))).json()
    legacy("filter_options")
    assert (await _get(client_as, VENDOR, surface="global")).status_code == 403
    assert (await _get(client_as, VENDOR, surface="website")).status_code == 403
    assert (await _get(client_as, HQ_HYUNDAI, surface="website")).status_code == 403
    assert (await _get(client_as, WEBSITE_KIA, surface="global")).status_code == 403
    assert (await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))).json() == off


# ── WU-12: 선택 브랜드로 옵션 좁히기(현행 optionScope = narrowScopeBrands(scope, filters.brand)) ────────────────
@needs_db
async def test_global_admin_brand_narrows_regions_and_languages(client_as, legacy):
    """관리자 brand=Kia: 국가 = Kia·공통 행(k5 DE, k10~12 US HMG), 언어도 같은 행. 매트릭스는 계정 스코프 그대로(현행 listMeasuredScopeMatrix(scope)).
    brand=Hyundai: KR·US, 언어 en·ko. 모르는 코드: 공통 행만(US) + dropped_filters(현행은 검증 없이 brand IN (코드, HMG)). 꺼짐이면 brand 무시."""
    off = (await _get(client_as, ADMIN, surface="global", brand="Kia")).json()
    legacy("filter_options")
    kia = (await _get(client_as, ADMIN, surface="global", brand="Kia")).json()
    hy = (await _get(client_as, ADMIN, surface="global", brand="Hyundai")).json()
    bad = (await _get(client_as, ADMIN, surface="global", brand="Zzz")).json()
    base = (await _get(client_as, ADMIN, surface="global")).json()
    assert "brand" in off["meta"]["ignored_filters"] and "DE" not in _codes(off["data"]["regions"])
    assert _codes(kia["data"]["regions"]) == ["DE", "US"] and kia["data"]["languages"] == ["en"]
    assert _combos(kia) == LEGACY_ADMIN_GLOBAL == _combos(base)                     # 매트릭스는 좁히지 않는다
    assert "brand" not in kia["meta"]["ignored_filters"] and kia["meta"]["dropped_filters"] == {}
    assert _codes(hy["data"]["regions"]) == ["KR", "US"] and hy["data"]["languages"] == ["en", "ko"]
    assert _codes(bad["data"]["regions"]) == ["US"] and bad["meta"]["dropped_filters"] == {"brand": ["Zzz"]}
    assert _codes(base["data"]["regions"]) == ["DE", "KR", "US"]
    assert kia["data"]["engines"] == DEFAULT_ENGINES


@needs_db
async def test_global_brand_account_hard_lock(client_as, legacy):
    """브랜드 스코프 계정은 URL brand 를 무시한다(현행 readStandardFilters 하드락 [스코프 브랜드, HMG]): brand=Kia 를 줘도 brand 없는 응답과 같고
    Kia 행(k5 DE)이 새지 않는다(레드팀: 요청 브랜드로 스코프를 넓힐 수 없다)."""
    legacy("filter_options")
    plain = (await _get(client_as, HQ_HYUNDAI, surface="global")).json()
    asked = (await _get(client_as, HQ_HYUNDAI, surface="global", brand="Kia")).json()
    assert asked["data"] == plain["data"] and "brand" in asked["meta"]["ignored_filters"]
    assert "DE" not in _all_regions(asked) and "Kia" not in str(asked["data"])
    us_plain = (await _get(client_as, KIA_US, surface="global")).json()
    us_asked = (await _get(client_as, KIA_US, surface="global", brand="Hyundai")).json()
    assert us_asked["data"] == us_plain["data"] and _all_regions(us_asked) <= {"US"}


@needs_db
async def test_website_admin_brand_narrows_sites(client_as, legacy):
    """웹사이트 관리자 brand=Kia: 국가·매트릭스·언어 모두 Kia 사이트만(현행 listWebsiteCountries/ScopeMatrix/MeasuredLanguages(optionScope)).
    brand=Hyundai 는 현대 사이트만(현대 N 사이트·HYUNDAI-N 가상 코드는 빠진다: websiteScopeBrands 는 국가 가상 코드 없이 N 을 더하지 않는다).
    비관리자(WEBSITE_KIA)는 brand 축을 받지 않는다(website/page.tsx 허용 축): 응답 = brand 없음."""
    legacy("filter_options")
    steps = _steps((M["legacy_site_ins"], S_HUS, "Hyundai", "US"), (M["legacy_site_ins"], S_N, "Hyundai N", "KR"),
                   (M["legacy_site_ins"], S_KFR, "Kia", "FR"), (M["legacy_site_prompt_ins"], S_N, "ko", 1),
                   (M["legacy_site_prompt_ins"], S_KFR, "fr", 1))
    async with staged(*steps) as conn:
        exp_kia = await _expected_web(conn, {"Kia"}, None)
        exp_hy = await _expected_web(conn, {"Hyundai"}, None)
        async with client_as(ADMIN) as c:
            kia = (await c.get(URL, params={"surface": "website", "brand": "Kia"})).json()
            hy = (await c.get(URL, params={"surface": "website", "brand": "Hyundai"})).json()
        async with client_as(WEBSITE_KIA) as c:
            wk = (await c.get(URL, params={"surface": "website"})).json()
            wk_asked = (await c.get(URL, params={"surface": "website", "brand": "Hyundai"})).json()
    _check(kia, exp_kia, "kia")
    _check(hy, exp_hy, "hyundai")
    assert _all_brands(kia) <= {"Kia"} and {"DE", "FR"} <= set(_codes(kia["data"]["regions"]))
    assert "HYUNDAI-N" not in _all_regions(hy) and "US" in _codes(hy["data"]["regions"]) and _all_brands(hy) <= {"Hyundai"}
    assert wk_asked["data"] == wk["data"] and "brand" in wk_asked["meta"]["ignored_filters"]


# ── B095: geo_only(전환 화면 = 국가 옵션만) ─────────────────────────────────────────
@needs_db
@pytest.mark.parametrize(("uid", "params", "spec"), [
    (ADMIN, {"surface": "global"}, None),
    (HQ_HYUNDAI, {"surface": "global"}, None),
    (ADMIN, {"surface": "global"}, "filter_options"),
    (ADMIN, {"surface": "website"}, None),
    (ADMIN, {"surface": "website"}, "filter_options"),
    (VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT)}, None),
])
async def test_geo_only_skips_catalog_and_custom_fields(client_as, legacy, monkeypatch, uid, params, spec):
    """geo_only=true: 카탈로그 택소노미(TAXON·CATALOG)·커스텀 필드 문장을 돌리지 않고 catalog·custom_fields = null.
    geo_matrix·regions·languages·engines·source_categories·meta 는 기본 호출과 같다(현행 프로필 경로 포함)."""
    from app.features.analytics.filters.options import service as S

    if spec:
        legacy(spec)
    seen: list[str] = []
    real = S.fetch_all

    async def spy(conn, sql, *a, **k):
        seen.append(str(sql))
        return await real(conn, sql, *a, **k)

    monkeypatch.setattr(S, "fetch_all", spy)
    skipped = {S.q.TAXON_SQL, S.q.CATALOG_GLOBAL_SQL, S.q.CATALOG_PROJECT_SQL, S.q.CUSTOM_FIELDS_SQL}
    full = (await _get(client_as, uid, **params)).json()
    assert bool(skipped & set(seen)) == (params["surface"] != "website")       # 기본 = 종전(global·project 는 카탈로그 문장)
    seen.clear()
    r = await _get(client_as, uid, **params, geo_only="true")
    assert r.status_code == 200, r.text
    assert not skipped & set(seen), seen
    assert r.json()["data"] == {**full["data"], "catalog": None, "custom_fields": None} and r.json()["meta"] == full["meta"]
