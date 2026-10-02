"""인증·인가: Supabase JWT(JWKS) 검증 → app.user_account 세션 사용자, 역할·메뉴·운영자 게이트, 데이터 스코프(default-deny),
프로젝트 접근, 검수(QA) 별도 게이트(Q17).

사용 규칙
- 토큰 검증(verified_subject)은 DB 커넥션을 여는 어떤 의존성보다 먼저 돈다(D-2): 무인증·토큰 오류 요청은 풀 커넥션 없이 401.
  core.db 의 RoConn·AdminLongConn 은 Bearer 인증 요청 전용이다(커넥션을 열기 전에 같은 검증을 부른다).
- 모든 /v1 읽기·쓰기 라우터는 CurrentUser(= Depends(get_principal)) 를 받는다. 역할 게이트는 require_role·require_menu_group 을
  라우터 dependencies= 로 건다(좁히기 전용 AND, 상승 불가: route-policy groupAllowed 계승).
- 데이터 스코프는 DataScope(principal, refs) 로만 계산한다. 요청 파라미터로 넓힐 수 없다. 교집합이 비면 403(default-deny).
- 비용 액션(프로젝트 생성·수집·실행)은 require_operator 로 막는다(operator-policy 이식). global 운영자도 프로젝트가 보여야 한다
  (스코프 안 ∨ 활성 멤버, 모듈-프로젝트 §7 "global 스코프 대조").
- 핸들러 안에서 표면 값에 따라 역할·메뉴를 가를 때는 check_role·check_menu_group(require_* 와 같은 판정·코드)을 부른다.
- 외부 호출(LLM·Supabase·GA4·Scope 진단)을 기다리는 핸들러는 CurrentUserDetached 를 쓴다: 계정만 짧은 api_ro 트랜잭션에서 읽고
  커넥션을 돌려준다. 필요한 읽기는 RoSession(core.db) 으로 짧게 연다(core.db 규약 "외부 호출은 커넥션을 쥔 채 하지 않는다").
- QA 콘솔 경로는 Supabase 세션이 아니라 require_qa_reviewer(HMAC 쿠키) 만 쓴다. role 스코프 밖이므로 qa_gate 풀로 격리한다.
  읽기·쓰기 라우터는 QaLiveConn(쿠키 + 세션 행 존재 확인)을 쓴다. QaConn 은 이미 폐기된 세션도 받아야 하는 경로(로그아웃)만.
- 클라이언트 IP 는 client_ip(request) 하나로 읽는다(core.config.trusted_proxy_hops, 배포 값은 배포 문서). 상한 버킷 키는 rate_key_ip.
  신뢰 중계(BFF, 결정 D2): X-HGH-Relay-Secret 이 core.config.relay_secret(HGH_RELAY_SECRET)과 상수 시간 비교로 일치할 때만
  X-HGH-Client-IP 를 쓴다(relay_client_ip). 미설정·불일치·형식 오류면 헤더를 무시하고 위 규칙 그대로다.
- 테스트는 install_test_keys(kid→공개키)로 로컬 서명 키를 주입한다(local·test 환경에서만 허용).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import secrets
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field, replace
from typing import Annotated, Any, Literal, get_args

import jwt
from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.codes import Refs, load_refs
from app.core.config import Settings, get_settings
from app.core.db import RoConn, RoSession, fetch_one, get_db

log = logging.getLogger("hgh.auth")

Role = Literal["hq", "region", "country", "admin", "vendor", "website"]
Operator = Literal["none", "assigned", "global"]
MenuGroup = Literal["standard", "website", "project", "admin"]
ALLOWED_ALGS = ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "EdDSA")
_EC_ALG = {"secp256r1": "ES256", "secp384r1": "ES384", "secp521r1": "ES512"}


def key_algorithm(key: Any) -> str:
    """서명 키가 허용하는 단일 알고리즘. PyJWK 는 JWK alg(또는 kty·crv 추론), 원시 키는 종류로 정한다.
    토큰 헤더 alg 가 아니라 키에서 알고리즘을 정해 algorithm confusion(예: 공개키를 HMAC 비밀로 쓰는 공격)을 막는다."""
    from cryptography.hazmat.primitives.asymmetric import ec, ed448, ed25519, rsa

    if isinstance(key, jwt.PyJWK):
        alg = key.algorithm_name
    elif isinstance(key, (rsa.RSAPublicKey, rsa.RSAPrivateKey)):
        alg = "RS256"
    elif isinstance(key, (ec.EllipticCurvePublicKey, ec.EllipticCurvePrivateKey)):
        alg = _EC_ALG.get(key.curve.name, "")
    elif isinstance(key, (ed25519.Ed25519PublicKey, ed448.Ed448PublicKey)):
        alg = "EdDSA"
    else:
        alg = ""
    if alg not in ALLOWED_ALGS:
        raise errors.unauthenticated("허용되지 않은 서명 키 종류")
    return alg


# ════════════════════════════════════════════════════════════════════════════
# JWT(JWKS) 검증
# ════════════════════════════════════════════════════════════════════════════
class JwtVerifier:
    """Supabase JWKS 로 서명·exp·aud·iss 검증. kid 미스는 PyJWKClient 가 1회 강제 갱신. 테스트 키는 local·test 환경에서만 주입 가능.
    알고리즘은 키에서 하나로 정하고(key_algorithm) 헤더 alg 가 다르면 401. 키·토큰 불일치 예외는 모두 401 로 바꾼다."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._static: dict[str, tuple[Any, str]] = {}
        self._client: jwt.PyJWKClient | None = None
        if settings.jwks_url:
            self._client = jwt.PyJWKClient(settings.jwks_url, cache_keys=True, lifespan=600, timeout=5)

    def install_test_keys(self, keys: dict[str, Any]) -> None:
        if not self.settings.is_dev:
            raise RuntimeError("테스트 서명 키 주입은 HGH_ENV local·test 에서만 허용")
        for kid, k in keys.items():
            self._static[kid] = (k.key if isinstance(k, jwt.PyJWK) else k, key_algorithm(k))

    async def preload(self) -> None:
        """기동 시 JWKS 선로드(콜드 fetch 지연 제거). 실패는 경고만(요청 시 재시도)."""
        if self._client is None:
            return
        try:
            await asyncio.to_thread(self._client.get_signing_keys)
        except Exception as e:  # noqa: BLE001
            log.warning("JWKS 선로드 실패: %s", type(e).__name__)

    def _key_for(self, token: str) -> tuple[Any, str]:
        try:
            header = jwt.get_unverified_header(token)
        except (jwt.PyJWTError, TypeError, ValueError) as e:
            raise errors.unauthenticated("토큰 형식 오류") from e
        kid = header.get("kid")
        if kid in self._static:
            key, alg = self._static[kid]
        elif self._client is None:
            raise errors.unauthenticated("서명 키 없음")
        else:
            try:
                jwk = self._client.get_signing_key(kid)
            except (jwt.PyJWKClientConnectionError, OSError, TimeoutError) as e:     # JWKS 엔드포인트 장애 = 503(500 금지)
                raise errors.unavailable("JWKS 조회 실패", code="auth_unavailable") from e
            except (jwt.PyJWTError, TypeError, ValueError, KeyError) as e:
                raise errors.unauthenticated("서명 키 조회 실패") from e
            key, alg = jwk.key, key_algorithm(jwk)
        if header.get("alg") != alg:
            raise errors.unauthenticated("토큰 alg 가 서명 키와 다르다")
        return key, alg

    async def verify(self, token: str) -> dict[str, Any]:
        key, alg = await asyncio.to_thread(self._key_for, token) if self._client is not None else self._key_for(token)
        opts = {"require": ["exp", "sub"] + (["iss"] if self.settings.jwt_issuer else [])}
        try:
            return jwt.decode(token, key=key, algorithms=[alg], audience=self.settings.jwt_audience,
                              issuer=self.settings.jwt_issuer, options=opts, leeway=5)
        except jwt.ExpiredSignatureError as e:
            raise errors.unauthenticated("토큰 만료", code="token_expired") from e
        except (jwt.PyJWTError, TypeError, ValueError) as e:     # InvalidKeyError·키 종류 불일치 포함
            raise errors.unauthenticated("토큰 검증 실패") from e


