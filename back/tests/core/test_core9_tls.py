"""core 9 D-5: DB 접속 sslmode=verify-full + RDS CA 번들(HGH_DB_SSLROOTCERT). 개발 DB 는 TLS 가 꺼져 있어(ssl=off) 테스트 안에서
127.0.0.1 임시 소켓 하나로 PostgreSQL SSLRequest 에 'S' 로 답하고 TLS 핸드셰이크만 하는 가짜 서버를 띄운다(테스트가 끝나면 닫는다).
검증이 통과하면 핸드셰이크 뒤 서버가 끊어 연결 오류가, 실패하면 인증서 검증 오류가 난다: 둘을 구분해 asyncpg(API 풀·적재 워커) 경로를 확인한다."""
from __future__ import annotations

import asyncio
import datetime as dt
import ssl
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from pydantic import SecretStr

from app.core import db as db_mod
from app.core.config import Settings, load_settings


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def _ca(cn: str):
    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(_name(cn)).issuer_name(_name(cn)).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=2))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False, data_encipherment=False,
                                         key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False),
                           critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    return key, cert


def _leaf(ca_key, ca_cert, host: str):
    key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(_name(host)).issuer_name(ca_cert.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(days=1)).not_valid_after(now + dt.timedelta(days=2))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(ca_key, hashes.SHA256()))
    return key, cert


def _pem(cert) -> bytes:
    return cert.public_bytes(serialization.Encoding.PEM)


@pytest.fixture(scope="module")
def pki(tmp_path_factory):
    d = tmp_path_factory.mktemp("hgh-core9-tls")
    ca_key, ca = _ca("hgh test rds ca")
    other_key, other = _ca("hgh other ca")
    out = {"dir": d, "bundle": d / "rds-ca-bundle.pem", "other_bundle": d / "other-bundle.pem"}
    out["bundle"].write_bytes(_pem(ca))
    out["other_bundle"].write_bytes(_pem(other))
    for name, (k, c) in {"good": _leaf(ca_key, ca, "localhost"), "wronghost": _leaf(ca_key, ca, "db.other.example")}.items():
        (d / f"{name}.crt").write_bytes(_pem(c))
        (d / f"{name}.key").write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                        serialization.NoEncryption()))
    return out


@asynccontextmanager
async def fake_pg_tls(pki, leaf: str) -> AsyncIterator[dict]:
    """SSLRequest(8바이트) → 'S' → TLS(서버 쪽) → 핸드셰이크가 끝나면 끊는다. 결과: handshakes = 성공한 핸드셰이크 수."""
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(pki["dir"] / f"{leaf}.crt", pki["dir"] / f"{leaf}.key")
    state = {"handshakes": 0, "requests": 0}

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            req = await reader.readexactly(8)
            state["requests"] += 1
            if req[4:] != (80877103).to_bytes(4, "big"):          # SSLRequest 코드
                return
            writer.write(b"S")
            await writer.drain()
            await writer.start_tls(ctx)
            state["handshakes"] += 1
        except (ssl.SSLError, ConnectionError, asyncio.IncompleteReadError, OSError):
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(handle, host="127.0.0.1", port=0)
    state["port"] = server.sockets[0].getsockname()[1]
    try:
        yield state
    finally:
        server.close()
        await server.wait_closed()


def _is_verify_error(e: BaseException) -> bool:
    cur: BaseException | None = e
    for _ in range(6):
        if isinstance(cur, ssl.SSLCertVerificationError):
            return True
        cur = cur.__cause__ or cur.__context__
        if cur is None:
            break
    return False


# ── 순수 규칙 ─────────────────────────────────────────────────────────────────
def test_asyncpg_url_tls_modes(pki):
    base = "postgresql://u:p@db.example:5432/hmg?sslmode=require"
    url, args = db_mod.asyncpg_url(base)                                          # 미설정 = 현행(require 문자열)
    assert args["ssl"] == "require" and "sslmode" not in url
    url, args = db_mod.asyncpg_url(base, sslrootcert=str(pki["bundle"]))          # 설정 = verify-full 컨텍스트(URL sslmode 무시)
    ctx = args["ssl"]
    assert isinstance(ctx, ssl.SSLContext) and ctx.check_hostname and ctx.verify_mode == ssl.CERT_REQUIRED
    assert len(ctx.get_ca_certs()) == 1 and "sslmode" not in url
    _, args = db_mod.asyncpg_url("postgresql://u:p@h/db?sslmode=disable", sslrootcert=str(pki["bundle"]))
    assert isinstance(args["ssl"], ssl.SSLContext)                                # 환경 설정이 URL 의 disable 보다 우선
    url, args = db_mod.asyncpg_url(f"postgresql://u:p@h/db?sslmode=verify-ca&sslrootcert={pki['bundle']}")
    assert isinstance(args["ssl"], ssl.SSLContext) and not args["ssl"].check_hostname and "sslrootcert" not in url
    url, args = db_mod.asyncpg_url(f"postgresql://u:p@h/db?sslmode=verify-full&sslrootcert={pki['bundle']}")
    assert args["ssl"].check_hostname and "sslrootcert" not in url
    _, args = db_mod.asyncpg_url("postgresql://u:p@h/db")
    assert "ssl" not in args


