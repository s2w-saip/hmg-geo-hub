"""테스트 공용 상수·도우미(core·기능 테스트 공통). 픽스처는 back/conftest.py 가 등록한다.

기능 테스트 사용 예(app/features/<…>/tests/test_x.py):

    from tests.support import ADMIN, HQ_HYUNDAI, TODAY, needs_db

    @needs_db
    async def test_summary(client_as):
        async with client_as(HQ_HYUNDAI) as c:
            r = await c.get("/v1/kpi/summary", params={"surface": "global"})
        assert r.status_code == 200

DB 는 로컬 개발 DB(합성 픽스처만)다. 가이드: back/tests/README.md

픽스처에 없는 상태(숨김 회차·추가 사실 행·발행값 등)는 staged(...) 로 만든다(롤백 전용, 커밋하지 않는다):

    from tests.support import Rows, SqlFile, Update, staged

    async with staged(Update("rd.cycle", {"cyc_key": 11}, {"hidden_scope": 3, "hidden_reason": 1}),
                      SqlFile(HERE / "extra.pgsql")) as conn:
        async with client_as(HQ_HYUNDAI) as c:
            r = await c.get("/v1/trend", params={"surface": "global"})     # 요청은 이 트랜잭션에서 api_ro 롤로 돈다

- 준비 단계는 소유자(HGH_TEST_DB_URL 사용자)로 SQL 경계 가드 없이 실행한다(테스트 준비이지 API 문장이 아니다). 준비 SQL 은 기능 폴더
  tests/*.pgsql 데이터 파일(정적 가드 검사 밖) 또는 Rows·Update 구조체로 둔다. 기능 .py 문자열에 rd 쓰기 SQL 을 쓰지 않는다(G6 정적 검사).
- 준비 뒤 같은 트랜잭션에서 role 을 api_ro 로 내리고(role=None 이면 소유자 유지) 엔진에 실행 가드를 건 다음 app.core.db.get_ro_conn
  (RoConn)·get_ro_opener(RoSession·CurrentUserDetached)를 이 커넥션으로 덮어쓴다. 블록이 끝나면 의존성 원복 + ROLLBACK 이라 복제본은 변하지 않는다(실패해도 다른 테스트가 보는 픽스처 그대로).
"""
from __future__ import annotations

import contextlib
import os
import pathlib
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import jwt
import pytest

DB_URL = os.environ.get("HGH_TEST_DB_URL")
needs_db = pytest.mark.skipif(not DB_URL, reason="HGH_TEST_DB_URL 미설정(로컬 개발 DB 필요: back/tests/README.md)")


def resolve_test_profile(raw: str | None) -> str:
    """시험 프로필 표기 → 정규 표기(core.profile.parse_profile, 구현된 스위치만). 'implemented' = 구현된 스위치 전부(stg 배포 프로필과 같은 값,
    'current' 는 미구현 스위치까지 켜서 설정 검증이 거부한다)."""
    from app.core.profile import IMPLEMENTED, SWITCHES, parse_profile

    s = (raw or "off").strip().lower()
    if s == "implemented":
        s = ",".join(n for n in SWITCHES if n in IMPLEMENTED)
    return parse_profile(s).spec


# 세션 시험 프로필(HGH_TEST_LEGACY_PROFILE: off 기본 | implemented | 스위치 이름 쉼표 목록). 설정 픽스처(settings)·적재기·bulk 시드(ingest.testkit)가
# 같은 값을 쓰고, 투영 스위치가 켜져 있으면 세션 시작에 시험 복제본 rd 를 그 프로필로 다시 투영한다(tests.dbforward.project_test_profile).
# 시험 하나만 다른 프로필로 돌리려면 @pytest.mark.legacy_profile("spec")(같은 표기). 운영 env HGH_LEGACY_PROFILE 은 읽지 않는다(우연한 전파 방지).
TEST_LEGACY_PROFILE = resolve_test_profile(os.environ.get("HGH_TEST_LEGACY_PROFILE"))


def _name_key_on() -> bool:
    from app.core.profile import parse_profile
    return parse_profile(TEST_LEGACY_PROFILE).display_name_latin


