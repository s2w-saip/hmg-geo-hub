"""The way to the data server: a request goes on as it came, with the internal token in place of the login token, and its answer comes back as it
is. No reading of either: same status, same headers a client acts on, same bytes, the query string untouched (a repeated key, an encoded value).
The data server decides the answer's shape."""
from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

log = logging.getLogger("hgh.hub")

# Hop-by-hop headers (RFC 9110 7.6.1) end at each connection. host and content-length are set for the next hop; server and date name that hop.
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"}
NOT_SENT = HOP | {"host", "content-length", "authorization"}
NOT_RETURNED = HOP | {"server", "date"}
# The data server bounds its own reads; this only ends a request whose answer never comes. Next's longest wait is a download's.
TIMEOUT = httpx.Timeout(connect=5, read=300, write=30, pool=5)
# One page sends all its sections at once; keep them on open connections.
LIMITS = httpx.Limits(max_connections=200, max_keepalive_connections=100, keepalive_expiry=30)

_client: httpx.AsyncClient | None = None


def data_server_url() -> httpx.URL:
    return httpx.URL(os.environ.get("HGH_DATA_SERVER_URL", "http://127.0.0.1:5555"))


async def open_client() -> None:
    global _client
    _client = httpx.AsyncClient(timeout=TIMEOUT, limits=LIMITS)


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _target(request: Request) -> httpx.URL:
    raw = request.scope.get("raw_path") or request.scope["path"].encode()
    query = request.scope.get("query_string") or b""
    return data_server_url().copy_with(raw_path=raw + (b"?" + query if query else b""))


async def _chunks(upstream: httpx.Response) -> AsyncIterator[bytes]:
    try:
        async for chunk in upstream.aiter_raw():
            yield chunk
    finally:
        await upstream.aclose()


def failure(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers={"Cache-Control": "no-store"})


async def forward(request: Request, internal: str) -> Response:
    """The request on to the data server, the account in `internal`: the login token stops here."""
    headers = [(k, v) for k, v in request.headers.raw if k.decode("latin-1").lower() not in NOT_SENT]
    headers.append((b"authorization", f"Bearer {internal}".encode()))
    body = await request.body()
    # httpx.Request, not client.build_request: the client's default headers would be added to the request.
    outgoing = httpx.Request(request.method, _target(request), headers=headers, content=body or None)
    try:
        upstream = await _client.send(outgoing, stream=True)
    except httpx.TimeoutException as exc:
        log.error("data server timed out: %s path=%s", type(exc).__name__, request.url.path)
        return failure(504, "timeout", "The data server did not answer in time")
    except httpx.TransportError as exc:
        log.error("data server unreachable: %s path=%s", type(exc).__name__, request.url.path)
        return failure(503, "source_unavailable", "The data server could not be reached")
    response = StreamingResponse(_chunks(upstream), status_code=upstream.status_code)
    response.raw_headers = [(k.lower(), v) for k, v in upstream.headers.raw if k.decode("latin-1").lower() not in NOT_RETURNED]
    return response
