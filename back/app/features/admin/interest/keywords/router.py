"""admin.interest.keywords 표준 키워드 라우터. 경로는 /v1 접두 포함 전체 경로. admin 전용(AD-1b).

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
from app.features.admin.interest.keywords import service as svc
from app.features.admin.interest.keywords.schemas import Keyword, KeywordCreate, KeywordDeleted, KeywordList, KeywordPatch, SourceType

router = APIRouter(tags=["admin.interest"], dependencies=[require_admin], responses=ERROR_RESPONSES)


@router.get("/v1/admin/interest/keywords", summary="고객 관심 키워드 목록(app.standard_keyword)", response_model=Envelope[KeywordList])
async def get_admin_interest_keywords_0(
        request: Request, ro: RoConn,
        source_type: Annotated[SourceType | None, Query()] = None,
        brand: Annotated[list[str], Query(max_length=20, description="brand_code")] = [],  # noqa: B006
        enabled: Annotated[bool | None, Query()] = None,
        q: Annotated[PgLine | None, Query(max_length=200, description="term 부분일치")] = None,
) -> Envelope[KeywordList]:
    items = await svc.list_keywords(ro, source_type=source_type, brands=check_values("brand", brand), enabled=enabled,
                                    q_text=clean_text(q, field="q", max_len=200))
    meta = crud_meta(request.query_params, mode="admin", support=("brand",))
    return Envelope[KeywordList](data=KeywordList(items=items), meta=meta)


@router.post("/v1/admin/interest/keywords", status_code=201, summary="키워드 생성", response_model=Envelope[Keyword])
async def post_admin_interest_keywords_1(body: KeywordCreate, ro: RoConn, rw: RwConn) -> Envelope[Keyword]:
    return Envelope[Keyword](data=await svc.create(ro, rw, body), meta=build_meta(mode="crud"))


@router.patch("/v1/admin/interest/keywords/{keyword_id}", summary="키워드 수정", response_model=Envelope[Keyword])
async def patch_admin_interest_keywords_by_id_2(keyword_id: uuid.UUID, body: KeywordPatch, ro: RoConn, rw: RwConn) -> Envelope[Keyword]:
    return Envelope[Keyword](data=await svc.update(ro, rw, keyword_id, body), meta=build_meta(mode="crud"))


@router.delete("/v1/admin/interest/keywords/{keyword_id}", summary="키워드 삭제", response_model=Envelope[KeywordDeleted])
async def delete_admin_interest_keywords_by_id_3(keyword_id: uuid.UUID, rw: RwConn) -> Envelope[KeywordDeleted]:
    await svc.delete(rw, keyword_id)
    return Envelope[KeywordDeleted](data=KeywordDeleted(keyword_id=keyword_id), meta=build_meta(mode="crud"))