def test_settings_and_libpq_params(pki):
    s = load_settings({"HGH_ENV": "local", "HGH_DB_SSLROOTCERT": str(pki["bundle"])})
    assert s.db_sslrootcert == str(pki["bundle"]) and "db_tls=verify-full" in repr(s)
    assert db_mod.libpq_ssl_params(s) == {"sslmode": "verify-full", "sslrootcert": str(pki["bundle"])}
    assert db_mod.libpq_ssl_env(s) == {"PGSSLMODE": "verify-full", "PGSSLROOTCERT": str(pki["bundle"])}
    none = load_settings({"HGH_ENV": "local"})
    assert none.db_sslrootcert is None and db_mod.libpq_ssl_params(none) == {} and db_mod.libpq_ssl_env(none) == {}
    with pytest.raises(ValueError, match="HGH_DB_SSLROOTCERT"):
        load_settings({"HGH_ENV": "local", "HGH_DB_SSLROOTCERT": str(pki["dir"] / "missing.pem")})
    with pytest.raises(ValueError, match="HGH_DB_SSLROOTCERT"):
        load_settings({"HGH_ENV": "prod", "HGH_JWKS_URL": "https://x/jwks", "HGH_JWT_ISSUER": "https://x",
                       "HGH_DB_SSLROOTCERT": str(pki["dir"])})                      # 디렉터리는 안 된다(파일만)


# ── 실제 핸드셰이크(asyncpg: API 풀 엔진·적재 워커 연결) ─────────────────────────────
def _settings(port: int, bundle, host: str = "localhost") -> Settings:
    return Settings(env="test", db_url=SecretStr(f"postgresql://u:p@{host}:{port}/hmg?sslmode=require"), db_sslrootcert=str(bundle),
                    db_assume_role=False)


async def _engine_connect(s: Settings) -> None:
    d = db_mod.Database(s)
    try:
        async with d.engine("api_ro").connect():
            pass
    finally:
        await d.dispose()


@pytest.mark.parametrize("path", ["engine", "loader"])
async def test_verify_full_handshake(pki, path):
    """같은 CA·맞는 이름 = 검증 통과(핸드셰이크 성공 뒤 서버가 끊어 연결 오류), 다른 CA·다른 이름 = 인증서 검증 오류.
    rootcert 없는 현행(require)은 다른 CA 인증서도 받는다(검증 없음: 이 설정이 필요한 이유)."""
    async def connect(s: Settings) -> None:
        if path == "engine":
            await _engine_connect(s)
        else:
            await db_mod.loader_connect(s, dsn=s.db_url.get_secret_value())   # type: ignore[union-attr]

    async with fake_pg_tls(pki, "good") as srv:
        with pytest.raises(BaseException) as ei:                              # noqa: B017 (검증 통과 뒤 끊김: 종류는 드라이버마다 다르다)
            await asyncio.wait_for(connect(_settings(srv["port"], pki["bundle"])), 10)
        assert not _is_verify_error(ei.value) and srv["handshakes"] == 1, repr(ei.value)

        with pytest.raises(BaseException) as ei:                              # noqa: B017
            await asyncio.wait_for(connect(_settings(srv["port"], pki["other_bundle"])), 10)
        assert _is_verify_error(ei.value), repr(ei.value)
        assert srv["handshakes"] == 1

        plain = Settings(env="test", db_url=SecretStr(f"postgresql://u:p@localhost:{srv['port']}/hmg?sslmode=require"), db_assume_role=False)
        with pytest.raises(BaseException) as ei:                              # noqa: B017
            await asyncio.wait_for(connect(plain), 10)
        assert not _is_verify_error(ei.value) and srv["handshakes"] == 2      # 현행 require: 검증 없이 핸드셰이크

    async with fake_pg_tls(pki, "wronghost") as srv:                          # 같은 CA, 다른 호스트 이름 → verify-full 이 거부
        with pytest.raises(BaseException) as ei:                              # noqa: B017
            await asyncio.wait_for(connect(_settings(srv["port"], pki["bundle"])), 10)
        assert _is_verify_error(ei.value) and srv["handshakes"] == 0, repr(ei.value)

