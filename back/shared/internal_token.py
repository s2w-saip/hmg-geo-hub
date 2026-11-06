"""The token the hub server signs for each request it passes to the data server: which account, in which scope, for a short time. A different key
from the login token's (HGH_INTERNAL_TOKEN_SECRET): the data server can check it and cannot sign one a browser would accept, and a login token is
no use against the data server. It carries the account's id and role while the data server still writes in that account's name (until step 1f)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from uuid import UUID

from shared.account import Principal

ENV = "HGH_INTERNAL_TOKEN_SECRET"
TTL_S = 60
SECRET_MIN_BYTES = 32
_PREFIX = "i1"


def key() -> bytes | None:
    raw = os.environ.get(ENV, "")
    return raw.encode() if len(raw.encode()) >= SECRET_MIN_BYTES else None


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(secret: bytes, who: Principal, now: float, ttl: int = TTL_S) -> str:
    payload = _b64(json.dumps({"sub": str(who.user_id), "role": who.role, "brands": list(who.brands), "regions": list(who.regions),
                               "countries": list(who.countries), "iat": int(now), "exp": int(now) + ttl}, separators=(",", ":")).encode())
    signature = _b64(hmac.new(secret, f"{_PREFIX}.{payload}".encode(), hashlib.sha256).digest())
    return f"{_PREFIX}.{payload}.{signature}"


def verify(secret: bytes, token: str, now: float) -> Principal | None:
    """The account a well-formed token names when it is signed with `secret` and not expired; otherwise None."""
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != _PREFIX:
        return None
    try:
        expected = hmac.new(secret, f"{_PREFIX}.{parts[1]}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(parts[2])):
            return None
        claims = json.loads(_unb64(parts[1]))
        if not isinstance(claims["exp"], int) or claims["exp"] <= now:
            return None
        return Principal(UUID(claims["sub"]), "", None, None, claims["role"], tuple(claims["brands"]), tuple(claims["regions"]), tuple(claims["countries"]))
    except (ValueError, KeyError, TypeError):
        return None
