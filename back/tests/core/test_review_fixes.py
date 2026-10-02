"""독립 검증 지적(B1·B2·m1~m11) 회귀 테스트. DB 없는 것과 로컬 개발 DB(hmg_core) 것을 함께 둔다."""
from __future__ import annotations

import base64
import json
import time
import uuid

import asyncpg
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from pydantic import SecretStr

from app.core import errors
from app.core.auth import (
    DataScope,
    JwtVerifier,
    Principal,
    key_algorithm,
    sign_qa_cookie,
    verify_qa_cookie,
)
from app.core.codes import parse_refs
from app.core.config import Settings, load_settings
from app.core.db import Database
from app.core.pagination import Cursor, decode_cursor, encode_cursor, filter_hash
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, needs_db


# ── B2: JWT 알고리즘은 키에서, 불일치는 전부 401 ─────────────────────────────────
def _tok(key, alg, kid, sub=None, **extra):
    now = int(time.time())
    claims = {"sub": str(sub or uuid.uuid4()), "aud": "authenticated", "exp": now + 600, **extra}
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


@pytest.fixture(scope="module")
def keys():
    return {"rsa": rsa.generate_private_key(public_exponent=65537, key_size=2048), "ec": ec.generate_private_key(ec.SECP256R1())}


def _verifier(keys, **kw) -> JwtVerifier:
    v = JwtVerifier(Settings(env="test", **kw))
    v.install_test_keys({"r": keys["rsa"].public_key(), "e": keys["ec"].public_key()})
    return v


async def test_jwt_alg_pinned_to_key(keys):
    v = _verifier(keys)
    assert (await v.verify(_tok(keys["rsa"], "RS256", "r")))["aud"] == "authenticated"
    assert (await v.verify(_tok(keys["ec"], "ES256", "e")))["aud"] == "authenticated"
    pem = keys["rsa"].public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    forged = jwt.api_jws.PyJWS().encode(json.dumps({"sub": "x", "aud": "authenticated", "exp": int(time.time()) + 60}).encode(),
                                        b"k" * 32, algorithm="HS256", headers={"kid": "r"})
    cases = [
        forged,                                                  # HS256 헤더(대칭 키) → RSA 키 alg 와 불일치
        _tok(keys["rsa"], "RS256", "e"),                         # RSA 서명인데 EC 키 kid → alg 불일치
        _tok(keys["ec"], "ES256", "r"),                          # EC 서명인데 RSA 키 kid
        _tok(keys["rsa"], "RS512", "r"),                         # 같은 키 다른 해시 → 키 alg(RS256) 와 불일치
        "a.b",                                                   # 형식 오류
        _tok(keys["rsa"], "RS256", "nope"),                      # 모르는 kid
    ]
    assert pem  # 공개키 PEM 을 HMAC 비밀로 쓰는 공격 경로(algorithm confusion)의 입력
    for t in cases:
        with pytest.raises(errors.ApiError) as e:
            await v.verify(t)
        assert e.value.status == 401


async def test_jwt_key_type_mismatch_is_401_not_500(keys):
    v = JwtVerifier(Settings(env="test"))
    v._static["bad"] = (b"not-a-key", "RS256")                   # 잘못 주입된 키(키 종류 불일치 → PyJWT TypeError·InvalidKeyError)
    with pytest.raises(errors.ApiError) as e:
        await v.verify(_tok(keys["rsa"], "RS256", "bad"))
    assert e.value.status == 401
    with pytest.raises(errors.ApiError):
        key_algorithm(object())
    assert key_algorithm(jwt.PyJWK.from_dict(json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(keys["rsa"].public_key())) | {"alg": "RS256"})) == "RS256"


async def test_jwks_fetch_failure_is_503(keys):
    """참고 경미: JWKS 엔드포인트 장애(OSError·연결 오류)는 500 이 아니라 503 auth_unavailable."""
    v = JwtVerifier(Settings(env="test", jwks_url="https://jwks.invalid/.well-known/jwks.json"))

    class Boom:
        def __init__(self, exc):
            self.exc = exc

        def get_signing_key(self, kid):
            raise self.exc

    for exc in (OSError("net down"), TimeoutError(), jwt.PyJWKClientConnectionError("x")):
        v._client = Boom(exc)
        with pytest.raises(errors.ApiError) as e:
            await v.verify(_tok(keys["rsa"], "RS256", "k"))
        assert e.value.status == 503 and e.value.code == "auth_unavailable"
    v._client = Boom(jwt.PyJWKClientError("no key"))
    with pytest.raises(errors.ApiError) as e:
        await v.verify(_tok(keys["rsa"], "RS256", "k"))
    assert e.value.status == 401


