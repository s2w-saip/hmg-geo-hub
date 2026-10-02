"""analytics.citations.sources 출처 카테고리 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.core.filters import CommonFilters
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.citations.sources import service
from app.features.analytics.citations.sources.schemas import SourcesData, TypesData

router = APIRouter(tags=["analytics.citations"], route_class=CachedRoute)


@router.get("/v1/citations/sources", response_model=Envelope[SourcesData], responses=ERROR_RESPONSES,
            summary="출처 카테고리 분포(M09) + 엔진×카테고리 + 답변 톤별 인용 요약 타일(한 요청)")
@result_cache()
async def get_citations_sources_0(request: Request, conn: RoConn, user: CurrentUser,
                                  filters: Annotated[CommonFilters, Query()]) -> Envelope[SourcesData]:
    """analytics.citations.sources: C-2 카테고리·엔진·톤·유형(Q19 로 유형 포함)."""
    return await service.get_sources(conn, user, filters, request)


@router.get("/v1/citations/sources/types", response_model=Envelope[TypesData], responses=ERROR_RESPONSES,
            summary="언급 유형 5종별 출처 카테고리 구성(현행 fetchStandardCitationTypeCategories 이관). 존치 여부 열린 질문")
@result_cache()
async def get_citations_sources_types_1(request: Request, conn: RoConn, user: CurrentUser,
                                        filters: Annotated[CommonFilters, Query()]) -> Envelope[TypesData]:
    """analytics.citations.sources: Q19 로 /sources 의 types 에 합쳤다. 이 경로는 taxonomy 정본 유지용으로 같은 계산의 types 부분만 낸다."""
    return await service.get_types(conn, user, filters, request)