# 세션 복제본이 현행 프로필 NAME(display_name_latin)으로 투영됐나. 켜지면 rd.dim_brand_name.bare = 정본 표시명 그대로라(대소문자 표기별 행,
# 운영 생성기와 같다) 픽스처의 'Toyota'·'TOYOTA' 가 두 표시 브랜드가 되고, bare 는 소문자가 아니다(be/int3-name2). 표시 브랜드 이름·행 수를
# 단언하는 시험은 이 값으로 기대값을 고른다.
TEST_NAME_KEY = _name_key_on()


def keep_name_projection(spec: str) -> str:
    """시험이 고정하는 프로필 표기에 세션 복제본의 NAME 투영을 더한다. NAME 은 표시 브랜드 키 자체를 바꾸는 투영 스위치라, 복제본(세션 프로필로
    투영)과 다른 값으로 적재·bulk 를 돌리면 차원 키가 섞인다. 다른 스위치를 고정하려는 시험은 이 값을 쓴다(끔 세션이면 spec 그대로)."""
    if not TEST_NAME_KEY:
        return spec
    return "display_name_latin" if spec in ("", "off") else f"{spec},display_name_latin"


TODAY = date(2026, 9, 27)   # 픽스처 회차 노출 판정 기준일(resolve_window(today=TODAY) 로 고정)

# 테스트 계정 7종(역할·스코프는 back/tests/README.md 표)
ADMIN = uuid.UUID("11111111-0000-4000-8000-000000000001")
HQ_HYUNDAI = uuid.UUID("11111111-0000-4000-8000-000000000002")
KIA_US = uuid.UUID("11111111-0000-4000-8000-000000000003")
VENDOR = uuid.UUID("11111111-0000-4000-8000-000000000004")
KIA_EU = uuid.UUID("11111111-0000-4000-8000-000000000005")
SUSPENDED = uuid.UUID("11111111-0000-4000-8000-000000000006")
WEBSITE_KIA = uuid.UUID("11111111-0000-4000-8000-000000000007")     # role website(웹사이트 경로만, route-policy WEBSITE_VIEWERS)
SYSTEM = uuid.UUID("5eed0000-0000-4000-8000-000000000001")          # 시드 시스템 사용자(행위자 GUC 용)
CUST_PROJECT = uuid.UUID("c0000000-0000-4000-8000-000000000003")
ROOT_PROJECT = uuid.UUID("c0000000-0000-4000-8000-000000000001")
KIA_DE_SITE = uuid.UUID("d0000000-0000-4000-8000-000000000002")
TEST_KID = "test-kid"

ACCOUNTS_SQL = """
SELECT set_config('app.actor_id', '5eed0000-0000-4000-8000-000000000001', false);   -- 계정 쓰기 = 행위자 필수(DB-v2.3 P31 감사 트리거)
INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_regions, scope_countries, menu_groups, status)
VALUES
 ('11111111-0000-4000-8000-000000000001', 't-admin@example.test', 'admin', 'global', true, '{}', '{}', '{}', NULL, 'active'),
 ('11111111-0000-4000-8000-000000000002', 't-hq-h@example.test', 'hq', 'assigned', false, '{Hyundai}', '{}', '{}', '{standard,project}', 'active'),
 ('11111111-0000-4000-8000-000000000003', 't-kia-us@example.test', 'country', 'none', false, '{Kia}', '{}', '{US}', NULL, 'active'),
 ('11111111-0000-4000-8000-000000000004', 't-vendor@example.test', 'vendor', 'none', false, '{}', '{}', '{}', '{project}', 'active'),
 ('11111111-0000-4000-8000-000000000005', 't-kia-eu@example.test', 'region', 'none', false, '{Kia}', '{kia-western-europe}', '{}', NULL, 'active'),
 ('11111111-0000-4000-8000-000000000006', 't-susp@example.test', 'hq', 'none', false, '{Hyundai}', '{}', '{}', NULL, 'suspended'),
 ('11111111-0000-4000-8000-000000000007', 't-core-web-kia@example.test', 'website', 'none', false, '{Kia}', '{}', '{}', '{website}', 'active')
ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, operator = EXCLUDED.operator, scope_all = EXCLUDED.scope_all,
  scope_brands = EXCLUDED.scope_brands, scope_regions = EXCLUDED.scope_regions, scope_countries = EXCLUDED.scope_countries,
  menu_groups = EXCLUDED.menu_groups, status = EXCLUDED.status;
DELETE FROM app.project_member WHERE user_id IN ('11111111-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000004');
INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at)
VALUES ('c0000000-0000-4000-8000-000000000003', '11111111-0000-4000-8000-000000000004', 'viewer', 'active',
        '11111111-0000-4000-8000-000000000001', now());
SELECT set_config('app.actor_id', '', false);
"""


