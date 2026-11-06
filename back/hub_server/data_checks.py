"""What the hub server asks the data server before it saves (D-26): gold_db is the data server's, so a correction or a role checks its source or entity there.
A refusal comes back to the browser as the data server words it."""
from __future__ import annotations

import logging
import time
from uuid import UUID

import httpx
from fastapi import HTTPException

from hub_server import proxy
from shared import internal_token
from shared.account import Principal

log = logging.getLogger("hgh.hub")


async def _ask(path: str, params: dict, who: Principal):
    key = internal_token.key()
    if key is None:
        raise HTTPException(503, f"The hub server is not configured ({internal_token.ENV})")
    url = proxy.data_server_url().copy_with(path=path, params=params)
    headers = {"authorization": f"Bearer {internal_token.sign(key, who.scope(), time.time())}", "accept": "application/json"}
    try:
        reply = await proxy.send(httpx.Request("GET", url, headers=headers))
    except httpx.TimeoutException as exc:
        log.error("data server check timed out: %s path=%s", type(exc).__name__, path)
        raise HTTPException(504, {"code": "timeout", "message": "The data server did not answer in time"}) from None
    except httpx.TransportError as exc:
        log.error("data server check unreachable: %s path=%s", type(exc).__name__, path)
        raise HTTPException(503, {"code": "source_unavailable", "message": "The data server could not be reached"}) from None
    if reply.status_code != 200:
        raise HTTPException(reply.status_code, reply.json()["error"])
    return reply.json()["data"]["gold"]


async def source(key: str, category: str | None, who: Principal) -> dict | None:
    """Gold's row for the source (None when Gold has no such source); a category Gold does not have is refused."""
    return await _ask("/v1/hub/source-overrides/check", {"skey": key, **({"category": category} if category is not None else {})}, who)


async def entity(key: UUID, who: Principal) -> dict | None:
    """Gold's row for the entity (None when Gold has no such entity)."""
    return await _ask("/v1/hub/entity-roles/check", {"entity": str(key)}, who)
