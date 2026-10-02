"""analytics.kpi.compare 기간 비교 Δ 라우터. 경로는 /v1 접두 포함 전체 경로."""
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.errors import ERROR_RESPONSES
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.kpi.summary.shared import kpi_context, kpi_today

from .schemas import CompareQuery, CompareResponse
from .service import get_compare

router = APIRouter(tags=["analytics.kpi"], route_class=CachedRoute)


@router.get("/v1/kpi/compare", response_model=CompareResponse, responses=ERROR_RESPONSES,
            summary="kind=window|calendarMonth|calendarWeek|cycle 의 cur·prev(·before) 분자·분모와 Δ, 억제 사유. 입력 합은 K-1 과 같은 core.measure.answer_cou")
@result_cache(key_deps={"today": kpi_today})
async def get_kpi_compare_0(
    request: Request,
    p: CurrentUser,
    conn: RoConn,
    q: Annotated[CompareQuery, Query()],
    today: Annotated[date | None, Depends(kpi_today)] = None,
) -> CompareResponse:
    """analytics.kpi.compare: 기간 비교 Δ(K-2). 명세: README.md, docs/design/api/모듈-KPI.md §2 K-2."""
    ctx = await kpi_context(conn, p, q, request)
    return await get_compare(conn, ctx, q, today=today)
