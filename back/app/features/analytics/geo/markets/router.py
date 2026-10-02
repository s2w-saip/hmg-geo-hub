"""analytics.geo.markets 국가별 현황 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.core.filters import CommonFilters
from app.core.result_cache import CachedRoute, result_cache

from . import service
from .schemas import GeoData

router = APIRouter(tags=["analytics.geo"], route_class=CachedRoute)


@router.get("/v1/geo", response_model=Envelope[GeoData], responses=ERROR_RESPONSES,
            summary="권역→국가 트리, 국가·권역별 M01~M05 와 최대경쟁사·선두 자사 브랜드. core.measure.fetch_counts(group_by=geo) + "
                    "brand_rows(group_by=geo). global·website 표면(Q8: 웹사이트는 언급 수만, 관점 브랜드 단일일 때만 권역 트리)")
@result_cache(geo_gate=True)
async def get_geo_0(p: CurrentUser, conn: RoConn, filters: Annotated[CommonFilters, Query()]) -> Envelope[GeoData]:
    """analytics.geo.markets: 국가별 현황(GEO-1). 기간 미지정 = 함대 스냅샷, 기간 지정 = 누적."""
    return await service.get_geo(conn, p, filters)
