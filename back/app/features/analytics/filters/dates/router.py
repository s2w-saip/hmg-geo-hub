"""analytics.filters.dates 선택 가능 날짜·기준일 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.errors import ERROR_RESPONSES
from app.core.filters import parse_custom_fields
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.filters.dates import service
from app.features.analytics.filters.dates.schemas import DatesQuery, DatesResponse

router = APIRouter(tags=["analytics.filters"], route_class=CachedRoute)


@router.get("/v1/filters/dates", response_model=DatesResponse, responses=ERROR_RESPONSES,
            summary="선택 가능 날짜(F-2): 표면별 선택 가능 회차 날짜(round_date 내림차순, 최대 400), latest_round_date(family 별 숨김을 뺀 최신 회차), first_measured_date, 기간 프리셋 4종(weekly·biweekly·monthly·yearly)")
@result_cache()
async def get_filters_dates_0(request: Request, principal: CurrentUser, conn: RoConn,
                              filters: Annotated[DatesQuery, Query()]) -> DatesResponse:
    """analytics.filters.dates(F-2). 공통 필터 축은 전부 받지 않고 meta.ignored_filters 로 알린다(from/to 포함)."""
    return await service.get_dates(conn, principal, filters, filters.family, parse_custom_fields(request.query_params))
