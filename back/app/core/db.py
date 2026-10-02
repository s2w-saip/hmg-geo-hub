"""DB 세션: 풀 4종(api_ro·api_rw·admin_long·qa_gate), 요청당 한 커넥션·한 트랜잭션.

규약(전체-통합 §5 core.db, DESIGN-CONTRACT §5)
- asyncpg + SQLAlchemy 2 Core(text). PgBouncer transaction 모드 호환: asyncpg statement_cache_size=0,
  SQLAlchemy prepared_statement_cache_size=0, 이름 없는 충돌 방지 prepared statement 이름.
- 커넥션 수: 읽기 요청 = api_ro 1(계정 조회와 지표가 의존성 캐시로 한 커넥션·한 트랜잭션을 공유),
  쓰기 요청 = 계정 조회용 api_ro 1 + api_rw 1, 검수 요청 = qa_gate 1(core.auth.QaConn). 읽기는 READ ONLY REPEATABLE READ(한 스냅샷).
  한 요청 안에서 같은 풀 커넥션을 둘 이상 열지 않고 문장은 순차 실행한다(병렬 커넥션 분할 금지).
- 세션 GUC 는 set_config(…, true)(트랜잭션 로컬)만 쓴다. SET(세션) 금지: 풀 커넥션에 값이 새어 다음 요청에 남는다.
- 롤: 풀 전용 URL 이 없으면 공용 URL 로 접속해 트랜잭션마다 set_config('role', <풀 롤>, true) 로 전환한다(롤 권한이 곧 경계).
  롤 기본 설정(ALTER ROLE … SET)은 SET ROLE 로 상속되지 않으므로 statement_timeout·jit·plan_cache_mode 를 트랜잭션마다 명시한다.
- 쓰기(api_rw)는 BEGIN 직후 set_config('app.actor_id', <user uuid>, true). app.actor() 가 미설정 쓰기를 거부한다(DB-v2 :96).
- rd 를 읽는 쓰기 핸들러는 api_ro 로 먼저 읽고 api_rw 트랜잭션에서 app 만 쓴다(api_rw 는 rd USAGE 없음).
- LLM·외부 호출은 커넥션을 쥔 채 하지 않는다(시그니처로 강제: 외부 호출 함수는 conn 인자를 받지 않는다).
  그런 핸들러는 core.auth.CurrentUserDetached + RoSession(짧은 api_ro 트랜잭션을 여는 함수)으로 읽기 → (커넥션 없음) 외부 호출 → 쓰기.
"""
from __future__ import annotations

import logging
import ssl
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID, uuid4

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from app.core.config import POOLS, PoolName, Settings, get_settings

log = logging.getLogger("hgh.db")


@dataclass(frozen=True)
class PoolSpec:
    role: str
    read_only: bool
    isolation: str
    statement_timeout: str
    extra: tuple[tuple[str, str], ...] = ()


POOL_SPECS: dict[str, PoolSpec] = {
    # DB-v2 §10: api_ro 롤 기본 5s·read_only·force_custom_plan·jit off 를 트랜잭션마다 재현한다.
    # force_custom_plan 은 범용 계획 전환(같은 준비문 6번째 실행부터, 1년 창 2~5배 느림: stg 2026-10-01 실측) 방지의 한 겹이고, 다른 한 겹은
    # asyncpg_url 의 준비문 재사용 금지다. 둘 다 tests/core/test_plan_cache_mode.py 가 단언한다(연결 시작 설정 server_settings 는 쓰지 않는다:
    # PgBouncer transaction 모드는 모르는 시작 파라미터를 거부할 수 있고, 트랜잭션 로컬 값이 이미 같은 효과다).
    "api_ro": PoolSpec("api_ro", True, "REPEATABLE READ", "5s", (("jit", "off"), ("plan_cache_mode", "force_custom_plan"))),
    "admin_long": PoolSpec("admin_long", True, "REPEATABLE READ", "30s", (("jit", "off"), ("plan_cache_mode", "force_custom_plan"))),
    "api_rw": PoolSpec("api_rw", False, "READ COMMITTED", "10s", (("jit", "off"),)),
    "qa_gate": PoolSpec("qa_gate", False, "READ COMMITTED", "5s", (("jit", "off"),)),
}