async def test_jwt_issuer_checked_when_configured(keys):
    v = _verifier(keys, jwt_issuer="https://x.supabase.co/auth/v1")
    with pytest.raises(errors.ApiError):
        await v.verify(_tok(keys["rsa"], "RS256", "r"))                                   # iss 없음
    with pytest.raises(errors.ApiError):
        await v.verify(_tok(keys["rsa"], "RS256", "r", iss="https://evil"))
    assert await v.verify(_tok(keys["rsa"], "RS256", "r", iss="https://x.supabase.co/auth/v1"))


# ── m1: stg·prod 는 issuer 필수 ────────────────────────────────────────────────
def test_config_requires_issuer_outside_dev():
    with pytest.raises(ValueError, match="ISSUER"):
        load_settings({"HGH_ENV": "prod", "HGH_JWKS_URL": "https://x/jwks"})
    assert load_settings({"HGH_ENV": "stg", "HGH_JWKS_URL": "https://x/jwks", "HGH_JWT_ISSUER": "https://x/auth/v1"}).jwt_issuer


# ── m2: QA 쿠키 비ASCII·변조 → 거부(500 아님) ───────────────────────────────────
def test_qa_cookie_non_ascii_rejected():
    s = Settings(env="test", qa_enabled=True, qa_secret=SecretStr("k"))
    from app.core.auth import new_qa_session
    ck = sign_qa_cookie(new_qa_session("검수자"), s)
    payload, _ = ck.split(".")
    for bad in (f"{payload}.서명", f"{payload}.\udcff", "한글.한글", f"{payload}.{'x' * 43}", "."):
        assert verify_qa_cookie(bad, s) is None
    assert verify_qa_cookie(ck, s).name == "검수자"


# ── m3: 변조 커서 전부 422 ──────────────────────────────────────────────────
def test_cursor_tampering_all_422():
    fh = filter_hash({"f": 1})
    good = encode_cursor(Cursor(sort="s", dir="asc", key=(1,), fh=fh))
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    bads = ["", "한글커서", "@@@", enc([1]), enc("s"), enc(None), enc({"v": 2}), enc({"v": 1, "sort": 1, "dir": "asc", "key": [1], "fh": fh}),
            enc({"v": 1, "sort": "s", "dir": "up", "key": [1], "fh": fh}), enc({"v": 1, "sort": "s", "dir": "asc", "key": [], "fh": fh}),
            enc({"v": 1, "sort": "s", "dir": "asc", "key": [[1]], "fh": fh}), enc({"v": 1, "sort": "s", "dir": "asc", "key": [{"$d": "x"}], "fh": fh}),
            enc({"v": 1, "sort": "s", "dir": "asc", "key": [1], "fh": fh, "g": "7"}), "x" * 5000]
    for b in bads:
        if not b:
            assert decode_cursor(b, sort="s", dir="asc", fh=fh, types=("int4",)) is None
            continue
        with pytest.raises(errors.ApiError) as e:
            decode_cursor(b, sort="s", dir="asc", fh=fh, types=("int4",))
        assert e.value.status == 422 and e.value.code == "cursor_invalid", b
    assert decode_cursor(good, sort="s", dir="asc", fh=fh, types=("int4",)).key == (1,)


