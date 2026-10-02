"""analytics.filters.options 필터 옵션 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.errors import ERROR_RESPONSES
from app.core.filters import parse_custom_fields
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.filters.options import service
from app.features.analytics.filters.options.schemas import OptionsQuery, OptionsResponse

router = APIRouter(tags=["analytics.filters"], route_class=CachedRoute)


@router.get("/v1/filters/options", response_model=OptionsResponse, responses=ERROR_RESPONSES,
            summary="필터 옵션(F-1): 옵션 창(from/to 또는 함대 스냅샷) 안에서 측정된 브랜드×국가×언어 매트릭스, 국가(권역·가상 브랜드 코드), 측정 엔진, 출처 카테고리(include=source_categories 일 때만). 카탈로그 택소노미는 global=루트 카탈로그, project=app.prompt, website=null(택소노미 축 없음). 커스텀 필드는 project 만")
@result_cache(key_deps={"legacy_web": service.legacy_website_key})
async def get_filters_options_0(request: Request, principal: CurrentUser, conn: RoConn,
                                filters: Annotated[OptionsQuery, Query()]) -> OptionsResponse:
    """analytics.filters.options(F-1). 필터 패널 첫 열림 시 호출(Q7, 첫 렌더 예산 제외). 기간만 받고 값 축은 ignored_filters."""
    return await service.get_options(conn, principal, filters, parse_custom_fields(request.query_params),
                                     include=frozenset(filters.include))
