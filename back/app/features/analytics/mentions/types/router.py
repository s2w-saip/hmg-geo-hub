"""analytics.mentions.types 언급 유형·태도 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta
from app.core.errors import ERROR_RESPONSES
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.mentions.brands.common import read_scope, suppression
from app.features.analytics.mentions.types.schemas import TypesData, TypesQuery
from app.features.analytics.mentions.types.service import mention_types

router = APIRouter(tags=["analytics.mentions"], route_class=CachedRoute)


@router.get("/v1/mentions/types", response_model=Envelope[TypesData], responses=ERROR_RESPONSES,
            summary="M08 언급 유형 5종 × 당사/경쟁 답변 수·언급 합, 유형 × 감성 매트릭스, 당사 스탠스 4계열(A3, rd.answer_stance ⋈ rd.answer 등치). 선택: split_own(관점 브랜드별 블록 by_own_brand)")
@result_cache()
async def get_mentions_types_0(request: Request, p: CurrentUser, conn: RoConn,
                               filters: Annotated[TypesQuery, Query()]) -> Envelope[TypesData]:
    """언급 유형 분포(M08)·유형 × 감성 매트릭스·당사 스탠스(A3) (명세: README.md, 모듈-언급 §3.2)."""
    ctx, win = await read_scope(conn, p, filters, request)
    data, extra = await mention_types(conn, ctx, win, split_own=filters.split_own)
    return Envelope[TypesData](data=data, meta=build_meta(mode=win.mode, window=win, ctx=ctx, suppressed={**suppression(win), **extra}))