def make_token(key, sub: uuid.UUID, *, aud: str = "authenticated", exp_in: int = 600, kid: str = TEST_KID, **claims) -> str:
    """테스트 서명 키로 Supabase 형식 JWT 발급(RS256)."""
    now = int(time.time())
    body = {"sub": str(sub), "aud": aud, "exp": now + exp_in, "iat": now, "role": "authenticated", **claims}
    return jwt.encode(body, key, algorithm="RS256", headers={"kid": kid})


async def principal(conn, uid: uuid.UUID):
    """계정 → Principal(app.core.auth.load_principal)."""
    from app.core import auth as auth_mod
    return await auth_mod.load_principal(conn, uid)


# ════════════════════════════════════════════════════════════════════════════
# 롤백 전용 준비(staged): 소유자로 행을 더하고, 요청은 같은 트랜잭션에서 api_ro 로 돈다
# ════════════════════════════════════════════════════════════════════════════
_IDENT = re.compile(r"^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$")


@dataclass(frozen=True)
class Rows:
    """table(스키마.표)에 행 추가. 열 이름은 dict 키(생성 열은 넣지 않는다)."""
    table: str
    rows: Sequence[Mapping[str, Any]]


@dataclass(frozen=True)
class Update:
    """table 의 where(열 = 값 AND …) 행을 values 로 갱신."""
    table: str
    where: Mapping[str, Any]
    values: Mapping[str, Any]


@dataclass(frozen=True)
class SqlFile:
    """준비 SQL 파일(여러 문장, 바인드 없음)을 소유자로 실행. 기능 폴더 tests/*.pgsql 에 둔다."""
    path: pathlib.Path | str


@dataclass(frozen=True)
class Sql:
    """준비 문장 하나($1… 위치 인자). load_named_sql 로 읽은 이름 붙은 문장과 함께 쓴다."""
    sql: str
    args: tuple[Any, ...] = field(default=())


Step = Rows | Update | SqlFile | Sql | Callable[[Any], Awaitable[None]]


def load_named_sql(path: pathlib.Path | str) -> dict[str, str]:
    """'-- name: x' 로 나뉜 준비 SQL 파일 → {이름: 문장}(주석 줄 제외)."""
    out: dict[str, list[str]] = {}
    cur: list[str] | None = None
    for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
        m = re.match(r"^--\s*name:\s*(\S+)", line)
        if m:
            cur = out.setdefault(m.group(1), [])
        elif cur is not None and not line.lstrip().startswith("--"):
            cur.append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def _table(name: str, cols: Sequence[str]) -> Any:
    from sqlalchemy import column, table

    if not _IDENT.match(name):
        raise ValueError(f"표 이름 형식: schema.table ({name!r})")
    schema, t = name.split(".")
    return table(t, *[column(c) for c in cols], schema=schema)


async def _apply_step(conn: Any, step: Step) -> None:
    from sqlalchemy import and_, insert, update

    if isinstance(step, Rows):
        if step.rows:
            cols = sorted({k for r in step.rows for k in r})
            await conn.execute(insert(_table(step.table, cols)).execution_options(hgh_sql_guard=False), [dict(r) for r in step.rows])
    elif isinstance(step, Update):
        t = _table(step.table, sorted({*step.where, *step.values}))
        await conn.execute(update(t).where(and_(*[t.c[k] == v for k, v in step.where.items()])).values(**dict(step.values))
                           .execution_options(hgh_sql_guard=False))
    elif isinstance(step, SqlFile):
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(pathlib.Path(step.path).read_text(encoding="utf-8"))
    elif isinstance(step, Sql):
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(step.sql, *step.args)
    else:
        await step(conn)


async def _set_role(conn: Any, role: str | None) -> None:
    raw = await conn.get_raw_connection()
    await raw.driver_connection.execute(f"SELECT set_config('role', '{role or 'none'}', true)")     # 'none' = 세션 사용자(소유자)


async def stage(conn: Any, *steps: Step) -> None:
    """staged 블록 안에서 준비를 더한다(키를 먼저 읽고 그 값으로 행을 넣을 때). 소유자로 되돌려 가드 없이 실행한 뒤 요청 롤로 복귀."""
    if "hgh_staged_role" not in conn.info:
        raise RuntimeError("stage() 는 staged(...) 가 준 커넥션에만")
    await _set_role(conn, None)
    try:
        for st in steps:
            await _apply_step(conn, st)
    finally:
        await _set_role(conn, conn.info["hgh_staged_role"])


