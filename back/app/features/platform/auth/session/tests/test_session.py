"""platform.auth.session(GET /v1/auth/me) 테스트.

기대값은 구현 SQL 이 아니라 계정 시드(tests/support.py ACCOUNTS_SQL) 손계산과 독립 SQL(app.rhq_region_country 직접 조회)로 만든다.
단위 테스트(DB 없음)는 DB CHECK 가 막아 픽스처로 만들 수 없는 경계(admin scope_all 거짓·엄브렐러만·미해석 권역)를 직접 확인한다.
"""
from __future__ import annotations

import contextlib
import uuid
from pathlib import Path
from typing import get_args

import asyncpg
import pytest

from app.core import auth as auth_mod
from app.core.auth import Principal
from app.core.codes import parse_refs
from app.core.filters import ignored_axes
from app.features.platform.auth.session import schemas
from app.features.platform.auth.session.service import build_session, session_scope
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

ME = "/v1/auth/me"
ALL_UIDS = (ADMIN, HQ_HYUNDAI, KIA_US, VENDOR, KIA_EU, SUSPENDED)
EMAILS = {ADMIN: "t-admin@example.test", HQ_HYUNDAI: "t-hq-h@example.test", KIA_US: "t-kia-us@example.test",
          VENDOR: "t-vendor@example.test", KIA_EU: "t-kia-eu@example.test", SUSPENDED: "t-susp@example.test"}


# ════════════════════════════════════════════════════════════════════════════
# 단위(DB 없음)
# ════════════════════════════════════════════════════════════════════════════
REFS = parse_refs({
    "brands": [{"code": "Hyundai", "bit": 1, "umb": False, "parent": None, "ord": 1},
               {"code": "Kia", "bit": 2, "umb": False, "parent": None, "ord": 2},
               {"code": "HMG", "bit": 8, "umb": True, "parent": None, "ord": 9}],
    "owned": [], "engines": [], "countries": [], "langs": [], "cats": [], "projects": [],
    "rhq": [{"id": "kia-we", "brand": "Kia", "cc": ["FR", "DE"]}, {"id": "kia-empty", "brand": "Kia", "cc": []}],
})


def _p(role="hq", *, operator="none", scope_all=False, brands=(), regions=(), countries=(), menu=None) -> Principal:
    return Principal(user_id=uuid.uuid4(), email="u@example.test", role=role, operator=operator, scope_all=scope_all,
                     scope_brands=tuple(brands), scope_regions=tuple(regions), scope_countries=tuple(countries),
                     menu_groups=menu, is_qa_reviewer=False)


def test_admin_forced_full_scope_even_if_db_says_otherwise():
    """Q16: admin 은 DB scope_all 과 무관하게 전체 스코프(DDL CHECK 로 시드 불가한 경계)."""
    s = session_scope(_p("admin", operator="global", scope_all=False, brands=("Kia",), countries=("US",)), REFS)
    assert s.model_dump() == {"all": True, "brands": None, "regions": None, "countries": None, "account_countries": None}


def test_umbrella_only_brand_scope_is_denied():
    s = session_scope(_p("hq", brands=("HMG",)), REFS)
    assert s.brands == [] and s.countries is None


def test_vendor_empty_brands_unrestricted_but_listed_brands_narrow():
    assert session_scope(_p("vendor"), REFS).brands is None           # 추가 결정 2026-09-28: 무제한
    assert session_scope(_p("vendor", brands=("Kia", "HMG")), REFS).brands == ["Kia"]


def test_q10_direct_countries_win_over_regions_and_are_uppercased():
    s = session_scope(_p("country", brands=("Kia",), regions=("kia-we",), countries=("us", "gb")), REFS)
    assert s.countries == ["GB", "US"] and s.regions == ["kia-we"]


def test_q10_region_expands_to_countries():
    s = session_scope(_p("region", brands=("Kia",), regions=("kia-we",)), REFS)
    assert s.countries == ["DE", "FR"]


@pytest.mark.parametrize("regions", [("kia-empty",), ("nope",), ("kia-we", "nope")])
def test_unresolvable_region_is_denied_not_unrestricted(regions):
    """권역이 국가로 안 풀리면(빈 권역·미해석 id) 무제한(null)이 아니라 거부([])."""
    s = session_scope(_p("region", brands=("Kia",), regions=regions), REFS)
    assert s.countries == [] and s.regions == list(regions)


