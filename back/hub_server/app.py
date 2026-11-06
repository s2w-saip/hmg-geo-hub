"""The hub server (T13): Next's only door. Since step 1c every /v1 request passes to the data server unchanged, writes included; login moves here
in 1d, saved filters in 1e, input editing in 1f, and from then on this proxy carries reads only. It holds no metric logic: every screen stops when it stops."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request

from hub_server import proxy


@asynccontextmanager
async def lifespan(app: FastAPI):
    await proxy.open_client()
    try:
        yield
    finally:
        await proxy.close_client()


app = FastAPI(title="HMG GEO HUB hub server", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
async def healthz():
    return {"ok": True, "service": "hub_server"}


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def to_data_server(path: str, request: Request):
    return await proxy.forward(request)
