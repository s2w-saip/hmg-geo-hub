"""환경 설정. 값은 환경 변수로만 받는다(배포는 Secrets Manager → 환경 변수 주입). 비밀값은 SecretStr 로 들고 출력하지 않는다.

환경 변수
  HGH_ENV                 local | test | stg | prod (필수 아님, 기본 local)
  HGH_DB_URL              모든 풀의 기본 접속 URL(postgresql://…). 풀별 URL 이 없으면 이것을 쓰고 트랜잭션마다 풀 롤로 전환한다.
  HGH_DB_URL_API_RO       api_ro 풀 전용 URL(선택)
  HGH_DB_URL_API_RW       api_rw 풀 전용 URL(선택)
  HGH_DB_URL_ADMIN_LONG   admin_long 풀 전용 URL(선택)
  HGH_DB_URL_QA_GATE      qa_gate 풀 전용 URL(선택)
  HGH_DB_ASSUME_ROLE      1(기본) = 트랜잭션 시작 시 set_config('role', <풀 롤>, true) 로 롤 전환. 로그인 롤이 곧 풀 롤이면 0
  HGH_DB_POOL_SIZE        풀당 크기(기본 5), HGH_DB_MAX_OVERFLOW(기본 5)
  HGH_DB_SSLROOTCERT      DB TLS 루트 CA 번들 경로(선택, D-5: RDS CA 번들 PEM). 설정되면 모든 DB 연결(API 풀·적재 워커 asyncpg, libpq 도구)을
                          sslmode=verify-full(서버 인증서 체인 + 호스트 이름 검증)로 연다. URL 의 sslmode 보다 우선. 미설정 = 현행(URL sslmode)
  HGH_JWKS_URL            Supabase JWKS URL(https://<ref>.supabase.co/auth/v1/.well-known/jwks.json)
  HGH_JWT_AUDIENCE        기본 authenticated
  HGH_JWT_ISSUER          iss 검증 값(stg·prod 필수, local·test 선택)
  HGH_QA_ENABLED          1 이면 검수 게이트 켬(Q17). 기본 꺼짐
  HGH_QA_SECRET           검수 쿠키 HMAC 키(stg·prod 필수, local·test 는 미설정 시 프로세스 임시 키)
  HGH_QA_PASSWORD         검수 공유 비밀번호(미설정이면 로그인 전부 거부: 기본 비밀번호 없음)
  HGH_ACCESS_AUDIT        1(기본) = 민감 조회 접근 감사 비동기 기록(Q4)
  HGH_SQL_GUARD           1 = 실행 전 SQL 경계 가드(core.sqlguard, 위반 시 SqlGuardError). local·test 기본 1, stg·prod 기본 0
  HGH_TRUSTED_PROXY_HOPS  클라이언트 IP = X-Forwarded-For 오른쪽에서 센 이 수만큼의 원소(0~5, 기본 0 = 소켓 주소). 배포(CloudFront → ALB →
                          앱)는 2. 옛 이름 HGH_QA_TRUSTED_PROXY_HOPS 도 읽는다. uvicorn --forwarded-allow-ips='*' 로 띄우지 않는다
  HGH_RELAY_SECRET        신뢰 중계(BFF) 공유 비밀(선택, 16자 이상). 설정되면 요청의 X-HGH-Relay-Secret 이 이 값과 상수 시간 비교로 일치할 때만
                          X-HGH-Client-IP 를 클라이언트 IP 로 쓴다(core.auth.client_ip, 결정 D2). 미설정·불일치면 그 헤더를 무시한다
  HGH_UPLOAD_MAX_BYTES    업로드(multipart·원본 바이트) 본문 상한(기본 10 MiB)
  HGH_RESULT_CACHE        1 = 데이터 버전 기반 결과 캐시 켬(core.result_cache, DB-v2.11). 기본 0(끔: 캐시 경로 자체가 없다)
  HGH_BUILD_ID            결과 캐시 키의 앱 빌드 식별자(배포 sha 등, 선택). 없으면 app 소스·잠금 파일 지문. API·데우기 프로세스가 같은 값이어야 한다
  HGH_LEGACY_PROFILE      현행 프로필(core.profile, 제품 결정 19·23~25): off | current | 스위치 이름 쉼표 목록. 기본 core.profile.DEFAULT_SPEC.
                          구현되지 않은 스위치를 켜면 적재 실패. off 가 아니면 결과 캐시 키에 프로필 지문이 들어간다. API·데우기·적재 워커가 같은 값이어야 한다
  검수(QA) 범위(Q17 서버 고정)
  HGH_QA_SURFACES         쉼표 구분 global|website|project(기본 셋 다)
  HGH_QA_SINCE            YYYY-MM-DD. 있으면 round_date ≥ 이 날짜인 job 만 검수 대상
  외부 서비스(비밀값은 SecretStr, 출력·argv 금지)
  HGH_SUPABASE_URL·HGH_SUPABASE_SERVICE_ROLE_KEY·HGH_SUPABASE_TIMEOUT_S(기본 10)   계정 관리(Supabase Admin)
  HGH_GA4_CREDENTIALS_JSON·HGH_GA4_TIMEOUT_S(기본 10)                            GA4 자격증명 JSON(service_account 또는 authorized_user)
  HGH_OPENROUTER_API_KEY·HGH_OPENROUTER_BASE_URL(기본 https://openrouter.ai/api/v1)·HGH_OPENROUTER_MODEL(기본 google/gemini-2.5-flash)·
  HGH_OPENROUTER_TIMEOUT_S(기본 60)                                              LLM(core.llm). 호출별 상한은 호출자가 더 길게 줄 수 있다
  HGH_CONTEXT_MAP_INDUSTRY_ENTITY_ID·HGH_CONTEXT_MAP_KEYWORD(기본 '자동차')         컨텍스트 맵(intent.social.context_map)
  적재 워커(load_settings(purpose='worker'))
  HGH_INGEST_DB_URL       loader 롤 직접 연결 URL(PgBouncer 미경유). 없으면 HGH_DB_URL(로컬 개발)
  HGH_INGEST_DB_ROLE      연결 직후 SET ROLE 할 롤(로컬 개발 = loader. 운영은 로그인 롤이 곧 loader 라 비움)
  HGH_INGEST_STATEMENT_TIMEOUT 적재 트랜잭션 문장 상한(기본 180s)
  HGH_INGEST_SYSTEM_ACTOR 아웃박스·scope_prompt 되쓰기 행위자(app.user_account 시스템 사용자 uuid)
  HGH_SCOPE_API_URL·HGH_SCOPE_API_KEY                                            Scope /api/v1
  HGH_DFS_API_URL·HGH_DFS_LOGIN·HGH_DFS_PASSWORD                                 DataForSEO
  HGH_ALERT_SLACK_WEBHOOK 라이브 경보 Slack Incoming Webhook(#ops-alerts, 선택). ingest.common.alerts 만 읽는다. 값이
                          https://hooks.slack.com/services/ 로 시작하지 않으면 미배선으로 본다(로그 싱크). 값은 출력·로그 금지
"""
from __future__ import annotations

