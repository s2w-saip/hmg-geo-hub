"""The account a request runs for. The hub server signs in the account and checks it again on every request (hub_server/auth.py), then sends it here
in a short-lived internal token. This server trusts that token and nothing else: no token, a forged or an expired one is 401, without reading any
account. A password change that is still owed is the hub server's refusal."""
from __future__ import annotations

import time

from fastapi import HTTPException

from shared import internal_token
from shared.account import Principal

__all__ = ["Principal", "admin", "principal"]


async def principal(authorization: str | None) -> Principal:
    key = internal_token.key()
    if key is None:
        raise HTTPException(503, f"The data server is not configured ({internal_token.ENV})")
    scheme, _, token = (authorization or "").partition(" ")
    who = internal_token.verify(key, token.strip(), time.time()) if scheme.lower() == "bearer" else None
    if who is None:
        raise HTTPException(401, "Sign in to the HUB")
    return who


async def admin(authorization: str | None) -> Principal:
    """The top-level administrator: 401 without a token, 403 for another role."""
    who = await principal(authorization)
    if not who.is_admin:
        raise HTTPException(403, {"code": "forbidden", "message": "The top-level administrator only"})
    return who