_verifier: JwtVerifier | None = None


def get_verifier() -> JwtVerifier:
    global _verifier
    if _verifier is None:
        _verifier = JwtVerifier(get_settings())
    return _verifier


def set_verifier(v: JwtVerifier | None) -> None:
    global _verifier
    _verifier = v


# ════════════════════════════════════════════════════════════════════════════
# 세션 사용자
# ════════════════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    email: str
    role: Role
    operator: Operator
    scope_all: bool
    scope_brands: tuple[str, ...]
    scope_regions: tuple[str, ...]
    scope_countries: tuple[str, ...]
    menu_groups: tuple[MenuGroup, ...] | None      # None = 무제한(DB CHECK 가 빈 배열을 막는다)
    is_qa_reviewer: bool
    display_name: str | None = None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


_PRINCIPAL_SQL = """
SELECT user_id, email::text AS email, display_name, role::text AS role, operator::text AS operator, scope_all,
       scope_brands, scope_regions, scope_countries, menu_groups::text[] AS menu_groups, is_qa_reviewer
  FROM app.user_account WHERE user_id = :uid AND status = 'active'
"""


def principal_from_row(r: dict[str, Any]) -> Principal:
    """계정 행 → Principal. menu_groups 는 저장값이 아니라 유효값(effective_menu_groups: 현행 lib/auth/menu-groups.ts effectiveMenuGroups,
    hmg-geo #328·#329)이다. 표면 게이트(surface_denial·check_menu_group)·/v1/auth/me·데우기 계정 목록이 모두 이 값을 본다(세션·착지 같은 값).
    관리 API(계정 목록·수정)는 이 함수를 거치지 않고 저장값을 그대로 읽는다(현행 어드민 콘솔도 저장값)."""
    role = r["role"]
    operator = r["operator"]
    if role == "vendor":          # DB CHECK ua_vendor_no_operator 와 이중 방어
        operator = "none"
    countries = tuple(r["scope_countries"] or ())
    menu = effective_menu_groups(r.get("menu_groups"), all_scope=bool(r["scope_all"]) or role == "admin", countries=countries)
    return Principal(user_id=uuid.UUID(str(r["user_id"])), email=r["email"], role=role, operator=operator,
                     scope_all=bool(r["scope_all"]), scope_brands=tuple(r["scope_brands"] or ()),
                     scope_regions=tuple(r["scope_regions"] or ()), scope_countries=countries,
                     menu_groups=menu, is_qa_reviewer=bool(r["is_qa_reviewer"]),
                     display_name=r.get("display_name"))


async def load_principal(conn: AsyncConnection, user_id: uuid.UUID) -> Principal:
    r = await fetch_one(conn, _PRINCIPAL_SQL, {"uid": user_id})
    if r is None:                  # 인증됐으나 프로필 없음·정지 = 접근 없음(현행 session.ts 원칙)
        raise errors.unauthenticated("활성 계정 없음", code="no_account")
    return principal_from_row(r)


def bearer_token(request: Request) -> str:
    h = request.headers.get("authorization") or ""
    if not h.lower().startswith("bearer "):
        raise errors.unauthenticated("Bearer 토큰 필요")
    tok = h[7:].strip()
    if not tok:
        raise errors.unauthenticated("Bearer 토큰 필요")
    return tok


_SUBJECT_STATE = "hgh_verified_subject"


async def verified_subject(request: Request) -> uuid.UUID:
    """Bearer JWT 검증 → sub(uuid). DB 를 쓰지 않는다. 요청당 1회(request.state 에 결과를 둔다: core.db 요청 커넥션 의존성과
    get_principal 이 같은 값을 쓴다). 실패는 401(unauthenticated·token_expired) 또는 JWKS 장애 503 auth_unavailable.

    D-2(2026-09-30): 무인증·토큰 오류 요청이 풀 커넥션·트랜잭션을 잡기 전에 끝나야 한다(부하 증폭 방지). 그래서 토큰 검증은 커넥션을
    여는 어떤 의존성보다 먼저 돈다: get_principal 은 이 의존성을 커넥션보다 앞에 받고, core.db.get_ro_conn·get_admin_long_conn 은
    커넥션을 열기 전에 이 함수를 직접 부른다(핸들러가 RoConn 을 CurrentUser 보다 앞에 선언해도 순서가 같다)."""
    done = getattr(request.state, _SUBJECT_STATE, None)
    if done is not None:
        return done
    claims = await get_verifier().verify(bearer_token(request))
    try:
        uid = uuid.UUID(str(claims["sub"]))
    except (KeyError, ValueError) as e:
        raise errors.unauthenticated("sub 형식 오류") from e
    setattr(request.state, _SUBJECT_STATE, uid)
    return uid


VerifiedSubject = Annotated[uuid.UUID, Depends(verified_subject)]


async def get_principal(request: Request, uid: VerifiedSubject, conn: RoConn) -> Principal:
    """JWT 검증(verified_subject, 커넥션 전) → sub → app.user_account(active). 같은 요청의 api_ro 커넥션을 재사용한다(의존성 캐시).
    매개변수 순서가 곧 해석 순서다: uid 가 conn 보다 앞이어야 한다(D-2)."""
    p = await load_principal(conn, uid)
    request.state.principal = p
    return p


CurrentUser = Annotated[Principal, Depends(get_principal)]


async def get_principal_detached(request: Request, uid: VerifiedSubject, open_ro: RoSession) -> Principal:
    """get_principal 과 같은 판정이되 계정 조회를 자체 짧은 api_ro 트랜잭션에서 하고 커넥션을 바로 돌려준다(요청 커넥션을 쥐지 않는다).
    외부 호출(LLM·Supabase·GA4 등)을 기다리는 핸들러용. 같은 핸들러에 RoConn·CurrentUser 를 함께 걸면 의미가 없다(요청 커넥션이 다시 열린다)."""
    async with open_ro() as conn:
        p = await load_principal(conn, uid)
    request.state.principal = p
    return p