def test_cursor_key_types_and_ranges_422():
    """재검증 N1: decimal.InvalidOperation·형 불일치·int4 범위 초과·실수 → 전부 422(asyncpg DataError 500 이 되지 않게)."""
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    base = {"v": 1, "sort": "zz", "dir": "desc", "fh": "x"}
    cases = [([{"$n": "abc"}], ("numeric",)), ([{"$n": "NaN"}], ("numeric",)), ([{"$n": "Infinity"}], ("numeric",)),
             (["x", 1], ("int4", "int4")), ([10 ** 30], ("int4",)), ([2 ** 31], ("int4",)), ([2 ** 63], ("int8",)),
             ([1.5], ("int4",)), ([True], ("int4",)), ([1], ("text",)), ([{"$d": "2026-09-14", "$t": "d"}], ("int4",)),
             ([{"$d": "2026-09-14T00:00:00", "$t": "dt"}], ("timestamptz",)), ([{"$u": "nope"}], ("uuid",)),
             ([1, 2], ("int4",)), ([], ("int4",)), (["a" * 600], ("text",)),
             # 3차 D1: NUL·짝 없는 서로게이트 텍스트, 지수 폭주 numeric, UTC 로 옮기면 범위 밖인 timestamptz
             (["a\u0000b"], ("text",)), (["\ud800"], ("text",)), ([{"$n": "1E+999999"}], ("numeric",)),
             ([{"$n": "1E-999999"}], ("numeric",)), ([{"$d": "0001-01-01T00:00:00+14:00", "$t": "dt"}], ("timestamptz",)),
             ([{"$d": "9999-12-31T23:59:59-14:00", "$t": "dt"}], ("timestamptz",))]
    for key, types in cases:
        with pytest.raises(errors.ApiError) as e:
            decode_cursor(enc({**base, "key": key}), sort="zz", dir="desc", fh="x", types=types)
        assert e.value.status == 422 and e.value.code == "cursor_invalid", (key, types)
    import datetime as dt
    import decimal
    ok = Cursor("zz", "desc", (dt.date(2026, 9, 14), 2 ** 31 - 1, decimal.Decimal("1.50"), uuid.UUID(int=1), "t", True,
                               dt.datetime(2026, 9, 14, tzinfo=dt.UTC)), "x")
    got = decode_cursor(encode_cursor(ok), sort="zz", dir="desc", fh="x",
                        types=("date", "int4", "numeric", "uuid", "text", "bool", "timestamptz"))
    assert got.key == ok.key


# ── B1·결정: 권역 미해석 거부, vendor 무제한, admin 강제 ──────────────────────────
REFS = parse_refs({
    "brands": [{"code": "Hyundai", "bit": 1, "umb": False, "parent": None, "ord": 1}, {"code": "Kia", "bit": 2, "umb": False, "parent": None, "ord": 2},
               {"code": "HMG", "bit": 8, "umb": True, "parent": None, "ord": 4}],
    "owned": [], "engines": [], "countries": [], "langs": [], "cats": [], "projects": [],
    "rhq": [{"id": "kia-eu", "brand": "Kia", "cc": ["DE", "FR"]}, {"id": "kia-empty", "brand": "Kia", "cc": []}]})


def _p(role="region", scope_all=False, brands=("Kia",), regions=(), countries=()):
    return Principal(uuid.uuid4(), "x@example.test", role, "none", scope_all, tuple(brands), tuple(regions), tuple(countries), None, False)


def test_datascope_region_expansion_and_decisions():
    assert DataScope.of(_p(regions=("kia-eu",)), REFS).countries == ("DE", "FR")
    assert DataScope.of(_p(regions=("kia-empty",)), REFS).countries == ()              # 풀리지 않는 권역 → 거부(B1)
    assert DataScope.of(_p(regions=("no-such",)), REFS).countries == ()
    assert DataScope.of(_p(regions=()), REFS).countries is None
    v = DataScope.of(_p(role="vendor", brands=()), REFS)
    assert v.brands is None and not v.all                                                # 브랜드 스코프 빈 vendor = 무제한(결정)
    assert DataScope.of(_p(role="hq", brands=("HMG",)), REFS).brands == ()             # 엄브렐러만 = 거부
    a = DataScope.of(_p(role="admin", scope_all=False, brands=("Kia",)), REFS)
    assert a.all and a.brands is None and a.countries is None                            # admin = 전체(Q16)


def test_unresolved_region_denies_project_visibility():
    """재검증 N3: 권역 id 가 하나라도 미해석이면 비멤버 프로젝트 가시성 거부 + 데이터 스코프도 거부."""
    ok = DataScope.of(_p(regions=("kia-eu",)), REFS)
    assert ok.project_in_scope(REFS, "Kia", "DE") and not ok.project_in_scope(REFS, "Kia", "US")
    part = DataScope.of(_p(regions=("kia-eu", "gone-region")), REFS)
    assert part.countries == () and not part.project_in_scope(REFS, "Kia", "DE") and not part.project_in_scope(REFS, None, None)


