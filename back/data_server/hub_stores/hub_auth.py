"""The account a request runs for, as far as this server needs it: its scope. The hub server signs in the account and checks it again on every request
(hub_server/auth.py), then sends the scope here in a short-lived internal token. This server trusts that token and nothing else: no token, a forged or an expired one
is 401, without reading any account. It writes nothing in an account's name, so it does not know who the account is."""
from __future__ import annotations

import time
from dataclasses import dataclass

from fastapi import HTTPException

from shared import internal_token


@dataclass(frozen=True)
class Reader:
    grant: dict

    @property
    def is_admin(self) -> bool:
        return bool(self.grant.get("all"))

    def scope(self) -> dict:
        return self.grant


async def principal(authorization: str | None) -> Reader:
    key = internal_token.key()
    if key is None:
        raise HTTPException(503, f"The data server is not configured ({internal_token.ENV})")
    scheme, _, token = (authorization or "").partition(" ")
    scope = internal_token.verify(key, token.strip(), time.time()) if scheme.lower() == "bearer" else None
    if scope is None:
        raise HTTPException(401, "Sign in to the HUB")
    return Reader(scope)


async def admin(authorization: str | None) -> Reader:
    """The top-level administrator: 401 without a token, 403 for another scope."""
    who = await principal(authorization)
    if not who.is_admin:
        raise HTTPException(403, {"code": "forbidden", "message": "The top-level administrator only"})
    return who