import os
import uuid
from datetime import date
from functools import lru_cache
from typing import Literal

from pydantic import BaseModel, SecretStr

from app.core.profile import DEFAULT_SPEC, parse_profile

Env = Literal["local", "test", "stg", "prod"]
PoolName = Literal["api_ro", "api_rw", "admin_long", "qa_gate"]
POOLS: tuple[PoolName, ...] = ("api_ro", "api_rw", "admin_long", "qa_gate")


class Settings(BaseModel):
    env: Env = "local"
    db_url: SecretStr | None = None
    db_urls: dict[str, SecretStr] = {}
    db_assume_role: bool = True
    db_pool_size: int = 5
    db_max_overflow: int = 5
    db_sslrootcert: str | None = None  # D-5: 있으면 모든 DB 연결 verify-full(core.db.ssl_context)
    jwks_url: str | None = None
    jwt_audience: str = "authenticated"
    jwt_issuer: str | None = None
    qa_enabled: bool = False
    qa_secret: SecretStr | None = None
    qa_password: SecretStr | None = None
    access_audit: bool = True
    sql_guard: bool = False           # 실행 전 SQL 경계 가드(core.sqlguard). local·test 기본 켬, stg·prod 기본 끔
    trusted_proxy_hops: int = 0       # core.auth.client_ip: XFF 오른쪽에서 센 원소 수(0 = 소켓 주소)
    relay_secret: SecretStr | None = None   # core.auth.client_ip: 신뢰 중계 헤더(X-HGH-Client-IP) 수용 비밀(D2). None 이면 헤더 무시
    upload_max_bytes: int = 10 * 1024 * 1024
    result_cache: bool = False        # core.result_cache(HGH_RESULT_CACHE). 기본 끔
    build_id: str | None = None       # 결과 캐시 키의 빌드 식별자(HGH_BUILD_ID). None = 소스 지문(core.result_cache.build_id)
    legacy_profile: str = "off"       # 현행 프로필 정규 표기(HGH_LEGACY_PROFILE, core.profile.parse_profile 로 검증된 값)
    qa_surfaces: tuple[str, ...] = ("global", "website", "project")
    qa_since: date | None = None
    # 외부 서비스
    supabase_url: str | None = None
    supabase_service_role_key: SecretStr | None = None
    supabase_timeout_s: float = 10.0
    ga4_credentials_json: SecretStr | None = None
    ga4_timeout_s: float = 10.0
    openrouter_api_key: SecretStr | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = "google/gemini-2.5-flash"
    openrouter_timeout_s: float = 60.0
    context_map_industry_entity_id: uuid.UUID | None = None
    context_map_keyword: str = "자동차"
    # 적재 워커
    ingest_db_url: SecretStr | None = None
    ingest_db_role: str | None = None
    ingest_statement_timeout: str = "180s"
    ingest_system_actor: uuid.UUID | None = None
    scope_api_url: str | None = None
    scope_api_key: SecretStr | None = None
    dfs_api_url: str | None = None
    dfs_login: SecretStr | None = None
    dfs_password: SecretStr | None = None
    alert_slack_webhook: SecretStr | None = None   # ingest.common.alerts SlackAlertSink(라이브 경보). 값 출력 금지

    @property
    def is_dev(self) -> bool:
        return self.env in ("local", "test")

    def url_for(self, pool: PoolName) -> SecretStr | None:
        return self.db_urls.get(pool) or self.db_url

    @property
    def loader_url(self) -> SecretStr | None:
        """적재 워커 연결 URL(HGH_INGEST_DB_URL, 없으면 HGH_DB_URL)."""
        return self.ingest_db_url or self.db_url

    def __repr__(self) -> str:  # 비밀값·URL 을 로그에 남기지 않는다
        return (f"Settings(env={self.env!r}, pools={sorted(k for k in POOLS if self.url_for(k))}, jwks={'set' if self.jwks_url else 'unset'}, "
                f"db_tls={'verify-full' if self.db_sslrootcert else 'url'})")

    __str__ = __repr__