def ssl_context(rootcert: str, *, verify_hostname: bool = True) -> ssl.SSLContext:
    """루트 CA 번들(PEM)로 서버 인증서를 검증하는 TLS 컨텍스트(D-5). verify_hostname=True = libpq sslmode=verify-full
    (체인 + 호스트 이름), False = verify-ca(체인만). 번들 파일을 못 읽으면 기동 시점에 실패한다(조용히 require 로 내려가지 않는다)."""
    ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=rootcert)
    ctx.check_hostname = verify_hostname
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def asyncpg_url(url: str, *, sslrootcert: str | None = None) -> tuple[str, dict[str, Any]]:
    """postgresql://…?sslmode=… → (postgresql+asyncpg://…, connect_args). asyncpg 는 sslmode 를 모르므로 ssl 인자로 옮긴다.
    D-5: sslrootcert(설정 HGH_DB_SSLROOTCERT)가 있으면 URL 의 sslmode 와 무관하게 verify-full 컨텍스트. URL 이 직접
    sslmode=verify-full|verify-ca&sslrootcert=<경로> 를 주면 그 CA 로 같은 컨텍스트(asyncpg 연결 인자에 sslrootcert 가 새지 않게 뺀다)."""
    parts = urlsplit(url)
    scheme = "postgresql+asyncpg"
    q = dict(parse_qsl(parts.query))
    connect_args: dict[str, Any] = {"statement_cache_size": 0, "prepared_statement_name_func": lambda: f"__hgh_{uuid4().hex}__"}
    mode = q.pop("sslmode", None)
    url_root = q.pop("sslrootcert", None)
    if sslrootcert:
        connect_args["ssl"] = ssl_context(sslrootcert)
    elif url_root and mode in ("verify-full", "verify-ca"):
        connect_args["ssl"] = ssl_context(url_root, verify_hostname=mode == "verify-full")
    elif mode and mode not in ("disable", "allow", "prefer"):
        connect_args["ssl"] = "require" if mode == "require" else mode
    q["prepared_statement_cache_size"] = "0"
    return urlunsplit((scheme, parts.netloc, parts.path, urlencode(q), parts.fragment)), connect_args


def libpq_ssl_params(settings: Settings | None = None) -> dict[str, str]:
    """libpq 도구(psycopg2·psql·pg_dump) 연결에 붙일 TLS 매개변수(D-5). HGH_DB_SSLROOTCERT 가 있으면
    {'sslmode': 'verify-full', 'sslrootcert': <경로>}, 없으면 {}(현행: URL·PGSSLMODE 그대로). DSN 키워드로 쓰거나(psycopg2.connect(url, **p))
    PGSSLMODE·PGSSLROOTCERT 환경 변수로 옮긴다(libpq_ssl_env)."""
    s = settings or get_settings()
    return {"sslmode": "verify-full", "sslrootcert": s.db_sslrootcert} if s.db_sslrootcert else {}


def libpq_ssl_env(settings: Settings | None = None) -> dict[str, str]:
    """libpq_ssl_params 를 PG* 환경 변수로(psql·pg_dump 하위 프로세스용)."""
    p = libpq_ssl_params(settings)
    return {"PGSSLMODE": p["sslmode"], "PGSSLROOTCERT": p["sslrootcert"]} if p else {}


