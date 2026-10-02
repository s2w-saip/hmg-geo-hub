"""analytics.mentions.brands 브랜드·경쟁사 비교 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta
from app.core.errors import ERROR_RESPONSES
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.mentions.brands.common import read_scope, suppression
from app.features.analytics.mentions.brands.schemas import BrandsData, BrandsQuery
from app.features.analytics.mentions.brands.service import mention_brands, truncation_meta

router = APIRouter(tags=["analytics.mentions"], route_class=CachedRoute)


@router.get("/v1/mentions/brands", response_model=Envelope[BrandsData], responses=ERROR_RESPONSES,
            summary="관점 브랜드 당사 블록(M01·M02·M04, rd.answer 당사 열)과 브랜드 순위 행(is_own, 경쟁 상위 top_n, 행별 M01·M02·M04·감성 4계열, core.measure.brand_rows). 선택: split_own(관점 브랜드별 당사 행)·include(prompts·multi·types·hmg)·group_by=engine·q·full")
@result_cache()
async def get_mentions_brands_0(request: Request, p: CurrentUser, conn: RoConn,
                                q: Annotated[BrandsQuery, Query()]) -> Envelope[BrandsData]:
    """관점 브랜드 대비 경쟁 브랜드의 노출률·점유율·평균 순위·언급 수·감성(명세: README.md, 모듈-언급 §3.1)."""
    ctx, win = await read_scope(conn, p, q, request)
    data = await mention_brands(conn, ctx, win, top_n=q.top_n, sort=q.sort, brand_keys=q.brand_key or None, split_own=q.split_own,
                                include=q.include, group_by=q.group_by, q=q.q, full=q.full)
    return Envelope[BrandsData](data=data, meta=build_meta(mode=win.mode, window=win, ctx=ctx, suppressed=suppression(win),
                                                           truncated=truncation_meta(data, full=q.full)))
