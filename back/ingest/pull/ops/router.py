"""ingest.pull.ops 적재 운영 조회 라우터(admin 전용). 경로는 /v1 접두 포함 전체 경로."""
from __future__ import annotations

import datetime as dt
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request

from app.core.auth import require_admin
from app.core.db import RoConn
from app.core.envelope import Envelope, ListData
from app.core.errors import ERROR_RESPONSES

from . import service
from .schemas import BacklogRow, IngestStatusRow, LoadRow

router = APIRouter(tags=["ingest.pull.ops"], dependencies=[require_admin])
_ERR = {k: ERROR_RESPONSES[k] for k in (401, 403, 422)}


@router.get("/v1/admin/ingest/status", response_model=Envelope[ListData[IngestStatusRow]], responses=_ERR,
            summary="프로젝트별 적재 커서·미해소 run 수(rd.v_ingest_status 뷰), admin")
async def get_admin_ingest_status_0(request: Request, conn: RoConn,
                                    surface: Annotated[Literal["global", "website", "project"] | None, Query()] = None
                                    ) -> Envelope[ListData[IngestStatusRow]]:
    """pull 커서(최근 시도·성공·오류·프롬프트 증분 커서·시장)와 run 원장 집계(미해소·blocked). 페이지 없음(프로젝트 수 소규모)."""
    data, meta = await service.status(conn, surface=surface, ignored=service.ignored_filters(request.query_params, surface_supported=True))
    return Envelope[ListData[IngestStatusRow]](data=data, meta=meta)


@router.get("/v1/admin/ingest/backlog", response_model=Envelope[ListData[BacklogRow]], responses=_ERR,
            summary="재확인 창 닫혔는데 미해소·blocked run(R12), 키셋(rd.v_ingest_backlog)")
async def get_admin_ingest_backlog_1(request: Request, conn: RoConn,
                                     surface: Annotated[Literal["global", "website", "project"] | None, Query()] = None,
                                     limit: Annotated[int | None, Query(ge=1, le=service.BACKLOG_MAX)] = None,
                                     cursor: Annotated[str | None, Query(max_length=4096)] = None) -> Envelope[ListData[BacklogRow]]:
    """경보 대상 run(blocked, 재확인 창이 닫혔는데 미해소 job·분석 대기). started_at 오름차순 키셋."""
    data, meta = await service.backlog(conn, surface=surface, limit=limit, cursor=cursor,
                                       ignored=service.ignored_filters(request.query_params, surface_supported=True))
    return Envelope[ListData[BacklogRow]](data=data, meta=meta)


@router.get("/v1/admin/ingest/loads", response_model=Envelope[ListData[LoadRow]], responses=_ERR,
            summary="ing.load 적재 감사(rd.v_ingest_load), 키셋")
async def get_admin_ingest_loads_2(request: Request, conn: RoConn,
                                   kind: Annotated[list[str], Query(max_length=9)] = [],  # noqa: B006  FastAPI 반복 파라미터 기본값
                                   status: Annotated[list[str], Query(max_length=3)] = [],  # noqa: B006
                                   started_from: Annotated[dt.datetime | None, Query()] = None,
                                   started_to: Annotated[dt.datetime | None, Query()] = None,
                                   limit: Annotated[int | None, Query(ge=1, le=service.LOADS_MAX)] = None,
                                   cursor: Annotated[str | None, Query(max_length=4096)] = None) -> Envelope[ListData[LoadRow]]:
    """적재 원장(kind·status·카운터·오류). started_from/started_to 는 적재 시각 축(공통 필터 from/to 와 다른 이름). load_id 내림차순 키셋."""
    data, meta = await service.loads(conn, kinds=kind, statuses=status, started_from=started_from, started_to=started_to, limit=limit,
                                     cursor=cursor, ignored=service.ignored_filters(request.query_params, surface_supported=False))
    return Envelope[ListData[LoadRow]](data=data, meta=meta)
