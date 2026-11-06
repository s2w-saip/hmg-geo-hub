"""The token the hub server signs for each request it passes to the data server: the account's scope, for a short time. A different key from the login token's
(HGH_INTERNAL_TOKEN_SECRET): the data server can check it and cannot sign one a browser would accept, and a login token is no use against the data server."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os

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


def sign(secret: bytes, scope: dict, now: float, ttl: int = TTL_S) -> str:
    payload = _b64(json.dumps({"scope": scope, "iat": int(now), "exp": int(now) + ttl}, separators=(",", ":")).encode())
    signature = _b64(hmac.new(secret, f"{_PREFIX}.{payload}".encode(), hashlib.sha256).digest())
    return f"{_PREFIX}.{payload}.{signature}"


def verify(secret: bytes, token: str, now: float) -> dict | None:
    """The scope a well-formed token carries when it is signed with `secret` and not expired; otherwise None."""
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != _PREFIX:
        return None
    try:
        expected = hmac.new(secret, f"{_PREFIX}.{parts[1]}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(parts[2])):
            return None
        claims = json.loads(_unb64(parts[1]))
        if not isinstance(claims["exp"], int) or claims["exp"] <= now or not isinstance(claims["scope"], dict):
            return None
        return claims["scope"]
    except (ValueError, KeyError, TypeError):
        return None
