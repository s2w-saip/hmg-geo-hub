"""analytics.trend.series 지표 추이 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.core.filters import parse_custom_fields
from app.core.measure import project_accuracy_cache_key
from app.core.result_cache import CachedRoute, result_cache

from . import service
from .schemas import TrendData, TrendQuery

router = APIRouter(tags=["analytics.trend"], route_class=CachedRoute)


async def project_accuracy_key(request: Request, conn: RoConn) -> str | None:
    """결과 캐시 끝점 추가 키(key_deps): 현행 프로필 project_accuracy_single_base ∧ project 표면이면 프로젝트 ⑥ 판정 입력 지문
    (core.measure.project_accuracy_cache_key: owned base·domain·추적 URL 은 추적 표가 아니다). 그 밖 None(문장 없음)."""
    return await project_accuracy_cache_key(conn, request.query_params)


@router.get("/v1/trend", response_model=Envelope[TrendData], responses=ERROR_RESPONSES,
            summary="bucket=cycle|week|month 지표 시계열(M01~M07), 원장 자리 있는데 값 없는 지점 갭 표시(R11, collection_error 갭 슬롯). "
                    "dimension=none|engine|brand|source|category|type. 카드와 같은 빌더(D6). 웹사이트 M06·M07 은 회차별 origin(report|live). "
                    "buckets[].measured_days(measured_days=false 면 null: 계산 생략), M03 지점 negative, dimension=brand 의 brand_key[]·split_own(선택)")
@result_cache(key_deps={"project_accuracy": project_accuracy_key})
async def get_trend_0(request: Request, p: CurrentUser, conn: RoConn, query: Annotated[TrendQuery, Query()]) -> Envelope[TrendData]:
    """analytics.trend.series: 지표 추이(T-1). from/to 가 없으면 최근 12 버킷(Q9)."""
    return await service.get_trend(conn, p, query, bucket=query.bucket, dimension=query.dimension, metrics=query.metrics,
                                   top=query.top, custom_fields=parse_custom_fields(request.query_params),
                                   brand_keys=query.brand_key, split_own=query.split_own, with_measured_days=query.measured_days,
                                   dims=query.dims)