# ── m4: url_rates 필수 인자(시그니처) ────────────────────────────────────────
def test_url_rates_requires_scope_args():
    import inspect

    from app.core.measure import url_rates
    ps = inspect.signature(url_rates).parameters
    assert ps["countries"].default is inspect.Parameter.empty and ps["langs"].default is inspect.Parameter.empty
    assert ps["brands"].default is inspect.Parameter.empty


# ── m10: QaConn 은 QaUser 에 의존한다 ──────────────────────────────────────────
def test_qa_conn_depends_on_qa_user():
    import typing

    from app.core.auth import QaConn, get_qa_conn, require_qa_reviewer
    dep = typing.get_args(QaConn)[1].dependency
    assert dep is get_qa_conn
    sub = typing.get_args(typing.get_type_hints(get_qa_conn, include_extras=True)["reviewer"])[1].dependency
    assert sub is require_qa_reviewer


# ── DB: 계정 트리거·CHECK·단언 엄격 모드·로그인 롤 ────────────────────────────────
@needs_db
async def test_user_account_triggers_and_checks(seeded, database):
    uid = uuid.uuid4()
    async with database.write(ADMIN) as c:                                             # 앱 경로: 행위자 GUC 가 심긴 api_rw
        await c.exec_driver_sql(f"INSERT INTO app.user_account (user_id, email, role, scope_brands, scope_regions) "
                                f"VALUES ('{uid}', 't-{uid.hex[:8]}@example.test', 'region', '{{Kia}}', '{{kia-western-europe}}')")
        await c.exec_driver_sql(f"UPDATE app.user_account SET scope_regions = '{{kia-north-america}}' WHERE user_id = '{uid}'")
        await c.exec_driver_sql(f"UPDATE app.user_account SET display_name = 'x' WHERE user_id = '{uid}'")   # 권한 무관 → 감사 행 없음
    cn = await asyncpg.connect(DB_URL)
    try:
        rows = await cn.fetch("SELECT change_type, actor_id, after->'scope_regions' AS r FROM app.permission_audit_log "
                              "WHERE target_user_id = $1 ORDER BY audit_id", uid)
        assert [(r["change_type"], r["actor_id"]) for r in rows] == [("create", ADMIN), ("update", ADMIN)]
        assert json.loads(rows[1]["r"]) == ["kia-north-america"]
        with pytest.raises(asyncpg.ForeignKeyViolationError):                       # 풀리지 않는 권역 id 는 저장 불가(B1)
            await cn.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
            await cn.execute("UPDATE app.user_account SET scope_regions = '{no-such-region}' WHERE user_id = $1", uid)
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await cn.execute("UPDATE app.user_account SET scope_countries = '{ZZ}' WHERE user_id = $1", uid)
        with pytest.raises(asyncpg.CheckViolationError):                            # admin → scope_all 강제(Q16)
            await cn.execute("UPDATE app.user_account SET role = 'admin', scope_all = false WHERE user_id = $1", uid)
        await cn.execute("SELECT set_config('app.actor_id', '', false)")
        with pytest.raises(asyncpg.RaiseError, match="actor_id"):                    # 행위자 없는 계정 쓰기 거부
            await cn.execute("UPDATE app.user_account SET operator = 'global' WHERE user_id = $1", uid)
        assert not await cn.fetchval("SELECT has_table_privilege('api_rw', 'app.permission_audit_log', 'INSERT')")
    finally:
        await cn.close()


@needs_db
async def test_assert_strict_mode(seeded):
    cn = await asyncpg.connect(DB_URL)
    try:
        assert await cn.fetchval("SELECT rd.assert_answer_cit_counts(ARRAY[1, 99999])") == 1          # 비엄격: 미지 키 무시
        assert await cn.fetchval("SELECT rd.assert_answer_cit_counts(ARRAY[1, 21], true)") == 2
        for keys in ("ARRAY[1, 99999]", "ARRAY[1, 13]", "ARRAY[14]"):                                  # 미지·비완료·드롭
            with pytest.raises(asyncpg.RaiseError, match="서빙 답변이 아닌 키"):
                await cn.fetchval(f"SELECT rd.assert_answer_cit_counts({keys}, true)")
    finally:
        await cn.close()