_QA_SURFACES = ("global", "website", "project")
RELAY_SECRET_MIN_LEN = 16            # HGH_RELAY_SECRET 최소 길이(짧은 비밀은 추측 대입 위험)


def _sec(e: dict[str, str] | os._Environ[str], k: str) -> SecretStr | None:
    v = e.get(k)
    return SecretStr(v) if v else None


def _qa_surfaces(raw: str) -> tuple[str, ...]:
    if not raw.strip():
        return _QA_SURFACES
    vals = tuple(dict.fromkeys(x.strip().lower() for x in raw.split(",") if x.strip()))
    bad = [x for x in vals if x not in _QA_SURFACES]
    if bad or not vals:
        raise ValueError(f"HGH_QA_SURFACES 는 global|website|project 쉼표 목록: {bad}")
    return vals


def load_settings(environ: dict[str, str] | None = None, *, purpose: Literal["api", "worker"] = "api") -> Settings:
    """환경 변수 → Settings. purpose='worker'(적재 워커)는 API 인증(JWKS·issuer) 필수 검증을 하지 않고 loader URL 을 요구한다."""
    e = os.environ if environ is None else environ
    env = (e.get("HGH_ENV") or "local").strip()
    if env not in ("local", "test", "stg", "prod"):
        raise ValueError("HGH_ENV 는 local|test|stg|prod")
    urls = {p: SecretStr(e[f"HGH_DB_URL_{p.upper()}"]) for p in POOLS if e.get(f"HGH_DB_URL_{p.upper()}")}
    hops_raw = (e.get("HGH_TRUSTED_PROXY_HOPS") or e.get("HGH_QA_TRUSTED_PROXY_HOPS") or "0").strip()
    if not hops_raw.isdigit() or not 0 <= int(hops_raw) <= 5:
        raise ValueError("HGH_TRUSTED_PROXY_HOPS 는 0~5")
    relay_raw = e.get("HGH_RELAY_SECRET") or ""
    if relay_raw and len(relay_raw) < RELAY_SECRET_MIN_LEN:
        raise ValueError(f"HGH_RELAY_SECRET 는 {RELAY_SECRET_MIN_LEN}자 이상")
    rootcert = (e.get("HGH_DB_SSLROOTCERT") or "").strip() or None
    if rootcert is not None and not os.path.isfile(rootcert):
        raise ValueError("HGH_DB_SSLROOTCERT 파일이 없다(RDS CA 번들 PEM 경로)")
    since_raw = (e.get("HGH_QA_SINCE") or "").strip()
    try:
        qa_since = date.fromisoformat(since_raw) if since_raw else None
    except ValueError as ex:
        raise ValueError("HGH_QA_SINCE 는 YYYY-MM-DD") from ex
    ind = (e.get("HGH_CONTEXT_MAP_INDUSTRY_ENTITY_ID") or "").strip()
    actor = (e.get("HGH_INGEST_SYSTEM_ACTOR") or "").strip()
    s = Settings(
        env=env,  # type: ignore[arg-type]
        db_url=SecretStr(e["HGH_DB_URL"]) if e.get("HGH_DB_URL") else None,
        db_urls=urls,
        db_assume_role=(e.get("HGH_DB_ASSUME_ROLE", "1").strip().lower() in ("1", "true", "yes", "on")),
        db_pool_size=int(e.get("HGH_DB_POOL_SIZE", "5")),
        db_max_overflow=int(e.get("HGH_DB_MAX_OVERFLOW", "5")),
        db_sslrootcert=rootcert,
        jwks_url=e.get("HGH_JWKS_URL") or None,
        jwt_audience=e.get("HGH_JWT_AUDIENCE") or "authenticated",
        jwt_issuer=e.get("HGH_JWT_ISSUER") or None,
        qa_enabled=(e.get("HGH_QA_ENABLED", "").strip() == "1"),
        qa_secret=SecretStr(e["HGH_QA_SECRET"]) if e.get("HGH_QA_SECRET") else None,
        qa_password=SecretStr(e["HGH_QA_PASSWORD"]) if e.get("HGH_QA_PASSWORD") else None,
        access_audit=(e.get("HGH_ACCESS_AUDIT", "1").strip() != "0"),
        sql_guard=(e.get("HGH_SQL_GUARD", "1" if env in ("local", "test") else "0").strip() == "1"),
        trusted_proxy_hops=int(hops_raw),
        relay_secret=SecretStr(relay_raw) if relay_raw else None,
        upload_max_bytes=int(e.get("HGH_UPLOAD_MAX_BYTES") or 10 * 1024 * 1024),
        result_cache=(e.get("HGH_RESULT_CACHE", "0").strip() == "1"),
        build_id=(e.get("HGH_BUILD_ID") or "").strip() or None,
        legacy_profile=parse_profile(e.get("HGH_LEGACY_PROFILE") or DEFAULT_SPEC).spec,
        qa_surfaces=_qa_surfaces(e.get("HGH_QA_SURFACES") or ""),
        qa_since=qa_since,
        supabase_url=(e.get("HGH_SUPABASE_URL") or "").rstrip("/") or None,
        supabase_service_role_key=_sec(e, "HGH_SUPABASE_SERVICE_ROLE_KEY"),
        supabase_timeout_s=float(e.get("HGH_SUPABASE_TIMEOUT_S") or 10),
        ga4_credentials_json=_sec(e, "HGH_GA4_CREDENTIALS_JSON"),
        ga4_timeout_s=float(e.get("HGH_GA4_TIMEOUT_S") or 10),
        openrouter_api_key=_sec(e, "HGH_OPENROUTER_API_KEY"),
        openrouter_base_url=(e.get("HGH_OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/"),
        openrouter_model=e.get("HGH_OPENROUTER_MODEL") or "google/gemini-2.5-flash",
        openrouter_timeout_s=float(e.get("HGH_OPENROUTER_TIMEOUT_S") or 60),
        context_map_industry_entity_id=uuid.UUID(ind) if ind else None,
        context_map_keyword=(e.get("HGH_CONTEXT_MAP_KEYWORD") or "자동차").strip() or "자동차",
        ingest_db_url=_sec(e, "HGH_INGEST_DB_URL"),
        ingest_db_role=(e.get("HGH_INGEST_DB_ROLE") or None),
        ingest_statement_timeout=e.get("HGH_INGEST_STATEMENT_TIMEOUT") or "180s",
        ingest_system_actor=uuid.UUID(actor) if actor else None,
        scope_api_url=e.get("HGH_SCOPE_API_URL") or None,
        scope_api_key=_sec(e, "HGH_SCOPE_API_KEY"),
        dfs_api_url=e.get("HGH_DFS_API_URL") or None,
        dfs_login=_sec(e, "HGH_DFS_LOGIN"),
        dfs_password=_sec(e, "HGH_DFS_PASSWORD"),
        alert_slack_webhook=_sec(e, "HGH_ALERT_SLACK_WEBHOOK"),
    )
    if purpose == "worker":
        if not s.is_dev and s.loader_url is None:
            raise ValueError("stg·prod 워커는 HGH_INGEST_DB_URL 필수")
        return s
    if not s.is_dev:
        if s.qa_enabled and s.qa_secret is None:
            raise ValueError("stg·prod 에서 HGH_QA_ENABLED=1 이면 HGH_QA_SECRET 필수")
        if s.jwks_url is None:
            raise ValueError("stg·prod 에서 HGH_JWKS_URL 필수")
        if s.jwt_issuer is None:
            raise ValueError("stg·prod 에서 HGH_JWT_ISSUER 필수(https://<ref>.supabase.co/auth/v1)")
    return s


_override: Settings | None = None


@lru_cache(maxsize=1)
def _from_env() -> Settings:
    return load_settings()


def get_settings() -> Settings:
    """프로세스 설정(환경 변수 1회 읽기). 테스트는 set_settings 로 교체한다."""
    return _override if _override is not None else _from_env()


def set_settings(s: Settings | None) -> None:
    """테스트·도구 전용 설정 교체(None = 환경 변수로 복귀)."""
    global _override
    _override = s
    _from_env.cache_clear()
