"""back 전체 테스트 공용 픽스처(core·기능 공통). 상수·도우미는 tests/support.py.

픽스처
  settings   세션 Settings(test, HGH_TEST_DB_URL, SQL 경계 가드 켬, QA 게이트 켬)
  _wire      (자동) 설정·JWT 검증기(테스트 서명 키) 전역 교체
  rsa_key    테스트 서명 키, token(uid, **kw) 발급 함수
  _db_latest (자동, 세션) 시험 복제본을 최신 DB 패치(v2.11 → v2.12 → v2.13 + cit_off 채우기)까지 올린다(tests/dbforward.py, 템플릿 이름이면 거부)
             + 시험 프로필(HGH_TEST_LEGACY_PROFILE)의 투영 스위치가 켜져 있으면 rd 를 그 프로필로 재투영(복제본 1회, DB 주석에 표시)
  _legacy_profile_marker (자동) @pytest.mark.legacy_profile("spec") 시험 동안만 활성 프로필 교체
  seeded     테스트 계정 6종·멤버십 멱등 UPSERT, 이번 달 접근 감사 파티션
  database   core.db.Database(init_db), ro = api_ro 트랜잭션 커넥션, refs = 참조 차원
  client_as  client_as(uid) → 인증된 httpx.AsyncClient(앱 = app.main.app) 비동기 컨텍스트 관리자. uid=None 이면 무인증
"""
from __future__ import annotations

import contextlib
import pathlib
import uuid
from typing import Any

import asyncpg
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import SecretStr

from app.core import auth as auth_mod
from app.core import db as db_mod
from app.core.config import Settings, set_settings
from tests.support import ACCOUNTS_SQL, DB_URL, TEST_KID, TEST_LEGACY_PROFILE, make_token, resolve_test_profile

# ── 대분류 경계 DB 되돌림(tests/area_reset.py): 한 번의 pytest 가 대분류 여럿을 같은 복제본에서 돌면 대분류마다 세션 시작 상태로 ──
_AREA: Any = None


def pytest_collection_finish(session):
    """최종 수집(선택·제외 반영)이 대분류 둘 이상이면 되돌림 장치를 켠다(run-areas·단일 대분류 실행은 그대로)."""
    global _AREA
    from tests import area_reset

    if not DB_URL or not area_reset.enabled() or not session.items:
        return
    root = pathlib.Path(session.config.rootpath)
    if len({area_reset.area_of(i.path, root) for i in session.items}) > 1:
        _AREA = area_reset.AreaReset(DB_URL, TEST_LEGACY_PROFILE)
        _AREA.root = root


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    """픽스처 준비 전(tryfirst): 첫 시험이면 복제본 상태를 떠 두고, 대분류가 바뀌었으면 그 상태로 되돌린다."""
    if _AREA is None:
        return
    from tests import area_reset

    a = area_reset.area_of(item.path, _AREA.root)
    if not _AREA.ready:
        _AREA.snapshot()
    elif a != _AREA.current:
        _AREA.reset()
    _AREA.current = a


def pytest_sessionfinish(session, exitstatus):
    if _AREA is not None:
        _AREA.drop_pristine()


@pytest.fixture(scope="session")
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(env="test", db_url=SecretStr(DB_URL) if DB_URL else None, jwt_audience="authenticated",
                    qa_enabled=True, qa_secret=SecretStr("test-qa-secret"), qa_password=SecretStr("pw-test"),
                    sql_guard=True,                                         # 테스트 중 모든 실행 문장에 경계 가드
                    legacy_profile=TEST_LEGACY_PROFILE)                     # 시험 프로필(HGH_TEST_LEGACY_PROFILE, 기본 off)


@pytest.fixture(autouse=True)
def _legacy_profile_marker(request, settings):
    """@pytest.mark.legacy_profile("spec"): 그 시험 동안만 활성 프로필을 바꾼다(spec = off | implemented | 스위치 쉼표 목록).
    rd 투영은 바꾸지 않는다(세션 프로필로 투영된 복제본 그대로): 투영 스위치를 고정하는 시험은 bulk 시드도 같은 프로필로 직접 돈다(ingest.testkit.bulk_seed)."""
    m = request.node.get_closest_marker("legacy_profile")
    if m is None:
        yield
        return
    set_settings(settings.model_copy(update={"legacy_profile": resolve_test_profile(m.args[0])}))
    try:
        yield
    finally:
        set_settings(settings)


@pytest.fixture(scope="session", autouse=True)
def _wire(settings, rsa_key):
    """전역 싱글턴(설정·검증기)을 테스트 설정으로 교체."""
    set_settings(settings)
    v = auth_mod.JwtVerifier(settings)
    v.install_test_keys({TEST_KID: rsa_key.public_key()})
    auth_mod.set_verifier(v)
    yield
    auth_mod.set_verifier(None)
    set_settings(None)


@pytest_asyncio.fixture(scope="session", loop_scope="session", autouse=True)
async def _db_latest():
    """DB 시험 전(세션 1회): 복제본이 템플릿(hmg_tpl v2.10)보다 뒤의 패치를 갖게 한다. DB-v2.13 부터 적재기·core.measure·seed-40 이
    rd.answer.cit_off 를 읽고 쓰므로 모든 DB 시험의 전제다. 새 템플릿(DB-v2.13.sql 합본)이면 할 일이 없다."""
    if not DB_URL:
        return
    from app.core.profile import parse_profile
    from tests.dbforward import ensure_latest, project_test_profile
    c = await asyncpg.connect(DB_URL)
    try:
        await ensure_latest(c)
        await project_test_profile(c, parse_profile(TEST_LEGACY_PROFILE))   # 투영 스위치가 켜진 시험 프로필이면 복제본 rd 재투영(1회)
    finally:
        await c.close()


@pytest.fixture(scope="session")
def token(rsa_key):
    return lambda sub, **kw: make_token(rsa_key, sub, **kw)


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def seeded():
    if not DB_URL:
        pytest.skip("HGH_TEST_DB_URL 미설정")
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute(ACCOUNTS_SQL)
        await c.execute("SELECT rd.ensure_month_leaf('app.access_audit_log'::regclass, current_date)")   # 적재기 월간 잡 대신
    finally:
        await c.close()
    return True


@pytest_asyncio.fixture(loop_scope="session")
async def database(settings, seeded):
    d = db_mod.init_db(settings)
    yield d
    await db_mod.close_db()


@pytest_asyncio.fixture(loop_scope="session")
async def ro(database):
    async with database.read("api_ro") as conn:
        yield conn


@pytest_asyncio.fixture(loop_scope="session")
async def refs(ro):
    from app.core.codes import load_refs
    return await load_refs(ro)


@pytest.fixture
def client_as(database, token):
    """client_as(uid) → `async with client_as(HQ_HYUNDAI) as c: await c.get("/v1/…")`. 앱은 app.main.app(기능 라우터 전부)."""
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    @contextlib.asynccontextmanager
    async def _client(uid: uuid.UUID | None, *, app_=None, **token_kw):
        headers = {"Authorization": f"Bearer {token(uid, **token_kw)}"} if uid is not None else {}
        async with AsyncClient(transport=ASGITransport(app=app_ or app), base_url="http://test", headers=headers) as c:
            yield c
    return _client