@needs_db
async def test_app_login_role_noinherit(seeded):
    """hgh_app(LOGIN NOINHERIT) 정의를 확인하고, 같은 모양의 임시 로그인 롤로 동작을 시험한다(공유 컨테이너 전역 롤 hgh_app 은 바꾸지 않는다).
    롤 전환 없이는 rd 를 못 읽고, core.db 트랜잭션(풀 롤 전환)으로만 읽는다."""
    tmp = f"hgh_app_t_{uuid.uuid4().hex[:8]}"
    pw = uuid.uuid4().hex
    cn = await asyncpg.connect(DB_URL)
    try:
        r = await cn.fetchrow("SELECT rolcanlogin, rolinherit FROM pg_roles WHERE rolname = 'hgh_app'")
        assert r["rolcanlogin"] and not r["rolinherit"]
        grants = await cn.fetch("SELECT r.rolname, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid "
                                "JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'hgh_app' ORDER BY 1")
        assert [(g["rolname"], g["inherit_option"], g["set_option"]) for g in grants] == [
            ("admin_long", False, True), ("api_ro", False, True), ("api_rw", False, True), ("qa_gate", False, True)]
        await cn.execute(f"CREATE ROLE {tmp} LOGIN NOINHERIT PASSWORD '{pw}'")
        await cn.execute(f"GRANT api_ro, api_rw, admin_long, qa_gate TO {tmp} WITH INHERIT FALSE, SET TRUE")
        dbname = DB_URL.rsplit("/", 1)[1]
        await cn.execute(f'GRANT CONNECT ON DATABASE "{dbname}" TO {tmp}')
        url = DB_URL.replace("postgres:dev@", f"{tmp}:{pw}@")
        raw = await asyncpg.connect(url)
        try:
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await raw.fetchval("SELECT count(*) FROM rd.answer")
        finally:
            await raw.close()
        d = Database(Settings(env="test", db_url=SecretStr(url), sql_guard=True))
        try:
            async with d.read("api_ro") as c:
                assert (await c.exec_driver_sql("SELECT current_user, session_user")).first() == ("api_ro", tmp)
                assert (await c.exec_driver_sql("SELECT count(*) FROM rd.answer", execution_options={"hgh_sql_guard": False})).scalar() == 19
            async with d.write(HQ_HYUNDAI) as c:
                assert (await c.exec_driver_sql("SELECT current_user")).scalar() == "api_rw"
            async with d.transaction("qa_gate") as c:
                assert (await c.exec_driver_sql("SELECT current_user")).scalar() == "qa_gate"
        finally:
            await d.dispose()
    finally:
        await cn.execute(f'REVOKE CONNECT ON DATABASE "{DB_URL.rsplit("/", 1)[1]}" FROM {tmp}')
        await cn.execute(f"DROP ROLE IF EXISTS {tmp}")
        await cn.close()


@needs_db
async def test_engine_guard_blocks_violations(database):
    """local·test 엔진 가드: 사실 표 술어 없는 문장은 DB 에 가기 전에 SqlGuardError(기능 통합 테스트가 걸린다)."""
    from app.core.sqlguard import SqlGuardError
    async with database.read("api_ro") as c:
        with pytest.raises(SqlGuardError):
            await c.exec_driver_sql("SELECT count(*) FROM rd.answer a WHERE a.surface = 1")
    async with database.read("api_ro") as c:
        with pytest.raises(SqlGuardError):
            await c.exec_driver_sql("SELECT set_config('role', 'api_rw', false)")


