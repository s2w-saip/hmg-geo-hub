"""analytics.citations.domain_detail 도메인 드릴다운 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Path, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.core.filters import SAFE_TEXT
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.citations.domain_detail import service
from app.features.analytics.citations.domain_detail.schemas import DomainDetailData, DomainDetailQuery

router = APIRouter(tags=["analytics.citations"], route_class=CachedRoute)


# skey 는 공식 소셜 계정 키(host+path, 예: linkedin.com/hyundai-motor-group)면 '/' 를 포함하므로 path 변환기로 받는다(OpenAPI 경로는 {skey})
@router.get("/v1/citations/domains/{skey:path}", response_model=Envelope[DomainDetailData], responses=ERROR_RESPONSES,
            summary="출처 1개 드릴다운: 인용 URL 상위 10 + 프롬프트 상위 12 × 답변 참조 8(BG-25 urls_limit·prompts_limit·answers_limit 로 넓힘)")
@result_cache()
async def get_citations_domains_by_id_0(request: Request, conn: RoConn, user: CurrentUser,
                                        skey: Annotated[str, Path(min_length=1, max_length=512, pattern=SAFE_TEXT, description="출처 그룹 키(도메인 순위의 skey)")],
                                        params: Annotated[DomainDetailQuery, Query()]) -> Envelope[DomainDetailData]:
    """analytics.citations.domain_detail: C-1 드릴다운(모듈-인용 §2)."""
    return await service.get_detail(conn, user, skey, params, request)
