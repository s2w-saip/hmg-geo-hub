"""admin.interest.sources 표준 출처 라우터. 경로는 /v1 접두 포함 전체 경로. admin 전용(AD-1b).

읽기 = api_ro, 쓰기 = api_rw(RwConn). 목록은 소규모 원천 표(수십~수백 행)라 페이지네이션 없이 전량을 준다(현행 동일).
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import require_admin
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import PgLine
from app.core.write import RwConn
from app.features.admin.catalog.prompts.admin_common import check_values, clean_text
from app.features.admin.interest.sources import service as svc
from app.features.admin.interest.sources.schemas import Channel, Source, SourceCreate, SourceDeleted, SourceList, SourcePatch

router = APIRouter(tags=["admin.interest"], dependencies=[require_admin], responses=ERROR_RESPONSES)


@router.get("/v1/admin/interest/sources", summary="표준 소스 목록", response_model=Envelope[SourceList])
async def get_admin_interest_sources_0(
        request: Request, ro: RoConn,
        channel: Annotated[Channel | None, Query()] = None,
        brand: Annotated[list[str], Query(max_length=20, description="brand_code")] = [],  # noqa: B006
        enabled: Annotated[bool | None, Query()] = None,
        q: Annotated[PgLine | None, Query(max_length=200, description="url 부분일치")] = None,
) -> Envelope[SourceList]:
    items = await svc.list_sources(ro, channel=channel, brands=check_values("brand", brand), enabled=enabled,
                                    q_text=clean_text(q, field="q", max_len=200))
    meta = crud_meta(request.query_params, mode="admin", support=("brand",))
    return Envelope[SourceList](data=SourceList(items=items), meta=meta)


@router.post("/v1/admin/interest/sources", status_code=201, summary="표준 소스 생성", response_model=Envelope[Source])
async def post_admin_interest_sources_1(body: SourceCreate, ro: RoConn, rw: RwConn) -> Envelope[Source]:
    return Envelope[Source](data=await svc.create(ro, rw, body), meta=build_meta(mode="crud"))


@router.patch("/v1/admin/interest/sources/{source_id}", summary="표준 소스 수정", response_model=Envelope[Source])
async def patch_admin_interest_sources_by_id_2(source_id: uuid.UUID, body: SourcePatch, ro: RoConn, rw: RwConn) -> Envelope[Source]:
    return Envelope[Source](data=await svc.update(ro, rw, source_id, body), meta=build_meta(mode="crud"))


@router.delete("/v1/admin/interest/sources/{source_id}", summary="표준 소스 삭제", response_model=Envelope[SourceDeleted])
async def delete_admin_interest_sources_by_id_3(source_id: uuid.UUID, rw: RwConn) -> Envelope[SourceDeleted]:
    await svc.delete(rw, source_id)
    return Envelope[SourceDeleted](data=SourceDeleted(source_id=source_id), meta=build_meta(mode="crud"))