def test_website_role_menu_passthrough():
    d = build_session(_p("website", brands=("Kia",), countries=("DE",), menu=("website",)), REFS)
    assert d.menu_groups == ["website"] and d.role == "website" and d.scope.countries == ["DE"]


def test_ignored_filter_axes_mapping():
    """기능 안 ignored_filter_axes 를 core.filters.ignored_axes(지원 축 없음)로 대체했다: 같은 축 이름표(같은 기대값)를 core 로 고정."""
    qp = {"surface": "global", "brand": "Kia", "country": "US", "from": "2026-09-01", "to": "2026-09-30", "engine": "gemini",
          "depth2": "x", "own_brand": "Kia", f"cf.{uuid.uuid4()}": "v", "project_id": "p", "unrelated": "1"}
    assert ignored_axes(qp) == ["brand", "country", "custom", "depth2", "engine", "own_brand", "period", "project_id", "surface"]
    assert ignored_axes({}) == []


# ════════════════════════════════════════════════════════════════════════════
# 통합(로컬 개발 DB)
# ════════════════════════════════════════════════════════════════════════════
async def _region_countries(region_id: str) -> list[str]:
    c = await asyncpg.connect(DB_URL)
    try:
        rows = await c.fetch("SELECT DISTINCT country_code FROM app.rhq_region_country WHERE region_id = $1", region_id)
    finally:
        await c.close()
    return sorted(r["country_code"] for r in rows)


def _expected(uid: uuid.UUID, kia_eu_countries: list[str]) -> dict:
    """ACCOUNTS_SQL 시드에서 손으로 옮긴 기대값."""
    base = {"user_id": str(uid), "email": EMAILS[uid], "display_name": None, "is_qa_reviewer": False}
    return {
        ADMIN: {**base, "role": "admin", "operator": "global", "menu_groups": None,
                "scope": {"all": True, "brands": None, "regions": None, "countries": None, "account_countries": None}},
        HQ_HYUNDAI: {**base, "role": "hq", "operator": "assigned", "menu_groups": ["standard", "project"],
                     "scope": {"all": False, "brands": ["Hyundai"], "regions": None, "countries": None, "account_countries": None}},
        KIA_US: {**base, "role": "country", "operator": "none", "menu_groups": None,
                 "scope": {"all": False, "brands": ["Kia"], "regions": None, "countries": ["US"], "account_countries": ["US"]}},
        VENDOR: {**base, "role": "vendor", "operator": "none", "menu_groups": ["project"],
                 "scope": {"all": False, "brands": None, "regions": None, "countries": None, "account_countries": None}},
        KIA_EU: {**base, "role": "region", "operator": "none", "menu_groups": None,
                 "scope": {"all": False, "brands": ["Kia"], "regions": ["kia-western-europe"], "countries": kia_eu_countries, "account_countries": None}},
    }[uid]


@needs_db
@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI, KIA_US, VENDOR, KIA_EU])
async def test_me_per_account(client_as, uid):
    kia_eu = await _region_countries("kia-western-europe")
    assert "DE" in kia_eu and len(kia_eu) > 1                   # 픽스처 전제(README: 권역 → 국가 전개, DE 포함)
    async with client_as(uid) as c:
        r = await c.get(ME)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["data"] == _expected(uid, kia_eu)
    assert body["meta"]["mode"] == "session"
    assert body["meta"]["surface"] is None and body["meta"]["cycles"] == [] and body["meta"]["generation"] is None
    assert body["meta"]["ignored_filters"] == [] and body["meta"]["dropped_filters"] == {} and body["meta"]["page"] is None
    assert r.headers["cache-control"] == "private, no-store"
    # 누출 0: 다른 계정의 식별자·이메일이 응답 어디에도 없다
    for other in ALL_UIDS:
        if other != uid:
            assert str(other) not in r.text and EMAILS[other] not in r.text