@needs_db
async def test_rhq_region_guard_triggers(seeded):
    """재검증 N3·DB-v2.4: 계정이 참조하는 권역·국가의 삭제·키 변경·TRUNCATE 거부, 라벨 변경은 허용(시험 후 롤백)."""
    cn = await asyncpg.connect(DB_URL)
    try:
        tr = cn.transaction()
        await tr.start()
        await cn.execute("SELECT set_config('app.actor_id', $1, true)", str(ADMIN))
        with pytest.raises(asyncpg.ForeignKeyViolationError):              # KIA_EU 계정이 kia-western-europe 참조
            async with cn.transaction():
                await cn.execute("DELETE FROM app.rhq_region WHERE region_id = 'kia-western-europe'")
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            async with cn.transaction():
                await cn.execute("DELETE FROM app.rhq_region_country WHERE region_id = 'kia-western-europe' AND country_code = 'DE'")
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            async with cn.transaction():
                await cn.execute("UPDATE app.rhq_region SET brand_code = 'Hyundai' WHERE region_id = 'kia-western-europe'")
        with pytest.raises(asyncpg.ForeignKeyViolationError):
            async with cn.transaction():
                await cn.execute("TRUNCATE app.rhq_region_country")
        async with cn.transaction():                                         # 라벨 변경은 참조와 무관
            await cn.execute("UPDATE app.rhq_region SET label = label || '*' WHERE region_id = 'kia-western-europe'")
        # 계정 국가 참조(KIA_US = US): US 가 여러 권역에 있으면 한 행 삭제는 허용, 마지막 행 삭제는 거부
        n_us = await cn.fetchval("SELECT count(*) FROM app.rhq_region_country WHERE country_code = 'US'")
        unref = await cn.fetch("SELECT c.region_id FROM app.rhq_region_country c WHERE c.country_code = 'US' AND NOT EXISTS "
                               "(SELECT 1 FROM app.user_account u WHERE c.region_id = ANY(u.scope_regions)) ORDER BY 1")
        assert n_us >= 1
        for i, row in enumerate(unref):
            stmt = "DELETE FROM app.rhq_region_country WHERE region_id = $1 AND country_code = 'US'"
            if i < n_us - 1:
                await cn.execute(stmt, row["region_id"])
            else:
                with pytest.raises(asyncpg.ForeignKeyViolationError):
                    async with cn.transaction():
                        await cn.execute(stmt, row["region_id"])
        # 참조 없는 권역(계정 권역·국가 밖)은 삭제 가능
        free = await cn.fetchval("SELECT r.region_id FROM app.rhq_region r WHERE NOT EXISTS (SELECT 1 FROM app.user_account u "
                                 "WHERE r.region_id = ANY(u.scope_regions)) AND NOT EXISTS (SELECT 1 FROM app.rhq_region_country c "
                                 "WHERE c.region_id = r.region_id AND c.country_code IN ('US')) ORDER BY 1 LIMIT 1")
        await cn.execute("DELETE FROM app.rhq_region WHERE region_id = $1", free)
        await tr.rollback()
    finally:
        await cn.close()


@needs_db
async def test_mixed_case_virtual_region_report(ro, database, seeded):
    """재검증 N2: 대소문자 혼합 가상 지역(SA-Dammam) 발행 유닛이 geo_keys 스코프에서 빠지지 않는다."""
    from datetime import date

    from app.core.codes import load_refs
    from app.core.cycles import CycleRow, build_window
    from app.core.db import fetch_all
    from app.core.filters import KPI_SUPPORT, CommonFilters, resolve_read_context
    from app.core.measure import report_values_sql, url_rates
    from tests.support import principal

    refs = await load_refs(ro)
    sa = refs.geo_key("SA-Dammam")
    assert sa is not None and refs.countries["SA-DAMMAM"].code == "SA-Dammam"            # 원표기 보존
    q = report_values_sql([date(2026, 9, 25)], ["Kia"], None, None, project_keys=(2,), geo_keys=(sa,))
    rows = await fetch_all(ro, q.text, q.params)
    assert [(r["measured"], r["target_hit"]) for r in rows] == [(4, 2)]
    q = report_values_sql([date(2026, 9, 25)], ["Kia"], ["sa-dammam"], None, project_keys=(2,), geo_keys=(sa,))
    assert len(await fetch_all(ro, q.text, q.params)) == 1                                   # 요청 국가 대소문자 무관
    ctx = await resolve_read_context(ro, await principal(ro, ADMIN), CommonFilters.model_validate(
        {"surface": "website", "country": ["SA-Dammam"]}), support=KPI_SUPPORT)
    assert ctx.geo_keys == (sa,) and ctx.countries == ("SA-DAMMAM",)
    ms = ctx.measure()
    ms2 = type(ms)(**{**ms.__dict__, "project_keys": (2,)})                                 # 사이트 스코프: 유닛 102 의 사이트 프로젝트
    d = date(2026, 9, 25)
    w = build_window(surface="website", mode="snapshot", rows=[CycleRow(99, 2, d, 0)], lo=d, hi=d, generation=1, project_keys=(2,))
    r = await url_rates(ro, ms2, w, brands=["Kia"], countries=ctx.countries, langs=None)
    assert {k: r[None][k] for k in ("target", "owned", "origin", "publications")} == {"target": (2, 4), "owned": (3, 4), "origin": "report",
                                                                                     "publications": ["rep-0925"]}


