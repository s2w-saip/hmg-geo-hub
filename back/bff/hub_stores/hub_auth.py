"""HUB login (2026-10-27; every role since 2026-10-29). The local front end's every page needs it (it asks
/v1/auth/me per page), and every screen and data read runs for the signed-in account's scope (bff/access.py).

Next posts the login to POST /v1/auth/login, keeps the returned token in an httpOnly cookie and sends it
back as `Authorization: Bearer` on every BFF call. The token is stateless (HMAC-SHA256 with
HGH_AUTH_SECRET) and names the account and its credential version. Every request reads the account
again, so disabling it, changing its role or scope or its password ends or narrows its sessions at once.

Roles (system.global_role): admin (every scope, the Admin pages and every HUB write), hq, region and country
(their brands, RHQ regions and countries; read only). An account without a role cannot sign in. Accounts are
created on the Admin screen (hub_stores/accounts.py) or by back/hub_storage/manage.py set-admin. A password an
administrator issued (must_change) opens nothing but /v1/auth/me and the password change (accounts.change_password)
until it is replaced."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
from collections import deque
from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException

from bff.hub_stores import operations_db
from bff.hub_stores.passwords import DUMMY_HASH, verify_password

TOKEN_TTL_S = int(os.environ.get("HGH_AUTH_TTL_S", str(8 * 3600)))
SECRET_MIN_BYTES = 32
LOGIN_MAX = 200
PASSWORD_MAX = 1024
# Failed logins per login id inside the window before further attempts are refused (one API process).
FAILURE_LIMIT, FAILURE_WINDOW_S = 5, 15 * 60

ROLES = ("admin", "hq", "region", "country")
ACCOUNT_SQL = """SELECT a.user_id,a.subject,a.email,a.display_name,a.status,c.password_hash,c.changed_at,c.must_change,
    g.role,g.brands,g.regions,g.countries
    FROM system.user_account a JOIN system.user_credential c USING(user_id)
    LEFT JOIN system.global_role g USING(user_id) WHERE {where}"""
BY_LOGIN = "lower(a.subject)=lower($1)"
BY_ID = "a.user_id=$1"


@dataclass(frozen=True)
class Principal:
    user_id: UUID
    login: str
    email: str | None
    display_name: str | None
    role: str
    brands: tuple[str, ...] = ()
    regions: tuple[str, ...] = ()
    countries: tuple[str, ...] = ()
    must_change: bool = False

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def scope(self) -> dict:
        """front AllowedScope: the administrator every scope, the others their brands, regions and countries."""
        if self.is_admin:
            return {"all": True}
        return {"all": False, "brands": list(self.brands), "regions": list(self.regions), "countries": list(self.countries)}

    def view(self) -> dict:
        return {"id": str(self.user_id), "login": self.login, "email": self.email, "displayName": self.display_name,
                "role": self.role, "scope": self.scope(), "mustChangePassword": self.must_change}


def unauthorized(message: str = "Sign in to the HUB") -> HTTPException:
    return HTTPException(401, message)


def password_change_required() -> HTTPException:
    return HTTPException(403, {"code": "password_change_required", "message": "Set a new password first"})


def admin_only() -> HTTPException:
    return HTTPException(403, {"code": "forbidden", "message": "The top-level administrator only"})


def secret() -> bytes | None:
    raw = os.environ.get("HGH_AUTH_SECRET", "")
    return raw.encode() if len(raw.encode()) >= SECRET_MIN_BYTES else None


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def credential_version(changed_at) -> int:
    return round(changed_at.timestamp() * 1_000_000)


def issue(key: bytes, user_id: UUID, version: int, now: float) -> tuple[str, int]:
    exp = int(now) + TOKEN_TTL_S
    payload = _b64(json.dumps({"sub": str(user_id), "cv": version, "iat": int(now), "exp": exp},
                              separators=(",", ":")).encode())
    signature = _b64(hmac.new(key, f"v1.{payload}".encode(), hashlib.sha256).digest())
    return f"v1.{payload}.{signature}", exp


def decode(key: bytes, token: str, now: float) -> dict | None:
    """The token's claims when it is well formed, signed with `key` and not expired; otherwise None."""
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return None
    try:
        expected = hmac.new(key, f"v1.{parts[1]}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(parts[2])):
            return None
        claims = json.loads(_unb64(parts[1]))
        UUID(claims["sub"])
        if not isinstance(claims["cv"], int) or not isinstance(claims["exp"], int):
            return None
    except (ValueError, KeyError, TypeError):
        return None
    return claims if claims["exp"] > now else None


class FailureLimiter:
    def __init__(self, limit: int = FAILURE_LIMIT, window: float = FAILURE_WINDOW_S):
        self.limit, self.window = limit, window
        self.failures: dict[str, deque] = {}

    def _recent(self, key: str, now: float) -> deque:
        q = self.failures.setdefault(key, deque())
        while q and q[0] <= now - self.window:
            q.popleft()
        return q

    def blocked(self, key: str, now: float) -> bool:
        return len(self._recent(key, now)) >= self.limit

    def fail(self, key: str, now: float) -> None:
        self._recent(key, now).append(now)

    def reset(self, key: str) -> None:
        self.failures.pop(key, None)


limiter = FailureLimiter()


def _principal(row) -> Principal:
    return Principal(row["user_id"], row["subject"], row["email"], row["display_name"], row["role"],
                     tuple(row["brands"] or ()), tuple(row["regions"] or ()), tuple(row["countries"] or ()),
                     bool(row["must_change"]))


def _active(row) -> bool:
    return row is not None and row["status"] == "active" and row["role"] in ROLES


async def _account(where: str, value):
    try:
        async with operations_db.connection() as conn:
            return await conn.fetchrow(ACCOUNT_SQL.format(where=where), value)
    except ConnectionError:
        raise HTTPException(503, "HUB login is not configured (operations store)") from None


async def login(login_id: str, password: str) -> dict:
    key = secret()
    if key is None:
        raise HTTPException(503, "HUB login is not configured (HGH_AUTH_SECRET)")
    login_id = login_id.strip()
    if not login_id or len(login_id) > LOGIN_MAX or not password or len(password) > PASSWORD_MAX:
        raise unauthorized("Login ID or password is incorrect")
    now = time.time()
    bucket = login_id.casefold()
    if limiter.blocked(bucket, now):
        raise HTTPException(429, "Too many failed sign-ins; try again later")
    row = await _account(BY_LOGIN, login_id)
    # scrypt is CPU-bound: off the event loop. The dummy hash keeps an unknown login as slow as a wrong password.
    ok = await asyncio.to_thread(verify_password, password, row["password_hash"] if row else DUMMY_HASH)
    if not (ok and _active(row)):
        limiter.fail(bucket, now)
        raise unauthorized("Login ID or password is incorrect")
    limiter.reset(bucket)
    return _session(key, row, now)


def _session(key: bytes, row, now: float) -> dict:
    token, exp = issue(key, row["user_id"], credential_version(row["changed_at"]), now)
    return {"token": token, "expiresAt": exp, "user": _principal(row).view()}


async def reissue(user_id: UUID) -> dict:
    """A new session of the account as it is now (after its password changed, which ended the earlier ones)."""
    key = secret()
    if key is None:
        raise HTTPException(503, "HUB login is not configured (HGH_AUTH_SECRET)")
    row = await _account(BY_ID, user_id)
    if not _active(row):
        raise unauthorized()
    return _session(key, row, time.time())


async def password_matches(user_id: UUID, password: str) -> bool:
    row = await _account(BY_ID, user_id)
    if row is None or len(password) > PASSWORD_MAX:
        return False
    return await asyncio.to_thread(verify_password, password, row["password_hash"])


async def principal(authorization: str | None, *, password_change: bool = False) -> Principal:
    """The signed-in account, or 401 (no, bad, expired or revoked session). An account that has to replace an
    issued password gets 403 password_change_required, except where `password_change` lets it through."""
    key = secret()
    if key is None:
        raise HTTPException(503, "HUB login is not configured (HGH_AUTH_SECRET)")
    scheme, _, token = (authorization or "").partition(" ")
    claims = decode(key, token.strip(), time.time()) if scheme.lower() == "bearer" else None
    if claims is None:
        raise unauthorized()
    row = await _account(BY_ID, UUID(claims["sub"]))
    if not _active(row) or credential_version(row["changed_at"]) != claims["cv"]:
        raise unauthorized()
    if row["must_change"] and not password_change:
        raise password_change_required()
    return _principal(row)


async def admin(authorization: str | None) -> Principal:
    """The signed-in top-level administrator: 401 without a session, 403 for another role."""
    who = await principal(authorization)
    if not who.is_admin:
        raise admin_only()
    return who