CurrentUserDetached = Annotated[Principal, Depends(get_principal_detached)]


# ════════════════════════════════════════════════════════════════════════════
# 게이트(라우터 dependencies= 에 건다)
# ════════════════════════════════════════════════════════════════════════════
def check_role(p: Principal, *roles: str) -> None:
    """역할 판정(403 role_forbidden). require_role 과 같은 판정을 핸들러 안에서 부를 때(표면 값에 따라 역할이 갈리는 경로)."""
    if p.role not in roles:
        raise errors.forbidden("역할 권한 없음", code="role_forbidden")


def check_menu_group(p: Principal, group: str) -> None:
    """메뉴 그룹 판정(403 menu_forbidden, menu_groups None = 무제한). require_menu_group 과 같은 판정."""
    if p.menu_groups is not None and group not in p.menu_groups:
        raise errors.forbidden("메뉴 권한 없음", code="menu_forbidden")


def require_role(*roles: Role) -> Callable[..., Any]:
    allowed = tuple(roles)

    async def _dep(p: CurrentUser) -> Principal:
        check_role(p, *allowed)
        return p
    return Depends(_dep)


def require_menu_group(group: MenuGroup) -> Callable[..., Any]:
    async def _dep(p: CurrentUser) -> Principal:
        check_menu_group(p, group)
        return p
    return Depends(_dep)


# ── 표면 경로 게이트(surface 가 쿼리 값인 읽기 API): 현행 front/lib/auth/route-policy.ts:26-35 표 그대로 ──
# 역할 천장(STANDARD_VIEWERS·WEBSITE_VIEWERS·PROJECT_VIEWERS) + 계정 menu_groups 좁히기(groupAllowed :335, None = 무제한).
# vendor 는 표준·웹사이트 경로 밖, website 역할은 웹사이트 경로만(DECISIONS-API 추가 결정 D-vendor: 'vendor 무제한'은 데이터 스코프만).
SURFACE_ROLES: dict[str, frozenset[str]] = {
    "global": frozenset(("hq", "region", "country", "admin")),
    "website": frozenset(("hq", "region", "country", "admin", "website")),
    "project": frozenset(("hq", "region", "country", "admin", "vendor")),
}
SURFACE_MENU: dict[str, str] = {"global": "standard", "website": "website", "project": "project"}


def surface_denial(p: Principal, surface: str) -> str | None:
    """표면 게이트 판정. 허용이면 None, 거부면 코드(role_forbidden | menu_forbidden). 알 수 없는 표면은 ValueError."""
    if surface not in SURFACE_ROLES:
        raise ValueError(f"알 수 없는 표면: {surface}")
    if p.role not in SURFACE_ROLES[surface]:
        return "role_forbidden"
    if p.menu_groups is not None and SURFACE_MENU[surface] not in p.menu_groups:
        return "menu_forbidden"
    return None


def require_surface(p: Principal, surface: str) -> None:
    """표면 경로 게이트(403 role_forbidden | menu_forbidden). resolve_read_context 가 첫 줄에서 부른다(모든 분석 읽기 일괄).
    데이터 스코프(DataScope)보다 먼저 건다: 스코프가 무제한이어도 표면에 들어올 수 없으면 거부."""
    code = surface_denial(p, surface)
    if code == "role_forbidden":
        raise errors.forbidden("역할 권한 없음", code=code)
    if code == "menu_forbidden":
        raise errors.forbidden("메뉴 권한 없음", code=code)


def require_surface_gate(surface: str) -> Callable[..., Any]:
    """require_surface 를 라우터 dependencies= 로 거는 형태(역할 천장 + 메뉴 그룹). 표면이 경로에 고정된 화면(예: 프로젝트 화면 전용
    intent 경로 = project 표면: front PROJECT_VIEWERS, website 역할 제외)에 쓴다."""
    if surface not in SURFACE_ROLES:
        raise ValueError(f"알 수 없는 표면: {surface}")

    async def _dep(p: CurrentUser) -> Principal:
        require_surface(p, surface)
        return p
    return Depends(_dep)


def shows_geo_map(p: Principal) -> bool:
    """시장 지도(GEO-1) 노출: 무제한 스코프(admin 포함, Q16) ∨ 역할 hq·region(현행 scope-policy.ts:264 showsGeoMap)."""
    return p.is_admin or p.scope_all or p.role in ("hq", "region")


def check_admin(p: Principal) -> None:
    """관리자 판정(403 admin_only). require_admin 과 같은 판정을 핸들러 안에서(Detached principal 등)."""
    if p.role != "admin":
        raise errors.forbidden("관리자 전용", code="admin_only")


async def _require_admin(p: CurrentUser) -> Principal:
    check_admin(p)
    return p

require_admin = Depends(_require_admin)


async def _admin_detached(p: CurrentUserDetached) -> Principal:
    """require_admin + require_menu_group('admin') 과 같은 판정·코드(admin_only·menu_forbidden)를 요청 커넥션 없이(CurrentUserDetached)."""
    check_admin(p)
    check_menu_group(p, "admin")
    return p


AdminDetached = Annotated[Principal, Depends(_admin_detached)]
"""외부 호출 관리 엔드포인트용(라우터 dependencies 의 require_admin·require_menu_group 은 요청 커넥션을 연다)."""


def can_create_project(p: Principal) -> bool:
    return p.role == "admin" or p.operator == "global"


def can_operate_project(p: Principal, active_member: bool) -> bool:
    if p.role == "admin":
        return True
    if p.operator == "none":
        return False
    if p.operator == "global":
        return True
    return active_member


def is_operator(p: Principal) -> bool:
    return p.role == "admin" or p.operator != "none"