@needs_db
async def test_fetch_keyset_maps_data_error_to_422(database):
    """3차 D1 최후 방어: 검증을 지난 커서 값이 DB 입력 오류(asyncpg DataError, SQLSTATE 22)를 내면 422 cursor_invalid.
    5라운드: 커서를 준 요청에서만 매핑하고, 커서가 없거나 문자열 인코딩 오류(22021)면 원래 오류를 올린다(원인과 다른 코드로 뭉개지 않음)."""
    from sqlalchemy.exc import DBAPIError

    from app.core.pagination import Cursor, fetch_keyset
    cur = Cursor(sort="x", dir="asc", key=(70000,), fh="f")
    async with database.read("api_ro") as c:
        with pytest.raises(errors.ApiError) as e:
            await fetch_keyset(c, "SELECT 1 AS x FROM app.brand b WHERE b.sort_order > CAST(:k AS int2)", {"k": 70000}, cursor=cur)
        assert e.value.status == 422 and e.value.code == "cursor_invalid"
    async with database.read("api_ro") as c:
        with pytest.raises(errors.ApiError) as e:
            await fetch_keyset(c, "SELECT 1 AS x FROM app.brand b WHERE b.brand_code > CAST(:k AS text) AND 1 / 0 = 1", {"k": "a"},
                               cursor=cur)
        assert e.value.status == 422                                          # 22012 division_by_zero 도 22 계열
    async with database.read("api_ro") as c:
        with pytest.raises(DBAPIError):                                       # 커서 없음 = 원래 오류 그대로
            await fetch_keyset(c, "SELECT 1 AS x FROM app.brand b WHERE b.sort_order > CAST(:k AS int2)", {"k": 70000})
    async with database.read("api_ro") as c:
        with pytest.raises(DBAPIError):                                       # 문자열 인자의 NUL(22021) 은 커서가 있어도 커서 오류가 아니다
            await fetch_keyset(c, "SELECT 1 AS x FROM app.brand b WHERE b.brand_code = CAST(:q AS text)", {"q": "a\x00b"}, cursor=cur)
    async with database.read("api_ro") as c:
        rows = await fetch_keyset(c, "SELECT brand_code FROM app.brand b WHERE b.sort_order > CAST(:k AS int2) ORDER BY 1", {"k": 0})
        assert len(rows) >= 3


def test_parse_refs_rejects_case_only_duplicate_country():
    """권고: rd.dim_country 코드가 대소문자만 달리 중복이면 대소문자 무시 조회가 모호하므로 거부."""
    base = {"brands": [], "owned": [], "engines": [], "langs": [], "rhq": [], "cats": [], "projects": []}
    with pytest.raises(ValueError, match="대소문자"):
        parse_refs({**base, "countries": [{"k": 1, "code": "SA-Dammam", "kind": "pseudo", "r": None, "vb": None, "h": False},
                                          {"k": 2, "code": "SA-DAMMAM", "kind": "pseudo", "r": None, "vb": None, "h": False}]})


def test_fixture00_bytes_match_seed10():
    """3차 D4: fixture-00-rules.sql 은 seed-10-app.sql 의 규칙 절 발췌다. non_competitor 패턴(CR 27개 포함) 바이트가 같아야 한다."""
    import pathlib
    root = pathlib.Path(__file__).resolve().parents[2]
    fx = (root / "tests/fixtures/fixture-00-rules.sql").read_bytes()
    sd = (root / "migration/seed/seed-10-app.sql").read_bytes()

    def blk(t: bytes, a: bytes, b: bytes) -> bytes:
        i = t.index(a)
        return t[i:t.index(b, i)]
    for a, b in ((b"-- 3-3. app.non_competitor_name", b"-- 3-4."), (b"-- 3-6. app.rhq_region", b"-- 3-7.")):
        assert blk(fx, a, b) == blk(sd, a, b), a
    assert blk(fx, b"-- 3-3. app.non_competitor_name", b"-- 3-4.").count(b"\r") == 27
    assert fx.count(b"\r") == sd.count(b"\r") == 27


@needs_db
async def test_client_as_helper(client_as):
    """D5: 기능 테스트용 client_as — 인증 헤더가 붙은 앱 클라이언트."""
    async with client_as(HQ_HYUNDAI) as c:
        assert c.headers["Authorization"].startswith("Bearer ")
        assert (await c.get("/healthz")).json() == {"ok": True}
    async with client_as(None) as c:
        assert "Authorization" not in c.headers