@needs_db
async def test_suspended_account_is_401(client_as):
    async with client_as(SUSPENDED) as c:
        r = await c.get(ME)
    assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"
    assert r.headers["cache-control"] == "no-store"            # R3(core): 인증 실패 응답도 공유 캐시 금지


@needs_db
async def test_unknown_subject_is_401(client_as):
    async with client_as(uuid.UUID("99999999-0000-4000-8000-000000000999")) as c:
        r = await c.get(ME)
    assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"


@needs_db
@pytest.mark.parametrize("kw,code", [({"exp_in": -120}, "token_expired"), ({"aud": "anon"}, "unauthenticated"),
                                     ({"kid": "other-kid"}, "unauthenticated")])
async def test_bad_token_is_401(client_as, kw, code):
    async with client_as(HQ_HYUNDAI, **kw) as c:
        r = await c.get(ME)
    assert r.status_code == 401 and r.json()["error"]["code"] == code


@needs_db
@pytest.mark.parametrize("headers", [{}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer "}, {"Authorization": "Bearer x.y.z"}])
async def test_missing_or_malformed_bearer_is_401(client_as, headers):
    async with client_as(None) as c:
        r = await c.get(ME, headers=headers)
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"
    assert "data" not in r.json()                              # 오류 응답에 세션 본문 없음
    assert r.headers["cache-control"] == "no-store"            # R3: core 오류 처리기가 401·403 에 no-store 를 붙인다(이전엔 헤더 없음)


@needs_db
async def test_common_filters_are_reported_not_applied(client_as):
    """지원 필터 없음: 필터를 줘도 data 는 그대로이고 준 축이 meta.ignored_filters 에 드러난다(조용히 무시 금지)."""
    params = [("surface", "global"), ("brand", "Hyundai"), ("country", "US"), ("country", "KR"), ("from", "2026-09-01"),
              ("to", "2026-09-30"), ("engine", "gemini"), ("funnel", "x"), (f"cf.{uuid.uuid4()}", "v")]
    async with client_as(KIA_US) as c:
        plain = (await c.get(ME)).json()
        filtered = (await c.get(ME, params=params)).json()
    assert filtered["data"] == plain["data"]
    assert filtered["meta"]["ignored_filters"] == ["brand", "country", "custom", "engine", "funnel", "period", "surface"]
    assert plain["meta"]["ignored_filters"] == []


@contextlib.asynccontextmanager
async def _temp_account(uid: uuid.UUID, *, role: str, brands: list[str], regions: list[str], countries: list[str],
                        menu: list[str] | None, extra_region: tuple[str, str] | None = None, qa: bool = False,
                        scope_all: bool = False, operator: str = "none", display_name: str | None = None):
    """임시 계정(복제본 DB 전용). 계정 쓰기는 행위자 GUC 필요(DB-v2.3 P31). 끝나면 계정·권역을 지운다."""
    actor = "SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', true)"   # 트랜잭션 한정(G5)
    c = await asyncpg.connect(DB_URL)
    try:
        async with c.transaction():
            await c.execute(actor)
            if extra_region:
                await c.execute("INSERT INTO app.rhq_region (region_id, brand_code, label) VALUES ($1, $2, 'tmp') ON CONFLICT DO NOTHING",
                                *extra_region)
            await c.execute("""INSERT INTO app.user_account (user_id, email, display_name, role, operator, scope_all, scope_brands,
                                                             scope_regions, scope_countries, menu_groups, is_qa_reviewer, status)
                               VALUES ($1, $2, $9, $3::app.user_role, $10::app.operator_scope, $11, $4, $5, $6, $7::app.menu_group[],
                                       $8, 'active')""",
                            uid, f"t-tmp-{uid.hex[:8]}@example.test", role, brands, regions, countries, menu, qa,
                            display_name, operator, scope_all)
        yield
    finally:
        async with c.transaction():
            await c.execute(actor)
            await c.execute("DELETE FROM app.user_account WHERE user_id = $1", uid)
            if extra_region:
                await c.execute("DELETE FROM app.rhq_region WHERE region_id = $1", extra_region[0])
        await c.close()


@needs_db
async def test_region_without_countries_is_denied(client_as):
    """권역이 있으나 국가가 하나도 없는 계정: 세션은 null(무제한)이 아니라 countries=[](거부)로 드러낸다(읽기 API 는 core 가 403 no_country_scope)."""
    uid = uuid.uuid4()
    rid = f"tmp-auth-{uid.hex[:8]}"
    async with _temp_account(uid, role="region", brands=["Kia"], regions=[rid], countries=[], menu=None, extra_region=(rid, "Kia")), \
            client_as(uid) as c:
        r = await c.get(ME)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["scope"] == {"all": False, "brands": ["Kia"], "regions": [rid], "countries": [], "account_countries": None}


@needs_db
async def test_website_role_menu_and_qa_flag_reflect_db(client_as):
    uid = uuid.uuid4()
    async with _temp_account(uid, role="website", brands=["Kia"], regions=[], countries=["DE"], menu=["website"], qa=True), \
            client_as(uid) as c:
        r = await c.get(ME)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert (d["role"], d["operator"], d["menu_groups"], d["is_qa_reviewer"]) == ("website", "none", ["website"], True)
    assert d["scope"] == {"all": False, "brands": ["Kia"], "regions": None, "countries": ["DE"], "account_countries": ["DE"]}


# ════════════════════════════════════════════════════════════════════════════
# 검증 결함 회귀(af74418 판정 D1~D3)
# ════════════════════════════════════════════════════════════════════════════
def test_d1_enum_types_come_from_core_not_redefined():
    """D1: Role·Operator·MenuGroup 을 기능에서 재정의하면 core·DB 에 값이 추가될 때 SessionData 검증이 500 을 낸다. 정본 하나만."""
    assert schemas.Role is auth_mod.Role
    assert schemas.Operator is auth_mod.Operator
    assert schemas.MenuGroup is auth_mod.MenuGroup
    src = Path(schemas.__file__).read_text(encoding="utf-8")
    assert "Literal[" not in src


def test_d1_every_core_enum_value_builds_a_session():
    """core 가 허용하는 모든 역할·운영자·메뉴 그룹 값이 세션 모델을 통과한다(값 불일치 = 500 경로 차단)."""
    for role in get_args(auth_mod.Role):
        op = "none" if role == "vendor" else "assigned"
        brands = () if role in ("admin", "vendor") else ("Kia",)
        d = build_session(_p(role, operator=op, scope_all=role == "admin", brands=brands, countries=("DE",),
                             menu=tuple(get_args(auth_mod.MenuGroup))), REFS)
        assert d.role == role and d.menu_groups == list(get_args(auth_mod.MenuGroup))
    for op in get_args(auth_mod.Operator):
        assert build_session(_p("hq", operator=op, brands=("Kia",)), REFS).operator == op


def test_d2_readme_names_consuming_screens():
    """D2: README 의 쓰는 화면은 AU-1 명세(전 화면 공통, DashLayout GNB·SNB)와 맞아야 한다(스캐폴드 문구 잔존 금지)."""
    readme = (Path(schemas.__file__).parent / "README.md").read_text(encoding="utf-8")
    assert "화면 없음" not in readme
    assert "DashLayout" in readme and "getSession" in readme
    assert "503" in readme and "auth_unavailable" in readme


def test_d3b_non_admin_scope_all_unit():
    """D3b: admin 이 아닌 scope_all 계정도 전체 스코프(Q16). 나머지 축은 계정 값과 무관하게 null."""
    s = session_scope(_p("hq", operator="assigned", scope_all=True, brands=("Kia",), regions=("kia-we",), countries=("US",)), REFS)
    assert s.model_dump() == {"all": True, "brands": None, "regions": None, "countries": None, "account_countries": None}


def test_d3b_vendor_umbrella_only_is_denied_unit():
    """D3b: vendor 무제한 규칙은 브랜드 스코프가 '비었을' 때만. 엄브렐러만 있으면 유효 브랜드가 없어 거부([])."""
    s = session_scope(_p("vendor", brands=("HMG",)), REFS)
    assert s.model_dump() == {"all": False, "brands": [], "regions": None, "countries": None, "account_countries": None}


@needs_db
async def test_d1_core_literals_match_db_enums():
    """D1 전제: core 타입 값 집합이 DB enum 과 같다(DB 에 값이 추가되면 여기서 먼저 깨진다)."""
    c = await asyncpg.connect(DB_URL)
    try:
        rows = await c.fetch("""SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
                                  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
                                 WHERE n.nspname = 'app' AND t.typname IN ('user_role', 'operator_scope', 'menu_group')
                                 GROUP BY t.typname""")
    finally:
        await c.close()
    db = {r["typname"]: set(r["labels"]) for r in rows}
    assert db == {"user_role": set(get_args(auth_mod.Role)), "operator_scope": set(get_args(auth_mod.Operator)),
                  "menu_group": set(get_args(auth_mod.MenuGroup))}


@needs_db
async def test_d3b_non_admin_scope_all_account(client_as):
    """D3b 통합: 비admin scope_all 계정(브랜드·국가 값이 있어도) → all=true, 나머지 null. operator 는 DB 원값."""
    uid = uuid.uuid4()
    async with _temp_account(uid, role="hq", brands=["Kia"], regions=[], countries=["US"], menu=["standard"],
                             scope_all=True, operator="assigned"), client_as(uid) as c:
        r = await c.get(ME)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert (d["role"], d["operator"], d["menu_groups"]) == ("hq", "assigned", ["standard"])
    assert d["scope"] == {"all": True, "brands": None, "regions": None, "countries": None, "account_countries": None}


@needs_db
async def test_d3b_vendor_umbrella_only_account_is_denied(client_as):
    """D3b 통합: 엄브렐러(HMG, app.brand.is_umbrella)만 가진 vendor → brands=[](거부). 빈 브랜드 vendor(null)와 다르다."""
    c0 = await asyncpg.connect(DB_URL)
    try:
        assert await c0.fetchval("SELECT is_umbrella FROM app.brand WHERE brand_code = 'HMG'") is True   # 픽스처 전제
    finally:
        await c0.close()
    uid = uuid.uuid4()
    async with _temp_account(uid, role="vendor", brands=["HMG"], regions=[], countries=[], menu=["project"]), client_as(uid) as c:
        r = await c.get(ME)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert (d["role"], d["operator"]) == ("vendor", "none")
    assert d["scope"] == {"all": False, "brands": [], "regions": None, "countries": None, "account_countries": None}


@needs_db
@pytest.mark.parametrize("name", ["김 제품 책임자", "<b>x</b> & \"q\"", "  공백 포함  "])
async def test_d3b_display_name_is_mapped_verbatim(client_as, name):
    """D3b 통합: display_name 이 있으면 DB 값 그대로(이스케이프·트림 없음, 렌더링 안전은 프론트 책임)."""
    uid = uuid.uuid4()
    async with _temp_account(uid, role="country", brands=["Kia"], regions=[], countries=["US"], menu=None,
                             display_name=name), client_as(uid) as c:
        r = await c.get(ME)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["display_name"] == name


def test_d3c_openapi_documents_503():
    """D3c: JWKS 장애 503(auth_unavailable)이 OpenAPI 에 문서화돼 있다."""
    from app.main import app
    op = app.openapi()["paths"][ME]["get"]
    assert set(op["responses"]) >= {"200", "401", "503"}
    assert op["responses"]["503"]["content"]["application/json"]["schema"] == op["responses"]["401"]["content"]["application/json"]["schema"]


class _DownJwks:
    """JWKS 엔드포인트 장애를 흉내 내는 PyJWKClient 대역."""

    def get_signing_key(self, kid):
        raise auth_mod.jwt.PyJWKClientConnectionError("jwks down")


@needs_db
async def test_d3c_jwks_outage_is_503_not_500(client_as, settings):
    """D3c 실측: 정적 키에 없는 kid 로 JWKS 조회가 장애면 503 auth_unavailable(500 아님)."""
    prev = auth_mod.get_verifier()
    v = auth_mod.JwtVerifier(settings)
    v._client = _DownJwks()
    auth_mod.set_verifier(v)
    try:
        async with client_as(HQ_HYUNDAI, kid="rotated-kid") as c:
            r = await c.get(ME)
    finally:
        auth_mod.set_verifier(prev)
    assert r.status_code == 503, r.text
    assert r.json()["error"]["code"] == "auth_unavailable"