class Database:
    """풀별 AsyncEngine 묶음. init_db 로 프로세스당 1개를 만들고 get_db 로 얻는다."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._engines: dict[str, AsyncEngine] = {}

    def engine(self, pool: PoolName) -> AsyncEngine:
        if pool not in POOL_SPECS:
            raise ValueError(f"알 수 없는 풀: {pool}")
        eng = self._engines.get(pool)
        if eng is None:
            secret = self.settings.url_for(pool)
            if secret is None:
                raise RuntimeError(f"{pool} 풀 접속 URL 미설정(HGH_DB_URL 또는 HGH_DB_URL_{pool.upper()})")
            url, connect_args = asyncpg_url(secret.get_secret_value(), sslrootcert=self.settings.db_sslrootcert)
            eng = create_async_engine(url, connect_args=connect_args, pool_size=self.settings.db_pool_size,
                                      max_overflow=self.settings.db_max_overflow, pool_pre_ping=True, pool_recycle=1800)
            if self.settings.sql_guard:            # local·test: 모든 실행 문장 경계 가드(기능 통합 테스트가 위반에 걸린다)
                from app.core.sqlguard import install_engine_guard
                install_engine_guard(eng)
            self._engines[pool] = eng
        return eng

    def assumes_role(self, pool: PoolName) -> bool:
        """풀 전용 URL 이 있으면 그 로그인 롤이 곧 풀 롤이라 전환하지 않는다."""
        return self.settings.db_assume_role and pool not in self.settings.db_urls

    @asynccontextmanager
    async def transaction(self, pool: PoolName, *, gucs: Mapping[str, str] | None = None) -> AsyncIterator[AsyncConnection]:
        """풀 커넥션 1개 + 트랜잭션 1개. 정상 종료 시 COMMIT(읽기 전용이면 영향 없음), 예외 시 ROLLBACK."""
        spec = POOL_SPECS[pool]
        async with self.engine(pool).connect() as raw:
            conn = await raw.execution_options(isolation_level=spec.isolation, postgresql_readonly=spec.read_only)
            async with conn.begin():
                settings: list[tuple[str, str]] = []
                if self.assumes_role(pool):
                    settings.append(("role", spec.role))
                settings.append(("statement_timeout", spec.statement_timeout))
                settings.extend(spec.extra)
                for k, v in (gucs or {}).items():
                    settings.append((k, v))
                await set_local(conn, settings)
                yield conn

    def read(self, pool: PoolName = "api_ro") -> Any:
        if POOL_SPECS[pool].read_only is False:
            raise ValueError(f"{pool} 는 읽기 풀이 아니다")
        return self.transaction(pool)

    def write(self, actor_id: UUID | str, *, actor_type: str = "user", batch_id: UUID | str | None = None,
              pool: PoolName = "api_rw") -> Any:
        """api_rw(또는 qa_gate) 쓰기 트랜잭션. 행위자 GUC 를 트랜잭션 로컬로 심는다."""
        if actor_type not in ("user", "system"):
            raise ValueError("actor_type 은 user|system")
        gucs = {"app.actor_id": str(UUID(str(actor_id))), "app.actor_type": actor_type}
        if batch_id is not None:
            gucs["app.batch_id"] = str(UUID(str(batch_id)))
        return self.transaction(pool, gucs=gucs)

    async def dispose(self) -> None:
        for eng in self._engines.values():
            await eng.dispose()
        self._engines.clear()


async def set_local(conn: AsyncConnection, settings: list[tuple[str, str]]) -> None:
    """set_config(k, v, true) 를 한 문장으로. 키는 코드 상수만(사용자 입력 금지), 값은 바인드."""
    if not settings:
        return
    parts = []
    params: dict[str, str] = {}
    for i, (k, v) in enumerate(settings):
        parts.append(f"set_config(:k{i}, :v{i}, true)")
        params[f"k{i}"] = k
        params[f"v{i}"] = v
    # 풀 롤·타임아웃 전환(role·statement_timeout 등)은 core 전용이라 기능 SQL 가드(app.* GUC 만 허용)에서 이 한 문장만 뺀다.
    # 키는 코드 상수만 오므로(set_local 호출부 = Database.transaction) 가드 우회가 기능 입력으로 열리지 않는다.
    await conn.execute(text("SELECT " + ", ".join(parts)), params, execution_options={"hgh_sql_guard": False})


# 계획기 힌트로 바꿀 수 있는 GUC(값이 아니라 계획만 바꾸는 비용 상수). 여기 없는 키는 planner_hint 가 거부한다.
PLANNER_HINT_KEYS = frozenset({"parallel_tuple_cost"})
# 대량 조인 결과를 Gather 로 모으는 문장 전용(인용 출처 톤·답변 열 문장, be/web-card-perf 2026-10-01): 기본 parallel_tuple_cost 0.1 은
# Gather 행 하나를 순차 처리 행의 10배로 잡아, 결과 100만 행대 조인을 병렬로 하지 않았다(stg hmg_r2 글로벌 3개월 톤 문장 Gather 1,266,509행
# 실측 약 0.25s 인데 추정 비용이 병렬 이득보다 컸다). 0.001 이면 같은 문장이 병렬 해시 조인을 골라 1.33s → 0.62s(값 같음).
PARALLEL_GATHER_HINT: tuple[tuple[str, str], ...] = (("parallel_tuple_cost", "0.001"),)


@asynccontextmanager
async def planner_hint(conn: AsyncConnection, settings: tuple[tuple[str, str], ...]) -> AsyncIterator[AsyncConnection]:
    """블록 안 문장에만 계획기 비용 상수를 바꾼다. 세이브포인트 안에서 set_config(…, true)를 걸고 블록이 끝나면 세이브포인트를 되감아
    값을 되돌린다(읽기 문장만 두는 블록 전용: 되감기는 GUC 만 되돌리고 REPEATABLE READ 스냅샷은 그대로다). 키는 PLANNER_HINT_KEYS 만."""
    bad = [k for k, _ in settings if k not in PLANNER_HINT_KEYS]
    if bad:
        raise ValueError(f"planner_hint 에 허용되지 않은 GUC: {bad}")
    sp = await conn.begin_nested()
    try:
        await set_local(conn, list(settings))
        yield conn
    finally:
        await sp.rollback()


_db: Database | None = None


def init_db(settings: Settings | None = None) -> Database:
    global _db
    _db = Database(settings or get_settings())
    return _db


def get_db() -> Database:
    if _db is None:
        return init_db()
    return _db


async def close_db() -> None:
    global _db
    if _db is not None:
        await _db.dispose()
        _db = None


# ── FastAPI 의존성: 요청당 한 커넥션(같은 요청 안 재사용은 FastAPI 의존성 캐시), 응답 전 종료(scope="function") ──
# D-2: 요청 커넥션은 Bearer 인증 요청 전용이다. 커넥션을 열기 전에 토큰부터 검증한다(core.auth.verified_subject, 요청당 1회 캐시).
# 무인증·토큰 오류 요청은 풀 커넥션·트랜잭션 없이 401 로 끝난다. 핸들러 매개변수 순서(RoConn 이 CurrentUser 보다 앞)와 무관하다.
async def _bearer_before_conn(request: Request) -> None:
    from app.core.auth import verified_subject  # 순환 import 회피(core.auth 가 이 모듈을 import 한다)

    await verified_subject(request)


async def get_ro_conn(request: Request) -> AsyncIterator[AsyncConnection]:
    await _bearer_before_conn(request)
    async with get_db().read("api_ro") as conn:
        yield conn


async def get_admin_long_conn(request: Request) -> AsyncIterator[AsyncConnection]:
    await _bearer_before_conn(request)
    async with get_db().read("admin_long") as conn:
        yield conn


RoConn = Annotated[AsyncConnection, Depends(get_ro_conn, scope="function")]
AdminLongConn = Annotated[AsyncConnection, Depends(get_admin_long_conn, scope="function")]

RoOpener = Callable[[], AbstractAsyncContextManager[AsyncConnection]]


def get_ro_opener() -> RoOpener:
    """짧은 api_ro 트랜잭션을 여는 함수(호출할 때마다 새 트랜잭션, 블록이 끝나면 커넥션 반납). 외부 호출을 끼운 핸들러의 읽기 단계용.
    의존성으로 받게 한 것은 테스트(tests.support.staged)가 준비 트랜잭션으로 덮어쓰게 하려는 것이다."""
    return lambda: get_db().read("api_ro")


RoSession = Annotated[RoOpener, Depends(get_ro_opener)]


# ── 조회 헬퍼 ──
async def fetch_all(conn: AsyncConnection, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    res = await conn.execute(text(sql), dict(params or {}))
    return [dict(r) for r in res.mappings().all()]


async def fetch_one(conn: AsyncConnection, sql: str, params: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    res = await conn.execute(text(sql), dict(params or {}))
    r = res.mappings().first()
    return dict(r) if r is not None else None


async def fetch_val(conn: AsyncConnection, sql: str, params: Mapping[str, Any] | None = None) -> Any:
    res = await conn.execute(text(sql), dict(params or {}))
    return res.scalar()


__all__ = [
    "POOLS",
    "POOL_SPECS",
    "AdminLongConn",
    "Database",
    "PoolSpec",
    "RoConn",
    "RoOpener",
    "RoSession",
    "asyncpg_url",
    "close_db",
    "fetch_all",
    "fetch_one",
    "fetch_val",
    "get_admin_long_conn",
    "get_db",
    "get_ro_conn",
    "get_ro_opener",
    "init_db",
    "libpq_ssl_env",
    "libpq_ssl_params",
    "set_local",
    "ssl_context",
]


# ════════════════════════════════════════════════════════════════════════════
# 적재 워커(loader) 직접 연결: API 풀과 따로(PgBouncer 미경유, SQLAlchemy 엔진 가드 밖. 워커 SQL 은 ing·rd 쓰기라 API 경계 대상 아님)
# ════════════════════════════════════════════════════════════════════════════
async def loader_connect(settings: Settings | None = None, *, dsn: str | None = None, role: str | None = None) -> Any:
    """asyncpg 연결 하나(statement 캐시 끔, 세션 TimeZone UTC, 선택 롤). TimeZone 은 시작 파라미터(server_settings: loader 는 PgBouncer 를
    거치지 않는 직접 연결), 롤은 SET ROLE(RESET ROLE 이 로그인 롤로 돌아가게: 시작 파라미터 role 이면 RESET 이 그 롤에 머문다).
    트랜잭션 로컬 statement_timeout·lock_timeout 은 호출자(ingest.common.db.LoaderDB.tx)가 건다. dsn·role 을 주면 설정 대신 쓴다(테스트)."""
    import asyncpg

    s = settings or get_settings()
    url = dsn or (s.loader_url.get_secret_value() if s.loader_url is not None else None)
    if url is None:
        raise RuntimeError("HGH_INGEST_DB_URL(또는 HGH_DB_URL) 미설정")
    tls: dict[str, Any] = {"ssl": ssl_context(s.db_sslrootcert)} if s.db_sslrootcert else {}   # D-5: verify-full(DSN sslmode 보다 우선)
    conn = await asyncpg.connect(url, statement_cache_size=0, server_settings={"TimeZone": "UTC"}, **tls)
    r = role if role is not None else s.ingest_db_role
    if r:
        await conn.execute(f'SET ROLE "{r.replace(chr(34), "")}"')     # 롤 이름은 설정값(코드·env)만, 식별자 인용
    return conn