@contextlib.asynccontextmanager
async def savepoint(conn: Any) -> AsyncIterator[Any]:
    """staged 블록 안의 부분 준비를 되돌리는 세이브포인트(모듈 단위 준비 위에서 시험 하나가 더한 행만 지운다).
    SAVEPOINT·ROLLBACK TO 는 드라이버 직접(API 문장 가드 밖)이라 요청 문장의 가드와 섞이지 않는다."""
    if "hgh_staged_role" not in conn.info:
        raise RuntimeError("savepoint() 는 staged(...) 가 준 커넥션에만")
    n = conn.info["hgh_savepoints"] = conn.info.get("hgh_savepoints", 0) + 1
    raw = await conn.get_raw_connection()
    await raw.driver_connection.execute(f"SAVEPOINT hgh_sp_{n}")
    try:
        yield conn
    finally:
        await raw.driver_connection.execute(f"ROLLBACK TO SAVEPOINT hgh_sp_{n}")
        await raw.driver_connection.execute(f"SELECT set_config('role', '{conn.info['hgh_staged_role'] or 'none'}', true)")


async def raw_fetch(conn: Any, sql: str, *args: Any) -> list[dict[str, Any]]:
    """준비 트랜잭션(staged 가 준 conn) 안의 독립 기대값 조회: $n 위치 인자, 드라이버 직접(기능 코드와 다른 경로, API 문장 가드 밖)."""
    raw = await conn.get_raw_connection()
    return [dict(r) for r in await raw.driver_connection.fetch(sql, *args)]


@contextlib.asynccontextmanager
async def staged(*steps: Step, role: str | None = "api_ro", app_: Any = None, actor: uuid.UUID | None = None) -> AsyncIterator[Any]:
    """롤백 전용 준비. 반환 = 요청과 같은 트랜잭션의 AsyncConnection(기대값 SQL 도 이것으로 센다: 실행 가드를 거친다).
    role: 준비 뒤 요청 롤(api_ro 기본, None = 소유자 유지). app_: 의존성을 덮을 앱(기본 app.main.app).
    actor: 준비 단계의 행위자(app.actor_id, 트랜잭션 로컬). 감사 트리거가 있는 app 표(app.prompt·app.user_account 등)를 고칠 때."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.db import asyncpg_url, get_ro_conn, get_ro_opener
    from app.core.sqlguard import install_engine_guard

    if not DB_URL:
        pytest.skip("HGH_TEST_DB_URL 미설정")
    if role is not None and role not in ("api_ro", "api_rw", "admin_long", "qa_gate"):
        raise ValueError(f"알 수 없는 롤: {role}")
    if app_ is None:
        from app.main import app as app_
    url, connect_args = asyncpg_url(DB_URL)
    eng = create_async_engine(url, connect_args=connect_args, poolclass=NullPool)
    try:
        async with eng.connect() as conn:
            tx = await conn.begin()
            try:
                # asyncpg 방언은 첫 실행 때 BEGIN 을 보낸다: 원시 드라이버 실행(SqlFile·Sql) 전에 트랜잭션을 연다(자동 커밋 방지)
                await conn.execute(text("SELECT 1"))
                if actor is not None:
                    await conn.execute(text("SELECT set_config('app.actor_id', :a, true)").execution_options(hgh_sql_guard=False),
                                       {"a": str(actor)})
                for st in steps:
                    await _apply_step(conn, st)
                conn.info["hgh_staged_role"] = role
                await _set_role(conn, role)
                install_engine_guard(eng)                # 준비 뒤 실행 문장(요청·기대값)은 전부 SQL 경계 가드

                async def ro() -> AsyncIterator[Any]:
                    yield conn

                @contextlib.asynccontextmanager
                async def _same() -> AsyncIterator[Any]:
                    yield conn

                app_.dependency_overrides[get_ro_conn] = ro
                app_.dependency_overrides[get_ro_opener] = lambda: _same     # RoSession·CurrentUserDetached 도 같은 준비 트랜잭션
                yield conn
            finally:
                app_.dependency_overrides.pop(get_ro_conn, None)
                app_.dependency_overrides.pop(get_ro_opener, None)
                await tx.rollback()
    finally:
        await eng.dispose()