async def is_active_member(conn: AsyncConnection, project_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    r = await fetch_one(conn, "SELECT 1 AS ok FROM app.project_member WHERE project_id = :pid AND user_id = :uid AND status = 'active'",
                        {"pid": project_id, "uid": user_id})
    return r is not None


async def require_operator(conn: AsyncConnection, p: Principal, action: Literal["create_project", "collect", "run"],
                           project_id: uuid.UUID | None = None, *, refs: Refs | None = None) -> None:
    """비용 액션 게이트(operator-policy.ts 이식). 프로젝트 생성은 project_id 없이 판정, 수집·실행은 멤버십 확인.
    global 운영자는 "스코프 안 프로젝트"만 운영한다(operator-policy.ts:27 주석, 모듈-프로젝트 §7 global 스코프 대조): 프로젝트가
    계정 스코프 안이거나 활성 멤버(명시 초대)여야 한다(= resolve_project 가시성, vendor 는 global 이 될 수 없다). refs 가 없으면 읽는다."""
    if action == "create_project":
        if not can_create_project(p):
            raise errors.forbidden("프로젝트 생성 권한 없음", code="operator_forbidden")
        return
    if project_id is None:
        raise ValueError("collect·run 은 project_id 필수")
    member = False
    if p.role != "admin" and p.operator in ("assigned", "global"):
        member = await is_active_member(conn, project_id, p.user_id)
    if not can_operate_project(p, member):
        raise errors.forbidden("운영 권한 없음", code="operator_forbidden")
    if p.role != "admin" and p.operator == "global" and not member:
        r = await fetch_one(conn, "SELECT brand_code, country_code FROM app.project WHERE project_id = :pid", {"pid": project_id})
        if r is None:
            raise errors.not_found("프로젝트 없음")
        if refs is None:
            refs = await load_refs(conn)
        if not DataScope.of(p, refs).project_in_scope(refs, r["brand_code"], r["country_code"]):
            raise errors.forbidden("운영 권한 없음(스코프 밖 프로젝트)", code="operator_forbidden")


# ════════════════════════════════════════════════════════════════════════════
# 데이터 스코프(default-deny)
# ════════════════════════════════════════════════════════════════════════════
# website 표면의 도시 단위 의사 코드 → 모국(현행 front lib/geo-catalog/pseudo-country.ts:31-51 PSEUDO_COUNTRIES 의 scopeParent,
# 적용 = withPseudoCountries :73-83, 호출 = website-sites.ts:48-51 effectiveCountries 끝). 모국을 허용하는 스코프가 이 코드 사이트도 본다
# (제네시스 사우디 도시별 사이트). CN-BJ 는 front 가 의도적으로 두지 않았다(pseudo-country.ts:16-18: 베이징현대 합작사 사이트는 전용 계정만).
# 권역 허브 코드(worldwide·EU·MIDDLEEAST)는 국가의 상위라 front 에도 이런 규칙이 없다(pseudo-country.ts:20-21, 필터 패널 표시 그룹만).
# 표준(global)·프로젝트 표면에는 적용하지 않는다(front standard-filters·scope-policy 는 lib/rhq effectiveScopeCountries 만 쓴다).
WEBSITE_SCOPE_PARENT: dict[str, str] = {"SA-DAMMAM": "SA", "SA-JEDDAH": "SA", "SA-RIYADH": "SA"}   # 키·값 대문자(DataScope.countries 표기)

# website 전용 사이트 코드(현행 front lib/scope/website-virtual-geo.ts WEBSITE_DEDICATED_SITE_CODES = worldwide·CPO + 브랜드 가상 코드
# WEBSITE_BRAND_GEO_CODES(HYUNDAI-N), hmg-geo PR #326·#328). 독립 사이트 하나를 가리킨다. 브랜드 가상 코드는 코드 상수가 아니라
# rd.dim_country kind 'virtual_brand' 행으로 판정한다(core.filters 요청 국가 축과 같은 원천). 키 대문자(DataScope.countries 표기).
WEBSITE_DEDICATED_SITE_CODES: frozenset[str] = frozenset({"WORLDWIDE", "CPO"})

# 전용 사이트 → 글로벌 표면에서 보는 시장(ISO)(현행 website-virtual-geo.ts WEBSITE_SITE_GLOBAL_MARKETS, hmg-geo #328 472dc57).
# 여기 없는 전용 코드(WORLDWIDE·CPO)는 글로벌 시장이 없다. 키 = 전용 사이트 코드(대문자, DataScope.countries 표기).
# 키는 참조(rd.dim_country) 없이도 전용 사이트 코드로 본다: 메뉴 파생(effective_menu_groups)은 계정 행만으로 판정한다. 시장 없는 브랜드
# 가상 코드가 rd.dim_country 에 생기면 메뉴(참조 없음)와 데이터(참조 판정)가 갈리므로 tests/core/test_sync_s1_auth.py 가드가 멈춘다.
SITE_GLOBAL_MARKETS: dict[str, tuple[str, ...]] = {"HYUNDAI-N": ("US", "KR")}

# 메뉴 그룹 전체(현행 menu-groups.ts VALID_GROUPS 순서).
MENU_GROUPS: tuple[str, ...] = get_args(MenuGroup)


def _upper_set(codes: Iterable[str] | None) -> tuple[str, ...]:
    return tuple(sorted({c.upper() for c in (codes or ())}))


def dedicated_site_codes(raw: Iterable[str], brand_geo: Iterable[str] = ()) -> tuple[str, ...]:
    """현행 websiteDedicatedCodes(website-virtual-geo.ts:115-117): 계정 국가(대문자) 중 전용 사이트 코드
    (WORLDWIDE·CPO·브랜드 가상 코드 = brand_geo ∪ SITE_GLOBAL_MARKETS 키). 정렬 튜플."""
    bg = set(brand_geo) | set(SITE_GLOBAL_MARKETS)
    return tuple(sorted({c for c in raw if c in WEBSITE_DEDICATED_SITE_CODES or c in bg}))


def site_account_global_countries(raw: Iterable[str], brand_geo: Iterable[str] = ()) -> tuple[str, ...] | None:
    """현행 siteAccountGlobalCountries(website-virtual-geo.ts:139-149): 전용 사이트 계정의 글로벌 국가 = 같은 배열의 전용 코드 아닌 값 ∪
    전용 코드의 글로벌 시장(SITE_GLOBAL_MARKETS). 전용 사이트 계정이 아니면 None(종전 규칙). 빈 튜플 = 글로벌에서 볼 시장이 없다(WW·CPO).
    raw = 계정 scope_countries 대문자. 결과는 정렬 튜플(현행은 계정 순서 + 시장 순서: 집합은 같다)."""
    raw = tuple(raw)
    dedicated = set(dedicated_site_codes(raw, brand_geo))
    if not dedicated:
        return None
    out = {c for c in raw if c not in dedicated}
    for code in dedicated:
        out.update(SITE_GLOBAL_MARKETS.get(code, ()))
    return tuple(sorted(out))


def global_scope_countries(raw: tuple[str, ...], brand_geo: Iterable[str], data_countries: tuple[str, ...] | None
                           ) -> tuple[str, ...] | None:
    """global 표면의 계정 국가 스코프(동기화 S1 BE-6). 현행 lib/rhq/index.ts:97-107 effectiveScopeCountries(hmg-geo 2670a16) 이식:
      1) 전용 사이트 계정(계정 국가에 WORLDWIDE·CPO·브랜드 가상 코드)이면 site_account_global_countries. 권역·브랜드 전체로 넓히지 않는다.
         그 값이 비면(WW·CPO) 전용 코드 그대로(ISO 답변과 아무것도 맞지 않아 0건, fail-closed. 글로벌 탭은 메뉴 파생이 숨긴다).
      2) 아니면 data_countries(Q10: 국가 우선, 없으면 권역 전개) 그대로.
    raw = 계정 scope_countries 대문자(정렬), brand_geo = rd.dim_country kind 'virtual_brand' 코드."""
    site = site_account_global_countries(raw, brand_geo)
    if site is None:
        return data_countries
    return site or dedicated_site_codes(raw, brand_geo)


def has_global_surface(all_scope: bool, countries: Iterable[str] | None) -> bool:
    """현행 hasGlobalSurface(website-virtual-geo.ts:152-156): 전체 스코프이거나, 전용 사이트 계정이 아니거나, 글로벌 시장이 있으면 참.
    참조 없이 판정한다(전용 코드 = WORLDWIDE·CPO·SITE_GLOBAL_MARKETS 키, SITE_GLOBAL_MARKETS 머리 주석)."""
    if all_scope:
        return True
    g = site_account_global_countries(_upper_set(countries))
    return g is None or len(g) > 0


def effective_menu_groups(stored: Iterable[str] | None, *, all_scope: bool, countries: Iterable[str] | None
                          ) -> tuple[MenuGroup, ...] | None:
    """계정의 유효 메뉴 그룹(좁히기 전용, 동기화 S1 BE-7). 현행 lib/auth/menu-groups.ts effectiveMenuGroups(hmg-geo #328·#329) 이식:
      - 저장값 중 유효 그룹만(순서 유지). 비면 None(제한 없음).
      - 글로벌 시장 없는 전용 사이트 계정(has_global_surface 거짓: WW·CPO)은 standard 를 뺀다(None 이면 전체 그룹에서 뺀다).
        결과가 비면 원래 값을 둔다(빈 값 = 제한 없음이라 넓어진다).
    all_scope = scope_all ∨ admin(Q16, DataScope.all 과 같다: 현행 profile.scopeAll, admin 은 DDL CHECK ua_admin_scope_all 로 늘 참)."""
    groups = tuple(g for g in (stored or ()) if g in MENU_GROUPS) or None
    if not has_global_surface(all_scope, countries):
        narrowed = tuple(g for g in (groups or MENU_GROUPS) if g != "standard")
        if narrowed:
            groups = narrowed
    return groups


def website_scope_brands(brands: tuple[str, ...] | None, raw: tuple[str, ...], refs: Refs) -> tuple[str, ...] | None:
    """website 표면의 계정 브랜드 허용 목록(동기화 S1 BE-8). 현행 websiteScopeBrands(website-virtual-geo.ts:183-196) 이식: 계정 brands
    + 계정 국가의 브랜드 가상 코드가 여는 사이트 브랜드(rd.dim_country virtual_brand_bit → app.brand, 그 부모가 brands 에 있을 때만.
    현행 WEBSITE_SITE_BRAND_PARENT 'Hyundai N' → 'Hyundai' = app.brand.parent_brand_code). brands 가 None(무제한)·()(거부)이면 그대로
    (값을 채우면 제한이 없던 계정에 제한이 생긴다). 순서 = 계정 순서 뒤에 덧붙임."""
    if not brands:
        return brands
    out = list(brands)
    for code in raw:
        c = refs.countries.get(code)
        if c is None or c.kind != "virtual_brand" or c.virtual_brand_bit is None:
            continue
        site = refs.brand_code_of_bit(int(c.virtual_brand_bit))
        b = refs.brand(site) if site else None
        if b is None or site in out:
            continue
        if b.parent and b.parent in out:
            out.append(b.code)
    return tuple(out)


def _brand_geo_codes(refs: Refs) -> frozenset[str]:
    """브랜드 가상 코드(rd.dim_country kind 'virtual_brand', 대문자 키). core.filters 요청 국가 축과 같은 원천."""
    return frozenset(code for code, c in refs.countries.items() if c.kind == "virtual_brand")


def _with_scope_parent(countries: tuple[str, ...]) -> tuple[str, ...]:
    """front withPseudoCountries(pseudo-country.ts:73-83): 모국(scopeParent)이 목록에 있는 도시 의사 코드를 더한다(정렬 튜플)."""
    have = set(countries)
    extra = {c for c, parent in WEBSITE_SCOPE_PARENT.items() if parent in have and c not in have}
    return tuple(sorted(have | extra)) if extra else countries


def website_scope_countries(p: Principal, refs: Refs, raw: tuple[str, ...], data_countries: tuple[str, ...] | None
                            ) -> tuple[str, ...] | None:
    """website 표면의 계정 국가 스코프(core 10라운드 제품 결정 2: 웹사이트 표면만 현행 교집합 규칙). 현행 front
    lib/db/repositories/website-sites.ts effectiveCountries(hmg-geo main 2670a16: c52a60d·#326·#328 반영) 이식, 비교는 대문자:
      1) 계정 국가에 전용 사이트 코드(WORLDWIDE·CPO·브랜드 가상 코드)가 있으면 그 코드만(같은 배열의 ISO 는 글로벌 전용, 도시 전개 없음).
      2) 권역·국가 둘 다 있으면: RHQ ISO(app.rhq_region_country 전체 집합)는 계정 권역 국가와의 교집합, RHQ 밖 사이트 가상 코드
         (CN-BJ·MIDDLEEAST·EU·SA-* 등, 브랜드 가상 코드 제외)는 교집합 없이 통과.
      3) 국가만 있으면 그 국가, 권역만 있으면 권역 전개(data_countries 그대로: 미해석 권역 () 거부 규칙 포함), 둘 다 없으면 None.
      4) 1 이 아니면 도시 의사 코드 scopeParent(SA → SA-*)를 더한다.
    front 와 다른 점: 교집합이 비면 front 는 0 사이트(빈 화면), 백엔드는 () → 403 no_country_scope(default-deny). stg 실측 해당 계정 0.
    raw = 계정 scope_countries 대문자 집합(정렬), data_countries = DataScope.countries(Q10 값: project 표면·세션, 전용 사이트 계정이 아니면 global)."""
    brand_geo = _brand_geo_codes(refs)
    dedicated = dedicated_site_codes(raw, brand_geo)
    if dedicated:
        return dedicated
    if not raw:
        base = data_countries
    elif not p.scope_regions:
        base = raw
    else:
        rhq_iso = {c.upper() for _, cc in refs.rhq.values() for c in cc}
        from_regions = {c.upper() for c in refs.region_countries(p.scope_regions)}
        base = tuple(sorted({c for c in raw if (c in rhq_iso and c in from_regions) or (c not in rhq_iso and c not in brand_geo)}))
        if not base:
            log.warning("계정 국가 %s 가 권역 %s 과 교집합이 비어 website 거부", list(raw), list(p.scope_regions))
    return _with_scope_parent(base) if base else base


@dataclass(frozen=True)
class DataScope:
    """계정 스코프를 표면 공통 값으로 푼 것. None = 제약 없음, 빈 튜플 = 전부 거부.

    all          : scope_all 이거나 admin(Q16: admin 은 DB 값과 무관하게 전체 스코프, DDL CHECK ua_admin_scope_all 로도 강제).
    brands       : 허용 브랜드 코드(엄브렐러 제외). 전체면 None. 브랜드 스코프가 빈 vendor 는 None(현행 무제한, 추가 결정 2026-09-28).
                   그 밖에 엄브렐러만 있는 경우 등 비면 () = 거부.
    countries    : 데이터 필터용 허용 ISO 국가(effectiveScopeCountries: countries 우선, 없으면 regions 전개, 둘 다 없으면 None).
                   권역 id 가 있는데 국가로 안 풀리면 () = 거부(검증 B1: 무제한으로 새지 않게). project 표면·세션 값(Q10). global 은
                   전용 사이트 계정만 global_countries 로 바뀐다(for_surface).
    regions      : 계정 권역(프로젝트 스코프의 브랜드별 권역 판정용).
    raw_countries: 계정 scope_countries 원값(프로젝트 스코프 판정용).
    web_countries: website 표면 국가 스코프(website_scope_countries). web_resolved 거짓이면(of() 를 거치지 않고 직접 만든 값) for_surface 가
                   countries 에 도시 scopeParent 만 더한다(종전 규칙).
    web_brands   : website 표면 브랜드 허용 목록(website_scope_brands: 브랜드 가상 코드가 여는 사이트 브랜드, 동기화 S1 BE-8).
    global_countries: global 표면 국가 스코프(global_scope_countries: 전용 사이트 계정의 글로벌 시장, 동기화 S1 BE-6).
    web_resolved : of() 가 표면 값(web_countries·web_brands·global_countries)을 계산했는가. 거짓이면 global 은 countries 그대로.
    """
    all: bool
    brands: tuple[str, ...] | None
    countries: tuple[str, ...] | None
    regions: tuple[str, ...]
    raw_countries: tuple[str, ...] = ()
    web_countries: tuple[str, ...] | None = None
    web_resolved: bool = False
    web_brands: tuple[str, ...] | None = None
    global_countries: tuple[str, ...] | None = None

    @classmethod
    def of(cls, p: Principal, refs: Refs) -> DataScope:
        if p.scope_all or p.role == "admin":
            if p.role == "admin" and not p.scope_all:
                log.warning("admin 계정 scope_all 거짓(Q16 위반 데이터): 전체 스코프로 취급")
            return cls(True, None, None, ())
        umb = {b.code for b in refs.brands if b.is_umbrella}
        if p.role == "vendor" and not p.scope_brands:
            brands: tuple[str, ...] | None = None
        else:
            brands = tuple(b for b in p.scope_brands if b not in umb)
        raw = tuple(sorted({c.upper() for c in p.scope_countries}))
        if raw:
            countries: tuple[str, ...] | None = raw
        elif p.scope_regions:
            unresolved = [r for r in p.scope_regions if r not in refs.rhq]
            countries = () if unresolved else tuple(refs.region_countries(p.scope_regions))   # 하나라도 미해석이거나 비면 () = 거부
            if not countries:
                log.warning("계정 권역 %s 이 국가로 풀리지 않음(미해석 %s): 데이터 거부", list(p.scope_regions), unresolved)
        else:
            countries = None
        return cls(False, brands, countries, tuple(p.scope_regions), raw,
                   web_countries=website_scope_countries(p, refs, raw, countries), web_resolved=True,
                   web_brands=website_scope_brands(brands, raw, refs),
                   global_countries=global_scope_countries(raw, _brand_geo_codes(refs), countries))

    def for_surface(self, surface: str) -> DataScope:
        """표면별 스코프.
        - website: 국가 = website_scope_countries(현행 front effectiveCountries: 전용 사이트 코드·ISO 권역 교집합·가상 코드 통과·도시
          scopeParent), 브랜드 = website_scope_brands(현행 websiteScopeBrands: 브랜드 가상 코드가 여는 사이트 브랜드).
        - global: 국가 = global_scope_countries(현행 effectiveScopeCountries: 전용 사이트 계정은 그 사이트의 글로벌 시장).
        - project·전체 스코프: 그대로. raw_countries(프로젝트 스코프)·countries(세션 Q10 값)는 바꾸지 않는다(결과 캐시 서명은 이 반환값을 쓴다)."""
        if self.all:
            return self
        if surface == "global":
            if not self.web_resolved or self.global_countries == self.countries:
                return self
            return replace(self, countries=self.global_countries)
        if surface != "website":
            return self
        if self.web_resolved:
            upd: dict[str, Any] = {}
            if self.web_countries != self.countries:
                upd["countries"] = self.web_countries
            if self.web_brands != self.brands:
                upd["brands"] = self.web_brands
            return replace(self, **upd) if upd else self
        if not self.countries:
            return self
        web = _with_scope_parent(self.countries)
        return self if web == self.countries else replace(self, countries=web)

    def brand_allowed(self, code: str | None) -> bool:
        """brand NULL(공통)은 모든 브랜드 계정에 보인다(scope-policy isInScope D5)."""
        return self.brands is None or code is None or code in self.brands

    def country_allowed(self, code: str | None) -> bool:
        return self.countries is None or (code is not None and code.upper() in self.countries)

    def virtual_brand_bits(self, refs: Refs) -> frozenset[int]:
        """국가 스코프 안 브랜드 가상 코드(rd.dim_country kind 'virtual_brand', 예 HYUNDAI-N)의 사이트 브랜드 비트. website 표면 값에서만 의미가 있다."""
        out: set[int] = set()
        for code in self.countries or ():
            c = refs.countries.get(code)
            if c is not None and c.kind == "virtual_brand" and c.virtual_brand_bit is not None:
                out.add(int(c.virtual_brand_bit))
        return frozenset(out)

    def site_allowed(self, refs: Refs, site_brand_bit: int | None, country: str | None) -> bool:
        """website 사이트 하나가 이 스코프(for_surface('website') 값)의 국가 조건을 통과하나(동기화 S1 BE-8). 현행
        websiteScopeCountryCondition(website-sites.ts:96-108): 스코프 국가를 splitWebsiteGeo 로 실 코드·브랜드 가상 코드로 갈라
        country_code ∈ 실 코드 ∨ 사이트 브랜드 ∈ 가상 코드 브랜드. countries None = 제약 없음, () = 거부. 브랜드 허용(관점 브랜드)은 호출자가 건다."""
        if self.countries is None:
            return True
        if site_brand_bit is not None and site_brand_bit in self.virtual_brand_bits(refs):
            return True
        return self.country_allowed(country)

    def project_in_scope(self, refs: Refs, brand: str | None, country: str | None) -> bool:
        """projectInScope(scope-policy.ts:99) 이식: 브랜드 → (그 브랜드 권역 → 국가) → 계정 국가. brand·country NULL 은 통과.
        계정 권역 id 가 하나라도 app.rhq_region 에 없으면(미해석) 비멤버 가시성은 거부한다(검증 N3: 좁히는 규칙이 조용히 빠지지 않게)."""
        if self.all:
            return True
        if any(r not in refs.rhq for r in self.regions):
            return False
        if self.brands and brand and brand not in self.brands:
            return False
        if brand and country:
            rids = [r for r in self.regions if refs.rhq.get(r, ("", ()))[0] == brand]
            if rids and country.upper() not in set(refs.region_countries(rids)):
                return False
        return not (self.raw_countries and country and country.upper() not in self.raw_countries)


# ════════════════════════════════════════════════════════════════════════════
# 프로젝트 접근(require_project)
# ════════════════════════════════════════════════════════════════════════════
ProjectLevel = Literal["member", "active_member", "owner", "operate", "owner_and_operate"]


@dataclass(frozen=True)
class ProjectAccess:
    project_id: uuid.UUID
    project_keys: tuple[int, ...]      # rd.dim_project(surface 3) 키(측정 전이면 빈 튜플)
    brand_code: str | None
    country_code: str
    member_role: str | None            # owner|viewer|None(비멤버 스코프 열람·admin)
    scope_project_id: uuid.UUID | None = None   # Scope 프로젝트 id(링크 전 None). 아웃박스 payload 용


async def resolve_project(conn: AsyncConnection, p: Principal, refs: Refs, project_id: uuid.UUID,
                          level: ProjectLevel = "member", *, members_only: bool = False) -> ProjectAccess:
    """고객 프로젝트 접근. 없음·standard_root·비가시는 전부 404(IDOR 은폐), 보이지만 등급 부족은 403.
    가시 = admin ∨ 활성 멤버 ∨ (vendor 아님 ∧ 프로젝트 브랜드×국가가 계정 스코프 안)(2026-07-02 결정 계승, front scope/server.ts:358
    assertProjectInScope 와 같은 판정).

    level
      member            가시면 통과(비멤버 스코프 열람 포함)
      active_member     admin ∨ 활성 멤버(비멤버는 가시여도 404: 현행 프로젝트 페이지 게이트 page.tsx·member/page.tsx notFound)
      owner             admin ∨ 활성 Owner(가시 비멤버·viewer 는 403 owner_only)
      operate           운영자(can_operate_project, global 은 가시 = 스코프 안 ∨ 활성 멤버)
      owner_and_operate 둘 다
    members_only=True 면 어느 level 이든 비멤버(admin 제외)를 먼저 404 로 숨긴다(멤버 전용 화면의 쓰기 경로)."""
    r = await fetch_one(conn, """
        SELECT p.project_id, p.kind, p.brand_code, p.country_code, p.scope_project_id,
               m.role::text AS member_role, m.status::text AS member_status,
               coalesce((SELECT array_agg(d.project_key ORDER BY d.project_key) FROM rd.dim_project d
                          WHERE d.project_id = p.project_id AND d.surface = 3), '{}') AS keys
          FROM app.project p
          LEFT JOIN app.project_member m ON m.project_id = p.project_id AND m.user_id = :uid
         WHERE p.project_id = :pid""", {"pid": project_id, "uid": p.user_id})
    if r is None or r["kind"] != "customer":
        raise errors.not_found("프로젝트 없음")
    active = r["member_status"] == "active"
    scope = DataScope.of(p, refs)
    visible = p.is_admin or active or (p.role != "vendor" and scope.project_in_scope(refs, r["brand_code"], r["country_code"]))
    if not visible or ((members_only or level == "active_member") and not (p.is_admin or active)):
        raise errors.not_found("프로젝트 없음")
    spid = r["scope_project_id"]
    acc = ProjectAccess(uuid.UUID(str(r["project_id"])), tuple(r["keys"] or ()), r["brand_code"], r["country_code"],
                        r["member_role"] if active else None, uuid.UUID(str(spid)) if spid is not None else None)
    if level in ("owner", "owner_and_operate") and not (p.is_admin or (active and r["member_role"] == "owner")):
        raise errors.forbidden("프로젝트 소유자 전용", code="owner_only")
    if level in ("operate", "owner_and_operate") and not can_operate_project(p, active):
        raise errors.forbidden("운영 권한 없음", code="operator_forbidden")
    return acc


# ════════════════════════════════════════════════════════════════════════════
# 검수(QA) 별도 게이트(Q17): 계정 없는 외부 검수자, 이름 + 공유 비밀번호 → HMAC 서명 세션 쿠키
#   현행 lib/qa/auth.ts 이식. 쿠키 = base64url(JSON{sessionId,name,issuedAt}).HMAC. 하드 만료 12시간.
#   role 스코프 체계 밖이므로 QA 조회·쓰기는 qa_gate 풀로만 한다(QA 모듈이 get_qa_conn 을 쓴다).
# ════════════════════════════════════════════════════════════════════════════
QA_COOKIE = "raw_data_qa"
QA_MAX_AGE_S = 12 * 60 * 60
_QA_MAX_NAME = 40
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_ephemeral_qa_secret: bytes | None = None


@dataclass(frozen=True)
class QaReviewer:
    session_id: str
    name: str
    issued_at: float = field(default=0.0)


def _qa_secret(settings: Settings) -> bytes:
    global _ephemeral_qa_secret
    if settings.qa_secret is not None:
        return settings.qa_secret.get_secret_value().encode()
    if not settings.is_dev:
        raise RuntimeError("HGH_QA_SECRET 미설정")
    if _ephemeral_qa_secret is None:
        _ephemeral_qa_secret = secrets.token_bytes(32)
        log.warning("HGH_QA_SECRET 미설정: 프로세스 임시 키 사용(local·test 전용)")
    return _ephemeral_qa_secret


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_qa_cookie(r: QaReviewer, settings: Settings | None = None) -> str:
    s = settings or get_settings()
    payload = _b64(json.dumps({"sessionId": r.session_id, "name": r.name, "issuedAt": int(r.issued_at * 1000)},
                              separators=(",", ":"), ensure_ascii=False).encode())
    sig = _b64(hmac.new(_qa_secret(s), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def verify_qa_cookie(raw: str | None, settings: Settings | None = None, now: float | None = None) -> QaReviewer | None:
    if not raw:
        return None
    s = settings or get_settings()
    parts = raw.split(".")
    if len(parts) != 2:
        return None
    payload, sig = parts
    try:   # 비ASCII·서로게이트가 섞인 변조 쿠키는 compare_digest(str) 가 TypeError 를 낸다 → 바이트로 비교, 실패는 거부
        expected = _b64(hmac.new(_qa_secret(s), payload.encode("utf-8"), hashlib.sha256).digest())
        if not hmac.compare_digest(sig.encode("utf-8"), expected.encode("ascii")):
            return None
    except (UnicodeError, TypeError, ValueError):
        return None
    try:
        d = json.loads(_unb64(payload).decode())
        sid, name, issued_ms = d["sessionId"], d["name"], d["issuedAt"]
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(sid, str) or not isinstance(name, str) or not isinstance(issued_ms, (int, float)):
        return None
    t = time.time() if now is None else now
    if t - issued_ms / 1000 > QA_MAX_AGE_S:
        return None
    return QaReviewer(sid, name, issued_ms / 1000)


def check_qa_password(given: str, settings: Settings | None = None) -> bool:
    """공유 비밀번호 비교(상수 시간). 설정이 없으면 항상 거부(기본 비밀번호 없음)."""
    s = settings or get_settings()
    if s.qa_password is None:
        return False
    return hmac.compare_digest((given or "").encode(), s.qa_password.get_secret_value().encode())


def normalize_reviewer_name(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    cleaned = _CONTROL.sub("", raw).strip()
    if not cleaned or len(cleaned) > _QA_MAX_NAME:
        return None
    return cleaned


def rate_key_ip(ip: str | None) -> str | None:
    """시도 상한 버킷 키용 주소. IPv6 는 /64 접두(예: '2001:db8:1:2::/64'), IPv4·IPv4 사상 IPv6 는 IPv4 주소 그대로.
    주소로 읽히지 않는 값(비어 있음·형식 오류)은 원문 그대로 둔다."""
    if not ip:
        return ip
    try:
        addr = ipaddress.ip_address(ip.strip().strip("[]").split("%", 1)[0])
    except ValueError:
        return ip
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            return str(addr.ipv4_mapped)
        return str(ipaddress.IPv6Network((int(addr) >> 64 << 64, 64)))
    return str(addr)


RELAY_SECRET_HEADER = "x-hgh-relay-secret"
RELAY_CLIENT_IP_HEADER = "x-hgh-client-ip"


def relay_client_ip(request: Request, settings: Settings | None = None) -> str | None:
    """신뢰 중계(BFF) 헤더의 클라이언트 IP(결정 D2). 다음을 모두 만족할 때만 값을 낸다(아니면 None = 헤더 무시).
    - core.config.relay_secret(HGH_RELAY_SECRET)이 설정돼 있다.
    - X-HGH-Relay-Secret 헤더가 정확히 1개이고 그 값이 비밀과 상수 시간 비교(hmac.compare_digest, 바이트)로 같다.
    - X-HGH-Client-IP 헤더가 정확히 1개이고 IPv4·IPv6 주소로 읽힌다(64자 이하). 값은 표준 표기(ipaddress)로 돌려준다.
    뷰어가 두 헤더를 직접 보내도 비밀을 모르면 무시된다. BFF 는 뷰어가 보낸 두 헤더를 지우고 자기 값을 붙여야 한다."""
    s = settings or get_settings()
    if s.relay_secret is None:
        return None
    given = request.headers.getlist(RELAY_SECRET_HEADER)
    if len(given) != 1:
        return None
    try:
        ok = hmac.compare_digest(given[0].encode("utf-8"), s.relay_secret.get_secret_value().encode("utf-8"))
    except (UnicodeError, TypeError, ValueError):
        return None
    if not ok:
        return None
    ips = request.headers.getlist(RELAY_CLIENT_IP_HEADER)
    if len(ips) != 1 or len(ips[0].strip()) > 64:
        return None
    try:
        return str(ipaddress.ip_address(ips[0].strip()))
    except ValueError:
        return None


def client_ip(request: Request, hops: int | None = None) -> str | None:
    """클라이언트 IP. 신뢰 중계 헤더(relay_client_ip, D2)가 유효하면 그 값, 아니면 신뢰 프록시가 붙인 X-Forwarded-For 원소
    (오른쪽에서 hops 번째, 기본 core.config.trusted_proxy_hops). 왼쪽 원소는 뷰어가 위조할 수 있어 쓰지 않는다. hops=0 이거나
    원소가 모자라면(프록시를 거치지 않은 요청·구성 불일치) 소켓 주소로 폴백한다.
    배포(CloudFront → ALB → 앱)는 2. uvicorn 을 --forwarded-allow-ips='*' 로 띄우지 않는다(소켓 주소 폴백이 뷰어 XFF 로 바뀐다)."""
    relayed = relay_client_ip(request)
    if relayed is not None:
        return relayed
    n = get_settings().trusted_proxy_hops if hops is None else hops
    if n > 0:
        parts = [x.strip() for x in ",".join(request.headers.getlist("x-forwarded-for")).split(",")]
        parts = [x for x in parts if x]
        if len(parts) >= n and len(parts[-n]) <= 64:
            return parts[-n]
    return request.client.host if request.client else None


def hash_ip(ip: str | None, settings: Settings | None = None) -> str | None:
    if not ip:
        return None
    s = settings or get_settings()
    return _b64(hmac.new(_qa_secret(s), f"ip:{ip}".encode(), hashlib.sha256).digest())


async def require_qa_reviewer(request: Request) -> QaReviewer:
    """QA 경로 첫 관문(킬 스위치 HGH_QA_ENABLED + 서명 쿠키). 실패는 401 qa_unauthorized."""
    s = get_settings()
    if not s.qa_enabled:
        raise errors.unauthenticated("검수 콘솔 꺼짐", code="qa_unauthorized")
    r = verify_qa_cookie(request.cookies.get(QA_COOKIE), s)
    if r is None:
        raise errors.unauthenticated("검수 세션 없음", code="qa_unauthorized")
    request.state.qa_reviewer = r
    return r


QaUser = Annotated[QaReviewer, Depends(require_qa_reviewer)]


async def get_qa_conn(reviewer: QaUser) -> AsyncIterator[AsyncConnection]:
    """검수 게이트(Q17) 전용 풀: qa_gate 롤(rd 읽기 일부 + app.qa_* 4표 쓰기). 검수 세션(QaUser)을 먼저 통과해야 커넥션을 연다."""
    async with get_db().transaction("qa_gate") as conn:
        yield conn


QaConn = Annotated[AsyncConnection, Depends(get_qa_conn, scope="function")]

_QA_SESSION_SQL = ("SELECT session_id, reviewer_name, started_at, last_seen_at FROM app.qa_review_session WHERE session_id = :sid "
                   "FOR KEY SHARE")


async def assert_qa_session(conn: AsyncConnection, reviewer: QaReviewer) -> dict[str, Any]:
    """쿠키의 세션 행이 살아 있는지(읽기 게이트·쓰기 전). 지워졌거나(로그아웃·운영 폐기) 형식이 틀리면 401 qa_unauthorized.
    행을 FOR KEY SHARE 로 트랜잭션 끝까지 잡아 로그아웃(FOR UPDATE → 삭제)과 직렬화한다(겹치면 401, FK 500 없음)."""
    try:
        sid = uuid.UUID(reviewer.session_id)
    except ValueError as e:
        raise errors.unauthenticated("검수 세션 형식 오류", code="qa_unauthorized") from e
    row = await fetch_one(conn, _QA_SESSION_SQL, {"sid": sid})
    if row is None:
        raise errors.unauthenticated("검수 세션 만료", code="qa_unauthorized")
    return row


async def get_live_qa_conn(reviewer: QaUser, conn: QaConn) -> AsyncConnection:
    """QaConn + 세션 행 존재 확인(PK 등치 1회). 세션 행을 지우면 읽기도 즉시 401 이다. 새 QA 경로는 기본으로 이것을 쓴다."""
    await assert_qa_session(conn, reviewer)
    return conn


QaLiveConn = Annotated[AsyncConnection, Depends(get_live_qa_conn)]


def new_qa_session(name: str) -> QaReviewer:
    return QaReviewer(str(uuid.uuid4()), name, time.time())


def roles_of(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(values)
