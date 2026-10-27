"""Local read-only BFF/API over external Gold and separate HUB data/operations stores."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from bff import api, screens
from bff.gold_reader.db import close_pool, connection, open_pool
from bff.hub_stores import analytics_db, hub_catalog, operations_db

log = logging.getLogger("hgh.gold")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await open_pool()
    await analytics_db.open_pool()
    await operations_db.open_pool()
    try:
        yield
    finally:
        await close_pool()
        await analytics_db.close_pool()
        await operations_db.close_pool()


app = FastAPI(title="HMG GEO HUB BFF / read-only API", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    code = "read_only" if exc.status_code == 405 else "not_found" if exc.status_code == 404 else "source_unavailable" if exc.status_code >= 500 else "invalid_value"
    return JSONResponse({"error": {"code": code, "message": str(exc.detail)}}, status_code=exc.status_code)


@app.exception_handler(asyncpg.PostgresError)
async def database_error(request: Request, exc: asyncpg.PostgresError):
    # A PostgreSQL message can contain query values. Never return or log it.
    log.error("Gold query failed: %s SQLSTATE=%s path=%s", type(exc).__name__, exc.sqlstate, request.url.path)
    return JSONResponse({"error": {"code": "source_unavailable", "message": "Gold data could not be read"}}, status_code=503)


@app.exception_handler(TimeoutError)
async def pool_timeout(request: Request, exc: TimeoutError):
    # No free database connection in time (pool acquire / connect): a transient source failure.
    log.error("Gold read timed out: %s path=%s", type(exc).__name__, request.url.path)
    return JSONResponse({"error": {"code": "source_unavailable", "message": "Gold data could not be read in time"}}, status_code=503)


@app.get("/healthz")
async def healthz():
    async with connection() as conn:
        info = dict(await conn.fetchrow("SELECT current_database() AS database,current_user AS role,current_setting('transaction_read_only') AS read_only"))
    return {"ok": True, "source": "gold", **info, "analytics": await analytics_db.health(),
            "operations": await operations_db.health()}


@app.get("/v1/hub/{kind}")
async def catalog(kind: str, limit: int = Query(100, ge=1, le=1000),
                  offset: int = Query(0, ge=0), project_id: str | None = None):
    return JSONResponse(jsonable_encoder(await hub_catalog.listing(kind,limit,offset,project_id)),
                        headers={"Cache-Control":"no-store"})


@app.get("/v1/screens/{path:path}")
async def screen(path: str, request: Request):
    return JSONResponse(jsonable_encoder(await screens.build(path, request.query_params)), headers={"Cache-Control": "no-store"})


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def read(path: str, request: Request):
    if request.method != "GET":
        raise HTTPException(405, "This service is read-only")
    return JSONResponse(jsonable_encoder(await api.read(path, request.query_params)), headers={"Cache-Control": "no-store"})
